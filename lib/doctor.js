/**
 * 自检：把「日志健康」用一次调用说清楚，而不是每次靠人去翻 jsonl。
 *
 * 为什么需要它：0.2.0→0.2.2 连续三个缺陷（服务未 inject、思考块污染、重启重放重复）
 * 每一次都是"装上跑一遍才现形"。与其每次重启后人工 grep，不如让工具自己报。
 *
 * 只读：不改文件、不删行。
 */
import { readEvents, readState, weekFilePath, exists, listEventDays, eventDayStamps } from './store.js'
import { readFacts } from './facts.js'
import { buildTurns } from './outline.js'
import { weekId, settledDays, dayKey } from './time.js'

/** 疑似思考污染的痕迹（0.2.2 起不该再出现；历史行仍可能带）。 */
const REASONING_HINTS = [
  'Let me ',
  'Let me do',
  'Now reply',
  'Memory entry',
  'I need to',
  '正在准备',
  // '我先'/'让我'/'接下来我' 在正常发言里太常见（实测误报率 5%），已移除
]

function looksLikeReasoning(text) {
  const value = String(text || '')
  if (value.length < 20) return false
  return REASONING_HINTS.some((hint) => value.includes(hint))
}

/**
 * 体检某一天。
 * @returns 结构化的健康报告（供 render 与测试共用）
 */
export async function diagnose({ dataDir, vaultDir, day }) {
  const { rows, badLines } = await readEvents(dataDir, day)
  const keys = new Map()
  const duplicates = []
  for (const row of rows) {
    const key = `${row.sid}#${row.seq}`
    if (keys.has(key)) duplicates.push(key)
    else keys.set(key, true)
  }

  const kinds = {}
  for (const row of rows) kinds[row.kind] = (kinds[row.kind] || 0) + 1

  const suspicious = rows.filter((row) => row.kind === 'assistant' && looksLikeReasoning(row.text))
  // 注意：buildTurns 返回的是**已压过的纲要**（字段是 userHead，不是 user）。
  // 0.2.3 第一版这里判断 `!turn.user`，结果每一轮都被算成占位轮（3 轮全占位）。
  const turns = buildTurns(rows)
  const orphans = turns.filter((turn) => !turn.userHead || turn.userChars === 0).length

  const week = weekId(new Date(`${day}T12:00:00`).getTime())
  const path = weekFilePath(vaultDir, week)
  const state = await readState(dataDir)

  // 收口台账体检：2026-11-13 审计的两条 P0 都是「台账只写了一半」，
  // 而原来自检完全不看台账 —— 所以它们静默活了四天。这三项就是那时的缺口。
  const now = Date.now()
  let pendingDays = []
  let revisitedDays = []
  let missingStamps = []
  try {
    const days = await listEventDays(dataDir)
    const stamps = await eventDayStamps(dataDir)
    const settled = settledDays({
      now,
      daysWithEvents: days,
      closedDays: state.closedDays,
      dayStamps: stamps,
      closedStamps: state.closedStamps,
      lookback: 400,
    })
    pendingDays = settled.days
    revisitedDays = settled.revisited
    missingStamps = (Array.isArray(state.closedDays) ? state.closedDays : []).filter(
      (item) => !(state.closedStamps && state.closedStamps[item]),
    )
  } catch {
    /* 台账读不出来不该让体检整份失败 */
  }

  // 事实层体检：stale 却没有任何 missing refs = 自相矛盾的假标记
  // （实测 21/75 条正是这个形态：标记留着、refs 其实都在）
  let staleCount = 0
  let staleInconsistent = []
  try {
    const facts = await readFacts(dataDir)
    const stale = facts.filter((fact) => fact.evidenceStale)
    staleCount = stale.length
    staleInconsistent = stale.filter((fact) => (fact.evidenceMissing || []).length === 0).map((fact) => fact.id)
  } catch {
    /* 事实层坏了不影响体检主体 */
  }

  return {
    day,
    rows: rows.length,
    unique: keys.size,
    duplicates: duplicates.slice(0, 10),
    duplicateCount: duplicates.length,
    badLines,
    kinds,
    reasoningSuspect: suspicious.length,
    reasoningSamples: suspicious.slice(0, 2).map((row) => ({ seq: row.seq, head: String(row.text).slice(0, 60) })),
    turns: turns.length,
    orphanTurns: orphans,
    week,
    weekFile: await exists(path),
    lastClosedDay: state.lastClosedDay || '',
    promptVersion: state.promptVersion || 'v1',
    // 按天记账：累计值不能冒充「今天丢了多少」
    dropped: Number((state.droppedByDay || {})[day]) || 0,
    droppedTotal: Number(state.dropped) || 0,
    pendingDays,
    revisitedDays,
    missingStamps,
    staleCount,
    staleInconsistent: staleInconsistent.slice(0, 10),
  }
}

/** 把体检结果说成人话。 */
export function formatDiagnosis(report) {
  const lines = [
    `${report.day} · ${report.rows} 行（唯一 ${report.unique}）· 坏行 ${report.badLines}`,
    `类型 ${Object.entries(report.kinds).map(([k, v]) => `${k}:${v}`).join(' ')}`,
    `轮次 ${report.turns}（无用户输入的占位轮 ${report.orphanTurns}）`,
    `周文件 ${report.week}${report.weekFile ? ' 已生成' : ' 未生成'} · 上次收口 ${report.lastClosedDay || '（还没收过）'}`,
  ]
  if (report.duplicateCount > 0) {
    lines.push(`⚠️ 重复键 ${report.duplicateCount} 个：${report.duplicates.slice(0, 5).join(', ')}`)
  } else {
    lines.push('✅ 无重复键')
  }
  if (report.reasoningSuspect > 0) {
    const sample = report.reasoningSamples.map((s) => `#${s.seq} ${s.head}`).join(' | ')
    lines.push(`⚠️ 疑似思考污染 ${report.reasoningSuspect} 行（0.2.2 之前的历史行）：${sample}`)
  } else {
    lines.push('✅ 无思考污染')
  }
  if (report.dropped > 0) lines.push(`⚠️ 今天因单日上限被丢弃 ${report.dropped} 条（累计 ${report.droppedTotal || 0} 条）`)
  else if (report.droppedTotal > 0) lines.push(`ℹ️ 历史上因单日上限丢弃过 ${report.droppedTotal} 条（今天 0 条）`)

  if (Array.isArray(report.missingStamps) && report.missingStamps.length > 0) {
    lines.push(
      `⚠️ 已收口但没记事件时间戳 ${report.missingStamps.length} 天：${report.missingStamps.slice(0, 5).join('、')}` +
        '（这些天之后新增的事件不会被重收）',
    )
  }
  if (Array.isArray(report.pendingDays) && report.pendingDays.length > 0) {
    const rev = Array.isArray(report.revisitedDays) ? report.revisitedDays : []
    lines.push(
      `⚠️ 待收口 ${report.pendingDays.length} 天：${report.pendingDays.slice(-5).join('、')}` +
        (rev.length > 0 ? `（其中重收 ${rev.slice(0, 5).join('、')}）` : ''),
    )
  }
  if (report.staleCount > 0) {
    const bad = Array.isArray(report.staleInconsistent) ? report.staleInconsistent : []
    lines.push(
      `⚠️ 事实层：evidenceStale ${report.staleCount} 条` +
        (bad.length > 0 ? `，其中 ${bad.length} 条没有任何缺失 ref（自相矛盾 = 假标记）` : ''),
    )
  }
  return lines.join('\n')
}
