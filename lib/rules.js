/**
 * P6 · 规则导出：把「约定」「决策的失效条件」「坑的判别信号」渲染成可执行的规则。
 *
 * 这是整套东西里唯一「有用性可证」的一步：日报没人读也就算了，
 * 但能拦住下一次踩坑的检查项才算数。
 *
 * 只导出**结构性**内容，不导出流水：没有 detector / expiresWhen 的条目不进来。
 */
import { join } from 'node:path'
import { writeAtomic, readMaybe } from './store.js'

const KIND_LABEL = {
  convention: '约定与口径',
  decision: '决策（附失效条件）',
  pitfall: '坑的判别信号',
}

/** 「未设定」这类占位不算有效值。 */
export function hasRealValue(text) {
  const value = String(text || '').trim()
  if (!value) return false
  return !/^(未设定|暂无|无|N\/A|n\/a|null|-|—)$/i.test(value)
}

/**
 * expiresWhen 常被模型写成完整句子（"若 X 变化时重新评估"），
 * 这种就原样用；否则补一个"时重评"。之前两种情况都补，产出"…时重新评估 时重评"。
 */
export function whenClause(text) {
  const value = String(text || '').trim()
  if (!value) return ''
  // 句子里任何位置出现「评估/重评」就视为完整句子，不再补「时重评」
  // （模型会写「重新评估」「再评估」「重评」三种，漏一种就叠词）
  if (/(评估|重评)/.test(value)) return value
  return value.replace(/时$/, '') + ' 时重评'
}

/**
 * detector 常被模型写成"看到 X 就查 Y"，拼进"看到「…」"会叠两层，
 * 这里把内层的"看到/就查/则查"一并剥掉。
 */
function cleanDetector(text) {
  return String(text || '')
    .replace(/^看到[「""]?/, '')
    .replace(/[」""]$/, '')
    .replace(/^就查/, '')
    .replace(/^则查/, '')
    .replace(/^应该查/, '')
    .replace(/[。.]$/, '')
    .trim()
}

/** 生成一段 Markdown 规则，可直接粘进 AGENTS.md 或技能文件。 */
export function renderRulesMarkdown(facts, { generatedAt, limit = 40 } = {}) {
  const picked = []
  for (const fact of facts || []) {
    if (fact.status === 'superseded') continue
    // 只导出「工作记忆」：工具自身的开发笔记不进规则
    // （否则贴进 AGENTS.md 的只会告诉未来的 agent 本插件的踩坑史）
    if (fact.scope === 'tool-self') continue
    // 未核实的根因不写进规则：规则是要执行的，写个猜测进去比留空更糟
    const rationale = String(fact.rationale || '')
    const cause = /尚未定位/.test(rationale) ? '根因未定位（原文无据）' : rationale
    if (fact.kind === 'convention') {
      picked.push({ order: 1, text: `- **${fact.title}**：${fact.statement}` })
    } else if (fact.kind === 'rejected') {
      // 被否方案是唯一能真正防「以后又提一遍同一个被否方案」的地方（审计 P1-7）
      picked.push({ order: 2, text: `- **不要再提 ${fact.title}**：${fact.statement || ''}（${fact.rationale || '之前已否掉'}）` })
    } else if (fact.kind === 'decision' && hasRealValue(fact.expiresWhen)) {
      picked.push({ order: 3, text: `- **${fact.title}**：${fact.statement}（${whenClause(fact.expiresWhen)}）` })
    } else if (fact.kind === 'pitfall' && hasRealValue(fact.detector) && !/暂无明确信号/.test(fact.detector)) {
      picked.push({ order: 4, text: `- 看到「${cleanDetector(fact.detector)}」→ 先查：${fact.title}（${cause || '根因见事实页'}）` })
    }
  }
  picked.sort((a, b) => a.order - b.order)
  const lines = [
    '<!-- 由 dsh-chronicle 生成；可粘进 AGENTS.md / 技能 / 项目约定 -->',
    '',
    '## 来自起居注的长期约定与检查项',
    '',
    `> 生成于 ${generatedAt} · 共 ${picked.length} 条（只收录有判别信号或失效条件的条目）`,
    '',
  ]
  let current = 0
  const titles = { 1: '约定', 2: '不要再提的方案', 3: '决策与重评条件', 4: '踩过的坑：判别信号' }
  for (const item of picked.slice(0, limit)) {
    if (item.order !== current) {
      current = item.order
      // 章节之间留空行，否则部分 Markdown 渲染器不认标题
      if (lines[lines.length - 1] !== '') lines.push('')
      lines.push(`### ${titles[current]}`, '')
    }
    lines.push(item.text)
  }
  if (picked.length === 0) lines.push('_还没有可导出的条目：需要约定、或带判别信号/失效条件的事实。_')
  lines.push('')
  return lines.join('\n')
}

/**
 * 该复核的旧事实：单次得出、且已经过了一段时间，或带 expiresWhen。
 *
 * 判据不看 status —— 存量里有一批「假 repeated」（timeline 只有 1 天却标复现），
 * 依赖 status 会让它们永远不进复核清单，真该复核的旧结论反而被淹没。
 */
export function reviewCandidates(facts, { now = Date.now(), olderThanDays = 14, limit = 8 } = {}) {
  const out = []
  for (const fact of facts || []) {
    if (fact.status === 'superseded') continue
    const born = Date.parse(`${fact.bornOn}T12:00:00`)
    const ageDays = Number.isFinite(born) ? (now - born) / 86400000 : 0
    const days = new Set((fact.timeline || []).map((item) => item && item.day).filter(Boolean)).size
    const weak = days < 2 && ageDays >= olderThanDays
    const expiring = hasRealValue(fact.expiresWhen)
    if (!weak && !expiring) continue
    out.push({
      id: fact.id,
      title: fact.title,
      kind: fact.kind,
      project: fact.project,
      bornOn: fact.bornOn,
      ageDays: Math.round(ageDays),
      reason: expiring ? `带重评条件：${fact.expiresWhen}` : `单次得出已 ${Math.round(ageDays)} 天未复现`,
      statement: fact.statement,
    })
  }
  out.sort((a, b) => b.ageDays - a.ageDays)
  return out.slice(0, limit)
}

/** 规则落盘到 vault（写=true 时用）。 */
export async function writeRulesFile(vaultDir, markdown) {
  const path = join(vaultDir, 'AGENTS.generated.md')
  await writeAtomic(path, markdown)
  return path
}

/** 读回已落盘的规则（面板与工具用）。 */
export async function readRulesFile(vaultDir) {
  return readMaybe(join(vaultDir, 'AGENTS.generated.md'))
}
