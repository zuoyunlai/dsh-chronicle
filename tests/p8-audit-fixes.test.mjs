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
import { catchUpDays, closeDecision, isValidCloseAt } from '../lib/time.js'
import { detectSupersedes, hasOppositeMarkers } from '../lib/supersede.js'
import { previousDay } from '../lib/close.js'

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

test('补收口：更早的历史天不能被 lastClosedDay 挡掉', () => {
  const days = catchUpDays({
    now: new Date('2026-11-10T00:05:00+08:00').getTime(),
    closeAt: '23:50',
    lastClosedDay: '2026-11-09',
    closedDays: ['2026-11-09'],
    daysWithEvents: ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'],
  })
  assert.deepEqual(days, ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'])
})

test('收口决定：已在 closedDays 里的日子不重复收', () => {
  const decision = closeDecision({
    now: new Date('2026-11-09T23:52:00+08:00').getTime(),
    closeAt: '23:50',
    lastClosedDay: '2026-11-09',
    closedDays: ['2026-11-09'],
  })
  assert.equal(decision.due, false)
})

test('前一天：跨月跨年都正确', () => {
  assert.equal(previousDay('2026-11-09'), '2026-11-08')
  assert.equal(previousDay('2026-11-01'), '2026-10-31')
  assert.equal(previousDay('2026-01-01'), '2025-12-31')
  assert.equal(previousDay('2027-01-01'), '2026-12-31')
})

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
    await rm(vaultDir, { recursive: true, force: true })
  }
})

/* ---------- closeAt 校验 ---------- */

test('closeAt 校验：非法值能被发现', () => {
  assert.equal(isValidCloseAt('23:50'), true)
  assert.equal(isValidCloseAt('24:00'), false)
  assert.equal(isValidCloseAt('bogus'), false)
  assert.equal(isValidCloseAt(''), false)
})
