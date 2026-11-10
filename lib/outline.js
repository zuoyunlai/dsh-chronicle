/**
 * 纲要压缩：把当天的事件行压成「轮次纲要」。
 *
 * 这一步是本插件成本与隐私的边界：**进模型的只有纲要，不是原文**。
 * 全部纯本地计算，零 token。
 */

import { looksLikePath } from './ingest.js'

const MAX_USER_HEAD = 200
const MAX_TOOLS = 6
const MAX_FILES = 6

function isFail(row) {
  return row.kind === 'tool' && row.ok === false
}

/** 单条事件行 → 轮次归属。用户消息开启新一轮。 */
export function buildTurns(rows) {
  const bySession = new Map()
  for (const row of rows) {
    if (!row || !row.sid) continue
    if (row.kind !== 'user' && row.kind !== 'assistant' && row.kind !== 'tool') continue
    if (!bySession.has(row.sid)) bySession.set(row.sid, [])
    bySession.get(row.sid).push(row)
  }

  const turns = []
  // 迁移兼容：老行可能没有 ws（0.5.x 采集的），用同一会话里任意一条带 ws 的行补上
  const wsBySession = new Map()
  for (const row of rows) {
    if (row?.sid && row.ws && row.ws !== 'unknown' && !wsBySession.has(row.sid)) wsBySession.set(row.sid, row.ws)
  }
  for (const [sid, list] of bySession) {
    list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    const fallbackWs = wsBySession.get(sid) || 'unknown'
    let current = null
    for (const row of list) {
      if (row.kind === 'user') {
        current = {
          sid,
          seq: row.seq ?? 0,
          ts: row.ts || '',
          ws: row.ws || fallbackWs,
          user: row.text || '',
          assistant: '',
          tools: [],
          files: [],
          failures: 0,
        }
        turns.push(current)
        continue
      }
      // 没有 user 开头的（会话开头被截断），补一个占位轮
      if (!current) {
        current = { sid, seq: row.seq ?? 0, ts: row.ts || '', ws: row.ws || '', user: '', assistant: '', tools: [], files: [], failures: 0 }
        turns.push(current)
      }
      if (row.kind === 'assistant') {
        current.assistant = (current.assistant + ' ' + (row.text || '')).trim()
      } else if (row.kind === 'tool') {
        if (row.tool) current.tools.push(row.tool)
        // 历史行里可能残留非路径的 path（v0.3.0 的 todo_write 误判），这里再挡一次
        if (row.path && looksLikePath(row.path)) current.files.push(row.path)
        if (isFail(row)) current.failures += 1
      }
    }
  }

  turns.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq - b.seq))
  return turns.map(condense)
}

function uniq(list, cap) {
  const out = []
  const seen = new Set()
  for (const item of list) {
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
    if (out.length >= cap) break
  }
  return out
}

/** 一轮 → 纲要（进模型的形态）。 */
export function condense(turn) {
  const head = String(turn.user || '').replace(/\s+/g, ' ').trim().slice(0, MAX_USER_HEAD)
  return {
    ref: `${turn.sid}#${turn.seq}`,
    ts: turn.ts,
    // 归属：哪個工作区。跨工作区汇总时靠它分组
    ws: turn.ws || 'unknown',
    userHead: head,
    assistantHead: String(turn.assistant || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    tools: uniq(turn.tools, MAX_TOOLS),
    files: uniq(turn.files, MAX_FILES),
    failures: turn.failures,
    userChars: String(turn.user || '').length,
  }
}

/**
 * 原文索引：ref → 这一轮的**完整**文本（用户 + 助手）。
 *
 * 为什么单独造：buildTurns 返回的是 condense 后的**纲要**，
 * 里面只有 userHead / assistantHead（各 300 字），没有原文。
 * 核验「根因在原文里有没有依据」需要原文——
 * 2026-11-10 踩坑：证据窗写成 turn.user/turn.assistant，
 * 而纲要里根本没有这两个字段 ⇒ 永远取到空串 ⇒ 所有根因都被判「未核验」。
 */
export function buildTurnTextIndex(rows) {
  const bySession = new Map()
  for (const row of rows || []) {
    if (!row || !row.sid) continue
    if (row.kind !== 'user' && row.kind !== 'assistant' && row.kind !== 'tool') continue
    if (!bySession.has(row.sid)) bySession.set(row.sid, [])
    bySession.get(row.sid).push(row)
  }
  const map = new Map()
  for (const [sid, list] of bySession) {
    list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    // 轮次归属必须与 buildTurns **完全一致**：ref 用**用户行**的 seq。
    // 用助手行的 seq 会导致索引键对不上（2026-11-10 踩过）。
    let current = null
    const flush = () => {
      if (current && current.parts.length > 0) map.set(sid + '#' + current.seq, current.parts.join(' \n '))
      current = null
    }
    for (const row of list) {
      if (row.kind === 'user') {
        flush()
        current = { seq: row.seq ?? 0, parts: [] }
        if (row.text) current.parts.push(row.text)
        continue
      }
      if (!current) current = { seq: row.seq ?? 0, parts: [] }
      if (row.kind === 'assistant' && row.text) current.parts.push(row.text)
    }
    flush()
  }
  return map
}

/** 当天纲要的总体统计（进 prompt 的抬头，省得模型自己数）。 */
export function summarizeOutline(turns) {
  const sessions = new Set(turns.map((t) => t.ref.split('#')[0]))
  const failures = turns.reduce((sum, t) => sum + (t.failures || 0), 0)
  return { turns: turns.length, sessions: sessions.size, failures }
}
