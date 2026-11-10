/**
 * 纪传体（entities）：给「被用过」的实体建页。
 *
 * 为什么现在才做（2026-11-10 审计 P1-1）：
 * `entityRule` / `entityMinScore` 两个配置项声明了但**零消费者**，
 * `vault/entities/` 是建了但永远空的目录。PLAN §18 用户拍板的
 * 「被召回命中一次即建立关联」完全没实现 —— 而事实层还记着
 * 「六条产品决议锁定 … 被召回命中一次即建立关联」，等于记忆层
 * 记录了一个关于系统自身的假事实。
 *
 * 门槛（对应 entityRule 配置）：
 *   on-hit  = 被召回命中过一次（写进 hits 表后下次收口建页）
 *   score   = 分数 ≥ entityMinScore（用图度数近似）
 *   always  = 见一个建一个（会很多，不推荐）
 *
 * 页面内容：实体是什么 + 提及它的记录 + 与谁共现。这样 Obsidian
 * 的反向链接能把「编年层」和「纪传体」串起来。
 */
import { join } from 'node:path'
import { ensureDir, writeAtomic, readMaybe, readJson } from './store.js'

export function entityPageDir(vaultDir) {
  return join(vaultDir, 'entities')
}

/**
 * 实体名的稳定文件名（Obsidian 双链用 [[name]]，文件名要能对上）。
 *
 * 去掉结尾的 .md：实体名本身可能就是 CHANGELOG.md，直接拼会变成 CHANGELOG.md.md。
 * 去掉后文件是 CHANGELOG.md，[[CHANGELOG.md]] 正好解析到它。
 */
export function entitySlug(name) {
  return String(name || '')
    .trim()
    .replace(/\.md$/i, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
}

/** 读命中台账（谁被召回用过）。 */
export async function readEntityHits(dataDir) {
  const data = await readJson(join(dataDir, 'graph', 'entity-hits.json'), null)
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

/** 记一次实体的命中（由 chronicle_search 调用）。 */
export async function bumpEntityHits(dataDir, names) {
  if (!Array.isArray(names) || names.length === 0) return 0
  const hits = await readEntityHits(dataDir)
  let touched = 0
  for (const name of names) {
    const key = String(name || '').trim()
    if (!key) continue
    hits[key] = (hits[key] || 0) + 1
    touched += 1
  }
  if (touched > 0) {
    await writeAtomic(join(dataDir, 'graph', 'entity-hits.json'), `${JSON.stringify(hits, null, 2)}\n`)
  }
  return touched
}

/**
 * 判断哪些实体该建页。
 * @param {{nodes:Array, rule:string, minScore:number, hits:object}} input
 */
export function pickEntityPages({ nodes = [], rule = 'on-hit', minScore = 4, hits = {} }) {
  const picked = []
  for (const node of nodes) {
    const name = String(node.name || '').trim()
    if (!name) continue
    if (node.kind === 'fact') continue // 事实有自己的页（facts/）
    const hitCount = Number(hits[name]) || 0
    if (rule === 'always') {
      picked.push(node)
      continue
    }
    if (rule === 'score') {
      if ((node.degree || 0) >= minScore) picked.push(node)
      continue
    }
    // 默认 on-hit：被召回用过才建页
    if (hitCount > 0) picked.push(node)
  }
  return picked
}

/** 实体页的 Markdown。 */
export function renderEntityPage({ node, entries, neighbors, hits }) {
  const title = String(node.name || '')
  const kindLabel = node.kind === 'file' ? '文件' : '概念'
  const lines = [
    '---',
    `entity: ${title}`,
    `kind: ${node.kind || 'file'}`,
    `degree: ${node.degree || 0}`,
    `hits: ${hits || 0}`,
    '---',
    '',
    `# ${title}`,
    '',
    `${kindLabel} · 图中度数 ${node.degree || 0} · 被召回 ${hits || 0} 次`,
    '',
  ]
  if (neighbors && neighbors.length > 0) {
    lines.push('## 一起出现', '')
    for (const neighbor of neighbors.slice(0, 12)) {
      lines.push(`- [[${entitySlug(neighbor.name)}]] · 权重 ${neighbor.weight}`)
    }
    lines.push('')
  }
  if (entries && entries.length > 0) {
    lines.push('## 提到它的记录', '')
    for (const entry of entries.slice(0, 20)) {
      lines.push(`- ★${entry.importance || 1} ${entry.title} · \`${entry.ref}\``)
    }
    lines.push('')
  } else {
    lines.push('_还没有记录提到它。_', '')
  }
  return `${lines.join('\n')}\n`
}

/**
 * 落地：给该建页的实体写 vault/entities/<name>.md。
 *
 * 注意（2026-11-10 真实 bug）：这个函数**自己从磁盘读图**，不接受调用方传 graph。
 * 原因：`mergeGraph()` 返回的是 `{days, entities: 数字, edges: 数字}` 这样的**统计摘要**，
 * 不是节点列表。调用方按 `graph.nodes` 取会永远拿到空数组 ⇒ 实体页一个都不建；
 * 而单元测试如果自己构造 `{nodes:[...]}` 就测不出来 —— 恰好就是发生过的情形。
 */
export async function persistEntityPages({ dataDir, vaultDir, rule = 'on-hit', minScore = 4, entries }) {
  const hits = await readEntityHits(dataDir)

  // 直接从产物读，不依赖调用方传的形状
  const graphData = await readJson(join(dataDir, 'graph', 'entities.json'), null)
  const nodes = Array.isArray(graphData?.entities) ? graphData.entities : []

  // 边在 edges.jsonl（一行一条）
  const edges = []
  const edgeText = await readMaybe(join(dataDir, 'graph', 'edges.jsonl'))
  if (edgeText) {
    for (const line of edgeText.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const edge = JSON.parse(trimmed)
        if (edge && edge.a && edge.b) edges.push(edge)
      } catch {
        /* 坏行跳过 */
      }
    }
  }

  const picked = pickEntityPages({ nodes, rule, minScore, hits })
  if (picked.length === 0) return { pages: 0, picked: 0, nodes: nodes.length }

  const dir = entityPageDir(vaultDir)
  await ensureDir(dir)

  // 邻接：谁和它一起出现
  const neighborMap = new Map()
  for (const edge of edges) {
    for (const [from, to] of [[edge.a, edge.b], [edge.b, edge.a]]) {
      const key = String(from || '').toLowerCase()
      if (!neighborMap.has(key)) neighborMap.set(key, [])
      neighborMap.get(key).push({ name: to, weight: edge.weight || 1 })
    }
  }

  let pages = 0
  for (const node of picked) {
    const key = String(node.name || '').toLowerCase()
    const related = (entries || [])
      .filter((entry) => {
        const names = [...(entry.entities || []), ...(entry.files || []).map((f) => String(f).split(/[\\/]/).pop())]
        return names.some((name) => String(name).toLowerCase() === key)
      })
      .sort((a, b) => (b.importance || 1) - (a.importance || 1))
    const neighbors = (neighborMap.get(key) || []).sort((a, b) => b.weight - a.weight)
    const markdown = renderEntityPage({ node, entries: related, neighbors, hits: hits[node.name] || 0 })
    await writeAtomic(join(dir, entitySlug(node.name) + '.md'), markdown)
    pages += 1
  }
  return { pages, picked: picked.length, nodes: nodes.length }
}
