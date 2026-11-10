/**
 * P3 检索与召回。
 *
 * 刻意不做的事：不装分词库、不做向量检索。
 *   - 中文按 **2-gram** 切片（不依赖 jieba，召回率对短查询够用）
 *   - 排序靠「实体精确命中 + 图 2 跳扩散 + 重要度 + 时间衰减」
 *   - 常驻注入只有一行，正文永远靠工具取 —— 这是不和 mnemon 抢预算的唯一办法
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { readMaybe } from './store.js'
import { whenClause } from './rules.js'

/** 中文 2-gram + 拉丁词。查询与文档走同一套切法，才能对上。 */
export function tokenize(text) {
  const out = new Set()
  const source = String(text || '').toLowerCase()
  if (!source) return out
  for (const match of source.matchAll(/[a-z0-9][a-z0-9_.-]{1,}/g)) out.add(match[0])
  for (const run of source.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) out.add(run)
    for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2))
  }
  return out
}

/** 读合并后的边（jsonl）。 */
export async function loadEdges(dataDir) {
  const text = await readMaybe(join(dataDir, 'graph', 'edges.jsonl'))
  if (!text) return []
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

/** 一条记录 → 可检索词集合。 */
export function entryTokensLegacy(entry) {
  const text = [entry.title, entry.claim, entry.basis, entry.kind, ...(entry.entities || [])].join(' ')
  const set = tokenize(text)
  for (const entity of entry.entities || []) set.add(`entity:${String(entity).toLowerCase()}`)
  return set
}

/** 读全部周镜像（close 时写的机器可读副本）。 */
/**
 * 读全部周镜像。
 *
 * 增量缓存（审计 P2-4）：每次 refreshCorpus 都全量重读太浪费——
 * 52 周后就是 52 个文件 × 每 5 分钟一次。这里按 `mtime+size` 判断文件变没变，
 * 没变的直接用上次解析好的结果。
 */
const mirrorCache = new Map() // fileName -> { stamp, entries }

export async function loadEntries(dataDir) {
  const dir = join(dataDir, 'index')
  let names = []
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
  } catch {
    mirrorCache.clear()
    return []
  }

  const { stat } = await import('node:fs/promises')
  const entries = []
  const alive = new Set(names)

  for (const name of names) {
    const path = join(dir, name)
    let stamp = ''
    try {
      const info = await stat(path)
      stamp = `${info.mtimeMs}:${info.size}`
    } catch {
      continue
    }
    const cached = mirrorCache.get(name)
    if (cached && cached.stamp === stamp) {
      entries.push(...cached.entries)
      continue
    }
    const text = await readMaybe(path)
    if (!text) continue
    try {
      const data = JSON.parse(text)
      const summaries = data.summaries || {}
      const parsed = (data.entries || []).map((entry) => ({
        ...entry,
        week: data.week,
        // 日结随条目带出来：面板顶部那段就是它，不必再解析 Markdown
        daySummary: summaries[entry.day] || '',
      }))
      mirrorCache.set(name, { stamp, entries: parsed })
      entries.push(...parsed)
    } catch {
      /* 坏镜像跳过，不拖垮检索 */
    }
  }

  // 清掉已经被删掉的周文件
  for (const key of [...mirrorCache.keys()]) {
    if (!alive.has(key)) mirrorCache.delete(key)
  }
  return entries
}

/** 测试与手动刷新用：丢掉镜像缓存。 */
export function clearMirrorCache() {
  mirrorCache.clear()
}

/** 无向邻接表：实体名（小写） → [{name, weight}]。 */
export function buildAdjacency(edges) {
  const adj = new Map()
  const push = (from, to, weight) => {
    if (!adj.has(from)) adj.set(from, [])
    adj.get(from).push({ name: to, weight })
  }
  for (const edge of edges || []) {
    const a = String(edge.a).toLowerCase()
    const b = String(edge.b).toLowerCase()
    push(a, edge.b, edge.weight || 1)
    push(b, edge.a, edge.weight || 1)
  }
  return adj
}

/** 从种子实体扩散 2 跳；返回 小写名 → 权重。 */
export function expandHops(adj, seeds, depth = 2) {
  const weight = new Map()
  let frontier = new Map(seeds.map((name) => [String(name).toLowerCase(), 1]))
  for (let d = 0; d < depth; d += 1) {
    const next = new Map()
    for (const [name, w] of frontier) {
      for (const neighbor of adj.get(name) || []) {
        const key = String(neighbor.name).toLowerCase()
        const value = w * 0.6 * (neighbor.weight > 1 ? 1 + Math.log(neighbor.weight) : 1)
        next.set(key, Math.max(next.get(key) || 0, value))
      }
    }
    for (const [name, w] of next) weight.set(name, Math.max(weight.get(name) || 0, w))
    frontier = next
  }
  return weight
}

/** 时间衰减：60 天半衰期。 */
export function recency(entryTs, now) {
  const ms = Date.parse(entryTs)
  if (!Number.isFinite(ms)) return 0.5
  const days = Math.max(0, (now - ms) / 86400000)
  return Math.exp((-days * Math.LN2) / 60)
}

/**
 * 检索。
 * @param {Array} entries
 * @param {string} query
 * @param {{edges?:Array, now?:number, limit?:number}} options
 */
/**
 * 条目的检索用词：标题 + 结论 + 依据 + **实体 + 文件名**。
 *
 * 关键修复（2026-11-10 审计）：原来只用 `entry.entities`，
 * 而建图用的是 `entry.files` —— 两套定义导致 entityHits / hopHit **恒为 0**，
 * 打分公式里权重最大的两项从未生效。实测「index.js」「上次那个坑」零命中。
 * 现在两侧统一：文件名的 basename 也进检索词。
 */
export function entryTokens(entry) {
  const set = new Set()
  const add = (text) => {
    for (const token of tokenize(text)) set.add(token)
  }
  add(entry.title)
  add(entry.claim)
  add(entry.basis)
  for (const entity of entry.entities || []) add(entity)
  for (const file of entry.files || []) add(String(file).split(/[\\/]/).pop())
  return set
}

/** 条目的实体集合（检索与建图共用一份）。 */
export function entryEntities(entry) {
  const out = []
  for (const entity of entry.entities || []) out.push(String(entity))
  for (const file of entry.files || []) out.push(String(file).split(/[\\/]/).pop())
  return out
}

/** 高频词表：2-gram 里这些词几乎每条都有，出现不说明相关性。 */
const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '把', '被', '这', '那', '个', '我', '你',
  '他', '它', '们', '有', '无', '不', '也', '就', '都', '还', '再', '但', '而', '并',
  '一个', '这个', '那个', '可以', '需要', '已经', '还是', '因为', '所以', '如果',
  '然后', '这样', '什么', '怎么', '为什么', '就是', '进行', '通过', '使用', '开始',
  '完成', '发现', '出现', '导致', '应该', '可能', '没有', '现在', '之后', '之前',
])

/**
 * IDF：稀有词权重高，高频词几乎不计分。
 * 不用向量库，一张停用词表 + 词频统计就够。
 */
export function buildIdf(entries) {
  const df = new Map()
  let total = 0
  for (const entry of entries) {
    total += 1
    for (const token of entryTokens(entry)) df.set(token, (df.get(token) || 0) + 1)
  }
  const idf = new Map()
  for (const [token, count] of df) {
    if (STOPWORDS.has(token)) {
      idf.set(token, 0)
      continue
    }
    idf.set(token, Math.log((total + 1) / (count + 0.5)))
  }
  return idf
}

export function searchEntries(entries, query, options = {}) {
  const { edges = [], now = Date.now(), limit = 10, idf } = options
  const tokens = tokenize(query)
  if (tokens.size === 0) return []

  const adj = buildAdjacency(edges)
  const queryLower = String(query).toLowerCase()
  const weights = idf || buildIdf(entries)

  // 查询里直接点名的实体 → 种子（用完整实体名匹配，不用 token 前缀，避免「门」命中「门禁」）
  const seeds = []
  for (const entry of entries) {
    for (const entity of entryEntities(entry)) {
      const name = String(entity).toLowerCase()
      if (name.length >= 2 && queryLower.includes(name)) seeds.push(name)
    }
  }
  const hopWeights = expandHops(adj, [...new Set(seeds)], 2)

  const results = []
  for (const entry of entries) {
    const set = entryTokens(entry)
    let lexical = 0
    let entityHits = 0
    for (const token of tokens) {
      if (!set.has(token)) continue
      lexical += weights.get(token) || 0 // IDF 加权
    }
    for (const entity of entryEntities(entry)) {
      const name = String(entity).toLowerCase()
      if (name && (tokens.has(name) || queryLower.includes(name))) entityHits += 1
    }
    let hopHit = 0
    for (const entity of entryEntities(entry)) {
      const w = hopWeights.get(String(entity).toLowerCase()) || 0
      if (w > hopHit) hopHit = w
    }
    if (lexical === 0 && entityHits === 0 && hopHit === 0) continue

    const importance = Math.min(5, Math.max(1, Number(entry.importance) || 1)) / 5
    // 权重重排（2026-11-10 审计）：原来 recency(0.8) 是 lexical(0.08~0.16) 的 10 倍，
    // 导致「旧的但精确的记录」必然输给「新的但无关的记录」——与跨会话记忆的目标相反。
    // 现在 lexical（IDF 加权）占主导，recency 只作微调，entityHits 封顶防刷分。
    const lexicalScore = Math.min(3, lexical / 3)
    const score =
      2 * Math.min(entityHits, 3) +
      1.5 * hopHit +
      2.0 * lexicalScore +
      0.6 * importance +
      0.3 * recency(entry.ts, now)
    results.push({
      ...entry,
      score: Number(score.toFixed(3)),
      lexical: Number(lexical.toFixed(2)),
      entityHits,
      hopHit: Number(hopHit.toFixed(2)),
    })
  }

  results.sort((a, b) => b.score - a.score || (a.ts < b.ts ? 1 : -1))
  if (results.length > 0) return results.slice(0, limit)

  // 回退：自然语言问法切不出有效的 2-gram（「上次那个坑」→ 上个/个坑，记录里没有）。
  // 这类查询退化成单字重叠，至少能捞回相关条目，而不是 0 命中。
  const single = new Set()
  for (const match of String(query || '').matchAll(/[\u4e00-\u9fff]/g)) single.add(match[0])
  if (single.size === 0) return []
  const fallback = []
  for (const entry of entries) {
    const text = [entry.title, entry.claim, entry.basis].filter(Boolean).join(' ')
    let hits = 0
    for (const ch of single) if (text.includes(ch)) hits += 1
    if (hits === 0) continue
    const importance = Math.min(5, Math.max(1, Number(entry.importance) || 1)) / 5
    fallback.push({
      ...entry,
      score: Number((hits / single.size + 0.4 * importance).toFixed(3)),
      lexical: hits,
      entityHits: 0,
      hopHit: 0,
      fallback: true,
    })
  }
  fallback.sort((a, b) => b.score - a.score || (a.ts < b.ts ? 1 : -1))
  return fallback.slice(0, limit)
}

/**
 * 常驻注入的那一行。没有当天记录就返回空串（连这一行都不出现）。
 * @param {{entries:Array, now?:number, budgetChars?:number}} input
 */
/**
 * 常驻注入的一行。
 *
 * 关键设计（2026-11-10 审计）：原来只输出**编年层的计数**，
 * 新会话读到「今天 2 个项目 · 4 条决策 · 6 个坑」并不能想起任何具体的事——
 * 那是流水账的元数据，不是记忆。
 *
 * 现在改成：**一条约定 + 一个待避的坑**（都是当天 facts 里挑的）。
 * 仍是一行、仍 ≤80 token，但注入的是**能改变行为的内容**。
 *
 * @param {{entries:Array, facts?:Array, now?:number, budgetChars?:number}} input
 */
export function buildInjectLine({ entries, facts = [], now = Date.now(), budgetChars = 160 }) {
  const d = new Date(now)
  const localDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  const today = (facts || []).filter((fact) => fact.scope !== 'tool-self' && fact.status !== 'superseded')
  const convention = today.find((fact) => fact.kind === 'convention' && fact.statement)
  const pitfall = today.find((fact) => fact.kind === 'pitfall' && fact.detector)
  const decision = today.find((fact) => fact.kind === 'decision' && fact.expiresWhen && fact.expiresWhen !== '未设定')

  const parts = []
  if (convention) parts.push(`${convention.title}：${trim(convention.statement, 34)}`)
  if (decision) parts.push(`${decision.title}（${trim(whenClause(decision.expiresWhen), 26)}）`)
  if (pitfall) parts.push(`遇到「${trim(pitfall.detector, 26)}」先查：${pitfall.title}`)

  if (parts.length > 0) {
    const line = `[chronicle] ${parts.join('；')}`
    return line.length > budgetChars ? `${line.slice(0, budgetChars - 1)}…` : line
  }

  // 没有事实时退回编年层计数（总比什么都不给强）
  const pool = entries.filter((entry) => String(entry.day) === localDay)
  if (pool.length === 0) return ''
  const counts = { projects: 0, decisions: 0, pitfalls: 0 }
  for (const entry of pool) {
    if (entry.section in counts) counts[entry.section] += 1
  }
  const brief = []
  if (counts.projects > 0) brief.push(`${counts.projects} 个项目`)
  if (counts.decisions > 0) brief.push(`${counts.decisions} 条决策`)
  if (counts.pitfalls > 0) brief.push(`${counts.pitfalls} 个坑`)
  const top = [...pool].sort((a, b) => (b.importance || 1) - (a.importance || 1))[0]
  const head = brief.length > 0 ? `今天 ${brief.join(' · ')}` : `今天 ${pool.length} 条`
  const line = `[chronicle] ${head} · 最高分：${top.title}（${String(top.ts || '').slice(5, 10)} ★${top.importance}）`
  return line.length > budgetChars ? `${line.slice(0, budgetChars - 1)}…` : line
}

function trim(text, max) {
  const value = String(text || '').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
