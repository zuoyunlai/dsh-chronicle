/**
 * 事实的推翻（supersede）：记忆系统区别于日志系统的核心能力。
 *
 * 为什么必须有（2026-11-10 审计 P1-2）：
 * 一条约定被推翻后，旧事实若永远有效，规则导出还会把它当现行规则推给下一次对话，
 * **系统必然在几个月后开始误导人**。
 *
 * 现状：`supersededBy` 字段声明了但从没有写入点，`status: 'superseded'` 的
 * 分支全是死代码——「事实可修订」这条设计原则名不副实。
 *
 * 本模块提供**机械可判**的冲突检测：不依赖模型，靠标题/实体的重叠 + 语义相反词。
 * 判不准就不判（宁可漏，不误伤）——把「推翻」做成自动的，必须极保守。
 */

/** 语义相反词：出现这些词，说明两条结论的方向相反。 */
const OPPOSITE_MARKERS = [
  ['是', '不是'],
  ['用', '不用'],
  ['开', '关'],
  ['启用', '停用'],
  ['保留', '删除'],
  ['增加', '移除'],
  ['改为', '不改'],
]

/** 分词后的实体集合（复用 recall 的切法，避免两套定义）。 */
function tokens(text) {
  const out = new Set()
  const source = String(text || '').toLowerCase()
  for (const match of source.matchAll(/[a-z0-9][a-z0-9_.-]{1,}/g)) out.add(match[0])
  for (const run of source.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) out.add(run)
    for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2))
  }
  return out
}

/** 两条事实的"同一件事"程度：标题/实体重叠。 */
export function overlapRatio(a, b) {
  const left = tokens(a.title)
  const right = tokens(b.title)
  if (left.size === 0 || right.size === 0) return 0
  let hit = 0
  for (const token of left) if (right.has(token)) hit += 1
  return hit / Math.max(left.size, right.size)
}

/** 是否出现语义相反的措辞。 */
export function hasOppositeMarkers(a, b) {
  const left = String(a.statement || a.title || '')
  const right = String(b.statement || b.title || '')
  for (const [pos, neg] of OPPOSITE_MARKERS) {
    const leftHasPos = left.includes(pos)
    const leftHasNeg = left.includes(neg)
    const rightHasPos = right.includes(pos)
    const rightHasNeg = right.includes(neg)
    // 一条说"用"，另一条说"不用" ⇒ 方向相反
    if (leftHasPos && rightHasNeg) return true
    if (leftHasNeg && rightHasPos) return true
  }
  return false
}

/**
 * 检测新事实是否推翻了旧事实。
 *
 * 判据（全部满足才判推翻，保守）：
 * ① 同 kind
 * ② 标题 token 重叠 ≥ 0.5（同一件事）
 * ③ 语义相反词出现
 * ④ 新事实的日期比旧事实晚
 *
 * @returns {Array<{oldId:string,newId:string}>}
 */
export function detectSupersedes(incoming, existing) {
  const out = []
  for (const fresh of incoming || []) {
    if (fresh.scope === 'tool-self') continue
    for (const old of existing || []) {
      if (old.id === fresh.id) continue
      if (old.kind !== fresh.kind) continue
      if (old.status === 'superseded') continue
      if (String(old.bornOn) >= String(fresh.bornOn)) continue
      if (overlapRatio(old, fresh) < 0.5) continue
      if (!hasOppositeMarkers(old, fresh)) continue
      out.push({ oldId: old.id, newId: fresh.id })
      break // 一条新事实最多推翻一条旧事实
    }
  }
  return out
}

/** 把推翻关系写进事实集合：旧事实置 superseded，新事实记 supersededBy。 */
export function applySupersedes(facts, pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return facts
  const byId = new Map(facts.map((fact) => [fact.id, fact]))
  for (const pair of pairs) {
    const oldFact = byId.get(pair.oldId)
    if (!oldFact) continue
    oldFact.status = 'superseded'
    oldFact.supersededBy = pair.newId
    const newFact = byId.get(pair.newId)
    if (newFact) newFact.supersedes = [...new Set([...(newFact.supersedes || []), pair.oldId])]
  }
  return facts
}
