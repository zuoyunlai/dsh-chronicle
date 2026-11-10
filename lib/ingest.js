/**
 * 采集：把宿主的 `session/event` 归类成一行可落盘的事件。
 *
 * 事件词汇（实测自 @openviking/dsh-memory-plugin 的 capture.mjs，同一宿主）：
 *   user/message      → event.data            就是消息
 *   assistant/message → event.data.message
 *   tool/result       → event.data.message
 *   tool/call         → event.data.callId / .name / .arguments
 *
 * 原则：
 *   - 只存定位与骨架，不存工具结果正文（那是隐私与体积的双重风险）
 *   - 任何异常都要吞掉：这是 emit 事件的监听器，抛错会污染宿主
 *   - 脱敏在这里就做完，落盘之后不再有明文
 */
import { localISO, dayKey } from './time.js'
import { redactDeep } from './redact.js'

const MAX_USER_CHARS = 4000
const MAX_ASSISTANT_CHARS = 800
const MAX_ARG_CHARS = 160

/**
 * 从 content blocks 里取**正文**。
 *
 * 只认 `type === 'text'`（或无 type 但带 text 的旧形态）。
 * 必须排除 `reasoning`：实测宿主把模型的思考块也塞在 assistant/message 里，
 * 不过滤就会把整段内心独白当成"当天做了什么"落盘（v0.2.1 现场抓到）。
 * 同样排除 tool-call / image / file —— 那些不是人话。
 */
export function blocksText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type && block.type !== 'text') continue
    if (typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 工具参数里最有信息量的那一截：路径 > 命令 > 名称。 */
export function argHint(args) {
  if (args == null) return ''
  let value = args
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return String(value).slice(0, MAX_ARG_CHARS)
    }
  }
  if (!value || typeof value !== 'object') return String(value).slice(0, MAX_ARG_CHARS)
  const path =
    value.path || value.file_path || value.filePath || value.notebook_path || value.target || value.root
  if (typeof path === 'string') return path.slice(0, MAX_ARG_CHARS)
  const command = value.command || value.cmd || value.query || value.pattern
  if (typeof command === 'string') return command.slice(0, MAX_ARG_CHARS)
  // 兜底只取**字符串**值：数组/对象会变成 "[object Object]"，
  // v0.3.0 实测把 `todos:[object Object],…` 写进了 prompt，纯噪音。
  const key = Object.keys(value)[0]
  if (!key) return ''
  const first = value[key]
  if (typeof first === 'string') return `${key}:${first.slice(0, 80)}`
  if (typeof first === 'number' || typeof first === 'boolean') return `${key}:${first}`
  return key
}

/** 工具调用是否"改了文件"——只认明确是写/改的工具名。 */
const WRITE_TOOLS = /(^|_)(write|edit|patch|append|create|move|copy|delete|remove)(_|$)|apply_patch|writefile/i

/**
 * 名字像写工具还不够，参数也得像个路径。
 * 反例：`todo_write` / `memory_write` / `write_report` 名字里都有 write，
 * 但它们的参数是 todos、content、报告标题——v0.3.0 实测把
 * `todos:[object Object]` 当成了"改过的文件"写进大纲和 prompt。
 */
export function looksLikePath(hint) {
  const value = String(hint || '')
  if (!value) return false
  if (/[\\/]/.test(value)) return true
  return /\.[A-Za-z0-9]{1,6}$/.test(value)
}

function isWriteTool(name, hint) {
  return typeof name === 'string' && WRITE_TOOLS.test(name) && looksLikePath(hint)
}

/** 工作区名：cwd 的最后一段；没有 cwd 时标记 unknown。 */
export function workspaceOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return 'unknown'
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || 'unknown'
}

function messageOf(event) {
  switch (event?.type) {
    case 'user/message':
      return event.data
    case 'assistant/message':
    case 'tool/result':
      return event.data?.message
    default:
      return null
  }
}

/**
 * 一条 DSH 事件 → 一条（或零条）日记事件行。
 * @returns {object|null}
 */
export function eventToRow(session, event) {
  try {
    const sid = session?.id
    if (!sid) return null
    const seq = Number(event?.seq)
    const ts = Number(event?.time) > 0 ? localISO(Number(event.time)) : localISO(Date.now())

    if (event.type === 'tool/call') {
      const name = String(event.data?.name || '')
      const hint = argHint(event.data?.arguments)
      return {
        v: 1,
        sid,
        seq: Number.isFinite(seq) ? seq : 0,
        ts,
        kind: 'tool',
        tool: name,
        arg: hint,
        path: isWriteTool(name, hint) ? hint : '',
      }
    }

    if (event.type === 'tool/result') {
      const message = messageOf(event)
      return {
        v: 1,
        sid,
        seq: Number.isFinite(seq) ? seq : 0,
        ts,
        kind: 'toolresult',
        ok: message?.isError !== true,
      }
    }

    const message = messageOf(event)
    if (!message || typeof message !== 'object') return null
    // 宿主/插件注入的消息不进日志
    const sourceKind = message.source?.kind
    if (typeof sourceKind === 'string' && (sourceKind === 'plugin' || sourceKind.startsWith('plugin:'))) return null
    if (typeof sourceKind === 'string' && sourceKind !== 'user' && sourceKind !== 'model') return null

    if (event.type === 'user/message') {
      const text = blocksText(message.content).replace(/\s+/g, ' ').trim()
      if (!text) return null
      return {
        v: 1,
        sid,
        seq: Number.isFinite(seq) ? seq : 0,
        ts,
        kind: 'user',
        text: text.slice(0, MAX_USER_CHARS),
        chars: text.length,
      }
    }

    if (event.type === 'assistant/message') {
      const text = blocksText(message.content).replace(/\s+/g, ' ').trim()
      if (!text) return null
      return {
        v: 1,
        sid,
        seq: Number.isFinite(seq) ? seq : 0,
        ts,
        kind: 'assistant',
        text: text.slice(0, MAX_ASSISTANT_CHARS),
        // 原文长度（截断前的）：体检时能判断「是真短还是被截了」（审计 P2-12）
        chars: text.length,
      }
    }

    return null
  } catch {
    return null
  }
}

/** 脱敏 + 归日 + 挂归属。返回 {day, row} 或 null。 */
export function prepareRow(session, event, redactOn) {
  const row = eventToRow(session, event)
  if (!row) return null
  // 归属：每条事件都带工作区，否则跨工作区之后分不清哪条属于谁
  row.cwd = session?.header?.cwd || ''
  row.ws = workspaceOf(row.cwd)
  const safe = redactOn ? redactDeep(row).value : row
  return { day: dayKey(Date.parse(safe.ts) || Date.now()), row: safe }
}

/**
 * 事件缓冲：攒够一批再落盘，避免每条事件一次 I/O。
 *
 * 去重键 `sid#seq`，且**跨进程持久**：第一次写某天之前先从磁盘把已有键读进来
 * （v0.2.1 实测：宿主重启后会重放事件，只靠内存 Set 会写出重复行）。
 */
export class EventBuffer {
  constructor({ dataDir, maxEventsPerDay = 5000 }) {
    this.dataDir = dataDir
    this.maxEventsPerDay = maxEventsPerDay
    this.pending = new Map() // day -> rows[]
    this.seen = new Map() // day -> Set(key)  本轮进程见过的键
    this.persisted = new Map() // day -> Set(key)  已经在磁盘上的键
    this.seeded = new Set() // 已经从磁盘播种过的天
    this.counts = new Map() // day -> number
    this.dropped = 0
  }

  /** 入缓冲；返回是否新增。 */
  push(day, row) {
    const key = `${row.sid}#${row.seq}`
    if (!this.seen.has(day)) this.seen.set(day, new Set())
    const set = this.seen.get(day)
    if (set.has(key)) return false
    set.add(key)
    const count = (this.counts.get(day) || 0) + 1
    this.counts.set(day, count)
    if (count > this.maxEventsPerDay) {
      this.dropped += 1
      return false
    }
    if (!this.pending.has(day)) this.pending.set(day, [])
    this.pending.get(day).push(row)
    return true
  }

  size() {
    let n = 0
    for (const rows of this.pending.values()) n += rows.length
    return n
  }

  /**
   * 把缓冲写出去；返回实际写入条数。
   * @param {{appendEvents:Function, loadSeen?:(day:string)=>Promise<string[]>}} io
   *   写失败的那一天保留在缓冲里等下次重试，不丢记录。
   */
  async flush(io) {
    const { appendEvents, loadSeen } = io
    let written = 0
    for (const [day, rows] of [...this.pending.entries()]) {
      if (!rows || rows.length === 0) {
        this.pending.delete(day)
        continue
      }
      try {
        if (!this.seeded.has(day)) {
          this.seeded.add(day)
          const keys = typeof loadSeen === 'function' ? await loadSeen(day) : []
          this.persisted.set(day, new Set(keys))
        }
        const done = this.persisted.get(day) || new Set()
        // 播种当日计数：磁盘已有多少行就算多少。
        // 不播种的话上限变成「每进程每次运行 N 条」——实测一天落了 1169 行（名义 400），
        // 另有 651 条被静默丢弃，且丢的是会话尾部（最新的、最有价值的）。
        if (!this.counts.has(day)) this.counts.set(day, done.size)
        const fresh = rows.filter((row) => !done.has(`${row.sid}#${row.seq}`))
        if (fresh.length > 0) {
          written += await appendEvents(this.dataDir, day, fresh)
          for (const row of fresh) done.add(`${row.sid}#${row.seq}`)
        }
        this.persisted.set(day, done)
        this.pending.delete(day)
      } catch {
        // 保留缓冲，下次再试；不要因为一次写失败丢掉当天记录
      }
    }
    return written
  }

  /** 已经见过的事件键（跨 flush 保持，防重放）。 */
  seenCount(day) {
    return this.seen.get(day)?.size ?? 0
  }
}
