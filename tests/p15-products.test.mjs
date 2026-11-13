/**
 * 产物面（2026-11-13 审计 P1/P2）：脱敏补全、事实页幂等、低分不重复渲染、幽灵工具名。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { redactDeep } from '../lib/redact.js'
import { persistFacts } from '../lib/facts.js'
import { renderWeek } from '../lib/render.js'
import { searchEntries } from '../lib/recall.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

async function withTmp(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-e-'))
  const vaultDir = await mkdtemp(join(tmpdir(), 'chronicle-e-vault-'))
  try {
    return await fn(dataDir, vaultDir)
  } finally {
    for (const dir of [dataDir, vaultDir]) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test('P2 脱敏：Stripe 下划线密钥 / Basic 凭据 / URL userinfo 不再漏', () => {
  const cases = [
    ['sk_live_51Habcdefghijklmnop', /REDACTED/],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', /REDACTED/],
    ['redis://default:s3cr3tpw@cache.internal:6379/0', /REDACTED/],
  ]
  for (const [input, pattern] of cases) {
    const out = redactDeep({ t: input }).value.t
    assert.match(out, pattern, `${input} 应当被脱敏，实际：${out}`)
  }
  // 正常 URL 不能被误吃
  const url = 'https://example.com/a/b?c=1'
  assert.equal(redactDeep({ t: url }).value.t, url)
})

test('P2 事实页幂等：同样的事实第二次收口不重写页，MEMORY.md 字节相同', () =>
  withTmp(async (dataDir, vaultDir) => {
    const incoming = [
      {
        id: 'decision-x',
        kind: 'decision',
        scope: 'general',
        title: 'X',
        statement: 'S',
        rationale: 'R',
        project: 'p',
        bornOn: '2026-11-13',
        evidence: ['s#1'],
        status: 'single',
        hits: 0,
        expiresWhen: '',
        detector: '',
      },
    ]
    const first = await persistFacts({ dataDir, vaultDir, incoming, generatedAt: '2026-11-13T00:00:00Z' })
    const md1 = await readFile(join(vaultDir, 'MEMORY.md'), 'utf8')
    const second = await persistFacts({ dataDir, vaultDir, incoming, generatedAt: '2026-11-13T01:00:00Z' })
    const md2 = await readFile(join(vaultDir, 'MEMORY.md'), 'utf8')

    assert.ok(first.pages > 0)
    assert.equal(second.pages, 0, '内容没变就不该重写页')
    assert.ok(second.unchanged > 0)
    assert.equal(md1, md2, 'MEMORY.md 不能带生成时间（否则每次收口都制造 diff）')
    assert.doesNotMatch(md2, /generatedAt/)
  }))

test('P2 低分条目只出现在「低分流水」，不在四块里再来一遍', () => {
  const mk = (ref, title, importance) => ({
    ref,
    title,
    claim: '',
    basis: '',
    importance,
    kind: 'delivery',
    entities: [],
    section: 'projects',
    project: 'p',
    ts: '2026-11-13T10:00:00+08:00',
    ws: 'w',
    files: [],
  })
  const entries = [mk('a', '高分条目', 4), mk('b', '低分唯一标题', 2)]
  const sections = [{ key: 'projects', title: '项目进展', refs: ['a', 'b'] }]
  const md = renderWeek({
    weekId: '2026-W46',
    days: [{ day: '2026-11-13', summary: 's', sections, threads: [], entries }],
    floor: 3,
    promptVersion: 'v1',
    entities: [],
  })
  const occurrences = md.split('低分唯一标题').length - 1
  assert.equal(occurrences, 1, '同一条不能渲染两次')
  assert.match(md, /低分流水/)
  assert.match(md, /高分条目/)
})

test('P2 检索：同一份语料重复检索结果稳定（IDF 缓存不改变语义）', () => {
  const entries = [
    { ref: 'a', ts: '2026-11-13T10:00:00+08:00', day: '2026-11-13', title: '改 ingest.js', claim: '思考块', importance: 4, entities: ['ingest.js'], ws: 'w', section: 'projects' },
    { ref: 'b', ts: '2026-11-12T10:00:00+08:00', day: '2026-11-12', title: '接入 llm 打分', claim: '一天一次', importance: 3, entities: ['llm.js'], ws: 'w', section: 'projects' },
  ]
  const now = Date.parse('2026-11-13T12:00:00+08:00')
  const first = searchEntries(entries, 'ingest', { now, limit: 5 })
  const second = searchEntries(entries, 'ingest', { now, limit: 5 })
  assert.deepEqual(second.map((r) => r.ref), first.map((r) => r.ref))
})

test('P2 文档漂移守卫：工具描述不许引用不存在的工具名', async () => {
  const source = await readFile(join(ROOT, 'index.js'), 'utf8')
  const names = new Set([...source.matchAll(/name: '(chronicle_[a-z_]+)'/g)].map((m) => m[1]))
  const referenced = new Set([...source.matchAll(/\b(chronicle_[a-z_]+)\b/g)].map((m) => m[1]))
  for (const ref of referenced) {
    assert.ok(names.has(ref), `描述里引用了不存在的工具 ${ref}`)
  }
})
