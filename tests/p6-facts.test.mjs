/**
 * P5/P6：事实层、跨天线索、规则导出、命中计数。
 * 全部用临时目录，不碰真实 vault。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  factsOfDay,
  mergeFactList,
  renderFactPage,
  renderMemoryIndex,
  persistFacts,
  bumpFactHits,
  readFacts,
  similarity,
} from '../lib/facts.js'
import { buildArcs, persistArcs, readArcs } from '../lib/arcs.js'
import { mergeProjects, sectionsFromEntries, structureWarnings } from '../lib/close.js'
import { attachFactNodes } from '../lib/entities.js'
import { renderRulesMarkdown, reviewCandidates } from '../lib/rules.js'

const DAY = '2026-11-09'

function entry(section, title, extra = {}) {
  // project 用中性的 'p'：dsh-chronicle 会被 scope 分类器判为 tool-self
  return { section, title, claim: 'statement-' + title, basis: 'root-' + title, project: 'p', ref: 'a#1', ...extra }
}

test('factsOfDay：四块各自映射成事实类型', () => {
  const facts = factsOfDay({
    day: DAY,
    entries: [
      entry('decisions', '定日期', { expiresWhen: '用户量过千' }),
      entry('pitfalls', '面板 404', { detector: '面板空白且 body 为空' }),
      entry('rejected', '用 SQLite', { claim: '改成 SQLite', basis: '引入原生依赖' }),
      entry('conventions', '收口时间', { claim: '23:50 收口' }),
      entry('questions', '回捞上限', { claim: '要不要多轮续补' }),
      entry('projects', '不该进事实层'),
      entry('threads', '也不该进'),
    ],
  })
  assert.deepEqual(
    facts.map((fact) => fact.kind),
    ['decision', 'pitfall', 'rejected', 'convention', 'question'],
    '只有四块 + 约定/未答进事实层，项目与线索不进',
  )
  const decision = facts[0]
  assert.equal(decision.expiresWhen, '用户量过千')
  assert.equal(decision.status, 'single')
  assert.equal(facts[1].detector, '面板空白且 body 为空')
  assert.deepEqual(facts[0].timeline, [{ day: DAY, ref: 'a#1' }])
})

test('mergeFactList：同日同题只算复述次数，状态仍是 single（跨天才 repeated）', () => {
  const first = factsOfDay({ day: '2026-11-08', entries: [entry('decisions', '定日期')] })
  const second = factsOfDay({ day: '2026-11-09', entries: [entry('decisions', '定日期', { ref: 'b#2' })] })
  const merged = mergeFactList(first, second)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].status, 'repeated', '跨两天才算复现')
  assert.deepEqual(merged[0].timeline.map((item) => item.day), ['2026-11-08', '2026-11-09'])
  assert.equal(merged[0].occurrences, 2)
})

test('mergeFactList：高相似的不同标题也合并（宁少勿滥）', () => {
  const a = factsOfDay({ day: DAY, entries: [entry('pitfalls', '面板空白', { claim: '面板空白且无内容' })] })
  const b = factsOfDay({ day: DAY, entries: [entry('pitfalls', '右侧面板无内容', { claim: '面板空白且无内容' })] })
  assert.ok(similarity('面板空白且无内容', '面板空白且无内容') > 0.9)
  const merged = mergeFactList(a, b)
  assert.equal(merged.length, 1, '同一件事不该出两条')
  assert.equal(merged[0].status, 'single', '同一天内的合并不算跨天复现')
  assert.equal(merged[0].occurrences, 1, 'occurrences 由 timeline 推导，不累加（否则重复收口会翻倍）')
})

test('事实页与索引：关键字段都在', () => {
  const [fact] = factsOfDay({
    day: DAY,
    entries: [entry('decisions', '定日期', { expiresWhen: '用户量过千' })],
  })
  const page = renderFactPage(fact)
  assert.match(page, /^---\nid: decision-/)
  assert.ok(page.includes('**何时重评**：用户量过千'), page)
  assert.ok(page.includes('出处：`a#1`'), page)

  const index = renderMemoryIndex({ facts: [fact], generatedAt: DAY })
  assert.match(index, /# 记忆索引/)
  assert.match(index, /\[\[decision-.*\]\]/)
})

test('persistFacts：写出原子页、索引、机器可读 index', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-facts-'))
  const vaultDir = await mkdtemp(join(tmpdir(), 'chronicle-facts-vault-'))
  try {
    const incoming = factsOfDay({
      day: DAY,
      entries: [entry('conventions', '收口时间', { claim: '23:50 收口' })],
    })
    const result = await persistFacts({ dataDir, vaultDir, incoming, generatedAt: DAY })
    assert.equal(result.facts, 1)
    assert.equal(result.pages, 1)

    const indexJson = JSON.parse(await readFile(join(dataDir, 'facts', 'index.json'), 'utf8'))
    assert.equal(indexJson.facts.length, 1)
    const memory = await readFile(join(vaultDir, 'MEMORY.md'), 'utf8')
    assert.match(memory, /约定与口径/)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
    await rm(vaultDir, { recursive: true, force: true })
  }
})

test('bumpFactHits：命中一次 +1', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-hits-'))
  try {
    const incoming = factsOfDay({ day: DAY, entries: [entry('decisions', '定日期')] })
    await persistFacts({ dataDir, vaultDir: await mkdtemp(join(tmpdir(), 'hits-v-')), incoming, generatedAt: DAY })
    assert.equal(await bumpFactHits(dataDir, ['a#1']), 1)
    assert.equal(await bumpFactHits(dataDir, ['zzz#9']), 0)
    const facts = await readFacts(dataDir)
    assert.equal(facts[0].hits, 1)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('buildArcs：跨两天的事实成为线索', async () => {
  const day1 = factsOfDay({ day: '2026-11-07', entries: [entry('pitfalls', '面板 404', { ref: 'a#1' })] })
  const day2 = factsOfDay({ day: '2026-11-09', entries: [entry('pitfalls', '面板 404', { ref: 'a#9' })] })
  const facts = mergeFactList(day1, day2)
  const arcs = buildArcs(facts)
  assert.equal(arcs.length, 1)
  assert.equal(arcs[0].span, '2026-11-07 → 2026-11-09')
  assert.equal(arcs[0].timeline.length, 2)

  const single = buildArcs(factsOfDay({ day: DAY, entries: [entry('decisions', '只出现一次')] }))
  assert.equal(single.length, 0, '只出现一天的不算线索')
})

test('persistArcs：写出 index 与页面', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chronicle-arcs-'))
  const vaultDir = await mkdtemp(join(tmpdir(), 'chronicle-arcs-v-'))
  try {
    const facts = mergeFactList(
      factsOfDay({ day: '2026-11-07', entries: [entry('pitfalls', '面板 404')] }),
      factsOfDay({ day: DAY, entries: [entry('pitfalls', '面板 404')] }),
    )
    const result = await persistArcs({ dataDir, vaultDir, facts, generatedAt: DAY })
    assert.equal(result.arcs, 1)
    assert.equal((await readArcs(dataDir)).length, 1)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
    await rm(vaultDir, { recursive: true, force: true })
  }
})

test('规则导出：只收约定、带失效条件的决策、带判别信号的坑', () => {
  const facts = [
    { id: 'c1', kind: 'convention', title: '收口时间', statement: '23:50 收口', project: 'p', status: 'single', bornOn: DAY },
    { id: 'd1', kind: 'decision', title: '用不用向量库', statement: '不用', expiresWhen: '用户量过千', project: 'p', status: 'single', bornOn: DAY },
    { id: 'p1', kind: 'pitfall', title: '面板 404', detector: '面板空白且 body 为空', rationale: '路由形状错', project: 'p', status: 'single', bornOn: DAY },
    { id: 'd2', kind: 'decision', title: '没有失效条件', statement: 'x', project: 'p', status: 'single', bornOn: DAY },
    { id: 'd3', kind: 'decision', title: '已被推翻', statement: 'y', expiresWhen: 'z', project: 'p', status: 'superseded', bornOn: DAY },
  ]
  const md = renderRulesMarkdown(facts, { generatedAt: DAY })
  assert.match(md, /### 约定/)
  assert.match(md, /收口时间/)
  assert.match(md, /用户量过千 时重评/)
  assert.match(md, /看到「面板空白且 body 为空」/)
  assert.ok(!md.includes('没有失效条件'), '没失效条件的决策不导出')
  assert.ok(!md.includes('已被推翻'), '被推翻的不导出')
})

test('reviewCandidates：单次且够老、或带重评条件的才进来', () => {
  const now = new Date('2026-11-09T12:00:00').getTime()
  const facts = [
    { id: 'a', kind: 'decision', title: '老结论', statement: 'x', project: 'p', status: 'single', bornOn: '2026-10-01' },
    { id: 'b', kind: 'decision', title: '新结论', statement: 'y', project: 'p', status: 'single', bornOn: '2026-11-08' },
    { id: 'c', kind: 'decision', title: '带重评', statement: 'z', expiresWhen: '用户量过千', project: 'p', status: 'repeated', bornOn: '2026-11-08' },
    { id: 'd', kind: 'decision', title: '已推翻', statement: 'w', project: 'p', status: 'superseded', bornOn: '2026-09-01' },
  ]
  const ids = reviewCandidates(facts, { now, olderThanDays: 14 }).map((item) => item.id)
  assert.deepEqual(ids.sort(), ['a', 'c'])
})

test('mergeProjects：同项目多阶段合并成一条（修「今天 9 个项目」）', () => {
  const entries = [
    {ref:'a#1',section:'projects',title:'dsh-chronicle',claim:'P0 验收通过'},
    {ref:'a#2',section:'projects',title:'dsh-chronicle',claim:'P2 完成 LLM 打分'},
    {ref:'a#3',section:'projects',title:'WSL 迁移',claim:'迁到 D 盘'},
    {ref:'a#4',section:'decisions',title:'某决策',claim:'x'}
  ]
  const sections = [{key:'projects',title:'项目进展',refs:['a#1','a#2','a#3']}]
  const merged = mergeProjects(entries, sections)
  const projects = merged.filter((e) => e.section === 'projects')
  assert.equal(projects.length, 2, '两个项目各一条')
  assert.match(projects[0].claim, /P0 验收通过；P2 完成 LLM 打分/)
  assert.deepEqual(sections[0].refs, ['a#1','a#3'])
  assert.equal(merged.filter((e) => e.section === 'decisions').length, 1, '其它板块不受影响')
})

test('合并自愈：旧的"尚未定位"被新的已核实根因替换', () => {
  const oldFacts = [{ id: 'pitfall-x', kind: 'pitfall', title: 'x', statement: 's', rationale: '尚未定位（模型推断「瞎猜」，原文无据）', bornOn: '2026-11-08', evidence: ['a#1'], timeline: [{day:'2026-11-08',ref:'a#1'}], status: 'single' }]
  const incoming = [{ id: 'pitfall-x', kind: 'pitfall', title: 'x', statement: 's', rationale: 'webServer 未就绪', bornOn: '2026-11-09', evidence: ['a#9'], timeline: [{day:'2026-11-09',ref:'a#9'}], status: 'single' }]
  const merged = mergeFactList(oldFacts, incoming)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].rationale, 'webServer 未就绪')
  assert.equal(merged[0].status, 'repeated')
})

test('近重复合并：标题只差几个字也要合（实测 20 条里 6 条是同一件事）', () => {
  const a = factsOfDay({ day: DAY, entries: [entry('pitfalls', '插件工具表消失', { ref: 'a#1' })] })
  const b = factsOfDay({ day: DAY, entries: [entry('pitfalls', '插件工具全部消失', { ref: 'a#2' })] })
  const merged = mergeFactList(a, b)
  assert.equal(merged.length, 1, '同一件事的两种说法应合成一条')
  assert.equal(merged[0].evidence.length, 2)
})

test('规则文案：expiresWhen 已是完整句子时不再叠"时重评"', () => {
  const facts = [
    { id: 'd1', kind: 'decision', title: '甲', statement: 's1', expiresWhen: '若产品定位扩展为通用知识库时重新评估', project: 'p', status: 'single', bornOn: DAY },
    { id: 'p1', kind: 'pitfall', title: '乙', detector: '看到 X 就查 Y', rationale: 'r', project: 'p', status: 'single', bornOn: DAY },
  ]
  const md = renderRulesMarkdown(facts, { generatedAt: DAY })
  assert.ok(md.includes('扩展为通用知识库时重新评估）'), md)
  assert.ok(!md.includes('重新评估 时重评'), '不该叠加')
  // 「看到」前缀要剥掉；内层「就查」要改成「时查」，
  // 否则输出成「看到「X 就查 Y」→ 先查：乙」叠两层「查」（审计 P1-10）
  assert.ok(md.includes('看到「X 时查 Y」'), 'detector 的前缀"看到"应被剥掉、内层"就查"应改为"时查"：' + md)
  assert.ok(!md.includes('就查'), '内层"就查"不该残留：' + md)
})

test('mergeProjects 不能丢掉挂在数组上的日结与四块（0.11.0 实测回归）', () => {
  const entries = [
    { ref: 'a#1', section: 'projects', title: 'p1', claim: 'x' },
    { ref: 'a#2', section: 'projects', title: 'p1', claim: 'y' },
    { ref: 'a#3', section: 'decisions', title: 'd', claim: 'z' },
  ]
  entries.summary = '今天的日结'
  entries.sections = [{ key: 'projects', title: '项目进展', refs: ['a#1', 'a#2'] }]
  const merged = mergeProjects(entries, entries.sections)
  assert.equal(merged.summary, '今天的日结', 'filter 返回新数组时必须把 summary 带过去')
  assert.deepEqual(merged.sections, entries.sections)
})

test('sectionsFromEntries：四块元数据丢了也能从 section 标签还原', () => {
  const entries = [
    { ref: 'a#1', section: 'projects', title: 'p' },
    { ref: 'a#2', section: 'decisions', title: 'd' },
    { ref: 'a#3', section: 'pitfalls', title: 'k' },
    { ref: 'a#4', section: 'threads', title: 't', thread: '线索一' },
  ]
  const sections = sectionsFromEntries(entries)
  assert.deepEqual(sections.map((s) => s.key), ['projects', 'decisions', 'pitfalls', 'threads'])
  assert.deepEqual(sections[0].refs, ['a#1'])
  assert.equal(sections[3].threads[0].title, '线索一')
})

test('结构自检：四块丢了、缺日结、有条目没被收录，都要报出来', () => {
  const lost = structureWarnings([
    { day: '2026-11-09', entries: [{ ref: 'a#1', section: 'decisions' }], summary: '', sections: [] },
  ])
  assert.ok(lost.some((line) => line.includes('四块为空')), lost.join('|'))
  assert.ok(lost.some((line) => line.includes('缺日结')), lost.join('|'))

  const healthy = structureWarnings([
    {
      day: '2026-11-09',
      entries: [{ ref: 'a#1', section: 'decisions' }],
      summary: '今天的日结',
      sections: [{ key: 'decisions', title: '结论与决策', refs: ['a#1'] }],
    },
  ])
  assert.deepEqual(healthy, [], '结构正常时不该报警')

  const orphan = structureWarnings([
    {
      day: '2026-11-09',
      entries: [{ ref: 'a#1', section: 'decisions' }, { ref: 'a#2', section: 'pitfalls' }],
      summary: 'x',
      sections: [{ key: 'decisions', title: '结论与决策', refs: ['a#1'] }],
    },
  ])
  assert.ok(orphan.some((line) => line.includes('没被任何板块收录')), orphan.join('|'))
})

test('attachFactNodes：事实进图，并连到所属项目（节点不再只有文件名）', () => {
  const graph = { nodes: [{ name: 'index.js', kind: 'file', degree: 9 }], edges: [], total: 1 }
  const facts = [
    { title: '回捞移出启动路径', kind: 'decision', project: 'dsh-chronicle', statement: '改为后台分批', evidence: ['a#1', 'a#2'], hits: 1 },
    { title: '面板 404', kind: 'pitfall', project: 'dsh-chronicle', statement: '路由形状错', evidence: ['b#1'], hits: 0 },
    { title: '未答问题不该进图', kind: 'question', project: 'dsh-chronicle', evidence: [] },
  ]
  const merged = attachFactNodes(graph, facts)
  const names = merged.nodes.map((n) => n.name)
  assert.ok(names.includes('回捞移出启动路径'), names.join(','))
  assert.ok(names.includes('dsh-chronicle'), '项目节点应被补出来')
  assert.ok(!names.includes('未答问题不该进图'), 'questions 不进图')
  const factNode = merged.nodes.find((n) => n.name === '回捞移出启动路径')
  assert.equal(factNode.kind, 'fact')
  assert.ok(merged.edges.some((edge) => edge.a === '回捞移出启动路径' && edge.b === 'dsh-chronicle'), '事实要连到项目')
})
