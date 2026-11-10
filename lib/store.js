/**
 * 落盘：插件私有数据（events / state）与产物（vault）的读写。
 *
 * 为什么用 node:fs 而不是 ctx.fs：
 *   ctx.fs 是给**模型可见文件系统**用的接缝（FsTarget + sandboxPolicy），
 *   写的是工作区/沙箱世界里的文件；插件私有数据落在 $DSH_HOME 下，
 *   不该走模型的沙箱语义。家族插件（dsh-pet）同样直接用 node:fs/promises。
 *
 * 原子性：
 *   整文件写一律 tmp + rename（POSIX 语义下同目录 rename 是原子的）；
 *   事件 JSONL 用 appendFile，单行 < 4KB、追加写不会撕裂。
 */
import { mkdir, readFile, writeFile, rename, appendFile, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 递归建目录（幂等）。 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

/** 原子写单个文件：tmp → rename。 */
export async function writeAtomic(path, text) {
  await ensureDir(dirname(path))
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmp, text, 'utf8')
  try {
    await rename(tmp, path)
  } catch (error) {
    // Windows 上目标被占用时 rename 会失败；退化为直接写，保证不丢内容
    await writeFile(path, text, 'utf8')
    // 删掉临时文件：原来这里是 readFile(tmp) —— 读了什么也没干，
    // 于是 rename 失败时残留 .tmp-* 会被 git add -A 提交进 vault（审计 P2-1）
    await unlink(tmp).catch(() => {})
  }
}

/** 读文本；不存在返回 undefined。 */
export async function readMaybe(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    throw error
  }
}

/** 读 JSON；坏文件退回 fallback（不崩、不静默删）。 */
export async function readJson(path, fallback) {
  const text = await readMaybe(path)
  if (!text) return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export function eventsPath(dataDir, day) {
  return join(dataDir, 'events', `${day}.jsonl`)
}

/** 追加事件行（一行一条，已脱敏）。 */
export async function appendEvents(dataDir, day, rows) {
  if (!rows || rows.length === 0) return 0
  await ensureDir(join(dataDir, 'events'))
  const payload = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  await appendFile(eventsPath(dataDir, day), payload, 'utf8')
  return rows.length
}

/** 读某天的全部事件行；坏行跳过（计数返回，便于诊断"为什么少了几条"）。 */
export async function readEvents(dataDir, day) {
  const text = await readMaybe(eventsPath(dataDir, day))
  if (!text) return { rows: [], badLines: 0 }
  const rows = []
  let badLines = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      badLines += 1
    }
  }
  return { rows, badLines }
}

/** 列出有事件的日期（YYYY-MM-DD），升序。 */
/**
 * 每天事件文件的 mtime（毫秒）。
 *
 * 用途：判断「已收口的天」后来有没有被回捞补进新事件。
 * 回捞是后台分批跑的，完全可能在 D 已收口之后才找到 D 的旧会话——
 * 那时周文件是旧的，但 closedDays 里已经有 D，不重收就永远不刷新。
 */
export async function eventDayStamps(dataDir) {
  const dir = join(dataDir, 'events')
  const out = {}
  try {
    const names = await readdir(dir)
    for (const name of names) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue
      try {
        const info = await stat(join(dir, name))
        out[name.slice(0, 10)] = Math.floor(info.mtimeMs)
      } catch {
        /* 单个文件 stat 失败不影响其它天 */
      }
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  return out
}

export async function listEventDays(dataDir) {
  const dir = join(dataDir, 'events')
  try {
    const names = await readdir(dir)
    return names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .map((name) => name.slice(0, 10))
      .sort()
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
}

/** 状态文件（游标 / 锁 / 脱敏计数 / 用量）。 */
export function statePath(dataDir) {
  return join(dataDir, 'state.json')
}

export async function readState(dataDir) {
  const raw = await readJson(statePath(dataDir), null)
  return {
    v: 1,
    lastClosedDay: raw?.lastClosedDay || null,
    cursor: raw?.cursor || {},
    redact: raw?.redact || {},
    usage: raw?.usage || {},
    promptVersion: raw?.promptVersion || 'v1',
    lastTickAt: raw?.lastTickAt || 0,
    ...raw,
  }
}

export async function writeState(dataDir, state) {
  await writeAtomic(statePath(dataDir), `${JSON.stringify(state, null, 2)}\n`)
}

/** 产物的周文件路径。 */
export function weekFilePath(vaultDir, weekId) {
  return join(vaultDir, 'chronicle', `${weekId}.md`)
}

/** 文件是否存在（用 stat，避免读全文）。 */
export async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 建好 vault 骨架（不含 .obsidian，那是 Obsidian 自己的）。 */
export async function ensureVault(vaultDir) {
  await ensureDir(join(vaultDir, 'chronicle'))
  await ensureDir(join(vaultDir, 'entities'))
  await ensureDir(join(vaultDir, 'facts'))
  const gitignore = join(vaultDir, '.gitignore')
  if (!(await exists(gitignore))) {
    await writeAtomic(
      gitignore,
      ['# 原始流水只给插件读，别进 git', 'events/', '', '# Obsidian 的会话状态每次开关都变', '.obsidian/workspace.json', '.obsidian/workspace-mobile.json', ''].join(
        '\n',
      ),
    )
  }
}
