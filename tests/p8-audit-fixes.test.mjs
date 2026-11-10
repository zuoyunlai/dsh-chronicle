/**
 * 2026-11-10 审计后的回归测试。
 *
 * 这一批全是「审计发现 → 修复」的守卫，每条都对应报告里的一条问题。
 * 目的：让同一个坑不会被第二次踩。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractJsonObject } from '../lib/llm.js'
import { classifyScope, factsOfDay, mergeFactList, archiveOrphanFactPages, persistFacts } from '../lib/facts.js'
import { searchEntries, buildIdf, entryEntities } from '../lib/recall.js'
import { renderRulesMarkdown, reviewCandidates, hasRealValue } from '../lib/rules.js'
import { sectionOfKind } from '../lib/score.js'
import { redactText } from '../lib/redact.js'
import { settledDays } from '../lib/time.js'
import { detectSupersedes, hasOppositeMarkers } from '../lib/supersede.js'
import { pickEntityPages, entitySlug, renderEntityPage } from '../lib/entitypages.js'
import { closeAnsweredQuestions } from '../lib/supersede.js'

/* ---------- P0-9 围栏正则（我造的 bug） ---------- */

test('围栏正则：围栏前有中文或花括号也能解析', () => {
  assert.deepEqual(extractJsonObject('按 {summary} 模板给你：\n```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJsonObject('```\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```\n以上'), { a: 1 })
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 })
})

/* ---------- P0-10 普适性闸 ---------- */

test('普适性闸：工具开发史与用户工作知识分开', () => {
  const toolSelf = classifyScope({
    title: '修 llm.js',
    statement: '改了 lib/llm.js 的 prompt',
    kind: 'note',
    project: 'dsh-chronicle',
  })
  const general = classifyScope({
    title: 'WSL 迁移',
    statement: 'WSL 已迁至 D 盘，vhdx 从 51.04G 降到 28.95G',
    kind: 'note',
    project: 'WSL 迁移',
  })
  assert.equal(toolSelf, 'tool-self')
  assert.equal(general, 'general')
})

test('普适性闸：用户自己的工作词汇（收口时间）不算工具自用', () => {
  const scope = classifyScope({
    title: '收口时间',
    statement: '23:50 收口',
    kind: 'convention',
    project: 'p',
  })
  assert.equal(scope, 'general', '「收口」是用户的工作词汇，不该被判成工具实现细节')
})

test('普适性闸：projects 里的真实工作能升级为事实', () => {
  const facts = factsOfDay({
    day: '2026-11-09',
    entries: [
      {
        section: 'projects',
        title: 'WSL 迁移与磁盘优化',
        claim: 'WSL 已迁至 D 盘，vhdx 从 51.04G 降到 28.95G，数据无损',
        basis: '',
        project: 'WSL 迁移',
        ref: 'a#1',
      },
      { section: 'projects', title: 'dsh-chronicle', claim: '完成插件调研与命名', basis: '', project: 'dsh-chronicle', ref: 'a#2' },
    ],
  })
  assert.equal(facts.length, 1, '只有通过普适性闸的才进事实层')
  assert.equal(facts[0].title, 'WSL 迁移与磁盘优化')
  assert.equal(facts[0].scope, 'general')
})

/* ---------- P0-11 检索 ---------- */

test('检索：实体定义与建图一致（files 也进检索词）', () => {
  const entry = { title: '修路由', claim: '', basis: '', entities: [], files: ['E:/x/lib/api.js'] }
  assert.ok(entryEntities(entry).includes('api.js'))
})

test('检索：文件名作查询能命中（原来 0 命中）', () => {
  const entries = [
    { ref: 'a#1', title: '修路由', claim: '', basis: '', entities: [], files: ['index.js'], importance: 4, ts: '2026-11-09T10:00:00+08:00' },
    { ref: 'a#2', title: '无关', claim: '讲讲天气', basis: '', entities: [], files: [], importance: 3, ts: '2026-11-09T10:00:00+08:00' },
  ]
  const results = searchEntries(entries, 'index.js', { edges: [], idf: buildIdf(entries) })
  assert.ok(results.length > 0, '文件名查询必须能命中')
  assert.equal(results[0].ref, 'a#1')
})

test('检索：自然语言问法有单字回退（原来 0 命中）', () => {
  const entries = [
    { ref: 'a#1', title: '回捞卡在单个会话', claim: '后台回捞 3 分 45 秒仍停在已读 1 个会话', basis: '', entities: [], files: [], importance: 4, ts: '2026-11-09T10:00:00+08:00' },
  ]
  const results = searchEntries(entries, '上次那个坑', { edges: [], idf: buildIdf(entries) })
  assert.ok(results.length > 0, '切不出 2-gram 时要退到单字匹配')
})

test('检索：旧的但精确的记录能排在新的但无关的前面', () => {
  const entries = [
    { ref: 'old', title: '路由形状写错导致 404', claim: '路由形状', basis: '', entities: [], files: [], importance: 3, ts: '2026-01-01T10:00:00+08:00' },
    { ref: 'new', title: '今天天气不错', claim: '闲聊', basis: '', entities: [], files: [], importance: 5, ts: '2026-11-09T10:00:00+08:00' },
  ]
  const results = searchEntries(entries, '路由形状', { edges: [], idf: buildIdf(entries) })
  assert.equal(results[0].ref, 'old', '相关度必须压过新鲜度')
})

/* ---------- P1-9 事实层幂等 ---------- */

test('事实层幂等：重复合并不改变 occurrences 与 status', () => {
  const incoming = factsOfDay({
    day: '2026-11-09',
    entries: [{ section: 'decisions', title: '甲', claim: 'c', basis: 'b', project: 'p', ref: 'a#1' }],
  })
  let facts = []
  for (let i = 0; i < 3; i += 1) facts = mergeFactList(facts, incoming)
  assert.equal(facts[0].occurrences, 1, 'occurrences 由 timeline 推导，不累加')
  assert.equal(facts[0].status, 'single', '同一天不算跨天复现')
})

test('status 全量重算：存量假 repeated 会被纠正', () => {
  const existing = [
    { id: 'x', kind: 'decision', title: 'x', statement: 's', rationale: 'r', scope: 'general', bornOn: '2026-11-09', timeline: [{ day: '2026-11-09' }], status: 'repeated', evidence: [], hits: 0, project: 'p' },
  ]
  const merged = mergeFactList(existing, [])
  assert.equal(merged[0].status, 'single', 'timeline 只有 1 天却标 repeated 是撒谎')
})

/* ---------- P1-2 推翻机制 ---------- */

test('推翻检测：同标题 + 语义相反 ⇒ 旧事实被标 superseded', () => {
  const old = [{ id: 'decision-用向量库', kind: 'decision', title: '用向量库', statement: '用向量库做检索', rationale: '', scope: 'general', bornOn: '2026-11-01', timeline: [{ day: '2026-11-01' }], status: 'single', evidence: [], hits: 0, project: 'p' }]
  const fresh = factsOfDay({
    day: '2026-11-10',
    entries: [{ section: 'decisions', title: '用向量库', claim: '不用向量库，改用 2-gram', basis: '量级小', ref: 'b#1', project: 'p' }],
  })
  const merged = mergeFactList(old, fresh)
  assert.equal(merged[0].status, 'superseded')
  assert.ok(merged[0].supersededBy)
})

test('推翻检测：语义相反词识别', () => {
  assert.equal(hasOppositeMarkers({ statement: '用向量库' }, { statement: '不用向量库' }), true)
  assert.equal(hasOppositeMarkers({ statement: '用向量库' }, { statement: '用 2-gram' }), false)
})

/* ---------- P0-8 脱敏 ---------- */

test('脱敏：JSON/YAML 带引号的键要生效', () => {
  for (const sample of ['{"password": "hunter2secret"}', "{'api_key': 'abcd1234efgh'}", '"authorization": "Bearer abc123def456"']) {
    assert.notEqual(redactText(sample).text, sample, `没脱敏：${sample}`)
  }
})

test('脱敏：常见厂商前缀与裸 UUID 要覆盖', () => {
  for (const sample of [
    'AIzaSyA1234567890abcdefghijklmnopqrstu',
    'xoxb-1234567890-abcdefghijkl',
    'glpat-abcdefghij1234567890',
    'b0c7f2c8-9a1b-4c3d-8e5f-1a2b3c4d5e6f',
    '123456789:AAHf6abcdefghijklmnopqrstuvwxyz1234',
    'sk-abc123',
  ]) {
    assert.notEqual(redactText(sample).text, sample, `没脱敏：${sample}`)
  }
})

test('脱敏：不该误伤普通词', () => {
  for (const sample of ['task-abc123def', 'disk-usage-report', 'mytask-123456', 'backfill-2026-11-10']) {
    assert.equal(redactText(sample).text, sample, `误伤了：${sample}`)
  }
})

/* ---------- P0-5 规则档 ---------- */

test('规则档必须产出 section，否则事实库永远为空', () => {
  assert.equal(sectionOfKind('decision'), 'decisions')
  assert.equal(sectionOfKind('pitfall'), 'pitfalls')
  assert.equal(sectionOfKind('delivery'), 'projects')
  assert.equal(sectionOfKind('research'), 'threads')
})

/* ---------- P0-6 / P0-7 时间窗口 ---------- */




/* ---------- P1-6 规则导出 ---------- */

test('规则导出：「未设定」不算有效失效条件', () => {
  assert.equal(hasRealValue('未设定'), false)
  assert.equal(hasRealValue('暂无'), false)
  assert.equal(hasRealValue('用户量过千'), true)
  const md = renderRulesMarkdown(
    [{ id: 'd', kind: 'decision', title: '甲', statement: 's', expiresWhen: '未设定', scope: 'general', status: 'single', bornOn: '2026-11-09', timeline: [] }],
    { generatedAt: '2026-11-10' },
  )
  assert.ok(!md.includes('未设定 时重评'), md)
})

test('规则导出：tool-self 不进规则', () => {
  const md = renderRulesMarkdown(
    [{ id: 'd', kind: 'decision', title: '甲', statement: 's', expiresWhen: 'x', scope: 'tool-self', status: 'single', bornOn: '2026-11-09', timeline: [] }],
    { generatedAt: '2026-11-10' },
  )
  assert.ok(!md.includes('甲'), '工具自身的开发笔记不该被导出成规则')
})

test('复核候选：判据不看 status（存量有假 repeated）', () => {
  const facts = [
    { id: 'a', kind: 'decision', title: '老结论', statement: 'x', scope: 'general', status: 'repeated', bornOn: '2026-10-01', timeline: [{ day: '2026-10-01' }] },
  ]
  const candidates = reviewCandidates(facts, { now: new Date('2026-11-10T12:00:00').getTime(), olderThanDays: 14 })
  assert.equal(candidates.length, 1, 'timeline 只有 1 天但 status 是 repeated 的，也要进复核清单')
})

/* ---------- P1-5 孤儿页 ---------- */

test('孤儿事实页被归档到 _superseded/', async () => {
  const vaultDir = await mkdtemp(join(tmpdir(), 'chronicle-orphan-'))
  try {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(vaultDir, 'facts'), { recursive: true })
    await writeFile(join(vaultDir, 'facts', 'pitfall-old.md'), 'old page', 'utf8')
    await writeFile(join(vaultDir, 'facts', 'pitfall-keep.md'), 'keep page', 'utf8')
    const result = await archiveOrphanFactPages(vaultDir, [{ id: 'pitfall-keep' }])
    assert.equal(result.archived, 1)
    const kept = await readFile(join(vaultDir, 'facts', 'pitfall-keep.md'), 'utf8')
    assert.equal(kept, 'keep page')
    const archived = await readFile(join(vaultDir, 'facts', '_superseded', 'pitfall-old.md'), 'utf8')
    assert.equal(archived, 'old page', '孤儿页要归档而不是删除，保留可审计性')
  } finally {
    await rm(vaultDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 })
  }
})

/* ---------- closeAt 校验 ---------- */


/* ---------- P1-13 LLM 打分缓存 ---------- */

test('打分缓存：命中缓存不再调模型，ref 集变了则作废', async () => {
  const { readScoreCache, writeScoreCache } = await import('../lib/scorecache.js')
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-cache-'))
  try {
    const entries = [{ ref: 'a#1', title: 'x', importance: 4 }]
    entries.summary = '这一天的日结，长度足够。'
    entries.sections = [{ key: 'decisions', title: '结论与决策', refs: ['a#1'] }]
    await writeScoreCache(dataDir, '2026-11-09', 'v1', entries)

    const hit = await readScoreCache(dataDir, '2026-11-09', 'v1', ['a#1'])
    assert.ok(hit, 'ref 集一致应命中')
    assert.equal(hit.summary, '这一天的日结，长度足够。')
    assert.equal(hit.sections.length, 1)

    const miss = await readScoreCache(dataDir, '2026-11-09', 'v1', ['a#1', 'a#2'])
    assert.equal(miss, null, 'ref 集变了缓存必须作废（回捞补了新会话）')

    const versionMiss = await readScoreCache(dataDir, '2026-11-09', 'v2', ['a#1'])
    assert.equal(versionMiss, null, 'prompt 版本变了缓存必须作废')
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 })
  }
})

/* ---------- P1-1 实体页 ---------- */

test('实体页门槛：on-hit 只给被召回过的建，score 看度数', () => {
  const nodes = [
    { name: 'index.js', kind: 'file', degree: 15 },
    { name: 'api.js', kind: 'file', degree: 3 },
    { name: '某事实', kind: 'fact', degree: 9 },
  ]
  assert.deepEqual(
    pickEntityPages({ nodes, rule: 'on-hit', hits: { 'api.js': 1 } }).map((n) => n.name),
    ['api.js'],
    '事实节点不进实体页（它有自己的 facts/ 页）',
  )
  assert.deepEqual(
    pickEntityPages({ nodes, rule: 'score', minScore: 4, hits: {} }).map((n) => n.name),
    ['index.js'],
  )
})

test('实体页：名字里的非法字符被替换（Obsidian 双链要对上）', () => {
  assert.equal(entitySlug('a/b:c*d'), 'a-b-c-d')
  assert.equal(entitySlug('  dsh-chronicle  '), 'dsh-chronicle')
})

test('实体页：渲染出邻居与相关记录', () => {
  const md = renderEntityPage({
    node: { name: 'index.js', kind: 'file', degree: 15 },
    entries: [{ ref: 'a#1', title: '修路由', importance: 4 }],
    neighbors: [{ name: 'dsh-chronicle', weight: 5 }],
    hits: 3,
  })
  assert.match(md, /entity: index.js/)
  assert.ok(md.includes('[[dsh-chronicle]]'), md)
  assert.match(md, /修路由/)
})

/* ---------- P1-7 问题生命周期 ---------- */

test('问题生命周期：被后续决策回答了要自动关闭', () => {
  const facts = [
    { id: 'q1', kind: 'question', title: '跨工作区怎么汇总', statement: '还没定', bornOn: '2026-11-08', status: 'single' },
    { id: 'd1', kind: 'decision', title: '跨工作区汇总', statement: '用 sessionQuery 回捞', bornOn: '2026-11-09', status: 'single' },
  ]
  const closed = closeAnsweredQuestions(facts)
  assert.equal(closed, 1)
  assert.equal(facts[0].status, 'answered')
  assert.equal(facts[0].answeredBy, 'd1')
})

test('问题生命周期：答案早于问题不算回答', () => {
  const facts = [
    { id: 'q1', kind: 'question', title: '跨工作区怎么汇总', statement: '还没定', bornOn: '2026-11-09', status: 'single' },
    { id: 'd1', kind: 'decision', title: '跨工作区汇总', statement: '用 sessionQuery 回捞', bornOn: '2026-11-08', status: 'single' },
  ]
  assert.equal(closeAnsweredQuestions(facts), 0, '答案不能早于问题')
  assert.equal(facts[0].status, 'single')
})

/* ---------- P2-18 工具 output.schema 不能是空壳 ---------- */

test('宿主激活：10 个工具都注册，且 output.schema 写实', async () => {
  const plugin = await import('../index.js')
  const tools = []
  const disposers = []
  const ctx = {
    tools: { register: (spec) => { tools.push(spec); return () => {} } },
    on: () => () => {},
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d || (() => {}) },
    inject: (list, cb) => (cb ? cb({ get: (k) => (list.includes(k) ? ctx[k] : undefined) }) : undefined),
    get: (k) => ctx[k],
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-boot-d-'))
  const vaultDir = await mkdtemp(join(tmpdir(), 'chronicle-boot-v-'))
  try {
    plugin.apply(ctx, {
      dataDir, vaultDir, closeAt: '23:50', tickMinutes: 5, importanceFloor: 3, scoring: 'rule',
      entityRule: 'on-hit', entityMinScore: 4, gitCommit: false, injectLine: true, injectBudget: 80,
      redact: true, maxEventsPerDay: 5000, includeSubagent: false, followModel: true, scoringModel: '',
      weekFile: true, panel: true, keepDays: 0,
    })
    assert.equal(tools.length, 10, '应该注册 10 个工具')
    for (const tool of tools) {
      assert.ok(tool.output, tool.name + ' 缺 output')
      assert.equal(typeof tool.output.render, 'function', tool.name + ' 缺 output.render')
      const props = tool.output.schema && tool.output.schema.properties
      assert.ok(props && Object.keys(props).length > 0, tool.name + ' 的 output.schema 是空壳')
    }
    // 卸载路径不能抛
    for (const dispose of disposers) {
      try { dispose() } catch (error) { assert.fail('卸载抛错: ' + error.message) }
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 })
    await rm(vaultDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 })
  }
})


/* ---------- 方案 B：次日收昨天 ---------- */

test('方案 B：今天永远不收，哪怕已经 23:59', () => {
  const result = settledDays({
    now: new Date(2026, 10, 9, 23, 59).getTime(),
    daysWithEvents: ['2026-11-09'],
    closedDays: [],
  })
  assert.deepEqual(result.days, [], '当天还没过完，收了就不完整')
})

test('方案 B：跨过午夜后第一次 tick 就收昨天', () => {
  const result = settledDays({
    now: new Date(2026, 10, 10, 0, 5).getTime(),
    daysWithEvents: ['2026-11-09', '2026-11-10'],
    closedDays: [],
  })
  assert.deepEqual(result.days, ['2026-11-09'], '只收过完的那天')
})

test('方案 B：关机 5 天后开机，全部补齐（不受固定时刻影响）', () => {
  const result = settledDays({
    now: new Date(2026, 10, 10, 9, 0).getTime(),
    daysWithEvents: ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'],
    closedDays: [],
  })
  assert.deepEqual(result.days, ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'])
})

test('方案 B：已收口的天不重复收', () => {
  const result = settledDays({
    now: new Date(2026, 10, 10, 9, 0).getTime(),
    daysWithEvents: ['2026-11-09'],
    closedDays: ['2026-11-09'],
    dayStamps: { '2026-11-09': 1000 },
    closedStamps: { '2026-11-09': 1000 },
  })
  assert.deepEqual(result.days, [])
})

test('方案 B：收口后回捞补进新事件 ⇒ 必须重收（否则周文件是旧的）', () => {
  const result = settledDays({
    now: new Date(2026, 10, 10, 9, 0).getTime(),
    daysWithEvents: ['2026-11-09'],
    closedDays: ['2026-11-09'],
    dayStamps: { '2026-11-09': 2000 },   // 事件文件在收口之后又变了
    closedStamps: { '2026-11-09': 1000 },
  })
  assert.deepEqual(result.days, ['2026-11-09'])
  assert.deepEqual(result.revisited, ['2026-11-09'], '要能区分「补收」和「重收」')
})

test('方案 B：lookback 截掉的天要报出来', () => {
  const many = Array.from({ length: 40 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`)
  const result = settledDays({
    now: new Date(2026, 10, 10, 9, 0).getTime(),
    daysWithEvents: many,
    closedDays: [],
    lookback: 30,
  })
  assert.equal(result.days.length, 30)
  assert.equal(result.dropped.length, 10, '被截掉的天必须能看见')
})

/* ---------- P1-1 实体页：必须从磁盘读图，不能依赖调用方传形状 ---------- */

test('实体页：自己从 graph/entities.json 读，不靠调用方传 graph（真实 bug 守卫）', async () => {
  const { mkdtemp, mkdir, writeFile, readdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { persistEntityPages } = await import('../lib/entitypages.js')

  const dataDir = await mkdtemp(join(tmpdir(), 'ent-real-d-'))
  const vaultDir = await mkdtemp(join(tmpdir(), 'ent-real-v-'))
  try {
    await mkdir(join(dataDir, 'graph'), { recursive: true })
    // 真实形状：entities.json 的节点在 entities 字段里（不是 nodes）
    await writeFile(
      join(dataDir, 'graph', 'entities.json'),
      JSON.stringify({
        v: 1,
        days: 2,
        entities: [
          { name: 'index.js', kind: 'file', days: ['2026-11-09'], mentions: [], degree: 15 },
          { name: 'CHANGELOG.md', kind: 'file', days: ['2026-11-09'], mentions: [], degree: 8 },
        ],
      }),
      'utf8',
    )
    await writeFile(
      join(dataDir, 'graph', 'edges.jsonl'),
      JSON.stringify({ a: 'index.js', b: 'CHANGELOG.md', type: 'file', weight: 5, evidence: [] }) + '\n',
      'utf8',
    )
    await writeFile(join(dataDir, 'graph', 'entity-hits.json'), JSON.stringify({ 'index.js': 2, 'CHANGELOG.md': 1 }), 'utf8')

    // 关键：**不传 graph**。之前调用方传的是 mergeGraph() 的统计摘要（数字），
    // 于是 nodes 恒为空、实体页一个都不建，而单测自己构造 nodes 就发现不了。
    const result = await persistEntityPages({ dataDir, vaultDir, rule: 'on-hit', entries: [] })
    assert.equal(result.pages, 2, '应从磁盘读到 2 个节点并各建一页')

    const files = (await readdir(join(vaultDir, 'entities'))).sort()
    assert.deepEqual(files, ['CHANGELOG.md', 'index.js.md'], 'CHANGELOG.md 不能变成 CHANGELOG.md.md')
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 })
    await rm(vaultDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 })
  }
})

/* ---------- P1-16 规则导出按项目分节 ---------- */

test('规则导出：按项目分节，通用条目排最前', () => {
  const facts = [
    { id: 'a', kind: 'convention', title: '通用约定', statement: 's', project: '', status: 'single', bornOn: '2026-11-09' },
    { id: 'b', kind: 'convention', title: '插件约定', statement: 's', project: 'dsh-chronicle', status: 'single', bornOn: '2026-11-09' },
    { id: 'c', kind: 'convention', title: '别的项目', statement: 's', project: 'wsl', status: 'single', bornOn: '2026-11-09' },
  ]
  const md = renderRulesMarkdown(facts, { generatedAt: '2026-11-10' })
  const heads = md.split('\n').filter((line) => line.startsWith('### '))
  assert.deepEqual(heads, ['### 通用', '### 项目：dsh-chronicle', '### 项目：wsl'], '通用必须排最前：' + heads.join(' | '))
})

test('规则导出：指定 project 时只留该项目 + 通用条目', () => {
  const facts = [
    { id: 'a', kind: 'convention', title: '通用约定', statement: 's', project: '', status: 'single', bornOn: '2026-11-09' },
    { id: 'b', kind: 'convention', title: '插件约定', statement: 's', project: 'dsh-chronicle', status: 'single', bornOn: '2026-11-09' },
    { id: 'c', kind: 'convention', title: '别的项目', statement: 's', project: 'wsl', status: 'single', bornOn: '2026-11-09' },
  ]
  const md = renderRulesMarkdown(facts, { generatedAt: '2026-11-10', project: 'dsh-chronicle' })
  assert.ok(md.includes('插件约定'), md)
  assert.ok(md.includes('通用约定'), '通用条目任何项目都该带上')
  assert.ok(!md.includes('别的项目'), '指定项目时不该混进其它项目：' + md)
})

/* ---------- CI 抓出的真 bug：超时定时器不能 unref ---------- */

test('withTimeout：没有任何其它句柄时也必须触发超时', async () => {
  const { withTimeout } = await import('../lib/backfill.js')
  const never = new Promise(() => {})
  const started = Date.now()
  await assert.rejects(
    () => withTimeout(never, 120, 'slow'),
    /超时 120ms/,
    '超时定时器 unref 之后，如果它是唯一待办句柄，事件循环会先变空、进程直接退出，超时永远不触发',
  )
  const used = Date.now() - started
  assert.ok(used >= 100, `应该在 ~120ms 后触发，实际 ${used}ms`)
  assert.ok(used < 3000, `不该拖太久，实际 ${used}ms`)
})

test('withTimeout：正常返回时不留悬挂定时器（不拖住进程退出）', async () => {
  const { withTimeout } = await import('../lib/backfill.js')
  const started = Date.now()
  const value = await withTimeout(Promise.resolve('ok'), 5000, 'fast')
  assert.equal(value, 'ok')
  assert.ok(Date.now() - started < 500, '正常路径应立即返回，不该等超时')
})

/* ---------- LLM 截断抢救（2026-11-10 真实故障） ---------- */

test('对象格式被截断：summary 与各数组能抢救出来', async () => {
  const { salvageDigestObject, normalizeDigest } = await import('../lib/llm.js')
  // 模拟 maxTokens 截断：对象没有收尾 }，最后一个数组也没有收尾 ]
  const truncated = [
    '{"summary":"今天主攻三片竹简图标，顺带发了 v2.2.0。",',
    '"projects":[{"name":"dsh-chronicle","progress":"换图标","ref":"s1#3"}],',
    '"decisions":[{"title":"用内联 SVG","decision":"不用 img","why":"没有公开 URL","ref":"s1#4"}],',
    '"pitfalls":[{"title":"脚架双记","symptom":"3 片数成 6","rootCause":"两处 push","ref":"s1#5"}]',
    // 故意缺 } 与 ]
  ].join('')

  const salvaged = salvageDigestObject(truncated)
  assert.ok(salvaged, '应抢救出对象')
  assert.match(salvaged.summary, /三片竹简图标/)
  assert.equal(salvaged.projects.length, 1)
  assert.equal(salvaged.projects[0].ref, 's1#3')
  assert.equal(salvaged.decisions.length, 1)
  assert.equal(salvaged.pitfalls.length, 1)

  // 抢救结果必须能过 normalizeDigest（这是真正要的东西）
  const digest = normalizeDigest(truncated, ['s1#3', 's1#4', 's1#5'])
  assert.ok(digest, 'normalizeDigest 应接受被截断的文本')
  assert.match(digest.summary, /三片竹简图标/)
  assert.equal(digest.entries.length, 3, '三条都该救出来')
  assert.ok(digest.sections.length >= 3, '四块结构应重建')
  assert.equal(digest.salvaged, true, '应标记为抢救结果')
})

test('未截断时不该走抢救路径', async () => {
  const { normalizeDigest } = await import('../lib/llm.js')
  // 日结是硬要求（≥20 字），所以这里给一句够长的
  const ok = '{"summary":"今天把侧栏图标换成了三片竹简，顺带修了测试脚手架的一个计数错误。","projects":[{"name":"P","progress":"x","ref":"s1#1"}]}'
  const digest = normalizeDigest(ok, ['s1#1'])
  assert.ok(digest)
  assert.equal(digest.salvaged, undefined, '完整 JSON 不该标成抢救')
  assert.equal(digest.entries.length, 1)
})

test('规则档也产出四块结构（之前只有 LLM 档有，自检因此误报）', async () => {
  const { scoreDay } = await import('../lib/score.js')
  const turns = [
    { sid: 'a', seq: 1, ts: '2026-11-10T10:00:00+08:00', user: '部署到生产并删除旧数据', assistant: '', tools: [], files: ['x.js'], failures: 0, userChars: 12 },
    { sid: 'a', seq: 2, ts: '2026-11-10T10:05:00+08:00', user: '查一下这个报错原因', assistant: '', tools: ['read'], files: [], failures: 0, userChars: 9 },
  ]
  const scored = scoreDay(turns)
  assert.ok(Array.isArray(scored.sections), '规则档必须给出 sections')
  assert.ok(scored.sections.length > 0, 'sections 不能为空')
  for (const section of scored.sections) {
    assert.ok(Array.isArray(section.refs) && section.refs.length > 0)
  }
})
