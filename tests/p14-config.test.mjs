/**
 * 口径与自检（2026-11-13 审计 P1-6 / P1-7 / P1-9 / P2 doctor）。
 *
 * 这一批的共同点：数字本身没错，但**口径不一致或没人看** ——
 * 注入预算是 80 却被乘 2、keepDays 声明了没人用、体检把累计丢弃当今日、
 * 体检不看收口台账（所以两条 P0 静默活了四天）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildInjectLine } from '../lib/recall.js'
import { pruneEventDays } from '../lib/store.js'
import { EventBuffer } from '../lib/ingest.js'
import { formatDiagnosis } from '../lib/doctor.js'

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'chronicle-d-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('P1-6 注入预算按字符：80 就是 80，不再偷偷乘 2', () => {
  const facts = [
    {
      id: 'convention-长',
      kind: 'convention',
      scope: 'general',
      project: 'p',
      status: 'single',
      bornOn: '2026-11-10',
      title: '很长的约定'.repeat(6),
      statement: '这是一条很长很长的约定正文，用来把注入行撑到超过预算。'.repeat(3),
    },
  ]
  const line = buildInjectLine({ facts, now: Date.parse('2026-11-13T12:00:00+08:00'), budgetChars: 80 })
  assert.ok(line.length <= 80, `注入行 ${line.length} 字符，超过 80`)
  assert.ok(line.startsWith('[chronicle] '))
})

test('P1-6 相关性：与 focusProject 同项目的事实优先，其次按日期新到旧', () => {
  const facts = [
    { id: 'c-old', kind: 'convention', scope: 'general', project: '别的项目', status: 'single', bornOn: '2026-11-12', title: '旧约束', statement: '别的项目的约定' },
    { id: 'c-focus', kind: 'convention', scope: 'general', project: '当前项目', status: 'single', bornOn: '2026-11-01', title: '当前约束', statement: '当前项目的约定' },
  ]
  const line = buildInjectLine({ facts, now: Date.parse('2026-11-13T12:00:00+08:00'), budgetChars: 200, focusProject: '当前项目' })
  assert.match(line, /当前约束/, '同项目的那条必须排在前面')

  const noFocus = buildInjectLine({ facts, now: Date.parse('2026-11-13T12:00:00+08:00'), budgetChars: 200 })
  assert.match(noFocus, /旧约束/, '没有焦点时按日期新到旧')
})

test('P1-9 keepDays 真的会清理过期事件文件（含 .bak），且不动别的文件', () =>
  withTmp(async (dir) => {
    const events = join(dir, 'events')
    await mkdir(events, { recursive: true })
    const files = [
      '2026-10-01.jsonl',
      '2026-10-01.jsonl.bak-20261001',
      '2026-11-10.jsonl',
      '2026-11-12.jsonl',
      'state.json',
    ]
    for (const name of files) await writeFile(join(events, name), '{}\n')

    const now = Date.parse('2026-11-13T12:00:00+08:00')
    const removed = await pruneEventDays(dir, 5, now)
    assert.deepEqual(removed, ['2026-10-01'], '只报被删的「天」，.bak 不重复报')
    const left = (await readdir(events)).sort()
    assert.ok(!left.includes('2026-10-01.jsonl'))
    assert.ok(!left.includes('2026-10-01.jsonl.bak-20261001'), '过期天的 .bak 一并清掉')
    assert.ok(left.includes('2026-11-10.jsonl'), '5 天内的必须留着')
    assert.ok(left.includes('state.json'), '非事件文件绝不动')
  }))

test('P1-9 keepDays=0 表示永不清理', () =>
  withTmp(async (dir) => {
    const events = join(dir, 'events')
    await mkdir(events, { recursive: true })
    await writeFile(join(events, '2020-01-01.jsonl'), '{}\n')
    assert.deepEqual(await pruneEventDays(dir, 0, Date.now()), [])
    assert.equal((await readdir(events)).length, 1)
  }))

test('P2 丢弃按天记账：buffer 要能报出「今天丢了多少」', () =>
  withTmp(async (dir) => {
    const buffer = new EventBuffer({ dataDir: dir, maxEventsPerDay: 2 })
    buffer.push('2026-11-13', { sid: 'a', seq: 1 })
    buffer.push('2026-11-13', { sid: 'a', seq: 2 })
    buffer.push('2026-11-13', { sid: 'a', seq: 3 })
    await buffer.flush({
      appendEvents: async (_d, _day, rows) => rows.length,
      loadSeen: async () => [],
    })
    assert.equal(buffer.dropped, 1)
    assert.equal(buffer.droppedByDay.get('2026-11-13'), 1)
  }))

test('P2 体检：把「今天/累计」与台账缺口说清楚，不再用累计值冒充今日', () => {
  const text = formatDiagnosis({
    day: '2026-11-13',
    rows: 10,
    unique: 10,
    badLines: 0,
    kinds: { user: 2, assistant: 8 },
    turns: 2,
    orphanTurns: 0,
    week: '2026-W46',
    weekFile: true,
    lastClosedDay: '2026-11-12',
    duplicateCount: 0,
    reasoningSuspect: 0,
    dropped: 0,
    droppedTotal: 651,
    pendingDays: ['2026-11-12'],
    revisitedDays: ['2026-11-12'],
    missingStamps: ['2026-11-12'],
    staleCount: 21,
    staleInconsistent: ['f1', 'f2'],
  })
  assert.match(text, /历史上因单日上限丢弃过 651 条（今天 0 条）/)
  assert.doesNotMatch(text, /⚠️ 因单日上限被丢弃 651 条/)
  assert.match(text, /没记事件时间戳 1 天：2026-11-12/)
  assert.match(text, /待收口 1 天：2026-11-12（其中重收 2026-11-12）/)
  assert.match(text, /evidenceStale 21 条，其中 2 条没有任何缺失 ref/)
})
