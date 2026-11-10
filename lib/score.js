/**
 * 打分。
 *
 * 两档：
 *   A 档（P2）= ctx.llm 结构化打分
 *   B 档（本文件）= 纯规则，零成本、零外部依赖
 *
 * B 档为什么必须有：LLM 会 402、会超时、会换模型。没有规则兜底，
 * 一次故障就整天没有记录——而「记录缺失」比「记录平庸」更难被发现。
 */

/** 不可逆外部动作：这类一律 +2，是 5 分的主要来源。 */
const IRREVERSIBLE = [
  '发版', '发布', '上线', '部署', '推送', '合并', '删除', '清空', '付款', '扣款',
  'push', 'release', 'deploy', 'publish', 'rm -', 'git push', 'force',
]

/**
 * 决策味道：说明这轮有取舍，不是流水。
 * 注意别放单字/泛词——"候选矩阵"里的「选」曾把一句纯提问误判成决策（P1 实测）。
 */
const DECISION = [
  '决定', '定稿', '拍板', '就按这个', '确认', '改成', '换方案', '方案改', '定方案',
  '取舍', '不做', '选择', '选了', '选哪个', '结论', '定下', '定了', '定了没',
]

/** 踩坑味道。 */
const PITFALL = ['报错', '坑', '失败', '踩', '崩', '异常', '不生效', '回退', '修不', 'error', 'traceback', 'bug']

/** 交付味道。 */
const DELIVERY = ['完成', '交付', '修好', '通了', '跑通', '全绿', '验收', '已修', '生效']

/** 调查味道。 */
const RESEARCH = ['查', '搜', '对比', '研究', '调研', '评估', '看看', '有没有']

/** 寒暄：这类不要单独成条。 */
const CHITCHAT = ['你好', '谢谢', '继续', '好的', '嗯', '在吗', '收到', 'ok', 'hello', 'hi']

function hits(text, words) {
  const lower = String(text || '').toLowerCase()
  let n = 0
  const found = []
  for (const w of words) {
    if (lower.includes(w.toLowerCase())) {
      n += 1
      found.push(w)
    }
  }
  return { n, found }
}

function pickKind(signals) {
  if (signals.irreversible.n > 0) return 'delivery'
  if (signals.decision.n > 0) return 'decision'
  if (signals.pitfall.n > 0) return 'pitfall'
  if (signals.delivery.n > 0) return 'delivery'
  if (signals.research.n > 0) return 'research'
  return 'chore'
}

/** 去掉 markdown 噪音：代码块、行内代码、加粗、链接、多余空白。 */
export function sanitizeText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 标题：优先用用户那句话的主句；但用户常说"已经重启""继续"这种**极短且无信息**的话，
 * 直接拿来做标题会得到一串 "★3 已经重启"（v0.2.3 现场实测就这样）。
 * 这时回退到"这一轮实际动了什么"：改过的文件名 > 主力工具名。
 */
const GENERIC_INPUT = /^(已经|好的|继续|可以|嗯+|ok|okay|行|收到|重启|重新启动|再试|试试|开始)[。！？.!?\s]*$/i

function basename(path) {
  return String(path || '').split(/[\\/]/).pop() || ''
}

function makeTitle(turn) {
  const raw = sanitizeText(turn.userHead)
  const cut = raw ? (raw.split(/[。！？!?\n]/)[0].trim() || raw) : ''
  const informative = cut.length >= 8 && !GENERIC_INPUT.test(cut)

  if (!informative) {
    const file = basename((turn.files || [])[0])
    if (file) return `改 ${file}`
    const tools = turn.tools || []
    if (tools.length > 0) return `${tools[0]}（${tools.length} 次工具调用）`
    const assistant = sanitizeText(turn.assistantHead)
    if (assistant) {
      const head = assistant.split(/[。！？!?\n]/)[0].trim()
      if (head) return head.length > 34 ? `${head.slice(0, 33)}…` : head
    }
    if (cut) return cut
    return '（无用户输入的一轮）'
  }
  return cut.length > 34 ? `${cut.slice(0, 33)}…` : cut
}

function makeClaim(turn) {
  const head = sanitizeText(turn.userHead)
  const generic = !head || head.length < 8 || GENERIC_INPUT.test(head)
  if (generic) {
    const assistant = sanitizeText(turn.assistantHead)
    if (assistant) {
      const first = assistant.split(/[。！？!?\n]/)[0].trim()
      if (first) return first.length > 80 ? `${first.slice(0, 79)}…` : first
    }
  }
  if (!head) return ''
  return head.length > 80 ? `${head.slice(0, 79)}…` : head
}

/**
 * 给一轮纲要打规则分。
 * @returns {{ref,title,claim,importance,kind,signals,basis}}
 */
/**
 * kind → section 映射。
 *
 * 为什么需要（2026-11-10 审计 P0-5）：默认档位是 rule，而 ruleScore 不产出 section，
 * factsOfDay 只认 section 白名单 ⇒ 事实库在**默认配置**下永远是空的，
 * 且结构自检不告警（因为 labelled===0）——一份看起来成功的空产物。
 */
export function sectionOfKind(kind) {
  if (kind === 'decision') return 'decisions'
  if (kind === 'pitfall') return 'pitfalls'
  if (kind === 'delivery') return 'projects'
  return 'threads'
}

export function ruleScore(turn) {
  const text = [turn.userHead, turn.assistantHead].filter(Boolean).join(' ')
  const signals = {
    irreversible: hits(text, IRREVERSIBLE),
    decision: hits(text, DECISION),
    pitfall: hits(text, PITFALL),
    delivery: hits(text, DELIVERY),
    research: hits(text, RESEARCH),
    chitchat: hits(turn.userHead, CHITCHAT),
  }

  const files = Array.isArray(turn.files) ? turn.files.length : 0
  const tools = Array.isArray(turn.tools) ? turn.tools.length : 0
  const failures = turn.failures || 0

  let score = 2
  const basis = []
  if (signals.irreversible.n > 0) {
    score += 2
    basis.push(`不可逆动作(${signals.irreversible.found.slice(0, 2).join('/')})`)
  }
  if (files > 0) {
    score += 1
    basis.push(`改动 ${files} 个文件`)
  }
  if (failures >= 3) {
    score += 1
    basis.push(`${failures} 次工具失败`)
  }
  if (signals.decision.n > 0) {
    score += 1
    basis.push('含决策表述')
  }
  // 纯寒暄压到 1；没有任何工具、也没文件的短轮 ≤2
  const onlyChitchat =
    signals.chitchat.n > 0 &&
    (turn.userChars || 0) <= 12 &&
    tools === 0 &&
    !turn.assistantHead
  if (onlyChitchat) {
    score = 1
    basis.push('寒暄')
  } else if (tools === 0 && files === 0 && (turn.userChars || 0) <= 20) {
    score = Math.min(score, 2)
    basis.push('短轮无产出')
  }

  score = Math.max(1, Math.min(5, score))

  return {
    ref: turn.ref,
    ts: turn.ts || '',
    title: makeTitle(turn),
    claim: makeClaim(turn),
    importance: score,
    kind: pickKind(signals),
    // section：规则档也必须给，否则 factsOfDay 只认 5 个 section → 事实库永远为空。
    // 映射按 kind 走，与 LLM 档的六块语义一致。
    section: sectionOfKind(pickKind(signals)),
    // 归属：工作区。跨工作区汇总时靠它分组与打标签
    ws: turn.ws || 'unknown',
    // 图用它做实体回退（LLM 模式会有 entities，规则模式只有文件基名）
    files: Array.isArray(turn.files) ? turn.files.slice(0, 4) : [],
    signals: {
      irreversible: signals.irreversible.n,
      decision: signals.decision.n,
      pitfall: signals.pitfall.n,
      delivery: signals.delivery.n,
      research: signals.research.n,
      chitchat: signals.chitchat.n,
      files,
      tools,
      failures,
    },
    basis: basis.join(' · '),
  }
}

/** "2026-11-09T20:21:02+08:00" → "20:21"。 */
function hhmm(ts) {
  const m = /T(\d{2}:\d{2})/.exec(String(ts || ''))
  return m ? m[1] : '--:--'
}

/** 整天打分 + 排序（重要度降序，同级按时间正序）。 */
export function scoreDay(turns) {
  const scored = turns.map(ruleScore)
  scored.sort((a, b) => b.importance - a.importance || (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.ref < b.ref ? -1 : 1))

  // 同一天出现同名标题时（例如连续几轮都在改同一个文件），用时间戳区分，
  // 否则周文件里会出现三条一模一样的 "★3 改 doctor.js"。
  const seen = new Map()
  for (const entry of scored) {
    const count = (seen.get(entry.title) || 0) + 1
    seen.set(entry.title, count)
    if (count > 1) entry.title = `${entry.title}（${hhmm(entry.ts)}）`
  }
  return scored
}
