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
 * **对象格式**的抢救（2026-11-10 实测缺口）。
 *
 * prompt 要的是对象：
 *   {"summary":"…","projects":[…],"decisions":[…],"pitfalls":[…],
 *    "rejected":[…],"conventions":[…],"questions":[…],"threads":[…]}
 * 输出被 maxTokens 截断时，收尾的 } 与 ] 都没了。
 * extractJsonObject 靠「首个 { 到末个 }」切片 ⇒ 必然解析失败；
 * 而 salvageObjects 只扫 **[数组]** 里的顶层对象，对象格式**没有任何抢救路径**
 * ⇒ 42 轮的工作内容全丢，退回规则分。
 *
 * 这里做两件事：
 *   ① summary 在最前面，几乎不可能被截掉，直接正则捞出来
 *   ② 每个数组各扫一遍，能独立解析的对象留下
 */
export function salvageDigestObject(text) {
  const raw = String(text || '')
  if (!raw) return null
  const out = {}

  const summaryMatch = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)
  if (summaryMatch) {
    try {
      out.summary = JSON.parse('"' + summaryMatch[1] + '"')
    } catch {
      /* 引号不配对就放弃 summary */
    }
  }

  const keys = ['projects', 'decisions', 'pitfalls', 'rejected', 'conventions', 'questions', 'threads']
  let found = 0
  for (const key of keys) {
    const keyIndex = raw.indexOf('"' + key + '"')
    if (keyIndex < 0) continue
    const arrStart = raw.indexOf('[', keyIndex)
    if (arrStart < 0) continue
    // 从 [ 开始切，让 salvageObjects 的顶层扫描正好落在这个数组里
    const items = salvageObjects(raw.slice(arrStart))
    if (items.length > 0) {
      out[key] = items
      found += items.length
    }
  }
  if (!out.summary && found === 0) return null
  out.__salvaged = found
  return out
}

/**
 * 归一「日结 + 线索」结构。
 *
 * 用户实测反馈「条目孤立来看毫无意义」——一堆平级的 ★4 修复条目读不出今天干了什么。
 * 现在模型先给 summary（能独立读懂的一天），再把条目挂到 2–5 条线索下。
 */
/**
 * 最长公共**连续**子串长度（按字符）。
 *
 * 为什么不用「二字组逐个计数」：那是切分伪影。
 * 根因「优先级高于手册」切出来是 时优/先级/级高/高于 —— 后三个几乎不可能
 * 逐字出现在原文（原文写的是「优先于」）。逐个计数要求 50% 命中，
 * 实际上是在赌运气：真实数据那次 55% 刚过线，换个说法就掉到 45%。
 *
 * 连续子串更贴语义：模型说的根因只要**有一大段**能对上原文，
 * 就说明它不是凭空编的。「手写知识命中」6 字连续命中 ⇒ 有依据。
 */
export function longestCommonRun(a, b) {
  const s = String(a || '')
  const t = String(b || '')
  if (!s || !t) return 0
  let best = 0
  let prev = new Array(t.length + 1).fill(0)
  for (let i = 1; i <= s.length; i += 1) {
    const cur = new Array(t.length + 1).fill(0)
    for (let j = 1; j <= t.length; j += 1) {
      if (s[i - 1] === t[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > best) best = cur[j]
      }
    }
    prev = cur
  }
  return best
}

/**
 * 根因是否有原文依据。
 *
 * 两条判据（任一成立即算有依据）：
 *   ① 英文标识符出现在原文里（webServer / ctx.timer / maxTokens…）—— 最强的信号
 *   ② 与原文有 ≥6 字的连续公共子串 —— 模型说的根因能对上原文的一段
 *
 * ② 取代了原来的「二字组命中率 ≥ 50%」：那个判据会被切分伪影带偏。
 */
export function hasRootCauseEvidence(cause, source) {
  const c = String(cause || '')
  const s = String(source || '')
  if (!c || !s) return false
  // ① 英文标识符 —— 最强的信号
  const identifiers = (c.match(/[A-Za-z][A-Za-z0-9_.]{3,}/g) || []).map((t) => t.toLowerCase())
  if (identifiers.some((token) => s.toLowerCase().includes(token))) return true
  // ② 连续公共子串：汉字 6 个 / 字母 8 个
  const run = longestCommonRun(c, s)
  const cjk = (c.match(/[\u4e00-\u9fff]/g) || []).length
  if (cjk >= 6 && run >= 6) return true
  if (cjk < 6 && run >= 8) return true
  // ③ 模糊匹配：允许 1 个字不同。
  //    「优先级」在原文写的是「优先于」—— 只差一个字，却会让精确匹配整段失效。
  if (cjk >= 6 && fuzzyRun(c, s, 6, 1) >= 6) return true
  // ④ 实词覆盖率：模型是**重新组织**过表述的，语序可能变，
  //    字符级匹配救不了（「手写知识命中时优先级高于手册」vs 原文
  //    「手写知识优先于手册，命中即返回」）。切掉虚词后按词袋看覆盖率。
  //
  //    阈值 0.5 是**故意保守**的：宁可标「未核验」也不放行猜测。
  //    已知边界：若模型只在原文中提过一次、且措辞与原文差异很大，
  //    覆盖率可能落在 0.4–0.5 之间而被误判为「未核验」——
  //    这是有意的偏向（记忆里的原则：宁可标未核验也不许伪造根因）。
  const coverage = realWordCoverage(c, s)
  if (coverage.ratio >= 0.5 && coverage.words >= 3) return true
  return false
}

/**
 * 中文虚词/连接词 —— 用作分词边界。
 *
 * 只收**几乎不可能承载根因语义**的词。像「优先级」这种虽像虚词但正是判断对象，
 * 不能收进来。
 */
const ZH_STOPWORDS = [
  '导致', '造成', '使得', '让', '被', '把', '将', '对', '为', '以', '从', '到', '与', '和', '及',
  '或', '的', '了', '着', '过', '在', '是', '而', '就', '都', '也', '但', '却', '这', '那', '有',
  '时', '高于', '低于', '大于', '小于', '之后', '之前', '之后', '于是', '因此', '所以', '因为', '由于',
  '一个', '这个', '那个', '如果', '就会', '可能', '应该', '需要', '进行', '出现', '发生',
]

/**
 * 实词覆盖率：根因切掉虚词后的实词，有多少能在原文里找到。
 *
 * 与连续子串互补：子串要求**顺序**一致，覆盖率不要求。
 */
export function realWordCoverage(cause, source) {
  const c = String(cause || '')
  const s = String(source || '')
  if (!c || !s) return { ratio: 0, words: 0, matched: [] }

  // 用停用词切边界
  let marked = c
  for (const w of ZH_STOPWORDS) marked = marked.split(w).join('\u0001')
  const parts = marked.split(/[\u0001\s，,。.、；;：:！!？?（）()「」“”"'\-]+/).filter(Boolean)

  const words = []
  for (const part of parts) {
    // 太短的片段信息量不足；太长的按 3 字窗切（中文词多是 2–4 字）
    if (part.length < 2) continue
    if (part.length <= 4) {
      words.push(part)
    } else {
      for (let i = 0; i + 3 <= part.length; i += 1) words.push(part.slice(i, i + 3))
    }
  }
  if (words.length === 0) return { ratio: 0, words: 0, matched: [] }

  const unique = [...new Set(words)]
  const matched = unique.filter((w) => s.includes(w))
  return { ratio: matched.length / unique.length, words: unique.length, matched }
}

/**
 * 编辑距离（Levenshtein），带上限早退。
 */
function editDistance(a, b, cap = 2) {
  const prev = new Array(b.length + 1).fill(0)
  const cur = new Array(b.length + 1).fill(0)
  for (let j = 0; j <= b.length; j += 1) prev[j] = j
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i
    let best = cur[0]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (cur[j] < best) best = cur[j]
    }
    if (best > cap) return cap + 1
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j]
  }
  return prev[b.length]
}

/**
 * 模糊连续匹配：cause 里存在一个长度 ≥ minLen 的片段，
 * 在 source 里能找到编辑距离 ≤ maxDiff 的对应片段。
 *
 * 用于捕捉「同义不同字」的表述差异（优先**级** vs 优先**于**）。
 */
export function fuzzyRun(cause, source, minLen = 6, maxDiff = 1) {
  const c = String(cause || '')
  const s = String(source || '')
  if (c.length < minLen || s.length < minLen) return 0
  let best = 0
  // 先试更长的片段（更可信），失败再降级
  for (let len = Math.min(c.length, 12); len >= minLen; len -= 1) {
    for (let i = 0; i + len <= c.length; i += 1) {
      const chunk = c.slice(i, i + len)
      // 用首字符做快速过滤，避免对 source 做无谓的编辑距离
      const first = chunk[0]
      for (let j = 0; j + len <= s.length; j += 1) {
        if (s[j] !== first) continue
        const d = editDistance(chunk, s.slice(j, j + len), maxDiff)
        if (d <= maxDiff) return len
      }
    }
  }
  return best
}

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
    if (!hasRootCauseEvidence(cause, source)) {
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
  let obj = extractJsonObject(text)
  let salvaged = false
  if (!obj || typeof obj !== 'object') {
    // 截断了就抢救对象格式（否则 42 轮的工作全丢）
    obj = salvageDigestObject(text)
    salvaged = Boolean(obj)
    if (!obj) return null
  }
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
  const out = { summary: summaryText, sections, threads, entries }
  if (salvaged) {
    out.salvaged = true
    out.note = '输出被 maxTokens 截断，已从断点处抢救'
  }
  return out
}

/**
 * 调一次模型给一整天打分。
 * @param {{turns:Array, llm:any, provider:string, model:string, signal?:AbortSignal, maxTokens?:number}} input
 * @returns {Promise<Array>} 已校验的条目；拿不到就返回空数组（调用方退回规则分）
 */
export async function scoreDayWithLlm({ turns, llm, provider, model, signal, maxTokens, reasoningEffort, textByRef }) {
  if (!llm || typeof llm.stream !== 'function') return []
  if (!provider || !model) return []
  if (!Array.isArray(turns) || turns.length === 0) return []

  // 预算跟着轮数走：写死的 8000 在 40+ 轮时必然截断（2026-11-10 实测 42 轮被截）。
  const budget = Math.min(32000, Math.max(8000, maxTokens || 8000 + turns.length * 350))
  const prompt = buildScorePrompt(turns)
  const options = {
    provider,
    model,
    messages: [userMessage(prompt)],
    temperature: 0,
    maxTokens: budget,
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
    throw new Error(`模型没有返回任何内容（finish=${finish || '未知'}）：思考可能吃满了 ${budget} token 预算`)
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
    // 证据窗用**原文**（textByRef）；没有就退回纲要的头。
    // 纲要里没有 turn.user/turn.assistant —— 2026-11-10 踩过：
    // 写成那两个字段 ⇒ 永远取到空串 ⇒ 所有根因都被判「未核验」。
    const evidence = textByRef && textByRef.size > 0
      ? textByRef
      : new Map(turns.map((turn) => [turn.ref, [turn.userHead, turn.assistantHead].filter(Boolean).join(' ')]))
    verifyRootCauses(digest.entries, evidence)
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
