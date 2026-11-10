/**
 * 面板三张图的聚合（纯函数）：事实构成 + 缺口、近 N 天堆叠柱、跨天线索跨度。
 * 数值在这里验，SVG 渲染不在测试里碰。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { factsBars, dailyBuckets, arcBars, buildViz } from '../lib/viz.js'

function fact(kind, extra = {}) {
  return { kind, title: kind + '-t', statement: 's', hits: 0, ...extra }
}

test('factsBars：按类聚合并算缺口，疑问全算债', () => {
  const data = factsBars([
    fact('pitfall', { detector: '看到 X 就查 Y' }),
    fact('pitfall', { detector: '暂无明确信号' }),
    fact('decision', { expiresWhen: '用户量过千' }),
    fact('decision', { expiresWhen: '未设定' }),
    fact('convention'),
    fact('question'),
    fact('question'),
  ])
  const row = (kind) => data.rows.find((item) => item.kind === kind)
  assert.equal(row('pitfall').filled, 1, '「暂无明确信号」不算填上')
  assert.equal(row('pitfall').gap, 1)
  assert.equal(row('decision').gap, 1)
  assert.equal(row('question').gap, 2, '疑问默认算债')
  assert.equal(row('convention').filled, 1, '约定天然算填上')
  assert.equal(data.total, 7)
  assert.equal(data.debt, 4)
  assert.match(data.headline, /4 条认知债（57%）/)
  assert.match(data.headline, /其中 2 条是悬而未决的疑问/)
  assert.ok(row('pitfall').ratio <= 1 && row('pitfall').ratio > 0)
})

test('factsBars：没有缺口时给出正面结论，不是空字符串', () => {
  const data = factsBars([fact('convention'), fact('pitfall', { detector: '看到 Y' })])
  assert.equal(data.debt, 0)
  assert.match(data.headline, /无认知债/)
})

test('dailyBuckets：补齐空白天，0 条那天也占位', () => {
  const now = new Date('2026-11-10T10:00:00').getTime()
  const data = dailyBuckets(
    [
      { day: '2026-11-09', section: 'pitfalls' },
      { day: '2026-11-09', section: 'decisions' },
      { day: '2026-11-09', section: 'projects' },
      { day: '2026-11-07', section: 'threads' },
    ],
    { days: 5, now },
  )
  assert.equal(data.days.length, 5)
  assert.deepEqual(
    data.days.map((item) => item.day),
    ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'],
  )
  const ninth = data.days.find((item) => item.day === '2026-11-09')
  assert.deepEqual([ninth.pitfalls, ninth.decisions, ninth.projects, ninth.total], [1, 1, 1, 3])
  assert.equal(data.days.find((item) => item.day === '2026-11-08').total, 0, '空白天必须保留')
  assert.equal(data.days.find((item) => item.day === '2026-11-07').others, 1, 'threads 归 others')
  assert.equal(data.max, 3)
  assert.equal(data.total, 4)
})

test('dailyBuckets：窗口外的条目被忽略', () => {
  const now = new Date('2026-11-10T10:00:00').getTime()
  const data = dailyBuckets([{ day: '2026-10-01', section: 'pitfalls' }], { days: 3, now })
  assert.equal(data.total, 0)
})

test('arcBars：只收 ≥2 天的线索，按跨度降序，超出折叠', () => {
  const arcs = [
    { id: 'a', title: '三天坑', days: ['11-07', '11-08', '11-09'] },
    { id: 'b', title: '两天坑', days: ['11-08', '11-09'] },
    { id: 'c', title: '一天', days: ['11-09'] },
    { id: 'd', title: '两天坑2', days: ['11-06', '11-09'] },
  ]
  const data = arcBars(arcs, { limit: 2 })
  assert.equal(data.rows.length, 2)
  assert.equal(data.rows[0].title, '三天坑')
  assert.equal(data.rest, 1)
  assert.ok(!data.rows.some((row) => row.title === '一天'), '单日的不是线索')
})

test('buildViz：三块一起给', () => {
  const viz = buildViz({
    facts: [fact('convention')],
    entries: [{ day: '2026-11-09', section: 'decisions' }],
    arcs: [],
    days: 7,
    now: new Date('2026-11-10T10:00:00').getTime(),
  })
  assert.equal(viz.facts.total, 1)
  assert.equal(viz.daily.days.length, 7)
  assert.equal(viz.arcs.rows.length, 0)
})
