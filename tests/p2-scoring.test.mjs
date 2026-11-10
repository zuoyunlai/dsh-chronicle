/**
 * P2：LLM 打分（A 档）+ 实体图。
 * 全部用假 llm 与临时目录，不联网、不花 token。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildScorePrompt, extractJsonArray, normalizeEntries, scoreDayWithLlm, collectText, salvageObjects } from '../lib/llm.js'
import { buildDayGraph, mergeGraph, writeDayGraph, neighborsOf } from '../lib/entities.js'
import { closeDay, scoreOneDay } from '../lib/close.js'
import { condense } from '../lib/outline.js'
import { writeAtomic, ensureDir } from '../lib/store.js'

/* ---------------- 假 llm ---------------- */

function fakeStream(text, finishKind = 'stop') {
  return (async function* () {
    for (const piece of String(text).match(/[\s\S]{1,20}/g) || []) {
      yield { type: 'text-delta', text: piece }
    }
    yield { type: 'finish', reason: { kind: finishKind } }
  })()
}

function fakeLlm(text, finishKind = 'stop') {
  return {
    calls: [],
    stream(options) {
      this.calls.push(options)
      return fakeStream(text, finishKind)
    },
  }
}

function turn(ref, extra = {}) {
  return condense({
    sid: ref.split('#')[0], seq: Number(ref.split('#')[1]), ts: `2026-11-09T10:0${ref.split('#')[1]}:00+08:00`,
    user: extra.user || '把 dsh-chronicle 的打分改成 LLM', assistant: extra.assistant || '',
    tools: extra.tools || ['edit'], files: extra.files || ['E:/x/lib/llm.js'], failures: 0,
    userChars: (extra.user || '把 dsh-chronicle 的打分改成 LLM').length,
  })
}

const GOOD_JSON = `这是一天的整理：
[
  {"ref":"s-1#1","title":"接入 LLM 打分","claim":"一天一次调用产出结构化条目","basis":"改 lib/llm.js","importance":4,"kind":"delivery","entities":["dsh-chronicle","llm.js"]},
  {"ref":"s-1#2","title":"补实体图","claim":"按天快照再合并","basis":"新增 lib/entities.js","importance":3,"kind":"chore","entities":["dsh-chronicle","entities.js"]},
  {"ref":"不存在#99","title":"编造的证据","claim":"x","basis":"x","importance":5,"kind":"delivery","entities":[]},
  {"ref":"s-1#1","title":"重复 ref","claim":"x","basis":"x","importance":5,"kind":"delivery","entities":[]},
  {"ref":"s-1#2","title":"坏枚举","claim":"x","basis":"x","importance":4,"kind":"nonsense","entities":[]},
  {"ref":"s-1#2","title":"分数越界","claim":"x","basis":"x","importance":99,"kind":"chore","entities":[]}
]
收尾一句废话。`

/* ---------------- prompt 与解析 ---------------- */

test('prompt：带 ref、工具、文件、失败数，且要求只输出 JSON', () => {
  const prompt = buildScorePrompt([turn('s-1#1'), turn('s-1#2', { user: '补实体图' })])
  assert.match(prompt, /s-1#1 \|/)
  assert.match(prompt, /工具:edit/)
  assert.match(prompt, /文件:llm\.js/)
  assert.match(prompt, /失败:0/)
  assert.match(prompt, /只输出 JSON 对象/)
  assert.match(prompt, /summary/)
  assert.match(prompt, /threads/)
})

test('解析：容忍代码围栏与前后废话', () => {
  assert.deepEqual(extractJsonArray('```json\n[{"a":1}]\n```'), [{ a: 1 }])
  assert.deepEqual(extractJsonArray('前言 [{"a":2}] 后语'), [{ a: 2 }])
  assert.equal(extractJsonArray('完全没有数组'), null)
  assert.equal(extractJsonArray(''), null)
})

test('校验：编造的 ref / 重复 ref / 坏枚举 / 越界分数全部丢弃', () => {
  const refs = ['s-1#1', 's-1#2']
  const entries = normalizeEntries(extractJsonArray(GOOD_JSON), refs)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map((e) => e.ref).sort(), ['s-1#1', 's-1#2'])
  assert.equal(entries[0].importance, 4)
  assert.ok(!entries.some((e) => e.title.includes('编造')))
  assert.ok(!entries.some((e) => e.title.includes('坏枚举')))
})

test('collectText：finish 报 error 时抛错（交给上层降级）', async () => {
  await assert.rejects(collectText(fakeStream('x', 'error')))
})

test('collectText：正常时返回 text 与 finish', async () => {
  const result = await collectText(fakeStream('[]'))
  assert.equal(result.text, '[]')
  assert.equal(result.finish, 'stop')
  assert.equal(result.reasoning, '')
})

test('collectText：思考增量单独收，不混进正文', async () => {
  const stream = (async function* () {
    yield { type: 'reasoning-delta', text: '我在想…' }
    yield { type: 'text-delta', text: '[]' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const result = await collectText(stream)
  assert.equal(result.text, '[]')
  assert.match(result.reasoning, /我在想/)
})

test('正文为空时从思考内容里救回结果', async () => {
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'reasoning-delta', text: '思考：' }
        yield {
          type: 'reasoning-delta',
          text: JSON.stringify([
            { ref: 's-1#1', title: '接入 LLM 打分', claim: 'a', basis: 'b', importance: 4, kind: 'delivery', entities: [] },
          ]),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const entries = await scoreDayWithLlm({ turns: [turn('s-1#1')], llm, provider: 'p', model: 'm' })
  assert.equal(entries.length, 1)
  assert.match(entries.note, /从思考内容里取到结果/)
})

test('抢救：输出被截断时保住已完整的对象', () => {
  // 模拟 maxTokens 截断：最后一个对象只写了一半
  const truncated = `[{"ref":"s-1#1","title":"接入 LLM 打分","claim":"a","basis":"b","importance":4,"kind":"delivery","entities":[]},{"ref":"s-1#2","title":"补实体图","claim":"c","basis":"d","importance":3,"kind":"chore","entities":[]},{"ref":"s-1#3","title":"被截断`
  const objects = salvageObjects(truncated)
  assert.equal(objects.length, 2, '两个完整对象应被保住')
  assert.equal(objects[1].ref, 's-1#2')

  // 完整数组走正路，不触发抢救
  assert.equal(salvageObjects('[]').length, 0)
})

test('scoreDayWithLlm：被截断也返回可用条目并标 truncated', async () => {
  const llm = fakeLlm(
    `[{"ref":"s-1#1","title":"接入 LLM 打分","claim":"a","basis":"b","importance":4,"kind":"delivery","entities":["dsh-chronicle"]},{"ref":"s-1#2","title":"写到一半`,
    'max-tokens',
  )
  const entries = await scoreDayWithLlm({ turns: [turn('s-1#1'), turn('s-1#2')], llm, provider: 'p', model: 'm' })
  assert.equal(entries.length, 1)
  assert.equal(entries.truncated, true)
  assert.match(entries.note, /抢救 1 条/)
})

/* ---------------- 打分整链 ---------------- */

test('scoreDayWithLlm：一天一次调用，返回已校验条目', async () => {
  const llm = fakeLlm(GOOD_JSON)
  const turns = [turn('s-1#1'), turn('s-1#2')]
  const entries = await scoreDayWithLlm({ turns, llm, provider: 'deepseek', model: 'flash' })
  assert.equal(llm.calls.length, 1, '必须一天只调一次')
  assert.equal(llm.calls[0].temperature, 0)
  assert.equal(llm.calls[0].provider, 'deepseek')
  assert.equal(entries.length, 2)
})

test('scoreDayWithLlm：传了 reasoningEffort 就带进请求', async () => {
  const llm = fakeLlm(GOOD_JSON)
  await scoreDayWithLlm({ turns: [turn('s-1#1'), turn('s-1#2')], llm, provider: 'p', model: 'm', reasoningEffort: 'minimal' })
  assert.equal(llm.calls[0].reasoningEffort, 'minimal')

  const plain = fakeLlm(GOOD_JSON)
  await scoreDayWithLlm({ turns: [turn('s-1#1'), turn('s-1#2')], llm: plain, provider: 'p', model: 'm' })
  assert.ok(!('reasoningEffort' in plain.calls[0]), '没传就不该出现这个字段')
})

test('scoreDayWithLlm：没有模型或没有 llm 时返回空（走规则分）', async () => {
  const turns = [turn('s-1#1')]
  assert.deepEqual(await scoreDayWithLlm({ turns, llm: null, provider: 'p', model: 'm' }), [])
  assert.deepEqual(await scoreDayWithLlm({ turns, llm: fakeLlm(GOOD_JSON), provider: '', model: '' }), [])
  assert.deepEqual(await scoreDayWithLlm({ turns: [], llm: fakeLlm(GOOD_JSON), provider: 'p', model: 'm' }), [])
})

test('增强抛错时静默退回规则分（scoring=rule-fallback）', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-p2-fallback-'))
  try {
    await ensureDir(join(dataDir, 'events'))
    const day = '2026-11-09'
    await writeAtomic(
      join(dataDir, 'events', `${day}.jsonl`),
      [
        { v: 1, sid: 's-1', seq: 1, ts: `${day}T10:01:00+08:00`, kind: 'user', text: '把打分改成 LLM', chars: 10 },
        { v: 1, sid: 's-1', seq: 2, ts: `${day}T10:02:00+08:00`, kind: 'tool', tool: 'edit', arg: 'E:/x/lib/llm.js', path: 'E:/x/lib/llm.js' },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n',
    )
    const scored = await scoreOneDay({
      dataDir,
      day,
      enhance: async () => {
        throw new Error('模型 402')
      },
    })
    assert.equal(scored.scoring, 'rule-fallback')
    assert.ok(scored.entries.length === 1)
    // 规则分：基础 2 + 改文件 1 + "改成"含决策表述 1 = 4
    assert.equal(scored.entries[0].importance, 4)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

/* ---------------- 图 ---------------- */

test('图：同轮共现建边，边权重按出现次数累计', () => {
  const snap = buildDayGraph({
    day: '2026-11-09',
    entries: [
      { ref: 's-1#1', entities: ['dsh-chronicle', 'llm.js'] },
      { ref: 's-1#2', entities: ['dsh-chronicle', 'llm.js'] },
      { ref: 's-1#3', entities: ['dsh-chronicle'] },
    ],
  })
  const names = snap.entities.map((e) => e.name).sort()
  assert.deepEqual(names, ['dsh-chronicle', 'llm.js'])
  const edge = snap.edges.find((e) => e.a === 'dsh-chronicle' && e.b === 'llm.js')
  assert.equal(edge.weight, 2)
  assert.deepEqual(edge.evidence.sort(), ['s-1#1', 's-1#2'])
})

test('图：规则模式用文件基名兜底，不产生空实体', () => {
  const snap = buildDayGraph({
    day: '2026-11-09',
    entries: [{ ref: 's-1#1', files: ['E:/a/lib/score.js', 'E:/a/lib/outline.js'] }],
  })
  assert.deepEqual(snap.entities.map((e) => e.name).sort(), ['outline.js', 'score.js'])
})

test('图：合并幂等（同一天收口两次不会把权重加两遍）', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-p2-graph-'))
  try {
    const snap = buildDayGraph({
      day: '2026-11-09',
      entries: [{ ref: 's-1#1', entities: ['a', 'b'] }],
    })
    await writeDayGraph(dataDir, snap)
    const first = await mergeGraph(dataDir)
    await writeDayGraph(dataDir, snap) // 同一天再写一次
    const second = await mergeGraph(dataDir)
    assert.deepEqual(second, first)

    const edges = (await readFile(join(dataDir, 'graph', 'edges.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(edges.length, 1)
    assert.equal(JSON.parse(edges[0]).weight, 1)

    const neighbors = await neighborsOf(dataDir, 'a')
    assert.equal(neighbors[0].name, 'b')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('收口：LLM 档生效时写进周文件并带上图统计', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-p2-close-'))
  const vaultDir = await mkdtemp(join(tmpdir(), 'chronicle-p2-vault-'))
  try {
    await ensureDir(join(dataDir, 'events'))
    const day = '2026-11-09'
    await writeAtomic(
      join(dataDir, 'events', `${day}.jsonl`),
      [
        { v: 1, sid: 's-1', seq: 1, ts: `${day}T10:01:00+08:00`, kind: 'user', text: '把打分改成 LLM', chars: 10 },
        { v: 1, sid: 's-1', seq: 2, ts: `${day}T10:02:00+08:00`, kind: 'tool', tool: 'edit', arg: 'E:/x/lib/llm.js', path: 'E:/x/lib/llm.js' },
        { v: 1, sid: 's-1', seq: 3, ts: `${day}T10:03:00+08:00`, kind: 'user', text: '顺便补实体图', chars: 7 },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n',
    )

    const llm = fakeLlm(
      JSON.stringify([
        { ref: 's-1#1', title: '接入 LLM 打分', claim: '一天一次调用', basis: '改 lib/llm.js', importance: 4, kind: 'delivery', entities: ['dsh-chronicle', 'llm.js'] },
        { ref: 's-1#3', title: '补实体图', claim: '按天快照合并', basis: '新增 entities.js', importance: 3, kind: 'chore', entities: ['dsh-chronicle', 'entities.js'] },
      ]),
    )

    const result = await closeDay({
      dataDir,
      vaultDir,
      day,
      floor: 3,
      gitCommit: false,
      enhance: ({ turns }) => scoreDayWithLlm({ turns, llm, provider: 'deepseek', model: 'flash' }),
    })

    assert.equal(result.closed, true)
    assert.equal(result.scoring, 'llm')
    assert.equal(result.entries, 2)
    assert.ok(result.graph.entities >= 3, `图实体应 ≥3，实际 ${result.graph.entities}`)
    const text = await readFile(result.path, 'utf8')
    assert.match(text, /### ★4 接入 LLM 打分/)
    assert.match(text, /entities: \[dsh-chronicle/)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
    await rm(vaultDir, { recursive: true, force: true })
  }
})
