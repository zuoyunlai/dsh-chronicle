/**
 * 面板图表用的聚合（纯函数，不碰 DOM、不碰文件）。
 *
 * 为什么放在宿主侧：client.js 是浏览器模块，import 不到 lib/；
 * 而且聚合写成纯函数才能用 node --test 验数值，不用引 DOM 环境。
 *
 * 取舍依据（2026-11-09 评审）：语料只有 1 天时趋势图是装饰，
 * 所以优先做横截面：事实构成 + 缺口；趋势图排第二但要能表达"断档"。
 */

const FILL_CHECKS = {
  pitfall: (fact) => Boolean(fact.detector) && !/暂无明确信号/.test(String(fact.detector)),
  decision: (fact) => Boolean(fact.expiresWhen) && !/未设定/.test(String(fact.expiresWhen)),
  convention: () => true,
  rejected: () => true,
  // 疑问默认算「债」：它既没有判别信号也没有重评条件，答完之前都是缺口
  question: () => false,
}

const LABELS = {
  pitfall: '坑',
  decision: '决策',
  convention: '约定',
  rejected: '被否',
  question: '疑问',
}

/**
 * 事实构成横条：每类一行，条内左段=可用（有判别信号/失效条件）、右段=缺口。
 * @returns {{rows:Array, total:number, debt:number, headline:string}}
 */
export function factsBars(facts) {
  const rows = []
  let total = 0
  let debt = 0
  for (const kind of Object.keys(FILL_CHECKS)) {
    const list = (facts || []).filter((fact) => fact.kind === kind)
    if (list.length === 0) continue
    const filled = list.filter((fact) => FILL_CHECKS[kind](fact)).length
    const hits = list.reduce((sum, fact) => sum + (Number(fact.hits) || 0), 0)
    total += list.length
    debt += list.length - filled
    rows.push({ kind, label: LABELS[kind], total: list.length, filled, gap: list.length - filled, hits })
  }
  const max = rows.reduce((value, row) => Math.max(value, row.total), 1)
  for (const row of rows) row.ratio = row.total / max

  const questionGap = rows.find((row) => row.kind === 'question')?.gap || 0
  const headline =
    debt === 0
      ? `无认知债：${total} 条事实都带判别信号或重评条件`
      : `${debt} 条认知债（${Math.round((debt / Math.max(1, total)) * 100)}%）` +
        (questionGap > 0 ? `，其中 ${questionGap} 条是悬而未决的疑问` : '')
  return { rows, total, debt, headline }
}

/**
 * 近 N 天条目堆叠柱。
 * 0 条的那天也要占位——「没干活」和「没数据」必须能区分开。
 */
export function dailyBuckets(entries, { days = 14, now = Date.now(), window: win } = {}) {
  const span = win === 'week' ? 7 : days
  const dayKeys = []
  const cursor = new Date(now)
  for (let index = span - 1; index >= 0; index -= 1) {
    const date = new Date(cursor.getTime() - index * 86400000)
    dayKeys.push(
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    )
  }
  const buckets = new Map(dayKeys.map((day) => [day, { day, projects: 0, decisions: 0, pitfalls: 0, questions: 0, others: 0, total: 0 }]))
  for (const entry of entries || []) {
    const bucket = buckets.get(String(entry.day))
    if (!bucket) continue
    const section = entry.section || ''
    if (section === 'projects') bucket.projects += 1
    else if (section === 'decisions') bucket.decisions += 1
    else if (section === 'pitfalls') bucket.pitfalls += 1
    else if (section === 'questions') bucket.questions += 1
    else bucket.others += 1
    bucket.total += 1
  }
  const list = [...buckets.values()]
  const max = list.reduce((value, item) => Math.max(value, item.total), 1)
  return { days: list, max, total: list.reduce((sum, item) => sum + item.total, 0), span }
}

/** 线索跨度：只看 ≥2 天的，和堆叠柱共用同一条日轴。 */
export function arcBars(arcs, { limit = 5 } = {}) {
  const list = (arcs || [])
    .filter((arc) => Array.isArray(arc.days) && arc.days.length >= 2)
    .sort((a, b) => b.days.length - a.days.length)
  return { rows: list.slice(0, limit), rest: Math.max(0, list.length - limit) }
}

/** 一个端点给齐三张图，省得面板连发四次请求。 */
export function buildViz({ facts, entries, arcs, days = 14, now = Date.now() }) {
  return {
    facts: factsBars(facts),
    daily: dailyBuckets(entries, { days, now }),
    arcs: arcBars(arcs),
  }
}
