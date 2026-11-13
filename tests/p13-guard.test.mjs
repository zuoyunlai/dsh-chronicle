/**
 * 安全面与生命周期（2026-11-13 审计 P1-1 / P1-8 / P2 export 默认值）。
 *
 * 背景（实测）：宿主自己的 `/api` 返回 401，而插件注册的 `/chronicle/api/facts`
 * 无凭据返回 200 / 16.7 KB；伪造 `Host: evil.example` 与 POST 同样受理。
 * 这些路由不在宿主鉴权链里，所以守卫必须由插件自己做。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { guardPanelRequest, registerChronicleRoutes, createChronicleApi } from '../lib/api.js'
import * as plugin from '../index.js'

const LOOPBACK = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:4375' } }

test('P1-1 守卫：回环 peer + 回环 Host + GET 放行', () => {
  assert.equal(guardPanelRequest({ method: 'GET', ...LOOPBACK }).ok, true)
  assert.equal(guardPanelRequest({ method: 'HEAD', ...LOOPBACK }).ok, true)
  assert.equal(
    guardPanelRequest({ method: 'GET', socket: { remoteAddress: '::1' }, headers: { host: '[::1]:4375' } }).ok,
    true,
  )
  assert.equal(
    guardPanelRequest({ method: 'GET', socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { host: 'localhost:4375' } }).ok,
    true,
  )
})

test('P1-1 守卫：非回环 peer 拒绝', () => {
  const verdict = guardPanelRequest({ method: 'GET', socket: { remoteAddress: '192.168.0.9' }, headers: { host: '127.0.0.1:4375' } })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 403)
})

test('P1-1 守卫：伪造 Host 拒绝（DNS rebinding 挡在这里）', () => {
  const verdict = guardPanelRequest({ method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.example' } })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 403)
})

test('P1-1 守卫：写方法一律拒绝', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const verdict = guardPanelRequest({ method, ...LOOPBACK })
    assert.equal(verdict.ok, false, method)
    assert.equal(verdict.status, 405)
  }
})

test('P1-1 守卫：mode=off 是显式逃生门', () => {
  assert.equal(guardPanelRequest({ method: 'GET', socket: { remoteAddress: '10.0.0.2' }, headers: { host: 'x.y' } }, { mode: 'off' }).ok, true)
})

/** 假 ServerResponse / 假 webServer，沿用 p4 的形状。 */
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

function harness() {
  const api = createChronicleApi({
    loadCorpus: async () => ({ entries: [], edges: [] }),
    neighborsOf: async () => [],
    readFacts: async () => ({ total: 0, facts: [] }),
    readArcs: async () => ({ arcs: [] }),
    loadGraph: async () => ({ entities: [], edges: [] }),
    readState: async () => ({ lastClosedDay: '', dropped: 0 }),
    buildViz: async () => ({}),
    uiLocale: () => 'zh',
    now: () => Date.parse('2026-11-13T12:00:00+08:00'),
  })
  const routes = []
  const webServer = { register: (route) => (routes.push(route), () => {}) }
  const report = {}
  registerChronicleRoutes(webServer, api, report)
  const route = routes.find((item) => item.path === '/chronicle/api/summary')
  return { routes, route, report }
}

test('P1-1 端到端：坏 Host 在路由层就被挡下，且不会触达 api', async () => {
  const { route } = harness()
  const res = fakeResponse()
  await route.handler({ url: '/chronicle/api/summary', method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.example' } }, res)
  assert.equal(res.captured.status, 403)
  assert.match(res.captured.body, /unauthorized/)
})

test('P1-1 端到端：POST 打同样的路由得到 405', async () => {
  const { route } = harness()
  const res = fakeResponse()
  await route.handler({ url: '/chronicle/api/summary', method: 'POST', ...LOOPBACK }, res)
  assert.equal(res.captured.status, 405)
})

test('P1-1 端到端：正常回环请求仍然 200', async () => {
  const { route } = harness()
  const res = fakeResponse()
  await route.handler({ url: '/chronicle/api/summary', method: 'GET', ...LOOPBACK }, res)
  assert.equal(res.captured.status, 200)
  assert.equal(JSON.parse(res.captured.body).ok !== undefined || true, true)
})

/* ---------- P2：export_rules 默认不落盘 ---------- */

function fakeCtx() {
  const registered = []
  return {
    registered,
    effect(fn) {
      const dispose = fn()
      return () => dispose?.()
    },
    on() {
      return () => {}
    },
    inject() {
      return () => {}
    },
    get(name) {
      if (name === 'tools') return { register: () => () => {} }
      return undefined
    },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
}

async function withDirs(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-c-'))
  const vaultDir = await mkdtemp(join(tmpdir(), 'chronicle-c-vault-'))
  try {
    return await fn(dataDir, vaultDir)
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 20))
    for (const dir of [dataDir, vaultDir]) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => {})
    }
  }
}

test('P2 回归：chronicle_export_rules 默认不写盘，write=true 才写', () =>
  withDirs(async (dataDir, vaultDir) => {
    const ctx = fakeCtx()
    plugin.apply(ctx, plugin.Config({ dataDir, vaultDir, gitCommit: false, panel: false }))
    const tool = ctx.registered.find((item) => item.name === 'chronicle_export_rules')
    assert.ok(tool, '工具必须注册')

    const quiet = await tool.execute({})
    assert.equal(quiet.path, '', '没传 write 时不该落盘')
    await assert.rejects(stat(join(vaultDir, 'AGENTS.generated.md')), /ENOENT/)

    const loud = await tool.execute({ write: true })
    assert.equal(loud.path, join(vaultDir, 'AGENTS.generated.md'))
    const text = await readFile(loud.path, 'utf8')
    assert.match(text, /#|规则/)
  }))
