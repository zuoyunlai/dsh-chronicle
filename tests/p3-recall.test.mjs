/**
 * P3：检索、图扩散、一行注入。
 * 用 fixture 条目，不碰真实数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tokenize, searchEntries, buildAdjacency, expandHops, buildInjectLine, recency, loadEntries } from '../lib/recall.js'
import { writeAtomic, ensureDir } from '../lib/store.js'

const NOW = new Date('2026-11-09T21:00:00+08:00').getTime()

function entry(over = {}) {
  return {
    ref: 's-1#1',
    ts: '2026-11-09T20:00:00+08:00',
    day: '2026-11-09',
    title: '修采集层：思考块与重复行',
    claim: '思考块被当正文落盘',
    basis: '改 ingest.js',
    importance: 4,
    kind: 'pitfall',
    entities: ['dsh-chronicle', 'ingest.js'],
    ...over,
  }
}

test('分词：中文 2-gram + 拉丁词', () => {
  const tokens = tokenize('重复行 flush 问题')
  assert.ok(tokens.has('重复'))
  assert.ok(tokens.has('复行'))
  assert.ok(tokens.has('flush'))
})

test('检索：实体精确命中压过纯关键词', () => {
  const entries = [
    entry({ ref: 'a', title: '改 ingest.js', claim: '无关', entities: ['ingest.js'] }),
    entry({ ref: 'b', title: '别的活', claim: '提到重复行三个字', entities: ['dsh-chronicle'] }),
  ]
  const results = searchEntries(entries, 'ingest.js', { now: NOW })
  assert.equal(results[0].ref, 'a')
  assert.ok(results[0].entityHits >= 1)
})

test('检索（C1 简化后）：只靠词面与实体名，不再用图 2 跳把无关条目带出来', () => {
  const entries = [
    entry({ ref: 'a', entities: ['dsh-chronicle'] }),
    entry({ ref: 'b', title: '改 llm.js', claim: '和 chronicle 一起改的', entities: ['llm.js'] }),
  ]
  const edges = [{ a: 'dsh-chronicle', b: 'llm.js', weight: 3 }]
  const results = searchEntries(entries, 'dsh-chronicle', { edges, now: NOW })
  const refs = results.map((r) => r.ref)
  // a 的实体名直接命中；b 因为正文里出现了「chronicle」子串，靠单字回退捞回，
  // 但**不是**靠图扩散——所以 hopHit 必须恒为 0（2026-11-13 产品反哺 C1）。
  assert.ok(refs.includes('a'))
  for (const r of results) assert.equal(r.hopHit, 0)
})

test('检索：空查询与全不命中都返回空', () => {
  const entries = [entry()]
  assert.deepEqual(searchEntries(entries, '', { now: NOW }), [])
  assert.deepEqual(searchEntries(entries, 'zzzzz', { now: NOW }), [])
})

test('衰减：越老越低，且不会为负', () => {
  const fresh = recency('2026-11-09T20:00:00+08:00', NOW)
  const old = recency('2026-08-01T20:00:00+08:00', NOW)
  assert.ok(fresh > old)
  assert.ok(old > 0)
  assert.equal(recency('坏时间', NOW), 0.5)
})

test('扩散：2 跳权重低于 1 跳', () => {
  const adj = buildAdjacency([
    { a: 'a', b: 'b', weight: 1 },
    { a: 'b', b: 'c', weight: 1 },
  ])
  const weights = expandHops(adj, ['a'], 2)
  assert.ok(weights.get('b') > weights.get('c'))
})

test('注入：当天没记录就空串；有记录只出一行且守预算', () => {
  assert.equal(buildInjectLine({ entries: [], now: NOW }), '')
  assert.equal(buildInjectLine({ entries: [entry({ day: '2026-11-08' })], now: NOW }), '')

  const line = buildInjectLine({
    entries: [entry(), entry({ ref: 's-1#2', title: '另一件事', importance: 5 })],
    now: NOW,
    budgetChars: 200,
  })
  assert.ok(line.startsWith('[chronicle] 今天 2 条'))
  assert.ok(line.includes('★5'))
  assert.ok(line.split('\n').length === 1, '注入必须只有一行')

  const shrunk = buildInjectLine({ entries: [entry()], now: NOW, budgetChars: 30 })
  assert.ok(shrunk.length <= 30, `预算外，实际 ${shrunk.length}`)
})

test('镜像：loadEntries 读回 close 写的 index/*.json', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-p3-'))
  try {
    await ensureDir(join(dataDir, 'index'))
    await writeAtomic(
      join(dataDir, 'index', '2026-W46.json'),
      JSON.stringify({ v: 1, week: '2026-W46', days: ['2026-11-09'], entries: [entry()] }),
    )
    const entries = await loadEntries(dataDir)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].week, '2026-W46')
    assert.equal(entries[0].day, '2026-11-09')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
