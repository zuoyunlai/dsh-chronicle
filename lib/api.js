/**
 * Host 侧只读 HTTP API：面板与工具共用同一套后端（硬约束 §11.5 第 2 条）。
 *
 * **路由形状按宿主契约来**（v0.5.0 曾按 Fetch 的 Request→Response 写，
 * `webServer.register` 直接抛错且被吞掉，结果一条路由都没注册）：
 *
 *   WebRoute = { kind: 'exact' | 'prefix', path, handler(req: IncomingMessage, res: ServerResponse) }
 *
 * 所以这里只注册**一条 prefix 路由** `/chronicle/api`，内部自己分派，
 * 用 Node 的 res.writeHead/res.end 回 JSON。少注册点 = 少一处可能抛错。
 */

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * 面板路由的入口守卫。
 *
 * 为什么必须有（2026-11-13 审计 P1-1）：这些路由是**插件自己往宿主 Web 服务上注册**的，
 * 不经过宿主的鉴权链。实测宿主自己的 `/api` 返回 401，而 `/chronicle/api/facts`
 * 无凭据返回 200 / 16.7 KB（75 条事实全文）；POST 与伪造 `Host: evil.example` 也一视同仁。
 * 本机监听 127.0.0.1 时影响面是本机任意进程；一旦有页面做 DNS rebinding
 * （Host 仍是攻击者域名、解析到 127.0.0.1），就能远程把这些数据读走。
 *
 * 判据（任一不满足即拒绝）：
 *   · 方法只能是 GET / HEAD —— 只读面不该接受写方法的语义（哪怕 handler 不写）；
 *   · peer 必须是回环地址；
 *   · Host 头必须是回环主机名（挡 DNS rebinding）。
 *
 * 兼容：`req.socket` / `req.headers.host` 都不存在时放行 —— 那不是经过 Web 服务的请求
 * （宿主与测试都至少提供其一）；真实 HTTP/1.1 请求二者必然存在，无法靠缺头绕过。
 *
 * @param {{method?:string, socket?:object, headers?:object}} req
 * @param {{mode?:'loopback'|'off'}} [options]
 */
export function guardPanelRequest(req, options = {}) {
  const mode = options.mode === 'off' ? 'off' : 'loopback'
  if (mode === 'off') return { ok: true }
  const method = String(req?.method || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return { ok: false, status: 405, error: 'method not allowed' }

  const peer = req?.socket?.remoteAddress
  if (typeof peer === 'string' && peer.length > 0 && !isLoopbackAddress(peer)) {
    return { ok: false, status: 403, error: 'unauthorized' }
  }
  const host = req?.headers?.host
  if (typeof host === 'string' && host.length > 0 && !isLoopbackHost(host)) {
    return { ok: false, status: 403, error: 'unauthorized' }
  }
  return { ok: true }
}

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase()
  if (value === '::1' || value === 'localhost') return true
  if (value === '::ffff:127.0.0.1') return true
  return /^127\./.test(value)
}

function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase()
  // 去掉端口：[::1]:4375 / 127.0.0.1:4375 / localhost:4375
  const name = value.startsWith('[')
    ? value.slice(0, value.indexOf(']') + 1)
    : value.replace(/:\d+$/, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || /^127\./.test(name)
}

/** 组装面板需要的全部只读数据源。所有函数都不改磁盘。 */
export function createChronicleApi({ loadCorpus, neighborsOf, readFacts, readArcs, loadGraph, readState, buildViz, uiLocale }) {
  function localDay(now = Date.now()) {
    const d = new Date(now)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  return {
    /** GET /chronicle/api/summary */
    async summary() {
      const { entries, edges } = await loadCorpus()
      // 记忆的完整度比条目数更重要：丢了多少条、覆盖了几个会话
      const state = typeof readState === 'function' ? await readState() : null
      const sessions = new Set(entries.map((entry) => String(entry.ref || '').split('#')[0]).filter(Boolean)).size
      const today = localDay()
      const todays = entries.filter((entry) => String(entry.day) === today)
      return {
        // 面板界面语言：'auto' | 'zh' | 'en'（客户端拿它决定文案）
        uiLocale: String((typeof uiLocale === 'function' ? uiLocale() : uiLocale) || 'auto'),
        entries: entries.length,
        edges: edges.length,
        today,
        todayEntries: todays.length,
        lastDay: entries.map((e) => e.day).sort().pop() || null,
        // 分两个数：今天的丢弃（面板要显示的就是这个）与历史累计。
        // 原来只有累计值，651 条历史遗留会被读成「今天丢了 651 条」（2026-11-13 审计 P2）。
        dropped: Number((state && state.droppedByDay && state.droppedByDay[today]) || 0),
        droppedTotal: Number(state && state.dropped) || 0,
        sessions,
      }
    },

    /** GET /chronicle/api/recent?days=7&limit=50 */
    /**
     * GET /chronicle/api/recent?days=7&limit=50
     *
     * 返回**按天分组**的结构（`dayList`）：面板「近期」是时间轴，
     * 每天一块 = 那天的日结 + 那天的条目。
     * 只给平铺 entries 的话，跨天数据在面板上会混成一锅 ——
     * 用户实测反馈「看不出哪件事是哪天做的」。
     */
    async recent({ days = 7, limit = 50, now = Date.now() } = {}) {
      const { entries } = await loadCorpus()
      const cutoff = now - Math.max(1, Math.min(90, days)) * 86400000
      const rows = entries
        .filter((entry) => {
          const ts = Date.parse(entry.ts)
          return Number.isFinite(ts) ? ts >= cutoff : true
        })
        .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
        .slice(0, Math.max(1, Math.min(200, limit)))

      const byDay = new Map()
      for (const row of rows) {
        const key = String(row.day || '')
        if (!byDay.has(key)) byDay.set(key, { day: key, summary: '', sections: row.sections || [], entries: [] })
        const bucket = byDay.get(key)
        if (!bucket.summary && row.daySummary) bucket.summary = row.daySummary
        bucket.entries.push(row)
      }
      const dayList = [...byDay.values()]
        .map((bucket) => ({
          day: bucket.day,
          // 当天日结：没有就是空串，面板会提示「那天没收口/没日结」
          summary: bucket.summary,
          count: bucket.entries.length,
          entries: bucket.entries,
        }))
        .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))

      return { days, count: rows.length, entries: rows, dayList }
    },

    /** GET /chronicle/api/search?q=…&limit=8 */
    async search({ q = '', limit = 8, now = Date.now() } = {}) {
      const query = String(q || '').trim()
      if (!query) return { query, results: [] }
      const { searchEntries } = await import('./recall.js')
      const { entries, edges } = await loadCorpus()
      return { query, results: searchEntries(entries, query, { edges, now, limit }) }
    },

    /** GET /chronicle/api/facts?kind=&project= */
    async facts({ kind = '', project = '', limit = 30 } = {}) {
      const all = typeof readFacts === 'function' ? await readFacts() : []
      const rows = all.filter(
        (fact) => (!kind || fact.kind === kind) && (!project || String(fact.project) === project),
      )
      return { total: rows.length, facts: rows.slice(0, Math.max(1, Math.min(100, limit))) }
    },

    /** GET /chronicle/api/arcs */
    async arcs() {
      const list = typeof readArcs === 'function' ? await readArcs() : []
      return { total: list.length, arcs: list }
    },

    /** GET /chronicle/api/graph?limit=80 —— 力导向图用，按度数取前 N 个节点 */
    async graph({ limit = 80 } = {}) {
      // 缺少依赖要报错，不能返回空数组：空数组在面板里看起来就是"还没数据"，
      // 会把「接线漏了」伪装成「还没有实体」（2026-11-09 实测踩过）
      if (typeof loadGraph !== 'function') {
        throw new Error('graph 视图未接线：createChronicleApi 缺少 loadGraph')
      }
      return loadGraph(Math.max(5, Math.min(400, limit)))
    },

    /** GET /chronicle/api/viz?days=14 —— 图谱下面三张图的数据 */
    async viz({ days = 14 } = {}) {
      if (typeof buildViz !== 'function') throw new Error('viz 视图未接线：createChronicleApi 缺少 buildViz')
      const [facts, arcs, corpus] = await Promise.all([
        typeof readFacts === 'function' ? readFacts() : [],
        typeof readArcs === 'function' ? readArcs() : [],
        loadCorpus(0),
      ])
      return buildViz({ facts, arcs, entries: corpus.entries, days: Math.max(1, Math.min(90, days)) })
    },

    /** GET /chronicle/api/related?name=… */
    async related({ name = '', limit = 8 } = {}) {
      const value = String(name || '').trim()
      if (!value) return { name: value, neighbors: [], entries: [] }
      const neighbors = await neighborsOf(value)
      const { entries } = await loadCorpus()
      const key = value.toLowerCase()
      const related = entries
        .filter((entry) => (entry.entities || []).some((entity) => String(entity).toLowerCase() === key))
        .sort((a, b) => (b.importance || 1) - (a.importance || 1))
        .slice(0, Math.max(1, Math.min(50, limit)))
      return { name: value, neighbors: neighbors.slice(0, 8), entries: related }
    },
  }
}

/**
 * 挂路由：**exact + prefix 双保险**，并且把每一步的结果记进 `report`。
 *
 * 为什么两种都注册：宿主按 `exact` 先匹配、再按最长 `prefix`、最后 fallback。
 * 单靠 prefix 时如果路径归一化（尾斜杠、大小写）和我以为的不一样，就会静默落到 fallback。
 * 两个 kind 的路径不同，不会触发「Duplicate (kind, path)」。
 *
 * 为什么记 report：0.5.1 的注册异常被 try/catch 吞了，面板只显示 404，
 * 从外部完全看不出是"没注册"还是"没匹配"。现在由 chronicle_ping 报出来。
 *
 * @returns {{report: object, disposers: Array<() => void>}}
 */
export function registerChronicleRoutes(webServer, api, report = {}, options = {}) {
  report.attempts = []
  report.disposers = 0
  const guardMode = options.guardMode === 'off' ? 'off' : 'loopback'
  report.guard = guardMode
  if (!webServer || typeof webServer.register !== 'function') {
    report.reason = 'webServer-unavailable'
    report.ok = false
    return { report, disposers: [] }
  }

  const endpoints = ['summary', 'recent', 'search', 'related', 'facts', 'arcs', 'graph', 'viz']
  const disposers = []

  const makeHandler = (tail) =>
    async function handler(req, res) {
      const verdict = guardPanelRequest(req, { mode: guardMode })
      if (!verdict.ok) return sendJson(res, verdict.status, { error: verdict.error })
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const params = url.searchParams
        if (tail === 'summary') return sendJson(res, 200, await api.summary())
        if (tail === 'recent') {
          return sendJson(
            res,
            200,
            await api.recent({ days: Number(params.get('days')) || 7, limit: Number(params.get('limit')) || 50 }),
          )
        }
        if (tail === 'search') {
          // 面板检索**不记命中**（审计 P2-21 明确不改）。
          //
          // 取舍：面板是只读面（§11.5），GET 不应该产生写盘副作用。
          // 记 hits 要写 data/facts/index.json 与 facts/*.md，一旦把写挂在 GET 上，
          // 浏览器的预取 / 刷新 / 重放都会让命中数虚高，hits 与 observations 一起失真。
          // 代价：只有工具侧 chronicle_search 会累加命中。
          // 这对 on-hit 建实体页的门槛影响很小 —— 真正会被「召回」的场景本来就是
          // 模型在对话里搜，而不是人肉点面板。
          return sendJson(res, 200, await api.search({ q: params.get('q') || '', limit: Number(params.get('limit')) || 8 }))
        }
        if (tail === 'facts') {
          return sendJson(res, 200, await api.facts({ kind: params.get('kind') || '', project: params.get('project') || '' }))
        }
        if (tail === 'arcs') return sendJson(res, 200, await api.arcs())
        if (tail === 'graph') return sendJson(res, 200, await api.graph({ limit: Number(params.get('limit')) || 80 }))
        if (tail === 'viz') return sendJson(res, 200, await api.viz({ days: Number(params.get('days')) || 14 }))
        return sendJson(res, 200, await api.related({ name: params.get('name') || '', limit: Number(params.get('limit')) || 8 }))
      } catch (error) {
        // 已经发过头就不能再发一次，否则 ERR_HTTP_HEADERS_SENT
        if (res.headersSent) return
        return sendJson(res, 500, { error: String((error && error.message) || error) })
      }
    }

  /** prefix 路由：自己从 URL 里剥尾段。 */
  async function prefixHandler(req, res) {
    const verdict = guardPanelRequest(req, { mode: guardMode })
    if (!verdict.ok) return sendJson(res, verdict.status, { error: verdict.error })
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const tail = url.pathname.slice('/chronicle/api'.length).replace(/^\/+/, '') || 'summary'
      const params = url.searchParams
      if (tail === 'summary') return sendJson(res, 200, await api.summary())
      if (tail === 'recent') {
        return sendJson(res, 200, await api.recent({ days: Number(params.get('days')) || 7, limit: Number(params.get('limit')) || 50 }))
      }
      if (tail === 'search') {
        return sendJson(res, 200, await api.search({ q: params.get('q') || '', limit: Number(params.get('limit')) || 8 }))
      }
      if (tail === 'related') {
        return sendJson(res, 200, await api.related({ name: params.get('name') || '', limit: Number(params.get('limit')) || 8 }))
      }
      if (tail === 'facts') {
        return sendJson(res, 200, await api.facts({ kind: params.get('kind') || '', project: params.get('project') || '' }))
      }
      if (tail === 'arcs') return sendJson(res, 200, await api.arcs())
      if (tail === 'graph') return sendJson(res, 200, await api.graph({ limit: Number(params.get('limit')) || 80 }))
      if (tail === 'viz') return sendJson(res, 200, await api.viz({ days: Number(params.get('days')) || 14 }))
      return sendJson(res, 404, { error: 'unknown chronicle endpoint', path: url.pathname })
    } catch (error) {
      return sendJson(res, 500, { error: String((error && error.message) || error) })
    }
  }

  const attempts = []
  for (const tail of endpoints) {
    const route = { kind: 'exact', path: `/chronicle/api/${tail}`, handler: makeHandler(tail) }
    try {
      disposers.push(webServer.register(route))
      attempts.push({ kind: 'exact', path: route.path, ok: true })
    } catch (error) {
      attempts.push({ kind: 'exact', path: route.path, ok: false, error: String((error && error.message) || error) })
    }
  }
  try {
    disposers.push(webServer.register({ kind: 'prefix', path: '/chronicle/api', handler: prefixHandler }))
    attempts.push({ kind: 'prefix', path: '/chronicle/api', ok: true })
  } catch (error) {
    attempts.push({ kind: 'prefix', path: '/chronicle/api', ok: false, error: String((error && error.message) || error) })
  }

  report.attempts = attempts
  report.disposers = disposers.length
  report.ok = attempts.some((attempt) => attempt.ok)
  return { report, disposers }
}

