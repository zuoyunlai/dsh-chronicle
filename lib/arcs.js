/**
 * 跨天线索（story arc）：同一件事被追了几天。
 *
 * 这是「按天记录 + 实体图」独有的价值：一个坑埋三天才解决，
 * 单看每天的日报只会看到三条互不相干的修复；串起来才看得出是什么在反复咬你。
 *
 * 来源不额外挖掘：事实层合并时已经记录了 timeline（每次出现是哪天、哪条证据），
 * 这里只做聚类与呈现。
 */
import { join } from 'node:path'
import { ensureDir, writeAtomic, readJson } from './store.js'

export function arcsIndexPath(dataDir) {
  return join(dataDir, 'arcs', 'index.json')
}

export function arcIdOf(fact) {
  return `arc-${fact.kind}-${fact.project}-${fact.id}`
    .toLowerCase()
    .replace(/[\s/\\]+/g, '-')
    .slice(0, 80)
}

/**
 * 从事实里抽线索：同一条事实在 ≥2 天出现过，就是一条跨天线索。
 * @param {Array} facts 事实索引
 */
export function buildArcs(facts) {
  const arcs = []
  for (const fact of facts || []) {
    const timeline = Array.isArray(fact.timeline) ? fact.timeline : []
    const days = [...new Set(timeline.map((item) => item.day).filter(Boolean))].sort()
    if (days.length < 2) continue
    arcs.push({
      id: arcIdOf(fact),
      title: fact.title,
      kind: fact.kind,
      project: fact.project,
      status: fact.status,
      days,
      span: `${days[0]} → ${days[days.length - 1]}`,
      timeline,
      factId: fact.id,
    })
  }
  return arcs.sort((a, b) => b.days.length - a.days.length || a.title.localeCompare(b.title))
}

export function renderArcPage(arc) {
  const lines = [
    '---',
    `id: ${arc.id}`,
    `kind: ${arc.kind}`,
    `project: ${arc.project}`,
    `span: ${arc.span}`,
    `status: ${arc.status}`,
    '---',
    '',
    `# ${arc.title}`,
    '',
    `跨 ${arc.days.length} 天（${arc.span}），关联事实：[[${arc.factId}]]`,
    '',
    '## 时间线',
    '',
    ...arc.timeline.map((item) => `- ${item.day} · \`${item.ref || ''}\``),
    '',
  ]
  return `${lines.join('\n')}\n`
}

export async function readArcs(dataDir) {
  const data = await readJson(arcsIndexPath(dataDir), null)
  return Array.isArray(data?.arcs) ? data.arcs : []
}

/** 写 arcs 索引 + vault 里每条线索一页。 */
export async function persistArcs({ dataDir, vaultDir, facts, generatedAt }) {
  const arcs = buildArcs(facts)
  await ensureDir(join(dataDir, 'arcs'))
  await writeAtomic(arcsIndexPath(dataDir), `${JSON.stringify({ v: 1, generatedAt, arcs }, null, 2)}\n`)

  const dir = join(vaultDir, 'arcs')
  await ensureDir(dir)
  for (const arc of arcs) await writeAtomic(join(dir, `${arc.id}.md`), renderArcPage(arc))
  return { arcs: arcs.length }
}
