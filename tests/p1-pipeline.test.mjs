/**
 * P1 流水线：脱敏 / 纲要 / 打分 / 渲染幂等 / 收口落盘。
 * 用真实临时目录跑 end-to-end（不碰真实 vault）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { redactText } from '../lib/redact.js'
import { buildTurns, condense } from '../lib/outline.js'
import { ruleScore, scoreDay } from '../lib/score.js'
import { renderWeek } from '../lib/render.js'
import { dayKey, weekId, settledDays } from '../lib/time.js'
import { eventToRow, prepareRow, EventBuffer } from '../lib/ingest.js'
import { appendEvents, readEvents } from '../lib/store.js'
import { createSerializer } from '../lib/serialize.js'
import { diagnose, formatDiagnosis } from '../lib/doctor.js'
import { closeDay } from '../lib/close.js'

/* ---------------- 脱敏 ---------------- */

test('脱敏：密钥/手机/邮箱/私钥块都替换', () => {
  const cases = [
    ['openai-key', 'export KEY=(sk-abcdefghijklmnopqrstuvwx)'],
    ['phone-cn', '电话 13812345678 联系我'],
    ['email', '发到 zuoyunlai@example.com'],
    ['private-key', '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'],
    ['github-token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ]
  for (const [label, text] of cases) {
    const out = redactText(text)
    assert.ok(out.total > 0, `${label} 应当命中`)
    assert.ok(!out.text.includes('sk-abcdef'), 'sk- 明文不应留下')
    assert.match(out.text, /«REDACTED:/)
  }
})

test('脱敏：别把普通词吃掉（左边界）', () => {
  for (const text of ['task-runner', 'disk-usage', 'cordis.patch.yml.bak-20260827', 'mask-it']) {
    const out = redactText(text)
    assert.equal(out.total, 0, `${text} 不应被脱敏`)
    assert.equal(out.text, text)
  }
})

/* ---------------- 纲要 + 打分 ---------------- */

function row(kind, seq, extra = {}) {
  return { v: 1, sid: 's1', seq, ts: `2026-11-09T10:0${seq}:00+08:00`, kind, ...extra }
}

test('纲要：用户消息开新轮，工具与助手挂到该轮', () => {
  const rows = [
    row('user', 1, { text: '修复发版脚本', chars: 6 }),
    row('tool', 2, { tool: 'write', path: 'E:/x/a.js' }),
    row('tool', 3, { tool: 'ops_bash', ok: false }),
    row('assistant', 4, { text: '改好了' }),
    row('user', 5, { text: '再跑一遍测试', chars: 7 }),
  ]
  const turns = buildTurns(rows)
  assert.equal(turns.length, 2)
  assert.equal(turns[0].tools.length, 2)
  assert.equal(turns[0].files.length, 1)
  assert.equal(turns[0].failures, 1)
  assert.match(turns[0].assistantHead, /改好了/)
  assert.equal(turns[1].tools.length, 0)
})

test('打分：不可逆动作 + 改文件 → 5；寒暄 → 1', () => {
  const hot = condense({
    sid: 's1', seq: 1, ts: '', user: '帮我发版并推送到远端', assistant: '', tools: ['write'], files: ['a.js'], failures: 0, userChars: 10,
  })
  const cold = condense({
    sid: 's2', seq: 1, ts: '', user: '你好', assistant: '', tools: [], files: [], failures: 0, userChars: 2,
  })
  assert.equal(ruleScore(hot).importance, 5)
  assert.equal(ruleScore(cold).importance, 1)
  assert.equal(ruleScore(hot).kind, 'delivery')
  assert.ok(ruleScore(hot).basis.includes('不可逆动作'))
})

test('打分：纯提问不因泛词被误判成决策（候选矩阵回归）', () => {
  const turn = condense({
    sid: 's1', seq: 1, ts: '', user: '有没有一个插件能自动记录我每天做的事？',
    assistant: '没有一把梭的，但有候选矩阵。', tools: ['plugin_manager'], files: [], failures: 0, userChars: 20,
  })
  const scored = ruleScore(turn)
  assert.ok(!scored.basis.includes('含决策表述'), `不应误判决策，实际：${scored.basis}`)
  assert.ok(scored.importance <= 3, `纯提问不该拿高分，实际 ${scored.importance}`)
})

test('标题：用户只说"已经重启"时回退到实际动了什么', () => {
  const terse = condense({
    sid: 's1', seq: 1, ts: '', user: '已经重启', assistant: '工具已加载，两个工具都在。',
    tools: ['edit', 'ops_bash'], files: ['E:/x/lib/score.js'], failures: 0, userChars: 4,
  })
  const scored = ruleScore(terse)
  assert.equal(scored.title, '改 score.js', `不应产出"已经重启"这种标题，实际：${scored.title}`)
  // 结论也要回退到助手那句，而不是复读"已经重启"
  assert.match(scored.claim, /工具已加载/)

  const informative = condense({
    sid: 's1', seq: 2, ts: '', user: '帮我发版并推送远端', assistant: '',
    tools: [], files: [], failures: 0, userChars: 9,
  })
  assert.equal(ruleScore(informative).title, '帮我发版并推送远端')
})

test('打分：整天按重要度降序', () => {
  const turns = [
    condense({ sid: 'a', seq: 1, ts: '', user: '你好', assistant: '', tools: [], files: [], failures: 0, userChars: 2 }),
    condense({ sid: 'a', seq: 2, ts: '', user: '部署到生产并删除旧数据', assistant: '', tools: [], files: ['x.js'], failures: 0, userChars: 12 }),
    condense({ sid: 'a', seq: 3, ts: '', user: '查一下这个报错原因', assistant: '', tools: ['read'], files: [], failures: 0, userChars: 9 }),
  ]
  const scored = scoreDay(turns)
  const values = scored.map((e) => e.importance)
  assert.deepEqual(values, [...values].sort((x, y) => y - x))
  assert.equal(values[0], 5)
})

/* ---------------- 时间 ---------------- */

test('时间：日键与 ISO 周号', () => {
  const ms = new Date('2026-11-09T12:00:00').getTime()
  assert.equal(dayKey(ms), '2026-11-09')
  assert.match(weekId(ms), /^2026-W\d{2}$/)
  // 方案 B：今天永远不收，只收已经过完的天
  const tonight = settledDays({
    now: new Date('2026-11-09T23:55:00').getTime(),
    daysWithEvents: ['2026-11-09'],
    closedDays: [],
  })
  assert.deepEqual(tonight.days, [], '当天还没过完，不能收')
  const nextMorning = settledDays({
    now: new Date('2026-11-10T09:00:00').getTime(),
    daysWithEvents: ['2026-11-09'],
    closedDays: [],
  })
  assert.deepEqual(nextMorning.days, ['2026-11-09'], '跨过午夜后收昨天')
})

/* ---------------- 事件归类 ---------------- */

test('事件归类：插件注入的消息被丢掉，写工具带出路径', () => {
  const session = { id: 's1' }
  const injected = eventToRow(session, {
    type: 'user/message', seq: 1, time: Date.now(),
    data: { role: 'user', content: [{ type: 'text', text: '宿主注入' }], source: { kind: 'plugin:openviking-memory' } },
  })
  assert.equal(injected, null)

  const real = eventToRow(session, {
    type: 'user/message', seq: 2, time: Date.now(),
    data: { role: 'user', content: [{ type: 'text', text: '修一下这个' }], source: { kind: 'user' } },
  })
  assert.equal(real.kind, 'user')
  assert.equal(real.text, '修一下这个')

  const tool = eventToRow(session, {
    type: 'tool/call', seq: 3, time: Date.now(),
    data: { callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: 'E:/x/a.js', content: 'x' }) },
  })
  assert.equal(tool.kind, 'tool')
  assert.equal(tool.path, 'E:/x/a.js')
})

test('事件归类：脱敏在落盘前完成', () => {
  const prepared = prepareRow(
    { id: 's1' },
    {
      type: 'user/message', seq: 1, time: Date.now(),
      data: { role: 'user', content: [{ type: 'text', text: 'key 是 sk-abcdefghijklmnopqrstuvwx' }], source: { kind: 'user' } },
    },
    true,
  )
  assert.ok(prepared)
  assert.ok(!JSON.stringify(prepared.row).includes('sk-abcdefghijklmnop'))
})

/* ---------------- 渲染幂等 + 收口 ---------------- */

test('渲染：同样输入逐字节相同', () => {
  const entries = [
    { ref: 's1#1', title: '发版 v0.2.0', claim: '已发版', basis: '不可逆动作', importance: 5 },
    { ref: 's2#1', title: '你好', claim: '你好', basis: '寒暄', importance: 1 },
  ]
  const input = { weekId: '2026-W46', days: [{ day: '2026-11-09', entries }], floor: 3, promptVersion: 'v1' }
  assert.equal(renderWeek(input), renderWeek(input))
  const md = renderWeek(input)
  assert.match(md, /^---\nid: 2026-W46/m)
  assert.match(md, /### ★5 发版 v0\.2\.0/)
  assert.match(md, /低分流水/)
  assert.ok(!/generatedAt|mtime/.test(md), 'frontmatter 不能有会漂移的字段')
})

test('收口：写周文件，重复收口逐字节不变', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-data-'))
  const vaultDir = await mkdtemp(join(tmpdir(), 'chronicle-vault-'))
  try {
    await mkdir(join(dataDir, 'events'), { recursive: true })
    const day = '2026-11-09'
    const lines = [
      { v: 1, sid: 's1', seq: 1, ts: `${day}T10:00:00+08:00`, kind: 'user', text: '发版并推送 chronicle 0.2.0', chars: 18 },
      { v: 1, sid: 's1', seq: 2, ts: `${day}T10:01:00+08:00`, kind: 'tool', tool: 'write', arg: 'E:/x/index.js', path: 'E:/x/index.js' },
      { v: 1, sid: 's2', seq: 1, ts: `${day}T11:00:00+08:00`, kind: 'user', text: '你好', chars: 2 },
    ]
    await writeFile(join(dataDir, 'events', `${day}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

    const first = await closeDay({ dataDir, vaultDir, day, floor: 3, gitCommit: false })
    assert.equal(first.closed, true)
    assert.equal(first.entries, 2)
    const expectedWeek = weekId(new Date(`${day}T12:00:00`).getTime())
    assert.equal(first.week, expectedWeek)
    const text1 = await readFile(join(vaultDir, 'chronicle', `${expectedWeek}.md`), 'utf8')
    assert.match(text1, /发版并推送 chronicle 0\.2\.0/)
    assert.match(text1, /低分流水/)

    const second = await closeDay({ dataDir, vaultDir, day, floor: 3, gitCommit: false })
    const text2 = await readFile(join(vaultDir, 'chronicle', `${expectedWeek}.md`), 'utf8')
    assert.equal(text1, text2, '收口必须幂等：第二次结果应与第一次逐字节相同')
    assert.equal(second.entries, 2)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
    await rm(vaultDir, { recursive: true, force: true })
  }
})

test('事件归类：思考块不进日志（v0.2.1 现场抓到）', () => {
  const row = eventToRow(
    { id: 's1' },
    {
      type: 'assistant/message', seq: 9, time: Date.now(),
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '我先想想……这段内心独白绝不能当天做了什么事' },
            { type: 'text', text: 'P1 已生效，两个工具都在。' },
            { type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' },
          ],
          source: { kind: 'model' },
        },
      },
    },
  )
  assert.ok(row)
  assert.equal(row.kind, 'assistant')
  assert.match(row.text, /P1 已生效/)
  assert.ok(!row.text.includes('内心独白'), '思考块必须被排除')
})

test('事件归类：只有思考块时整条丢弃', () => {
  const row = eventToRow(
    { id: 's1' },
    {
      type: 'assistant/message', seq: 10, time: Date.now(),
      data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '只有思考' }], source: { kind: 'model' } } },
    },
  )
  assert.equal(row, null)
})

test('缓冲：跨进程去重（宿主重放不会写出重复行）', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-dedupe-'))
  try {
    const io = {
      appendEvents,
      loadSeen: async (day) => (await readEvents(dataDir, day)).rows.map((r) => `${r.sid}#${r.seq}`),
    }
    const rowA = { v: 1, sid: 's1', seq: 7, ts: '2026-11-09T10:00:00+08:00', kind: 'user', text: '第一次' }

    const first = new EventBuffer({ dataDir })
    first.push('2026-11-09', rowA)
    assert.equal(await first.flush(io), 1)

    // 模拟重启：全新缓冲、内存里没有任何记忆
    const second = new EventBuffer({ dataDir })
    second.push('2026-11-09', rowA)
    assert.equal(await second.flush(io), 0, '同一 sid#seq 不应重复写入')

    // 同一天新事件仍要正常写
    second.push('2026-11-09', { ...rowA, seq: 8, text: '第二次' })
    assert.equal(await second.flush(io), 1)

    const { rows } = await readEvents(dataDir, '2026-11-09')
    assert.equal(rows.length, 2)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('串行化：并发任务不重叠（落盘重复行的根因）', async () => {
  const run = createSerializer()
  const order = []
  let active = 0
  const task = (name, ms) => async () => {
    active += 1
    assert.equal(active, 1, '任何时刻只允许一个任务在跑')
    await new Promise((resolve) => setTimeout(resolve, ms))
    order.push(name)
    active -= 1
    return name
  }
  const results = await Promise.all([run(task('a', 20)), run(task('b', 5)), run(task('c', 1))])
  assert.deepEqual(results, ['a', 'b', 'c'])
  assert.deepEqual(order, ['a', 'b', 'c'])
})

test('串行化：一个任务抛错不卡死队列', async () => {
  const run = createSerializer()
  await assert.rejects(run(async () => { throw new Error('boom') }))
  const after = await run(async () => 'ok')
  assert.equal(after, 'ok')
})

test('体检：能报出重复键与思考污染', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-doctor-'))
  const vaultDir = await mkdtemp(join(tmpdir(), 'chronicle-doctor-vault-'))
  try {
    await mkdir(join(dataDir, 'events'), { recursive: true })
    const day = '2026-11-09'
    const rows = [
      { v: 1, sid: 's1', seq: 1, ts: `${day}T10:00:00+08:00`, kind: 'user', text: '你好', chars: 2 },
      { v: 1, sid: 's1', seq: 1, ts: `${day}T10:00:00+08:00`, kind: 'user', text: '你好', chars: 2 },
      { v: 1, sid: 's1', seq: 2, ts: `${day}T10:01:00+08:00`, kind: 'assistant', text: 'Let me do 1 & 2 in parallel, then reply.' },
    ]
    await writeFile(join(dataDir, 'events', `${day}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

    const report = await diagnose({ dataDir, vaultDir, day })
    assert.equal(report.rows, 3)
    assert.equal(report.unique, 2)
    assert.equal(report.duplicateCount, 1)
    assert.equal(report.reasoningSuspect, 1)
    assert.equal(report.weekFile, false)
    // 重复的两条 user 行各开一轮 ⇒ 2 轮；但都带用户输入 ⇒ 占位轮 0
    // （0.2.3 首版把每轮都算成占位轮，这里锁住）
    assert.equal(report.turns, 2)
    assert.equal(report.orphanTurns, 0)
    const text = formatDiagnosis(report)
    assert.match(text, /重复键 1 个/)
    assert.match(text, /疑似思考污染 1 行/)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
    await rm(vaultDir, { recursive: true, force: true })
  }
})

test('收口：没有事件的一天不生成文件', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-empty-'))
  const vaultDir = await mkdtemp(join(tmpdir(), 'chronicle-emptyv-'))
  try {
    const result = await closeDay({ dataDir, vaultDir, day: '2026-11-01', floor: 3, gitCommit: false })
    assert.equal(result.closed, false)
    assert.equal(result.reason, 'no-events')
    assert.equal(result.day, '2026-11-01', '未收口也要带回 day，否则前端只能显示 undefined')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
    await rm(vaultDir, { recursive: true, force: true })
  }
})
