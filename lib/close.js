/**
 * 收口：一天 → 一份周文件。
 *
 * 顺序（每一步失败都不留半成品）：
 *   读事件 → 纲要 → 打分 → 汇总本周所有已收口的天 → 渲染 → 原子写 → 可选 git commit
 *
 * 幂等：渲染只依赖（事件集合, promptVersion, floor）。同样的输入 ⇒ 逐字节同样的文件。
 * 不可变：默认不覆盖已存在的**不同 promptVersion** 的文件，而是把旧的改名留档。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

import { buildTurns, summarizeOutline, buildTurnTextIndex } from './outline.js'
import { scoreDay } from './score.js'
import { renderWeek } from './render.js'
import { buildDayGraph, writeDayGraph, mergeGraph } from './entities.js'
import { factsOfDay, persistFacts, renderFactPage } from './facts.js'
import { buildArcs, persistArcs } from './arcs.js'
import { readScoreCache, writeScoreCache } from './scorecache.js'
import { persistEntityPages } from './entitypages.js'
import { readEvents, listEventDays, writeAtomic, weekFilePath, exists, readMaybe, readJson, ensureVault, ensureDir } from './store.js'
import { weekId, dayKey } from './time.js'

const run = promisify(execFile)

/**
 * 某一天 → 打好的分。
 * @param {{dataDir:string, day:string, enhance?:(ctx:{turns:Array, ruleEntries:Array})=>Promise<Array>, promptVersion?:string}} input
 *   `enhance` 由宿主侧注入（P2 的 LLM 打分）；它抛错或返回空就**静默退回规则分**。
 *   `promptVersion` 给定时启用 LLM 打分缓存：收口 D 不再对本周其它天重复调模型
 *   （审计 P1-13：原来每次收口重算整周，成本 O(天数²) 且温度会改写已提交内容）。
 */
export async function scoreOneDay({ dataDir, day, enhance, promptVersion }) {
  const { rows, badLines } = await readEvents(dataDir, day)
  const turns = buildTurns(rows)
  let entries = scoreDay(turns)
  let scoring = 'rule'

  if (typeof enhance === 'function' && entries.length > 0) {
    // 缓存命中 ⇒ 不调模型。事件集变了缓存自动作废（回捞补了新会话时）。
    let cached = null
    if (promptVersion) {
      const liveRefs = entries.map((entry) => entry.ref)
      cached = await readScoreCache(dataDir, day, promptVersion, liveRefs)
    }
    if (cached) {
      assignProjects(cached, cached.filter((entry) => entry.section === 'projects').map((entry) => entry.title))
      entries = mergeProjects(cached, cached.sections)
      scoring = 'llm'
    } else {
      try {
      const ruleByRef = new Map(entries.map((entry) => [entry.ref, entry]))
      // 把**原文索引**一起传下去：核验根因要用全文。
      // 纲要只有每轮的头 300 字，命中率不够（2026-11-11 实测 45% < 50% 阈值 ⇒ 误判「原文无据」）。
      const enhanced = await enhance({
        turns,
        ruleEntries: entries,
        textByRef: buildTurnTextIndex(rows),
      })
      if (Array.isArray(enhanced) && enhanced.length > 0) {
        const tsByRef = new Map(turns.map((turn) => [turn.ref, turn.ts]))
        const mapped = enhanced
          .map((entry) => ({
            ...entry,
            ts: tsByRef.get(entry.ref) || ruleByRef.get(entry.ref)?.ts || '',
            // 归属不能丢：LLM 只给标题与结论，工作区来自规则那一轮
            ws: entry.ws || ruleByRef.get(entry.ref)?.ws || 'unknown',
            // 归属标签：模型没给 project 时退回工作区名，保证每条都有可点的标签
            project:
              entry.project ||
              ruleByRef.get(entry.ref)?.project ||
              entry.ws ||
              ruleByRef.get(entry.ref)?.ws ||
              'unknown',
            // LLM 没给文件时用规则那轮的文件，图不掉信息
            files: Array.isArray(entry.files) && entry.files.length > 0 ? entry.files : ruleByRef.get(entry.ref)?.files || [],
          }))
          .sort((a, b) => b.importance - a.importance || (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
        mapped.summary = typeof enhanced.summary === 'string' ? enhanced.summary : ''
        mapped.threads = Array.isArray(enhanced.threads) ? enhanced.threads : []
        mapped.sections = Array.isArray(enhanced.sections) && enhanced.sections.length > 0 ? enhanced.sections : sectionsFromEntries(mapped)
        // 项目名来自「项目进展」板块；用它给漏填 project 的条目做机械归属
        assignProjects(
          mapped,
          mapped.filter((entry) => entry.section === 'projects').map((entry) => entry.title),
        )
        // 同项目多阶段合并成一条（否则"今天 9 个项目"）
        entries = mergeProjects(mapped, mapped.sections)
        scoring = 'llm'
        // 命中缓存则跳过；新算的写进缓存，下次收口本周其它天不再调模型
        if (promptVersion) {
          mapped.scoring = 'llm'
          await writeScoreCache(dataDir, day, promptVersion, mapped).catch(() => {})
        }
      }
      } catch {
        scoring = 'rule-fallback'
      }
    }
  }

  return {
    day,
    entries,
    scoring,
    summary: entries.summary || '',
    threads: entries.threads || [],
    sections: entries.sections || [],
    stats: { ...summarizeOutline(turns), rows: rows.length, badLines },
  }
}

/**
 * 项目归属兜底：模型经常漏填 `project`，一漏就全退成工作区名，
 * 于是 19 条记录全挂 `#default-workspace`，项目标签等于白做（2026-11-09 实测）。
 *
 * 这里做机械匹配：拿「项目进展」里给出的项目名，去条目的标题/结论/依据/实体里找；
 * 命中就以项目名归属，全都不命中才退回工作区名。
 */
export function assignProjects(entries, projectNames) {
  const names = (Array.isArray(projectNames) ? projectNames : []).map((name) => String(name || '').trim()).filter(Boolean)
  if (names.length === 0 || !Array.isArray(entries)) return entries
  const lower = names.map((name) => [name, name.toLowerCase()])

  // 第二轮要用：某个工作区当天只出现一个项目时，该工作区的记录都归它
  const projectsByWorkspace = new Map()
  for (const entry of entries) {
    if (entry.section !== 'projects') continue
    const ws = entry.ws || 'unknown'
    if (!projectsByWorkspace.has(ws)) projectsByWorkspace.set(ws, new Set())
    projectsByWorkspace.get(ws).add(entry.title)
  }

  for (const entry of entries) {
    const current = String(entry.project || '').trim()
    const alreadyValid = lower.some(([, key]) => key === current.toLowerCase())
    if (alreadyValid) continue

    const haystack = [entry.title, entry.claim, entry.basis, ...(entry.entities || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()

    let best = ''
    let bestScore = 0
    for (const [name, key] of lower) {
      let score = 0
      if (haystack.includes(key)) score += 3
      for (const part of key.split(/[-_\s]+/).filter((piece) => piece.length >= 3)) {
        if (haystack.includes(part)) score += 1
      }
      if (score > bestScore) {
        bestScore = score
        best = name
      }
    }

    // 第二轮：本文没提到项目名，但该工作区当天只有一个项目 ⇒ 归它
    if (!best) {
      const candidates = projectsByWorkspace.get(entry.ws || 'unknown')
      if (candidates && candidates.size === 1) best = [...candidates][0]
    }

    entry.project = best || entry.ws || 'unknown'
  }
  return entries
}

/**
 * 项目条目按名字合并：同一个项目当天只保留一条。
 *
 * 实测（2026-11-09）：模型把 P0/P1/P2/P3/P4 每个阶段都当成一条"项目进展"，
 * 于是「今天 9 个项目」——实际只有 2 个。项目数虚高会污染注入行与标签统计。
 * 合并时把各阶段进展用「；」拼起来，信息不丢。
 */
export function mergeProjects(entries, sections) {
  if (!Array.isArray(entries)) return entries
  const byName = new Map()
  const keep = new Set()

  for (const entry of entries) {
    if (entry.section !== 'projects') continue
    const key = String(entry.title || '').toLowerCase().trim()
    if (!key) continue
    const existing = byName.get(key)
    if (!existing) {
      byName.set(key, entry)
      keep.add(entry.ref)
      continue
    }
    const parts = [existing.claim, entry.claim].filter(Boolean).join('；')
    existing.claim = [...new Set(parts.split('；').map((piece) => piece.trim()).filter(Boolean))].join('；')
  }

  for (const section of sections || []) {
    if (section && section.key === 'projects') section.refs = [...keep]
  }
  const filtered = entries.filter((entry) => entry.section !== 'projects' || keep.has(entry.ref))
  // 数组上挂的元数据（日结 / 四块）必须带过去：
  // filter() 返回的是新数组，丢掉 summary 与 sections 会让渲染退回平铺条目（实测踩过）
  if (entries.summary) filtered.summary = entries.summary
  if (entries.threads) filtered.threads = entries.threads
  if (Array.isArray(entries.sections)) filtered.sections = entries.sections
  return filtered
}

const SECTION_TITLES = [
  ['projects', '项目进展'],
  ['decisions', '结论与决策'],
  ['conventions', '约定与口径'],
  ['pitfalls', '坑与根因'],
  ['rejected', '被否方案'],
  ['questions', '未答问题'],
  ['threads', '其余进展'],
]

/**
 * 从条目的 `section` 标签重建四块。
 *
 * 为什么需要这道兜底：`sections` 是挂在数组上的元数据，任何一次
 * filter/重建数组都可能把它丢掉（0.11.0 实测：mergeProjects 用 filter 返回新数组，
 * 结果整份周文件退回平铺条目，日结也没了）。条目自己的 section 标签不会丢，
 * 用它可以无成本还原结构。
 */
export function sectionsFromEntries(entries) {
  const present = new Set((entries || []).map((entry) => entry.section).filter(Boolean))
  const out = []
  for (const [key, title] of SECTION_TITLES) {
    if (!present.has(key)) continue
    const refs = entries.filter((entry) => entry.section === key).map((entry) => entry.ref).filter(Boolean)
    if (refs.length === 0) continue
    const section = { key, title, refs }
    if (key === 'threads') {
      const threads = new Map()
      for (const entry of entries.filter((item) => item.section === 'threads')) {
        const name = entry.thread || '其余'
        if (!threads.has(name)) threads.set(name, [])
        threads.get(name).push(entry.ref)
      }
      section.threads = [...threads].map(([name, list]) => ({ title: name, why: '', refs: list }))
    }
    out.push(section)
  }
  return out
}

/**
 * 结构自检：收口产物退化了要喊出来，不能静默降级。
 *
 * 为什么需要：0.11.0 因为 filter() 丢元数据，整份周文件退回平铺条目，
 * 但**文件照样生成、git 照样提交**——从外部看一切都是成功的。
 * 这类"出错的现象比正常更像正常"的故障，只能靠产物自检发现。
 */
export function structureWarnings(days) {
  const warnings = []
  for (const day of days || []) {
    const labelled = (day.entries || []).filter((entry) => entry.section).length
    const total = (day.entries || []).length
    if (total === 0) continue
    if (labelled > 0 && (!Array.isArray(day.sections) || day.sections.length === 0)) {
      warnings.push(`${day.day}：条目都有 section 标签，但四块为空 —— 渲染会退回平铺条目`)
    }
    if (!day.summary) warnings.push(`${day.day}：缺日结（summary 为空）`)
    const covered = new Set()
    for (const section of day.sections || []) for (const ref of section.refs || []) covered.add(ref)
    const orphan = (day.entries || []).filter(
      (entry) => entry.section && entry.section !== 'threads' && !covered.has(entry.ref),
    ).length
    if (orphan > 0 && Array.isArray(day.sections) && day.sections.length > 0) {
      warnings.push(`${day.day}：${orphan} 条有类型的条目没被任何板块收录`)
    }
  }
  return warnings
}

/**
 * 周文件里应包含哪些天：同一周、已经有事件、且**不晚于收口目标天**。
 *
 * `<= today` 这条约束是 2026-11-13 补的（审计之后复跑时发现）：
 * 原来只判「同一周」，于是收口 11-12 时会把**还没过完的今天**（11-13）
 * 连同它当时的半截事件一起写进周文件 —— 实测重收 11-12 后镜像 `days` 里
 * 多出 2026-11-13、最大 ts 是当天的 19:38。方案 B 的第一条就是「永远不收今天」。
 */
export async function daysOfWeek(dataDir, week, today) {
  const all = await listEventDays(dataDir)
  const wanted = []
  for (const day of all) {
    if (day > today) continue
    const ms = new Date(`${day}T12:00:00`).getTime()
    if (weekId(ms) === week) wanted.push(day)
  }
  // 当天即使还没落盘也允许出现（供手动触发）
  if (!wanted.includes(today)) {
    const ms = new Date(`${today}T12:00:00`).getTime()
    if (weekId(ms) === week) wanted.push(today)
  }
  return wanted.sort()
}

/**
 * 「证据是否还在」的宇宙：**磁盘上的事件流** ∪ 当期条目 ref。
 *
 * 只取当期条目会误判（2026-11-13 实测：重收后 stale 21→26，而 27 个 ref 全在事件库里）——
 * 模型漏归组、低分折叠、条目被 merge 都会让仍可回源的证据被判悬空。
 *
 * 成本：事件文件约 4.6 ms/MB·天，只看最近 `maxDays` 天；读不出来的天跳过（保守：不判悬空）。
 *
 * @param {string} dataDir
 * @param {Array<{entries:Array}>} days 当期条目（其中也有 ref，一并计入）
 * @param {{maxDays?:number}} [options]
 * @returns {Promise<Set<string>>}
 */
export async function collectAliveRefs(dataDir, days, options = {}) {
  const alive = new Set()
  for (const d of days || []) for (const e of d.entries || []) if (e.ref) alive.add(e.ref)
  const maxDays = Number(options.maxDays) > 0 ? Number(options.maxDays) : 30
  try {
    const eventDays = await listEventDays(dataDir)
    for (const day of eventDays.slice(-maxDays)) {
      try {
        const read = await readEvents(dataDir, day)
        for (const row of read.rows) alive.add(`${row.sid}#${row.seq}`)
      } catch {
        /* 单天读不出来就跳过：宁可漏判悬空，也不要误标 */
      }
    }
  } catch {
    /* 事件目录都读不到就只用条目 ref：此时不新增任何悬空标记之外的行为 */
  }
  return alive
}

/** vault 是否已是 git 仓库；不是就初始化一次（只本地，绝不 push）。 */async function ensureGitRepo(vaultDir) {
  if (await exists(join(vaultDir, '.git'))) return true
  try {
    await run('git', ['init'], { cwd: vaultDir })
    return true
  } catch {
    return false
  }
}

async function gitCommitVault(vaultDir, week) {
  try {
    if (!(await ensureGitRepo(vaultDir))) return { committed: false, reason: 'git-unavailable' }
    await run('git', ['add', '-A'], { cwd: vaultDir })
    // 没有变更时 commit 会非零退出 —— 那是正常情况，不是错误
    await run('git', ['commit', '-m', `chronicle: ${week}`], { cwd: vaultDir })
    return { committed: true }
  } catch (error) {
    const message = String(error?.stderr || error?.message || '')
    if (/nothing to commit|no changes added/i.test(message)) return { committed: false, reason: 'no-changes' }
    return { committed: false, reason: 'git-failed', message: message.slice(0, 200) }
  }
}

/**
 * 收口某一天。
 * @returns {{closed:boolean, reason?:string, week?:string, path?:string, entries?:number, git?:object}}
 */export async function closeDay({
  dataDir,
  vaultDir,
  day,
  floor = 3,
  promptVersion = 'v1',
  gitCommit = false,
  enhance,
  factsThrough,
  entityRule = 'on-hit',
  entityMinScore = 4,
}) {
  const scored = await scoreOneDay({ dataDir, day, enhance, promptVersion })
  if (scored.entries.length === 0) {
    // 带上 day：否则调用方只能显示「（undefined）」
    return { closed: false, reason: 'no-events', day, entries: 0 }
  }

  const week = weekId(new Date(`${day}T12:00:00`).getTime())
  const weekDays = await daysOfWeek(dataDir, week, day)
  const days = []
  for (const d of weekDays) {
    const one = d === day ? scored : await scoreOneDay({ dataDir, day: d, enhance, promptVersion })
    if (one.entries.length > 0) {
      days.push({ day: d, entries: one.entries, summary: one.summary || '', threads: one.threads || [], sections: one.sections || [] })
    }
  }

  // 图：先写各天快照（同一天覆盖 ⇒ 幂等），再整体合并
  let graph = null
  try {
    for (const d of days) {
      await writeDayGraph(dataDir, buildDayGraph({ day: d.day, entries: d.entries }))
    }
    graph = await mergeGraph(dataDir)
  } catch {
    graph = null // 图坏了不该拖住日报
  }

  // 事实层与跨天线索：从当天的四块里提炼「不随日期过期」的东西
  let facts = null
  let arcs = null
  let entityPages = null
  try {
    // 事实提炼的输入 = 被收口那一天。
    //
    // 历史上这里还要顺带重提 D-1（审计 P0-6）：因为收口在 23:50 触发、
    // 事件却写到 24:00，当天最后 10 分钟永远进不了事实库。
    //
    // 2026-11-10 方案 B 之后这个补丁**不再需要**：
    // 收口只在跨过午夜后才发生，那一天已经完整结束，不存在「之后才写进来的事件」。
    // 删掉补丁同时消除两个隐患：重复提炼同一批事件、以及依赖 D-1 存在的隐式前提。
    const incoming = factsOfDay({ day, entries: scored.entries })
    if (incoming.length > 0) {
      const generatedAt = new Date().toISOString()
      const persisted = await persistFacts({ dataDir, vaultDir, incoming, generatedAt })
      // 线索要用合并后的事实（同一条在多个日子出现才算线索）
      const allFacts = await import('./facts.js').then((mod) => mod.readFacts(dataDir))
      arcs = await persistArcs({ dataDir, vaultDir, facts: allFacts, generatedAt })
      // 证据悬空检查：事实的 ref 可能已不在当期编年层里（重收口会重写周文件）。
      //
      // 2026-11-13 复跑发现的关键点：**判据不能取「当期周文件的条目」**。
      // 实测重收 11-12 后 stale 从 21 涨到 26，而 27 个 ref 全部能在 events/ 里找到 ——
      // 模型漏归组、低分折叠、条目被 merge 掉都会让仍然可回源的证据被判成「悬空」。
      // 「证据还在不在」的宇宙是**事件流**，不是当期摘要。
      const liveRefs = await collectAliveRefs(dataDir, days)
      const { markStaleEvidence } = await import('./sections.js')
      // 纪传体落地：entityRule 配置终于有消费者了（审计 P1-1）
      // C2（2026-11-13 产品反哺）：纪传体冻结 —— 默认不再生成实体页。
      // 实测 28 个实体页里 20 个是源码文件名，信息增益低于维护成本；
      // 图谱（graph/）仍然照写，面板的只读可视化不受影响。
      // 想恢复：把 entityRule 设成 'on-hit' / 'score' / 'always'。
      if (String(entityRule) === 'off') {
        entityPages = { pages: 0, frozen: true }
      } else {
        try {
          entityPages = await persistEntityPages({
            dataDir,
            vaultDir,
            rule: entityRule,
            minScore: entityMinScore,
            // 不传 graph：mergeGraph() 返回的是统计摘要（数字），不是节点列表。
            // persistEntityPages 自己从 graph/entities.json 读（2026-11-10 修）
            entries: days.flatMap((item) => item.entries),
          })
        } catch {
          entityPages = null // 实体页失败不拖住收口
        }
      }
      markStaleEvidence(allFacts, liveRefs)
      // 无条件回写（含 stale===0）：只在 stale>0 时写，会让「曾经悬空、后来补回证据」的
      // 事实永久带着假标记（2026-11-13 审计 P1-2：实测 21/75 条误标，refs 实际全在）。
      {
        const { persistEvidenceCheck } = await import('./sections.js')
        await persistEvidenceCheck(dataDir, allFacts, { vaultDir, renderPage: renderFactPage })
      }
      facts = persisted
    }
  } catch {
    facts = null // 事实层坏了不该拖住日报
  }

  const warnings = structureWarnings(days)

  const entityNames = await topEntityNames(dataDir, 8)
  const markdown = renderWeek({ weekId: week, days, floor, promptVersion, entities: entityNames })
  await ensureVault(vaultDir)
  const target = weekFilePath(vaultDir, week)

  // 机器可读镜像：检索不必去解析 Markdown（P3 的检索源）
  try {
    const mirror = {
      v: 1,
      week,
      promptVersion,
      days: days.map((d) => d.day),
      // 日结与线索一起进镜像：面板直接读，不必解析 Markdown
      summaries: Object.fromEntries(days.map((d) => [d.day, d.summary || ''])),
      threads: Object.fromEntries(days.map((d) => [d.day, d.threads || []])),
      sections: Object.fromEntries(days.map((d) => [d.day, d.sections || []])),
      entries: days.flatMap((d) => d.entries.map((entry) => ({ ...entry, day: d.day }))),
    }
    await ensureDir(join(dataDir, 'index'))
    await writeAtomic(join(dataDir, 'index', `${week}.json`), `${JSON.stringify(mirror, null, 2)}\n`)
  } catch {
    /* 镜像写失败不该拖住日报 */
  }

  // 已存在且 promptVersion 不同 ⇒ 旧文件改名留档，不原地覆盖历史口径。
  // 2026-11-13 审计 P2：原条件写作 `promptVersion !== 'v1'`，于是把口径降回 v1 时会
  // 直接覆盖掉 `.v2.md` 之前的那一版 —— 归档要按「两版不同」判，不按「新的是不是 v1」判。
  const previous = await readMaybe(target)
  if (previous) {
    const m = /^prompt:\s*(\S+)/m.exec(previous)
    const prevVersion = m ? m[1] : null
    if (prevVersion && prevVersion !== promptVersion) {
      await writeAtomic(join(vaultDir, 'chronicle', `${week}.${prevVersion}.md`), previous)
    }
  }

  await writeAtomic(target, markdown)

  let git = null
  if (gitCommit) git = await gitCommitVault(vaultDir, week)

  return {
    closed: true,
    week,
    path: target,
    day,
    entries: scored.entries.length,
    daysIncluded: days.length,
    scoring: scored.scoring,
    stats: scored.stats,
    graph,
    // 这几个可能是 null（git 关着、facts/arcs/实体页失败）。
    // 工具 output.schema 声明它们是 object，返回 null 会让宿主在**干完活之后**
    // 才报 `invalid output` —— 用户看到的是"报错了"，其实文件已经写好。
    entityPages: entityPages || {},
    facts: facts || {},
    arcs: arcs || {},
    warnings,
    entities: entityNames,
    git: git || {},
  }
}

/** 读合并后的图，取提及最多的实体名（写进 frontmatter，Obsidian 侧可直接按实体筛）。 */
async function topEntityNames(dataDir, limit) {
  const data = await readJson(join(dataDir, 'graph', 'entities.json'), null)
  const list = Array.isArray(data?.entities) ? data.entities : []
  return list.slice(0, limit).map((entity) => entity.name).filter(Boolean)
}

/** 供手动触发/调试：某天打了多少分、多少条。 */
export async function previewDay({ dataDir, day }) {
  const scored = await scoreOneDay({ dataDir, day })
  return {
    day,
    stats: scored.stats,
    top: scored.entries.slice(0, 5).map((e) => ({ importance: e.importance, title: e.title, ref: e.ref, kind: e.kind })),
  }
}

export { dayKey }
