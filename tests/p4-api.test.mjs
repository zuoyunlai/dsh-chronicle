/**
 * P4：面板只读 API。
 *
 * 路由形状按宿主契约：`{ kind: 'prefix', path, handler(req, res) }`，
 * 其中 req 是 Node IncomingMessage（只用到 url），res 是 ServerResponse。
 * v0.5.0 曾按 Fetch 的 Request→Response 写，注册直接抛错——这里锁住形状。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createChronicleApi, registerChronicleRoutes } from '../lib/api.js'

const NOW = new Date('2026-11-09T21:00:00+08:00').getTime()

function fixture() {
  const entries = [
    { ref: 'a', ts: '2026-11-09T20:00:00+08:00', day: '2026-11-09', title: '改 ingest.js', claim: '思考块', importance: 4, entities: ['dsh-chronicle', 'ingest.js'] },
    { ref: 'b', ts: '2026-11-08T10:00:00+08:00', day: '2026-11-08', title: '接入 LLM 打分', claim: '一天一次', importance: 3, entities: ['llm.js'] },
    { ref: 'c', ts: '2026-10-01T10:00:00+08:00', day: '2026-10-01', title: '很老的记录', claim: '旧', importance: 2, entities: [] },
  ]
  const edges = [{ a: 'dsh-chronicle', b: 'llm.js', weight: 2 }]
  return {
    loadCorpus: async () => ({ entries, edges }),
    neighborsOf: async (name) => (name === 'llm.js' ? [{ name: 'dsh-chronicle', weight: 2 }] : []),
  }
}

/** 假的 ServerResponse：只记录 writeHead / end。 */
function fakeResponse() {
  const captured = { status: 0, headers: {}, body: '' }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers || {}
    },
    end(text) {
      captured.body = text || ''
    },
  }
}

async function hit(route, path) {
  const res = fakeResponse()
  await route.handler({ url: path, method: 'GET' }, res)
  return { status: res.captured.status, headers: res.captured.headers, body: JSON.parse(res.captured.body || 'null') }
}

function register(api) {
  const routes = []
  const report = {}
  const { disposers } = registerChronicleRoutes({ register: (route) => (routes.push(route), () => {}) }, api, report)
  routes.report = report
  routes.disposers = disposers
  return routes
}

/** 四个 exact + 一个 prefix，按路径取。 */
function routeOf(routes, path) {
  return routes.find((route) => route.path === path)
}

test('summary：给出总数、边数与今日条数', async () => {
  const summary = await createChronicleApi(fixture()).summary()
  assert.equal(summary.entries, 3)
  assert.equal(summary.edges, 1)
  assert.match(summary.today, /^\d{4}-\d{2}-\d{2}$/, 'today 跟着真实时钟走，不该写死')
  assert.ok(summary.todayEntries >= 0)
  assert.equal(summary.lastDay, '2026-11-09')
})

test('recent：按天数窗口过滤，新的在前', async () => {
  const recent = await createChronicleApi(fixture()).recent({ days: 7, now: NOW })
  assert.deepEqual(recent.entries.map((e) => e.ref), ['a', 'b'], '10-01 那条应被窗口挡掉')
})

test('search / related：空参数不炸', async () => {
  const api = createChronicleApi(fixture())
  assert.deepEqual((await api.search({ q: '  ' })).results, [])
  assert.deepEqual((await api.related({ name: '' })).entries, [])
  assert.equal((await api.search({ q: 'ingest.js', now: NOW })).results[0].ref, 'a')
  const related = await api.related({ name: 'llm.js' })
  assert.equal(related.neighbors[0].name, 'dsh-chronicle')
  assert.deepEqual(related.entries.map((e) => e.ref), ['b'])
})

test('路由形状：四个 exact + 一个 prefix，且注册结果可查', () => {
  const routes = register(createChronicleApi(fixture()))
  const exact = routes.filter((route) => route.kind === 'exact').map((route) => route.path).sort()
  assert.deepEqual(exact, [
    '/chronicle/api/arcs',
    '/chronicle/api/facts',
    '/chronicle/api/graph',
    '/chronicle/api/recent',
    '/chronicle/api/related',
    '/chronicle/api/search',
    '/chronicle/api/summary',
    '/chronicle/api/viz',
  ])
  const prefix = routes.filter((route) => route.kind === 'prefix')
  assert.equal(prefix.length, 1, 'prefix 兜底只需要一条')
  assert.equal(prefix[0].path, '/chronicle/api')

  // 注册结果必须可查（0.5.1 的教训：异常被吞，外部只看得到 404）
  assert.equal(routes.report.ok, true)
  assert.equal(routes.report.disposers, 9)
  assert.equal(routes.report.attempts.filter((a) => a.ok).length, 9)
})

test('路由：exact 端点回 JSON 200，坏参数退回默认', async () => {
  const routes = register(createChronicleApi(fixture()))

  const summary = await hit(routeOf(routes, '/chronicle/api/summary'), 'http://127.0.0.1/chronicle/api/summary')
  assert.equal(summary.status, 200)
  assert.match(summary.headers['content-type'], /application\/json/)
  assert.equal(summary.body.entries, 3)

  // days 参数坏掉时退回 7 天
  const recent = await hit(routeOf(routes, '/chronicle/api/recent'), 'http://127.0.0.1/chronicle/api/recent?days=abc')
  assert.equal(recent.body.entries.length, 2)

  const search = await hit(routeOf(routes, '/chronicle/api/search'), 'http://127.0.0.1/chronicle/api/search?q=ingest.js')
  assert.equal(search.body.results[0].ref, 'a')

  const related = await hit(routeOf(routes, '/chronicle/api/related'), 'http://127.0.0.1/chronicle/api/related?name=llm.js')
  assert.deepEqual(related.body.entries.map((e) => e.ref), ['b'])
})

test('路由：prefix 兜底能分派，未知尾段回 404 JSON', async () => {
  const routes = register(createChronicleApi(fixture()))
  const prefix = routes.find((route) => route.kind === 'prefix')

  const summary = await hit(prefix, 'http://127.0.0.1/chronicle/api/summary')
  assert.equal(summary.status, 200)

  const missing = await hit(prefix, 'http://127.0.0.1/chronicle/api/nope')
  assert.equal(missing.status, 404)
  assert.match(missing.body.error, /unknown chronicle endpoint/)
})

test('路由：handler 抛错时回 500 JSON，而不是崩', async () => {
  const routes = register({
    summary: async () => {
      throw new Error('boom')
    },
    recent: async () => ({}),
    search: async () => ({}),
    related: async () => ({}),
  })
  const response = await hit(routeOf(routes, '/chronicle/api/summary'), 'http://127.0.0.1/chronicle/api/summary')
  assert.equal(response.status, 500)
  assert.match(response.body.error, /boom/)
})

test('没有 webServer 时明确报出来（面板不该拖垮 Host）', () => {
  const report = {}
  const { disposers } = registerChronicleRoutes(null, {}, report)
  assert.deepEqual(disposers, [])
  assert.equal(report.ok, false)
  assert.equal(report.reason, 'webServer-unavailable')
})

test('facts / arcs：面板两个新视图的端点', async () => {
  const facts = [
    { id: 'decision-a', kind: 'decision', title: '甲', statement: 'x', project: 'p', status: 'single', hits: 2 },
    { id: 'pitfall-b', kind: 'pitfall', title: '乙', statement: 'y', project: 'p', status: 'repeated', hits: 0 },
  ]
  const arcs = [{ id: 'arc-a', title: '甲', project: 'p', days: ['2026-11-07', '2026-11-09'], span: '11-07 → 11-09' }]
  const routes = register(
    createChronicleApi({
      loadCorpus: async () => ({ entries: [], edges: [] }),
      neighborsOf: async () => [],
      readFacts: async () => facts,
      readArcs: async () => arcs,
    }),
  )
  const all = await hit(routeOf(routes, '/chronicle/api/facts'), 'http://127.0.0.1/chronicle/api/facts')
  assert.equal(all.body.total, 2)
  const only = await hit(routeOf(routes, '/chronicle/api/facts'), 'http://127.0.0.1/chronicle/api/facts?kind=pitfall')
  assert.equal(only.body.total, 1)
  assert.equal(only.body.facts[0].title, '乙')
  const arcRes = await hit(routeOf(routes, '/chronicle/api/arcs'), 'http://127.0.0.1/chronicle/api/arcs')
  assert.equal(arcRes.body.total, 1)
})

test('graph：力导向图数据（节点按度数排序、边只保留两端都在的）', async () => {
  const routes = register(
    createChronicleApi({
      loadCorpus: async () => ({ entries: [], edges: [] }),
      neighborsOf: async () => [],
      readFacts: async () => [],
      readArcs: async () => [],
      loadGraph: async () => ({
        total: 30,
        nodes: [{ name: 'index.js', kind: 'file', degree: 12 }, { name: 'dsh-chronicle', kind: 'llm', degree: 9 }],
        edges: [{ a: 'index.js', b: 'dsh-chronicle', weight: 3 }],
      }),
    }),
  )
  const res = await hit(routeOf(routes, '/chronicle/api/graph'), 'http://127.0.0.1/chronicle/api/graph?limit=80')
  assert.equal(res.body.nodes.length, 2)
  assert.equal(res.body.edges.length, 1)
  assert.equal(res.body.total, 30)
})
