/**
 * 数据面四项（2026-11-13 审计 P1-2 / P1-3 / P1-4 / P1-5）。
 *
 * 共同点：都是「写了但没人验」的静默失效 ——
 *   上限播种：push 已把计数写进去 ⇒ flush 的播种永远不执行；
 *   证据标记：只在 stale>0 时回写 ⇒ 清不掉的假标记；
 *   索引：五类规范之外的事实不列 ⇒ 头部数量骗人；
 *   失败信号：判据要求的字段从不被写入 ⇒ 恒 0。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EventBuffer } from '../lib/ingest.js'
import { buildTurns } from '../lib/outline.js'
import { renderMemoryIndex } from '../lib/facts.js'
import { persistEvidenceCheck } from '../lib/sections.js'

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'chronicle-b-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('P1-3 回归：上限按磁盘行数判，重启后不会重新给满额度', () =>
  withTmp(async (dir) => {
    const buffer = new EventBuffer({ dataDir: dir, maxEventsPerDay: 3 })
    buffer.push('2026-01-01', { sid: 'a', seq: 3 })
    buffer.push('2026-01-01', { sid: 'a', seq: 4 })
    let written = 0
    await buffer.flush({
      appendEvents: async (_d, _day, rows) => {
        written += rows.length
        return rows.length
      },
      // 磁盘上已经有 2 条，上限 3 ⇒ 只能再写 1 条
      loadSeen: async () => ['a#1', 'a#2'],
    })
    assert.equal(written, 1, '只能补足到上限，不能按「每进程 3 条」再写 2 条')
    assert.equal(buffer.dropped, 1, '被上限挡下的必须计数，不能静默')
  }))

test('P1-3 回归：写进磁盘的键不会重复写第二遍', () =>
  withTmp(async (dir) => {
    const buffer = new EventBuffer({ dataDir: dir, maxEventsPerDay: 100 })
    buffer.push('2026-01-01', { sid: 'a', seq: 1 })
    buffer.push('2026-01-01', { sid: 'a', seq: 2 })
    const io = {
      appendEvents: async (_d, _day, rows) => rows.length,
      loadSeen: async () => ['a#1', 'a#2'],
    }
    assert.equal(await buffer.flush(io), 0, '磁盘已有的两条不能再写')
    // 宿主重启后重放同样事件：push 会被 seen 挡住，flush 也没有新行
    buffer.push('2026-01-01', { sid: 'a', seq: 1 })
    assert.equal(await buffer.flush(io), 0)
  }))

test('P1-4 回归：五类之外的记录（note）必须出现在 MEMORY.md 并被计数', () => {
  const facts = [
    { id: 'decision-a', kind: 'decision', scope: 'general', project: 'p', title: 'A', status: 'single' },
    { id: 'note-b', kind: 'note', scope: 'general', project: 'p', title: 'B 线索', status: 'single' },
    { id: 'note-c', kind: 'note', scope: 'tool-self', project: 'p', title: 'C 自身', status: 'single' },
  ]
  const md = renderMemoryIndex({ facts, generatedAt: '2026-11-13T00:00:00Z' })
  assert.match(md, /工作记忆 2 条/)
  assert.match(md, /## 其他记录（1）/)
  assert.match(md, /\[\[note-b\]\] B 线索/)
  // tool-self 不算工作记忆，也不该混进「其他记录」
  assert.doesNotMatch(md, /## 其他记录（2）/)
})

test('P1-2 回归：证据补回来后 stale 标记必须能被清掉，且同步事实页', () =>
  withTmp(async (dir) => {
    const factsDir = join(dir, 'facts')
    const vaultDir = join(dir, 'vault')
    await mkdir(factsDir, { recursive: true })
    await mkdir(join(vaultDir, 'facts'), { recursive: true })
    await writeFile(
      join(factsDir, 'index.json'),
      JSON.stringify({
        v: 1,
        facts: [{ id: 'f1', kind: 'decision', evidenceStale: true, evidenceMissing: ['s#1'], title: 'x' }],
      }),
    )

    const stale = await persistEvidenceCheck(
      dir,
      [{ id: 'f1', evidenceStale: false, evidenceMissing: [] }],
      { vaultDir, renderPage: () => 'PAGE-CONTENT' },
    )
    assert.equal(stale, 0)
    const index = JSON.parse(await readFile(join(factsDir, 'index.json'), 'utf8'))
    assert.equal(index.facts[0].evidenceStale, false, '假标记必须被清掉')
    assert.deepEqual(index.facts[0].evidenceMissing, [])
    assert.equal(
      await readFile(join(vaultDir, 'facts', 'f1.md'), 'utf8'),
      'PAGE-CONTENT',
      '索引改了页也要改，否则两处口径不一致',
    )
  }))

test('P1-5 回归：失败次数从 tool/result 行统计，且不因它凭空造轮', () => {
  const rows = [
    { sid: 's1', seq: 1, kind: 'user', text: '做点事', ts: '2026-11-13T10:00:00+08:00' },
    { sid: 's1', seq: 2, kind: 'tool', tool: 'ops_bash', ts: '2026-11-13T10:00:01+08:00' },
    { sid: 's1', seq: 3, kind: 'toolresult', ok: false, ts: '2026-11-13T10:00:02+08:00' },
    { sid: 's1', seq: 4, kind: 'toolresult', ok: true, ts: '2026-11-13T10:00:03+08:00' },
  ]
  const turns = buildTurns(rows)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].failures, 1, 'ok:false 的 toolresult 必须算进失败数')

  // 只有 toolresult 的会话（截断过的日志）不该冒出一个占位轮
  const lonely = buildTurns([{ sid: 's2', seq: 9, kind: 'toolresult', ok: false, ts: '2026-11-13T11:00:00+08:00' }])
  assert.equal(lonely.length, 0)
})
