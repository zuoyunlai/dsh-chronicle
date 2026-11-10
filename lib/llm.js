/**
 * A 档打分：让宿主模型把一天的纲要整理成结构化条目。
 *
 * 三条铁律：
 *   1. **一次调用搞定一天**，不是一轮一次 —— 省钱，而且同一天的重要度口径一致。
 *   2. **只发纲要**，不发原文。这是成本边界，也是隐私边界。
 *   3. **输出必须可校验**：`ref` 必须在当天纲要里存在，分数与枚举越界一律丢；
 *      宁可退回规则分，也不接受模型编造的证据。
 *
 * 失败不是错误：拿不到结果就把控制权交回规则分（B 档），永远有东西可写。
 */

import { sanitizeText } from './score.js'

const KINDS = new Set(['decision', 'pitfall', 'delivery', 'research', 'chore', 'chat', 'todo'])

/** 把纲要编成 prompt。刻意用管道分隔的紧凑格式，比 JSON 省一半 token。 */
export function buildScorePrompt(turns) {
  const lines = turns.map((turn) => {
    const tools = (turn.tools || []).slice(0, 4).join(',') || '-'
    const files = (turn.files || []).map((f) => String(f).split(/[\\/]/).pop()).slice(0, 3).join(',') || '-'
    const head = sanitizeText(turn.userHead).slice(0, 160)
    // 助手那句是判断"到底做成了什么"的关键证据：用户常只说"继续/已经重启"，
    // 没有这一列，模型只能照着用户那四个字编标题（v0.3.0 实测）。
    const gist = sanitizeText(turn.assistantHead).slice(0, 100) || '-'
    return `${turn.ref} | 工作区:${turn.ws || 'unknown'} | ${head} | 说:${gist} | 工具:${tools} | 文件:${files} | 失败:${turn.failures || 0}`
  })

  return [
    '你是工作日志编辑。下面是某一天各轮对话的纲要。',
    '',
    ...lines,
    '',
    '**输出目标：一份能独立读懂的一天**（不是条目清单）。四个固定板块，缺则留空数组：',
    '',
    '1. summary：3–5 句日结。今天整体怎么回事、主线是什么、到哪一步了。',
    '   必须脱离开条目也能读懂。',
    '2. projects：今天动过哪些**项目/工作区**，每个一条：name（项目名）+ progress（一句话进展）。',
    '3. decisions：双方交流得出的**有价值结论与决策**。每条给：',
    '   title（决策名，≤20 字）、decision（决定了什么，≤60 字）、why（为什么这么定，≤60 字）。',
    '   只收真正拍板的、或推翻旧结论的；讨论过程不算。',
    '4. pitfalls：踩的**坑与根因**。每条给：',
    '   title（坑名，≤20 字）、symptom（现象，≤50 字）、rootCause（**根因**，≤60 字）、fix（怎么绕开，≤50 字）。',
    '   没有明确根因的不要伪造根因，把 rootCause 写成尚未定位。',
    '5. threads：其余值得记的进展，2–4 条线索，每条 title + why + entries。',
    '   过程性的反复修复必须合并，不要一个动作一条。',
    '',
    'ref 规则：projects/decisions/pitfalls/threads 的每一条都要带 ref（来自上面第一列），',
    '用于回溯证据；threads 的 entries 同样带 ref。编造 ref 会被整条丢弃。',
    '',
    '**project 字段（每条必填）**：这条记录属于哪个项目，取值必须是 projects 里出现过的 name，',
    '原样照抄（例如 "dsh-chronicle"）。确实跨多个项目的写 "多个项目"。',
    '这个字段会被渲染成标签，读者点它就能筛出同一项目的全部记录。',
    '',
    'importance 判据（条目级）：5 = 不可逆外部动作或定稿级决策；4 = 产出交付物/修复真实缺陷/推翻旧结论；',
    '3 = 常规实现、调查；2 = 有信息量的闲聊（一般不输出）。',
    '6. rejected：**被否掉的方案**。每条给 title（方案名）、option（方案内容）、reason（为什么否掉，≤60 字）。',
    '   这一块专门防"以后又提一遍同一个被否方案"，务必写清楚否掉的理由。',
    '7. conventions：今天定下的**规矩与口径**（可持续复用的约定，例如"定时 23:50""不回头改历史项目"）。',
    '   title（约定名）+ rule（具体内容）。没有就留空数组。',
    '8. questions：今天提出但**还没答清的问题**。title + detail。没有就留空数组。',
    '',
    '两个**必填**字段（规则导出靠它们，缺了那条就不会被导出）：',
    '- decisions[].expiresWhen：这条决策**什么情况下要重新评估**；确实没有就写「未设定」，不要留空。',
    '- pitfalls[].detector：下次看到**什么可观察的信号**就该怀疑是这个根因（写成"看到 X 就查 Y"的形式）；',
    '  确实想不到就写「暂无明确信号」，不要留空、不要把现象复述一遍当信号。',
    '',
    'kind 取值：decision | pitfall | delivery | research | chore | todo',
    '',
    '硬约束：',
    '- 只输出 JSON 对象，不要解释、不要代码块围栏。',
    '- ref 必须逐字照抄上面第一列。',
    '- entities 只填专有名词（项目名/文件名/产品名/插件名），最多 5 个。',
    '- summary 之外的所有内容都要能追溯到某个 ref。',
    '- rejected/conventions/questions 没有内容就给空数组，不要编。',
    '',
    '格式：',
    '{"summary":"…","projects":[{"name":"dsh-chronicle","progress":"…","ref":"s-1#3","project":"dsh-chronicle"}],"decisions":[{"title":"…","decision":"…","why":"…","expiresWhen":"…","ref":"s-1#5","project":"dsh-chronicle"}],"pitfalls":[{"title":"…","symptom":"…","rootCause":"…","fix":"…","detector":"…","ref":"s-1#7","project":"dsh-chronicle"}],"rejected":[{"title":"…","option":"…","reason":"…","ref":"s-1#8","project":"dsh-chronicle"}],"conventions":[{"title":"…","rule":"…","ref":"s-1#9","project":"dsh-chronicle"}],"questions":[{"title":"…","detail":"…","ref":"s-1#10","project":"dsh-chronicle"}],"threads":[{"title":"…","why":"…","entries":[{"ref":"s-1#11","title":"…","claim":"…","basis":"…","importance":4,"kind":"delivery","entities":["dsh-chronicle"]}]}]}',
  ].join('\n')
}

/** 收集 llm.stream 的文本增量；出错直接抛，交给上层降级。 */
export async function collectText(stream) {
  let text = ''
  let reasoning = ''
  let finish = ''
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') text += chunk.text || ''
    // 思考模型会把预算先烧在 reasoning 上；正文为空时，这里往往是唯一的可救内容
    if (chunk.type === 'reasoning-delta') reasoning += chunk.text || ''
    if (chunk.type === 'finish') {
      finish = chunk.reason?.kind || ''
      if (finish === 'error' || finish === 'aborted') {
        throw new Error(`llm finish: ${finish} ${chunk.reason?.failure?.message || ''}`.trim())
      }
    }
  }
  return { text, reasoning, finish }
}

/**
 * 兜底解析：模型输出被 maxTokens 截断时，数组缺收尾 `]`，`JSON.parse` 必然失败。
 * 这里逐个扫出**顶层对象**，只保留能独立解析的那些 —— 保住已经写好的前缀，
 * 而不是把 14 条全丢掉退回规则分（2026-11-09 实测就这么丢过一次）。
 */
export function salvageObjects(text) {
  const raw = String(text || '')
  const start = raw.indexOf('[')
  if (start < 0) return []
  const out = []
  let depth = 0
  let inString = false
  let escaped = false
  let objStart = -1

  for (let i = start + 1; i < raw.length; i += 1) {
    const ch = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) objStart = i
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0 && objStart >= 0) {
        const candidate = raw.slice(objStart, i + 1)
        try {
          out.push(JSON.parse(candidate))
        } catch {
          /* 这一块坏了就跳过，不影响其它块 */
        }
        objStart = -1
      }
      continue
    }
    if (ch === ']' && depth === 0) break
  }
  return out
}

/** 从模型输出里抠出 JSON 数组：容忍代码围栏、前后废话。 */
export function extractJsonArray(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * 校验并归一模型给的条目。
 * @param {unknown} parsed 模型返回的数组
 * @param {Iterable<string>} validRefs 当天纲要里真实存在的 ref
 */
export function normalizeEntries(parsed, validRefs) {
  if (!Array.isArray(parsed)) return []
  const allowed = new Set(validRefs)
  const out = []
  const seen = new Set()
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const ref = String(item.ref || '').trim()
    if (!allowed.has(ref)) continue // 证据核验：查不到就整条丢弃
    if (seen.has(ref)) continue
    const importance = Number(item.importance)
    if (!Number.isFinite(importance) || importance < 1 || importance > 5) continue
    const kind = String(item.kind || '').trim()
    if (!KINDS.has(kind)) continue
    const title = String(item.title || '').trim()
    if (!title) continue
    seen.add(ref)
    out.push({
      ref,
      title: title.length > 34 ? `${title.slice(0, 33)}…` : title,
      claim: String(item.claim || '').trim().slice(0, 120),
      basis: String(item.basis || '').trim().slice(0, 80),
      importance: Math.round(importance),
      kind,
      entities: Array.isArray(item.entities)
        ? item.entities.map((e) => String(e).trim()).filter(Boolean).slice(0, 5)
        : [],
    })
  }
  return out
}

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/**
 * 重要度：交回模型自己判。
 *
 * 原来这里一律写死 4（rejected/questions 写死 3），实测直方图 {3:7, 4:15}，
 * 1/2/5 全为 0 —— 区分度为零，连带 `floor=3` 的低分折叠成了死代码。
 * 现在只做越界过滤 + 缺省兜底。
 */
function realImportance(item, fallback = 4) {
  const value = Number(item && item.importance)
  if (!Number.isFinite(value)) return fallback
  return Math.min(5, Math.max(1, Math.round(value)))
}

/** 从模型输出里抠出 JSON 对象：容忍代码围栏、前后废话。 */
export function extractJsonObject(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * 归一「日结 + 线索」结构。
 *
 * 用户实测反馈「条目孤立来看毫无意义」——一堆平级的 ★4 修复条目读不出今天干了什么。
 * 现在模型先给 summary（能独立读懂的一天），再把条目挂到 2–5 条线索下。
 */
/**
 * 机械核对「根因」有没有原文依据。
 *
 * prompt 里写了不许伪造根因，实测模型照样编：把「ctx.timer 没 inject
 * 导致工具消失」写成「peer 依赖写法不兼容」，两个都像模像样，但后者是错的。
 * 坑的根因是这份记录最值钱的部分，编错的根因比没定位有害得多。
 *
 * 做法：把根因切成中文二字组，去对应轮次原文里查；命中率 < 50% 就降级为
 * 「尚未定位（原文无据）」，并把推断内容留作参考。
 */
export function verifyRootCauses(entries, textByRef) {
  if (!Array.isArray(entries) || !textByRef) return entries
  for (const entry of entries) {
    if (entry.section !== 'pitfalls') continue
    const basis = String(entry.basis || '')
    const match = /^根因：([^·]+)/.exec(basis)
    if (!match) continue
    const cause = match[1].trim()
    if (!cause || cause.includes('尚未定位')) continue
    const source = String(textByRef.get(entry.ref) || '')
    // 取不到原文时**不能放行**：放行等于「未核验就冒充结论」。
    // 审计 P1-11 实测：`if (!source) continue` 让核验不到的根因原样通过。
    if (!source) {
      entry.basis = basis.replace(/^根因：[^·]+/, `根因：尚未定位（无法取到原文，未核验）`)
      entry.rootCauseUnverified = true
      continue
    }
    // 强证据优先：根因里出现的英文标识符（webServer、ctx.timer、maxTokens…）
    // 只要在原文里出现过一次，就算有据。中英文用词不同时，这条能避免把真根因误杀。
    const identifiers = (cause.match(/[A-Za-z][A-Za-z0-9_.]{3,}/g) || []).map((token) => token.toLowerCase())
    if (identifiers.some((token) => source.toLowerCase().includes(token))) continue
    const tokens = cause.match(/[\u4e00-\u9fff]{2}/g) || []
    if (tokens.length === 0) continue
    const hit = tokens.filter((token) => source.includes(token)).length
    if (hit / tokens.length < 0.5) {
      // 按「· 绕过：」切分而不是 [^·]+ —— 根因里本身可能含「·」，
      // 用 [^·]+ 会把后半截的「绕过：…」一起吞掉（审计 P1-11 第三点）。
      const replaced = basis.replace(/^根因：[\s\S]*?(?=·\s*绕过：|$)/, `根因：尚未定位（模型推断「${cause}」，原文无据）`)
      entry.basis = replaced === basis ? basis : replaced
      entry.rootCauseUnverified = true
    }
  }
  return entries
}

export function normalizeDigest(text, validRefs) {
  const obj = extractJsonObject(text)
  if (!obj || typeof obj !== 'object') return null
  const allowed = new Set(validRefs)
  const seen = new Set()
  const entries = []
  const sections = []

  const str = (value, max) => String(value == null ? '' : value).trim().slice(0, max)
  const refOf = (item) => {
    const ref = str(item && item.ref, 80)
    return allowed.has(ref) && !seen.has(ref) ? ref : ''
  }
  const push = (entry) => {
    seen.add(entry.ref)
    entries.push(entry)
    return entry
  }

  // ① 项目进展
  const projects = []
  for (const item of Array.isArray(obj.projects) ? obj.projects : []) {
    const name = str(item && item.name, 40)
    const ref = refOf(item)
    if (!name || !ref) continue
    projects.push(
      push({
        ref,
        title: name,
        claim: str(item.progress, 100),
        basis: '',
        importance: realImportance(item),
        kind: 'delivery',
        entities: [name],
        section: 'projects',
        project: name,
      }),
    )
  }
  if (projects.length > 0) sections.push({ key: 'projects', title: '项目进展', refs: projects.map((e) => e.ref) })

  // ② 结论与决策
  const decisions = []
  for (const item of Array.isArray(obj.decisions) ? obj.decisions : []) {
    const title = str(item && item.title, 40)
    const ref = refOf(item)
    if (!title || !ref) continue
    decisions.push(
      push({
        ref,
        title,
        claim: str(item.decision, 110),
        basis: str(item.why, 90),
        // 决策的失效条件：以后什么时候该重评这条（事实层会用到）
        expiresWhen: str(item && item.expiresWhen, 90),
        importance: realImportance(item),
        kind: 'decision',
        entities: [],
        section: 'decisions',
        project: str(item && item.project, 40),
      }),
    )
  }
  if (decisions.length > 0) sections.push({ key: 'decisions', title: '结论与决策', refs: decisions.map((e) => e.ref) })

  // ③ 坑与根因
  const pitfalls = []
  for (const item of Array.isArray(obj.pitfalls) ? obj.pitfalls : []) {
    const title = str(item && item.title, 40)
    const ref = refOf(item)
    if (!title || !ref) continue
    const rootCause = str(item.rootCause, 110) || '尚未定位'
    const fix = str(item.fix, 90)
    pitfalls.push(
      push({
        ref,
        title,
        claim: str(item.symptom, 110),
        basis: `根因：${rootCause}${fix ? ' · 绕过：' + fix : ''}`,
        fix: str(item.fix, 90),
        // 判别信号：下次看到什么就该怀疑是它（可执行线索）
        detector: str(item && item.detector, 110),
        importance: realImportance(item),
        kind: 'pitfall',
        entities: [],
        section: 'pitfalls',
        project: str(item && item.project, 40),
      }),
    )
  }
  if (pitfalls.length > 0) sections.push({ key: 'pitfalls', title: '坑与根因', refs: pitfalls.map((e) => e.ref) })

  // ⑤ 被否方案 / 约定 / 未答问题
  const rejected = []
  for (const item of Array.isArray(obj.rejected) ? obj.rejected : []) {
    const title = str(item && item.title, 40)
    const ref = refOf(item)
    if (!title || !ref) continue
    rejected.push(
      push({
        ref,
        title,
        claim: str(item.option, 110),
        basis: str(item.reason, 90),
        importance: realImportance(item, 3),
        kind: 'decision',
        entities: [],
        section: 'rejected',
        project: str(item && item.project, 40),
      }),
    )
  }
  if (rejected.length > 0) sections.push({ key: 'rejected', title: '被否方案', refs: rejected.map((e) => e.ref) })

  const conventions = []
  for (const item of Array.isArray(obj.conventions) ? obj.conventions : []) {
    const title = str(item && item.title, 40)
    const ref = refOf(item)
    if (!title || !ref) continue
    conventions.push(
      push({
        ref,
        title,
        claim: str(item.rule, 110),
        basis: '',
        importance: realImportance(item),
        kind: 'decision',
        entities: [],
        section: 'conventions',
        project: str(item && item.project, 40),
      }),
    )
  }
  if (conventions.length > 0) sections.push({ key: 'conventions', title: '约定与口径', refs: conventions.map((e) => e.ref) })

  const questions = []
  for (const item of Array.isArray(obj.questions) ? obj.questions : []) {
    const title = str(item && item.title, 40)
    const ref = refOf(item)
    if (!title || !ref) continue
    questions.push(
      push({
        ref,
        title,
        claim: str(item.detail, 110),
        basis: '',
        importance: realImportance(item, 3),
        kind: 'research',
        entities: [],
        section: 'questions',
        project: str(item && item.project, 40),
      }),
    )
  }
  if (questions.length > 0) sections.push({ key: 'questions', title: '未答问题', refs: questions.map((e) => e.ref) })

  // ④ 其余进展（线索）
  const threads = []
  for (const thread of Array.isArray(obj.threads) ? obj.threads : []) {
    const title = str(thread && thread.title, 40)
    if (!title) continue
    const kept = []
    for (const item of Array.isArray(thread && thread.entries) ? thread.entries : []) {
      const ref = refOf(item)
      if (!ref) continue
      const importance = Number(item.importance)
      if (!Number.isFinite(importance) || importance < 1 || importance > 5) continue
      const kind = str(item.kind, 20)
      if (!KINDS.has(kind)) continue
      const entryTitle = str(item.title, 40)
      if (!entryTitle) continue
      kept.push(
        push({
          ref,
          title: entryTitle.length > 34 ? entryTitle.slice(0, 33) + '…' : entryTitle,
          claim: str(item.claim, 120),
          basis: str(item.basis, 80),
          importance: Math.round(importance),
          kind,
          entities: Array.isArray(item.entities) ? item.entities.map((e) => String(e).trim()).filter(Boolean).slice(0, 5) : [],
          section: 'threads',
          thread: title,
          project: str(item && item.project, 40),
        }),
      )
    }
    if (kept.length > 0) threads.push({ title, why: str(thread.why, 140), refs: kept.map((e) => e.ref) })
  }
  if (threads.length > 0) sections.push({ key: 'threads', title: '其余进展', refs: threads.flatMap((t) => t.refs), threads })

  if (entries.length === 0) return null
  // 日结是硬要求：'不是条目清单' 这个卖点的落点就是它。
  // 缺失或过短时不静默放过 —— 宁可退回重试，也不要产出一份没有日结的日报。
  const summaryText = str(obj.summary, 800)
  if (summaryText.length < 20) return null
  // 固定阅读顺序：项目 → 决策 → 约定 → 坑 → 被否 → 未答 → 其余
  const ORDER = ['projects', 'decisions', 'conventions', 'pitfalls', 'rejected', 'questions', 'threads']
  sections.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key))
  return { summary: summaryText, sections, threads, entries }
}

/**
 * 调一次模型给一整天打分。
 * @param {{turns:Array, llm:any, provider:string, model:string, signal?:AbortSignal, maxTokens?:number}} input
 * @returns {Promise<Array>} 已校验的条目；拿不到就返回空数组（调用方退回规则分）
 */
export async function scoreDayWithLlm({ turns, llm, provider, model, signal, maxTokens = 8000, reasoningEffort }) {
  if (!llm || typeof llm.stream !== 'function') return []
  if (!provider || !model) return []
  if (!Array.isArray(turns) || turns.length === 0) return []

  const prompt = buildScorePrompt(turns)
  const options = {
    provider,
    model,
    messages: [userMessage(prompt)],
    temperature: 0,
    maxTokens,
    signal,
  }
  // 打分这件事不需要深度思考：思考模型会把预算全烧在 reasoning 上，正文吐不出来。
  // 传入模型支持的最低档，把 token 留给正文。
  if (reasoningEffort) options.reasoningEffort = reasoningEffort
  const stream = llm.stream(options)
  const { text, reasoning, finish } = await collectText(stream)
  const validRefs = turns.map((turn) => turn.ref)

  // 正文优先；正文为空时（思考吃满预算）退到 reasoning 里找 JSON
  const sources = []
  if (String(text || '').trim()) sources.push({ body: text, from: 'text' })
  if (String(reasoning || '').trim()) sources.push({ body: reasoning, from: 'reasoning' })

  if (sources.length === 0) {
    throw new Error(`模型没有返回任何内容（finish=${finish || '未知'}）：思考可能吃满了 ${maxTokens} token 预算`)
  }

  // 首选「日结 + 线索」结构；失败再退回旧的条目数组
  let digest = null
  let usedFrom = 'text'
  for (const source of sources) {
    digest = normalizeDigest(source.body, validRefs)
    if (digest) { usedFrom = source.from; break }
  }
  if (digest) {
    const entries = digest.entries
    // 根因必须能在原文里找到依据，否则降级为「尚未定位」
    // 证据窗要够宽：只用 userHead + assistantHead（各截 300/100 字）会漏掉
    // 写在助手正文后半段的真根因（审计 P1-11 实测：「插件工具表消失」的真根因
    // `ctx.timer` 未 inject 就写在修复叙述里，被误杀成「原文无据」）。
    verifyRootCauses(
      digest.entries,
      new Map(
        turns.map((turn) => [
          turn.ref,
          [turn.user, turn.assistant].filter(Boolean).join(' '),
        ]),
      ),
    )
    entries.summary = digest.summary
    entries.threads = digest.threads
    entries.sections = digest.sections
    if (usedFrom === 'reasoning') entries.note = '正文为空，从思考内容里取到结果'
    if (finish === 'max-tokens') entries.note = (entries.note ? entries.note + '；' : '') + '输出被截断，已保留已达成的线索'
    return entries
  }

  // 兼容：模型仍然吐了平铺数组（旧格式或被截断到只剩数组）
  let entries = []
  let salvaged = 0
  for (const source of sources) {
    entries = normalizeEntries(extractJsonArray(source.body), validRefs)
    if (entries.length === 0) {
      const objects = salvageObjects(source.body)
      entries = normalizeEntries(objects, validRefs)
      salvaged = entries.length
    }
    if (entries.length > 0) { usedFrom = source.from; break }
  }

  if (entries.length === 0) {
    const hint = finish === 'max-tokens' ? '（输出被 maxTokens 截断）' : ''
    const body = usedFrom === 'reasoning' ? reasoning : text
    throw new Error(`输出不是 JSON${hint}：${sanitizeText(body).slice(0, 120)}`)
  }

  if (salvaged > 0) {
    entries.truncated = finish === 'max-tokens'
    entries.note = `从 ${usedFrom === 'reasoning' ? '思考' : '正文'} 中抢救 ${salvaged} 条${finish === 'max-tokens' ? '（输出被截断）' : ''}`
  } else if (usedFrom === 'reasoning') {
    entries.note = '正文为空，从思考内容里取到结果'
  }
  return entries
}
