/**
 * 脱敏：任何内容进磁盘**之前**必须过这里。
 *
 * 为什么前置而不是事后清理：一次会话里粘贴的 key 会被写进 Markdown，
 * 再被 gitCommit 提交、被同步盘带走。事后清理永远慢一步。
 *
 * 边界坑（务必保留）：`ak-` / `sk-` 必须带 `(?<![A-Za-z0-9])` 左边界，
 * 否则 `task-…`、`disk-…`、`…yml.bak` 会被误吃（dsh-living-memory 踩过）。
 */

const RULES = [
  {
    // Stripe 系用下划线不是连字符：sk_live_… / sk_test_… / rk_live_…
    // 2026-11-13 审计实测：`sk_live_51H…` 原样落盘（旧规则只认 `sk-`）
    name: 'stripe-key',
    re: /(?<![A-Za-z0-9])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  },
  {
    // HTTP Basic 凭据：Authorization: Basic dXNlcjpwYXNz…
    name: 'basic-auth',
    re: /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/gi,
  },
  {
    // URL 里的 userinfo：scheme://user:password@host
    // 必须排在 email 之前，否则 `default:s3cret@host` 会被 email 规则当成邮箱吃掉（归错类）
    name: 'url-userinfo',
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi,
  },
  {
    name: 'openai-key',
    re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}/g,
  },
  {
    name: 'volc-ak',
    re: /(?<![A-Za-z0-9])ak-[A-Za-z0-9_-]{6,}/g,
  },
  {
    name: 'github-token',
    re: /(?<![A-Za-z0-9])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
  },
  {
    name: 'aws-key-id',
    re: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  },
  {
    name: 'bearer',
    re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  },
  {
    name: 'jwt',
    re: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    name: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    // 关键修复（2026-11-10 审计）：原来关键字与分隔符之间不允许闭引号，
    // 而 JSON/YAML 的带引号键必然有 —— {"password": "…"} 会原样落盘并被 git 提交。
    // 现在允许闭引号，并补齐常见键名。
    name: 'credential-pair',
    re: /["']?\b(?:password|passwd|pwd|pass|api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|x-api-key|private[_-]?key|credential)s?["']?\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
  },
  {
    // 常见云厂商前缀（原来只有 sk-/ak-）
    name: 'vendor-key',
    re: /(?<![A-Za-z0-9])(?:AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|glpat-[0-9A-Za-z_-]{16,}|hf_[0-9A-Za-z]{20,}|npm_[0-9A-Za-z]{30,}|ASIA[0-9A-Z]{16})(?![A-Za-z0-9])/g,
  },
  {
    // 裸 UUID 形态的 AK/SK：火山这类厂商不发前缀，只能靠形态识别
    name: 'bare-uuid-key',
    re: /(?<![A-Za-z0-9-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9-])/gi,
  },
  {
    // Telegram bot token 形态
    name: 'telegram-token',
    re: /(?<![A-Za-z0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9])/g,
  },
  {
    name: 'phone-cn',
    re: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  },
  {
    name: 'id-cn',
    re: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g,
  },
  {
    name: 'email',
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
]

const REPLACEMENT = (name) => `«REDACTED:${name}»`

/**
 * 脱敏一段文本。
 * @returns {{text:string, hits:Record<string,number>, total:number}}
 */
export function redactText(input) {
  if (typeof input !== 'string' || input === '') return { text: input ?? '', hits: {}, total: 0 }
  let text = input
  const hits = {}
  for (const rule of RULES) {
    rule.re.lastIndex = 0
    let count = 0
    text = text.replace(rule.re, () => {
      count += 1
      return REPLACEMENT(rule.name)
    })
    if (count > 0) hits[rule.name] = (hits[rule.name] || 0) + count
  }
  const total = Object.values(hits).reduce((a, b) => a + b, 0)
  return { text, hits, total }
}

/** 深走对象里所有字符串。用于把一整条事件行一次过完。 */
export function redactDeep(value, acc = { hits: {}, total: 0 }) {
  if (typeof value === 'string') {
    const r = redactText(value)
    for (const [k, v] of Object.entries(r.hits)) acc.hits[k] = (acc.hits[k] || 0) + v
    acc.total += r.total
    return { value: r.text, hits: acc.hits, total: acc.total }
  }
  if (Array.isArray(value)) {
    const out = value.map((item) => redactDeep(item, acc).value)
    return { value: out, hits: acc.hits, total: acc.total }
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, acc).value
    return { value: out, hits: acc.hits, total: acc.total }
  }
  return { value, hits: acc.hits, total: acc.total }
}

export const RULE_NAMES = RULES.map((r) => r.name)
