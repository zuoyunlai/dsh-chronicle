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

/** 组装面板需要的全部只读数据源。所有函数都不改磁盘。 */
export function createChronicleApi({ loadCorpus, neighborsOf, readFacts, readArcs, loadGraph, readState, buildViz }) {
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
        entries: entries.length,
        edges: edges.length,
        today,
        todayEntries: todays.length,
        lastDay: entries.map((e) => e.day).sort().pop() || null,
        dropped: Number(state && state.dropped) || 0,
        sessions,
      }
    },

    /** GET /chronicle/api/recent?days=7&limit=50 */
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
      return { days, count: rows.length, entries: rows }
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
export function registerChronicleRoutes(webServer, api, report = {}) {
  report.attempts = []
  report.disposers = 0
  if (!webServer || typeof webServer.register !== 'function') {
    report.reason = 'webServer-unavailable'
    report.ok = false
    return { report, disposers: [] }
  }

  const endpoints = ['summary', 'recent', 'search', 'related', 'facts', 'arcs', 'graph', 'viz']
  const disposers = []

  const makeHandler = (tail) =>
    async function handler(req, res) {
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

