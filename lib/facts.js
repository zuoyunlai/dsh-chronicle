/**
 * 事实层（facts）：从「某一天的决策与坑」提炼出**不随日期过期**的原子条目。
 *
 * 为什么需要这一层：日报记的是"今天发生了什么"（事件），
 * 而用户真正想留的是"什么结论以后还能用"（事实）。
 * 两者混在一起，日报会被迫承载记忆的职责，越写越长却越没用。
 *
 * 形态参照 evergreen notes / agent-mem：
 *   - 一条事实一个页面（原子性，概念标题）
 *   - 一份 MEMORY.md 索引（先读索引再决定读哪篇）
 *   - 机器可读 index.json（给检索与注入用，不解析 Markdown）
 *
 * 不可变原则不变：事实页可修订（status / supersededBy / hits），
 * 但日报与事件流永远不回头改。
 */
import { join } from 'node:path'
import { ensureDir, writeAtomic, readJson, readMaybe } from './store.js'
import { tokenize } from './recall.js'
import { detectSupersedes, applySupersedes, hasOppositeMarkers, closeAnsweredQuestions } from './supersede.js'

/** 事实类型：决定落在哪个目录、导出成什么规则。 */
export const FACT_KINDS = ['decision', 'pitfall', 'rejected', 'convention', 'question']

/** 标题 → 稳定文件名（可重算，便于幂等）。 */
export function slugOf(text, fallback = 'fact') {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[\s/\\:*?"<>|]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return (raw || fallback).slice(0, 60)
}

/** 稳定 id：类型 + slug，便于跨天合并时对齐。 */
export function factId(kind, title) {
  return `${kind}-${slugOf(title, 'untitled')}`
}

/** 文本相似度（token 覆盖率），用于跨天合并去重。 */
export function similarity(a, b) {
  const left = tokenize(a)
  const right = tokenize(b)
  if (left.size === 0 || right.size === 0) return 0
  let hit = 0
  for (const token of left) if (right.has(token)) hit += 1
  return hit / Math.max(left.size, right.size)
}

/**
 * 把一天的条目转成事实。
 * @param {{day:string, entries:Array}} input
 */
/**
 * 判断一条记录属于「用户工作知识」还是「工具自身的开发史」。
 *
 * 为什么需要（2026-11-10 审计）：实测 16 条事实**全部**来自插件自己的开发会话，
 * 而当天真正干了活的另一个会话（WSL 迁移与磁盘优化）产出 **0 条**——
 * 因为白名单不含 projects/threads。
 * 长期后果是致命的：用户会形成「记了也没用」的预期，然后不再认真对话，
 * 语料质量下降、记忆质量再降 —— 一个自我强化的负循环。
 *
 * 判据（保守，宁可漏判不可误判）：
 * ① 陈述里含**具体的量/路径/版本/条件**（"51.04G 降到 28.95G"、"迁至 D 盘"）→ general
 * ② 提到本工具自身的实现细节（文件名、模块名、"插件"、"起居注"、"收口"…）→ tool-self
 * ③ 两者都不明显 → tool-self（保守：不污染主索引）
 */
/**
 * 「工具自身开发史」的判据。
 *
 * 踩过的坑：初版把「收口」「打分」「面板」「注入」等词都算成工具自用，
 * 结果「收口时间 23:50」这种**用户自己的工作约定**被误判为工具开发史而排除。
 * 那些词是用户描述自己工作流程的词汇，不是工具的实现细节。
 *
 * 真正的标记只有两类：
 * ① 明确指向本工具（起居注 / chronicle / 本插件 / 这个插件）
 * ② 提到工具的代码产物（文件名、模块路径、测试文件）
 */
const TOOL_SELF_HINTS = ['本插件', '这个插件', '本记录系统', '本工具', '插件自身']
const TOOL_SELF_PATTERNS = [
  /\b[\w-]+\.(js|mjs|cjs|ts)\b/, // 源文件名
  /\blib\/[\w/]+/, // 模块路径
  /\btests?\/[\w-]+/, // 测试路径
  /\bnode --test\b/,
  /\bctx\.(inject|get|timer|tools|llm)\b/, // 宿主 API 名
  /\bplugin_doctor\b/,
]

const SPECIFIC_HINTS = [
  /\d+\s*(G|M|K|TB|GB|MB)/i, // 带单位的量
  /\d+\.\d+/, // 小数
  /\bv?\d+\.\d+\.\d+/, // 版本号
  /[A-Za-z]:[\\/][^，。；\s]{3,}/, // Windows 绝对路径
]

export function classifyScope({ title, statement, rationale, project, kind }) {
  const text = [title, statement, rationale].filter(Boolean).join(' ')
  // 明确指向本工具 ⇒ 工具自用（不管它属于哪一块）
  if (TOOL_SELF_HINTS.some((hint) => text.includes(hint))) return 'tool-self'
  // 提到工具的代码产物 ⇒ 工具自用
  if (TOOL_SELF_PATTERNS.some((pattern) => pattern.test(text))) return 'tool-self'
  // 决策/坑/约定/被否/未答本身就是「有价值的结论」，默认是工作知识。
  // 注意：**不按 project 名判定** —— 用户的工作项目本身就可能叫 dsh-chronicle，
  // 按项目名一刀切会把用户的真实决策也排除掉（审计初版踩过这个坑）。
  if (kind && kind !== 'note') return 'general'
  // projects/threads 门槛更高：必须含具体的量/路径/版本/条件
  if (SPECIFIC_HINTS.some((pattern) => pattern.test(text))) return 'general'
  return 'tool-self'
}

/**
 * 把一天的条目转成事实。
 *
 * 两种来源：
 * ① 四块里的决策/约定/坑/被否/未答 —— 默认进事实层
 * ② 项目进展/其余 —— **只有通过普适性闸才进**（否则全是开发史）
 */
export function factsOfDay({ day, entries }) {
  const out = []
  for (const entry of entries || []) {
    const section = entry.section
    const kind = section === 'decisions' ? 'decision'
      : section === 'pitfalls' ? 'pitfall'
      : section === 'rejected' ? 'rejected'
      : section === 'conventions' ? 'convention'
      : section === 'questions' ? 'question'
      : section === 'projects' || section === 'threads' ? 'note'
      : null
    if (!kind) continue

    // projects/threads 要过普适性闸；四块的默认 scope 由分类器判
    const scope = classifyScope({
      title: entry.title,
      statement: entry.claim,
      rationale: entry.basis,
      project: entry.project,
      kind,
    })
    if (kind === 'note' && scope !== 'general') continue

    out.push({
      id: factId(kind, entry.title),
      kind,
      scope,
      title: entry.title,
      // decision: 决定了什么；pitfall: 现象；rejected: 被否的方案；convention: 规矩本身
      statement: entry.claim || '',
      // decision: 为什么；pitfall: 根因；rejected: 否掉的理由
      rationale: String(entry.basis || '').replace(/^根因：/, ''),
      // 只有决策有：什么时候该重新评估
      expiresWhen: entry.expiresWhen || '',
      // 只有坑有：下次看到什么信号就该怀疑它
      detector: entry.detector || '',
      project: entry.project || 'unknown',
      bornOn: day,
      status: 'single', // single → repeated（跨天复现）→ superseded（被推翻）
      hits: 0,
      evidence: [entry.ref].filter(Boolean),
      // 跨天线索靠它：每次出现是哪天、哪条证据
      timeline: entry.ref ? [{ day, ref: entry.ref }] : [],
      // 同一天被复述多次也算次数：timeline 按 day|ref 去重会抹掉它
      occurrences: 1,
      supersededBy: '',
    })
  }
  return out
}

export function factsDir(dataDir) {
  return join(dataDir, 'facts')
}

export function factsIndexPath(dataDir) {
  return join(factsDir(dataDir), 'index.json')
}

/** 读已有事实索引（没有就空数组）。 */
export async function readFacts(dataDir) {
  const data = await readJson(factsIndexPath(dataDir), null)
  return Array.isArray(data?.facts) ? data.facts : []
}

/**
 * 合并今天的事实进总索引。
 *
 * 合并规则（宁少勿滥）：
 *   同一 id（类型 + 标题 slug）⇒ 累加证据，status 升到 repeated
 *   高相似（≥0.72）⇒ 视作同一件事，合并证据但保留先出现的那条标题
 */
export function mergeFactList(existing, incoming) {
  const facts = [...existing]
  const byId = new Map(facts.map((fact) => [fact.id, fact]))

  for (const fact of incoming) {
    const same = byId.get(fact.id)
    if (same) {
      // 同标题但语义相反 ⇒ 是「推翻」不是「合并」。
      // 不区分的话，一条被推翻的约定会以合并的形式继续有效，
      // 规则导出照样把它当现行规则推给下一次对话（审计 P1-2）。
      if (hasOppositeMarkers(same, fact) && String(same.bornOn || '') < String(fact.bornOn || '')) {
        same.status = 'superseded'
        same.supersededBy = fact.id
        fact.supersedes = [...new Set([...(fact.supersedes || []), same.id])]
        continue
      }
      same.evidence = [...new Set([...(same.evidence || []), ...(fact.evidence || [])])]
      same.timeline = mergeTimeline(same.timeline, fact.timeline)
      // occurrences 由 timeline 推导，不能累加（否则重复收口会 1→2→4 翻倍）
      same.status = same.status === 'superseded' ? 'superseded' : repeatedStatus(same.timeline)
      if (fact.expiresWhen) same.expiresWhen = fact.expiresWhen
      if (fact.detector) same.detector = fact.detector
      // 自愈：旧的"尚未定位"遇上新的已核实根因就替换掉（重算收口不再留下旧猜测）
      const oldUnverified = /尚未定位/.test(String(same.rationale || ''))
      const incomingVerified = fact.rationale && !/尚未定位/.test(String(fact.rationale))
      if (!same.rationale || (oldUnverified && incomingVerified)) same.rationale = fact.rationale
      continue
    }

    // 近重复：正文相似就够，标题相近也算（模型对同一件事常换说法：
    // 「插件工具表消失」vs「插件工具全部消失」——2026-11-09 实测一半事实是这种成对重复）
    // 取**最相似**的一个，不是第一个满足的 ——
    // 三条判据强度差异极大（共享 ref ≫ 正文 0.72 > 标题 0.62），
    // 按数组顺序取第一个会让「碰巧像」的候选赢（审计 P2-7）
    let near = null
    let nearScore = 0
    for (const candidate of facts) {
      if (candidate.kind !== fact.kind) continue
      if (candidate.supersededBy) continue
      let score = 0
      if ((candidate.evidence || []).some((ref) => (fact.evidence || []).includes(ref))) score += 3
      const body = similarity(candidate.statement || candidate.title, fact.statement || fact.title)
      if (body >= 0.72) score += 2
      // 标题只作弱信号：0.62 起，且长度差不能太大
      const titleScore = similarity(candidate.title, fact.title)
      if (titleScore >= 0.55) {
        const lenA = String(candidate.title || '').length
        const lenB = String(fact.title || '').length
        const lenRatio = Math.min(lenA, lenB) / Math.max(1, Math.max(lenA, lenB))
        if (lenRatio >= 0.7) score += 1
      }
      if (score > nearScore) {
        nearScore = score
        near = candidate
      }
    }
    // 命中任意一条判据即可合并；但标题判据还要长度接近，
    // 否则「右栏面板无数据」与「右栏面板无数据且不跟主题」会被并成一条（多带了不同现象）
    if (nearScore < 1) near = null
    if (near) {
      near.evidence = [...new Set([...(near.evidence || []), ...(fact.evidence || [])])]
      // 新条目的结论不能被丢：原来 near 分支只并证据，
      // 导致「同一坑再次出现、这次根因已核实」时新的根因被静默丢弃（审计 P1-4）
      if (fact.statement && fact.statement.length > (near.statement || '').length) near.statement = fact.statement
      const nearUnverified = /尚未定位/.test(String(near.rationale || ''))
      const factVerified = fact.rationale && !/尚未定位/.test(String(fact.rationale))
      if (!near.rationale || (nearUnverified && factVerified)) near.rationale = fact.rationale
      if (fact.detector && !near.detector) near.detector = fact.detector
      if (fact.expiresWhen && !near.expiresWhen) near.expiresWhen = fact.expiresWhen
      near.timeline = mergeTimeline(near.timeline, fact.timeline)

      near.status = near.status === 'superseded' ? 'superseded' : repeatedStatus(near.timeline)
      if (fact.detector && !near.detector) near.detector = fact.detector
      if (fact.expiresWhen && !near.expiresWhen) near.expiresWhen = fact.expiresWhen
      continue
    }

    facts.push(fact)
    byId.set(fact.id, fact)
  }

  // 冲突检测：新事实推翻旧事实（记忆系统的核心能力，审计 P1-2）
  const supersedes = detectSupersedes(incoming, facts)
  if (supersedes.length > 0) applySupersedes(facts, supersedes)
  // 未答问题被后续决策回答后自动关闭（审计 P1-7：原来问题永不关闭）
  closeAnsweredQuestions(facts)

  // 全量归一化：status 与 occurrences 都由 timeline 推导，不靠历史遗留值。
  // 修两件事：① 存量事实的假 'repeated' 徽标（timeline 只有 1 天却标复现）；
  //          ② 重复收口时 occurrences 累加导致的非幂等（1→2→4）。
  for (const fact of facts) {
    // scope 也全量重算：存量事实建库时还没有 scope 字段，
    // 不重算的话「tool-self 不进主索引」这条永远不生效（实测 16 条全挂在 general）。
    // 已经被手工标成 tool-self 的保留，其余按内容重判。
    if (fact.scope !== 'tool-self') {
      fact.scope = classifyScope({
        title: fact.title,
        statement: fact.statement,
        rationale: fact.rationale,
        project: fact.project,
        kind: fact.kind,
      })
    }
    if (fact.status !== 'superseded' && fact.status !== 'answered') fact.status = repeatedStatus(fact.timeline)
    const days = new Set((fact.timeline || []).map((item) => item && item.day).filter(Boolean))
    fact.occurrences = (fact.timeline || []).length
    fact.days = days.size
  }

  return facts.sort((a, b) => String(b.bornOn).localeCompare(String(a.bornOn)) || a.id.localeCompare(b.id))
}

/**
 * repeated 的判定必须跨天。
 *
 * 之前同日合并也标 repeated，导致 12 条事实标着「复现」但 timeline 只有 1 天，
 * 跨天线索（arcs）因此永远是空的——徽标和线索都在撒谎。
 */
export function repeatedStatus(timeline) {
  const days = new Set((timeline || []).map((item) => item && item.day).filter(Boolean))
  return days.size >= 2 ? 'repeated' : 'single'
}

export function mergeTimeline(a, b) {
  const out = []
  const seen = new Set()
  for (const item of [...(a || []), ...(b || [])]) {
    if (!item || !item.day) continue
    const key = item.day + "|" + (item.ref || "")
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ day: item.day, ref: item.ref || "" })
  }
  return out.sort((x, y) => String(x.day).localeCompare(String(y.day)))
}

/** 事实页的 Markdown（Obsidian 可读，带 frontmatter 与出处）。 */
export function renderFactPage(fact) {
  const lines = [
    '---',
    `id: ${fact.id}`,
    `kind: ${fact.kind}`,
    `project: ${fact.project}`,
    `bornOn: ${fact.bornOn}`,
    `status: ${fact.status}`,
    `hits: ${fact.hits || 0}`,
    ...(fact.evidenceStale ? ['evidenceStale: true'] : []),
    `evidence: [${(fact.evidence || []).join(', ')}]`,
    '---',
    '',
    `# ${fact.title}`,
    '',
    fact.statement ? `**结论**：${fact.statement}` : '',
    fact.rationale ? `**为什么**：${fact.rationale}` : '',
    fact.expiresWhen ? `**何时重评**：${fact.expiresWhen}` : '',
    fact.detector ? `**判别信号**：${fact.detector}` : '',
    '',
    `出处：${(fact.evidence || []).map((ref) => `\`${ref}\``).join(' · ') || '（无）'}`,
    fact.supersededBy ? `\n已被取代：\`${fact.supersededBy}\`` : '',
  ]
  return `${lines.filter((line) => line !== '').join('\n')}\n`
}

/** MEMORY.md：人读索引，先看它再决定读哪篇。 */
export function renderMemoryIndex({ facts, generatedAt }) {
  const groups = [
    ['decision', '决策'],
    ['convention', '约定与口径'],
    ['pitfall', '坑与根因'],
    ['rejected', '被否的方案'],
    ['question', '未答问题'],
  ]
  const general = facts.filter((fact) => fact.scope !== 'tool-self')
  const toolSelf = facts.filter((fact) => fact.scope === 'tool-self')
  const lines = [
    '# 记忆索引',
    '',
    // 不写生成时间：MEMORY.md 是**产物**，每写一次都带上时间戳就等于每次收口都制造 diff，
    // git 里会堆一串只有时间戳变化的提交（2026-11-13 审计 P2：23 次 commit 全同名）。
    // 机器可读的 index.json 里仍然保留 generatedAt。
    `> 由 dsh-chronicle 生成 · 工作记忆 ${general.length} 条 · 工具自身笔记 ${toolSelf.length} 条`,
    '> 先读这里，再决定打开哪一篇；单条事实都在 `facts/` 目录下。',
    '',
  ]
  if (toolSelf.length > 0) {
    lines.push('## 工具自身笔记（不进规则导出，不算工作记忆）', '')
    for (const fact of toolSelf) {
      lines.push('- ' + fact.title + ' · ' + fact.project + ' · ' + fact.status + ' · `' + fact.id + '`')
    }
    lines.push('')
  }
  for (const [kind, label] of groups) {
    const list = facts.filter((fact) => fact.kind === kind && fact.scope !== 'tool-self')
    if (list.length === 0) continue
    lines.push(`## ${label}（${list.length}）`, '')
    for (const fact of list) {
      const badge =
        fact.status === 'superseded' ? '~~已推翻~~' : fact.status === 'repeated' ? '复现' : '单次'
      lines.push(`- [[${fact.id}]] ${fact.title} · ${fact.project} · ${badge}`)
    }
    lines.push('')
  }

  // 已落库、但不在五类规范里的记录（现网有 14 条 `note`）。
  // 不列出来的后果是：头部写「工作记忆 67 条」，正文只列出 53 条 ——
  // 索引骗人比没有索引更糟（2026-11-13 审计 P1-4）。
  const knownKinds = new Set(groups.map(([kind]) => kind))
  const extras = facts.filter((fact) => fact.scope !== 'tool-self' && !knownKinds.has(fact.kind))
  if (extras.length > 0) {
    lines.push(`## 其他记录（${extras.length}）`, '')
    for (const fact of extras) {
      const badge =
        fact.status === 'superseded' ? '~~已推翻~~' : fact.status === 'repeated' ? '复现' : '单次'
      lines.push(`- [[${fact.id}]] ${fact.title} · ${fact.project} · ${fact.kind} · ${badge}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 把事实写进 vault（原子页 + 索引），并更新机器可读索引。
 * @returns {{facts:number, pages:number, index:string}}
 */
export async function persistFacts({ dataDir, vaultDir, incoming, generatedAt }) {
  const existing = await readFacts(dataDir)
  const facts = mergeFactList(existing, incoming)

  await ensureDir(factsDir(dataDir))
  await writeAtomic(
    factsIndexPath(dataDir),
    `${JSON.stringify({ v: 1, generatedAt, facts }, null, 2)}\n`,
  )

  const dir = join(vaultDir, 'facts')
  await ensureDir(dir)
  let pages = 0
  let unchanged = 0
  for (const fact of facts) {
    // 只写内容真的变了的页：全量重写是 O(全部事实) 的写放大，
    // 76 页 ≈108 ms，1000 条时 ≈1.4 s（2026-11-13 审计 P1：收口写侧的主要成本）。
    const path = join(dir, `${fact.id}.md`)
    const next = renderFactPage(fact)
    try {
      const current = await readMaybe(path)
      if (current === next) {
        unchanged += 1
        continue
      }
    } catch {
      /* 读不到就照常写 */
    }
    await writeAtomic(path, next)
    pages += 1
  }
  const indexPath = join(vaultDir, 'MEMORY.md')
  const indexText = `${renderMemoryIndex({ facts, generatedAt })}\n`
  const indexBefore = await readMaybe(indexPath)
  if (indexBefore !== indexText) await writeAtomic(indexPath, indexText)
  // 孤儿页归档（同一件事的两种说法留下的旧文件）
  const { archived } = await archiveOrphanFactPages(vaultDir, facts)
  return { facts: facts.length, pages, unchanged, index: indexPath, archived }
}

/** 命中计数：被 recall/检索用过一次就 +1（这是判断"这东西有没有用"的唯一指标）。 */
/**
 * 命中计数：被检索用到一次就 +1。
 *
 * 除了写索引，**还要重写受影响的 vault 页面** ——
 * 原来只改 index，页面 frontmatter 的 `hits:` 停在下次收口的快照上，
 * 于是「同源两处数字不同」（审计 P1-12）。
 *
 * @param {string} dataDir
 * @param {string[]} refs 本次被检索命中的证据 ref
 * @param {string} [vaultDir] 给了就同步页面
 */
export async function bumpFactHits(dataDir, refs, vaultDir) {
  if (!Array.isArray(refs) || refs.length === 0) return 0
  const facts = await readFacts(dataDir)
  if (facts.length === 0) return 0
  const touchedFacts = []
  for (const fact of facts) {
    if ((fact.evidence || []).some((ref) => refs.includes(ref))) {
      fact.hits = (fact.hits || 0) + 1
      touchedFacts.push(fact)
    }
  }
  if (touchedFacts.length === 0) return 0
  await writeAtomic(
    factsIndexPath(dataDir),
    `${JSON.stringify({ v: 1, generatedAt: new Date().toISOString(), facts }, null, 2)}\n`,
  )
  // 同步页面：否则索引涨了、页面没涨
  if (vaultDir) {
    for (const fact of touchedFacts) {
      try {
        await writeAtomic(join(vaultDir, 'facts', `${fact.id}.md`), renderFactPage(fact))
      } catch {
        /* 单页写失败不影响计数 */
      }
    }
  }
  return touchedFacts.length
}

/**
 * 归档孤儿事实页。
 *
 * 为什么需要：模型对同一件事常换说法（`插件工具表消失` vs `插件工具全部消失`），
 * id 随标题变，近重复合并把证据并过去了，但**旧页面文件还留在磁盘上**。
 * 实测曾出现「22 个 md vs 16 条索引」，且同一件事有两个页面、两种状态。
 *
 * 不直接删：归档到 `facts/_superseded/`，保留可审计性。
 */
export async function archiveOrphanFactPages(vaultDir, facts) {
  const dir = join(vaultDir, 'facts')
  const alive = new Set((facts || []).map((fact) => `${fact.id}.md`))
  let archived = 0
  let names = []
  try {
    const { readdir } = await import('node:fs/promises')
    names = (await readdir(dir)).filter((name) => name.endsWith('.md'))
  } catch {
    return { archived: 0 }
  }
  for (const name of names) {
    if (alive.has(name)) continue
    try {
      const { rename } = await import('node:fs/promises')
      const target = join(dir, '_superseded', name)
      await ensureDir(join(dir, '_superseded'))
      await rename(join(dir, name), target)
      archived += 1
    } catch {
      /* 归档失败不阻断收口 */
    }
  }
  return { archived }
}

/** 读一条事实页的原文（给工具与面板用）。 */
export async function readFactText(vaultDir, id) {
  return readMaybe(join(vaultDir, 'facts', `${id}.md`))
}
