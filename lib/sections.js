/**
 * 四块结构的重建与兜底。
 *
 * 为什么单独放一个模块：`sectionsFromEntries` 需要被**收口**（close.js）与
 * **渲染**（render.js）同时使用，而 close.js 已经 import render.js ——
 * 放在一起会循环依赖。
 *
 * 为什么需要它（2026-11-10 审计 P1-8）：`sections` 是挂在数组上的元数据，
 * 任何一次 filter / 重建数组都可能把它丢掉。实测镜像里
 * `sections: {"2026-11-09": []}`，而 22/22 条目仍带 `section` 标签 ——
 * 于是从镜像重渲染会退化成平铺条目，**vault 重建不出来**。
 * 条目自己的 `section` 标签不会丢，用它可以无成本还原结构。
 */
import { readMaybe, writeAtomic } from './store.js'

export const SECTION_TITLES = [
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
 * @param {Array} entries
 * @returns {Array<{key:string,title:string,refs:string[],threads?:Array}>}
 */
export function sectionsFromEntries(entries) {
  const present = new Set((entries || []).map((entry) => entry.section).filter(Boolean))
  const out = []
  for (const [key, title] of SECTION_TITLES) {
    if (!present.has(key)) continue
    const refs = (entries || []).filter((entry) => entry.section === key).map((entry) => entry.ref).filter(Boolean)
    if (refs.length === 0) continue
    const section = { key, title, refs }
    if (key === 'threads') {
      const threads = new Map()
      for (const entry of (entries || []).filter((item) => item.section === 'threads')) {
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
 * 取某天的四块：优先用元数据，缺失则从条目标签重建。
 * @param {{day:string, entries:Array, sections?:Array, threads?:Array}} input
 */
export function resolveSections({ entries, sections, threads }) {
  if (Array.isArray(sections) && sections.length > 0) {
    return { sections, threads: Array.isArray(threads) ? threads : [] }
  }
  const rebuilt = sectionsFromEntries(entries)
  return { sections: rebuilt, threads: rebuilt.find((section) => section.key === 'threads')?.threads || [] }
}

/**
 * 校验证据是否还挂在当期编年层里。
 *
 * 为什么需要（审计 P1-6）：事实的 evidence 指向 `session-xxx#seq`，
 * 但重收口会整体重写周文件，那些 ref 可能已经不在里面 ——
 * 实测 3/16 条（19%）回源即断，违反设计原则「每条结论带证据，可回源核实」。
 */
export function markStaleEvidence(facts, liveRefs) {
  const alive = new Set(liveRefs || [])
  let stale = 0
  for (const fact of facts || []) {
    const refs = fact.evidence || []
    const missing = refs.filter((ref) => !alive.has(ref))
    fact.evidenceStale = missing.length > 0
    fact.evidenceMissing = missing
    if (fact.evidenceStale) stale += 1
  }
  return stale
}

/** 把判定结果写进索引与事实页。 */
export async function persistEvidenceCheck(dataDir, facts) {
  const path = `${dataDir}/facts/index.json`
  const raw = await readMaybe(path)
  if (!raw) return 0
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return 0
  }
  let stale = 0
  for (const fact of data.facts || []) {
    const target = (facts || []).find((item) => item.id === fact.id)
    if (!target) continue
    fact.evidenceStale = Boolean(target.evidenceStale)
    fact.evidenceMissing = target.evidenceMissing || []
    if (fact.evidenceStale) stale += 1
  }
  await writeAtomic(path, `${JSON.stringify(data, null, 2)}\n`)
  return stale
}
