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

/**
 * 哪些日子该收口。
 *
 * ## 为什么不再有「23:50 收口」（2026-11-10 用户拍板方案 B）
 *
 * 收口的本质是问「**这一天过完了吗**」——只有过了当地 00:00 才有确定答案。
 * 固定时刻（23:50）在当天还没结束时就把当天封了，于是：
 *   · 23:50–24:00 的工作没进当天，要靠「次日重提前一天」打补丁
 *   · 23:50 时用户通常已不在电脑前，「当晚能看到日结」这个卖点基本落空
 *   · 关机就等于错过，只能靠下次启动补偿
 *
 * 现在：**永远不收今天，只收 < 今天的天**。跨过午夜后第一次 tick 就收昨天。
 * 关机不丢数据 —— 开机第一件事就是补收，和「关了几小时」无关。
 *
 * @param {object} input
 * @param {number} input.now
 * @param {string[]} input.daysWithEvents 有事件文件的日子
 * @param {string[]} [input.closedDays] 已收口的日子
 * @param {Record<string, number>} [input.dayStamps] 每天事件文件的 mtime
 * @param {Record<string, number>} [input.closedStamps] 收口时记下的事件文件 mtime
 * @param {number} [input.lookback] 一次最多补几天（防首次启动扫陈年目录）
 * @returns {{days: string[], dropped: string[], revisited: string[]}}
 *   days      = 要收口的天
 *   dropped   = 被 lookback 截掉的天（要报出来，不能静默丢）
 *   revisited = 已收口但事件后来又变了、需要重收的天
 */
export function settledDays({
  now,
  daysWithEvents,
  closedDays,
  dayStamps,
  closedStamps,
  lookback = 30,
}) {
  const today = dayKey(now)
  const done = new Set(Array.isArray(closedDays) ? closedDays : [])
  const pending = []
  const revisited = []

  for (const day of [...new Set(daysWithEvents || [])].sort()) {
    // 今天还没过完 —— 永远不收（这是方案 B 的全部要点）
    if (day >= today) continue
    if (!done.has(day)) {
      pending.push(day)
      continue
    }
    // 已收口，但回捞在收口之后补进了新事件 ⇒ 周文件已是旧的，必须重收
    const stamp = Number((dayStamps || {})[day] || 0)
    const closedAt = Number((closedStamps || {})[day] || 0)
    if (stamp > 0 && closedAt > 0 && stamp > closedAt) {
      pending.push(day)
      revisited.push(day)
    }
  }

  return {
    days: pending.slice(-lookback),
    dropped: pending.slice(0, Math.max(0, pending.length - lookback)),
    revisited,
  }
}

/**
 * 收口完成后的台账写入 —— **唯一入口**，定时器与手动工具都走它。
 *
 * 为什么必须统一（2026-11-13 审计 P0-1/P0-2）：
 *   · 定时器路径只写 `lastClosedDay/lastClose/closedStamps`，不写 `closedDays`
 *     ⇒ `settledDays` 认为这一天没完成 ⇒ 每个 tick（默认 5 分钟）重收一遍；
 *   · 手动路径只写 `closedDays`，不写 `closedStamps`
 *     ⇒ `settledDays` 的「回捞后事件变新了要重收」判据（要求 closedAt>0）永不成立
 *     ⇒ 手动收口那天之后新增的事件从此再也不会进产物。
 *
 * 两条都必须写，缺一个就是一条静默失效。
 *
 * @param {object} state   可变 state（readState 的返回值）
 * @param {{day:string, week?:string, at:number, reason?:string, stamp?:number, keepStampDays?:number, maxClosedDays?:number}} input
 *   stamp = 收口这一刻事件文件的 mtime（拿不到就传 0，此时只记账不参与重收判定）
 * @returns {object} 同一个 state（就地修改，便于链式写盘）
 */
export function applyCloseLedger(state, input) {
  const s = state || {}
  const day = String(input?.day || '')
  if (!day) return s
  const at = Number(input?.at) || Date.now()
  const keepStampDays = Number(input?.keepStampDays) > 0 ? Number(input.keepStampDays) : 90
  const maxClosedDays = Number(input?.maxClosedDays) > 0 ? Number(input.maxClosedDays) : 60

  if (!s.lastClosedDay || day > s.lastClosedDay) s.lastClosedDay = day
  s.closedDays = [...new Set([...(s.closedDays || []), day])].sort().slice(-maxClosedDays)
  s.lastClose = { day, week: input?.week || '', at, reason: input?.reason || '' }

  const stamp = Number(input?.stamp) || 0
  if (stamp > 0) s.closedStamps = { ...(s.closedStamps || {}), [day]: stamp }
  // 戳只留最近 N 天，别让 state 无限长
  const keepFrom = dayKey(at - keepStampDays * 86400000)
  for (const key of Object.keys(s.closedStamps || {})) {
    if (key < keepFrom) delete s.closedStamps[key]
  }
  return s
}
