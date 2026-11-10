/**
 * 图：实体与共现边。
 *
 * 设计取舍：
 *   - **按天存快照，再整体合并**。收口同一天两次不会把权重加两遍（幂等），
 *     也不需要在 edges.jsonl 上做增量去重。快照是幂等的真源。
 *   - 边只做 `cooccur`（同一轮里同时出现）。因果/取代这类语义边留给事实层（P5），
 *     在这里硬抽会一半是错的。
 *   - 实体来源：LLM 打分模式用模型给的专有名词；规则模式退回文件基名，
 *     宁少勿滥——空实体页比错实体页更糟。
 */
import { join } from 'node:path'
import { ensureDir, writeAtomic, readJson, readMaybe } from './store.js'

function basename(path) {
  return String(path || '').split(/[\\/]/).pop() || ''
}

/**
 * 一轮里出现的实体。
 * 带来源：`llm`（模型给的专有名词）> `file`（文件基名兜底）。
 * 规则模式下这张图本质是「文件共变图」——有用，但要知道它是什么。
 */
export function entitiesOfEntry(entry) {
  const fromLlm = (Array.isArray(entry.entities) ? entry.entities : []).map((name) => ({ name, kind: 'llm' }))
  const fromFiles = (Array.isArray(entry.files) ? entry.files : []).map((path) => ({ name: basename(path), kind: 'file' }))
  const out = []
  const seen = new Set()
  for (const item of [...fromLlm, ...fromFiles]) {
    const value = String(item.name || '').trim()
    if (!value || value.length > 40) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name: value, kind: item.kind })
  }
  return out.slice(0, 8)
}

/**
 * 一天 → 图快照。
 * @param {{day:string, entries:Array}} input
 */
export function buildDayGraph({ day, entries }) {
  const nodes = new Map() // 小写名 → {name, kind, mentions:Set}
  const edges = new Map() // "a\u0000b" → {a,b,weight,evidence:Set}

  for (const entry of entries) {
    const entities = entitiesOfEntry(entry)
    for (const entity of entities) {
      const key = entity.name.toLowerCase()
      if (!nodes.has(key)) nodes.set(key, { name: entity.name, kind: entity.kind, mentions: new Set() })
      const node = nodes.get(key)
      // LLM 给的专有名词优先于文件基名
      if (entity.kind === 'llm') node.kind = 'llm'
      node.mentions.add(entry.ref)
    }
    const names = entities.map((entity) => entity.name)
    // 同一轮里的两两共现（组合数，实体数上限 8 ⇒ 最多 28 条）
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const pair = [names[i], names[j]].sort((a, b) => a.localeCompare(b))
        const key = `${pair[0].toLowerCase()}\u0000${pair[1].toLowerCase()}`
        if (!edges.has(key)) edges.set(key, { a: pair[0], b: pair[1], weight: 0, evidence: new Set() })
        const edge = edges.get(key)
        edge.weight += 1
        edge.evidence.add(entry.ref)
      }
    }
  }

  return {
    v: 1,
    day,
    entities: [...nodes.values()].map((node) => ({
      name: node.name,
      kind: node.kind,
      mentions: [...node.mentions].sort(),
    })),
    edges: [...edges.values()].map((edge) => ({
      a: edge.a,
      b: edge.b,
      type: 'cooccur',
      weight: edge.weight,
      evidence: [...edge.evidence].sort(),
    })),
  }
}

export function graphDir(dataDir) {
  return join(dataDir, 'graph')
}

export function dayGraphPath(dataDir, day) {
  return join(graphDir(dataDir), 'days', `${day}.json`)
}

/** 写某天的图快照（幂等：同一天覆盖）。 */
export async function writeDayGraph(dataDir, snapshot) {
  await ensureDir(join(graphDir(dataDir), 'days'))
  await writeAtomic(dayGraphPath(dataDir, snapshot.day), `${JSON.stringify(snapshot, null, 2)}\n`)
  return dayGraphPath(dataDir, snapshot.day)
}

/** 读某天的图快照。 */
export async function readDayGraph(dataDir, day) {
  return readJson(dayGraphPath(dataDir, day), null)
}

/**
 * 合并所有天快照 → entities.json 与 edges.jsonl。
 * 只读快照，不读事件，所以重跑代价很低。
 */
/**
 * 把事实（决策 / 坑 / 约定 / 被否方案）挂进图。
 *
 * 为什么需要：实体图里几乎全是文件名（index.js、llm.js…），
 * 那是"我改了哪些文件"，不是"我在想什么"。真正有记忆价值的是
 * 「回捞移出启动路径」「面板 404」这类条目，它们该成为图上的节点，
 * 并连到所属项目上。
 */
export function attachFactNodes(graph, facts, { limit = 40 } = {}) {
  const nodes = [...(graph?.nodes || [])]
  const edges = [...(graph?.edges || [])]
  const byName = new Map(nodes.map((node) => [String(node.name).toLowerCase(), node]))

  const picked = (facts || [])
    .filter((fact) => ['decision', 'pitfall', 'convention', 'rejected'].includes(fact.kind))
    .sort((a, b) => (b.hits || 0) - (a.hits || 0))
    .slice(0, limit)

  for (const fact of picked) {
    const key = String(fact.title || '').toLowerCase()
    if (!key || byName.has(key)) continue
    const node = {
      name: fact.title,
      kind: 'fact',
      degree: 1 + (fact.evidence || []).length,
      mentions: (fact.evidence || []).length,
      factKind: fact.kind,
      statement: fact.statement || '',
    }
    nodes.push(node)
    byName.set(key, node)

    // 连到项目：项目节点存在就连它，不存在就补一个
    const project = String(fact.project || '').trim()
    if (!project || project === 'unknown') continue
    const projectKey = project.toLowerCase()
    if (!byName.has(projectKey)) {
      const projectNode = { name: project, kind: 'llm', degree: 1, mentions: 1 }
      nodes.push(projectNode)
      byName.set(projectKey, projectNode)
    }
    edges.push({ a: fact.title, b: project, weight: 2 })
  }
  return { nodes, edges, total: (graph?.total || 0) + picked.length }
}

/**
 * 读完整图（给可视化用）：按度数取前 N 个节点，连同它们之间的边。
 * 度数 = 这个实体被多少次写进日报 / 跟多少个别的实体同时出现——越大越是枢纽。
 */
export async function loadGraph(dataDir, { limit = 80 } = {}) {
  const entitiesText = await readMaybe(join(graphDir(dataDir), 'entities.json'))
  const edgesText = await readMaybe(join(graphDir(dataDir), 'edges.jsonl'))
  const nodes = []
  if (entitiesText) {
    try {
      const snapshot = JSON.parse(entitiesText)
      for (const entity of snapshot.entities || []) {
        nodes.push({
          name: entity.name,
          kind: entity.kind || 'file',
          mentions: (entity.mentions || []).length,
          days: (entity.days || []).length,
        })
      }
    } catch {
      /* 坏快照跳过 */
    }
  }
  const edges = []
  if (edgesText) {
    for (const line of edgesText.split('\n')) {
      if (!line.trim()) continue
      try {
        const edge = JSON.parse(line)
        if (edge && edge.a && edge.b) edges.push({ a: edge.a, b: edge.b, weight: Number(edge.weight) || 1 })
      } catch {
        /* 坏行跳过 */
      }
    }
  }

  const degree = new Map(nodes.map((node) => [node.name.toLowerCase(), 0]))
  for (const edge of edges) {
    for (const key of [edge.a.toLowerCase(), edge.b.toLowerCase()]) {
      if (degree.has(key)) degree.set(key, degree.get(key) + 1)
    }
  }
  for (const node of nodes) node.degree = degree.get(node.name.toLowerCase()) || 0
  nodes.sort((x, y) => y.degree - x.degree || y.mentions - x.mentions || x.name.localeCompare(y.name))
  const kept = nodes.slice(0, Math.max(1, Math.min(400, limit)))
  const alive = new Set(kept.map((node) => node.name.toLowerCase()))
  return {
    nodes: kept,
    edges: edges.filter((edge) => alive.has(edge.a.toLowerCase()) && alive.has(edge.b.toLowerCase())),
    total: nodes.length,
  }
}
/** 把每天的快照合并成一张全图（幂等：重算结果一致）。 */
export async function mergeGraph(dataDir) {
  const dir = join(graphDir(dataDir), 'days')
  let names = []
  try {
    const { readdir } = await import('node:fs/promises')
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
  } catch {
    names = []
  }

  const nodes = new Map()
  const edges = new Map()

  for (const name of names) {
    const text = await readMaybe(join(dir, name))
    if (!text) continue
    let snap
    try {
      snap = JSON.parse(text)
    } catch {
      continue
    }
    for (const entity of snap.entities || []) {
      const key = String(entity.name).toLowerCase()
      if (!nodes.has(key)) nodes.set(key, { name: entity.name, kind: entity.kind || 'file', days: new Set(), mentions: new Set() })
      const node = nodes.get(key)
      if (entity.kind === 'llm') node.kind = 'llm'
      node.days.add(snap.day)
      for (const ref of entity.mentions || []) node.mentions.add(ref)
    }
    for (const edge of snap.edges || []) {
      const pair = [edge.a, edge.b].sort((x, y) => x.localeCompare(y))
      const key = `${pair[0].toLowerCase()}\u0000${pair[1].toLowerCase()}`
      if (!edges.has(key)) edges.set(key, { a: pair[0], b: pair[1], type: edge.type || 'cooccur', weight: 0, evidence: new Set() })
      const merged = edges.get(key)
      merged.weight += edge.weight || 1
      for (const ref of edge.evidence || []) merged.evidence.add(ref)
    }
  }

  const entitiesOut = [...nodes.values()]
    .map((node) => ({
      name: node.name,
      kind: node.kind,
      days: [...node.days].sort(),
      mentions: [...node.mentions].sort(),
      degree: 0,
    }))
    .sort((a, b) => b.mentions.length - a.mentions.length || a.name.localeCompare(b.name))

  const edgesOut = [...edges.values()]
    .map((edge) => ({ a: edge.a, b: edge.b, type: edge.type, weight: edge.weight, evidence: [...edge.evidence].sort() }))
    .sort((a, b) => b.weight - a.weight || a.a.localeCompare(b.a))

  // 度数回填，供 P3 的相关性打分直接用
  const degree = new Map()
  for (const edge of edgesOut) {
    degree.set(edge.a.toLowerCase(), (degree.get(edge.a.toLowerCase()) || 0) + edge.weight)
    degree.set(edge.b.toLowerCase(), (degree.get(edge.b.toLowerCase()) || 0) + edge.weight)
  }
  for (const entity of entitiesOut) entity.degree = degree.get(entity.name.toLowerCase()) || 0

  await ensureDir(graphDir(dataDir))
  await writeAtomic(
    join(graphDir(dataDir), 'entities.json'),
    `${JSON.stringify({ v: 1, days: names.length, entities: entitiesOut }, null, 2)}\n`,
  )
  await writeAtomic(
    join(graphDir(dataDir), 'edges.jsonl'),
    edgesOut.map((edge) => JSON.stringify(edge)).join('\n') + (edgesOut.length ? '\n' : ''),
  )

  return { days: names.length, entities: entitiesOut.length, edges: edgesOut.length }
}

/** P3 会用：某个实体的邻居（1 跳，按权重降序）。 */
export async function neighborsOf(dataDir, name) {
  const target = String(name || '').toLowerCase()
  const text = await readMaybe(join(graphDir(dataDir), 'edges.jsonl'))
  if (!text) return []
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let edge
    try {
      edge = JSON.parse(line)
    } catch {
      continue
    }
    if (edge.a.toLowerCase() === target) out.push({ name: edge.b, weight: edge.weight, type: edge.type })
    else if (edge.b.toLowerCase() === target) out.push({ name: edge.a, weight: edge.weight, type: edge.type })
  }
  return out.sort((x, y) => y.weight - x.weight)
}
