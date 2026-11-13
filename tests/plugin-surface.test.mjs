/**
 * 插件表面：导出、Config 默认值、工具注册、可选服务缺失时的健壮性。
 *
 * 关键回归：v0.2.0 曾在没有 inject 'timer' 的情况下直接读 `ctx.timer.interval`，
 * TypeError 让整个插件加载失败（重启后工具全部消失，只能看到 unknown tool）。
 * 这里刻意提供一个**没有 timer** 的 ctx，apply 必须不抛错、工具照常注册。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as plugin from '../index.js'

/** 最小 ctx 假件：**不提供 timer**，模拟服务缺失。 */
function fakeCtx({ withTimer = false, services = {}, injectable = {} } = {}) {
  const registered = []
  const routes = []
  const timer = withTimer ? { interval: () => () => {}, timeout: () => () => {} } : undefined
  const webServer = injectable.webServer
  return {
    registered,
    routes,
    effect(fn) {
      const dispose = fn()
      return () => dispose?.()
    },
    on() {
      return () => {}
    },
    /**
     * 模拟 cordis 的 ctx.inject：服务在就立即回调，否则不回调。
     * 0.5.2 之前的真实故障就是"apply 那一刻服务还没就绪"，这里把这条路径也覆盖。
     */
    inject(names, callback) {
      const bag = new Map()
      for (const name of names) {
        if (name === 'webServer' && webServer) bag.set(name, webServer)
      }
      if (bag.size === 0) return () => {}
      return callback({ get: (name) => bag.get(name) }) || (() => {})
    },
    get(name) {
      if (name === 'tools') return { register: () => () => {} }
      if (name === 'timer') return timer
      if (name === 'webServer') return webServer
      return services[name]
    },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
}

/** 临时目录，避免 apply 的启动流程写到真实 ~/dsh-chronicle-vault。 */
async function withDirs(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-surface-'))
  const vaultDir = await mkdtemp(join(tmpdir(), 'chronicle-surface-vault-'))
  try {
    return await fn(dataDir, vaultDir)
  } finally {
    // 启动流程是异步的（ensureVault/flush/tick），可能比测试本身活得久一点；
    // Windows 上紧跟着 rm 会撞 ENOTEMPTY，所以重试几次而不是一次放弃。
    await new Promise((resolve) => setTimeout(resolve, 20))
    for (const dir of [dataDir, vaultDir]) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => {})
    }
  }
}

test('导出齐全', () => {
  assert.equal(plugin.name, 'dsh-chronicle')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(plugin.PHASE, 'P6')
  assert.equal(typeof plugin.apply, 'function')
})

test('Config 默认值等于已定稿的决议', () => {
  assert.ok(plugin.Config, 'Config 应当有 schema（仓库内 devDependency 已装）')
  const config = plugin.Config({})
  assert.equal(Object.keys(config).length, 19, 'C3 收敛：移除 closeAt / followModel / scoringModel 后应为 19 项')
  assert.equal(config.scoring, 'rule', 'P2 默认必须走规则档，LLM 要显式打开')
  // closeAt 已移除（方案 B）：收口挂在自然日边界，不再有固定时刻
  assert.equal(config.closeAt, undefined, 'closeAt 应从配置里移除')
  assert.equal(config.uiLocale, 'auto', '界面语言默认跟随宿主')
  assert.equal(config.gitCommit, true)
  // C2（2026-11-13 产品反哺）：纪传体冻结，实体页默认不建（图谱仍写）
  assert.equal(config.entityRule, 'off')
  assert.equal(config.panel, true)
  // 2026-11-13 审计 P1-1：面板路由不在宿主鉴权链里，守卫默认必须开
  assert.equal(config.panelGuard, 'loopback')
  assert.equal(config.weekFile, true)
  assert.equal(config.vaultDir, '~/dsh-chronicle-vault')
  // 2026-11-13 产品反哺 D3：注入改为「一行一条事实」，预算 80 → 140
  assert.equal(config.injectBudget, 140)
  assert.equal(config.importanceFloor, 3)
  assert.equal(config.redact, true)
})

test('没有 timer 服务时 apply 不抛错，两个工具照常注册', async () => {
  await withDirs(async (dataDir, vaultDir) => {
    const ctx = fakeCtx({ withTimer: false })
    const config = plugin.Config({ dataDir, vaultDir })
    assert.doesNotThrow(() => plugin.apply(ctx, config))
    assert.deepEqual(
      ctx.registered.map((tool) => tool.name).sort(),
      [
        'chronicle_capsule',
        'chronicle_close',
        'chronicle_doctor',
        'chronicle_export_rules',
        'chronicle_facts',
        'chronicle_ping',
        'chronicle_related',
        'chronicle_review',
        'chronicle_search',
        'chronicle_today',
      ],
    )
    for (const tool of ctx.registered) {
      assert.equal(tool.parameters.type, 'object')
      assert.equal(tool.parameters.additionalProperties, false)
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.render, 'function')
    }
    const close = ctx.registered.find((tool) => tool.name === 'chronicle_close')
    assert.deepEqual(Object.keys(close.parameters.properties).sort(), ['day', 'dryRun', 'scoring'])
  })
})

test('有 timer 时同样正常（回归两个定时器都装上）', async () => {
  await withDirs(async (dataDir, vaultDir) => {
    const ctx = fakeCtx({ withTimer: true })
    assert.doesNotThrow(() => plugin.apply(ctx, plugin.Config({ dataDir, vaultDir })))
    assert.equal(ctx.registered.length, 10)
  })
})

test('webServer 通过 inject 就绪时，路由真的注册上（0.5.2 故障回归）', async () => {
  await withDirs(async (dataDir, vaultDir) => {
    const routes = []
    const ctx = fakeCtx({ injectable: { webServer: { register: (route) => (routes.push(route), () => {}) } } })
    plugin.apply(ctx, plugin.Config({ dataDir, vaultDir }))

    const ping = ctx.registered.find((tool) => tool.name === 'chronicle_ping')
    const value = await ping.execute({}, {})
    assert.equal(value.routes.ok, true, '应当注册成功')
    assert.equal(value.routes.disposers, 9, '8 条 exact + 1 条 prefix')
    assert.equal(routes.length, 9)
    const text = ping.output.render({}, value)[0].text
    assert.match(text, /面板 API 已注册 9 条/)
  })
})

test('没有 webServer 时，自检明确报出原因而不是静默', async () => {
  await withDirs(async (dataDir, vaultDir) => {
    const ctx = fakeCtx()
    plugin.apply(ctx, plugin.Config({ dataDir, vaultDir }))
    const ping = ctx.registered.find((tool) => tool.name === 'chronicle_ping')
    const value = await ping.execute({}, {})
    assert.equal(value.routes.ok, false)
    assert.match(ping.output.render({}, value)[0].text, /面板 API 未注册/)
  })
})

test('ping 的 execute 报出缺失服务，但不影响自身可用', async () => {
  await withDirs(async (dataDir, vaultDir) => {
    const ctx = fakeCtx({ withTimer: false })
    plugin.apply(ctx, plugin.Config({ dataDir, vaultDir }))
    const ping = ctx.registered.find((tool) => tool.name === 'chronicle_ping')
    const value = await ping.execute({}, {})
    assert.equal(value.phase, 'P6')
    assert.equal(value.dataDir, dataDir)
    assert.equal(value.vaultDir, vaultDir)
    for (const key of ['fs', 'llm', 'sessionQuery', 'timer', 'systemPrompt']) {
      assert.equal(value.services[key], false, `${key} 应报 false`)
    }
    const blocks = ping.output.render({}, value)
    assert.match(blocks[0].text, /dsh-chronicle P6/)
  })
})

test('依赖接线：index.js 必须把 facts/arcs/graph 三个读取器都传给 createChronicleApi', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  for (const key of ['readFacts', 'readArcs', 'loadGraph', 'buildViz']) {
    const wired = new RegExp(`${key}\\s*[:,]`).test(src)
    assert.ok(wired, `createChronicleApi 缺少 ${key} 接线（面板会显示空数据）`)
  }
})
