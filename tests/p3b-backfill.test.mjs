/**
 * 回捞：跨工作区 / 跨对话的核心。
 * 全部用假 sessionQuery，不碰真实会话。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { dayWindow, workspaceOf, pickSessions, rowsOfSnapshot, backfillDay } from '../lib/backfill.js'
import { renderWeek } from '../lib/render.js'

const DAY = '2026-11-09'
const NOON = new Date('2026-11-09T12:00:00').getTime()

function userEvent(seq, text, time = NOON) {
  return {
    type: 'user/message',
    seq,
    time,
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

function snapshot(id, cwd, events) {
  return { session: { id, cwd, createdAt: NOON }, inheritedEventCount: 0, events }
}

test('日窗口：本地日的 [start, end)', () => {
  const { start, end } = dayWindow(DAY)
  assert.equal(end - start, 86400000)
  assert.equal(new Date(start).getDate(), 9)
})

test('工作区名取 cwd 最后一段', () => {
  assert.equal(workspaceOf('E:/Documents/deepseek-harness/default-workspace'), 'default-workspace')
  assert.equal(workspaceOf('E:\\Documents\\柜门自动下单软件\\原型'), '原型')
  assert.equal(workspaceOf(''), 'unknown')
  assert.equal(workspaceOf(undefined), 'unknown')
})

test('挑会话：跳过子代理与不可用的', () => {
  const records = [
    { header: { id: 'a', cwd: '/w1' }, live: true, persisted: true },
    { header: { id: 'b', origin: 'subagent' }, live: true, persisted: true },
    { header: { id: 'c' }, live: false, persisted: false },
    { header: { id: 'd', cwd: '/w2' }, live: false, persisted: true },
  ]
  assert.deepEqual(
    pickSessions(records, { skipLive: false }).map((r) => r.header.id),
    ['a', 'd'],
  )
  assert.deepEqual(
    pickSessions(records, { includeSubagent: true, skipLive: false }).map((r) => r.header.id),
    ['a', 'b', 'd'],
  )
  assert.equal(pickSessions(records, { limit: 1 }).length, 1)
})

test('裁事件：只要当天窗口内的，并挂上工作区', () => {
  const rows = rowsOfSnapshot(
    snapshot('s1', 'E:/w/alpha', [
      userEvent(1, '今天做的'),
      userEvent(2, '昨天做的', NOON - 86400000),
      userEvent(3, '明天做的', NOON + 86400000),
    ]),
    { day: DAY },
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].seq, 1)
  assert.equal(rows[0].ws, 'alpha')
  assert.match(rows[0].cwd, /alpha$/)
})

test('回捞整天：多个工作区都会被收进来，且按 sid#seq 去重', async () => {
  const pushed = []
  const buffer = {
    push(day, row) {
      pushed.push({ day, row })
      return true
    },
  }
  const sessionQuery = {
    async listSessions() {
      return [
        { header: { id: 's1', cwd: 'E:/w/alpha' }, live: true, persisted: true },
        { header: { id: 's2', cwd: 'E:/w/beta' }, live: false, persisted: true },
        { header: { id: 's3', origin: 'subagent' }, live: true, persisted: true },
      ]
    },
    async readSession(id) {
      if (id === 's1') return snapshot('s1', 'E:/w/alpha', [userEvent(1, 'alpha 的活')])
      return snapshot('s2', 'E:/w/beta', [userEvent(1, 'beta 的活')])
    },
    async readTitleSnapshots(ids) {
      return ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { title: { title: `标题-${sessionId}` } } }))
    },
  }

  const result = await backfillDay({ sessionQuery, buffer, day: DAY, skipLive: false })
  assert.equal(result.sessions, 2, '子代理不该被读')
  assert.equal(result.rows, 2)
  assert.equal(result.errors.length, 0)
  const workspaces = pushed.map((item) => item.row.ws).sort()
  assert.deepEqual(workspaces, ['alpha', 'beta'], '两个工作区都要进来')
})

test('回捞：readSession 报错不中断其它会话', async () => {
  const buffer = { push: () => true }
  const sessionQuery = {
    async listSessions() {
      return [
        { header: { id: 'bad', cwd: '/a' }, live: true, persisted: true },
        { header: { id: 'ok', cwd: '/b' }, live: true, persisted: true },
      ]
    },
    async readSession(id) {
      if (id === 'bad') throw new Error('日志损坏')
      return snapshot('ok', '/b', [userEvent(1, '正常')])
    },
  }
  const result = await backfillDay({ sessionQuery, buffer, day: DAY, skipLive: false })
  assert.equal(result.sessions, 1)
  assert.equal(result.rows, 1)
  assert.match(result.errors.join(' '), /日志损坏/)
})

test('回捞：sessionQuery 缺失时明确报出来', async () => {
  const result = await backfillDay({ sessionQuery: null, buffer: { push: () => true }, day: DAY })
  assert.match(result.errors.join(' '), /sessionQuery/)
})

test('回捞：超过截止时间就停下，并为剩余会话留话', async () => {
  let reads = 0
  const sessionQuery = {
    async listSessions() {
      return Array.from({ length: 5 }, (_, i) => ({ header: { id: `s${i}`, cwd: '/w' }, live: true, persisted: true }))
    },
    async readSession(id) {
      reads += 1
      await new Promise((resolve) => setTimeout(resolve, 30))
      return snapshot(id, '/w', [userEvent(1, 'x')])
    },
  }
  const result = await backfillDay({ sessionQuery, buffer: { push: () => true }, day: DAY, deadlineMs: 60, skipLive: false })
  assert.equal(result.timedOut, true)
  assert.ok(result.sessions >= 1 && result.sessions < 5, `应在中途停下，实际读了 ${result.sessions}`)
  assert.match(result.errors.join(' '), /截止/)
})

test('回捞：边读边回调，调用方能先落盘', async () => {
  const progress = []
  const sessionQuery = {
    async listSessions() {
      return Array.from({ length: 4 }, (_, i) => ({ header: { id: `s${i}`, cwd: '/w' }, live: true, persisted: true }))
    },
    async readSession(id) {
      return snapshot(id, '/w', [userEvent(1, 'x')])
    },
  }
  await backfillDay({
    sessionQuery,
    buffer: { push: () => true },
    day: DAY,
    skipLive: false,
    onProgress: (partial) => progress.push(partial.sessions),
  })
  assert.ok(progress.length >= 2, '应至少回调两次（每 3 个一次 + 收尾一次）')
  assert.equal(progress[progress.length - 1], 4)
})

test('默认跳过正在运行的会话（它们由实时事件流覆盖）', () => {
  const records = [
    { header: { id: 'live', cwd: '/w' }, live: true, persisted: true },
    { header: { id: 'history', cwd: '/w' }, live: false, persisted: true },
  ]
  assert.deepEqual(
    pickSessions(records).map((r) => r.header.id),
    ['history'],
    '启动回捞不该去读正在跑的那个（内容最大、最慢）',
  )
  assert.deepEqual(
    pickSessions(records, { skipLive: false }).map((r) => r.header.id),
    ['live', 'history'],
    '手动深度回捞时两个都要',
  )
})

test('当天没动静的会话不读全文（靠轻量清单筛掉）', async () => {
  const read = []
  const sessionQuery = {
    async listSessions() {
      return [
        { header: { id: 'today', cwd: '/w' }, live: false, persisted: true },
        { header: { id: 'stale', cwd: '/w' }, live: false, persisted: true },
      ]
    },
    async listEvents(id) {
      // today 有当天事件，stale 只有前一天的
      return id === 'today'
        ? [{ seq: 1, type: 'user/message', time: NOON }]
        : [{ seq: 1, type: 'user/message', time: NOON - 3 * 86400000 }]
    },
    async readSession(id) {
      read.push(id)
      return snapshot(id, '/w', [userEvent(1, '今天的活')])
    },
  }
  const result = await backfillDay({ sessionQuery, buffer: { push: () => true }, day: DAY, skipLive: false })
  assert.deepEqual(read, ['today'], 'stale 不该被读全文')
  assert.equal(result.noEvents, 1)
  assert.equal(result.sessions, 1)
})

test('分批续补：从 startIndex 接着读，并给出下一批游标', async () => {
  const seen = []
  const sessionQuery = {
    async listSessions() {
      return Array.from({ length: 4 }, (_, i) => ({ header: { id: `s${i}`, cwd: '/w' }, live: false, persisted: true }))
    },
    async listEvents() {
      return [{ seq: 1, type: 'user/message', time: NOON }]
    },
    async readSession(id) {
      seen.push(id)
      return snapshot(id, '/w', [userEvent(1, 'x')])
    },
  }
  const first = await backfillDay({ sessionQuery, buffer: { push: () => true }, day: DAY, startIndex: 0, deadlineMs: -1 })
  assert.equal(first.done, false, 'deadline 已过应当立刻让位')
  assert.equal(first.nextIndex, 0)

  const second = await backfillDay({ sessionQuery, buffer: { push: () => true }, day: DAY, startIndex: 2 })
  assert.deepEqual(seen, ['s2', 's3'], '只处理游标之后的部分')
  assert.equal(second.nextIndex, 4)
  assert.equal(second.done, true)
  assert.equal(second.sessions, 2)
})

test('单会话卡死只跳过它，不拖住整条链', async () => {
  const read = []
  const sessionQuery = {
    async listSessions() {
      return [
        { header: { id: 'slow', cwd: '/a' }, live: false, persisted: true },
        { header: { id: 'fast', cwd: '/b' }, live: false, persisted: true },
      ]
    },
    async listEvents() {
      return [{ seq: 1, type: 'user/message', time: NOON }]
    },
    async readSession(id) {
      read.push(id)
      if (id === 'slow') await new Promise(() => {}) // 永不返回，模拟巨无霸
      return snapshot(id, '/b', [userEvent(1, '正常')])
    },
  }
  const result = await backfillDay({
    sessionQuery,
    buffer: { push: () => true },
    day: DAY,
    skipLive: false,
    deadlineMs: 2000,
  })
  assert.deepEqual(read, ['slow', 'fast'], '卡死的那个被跳过，后面的照读')
  assert.equal(result.sessions, 1, '只有 fast 读成功')
  assert.equal(result.slow, 1, '卡死的记为 slow')
})

test('渲染：跨工作区时 frontmatter 有 workspaces，条目带工作区', () => {
  const md = renderWeek({
    weekId: '2026-W46',
    days: [
      {
        day: DAY,
        entries: [
          { ref: 's1#1', title: '改 ingest.js', claim: 'a', basis: 'b', importance: 4, ws: 'dsh-chronicle' },
          { ref: 's2#1', title: '报价单列宽', claim: 'c', basis: 'd', importance: 3, ws: '柜门原型' },
          { ref: 's3#1', title: '未知来源', claim: 'e', basis: 'f', importance: 3, ws: 'unknown' },
        ],
      },
    ],
    floor: 3,
  })
  assert.match(md, /workspaces: \[.*dsh-chronicle/)
  assert.match(md, /按工作区：/)
  assert.match(md, /工作区 `dsh-chronicle`/)
  assert.match(md, /工作区 `柜门原型`/)
  assert.ok(!md.includes('工作区 `unknown`'), 'unknown 不该出现在条目里')
})
