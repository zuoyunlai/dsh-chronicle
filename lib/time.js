/**
 * 时间与周期工具：全部走**本地时区**。
 *
 * 为什么不用 UTC：收口时刻是"你的一天"，用户在看 23:50，UTC 会把记录落错日期。
 * 为什么周文件用 ISO 周：与 Obsidian 的周记习惯一致（2026-W45）。
 */

/** 两位补零。 */
export function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 本地日期键 YYYY-MM-DD。 */
export function dayKey(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 本地 HH:mm。 */
export function clock(ms) {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 带本地偏移的 ISO 时间戳（写进事件行，便于回源对照）。 */
export function localISO(ms) {
  const d = new Date(ms)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  )
}

/** ISO 周编号 1–53。 */
export function isoWeek(ms) {
  const d = new Date(ms)
  // 以周四定位所在周，避开跨年周次错位
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dayNum = (target.getDay() + 6) % 7 // 周一=0
  target.setDate(target.getDate() - dayNum + 3)
  const firstThursday = new Date(target.getFullYear(), 0, 4)
  const firstDayNum = (firstThursday.getDay() + 6) % 7
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3)
  const week = 1 + Math.round((target - firstThursday) / (7 * 86400000))
  return { year: target.getFullYear(), week }
}

/** 周文件 ID：2026-W45。 */
export function weekId(ms) {
  const { year, week } = isoWeek(ms)
  return `${year}-W${pad2(week)}`
}

/** "23:50" → 分钟数；非法输入退回 23:50。 */
/**
 * closeAt 是否合法（'23:50' 形式）。
 * 非法值会被静默退回 23:50（实测 closeMinutes('bogus') === closeMinutes('23:50')），
 * 所以要在 ping 里明确报出来，否则用户以为自己改了其实没改。
 */
export function isValidCloseAt(closeAt) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(closeAt || '').trim())
}

export function closeMinutes(hhmm) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || '').trim())
  if (!m) return 23 * 60 + 50
  return Number(m[1]) * 60 + Number(m[2])
}

/** 今天（本地）的收口时刻毫秒。 */
export function closeAtToday(now, closeAt) {
  const d = new Date(now)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return start + closeMinutes(closeAt) * 60000
}

/**
 * 该不该收口。
 * @returns {{due:boolean, day:string, reason:string}}
 */
export function closeDecision({ now, closeAt, lastClosedDay, closedDays }) {
  const day = dayKey(now)
  const dueMs = closeAtToday(now, closeAt)
  const done = new Set(Array.isArray(closedDays) ? closedDays : [])
  if (lastClosedDay) done.add(lastClosedDay)
  if (now >= dueMs && !done.has(day)) {
    return { due: true, day, reason: 'closeAt-reached' }
  }
  return { due: false, day, reason: 'not-yet' }
}

/**
 * 补齐哪些天（启动补偿）：昨天及更早、且没有收口记录的、但有事件的天。
 * 只补最近 lookback 天，避免首次启动把陈年目录全扫一遍。
 */
/**
 * 补收口：哪些有事件但还没收口的日子。
 *
 * 关键修复（2026-11-10 审计 P0-7）：原来只看 `lastClosedDay` 一个值，
 * 于是**所有 ≤ 它但其实没收口的日子都被永久跳过**。
 * 可达场景：插件 X 日安装并收口 X 日；随后 backfill 回捞出更早日期的事件 →
 * 那些天此后永远不会被收口，且无任何告警。
 *
 * 现在用 `closedDays` 集合（真正收口过的日子），`lastClosedDay` 只作兼容兜底。
 *
 * @param {string[]} [closedDays] 已收口的日子集合（新增）
 */
export function catchUpDays({ now, closeAt, lastClosedDay, closedDays, daysWithEvents, lookback = 7 }) {
  const dueMs = closeAtToday(now, closeAt)
  const today = dayKey(now)
  const done = new Set(Array.isArray(closedDays) ? closedDays : [])
  if (lastClosedDay) done.add(lastClosedDay)
  const out = []
  for (const day of [...daysWithEvents].sort()) {
    if (day >= today && now < dueMs) continue // 今天还没到收口点
    if (done.has(day)) continue
    out.push(day)
  }
  return out.slice(-lookback)
}
