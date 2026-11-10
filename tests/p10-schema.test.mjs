/**
 * 宿主 JSON Schema 校验的本地复刻。
 *
 * 为什么必须有（2026-11-10 真实事故）：
 * 我为审计 P2-18「把 output.schema 写实」给 10 个工具补了 schema，
 * 用了 `type: ['string','null']` 和 `additionalProperties: { type: 'boolean' }`，
 * 结果宿主报
 *   JsonSchemaError: unsupported JSON schema:
 *     schema.properties.scoringTarget.type must be a single type string (type arrays are not supported)
 *     schema.properties.services.additionalProperties must be a boolean
 * 整个插件条目 `import failed`，DSH 启动失败，还被自动从 profile 摘掉。
 *
 * 教训：**「更严格的 schema」在别的校验器里可能是非法的**。
 * 拿不到宿主实现时，至少要把已知的约束在本地复刻成断言。
 *
 * DSH 支持的子集（按报错信息归纳）：
 *   - type 必须是**单个字符串**，不接受数组（所以没有联合类型 / nullable）
 *   - additionalProperties 必须是**布尔**
 *   - 属性用 properties / items / required 表达
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { TOOL_SCHEMAS } from '../lib/schemas.js'

const ALLOWED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])

/** 递归收集一个 schema 里的所有违规点。 */
export function findSchemaViolations(schema, path = 'schema') {
  const problems = []
  if (schema === null || schema === undefined) return problems

  if (Array.isArray(schema)) {
    schema.forEach((item, index) => problems.push(...findSchemaViolations(item, `${path}[${index}]`)))
    return problems
  }
  if (typeof schema !== 'object') return problems

  if ('type' in schema) {
    const type = schema.type
    if (Array.isArray(type)) {
      problems.push(`${path}.type 是数组（宿主不支持联合类型，必须是单个字符串）`)
    } else if (typeof type !== 'string') {
      problems.push(`${path}.type 必须是字符串，收到 ${typeof type}`)
    } else if (!ALLOWED_TYPES.has(type)) {
      problems.push(`${path}.type 非法值 ${JSON.stringify(type)}`)
    }
  }

  if ('additionalProperties' in schema) {
    const extra = schema.additionalProperties
    if (typeof extra !== 'boolean') {
      // DSH 实测会报 "must be a boolean"
      if (extra && typeof extra === 'object') {
        problems.push(`${path}.additionalProperties 是对象（宿主只接受布尔）`)
        problems.push(...findSchemaViolations(extra, `${path}.additionalProperties`))
      } else {
        problems.push(`${path}.additionalProperties 必须是布尔`)
      }
    }
  }

  for (const [key, value] of Object.entries(schema.properties || {})) {
    problems.push(...findSchemaViolations(value, `${path}.properties.${key}`))
  }
  if (schema.items) problems.push(...findSchemaViolations(schema.items, `${path}.items`))
  if (Array.isArray(schema.oneOf)) {
    problems.push(...findSchemaViolations(schema.oneOf, `${path}.oneOf`))
  }
  if (Array.isArray(schema.anyOf)) {
    problems.push(...findSchemaViolations(schema.anyOf, `${path}.anyOf`))
  }
  return problems
}

test('校验器自检：能识别 type 数组与对象 additionalProperties', () => {
  const bad = {
    type: 'object',
    properties: {
      a: { type: ['string', 'null'] },
      b: { type: 'object', additionalProperties: { type: 'boolean' } },
    },
  }
  const problems = findSchemaViolations(bad)
  assert.ok(problems.some((p) => p.includes('type 是数组')), '应识别 type 数组')
  assert.ok(problems.some((p) => p.includes('additionalProperties')), '应识别对象型 additionalProperties')
})

test('10 个工具的 output.schema 全部符合宿主支持的子集', () => {
  const names = Object.keys(TOOL_SCHEMAS)
  assert.equal(names.length, 10, '应该有 10 个工具 schema')
  for (const name of names) {
    const problems = findSchemaViolations(TOOL_SCHEMAS[name], `TOOL_SCHEMAS.${name}`)
    assert.deepEqual(problems, [], `${name} 的 schema 有违规:\n  ` + problems.join('\n  '))
  }
})

test('每个 schema 都是 object 且声明了至少一个属性（不能是空壳）', () => {
  for (const [name, schema] of Object.entries(TOOL_SCHEMAS)) {
    assert.equal(schema.type, 'object', `${name} 的顶层 type 必须是 object`)
    const props = schema.properties || {}
    assert.ok(Object.keys(props).length > 0, `${name} 的 properties 不能为空（空壳 schema 等于没声明）`)
  }
})

/**
 * 输出校验：声明了 schema 就必须让实际输出满足它。
 *
 * 这是本次事故的另一半——schema 写实之后，宿主会**真的拿它校验 execute 返回值**。
 * `lastError: null` 撞上 `type: 'string'` 就报
 *   tool "chronicle_ping" returned invalid output: "value.lastError" must be a string
 * 空壳 schema 时代这个问题是隐形的。
 */

/** 只校验本插件用到的子集：string/number/boolean/object/array + properties + required。 */
function validateAgainstSchema(value, schema, path = 'value') {
  const problems = []
  if (!schema || typeof schema !== 'object') return problems
  const type = schema.type

  if (type === 'string' && typeof value !== 'string') problems.push(`${path} 应该是 string，实际 ${value === null ? 'null' : typeof value}`)
  if (type === 'number' && typeof value !== 'number') problems.push(`${path} 应该是 number，实际 ${value === null ? 'null' : typeof value}`)
  if (type === 'boolean' && typeof value !== 'boolean') problems.push(`${path} 应该是 boolean，实际 ${value === null ? 'null' : typeof value}`)
  if (type === 'array' && !Array.isArray(value)) problems.push(`${path} 应该是 array，实际 ${value === null ? 'null' : typeof value}`)
  if (type === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    problems.push(`${path} 应该是 object，实际 ${value === null ? 'null' : typeof value}`)
    return problems
  }

  if (type === 'object' && value && typeof value === 'object') {
    for (const key of schema.required || []) {
      if (!(key in value)) problems.push(`${path}.${key} 是必需字段但缺失`)
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) problems.push(...validateAgainstSchema(value[key], sub, `${path}.${key}`))
    }
  }
  if (type === 'array' && Array.isArray(value) && schema.items) {
    value.slice(0, 5).forEach((item, index) => problems.push(...validateAgainstSchema(item, schema.items, `${path}[${index}]`)))
  }
  return problems
}

test('chronicle_ping 的实际输出满足它声明的 schema', async () => {
  const plugin = await import('../index.js')
  const tools = new Map()
  const ctx = {
    tools: { register: (spec) => { tools.set(spec.name, spec); return () => {} } },
    on: () => () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject: (list, cb) => (cb ? cb({ get: (k) => (list.includes(k) ? ctx[k] : undefined) }) : undefined),
    get: (k) => ctx[k],
  }
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { rm } = await import('node:fs/promises')
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-out-d-'))
  const vaultDir = await mkdtemp(join(tmpdir(), 'chronicle-out-v-'))
  try {
    plugin.apply(ctx, {
      dataDir, vaultDir, closeAt: '23:50', tickMinutes: 5, importanceFloor: 3, scoring: 'rule',
      entityRule: 'on-hit', entityMinScore: 4, gitCommit: false, injectLine: true, injectBudget: 80,
      redact: true, maxEventsPerDay: 5000, includeSubagent: false, followModel: true, scoringModel: '',
      weekFile: true, panel: true, keepDays: 0,
    })
    const ping = tools.get('chronicle_ping')
    assert.ok(ping, '没有注册 chronicle_ping')
    const value = await ping.execute({})
    const problems = validateAgainstSchema(value, TOOL_SCHEMAS.chronicle_ping)
    assert.deepEqual(problems, [], 'ping 输出不满足 schema:\n  ' + problems.join('\n  '))
    // 明确：可空字段现在一律给字符串，不再返回 null
    assert.equal(typeof value.lastError, 'string')
    assert.equal(typeof value.llmError, 'string')
    assert.equal(typeof value.lastClosedDay, 'string')
    assert.equal(typeof value.scoringTarget, 'string')
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 })
    await rm(vaultDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 })
  }
})

test('10 个工具的实际输出都满足各自声明的 schema', async () => {
  const plugin = await import('../index.js')
  const tools = new Map()
  const ctx = {
    tools: { register: (spec) => { tools.set(spec.name, spec); return () => {} } },
    on: () => () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject: (list, cb) => (cb ? cb({ get: (k) => (list.includes(k) ? ctx[k] : undefined) }) : undefined),
    get: (k) => ctx[k],
  }
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-all-d-'))
  const vaultDir = await mkdtemp(join(tmpdir(), 'chronicle-all-v-'))
  try {
    plugin.apply(ctx, {
      dataDir, vaultDir, closeAt: '23:50', tickMinutes: 5, importanceFloor: 3, scoring: 'rule',
      entityRule: 'on-hit', entityMinScore: 4, gitCommit: false, injectLine: true, injectBudget: 80,
      redact: true, maxEventsPerDay: 5000, includeSubagent: false, followModel: true, scoringModel: '',
      weekFile: true, panel: true, keepDays: 0,
    })

    const callArgs = {
      chronicle_ping: {},
      chronicle_close: { dryRun: true },
      chronicle_doctor: {},
      chronicle_today: {},
      chronicle_search: { query: '测试' },
      chronicle_related: { name: 'index.js' },
      chronicle_facts: {},
      chronicle_review: {},
      chronicle_export_rules: { write: false },
      chronicle_capsule: { text: '审计回归用的一句' },
    }

    const failures = []
    for (const [name, schema] of Object.entries(TOOL_SCHEMAS)) {
      const tool = tools.get(name)
      if (!tool) {
        failures.push(`${name}: 没有注册`)
        continue
      }
      let value
      try {
        value = await tool.execute(callArgs[name] || {})
      } catch (error) {
        failures.push(`${name}: execute 抛错 ${error.message}`)
        continue
      }
      const problems = validateAgainstSchema(value, schema)
      if (problems.length > 0) failures.push(`${name}:\n    ` + problems.join('\n    '))
    }
    assert.deepEqual(failures, [], '这些工具的输出不满足 schema:\n  ' + failures.join('\n  '))
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 })
    await rm(vaultDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 })
  }
})
