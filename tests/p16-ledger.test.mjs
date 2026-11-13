/**
 * D1 / D2（2026-11-13 产品反哺）：导出要能看 diff，动作账本只留失败。
 *
 * 背景数字（真实数据）：
 *   · 成功工具结果 5,993 条 = 43.6% 行数 / 27% 字节，从无消费者；
 *   · 产物里 130 个去重引用全部是 user 事件，toolresult 引用 0 次；
 *   · 导出段落每次带时间戳 ⇒ 每次导出都制造 diff，git 里堆满无变化提交。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { diffExport } from '../lib/rules.js'
import { eventToRow } from '../lib/ingest.js'
import * as plugin from '../index.js'

function fakeCtx() {
  const registered = []
  return {
    registered,
    effect(fn) {
      const dispose = fn()
      return () => dispose?.()
    },
    on() {
      return () => {}
    },
    inject() {
      return () => {}
    },
    get() {
      return undefined
    },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
}

async function withDirs(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-d1-'))
  const vaultDir = await mkdtemp(join(tmpdir(), 'chronicle-d1-vault-'))
  try {
    return await fn(dataDir, vaultDir)
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 20))
    for (const dir of [dataDir, vaultDir]) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => {})
    }
  }
}

/* ---------- D1：导出 diff ---------- */

test('D1 diffExport：只比内容行，忽略注释/引用头/标题/空行', () => {
  const previous = ['<!-- x -->', '## 标题', '> 共 2 条', '- A', '- B', ''].join('\n')
  const next = ['<!-- y -->', '## 标题2', '> 共 2 条', '- B', '- C', ''].join('\n')
  const d = diffExport(previous, next)
  assert.deepEqual(d.added, ['- C'])
  assert.deepEqual(d.removed, ['- A'])
  assert.equal(d.first, false)
  assert.equal(diffExport('', next).first, true)
})

test('D1 导出正文不含时间戳（否则每次导出都制造 diff）', async () => {
  const { renderRulesMarkdown } = await import('../lib/rules.js')
  const facts = [
    { id: 'c1', kind: 'convention', scope: 'general', project: 'p', status: 'single', title: '约定一', statement: 'S' },
  ]
  const a = renderRulesMarkdown(facts, { generatedAt: '2026-11-13' })
  const b = renderRulesMarkdown(facts, { generatedAt: '2026-11-20' })
  assert.equal(a, b, '两次导出必须逐字节相同')
  assert.match(a, /dsh-chronicle:begin/)
  assert.match(a, /dsh-chronicle:end/)
})

test('D1 工具：第一次报 first，第二次报 0 变化，加一条规则后报 +1', () =>
  withDirs(async (dataDir, vaultDir) => {
    const factsDir = join(dataDir, 'facts')
    await mkdir(factsDir, { recursive: true })
    const writeFacts = (extra = []) =>
      writeFile(
        join(factsDir, 'index.json'),
        JSON.stringify({
          v: 1,
          facts: [
            { id: 'c-base', kind: 'convention', scope: 'general', project: 'p', status: 'single', title: '基础约定', statement: 'S', evidence: ['a#1'] },
            ...extra,
          ],
        }),
      )
    await writeFacts()

    const ctx = fakeCtx()
    plugin.apply(ctx, plugin.Config({ dataDir, vaultDir, gitCommit: false, panel: false }))
    const tool = ctx.registered.find((item) => item.name === 'chronicle_export_rules')

    const first = await tool.execute({})
    assert.equal(first.first, true)
    assert.equal(first.addedCount, 0, '首次不该有 added')

    const second = await tool.execute({})
    assert.equal(second.first, false)
    assert.equal(second.addedCount, 0, '内容没变就是 0 变化')
    assert.equal(second.removedCount, 0)

    await writeFacts([
      { id: 'c-new', kind: 'convention', scope: 'general', project: 'p', status: 'single', title: '新约定', statement: 'S2', evidence: ['a#2'] },
    ])
    const third = await tool.execute({})
    assert.equal(third.addedCount, 1, '新增一条约定应报 +1')
    assert.match(third.added[0], /新约定/)
  }))

/* ---------- D2：动作账本 ---------- */

const session = { id: 's1' }

test('D2 采集：成功的工具结果不写行，失败才写且带正文', () => {
  const okRow = eventToRow(session, {
    type: 'tool/result',
    seq: 1,
    time: Date.parse('2026-11-13T10:00:00+08:00'),
    data: { message: { isError: false, content: [{ type: 'text', text: 'all good' }] } },
  })
  assert.equal(okRow, null, '成功的工具结果不该占一行')

  const failRow = eventToRow(session, {
    type: 'tool/result',
    seq: 2,
    time: Date.parse('2026-11-13T10:00:01+08:00'),
    data: { message: { isError: true, content: [{ type: 'text', text: 'bash: fork: retry: Resource temporarily unavailable' }] } },
  })
  assert.equal(failRow.kind, 'toolresult')
  assert.equal(failRow.ok, false)
  assert.match(failRow.text, /Resource temporarily unavailable/)
})

test('D2 失败正文截断到 400 字，避免堆栈噪声', () => {
  const row = eventToRow(session, {
    type: 'tool/result',
    seq: 3,
    time: Date.parse('2026-11-13T10:00:02+08:00'),
    data: { message: { isError: true, content: [{ type: 'text', text: 'x'.repeat(2000) }] } },
  })
  assert.equal(row.text.length, 400)
})
