/**
 * LLM 打分结果的磁盘缓存。
 *
 * 为什么需要（2026-11-10 审计 P1-13）：收口任意一天时，本周其它每天都被
 * 重新调用一次 LLM（close.js 的 daysOfWeek 循环）。模型有温度，
 * 重打分结果可能不同 → 已提交的周文件被改写；成本 O(天数²)。
 *
 * 缓存键 = (day, promptVersion)。prompt 版本变了自然全部失效。
 * 目录：dataDir/cache/score-<day>-<promptVersion>.json
 */
import { join } from 'node:path'
import { readMaybe, writeAtomic } from './store.js'

function cachePath(dataDir, day, promptVersion) {
  return join(dataDir, 'cache', `score-${day}-${promptVersion}.json`)
}

/**
 * 读缓存。命中返回数组（带挂载的 summary/sections 元数据），未命中返回 null。
 * 校验缓存的 ref 集是否与当期事件一致——事件变了（回捞补了新会话）缓存作废。
 */
export async function readScoreCache(dataDir, day, promptVersion, liveRefs) {
  const text = await readMaybe(cachePath(dataDir, day, promptVersion))
  if (!text) return null
  try {
    const data = JSON.parse(text)
    if (!Array.isArray(data.entries)) return null
    // 事件集变了就作废：缓存是「这一天打过分」的承诺，不是永久真理
    if (Array.isArray(liveRefs) && liveRefs.length > 0) {
      const cached = new Set(data.entries.map((entry) => entry.ref))
      const same = liveRefs.length === cached.size && liveRefs.every((ref) => cached.has(ref))
      if (!same) return null
    }
    const out = data.entries
    if (typeof data.summary === 'string') out.summary = data.summary
    if (Array.isArray(data.sections)) out.sections = data.sections
    if (Array.isArray(data.threads)) out.threads = data.threads
    if (typeof data.scoring === 'string') out.scoring = data.scoring
    return out
  } catch {
    return null
  }
}

/** 写缓存。entries 上挂的元数据一并存。 */
export async function writeScoreCache(dataDir, day, promptVersion, result) {
  if (!Array.isArray(result) || result.length === 0) return
  const payload = {
    v: 1,
    day,
    promptVersion,
    scoring: result.scoring || 'llm',
    summary: result.summary || '',
    sections: result.sections || [],
    threads: result.threads || [],
    entries: result,
  }
  await writeAtomic(cachePath(dataDir, day, promptVersion), `${JSON.stringify(payload, null, 2)}\n`)
}
