/**
 * 收口台账：closedDays 与 closedStamps 必须同写（2026-11-13 审计 P0-1 / P0-2）。
 *
 * 两个真实故障：
 *   · 定时器路径只写 stamp 不写 closedDays ⇒ 跨午夜后每个 tick 把同一天重收一遍（5 分钟循环）；
 *   · 手动路径只写 closedDays 不写 stamp ⇒ 这一天之后回捞补进的事件永远不再进产物
 *     （2026-11-12 因此丢了 15:51 之后 2,306 条事件，占当天 60.6%）。
 *
 * 这两条都不是「功能少做」而是「两条路径各写一半」，所以修复点必须是**唯一入口**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { applyCloseLedger, settledDays, dayKey } from '../lib/time.js'

const NOW = Date.parse('2026-11-14T10:00:00+08:00')

test('台账：一次收口同时写 closedDays 与 closedStamps', () => {
  const s = {}
  applyCloseLedger(s, { day: '2026-11-13', week: '2026-W46', at: NOW, reason: 'interval', stamp: 1000 })
  assert.deepEqual(s.closedDays, ['2026-11-13'])
  assert.equal(s.closedStamps['2026-11-13'], 1000)
  assert.equal(s.lastClosedDay, '2026-11-13')
  assert.deepEqual(s.lastClose, { day: '2026-11-13', week: '2026-W46', at: NOW, reason: 'interval' })
})

test('P0-1 回归：定时器收口后，下一个 tick 不再重收同一天', () => {
  const s = {}
  applyCloseLedger(s, { day: '2026-11-13', week: '2026-W46', at: NOW, reason: 'interval', stamp: 1000 })
  const first = settledDays({
    now: NOW,
    daysWithEvents: ['2026-11-13'],
    closedDays: s.closedDays,
    dayStamps: { '2026-11-13': 1000 },
    closedStamps: s.closedStamps,
  })
  assert.deepEqual(first.days, [])
  assert.deepEqual(first.revisited, [])

  // 再跑一次（模拟 5 分钟后的 tick）：仍然不该收
  const second = settledDays({
    now: NOW,
    daysWithEvents: ['2026-11-13'],
    closedDays: s.closedDays,
    dayStamps: { '2026-11-13': 1000 },
    closedStamps: s.closedStamps,
  })
  assert.deepEqual(second.days, [])
})

test('P0-2 回归：手动收口后事件变新 ⇒ 该天进入重收', () => {
  const s = {}
  applyCloseLedger(s, { day: '2026-11-12', week: '2026-W46', at: NOW, reason: 'manual', stamp: 1000 })
  const later = settledDays({
    now: NOW,
    daysWithEvents: ['2026-11-12'],
    closedDays: s.closedDays,
    dayStamps: { '2026-11-12': 2000 }, // 收口之后又写进了新事件
    closedStamps: s.closedStamps,
  })
  assert.deepEqual(later.days, ['2026-11-12'])
  assert.deepEqual(later.revisited, ['2026-11-12'])
})

test('P0-2 反向：手动收口后事件没变 ⇒ 不重收（不能靠重收掩盖问题）', () => {
  const s = {}
  applyCloseLedger(s, { day: '2026-11-12', at: NOW, reason: 'manual', stamp: 1000 })
  const same = settledDays({
    now: NOW,
    daysWithEvents: ['2026-11-12'],
    closedDays: s.closedDays,
    dayStamps: { '2026-11-12': 1000 },
    closedStamps: s.closedStamps,
  })
  assert.deepEqual(same.days, [])
})

test('拿不到 mtime（stamp=0）时只记账，不写戳、也不误判重收', () => {
  const s = {}
  applyCloseLedger(s, { day: '2026-11-12', at: NOW, reason: 'manual', stamp: 0 })
  assert.deepEqual(s.closedDays, ['2026-11-12'])
  assert.equal(s.closedStamps, undefined)
  const r = settledDays({
    now: NOW,
    daysWithEvents: ['2026-11-12'],
    closedDays: s.closedDays,
    dayStamps: { '2026-11-12': 9999 },
    closedStamps: s.closedStamps,
  })
  // 没有戳就无从判断「变了没」——保守选择是不重收（宁可漏一次，也不刷屏）
  assert.deepEqual(r.days, [])
})

test('戳按 90 天裁剪，closedDays 按 60 天封顶且保留最近的天', () => {
  const old = dayKey(NOW - 200 * 86400000)
  const s = { closedStamps: { [old]: 111 } }
  applyCloseLedger(s, { day: '2026-11-13', at: NOW, stamp: 222 })
  assert.equal(s.closedStamps[old], undefined, '超过 90 天的戳必须被裁掉')
  assert.equal(s.closedStamps['2026-11-13'], 222)

  const many = { closedDays: [] }
  for (let i = 0; i < 70; i += 1) {
    const day = dayKey(NOW - i * 86400000)
    applyCloseLedger(many, { day, at: NOW, stamp: 1 })
  }
  assert.equal(many.closedDays.length, 60)
  assert.equal(many.closedDays.at(-1), dayKey(NOW))
})

test('重复收口同一天不产生重复条目', () => {
  const s = {}
  applyCloseLedger(s, { day: '2026-11-13', at: NOW, stamp: 1 })
  applyCloseLedger(s, { day: '2026-11-13', at: NOW + 1000, stamp: 2 })
  assert.deepEqual(s.closedDays, ['2026-11-13'])
  assert.equal(s.closedStamps['2026-11-13'], 2, '戳要跟着最新一次收口更新')
})

test('收口历史某天不得把「还没过完的今天」写进周文件（2026-11-13 复跑发现）', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { daysOfWeek } = await import('../lib/close.js')
  const dir = await mkdtemp(join(tmpdir(), 'chronicle-week-'))
  try {
    await mkdir(join(dir, 'events'), { recursive: true })
    for (const day of ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']) {
      await writeFile(join(dir, 'events', `${day}.jsonl`), '')
    }
    const days = await daysOfWeek(dir, '2026-W46', '2026-11-12')
    assert.deepEqual(days, ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'])
    assert.ok(!days.includes('2026-11-13'), '今天还没过完，不能被收进去')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ---------- 一次性戳迁移（2026-11-14，方案 A） ---------- */

test('迁移：补全 / 跳过无事件文件的天 / 不覆盖已有戳 / 幂等', async () => {
  const { migrateStamps } = await import('../lib/time.js')
  const state = {
    closedDays: ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'],
    closedStamps: { '2026-11-12': 999 },
  }
  const dayStamps = { '2026-11-09': 100, '2026-11-10': 200, '2026-11-12': 888 }
  const first = migrateStamps(state, { dayStamps, version: 1, at: 1000 })
  assert.equal(first.alreadyDone, false)
  assert.deepEqual(first.filled, ['2026-11-09', '2026-11-10'])
  assert.deepEqual(first.skipped, ['2026-11-11'], '没有事件文件的天不造假戳')
  assert.equal(state.closedStamps['2026-11-12'], 999, '已有戳不能被覆盖')
  assert.equal(state.closedStamps['2026-11-09'], 100)
  assert.equal(state.stampsMigration, 1)

  const second = migrateStamps(state, { dayStamps, version: 1 })
  assert.equal(second.alreadyDone, true)
  assert.equal(second.changed, false)
})

test('迁移后：补过戳的天若事件再变，仍会进入重收（语义没被破坏）', async () => {
  const { migrateStamps } = await import('../lib/time.js')
  const state = { closedDays: ['2026-11-09'], closedStamps: {} }
  migrateStamps(state, { dayStamps: { '2026-11-09': 100 }, version: 1 })
  const r = settledDays({
    now: Date.parse('2026-11-14T10:00:00+08:00'),
    daysWithEvents: ['2026-11-09'],
    closedDays: state.closedDays,
    dayStamps: { '2026-11-09': 300 },
    closedStamps: state.closedStamps,
  })
  assert.deepEqual(r.days, ['2026-11-09'])
  assert.deepEqual(r.revisited, ['2026-11-09'])
})
