/**
 * 回捞：把「磁盘上已有的、当天发生过的」对话补进日志。
 *
 * 为什么必须有：`session/event` 只在**进程内、有活动时**推送。重启前的对话、
 * 其他工作区里当天没再动过的对话，一条都不会进采集。
 * 2026-11-09 用户实测反馈「看不到其他对话和工作区」就是这个原因。
 *
 * 数据源（宿主 sessionQuery 服务，实时优先）：
 *   listSessions()            → SessionRecord[]，含 header.cwd / origin / live / persisted
 *   readSession(id)           → 完整事件流（含内容）
 *   readTitleSnapshots(ids)   → 对话标题
 *
 * 边界：
 *   - 只读当天窗口内的事件（按本地日切）
 *   - 每个会话只读一次（调用方按天记账），不每 tick 重读
 *   - 会话数设上限，避免首次运行把几百个历史会话全读一遍
 */
import { eventToRow } from './ingest.js'
import { redactDeep } from './redact.js'

/** 本地某天的 [start, end) 毫秒。 */
export function dayWindow(day) {
  const [y, m, d] = String(day).split('-').map(Number)
  const start = new Date(y, m - 1, d).getTime()
  const end = new Date(y, m - 1, d + 1).getTime()
  return { start, end }
}

/** 工作区名：cwd 的最后一段；没有 cwd 时标记为 unknown。 */
export function workspaceOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return 'unknown'
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || 'unknown'
}

/**
 * 从会话记录里挑出值得回捞的那些。
 *
 * `skipLive`（默认开）：**跳过正在运行的会话**。
 *   理由：实时 `session/event` 已经在采它们了，再读一遍完整日志纯属重复劳动；
 *   而且实测「当前这个会话」正是内容最大、`readSession` 最慢的那个
 *   —— 2026-11-09 首次回捞就卡在它身上，15 秒只读完 1 个会话。
 *   手动收口时传 `skipLive: false` 做一次深度补读。
 */
export function pickSessions(records, { includeSubagent = false, limit = 200, skipLive = true } = {}) {
  const out = []
  for (const record of records || []) {
    const header = record?.header
    if (!header?.id) continue
    if (!record.live && !record.persisted) continue
    if (skipLive && record.live) continue
    if (!includeSubagent && header.origin === 'subagent') continue
    out.push(record)
    if (out.length >= limit) break
  }
  return out
}

/** 给单个会话的读取加时限：一个巨无霸不该拖住整条链路。 */
export async function withTimeout(promise, ms, label = 'operation') {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms)
        if (timer && typeof timer.unref === 'function') timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 用轻量事件清单（`listEvents`，不含正文）判断这个会话当天有没有动静。
 * 拿不到清单时返回 true —— 宁可多读一个，也别漏掉当天的记录。
 */
export async function hasEventsInWindow(sessionQuery, sessionId, window, perSessionMs = 4000) {
  if (typeof sessionQuery.listEvents !== 'function') return true
  try {
    const events = await withTimeout(sessionQuery.listEvents(sessionId), perSessionMs, `listEvents ${sessionId}`)
    return (events || []).some((event) => {
      const time = Number(event?.time)
      return Number.isFinite(time) && time >= window.start && time < window.end
    })
  } catch {
    // 超时/失败都当"可能有"，交给 readSession 去试（那边也有时限）
    return true
  }
}

/**
 * 把一个会话的完整日志裁成当天的事件行。
 * @returns {Array<object>} 已脱敏的事件行（含 cwd / ws）
 */
export function rowsOfSnapshot(snapshot, { day, redact = true } = {}) {
  const { start, end } = dayWindow(day)
  const header = snapshot?.session || {}
  const session = { id: header.id, header }
  const ws = workspaceOf(header.cwd)
  const rows = []
  for (const event of snapshot?.events || []) {
    const time = Number(event?.time)
    if (!Number.isFinite(time) || time < start || time >= end) continue
    const row = eventToRow(session, event)
    if (!row) continue
    row.cwd = header.cwd || ''
    row.ws = ws
    rows.push(redact ? redactDeep(row).value : row)
  }
  return rows
}

/**
 * 回捞某一天：读会话 → 裁事件 → 塞进缓冲（缓冲自己按 sid#seq 去重）。
 *
 * @param {{sessionQuery:any, buffer:any, day:string, includeSubagent?:boolean, redact?:boolean, limit?:number, log?:(msg:string)=>void}} input
 * @returns {Promise<{sessions:number, rows:number, skipped:number, errors:string[]}>}
 */
export async function backfillDay({
  sessionQuery,
  buffer,
  day,
  includeSubagent = false,
  redact = true,
  limit = 200,
  skipLive = true,
  deadlineMs = 15000,
  startIndex = 0,
  onProgress,
}) {
  const result = { sessions: 0, rows: 0, skipped: 0, noEvents: 0, errors: [], timedOut: false, nextIndex: startIndex, done: true }
  const startedAt = Date.now()
  if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') {
    result.errors.push('sessionQuery 不可用')
    return result
  }

  let records = []
  try {
    records = (await sessionQuery.listSessions()) || []
  } catch (error) {
    result.errors.push(`listSessions 失败：${(error && error.message) || error}`)
    return result
  }

  const picked = pickSessions(records, { includeSubagent, limit, skipLive })
  result.skipped = Math.max(0, records.length - picked.length)
  result.total = picked.length
  const window = dayWindow(day)
  const perSessionMs = Math.max(1000, Math.min(8000, Math.round(deadlineMs / 2)))

  for (let index = startIndex; index < picked.length; index += 1) {
    // 每批有截止时间：单个会话可能要 7 秒（listEvents 也要解析整个日志），
    // 165 个候选串行读完是几分钟 —— 只能分批，绝不能卡在启动路径上。
    if (Date.now() - startedAt > deadlineMs) {
      result.timedOut = true
      result.nextIndex = index
      result.done = false
      result.errors.push(`本批到 ${deadlineMs}ms 截止，从第 ${index}/${picked.length} 个继续`)
      break
    }
    const record = picked[index]
    result.nextIndex = index + 1

    const active = await hasEventsInWindow(sessionQuery, record.header.id, window, perSessionMs)
    if (!active) {
      result.noEvents += 1
      if (typeof onProgress === 'function') await onProgress(result)
      continue
    }
    try {
      const snapshot = await withTimeout(
        sessionQuery.readSession(record.header.id),
        perSessionMs,
        `readSession ${record.header.id}`,
      )
      const rows = rowsOfSnapshot(snapshot, { day, redact })
      result.sessions += 1
      result.rows += rows.length
      for (const row of rows) buffer.push(row.ts.slice(0, 10), row)
      if (typeof onProgress === 'function') await onProgress(result)
    } catch (error) {
      // 超时的会话记为 slow，继续下一个：一个巨无霸不该拖住整条链
      const message = (error && error.message) || String(error)
      if (/超时/.test(message)) result.slow = (result.slow || 0) + 1
      result.errors.push(`读会话 ${record.header.id} 失败：${message}`)
    }
  }

  if (typeof onProgress === 'function') await onProgress(result)
  return result
}

/** 批量取标题，挂到记录的 `title` 上（取不到就留空，不影响回捞）。 */
async function attachTitles(sessionQuery, records) {
  if (records.length === 0 || typeof sessionQuery.readTitleSnapshots !== 'function') return
  try {
    const ids = records.map((record) => record.header.id)
    const results = await sessionQuery.readTitleSnapshots(ids)
    const byId = new Map()
    for (const item of results || []) {
      if (item?.status === 'fulfilled' && item.value?.title?.title) {
        byId.set(item.sessionId, item.value.title.title)
      }
    }
    for (const record of records) {
      const title = byId.get(record.header.id)
      if (title) record.title = title
    }
  } catch {
    /* 标题拿不到就算了：它是锦上添花，不该拖住回捞 */
  }
}
