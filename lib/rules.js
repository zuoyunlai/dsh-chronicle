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
    // 内层的「就查」同样要去掉：正则只剥行首会留下
    // 「流中无 content 就查 finish_reason」→ 先查：… 这种叠句（审计 P1-10）
    .replace(/就查/, '时查')
    .replace(/^则查/, '')
    .replace(/^应该查/, '')
    .replace(/[。.]$/, '')
    .trim()
}

/** 生成一段 Markdown 规则，可直接粘进 AGENTS.md 或技能文件。 */
/**
 * 把事实渲染成可粘进 AGENTS.md 的规则。
 *
 * ## 为什么按项目分组（审计 P1-16）
 *
 * 实测导出 13 条里 12 条是**这个插件自己的开发史**。
 * 贴进全局 AGENTS.md 只会告诉未来的 agent「起居注的坑」——
 * 对别的项目是纯噪音，而且冲淡了真正通用的那一条。
 *
 * 现在每个项目单独一节，项目无关的进「通用」并排在最前；
 * 想只拿某一个项目的规则就传 project 参数。
 */
export function renderRulesMarkdown(facts, { generatedAt, limit = 40, project = '' } = {}) {
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
      picked.push({ order: 1, project: fact.project, text: `- **${fact.title}**：${fact.statement}` })
    } else if (fact.kind === 'rejected') {
      // 被否方案是唯一能真正防「以后又提一遍同一个被否方案」的地方（审计 P1-7）
      picked.push({ order: 2, project: fact.project, text: `- **不要再提 ${fact.title}**：${fact.statement || ''}（${fact.rationale || '之前已否掉'}）` })
    } else if (fact.kind === 'decision' && hasRealValue(fact.expiresWhen)) {
      picked.push({ order: 3, project: fact.project, text: `- **${fact.title}**：${fact.statement}（${whenClause(fact.expiresWhen)}）` })
    } else if (fact.kind === 'pitfall' && hasRealValue(fact.detector) && !/暂无明确信号/.test(fact.detector)) {
      picked.push({ order: 4, project: fact.project, text: `- 看到「${cleanDetector(fact.detector)}」→ 先查：${fact.title}（${cause || '根因见事实页'}）` })
    }
  }
  // 按项目分组：项目无关的（unknown/空）进「通用」并排最前
  const buckets = new Map()
  for (const item of picked) {
    const raw = String(item.project || '').trim()
    const key = raw && raw !== 'unknown' ? raw : ''
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(item)
  }
  const projectKeys = [...buckets.keys()].filter(Boolean).sort()
  if (project) {
    // 只导出指定项目（外加通用条目）
    for (const key of [...projectKeys]) {
      if (key !== project) buckets.delete(key)
    }
  }
  const order = [''].concat([...buckets.keys()].filter(Boolean).sort())
  const titles = { 1: '约定', 2: '不要再提的方案', 3: '决策与重评条件', 4: '踩过的坑：判别信号' }

  const total = [...buckets.values()].reduce((sum, list) => sum + list.length, 0)
  // 稳定化（D1）：正文里不写时间戳 —— 否则每次导出都制造 diff，git 里堆满无变化提交。
  // 用 begin/end 标记包住，脚本可以幂等替换 AGENTS.md 里的这一段。
  const lines = [
    '<!-- dsh-chronicle:begin · 由本插件生成，勿手改；重生成用 chronicle_export_rules -->',
    '## 决策台账（来自起居注）',
    '',
    `> 共 ${total} 条；只收录有判别信号（detector）或失效条件（expiresWhen）的条目。`,
    '',
  ]
  if (total === 0) {
    lines.push('_还没有可导出的条目：需要约定、或带判别信号/失效条件的事实。_', '')
    lines.push('', '<!-- dsh-chronicle:end -->')
    return lines.join('\n')
  }

  let emitted = 0
  for (const bucketKey of order) {
    const list = buckets.get(bucketKey)
    if (!list || list.length === 0) continue
    if (emitted > 0) lines.push('')
    // 项目分区标题：让人一眼看出哪些是本项目的、哪些是跨项目通用的
    lines.push(bucketKey ? `### 项目：${bucketKey}` : '### 通用', '')
    emitted += 1
    let current = 0
    for (const item of list.sort((a, b) => a.order - b.order)) {
      if (item.order !== current) {
        current = item.order
        if (lines[lines.length - 1] !== '') lines.push('')
        lines.push(`#### ${titles[current]}`, '')
      }
      lines.push(item.text)
    }
  }
  lines.push('', '<!-- dsh-chronicle:end -->', '')
  return lines.join('\n')
}

/**
 * 两次导出之间的差异（D1，2026-11-13 产品反哺）。
 *
 * 为什么需要：导出成 AGENTS.md 的段落会被贴进项目约定，用户要看的是
 * **这次比上次多了什么规则、少了什么规则**，而不是一整段重新读一遍。
 *
 * 比较口径：只看内容行（去掉注释、引用头、标题、空行），避免标题层级变化制造噪声。
 *
 * @param {string} previous 上一次导出的 Markdown（没有就传空串）
 * @param {string} next 本次导出
 * @returns {{added:string[], removed:string[], first:boolean}}
 */
export function diffExport(previous, next) {
  const contentLines = (md) =>
    String(md || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('<!--') && !line.startsWith('>') && !line.startsWith('#'))
  const before = contentLines(previous)
  const after = contentLines(next)
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    added: after.filter((line) => !beforeSet.has(line)),
    removed: before.filter((line) => !afterSet.has(line)),
    first: before.length === 0,
  }
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
