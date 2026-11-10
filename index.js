/**
 * dsh-chronicle · 起居注 —— Host 半边
 *
 * P1：采集 → 纲要 → 规则打分 → 落周文件 →（可选）git commit。
 * 全部离线：不调模型、不联网、不依赖任何第三方插件。
 *
 * 依赖面：只硬依赖 tools；fs 未用（插件私有数据走 node:fs），
 * llm / systemPrompt 在 P2 / P3 才接。其余服务只做就绪探测。
 *
 * 目录语义（别混）：
 *   dataDir  = 私有数据（events/*.jsonl、state.json）—— 删了不可重建
 *   vaultDir = 产物（chronicle/*.md、entities/、facts/）—— 删了能重跑
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { dayKey, closeDecision, catchUpDays, weekId, isValidCloseAt } from './lib/time.js'
import { EventBuffer, prepareRow } from './lib/ingest.js'
import { closeDay, previewDay } from './lib/close.js'
import { scoreDayWithLlm } from './lib/llm.js'
import { loadEntries, loadEdges, searchEntries, buildInjectLine } from './lib/recall.js'
import { createChronicleApi, registerChronicleRoutes } from './lib/api.js'
import { backfillDay } from './lib/backfill.js'
import { readFacts, bumpFactHits } from './lib/facts.js'
import { bumpEntityHits } from './lib/entitypages.js'
import { reviewCandidates, renderRulesMarkdown } from './lib/rules.js'
import { readArcs } from './lib/arcs.js'
import { buildViz } from './lib/viz.js'
import { neighborsOf, loadGraph, attachFactNodes } from './lib/entities.js'
import { diagnose, formatDiagnosis } from './lib/doctor.js'
import {
  appendEvents,
  listEventDays,
  readEvents,
  readState,
  writeState,
  ensureVault,
  writeAtomic,
  readMaybe,
} from './lib/store.js'
import { createSerializer } from './lib/serialize.js'
import { TOOL_SCHEMAS } from './lib/schemas.js'

/**
 * schemastery 是**宿主 peer**，不是我们的依赖：
 *   - 从 npm 装进 profile 时，Node 从 profile/node_modules 解析到它（正常路径）
 *   - 用 `file:` / link 直接链接本仓库时，Node 从仓库真实路径向上找，找不到
 *     （实测 ERR_MODULE_NOT_FOUND ... imported from ...\dsh-chronicle\index.js）
 * 所以做容错导入：拿不到就不声明 Config（插件照常加载，只是没有设置页）。
 */
const Schema = await import('@deepseek-ai/schemastery')
  .then((mod) => mod.default ?? mod)
  .catch(() => null)

/** 与 cordis.patch.yml 的 insert id 保持一致。 */
export const name = 'dsh-chronicle'

/** 只硬依赖 tools；其余服务在运行时按需探测。 */
export const inject = ['tools']

/** 当前实现阶段。 */
export const PHASE = 'P6'

const VERSION = '1.1.4'

/** 每攒多少条事件就落一次盘。 */
const FLUSH_EVENTS = 20

/** 缓冲最长多久落一次盘（毫秒）。 */
const FLUSH_MS = 15_000

export const Config = Schema
  ? Schema.object({
      vaultDir: Schema.string()
        .default('~/dsh-chronicle-vault')
        .description('产物目录（Obsidian 直接 Open as vault 这一层）。默认独立库，不放进任何 DSH 工作区。'),
      dataDir: Schema.string()
        .default('')
        .description('私有数据目录。留空 = $DSH_HOME/dsh-chronicle（无 DSH_HOME 时退到 ~/.dsh/dsh-chronicle）。'),
      closeAt: Schema.string()
        .default('23:50')
        .description('当天收口时刻，HH:mm，本地时区。跨天由启动补偿兜底。'),
      tickMinutes: Schema.number()
        .min(1)
        .max(60)
        .default(5)
        .description('轮询间隔（分钟）。只判断"该不该收口"，不承担重活。'),
      weekFile: Schema.boolean()
        .default(true)
        .description('按周一个文件（2026-W45.md）。关掉退回按天——一年 365 个文件会拖垮 Obsidian 的 graph view。'),
      includeSubagent: Schema.boolean()
        .default(false)
        .description('是否收录子代理会话。默认不收，子代理的流水会把日报淹没。'),
      followModel: Schema.boolean()
        .default(true)
        .description('打分跟随当前选中模型（P2 起生效）。'),
      scoringModel: Schema.string()
        .default('')
        .description('固定打分模型，形如 provider/model。仅 followModel=false 时生效。'),
      importanceFloor: Schema.number()
        .min(1)
        .max(5)
        .default(3)
        .description('低于此分折叠进附录（不丢弃——丢了会让人怀疑漏记）。'),
      injectLine: Schema.boolean()
        .default(true)
        .description('是否在上下文里注入那一行概览（P3 起生效）。'),
      injectBudget: Schema.number()
        .min(0)
        .max(400)
        .default(80)
        .description('注入 token 硬上限。'),
      redact: Schema.boolean()
        .default(true)
        .description('写入磁盘前脱敏（密钥 / 令牌 / 私钥块 / 手机号 / 身份证 / 邮箱）。强烈建议不要关。'),
      maxEventsPerDay: Schema.number()
        .min(50)
        .max(20000)
        .default(5000)
        .description(
          '单日事件条数上限；超出后丢弃并计数（state.dropped）。默认 5000：实测一天真实事件约 1200 条，' +
            '原来的 400 太紧且按「每进程」计数，会静默丢掉会话尾部（最新的对话）。',
        ),
      gitCommit: Schema.boolean()
        .default(true)
        .description('生成后自动 git commit（只本地，绝不 push）。vault 必须是独立仓库。'),
      entityRule: Schema.string()
        .default('on-hit')
        .description('实体页建立门槛：on-hit = 被召回命中过一次；score = ★≥entityMinScore。'),
      scoring: Schema.string()
        .default('rule')
        .description('打分档位：rule = 纯规则（零成本、永远可用）；llm = 让当前模型整理一天（更准，花一次调用，失败自动退回 rule）。'),
      entityMinScore: Schema.number()
        .min(1)
        .max(5)
        .default(4)
        .description('entityRule=score 时的分数门槛。'),
      panel: Schema.boolean()
        .default(true)
        .description('是否注册 Web 面板入口（P4 生效）。'),
      keepDays: Schema.number()
        .min(0)
        .max(3650)
        .default(0)
        .description('原始 JSONL 保留天数，0 = 永久。'),
    })
  : undefined

function expandHome(input) {
  if (typeof input !== 'string' || input === '') return ''
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2))
  return input
}

function resolveDirs(config) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return {
    dataDir: expandHome(config.dataDir) || join(dshHome, 'dsh-chronicle'),
    vaultDir: expandHome(config.vaultDir),
  }
}

function probeServices(ctx) {
  const wanted = ['tools', 'fs', 'llm', 'sessionQuery', 'timer', 'systemPrompt']
  const out = {}
  for (const key of wanted) {
    try {
      out[key] = Boolean(ctx.get(key))
    } catch {
      out[key] = false
    }
  }
  return out
}

/** 取可选服务：拿不到就返回 undefined，绝不让一个服务把插件加载拖死。 */
function optionalService(ctx, key) {
  try {
    return ctx.get(key) || null
  } catch {
    return null
  }
}

/** 回捞状态的人话版本：进行中 / 完成 / 出错 三种形态必须能区分。 */
function renderBackfill(backfill) {
  if (!backfill) return '（还没跑）'
  const progress =
    backfill.total && backfill.nextIndex ? ` · 进度 ${backfill.nextIndex}/${backfill.total}` : ''
  if (backfill.running) {
    return `${backfill.day || '?'} 后台进行中 · 已读 ${backfill.sessions ?? 0} 个会话 / ${backfill.rows ?? 0} 条事件${progress}`
  }
  const parts = [`${backfill.day || '?'} · 会话 ${backfill.sessions ?? 0} · 事件 ${backfill.rows ?? 0}`]
  if (backfill.total) parts.push(`候选 ${backfill.total}`)
  if (backfill.noEvents) parts.push(`当天无动静 ${backfill.noEvents}`)
  if (backfill.slow) parts.push(`跳过卡死 ${backfill.slow}`)
  if (backfill.done === false) parts.push(`未完成${progress}（3 秒后续补）`)
  if (backfill.error) parts.push(`错误 ${backfill.error}`)
  return parts.join(' · ')
}

export function apply(ctx, config) {
  const { dataDir, vaultDir } = resolveDirs(config)
  const buffer = new EventBuffer({ dataDir, maxEventsPerDay: config.maxEventsPerDay })

  /** @type {any} */
  let state = null
  let closing = false
  let lastError = ''

  async function getState() {
    if (!state) state = await readState(dataDir)
    return state
  }

  /**
   * 落盘串行化。
   * 0.2.2 实测：boot、session/flush、定时器、攒够阈值四处都可能同时调 flushNow，
   * 两次 flush 会在 `pending.delete(day)` 之前各自读到同一批行 ⇒ 写出重复行。
   */
  const serializeFlush = createSerializer()
  const flushNow = () => serializeFlush(() => doFlush())

  async function doFlush() {
    const written = await buffer.flush({
      appendEvents,
      // 跨进程去重：第一次写某天之前先把磁盘上已有的 sid#seq 读进来，
      // 宿主重启后重放的事件不会再被写第二遍。
      loadSeen: async (day) => {
        const read = await readEvents(dataDir, day)
        return read.rows.map((row) => `${row.sid}#${row.seq}`)
      },
    })
    if (written > 0) {
      const s = await getState()
      s.lastTickAt = Date.now()
      s.dropped = (s.dropped || 0) + buffer.dropped
      buffer.dropped = 0
      await writeState(dataDir, s)
    }
    return written
  }

  /** 回捞状态：供 ping 报出「本次补了多少会话/事件」。 */
  let lastBackfill = null
  const backfilledDays = new Set()

  /**
   * 回捞某一天：把磁盘上当天发生过的**所有会话、所有工作区**补进缓冲。
   * 这个函数是「跨工作区」能成立的前提 —— 实时事件只覆盖进程内有活动的会话。
   */
  async function backfillTarget(day, { force = false, skipLive = true, startIndex = 0, deadlineMs } = {}) {
    const startedAt = Date.now()
    // 先置「进行中」：回捞是后台分批跑的，ping 必须能看出它在干什么
    lastBackfill = { day, running: true, sessions: 0, rows: 0, startedAt, nextIndex: startIndex }
    try {
      const sessionQuery = optionalService(ctx, 'sessionQuery')
      const result = await backfillDay({
        sessionQuery,
        buffer,
        day,
        includeSubagent: Boolean(config.includeSubagent),
        limit: 1000,
        redact: Boolean(config.redact),
        skipLive,
        startIndex,
        deadlineMs: deadlineMs || (skipLive ? 12000 : 45000),
        onProgress: async (partial) => {
          lastBackfill = { day, running: true, sessions: partial.sessions, rows: partial.rows, startedAt, nextIndex: partial.nextIndex }
          if (buffer.size() > 0) await flushNow()
        },
      })
      lastBackfill = { day, ...result, running: false, at: Date.now() }
      if (result.rows > 0) await flushNow()
    } catch (error) {
      lastBackfill = { day, running: false, done: true, error: String((error && error.message) || error), at: Date.now() }
    }
    return lastBackfill
  }

  // 回捞批次的续订定时器：必须由 effect 持有，否则插件卸载后它还会触发并写盘
  // （审计 P2-5：卸载 → 僵尸 timer → 写回 v1 的过期 state 快照 → backfillCursor 被清空）
  let backfillTimer = null
  let backfillDispose = null

  function scheduleBackfillBatch(day, delayMs = 3000) {
    if (backfillTimer) clearTimeout(backfillTimer)
    backfillTimer = setTimeout(() => {
      backfillTimer = null
      void backfillLoop(day)
    }, delayMs)
    if (backfillTimer && typeof backfillTimer.unref === 'function') backfillTimer.unref()
  }

  function releaseBackfillTimer() {
    if (backfillTimer) {
      clearTimeout(backfillTimer)
      backfillTimer = null
    }
    if (typeof backfillDispose === 'function') {
      try { backfillDispose() } catch { /* ignore */ }
      backfillDispose = null
    }
  }

  /**
   * 分批续补：每批 12 秒，跑到哪记到哪（state.backfillCursor），下一批接着来。
   * 为什么必须这样：165 个候选、每个 listEvents 就要几秒——一次性读完要几分钟，
   * 期间不能挡住启动，也不能让用户以为"没在跑"。
   */
  let backfilling = false

  async function backfillLoop(day, { force = false, skipLive = true } = {}) {
    if (!force && backfilledDays.has(day)) return lastBackfill
    // 互斥：tick（5 分钟）与续补（3 秒）会并发进来读同一个游标，
    // 导致同一批会话读两遍、游标可能回退（审计 P1-14）
    if (backfilling) return lastBackfill
    backfilling = true
    try {
      return await runBackfillLoop(day, { force, skipLive })
    } finally {
      backfilling = false
    }
  }

  async function runBackfillLoop(day, { force = false, skipLive = true } = {}) {
    const s = await getState()
    const cursor = s.backfillCursor && s.backfillCursor.day === day ? s.backfillCursor.nextIndex || 0 : 0
    const result = await backfillTarget(day, { force, skipLive, startIndex: cursor })

    if (result && result.done === false) {
      s.backfillCursor = { day, nextIndex: result.nextIndex || 0 }
      await writeState(dataDir, s)
      scheduleBackfillBatch(day, 3000)
    } else if (result) {
      s.backfillCursor = null
      if (!result.error) backfilledDays.add(day)
      await writeState(dataDir, s)
    }
    return result
  }

  async function runTick(reason) {
    if (closing) return
    try {
      await flushNow()
      const s = await getState()
      const now = Date.now()
      const days = await listEventDays(dataDir)
      const decision = closeDecision({
        now,
        closeAt: config.closeAt,
        lastClosedDay: s.lastClosedDay,
        closedDays: s.closedDays,
      })
      const catchUp = catchUpDays({
        now,
        closeAt: config.closeAt,
        lastClosedDay: s.lastClosedDay,
        closedDays: s.closedDays,
        daysWithEvents: days,
      })
      const targets = [...new Set([...(decision.due ? [decision.day] : []), ...catchUp])]
      if (targets.length === 0) {
        s.lastTickAt = now
        await writeState(dataDir, s)
        return
      }
      closing = true
      try {
        await ensureVault(vaultDir)
        for (const day of targets.sort()) {
          // 收口前顺手推一批回捞（不 await：回捞是后台活，不该拖住收口）
          void backfillLoop(day)
          const result = await closeDay(closeArgs(day))
          if (result.closed) {
            if (!s.lastClosedDay || day > s.lastClosedDay) s.lastClosedDay = day
            s.lastClose = { day, week: result.week, at: now, reason }
            await writeState(dataDir, s)
          }
        }
        await refreshCorpus()
      } finally {
        closing = false
      }
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 300)
    }
  }

  /* ---------- A 档打分（P2）：默认关，失败静默退回规则分 ---------- */

  /** 当前选中的模型；拿不到就返回 null。 */
  function currentModel() {
    try {
      const service = optionalService(ctx, 'agentDefaultModel')
      const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null
      return selection && selection.provider && selection.model ? selection : null
    } catch {
      return null
    }
  }

  /** 挑这次打分用哪个模型：配置里写死的 > 跟随当前选中。 */
  function scoringTarget() {
    const pinned = String(config.scoringModel || '').trim()
    if (pinned.includes('/')) {
      const [provider, model] = pinned.split('/')
      if (provider && model) return { provider, model }
    }
    if (config.followModel) {
      const selection = currentModel()
      if (selection) return { provider: selection.provider, model: selection.model }
    }
    return null
  }

  /**
   * 生成一个 enhance 闭包：返回 [] 就等于"用规则分"。
   * 为什么做成工厂而不是固定闭包：`chronicle_close` 要支持**单次覆盖**档位。
   *
   * 失败必须留话：0.5.3 之前这里把所有异常都吞了，结果 scoring 写成 rule，
   * 外面完全看不出 LLM 档为什么没生效（2026-11-09 实测就踩了）。
   */
  let llmError = ''
  let llmNote = ''

  function makeEnhancer(mode) {
    return async function enhance({ turns }) {
      if (String(mode || 'rule') !== 'llm') {
        llmError = ''
        return []
      }
      const llm = optionalService(ctx, 'llm')
      if (!llm || typeof llm.stream !== 'function') {
        llmError = 'llm 服务不可用'
        return []
      }
      const target = scoringTarget()
      if (!target) {
        llmError = '没有可用模型（followModel 解析不到当前选择）'
        return []
      }
      try {
        // 打分不需要深度思考：拿模型支持的最低档，把 token 留给正文。
        // （2026-11-09 实测：思考把预算吃满，正文一个字都没吐出来）
        let reasoningEffort
        try {
          const info = await llm.resolveModelInfo?.(target.provider, target.model)
          const efforts = info?.reasoning?.efforts || []
          if (efforts.length > 0) reasoningEffort = efforts[0].id
        } catch {
          reasoningEffort = undefined
        }

        const entries = await scoreDayWithLlm({
          turns,
          llm,
          provider: target.provider,
          model: target.model,
          maxTokens: 8000,
          reasoningEffort,
        })
        llmError = ''
        llmNote = entries.note || ''
        return entries
      } catch (error) {
        llmError = String((error && error.message) || error).slice(0, 300)
        llmNote = ''
        return []
      }
    }
  }

  const enhance = makeEnhancer(config.scoring)

  /** 供 closeDay 的调用点统一取参数。 */
  function closeArgs(day, mode) {
    return {
      dataDir,
      vaultDir,
      day,
      floor: config.importanceFloor,
      promptVersion: statePromptVersion(),
      gitCommit: Boolean(config.gitCommit),
      entityRule: String(config.entityRule || 'on-hit'),
      entityMinScore: Number(config.entityMinScore) || 4,
      enhance: mode ? makeEnhancer(mode) : enhance,
    }
  }

  function statePromptVersion() {
    return (state && state.promptVersion) || 'v1'
  }

  /* ---------- 采集：订阅 session/event ---------- */
  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      try {
        if (!config.includeSubagent) {
          const origin = session?.header?.origin
          if (origin === 'subagent') return
        }
        const prepared = prepareRow(session, event, config.redact)
        if (!prepared) return
        buffer.push(prepared.day, prepared.row)
        if (buffer.size() >= FLUSH_EVENTS) void flushNow()
      } catch (error) {
        lastError = String(error?.message || error).slice(0, 300)
      }
    }),
  )

  /* ---------- 落盘：宿主 flush 时顺手刷一次（这是被 await 的持久化点） ---------- */
  ctx.effect(() =>
    ctx.on('session/flush', async () => {
      try {
        await flushNow()
      } catch {
        /* 不阻断宿主的持久化检查点 */
      }
    }),
  )

  // 定时器走可选服务：v0.2.0 曾在未 inject 的情况下直接读 ctx.timer，
  // 触发 TypeError 导致整个插件加载失败（工具全部消失）。
  //
  // 用 ctx.inject 而不是一次性 ctx.get（审计 P2-6）：服务晚到时能自愈。
  // 拿不到就退化为"只在启动时跑一次 tick"，插件仍然可用。
  ctx.effect(() =>
    ctx.inject(['timer'], (injected) => {
      const service = injected.get('timer')
      if (!service || typeof service.interval !== 'function') return
      const stops = [
        service.interval(() => void flushNow(), FLUSH_MS),
        service.interval(() => void runTick('interval'), Math.max(1, config.tickMinutes) * 60_000),
      ]
      return () => {
        for (const stop of stops) {
          try {
            stop()
          } catch {
            /* 释放失败不影响卸载 */
          }
        }
        releaseBackfillTimer()
        void flushNow()
      }
    }),
  )

  /* ---------- 工具面 ---------- */
  ctx.effect(() =>
    ctx.tools.register({
      name: 'chronicle_ping',
      description:
        '起居注（dsh-chronicle）自检：返回实现阶段、版本、数据目录与产物目录、关键配置、' +
        '宿主服务就绪情况，以及缓冲与收口进度。不读写任何文件。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: TOOL_SCHEMAS.chronicle_ping,
        render(_args, value) {
          const s = value.services || {}
          const marks = Object.entries(s)
            .map(([k, ok]) => `${k}${ok ? '✓' : '✗'}`)
            .join(' ')
          return [
            {
              type: 'text',
              text:
                `dsh-chronicle ${value.phase} v${value.version}\n` +
                `数据 ${value.dataDir}\n产物 ${value.vaultDir}\n` +
                `收口 ${value.closeAt} · 门槛 ★${value.floor} · git 提交 ${value.gitCommit ? '开' : '关'}\n` +
                `打分 ${value.scoring}${value.scoringTarget ? `（${value.scoringTarget}）` : '（无可用模型）'}\n` +
                `面板 API ${value.routes && value.routes.ok ? `已注册 ${value.routes.disposers} 条` : `未注册（${(value.routes && value.routes.reason) || '无 webServer'}）`}\n` +
                `回捞 ${renderBackfill(value.backfill)}\n` +
                (value.llmError ? `⚠️ LLM 上次失败：${value.llmError}\n` : '') +
                (value.closeAtValid === false ? '⚠️ closeAt 非法，已退回 23:50\n' : '') +
                `状态 上次收口 ${value.lastClosedDay || '（还没收过）'} · 缓冲 ${value.buffered} 条 · 今日 ${value.eventsToday} 条\n` +
                `服务 ${marks}`,
            },
          ]
        },
      },
      async execute() {
        const s = await getState()
        const today = dayKey(Date.now())
        let eventsToday = 0
        try {
          const read = await readEvents(dataDir, today)
          eventsToday = read.rows.length
        } catch {
          eventsToday = -1
        }
        return {
          phase: PHASE,
          version: VERSION,
          dataDir,
          vaultDir,
          closeAt: String(config.closeAt),
          closeAtValid: isValidCloseAt(config.closeAt),
          floor: config.importanceFloor,
          scoring: String(config.scoring || 'rule'),
          routes: routeReport,
          backfill: lastBackfill || {},
          llmError: llmError || '',
          scoringTarget: (() => {
            const target = scoringTarget()
            return target ? `${target.provider}/${target.model}` : ''
          })(),
          gitCommit: Boolean(config.gitCommit),
          weekFile: Boolean(config.weekFile),
          lastClosedDay: s.lastClosedDay || '',
          buffered: buffer.size(),
          eventsToday,
          lastError: lastError || '',
          services: probeServices(ctx),
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chronicle_close',
      description:
        '立刻收口某一天（默认今天）：读当天事件 → 纲要 → 打分 → 写周文件（可选 git commit）。' +
        'scoring 可单次覆盖打分档位（rule/llm），dryRun=true 只预览不写文件。用于手动补跑与调试，正常情况由定时器自动完成。',
      parameters: {
        type: 'object',
        properties: {
          day: { type: 'string', description: 'YYYY-MM-DD，默认今天（本地时区）' },
          dryRun: { type: 'boolean', description: '只预览，不写文件' },
          scoring: {
            type: 'string',
            description: '单次覆盖打分档位：rule = 纯规则；llm = 让当前模型整理一天。省略则跟随插件配置。',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: TOOL_SCHEMAS.chronicle_close,
        render(_args, value) {
          if (value.dryRun) {
            const top = (value.top || [])
              .map((t) => `★${t.importance} ${t.title}`)
              .join('\n')
            return [
              {
                type: 'text',
                text: `预览 ${value.day}：${value.stats?.turns ?? 0} 轮 / ${value.stats?.sessions ?? 0} 会话\n${top || '（没有可记录的轮次）'}`,
              },
            ]
          }
          if (!value.closed) {
            const text =
              value.reason === 'no-events'
                ? `${value.day} 没有任何会话活动，没有可收口的内容（已回捞，磁盘上也没有这一天的事件）。`
                : `未收口：${value.reason || '未知原因'}（${value.day || '?'}）`
            return [{ type: 'text', text }]
          }
          const git = value.git ? (value.git.committed ? ' · 已 git commit' : ` · git: ${value.git.reason || 'skipped'}`) : ''
          const graph = value.graph ? ` · 图 ${value.graph.entities} 实体 / ${value.graph.edges} 边` : ''
          const failed = value.llmError ? `\n⚠️ LLM 档没生效，已退回规则分：${value.llmError}` : ''
          const noted = value.llmNote ? `（${value.llmNote}）` : ''
          return [
            {
              type: 'text',
              text:
                `已收口 ${value.day} → ${value.week}（${value.entries} 条，本周合并 ${value.daysIncluded} 天，打分 ${value.scoring}${noted}）\n` +
                `文件 ${value.path}${graph}${git}${failed}` +
                // 结构退化了必须喊出来：静默降级比报错更危险
                (Array.isArray(value.warnings) && value.warnings.length > 0
                  ? `\n⚠ 结构自检：\n${value.warnings.map((line) => '  · ' + line).join('\n')}`
                  : ''),
            },
          ]
        },
      },
      async execute(args) {
        const day = typeof args?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.day) ? args.day : dayKey(Date.now())
        const mode = args?.scoring === 'llm' ? 'llm' : args?.scoring === 'rule' ? 'rule' : undefined
        if (args?.dryRun) {
          const preview = await previewDay({ dataDir, day })
          return { dryRun: true, ...preview, scoringRequested: mode || String(config.scoring || 'rule') }
        }
        const s = await getState()
        // 手动收口走深度回捞：连正在运行的会话也读一遍（实时流只覆盖插件加载之后的部分）
        await backfillLoop(day, { force: true, skipLive: false })
        const result = await closeDay(closeArgs(day, mode))
        if (result.closed) {
          if (!s.lastClosedDay || day > s.lastClosedDay) s.lastClosedDay = day
          // 收口日集合：补收口只看它，不再只看 lastClosedDay（否则更早的历史天被永久跳过）
          s.closedDays = [...new Set([...(s.closedDays || []), day])].sort().slice(-60)
          await writeState(dataDir, s)
          await refreshCorpus()
        }
        return {
          ...result,
          llmError: mode === 'llm' && result.scoring !== 'llm' ? llmError || '未知原因' : '',
          llmNote: mode === 'llm' && result.scoring === 'llm' ? llmNote : '',
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chronicle_doctor',
      description:
        '起居注日志体检：报出某天的事件行数、重复键、坏行、类型分布、轮次数、思考污染痕迹，' +
        '以及周文件是否已生成。只读，不改任何文件。日志"看着有但其实不对"时先跑它。',
      parameters: {
        type: 'object',
        properties: { day: { type: 'string', description: 'YYYY-MM-DD，默认今天（本地时区）' } },
        additionalProperties: false,
      },
      output: {
        schema: TOOL_SCHEMAS.chronicle_doctor,
        render(_args, value) {
          return [{ type: 'text', text: formatDiagnosis(value) }]
        },
      },
      async execute(args) {
        const day = typeof args?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.day) ? args.day : dayKey(Date.now())
        return diagnose({ dataDir, vaultDir, day })
      },
    }),
  )

  /* ---------- P3：检索语料缓存 + 常驻一行注入 ---------- */

  let corpus = { entries: [], edges: [], loadedAt: 0 }
  let injectText = ''

  async function refreshCorpus() {
    try {
      const entries = await loadEntries(dataDir)
      const edges = await loadEdges(dataDir)
      corpus = { entries, edges, loadedAt: Date.now() }
      injectText = config.injectLine
        ? buildInjectLine({
            entries,
            facts: await readFacts(dataDir),
            budgetChars: Math.max(20, config.injectBudget) * 2,
          })
        : ''
    } catch {
      /* 语料读失败就让注入为空，不打扰会话 */
    }
    return corpus
  }

  async function getCorpus(maxAgeMs = 60_000) {
    if (Date.now() - corpus.loadedAt > maxAgeMs) await refreshCorpus()
    return corpus
  }

  // 常驻注入：只有一行，且当天没记录时是空串（连这一行都不出现）。
  // 用 ctx.inject 而不是一次性 ctx.get（审计 P2-19）：systemPrompt 晚到时能自愈。
  if (typeof ctx.inject === 'function') {
    ctx.effect(() =>
      ctx.inject(['systemPrompt'], (injected) => {
        const service = injected.get('systemPrompt')
        if (!service || typeof service.context !== 'function') return
        return service.context({
          name: 'chronicle-hint',
          order: 900,
          text: () => injectText,
        })
      }),
    )
  } else {
    const systemPrompt = optionalService(ctx, 'systemPrompt')
    if (systemPrompt && typeof systemPrompt.context === 'function') {
      ctx.effect(() =>
        systemPrompt.context({
          name: 'chronicle-hint',
          order: 900,
          text: () => injectText,
        }),
      )
    }
  }

  // 只读 API：面板与工具共用同一后端（同一函数，不分叉）
  //
  // 时序坑（0.5.2 之前）：apply() 里 `ctx.get('webServer')` 在插件挂载那一刻是 undefined——
  // 资源树是异步加载的，webserver 比插件晚就绪。于是整段注册被 if 静默跳过，
  // 外部只看到面板 404（`chronicle_ping` 报 webServer-unavailable 才定位到）。
  // 正确做法：`ctx.inject(['webServer'], cb)` —— 服务已在就立即回调，否则等服务出现再回调。
  const routeReport = { ok: false, reason: 'not-run', attempts: [], disposers: 0 }
  const api = createChronicleApi({
    loadCorpus: () => getCorpus(0),
    neighborsOf: (name) => neighborsOf(dataDir, name),
    // 面板的「事实 / 线索 / 图谱」三个视图直读对应索引
    readFacts: () => readFacts(dataDir),
    readArcs: () => readArcs(dataDir),
    // 图上既要有文件，也要有「想出来的东西」：把事实节点挂进来
    // 面板要显示「丢了多少事件」，这是记忆完整度的唯一指标
    readState: () => readState(dataDir),
    buildViz,
    loadGraph: async (limit) => {
      const base = await loadGraph(dataDir, { limit })
      return attachFactNodes(base, await readFacts(dataDir))
    },
  })

  function startRoutes(webServer) {
    // 幂等：ctx.inject 可能因为服务重新发布而回调第二次，
    // 再注册一遍会撞「Duplicate (kind, path)」并把 ok 覆写成 false
    // （2026-11-09 实测：状态显示「未注册（registered）」）。
    if (routeReport.ok) return () => {}
    if (!webServer || typeof webServer.register !== 'function') {
      routeReport.reason = 'webServer-invalid'
      routeReport.ok = false
      return () => {}
    }
    const { disposers } = registerChronicleRoutes(webServer, api, routeReport)
    if (routeReport.ok) routeReport.reason = 'registered'
    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* ignore */
        }
      }
      // 必须复位：ctx.inject 的回调会在服务变化时被卸载并重跑。
      // 不复位的话守卫会挡掉重新注册 → 面板永久 404，而 ping 仍报"已注册 N 条"。
      routeReport.ok = false
      routeReport.reason = 'disposed'
    }
  }

  if (typeof ctx.inject === 'function') {
    // 服务就绪即注册；插件重载时 inject 会重跑，旧 disposer 由 ctx.effect 释放
    ctx.effect(() => ctx.inject(['webServer'], (injected) => startRoutes(injected.get('webServer'))))
  } else {
    const webServer = optionalService(ctx, 'webServer')
    if (webServer) ctx.effect(() => startRoutes(webServer))
    else {
      routeReport.reason = 'webServer-unavailable'
      routeReport.ok = false
    }
  }

  // 第三道保险：万一这个宿主版本没有 ctx.inject，或者 inject 没触发，
  // 三次延迟重试把注册补上。失败也只会停在 reason 里，不会影响其它功能。
  let routeRetries = 0
  function retryRoutes() {
    if (routeReport.ok || routeRetries >= 3) return
    routeRetries += 1
    const webServer = optionalService(ctx, 'webServer')
    if (webServer && typeof webServer.register === 'function') {
      try {
        ctx.effect(() => startRoutes(webServer))
      } catch {
        /* ignore */
      }
      return
    }
    const handle = setTimeout(retryRoutes, 1000 * routeRetries * 3)
    if (handle && typeof handle.unref === 'function') handle.unref()
  }
  retryRoutes()

  /* ---------- 三个按需工具（正文永远靠取，不塞上下文） ---------- */

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chronicle_today',
      description: '起居注：取某一天（默认今天）的记录，按重要度降序。用于回答「我今天到底做了什么」。',
      parameters: {
        type: 'object',
        properties: {
          day: { type: 'string', description: 'YYYY-MM-DD，默认今天（本地时区）' },
          limit: { type: 'number', description: '最多返回几条，默认 20' },
        },
        additionalProperties: false,
      },
      output: {
        schema: TOOL_SCHEMAS.chronicle_today,
        render(_args, value) {
          if (!value.entries || value.entries.length === 0) {
            return [{ type: 'text', text: `${value.day} 没有记录（还没收口，或那天没干活）。` }]
          }
          const lines = value.entries.map((e) => `★${e.importance} ${e.title} · \`${e.ref}\``)
          return [{ type: 'text', text: `${value.day} · ${value.total} 条\n${lines.join('\n')}` }]
        },
      },
      async execute(args) {
        const day = typeof args?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.day) ? args.day : dayKey(Date.now())
        const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20))
        const { entries } = await getCorpus(0)
        const mine = entries
          .filter((entry) => String(entry.day) === day)
          .sort((a, b) => (b.importance || 1) - (a.importance || 1))
        return { day, total: mine.length, entries: mine.slice(0, limit) }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chronicle_search',
      description:
        '起居注：跨天检索自己的记录。命中靠「实体精确匹配 + 图 2 跳扩散 + 重要度 + 60 天半衰期」，' +
        '返回带分数的条目与证据 ref。问「上次那个坑」「之前定过什么」时用它。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词、实体名、或一句人话' },
          limit: { type: 'number', description: '最多返回几条，默认 8' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: TOOL_SCHEMAS.chronicle_search,
        render(_args, value) {
          if (!value.results || value.results.length === 0) {
            return [{ type: 'text', text: `没命中「${value.query}」。` }]
          }
          const lines = value.results.map(
            (r) => `★${r.importance} ${r.title} · ${r.score} 分 · \`${r.ref}\`\n  ${r.claim || ''}`,
          )
          return [{ type: 'text', text: `${value.results.length} 条命中「${value.query}」\n${lines.join('\n')}` }]
        },
      },
      async execute(args) {
        const query = String(args?.query || '').trim()
        const limit = Math.max(1, Math.min(50, Number(args?.limit) || 8))
        if (!query) return { query, results: [] }
        const { entries, edges } = await getCorpus()
        const results = searchEntries(entries, query, { edges, limit })
        // 命中即记账：这是判断"这套东西到底有没有用"的唯一指标
        if (results.length > 0) {
          try {
            await bumpFactHits(dataDir, results.map((item) => item.ref), vaultDir)
            // 记实体命中：entityRule=on-hit 时这是建页的唯一依据（审计 P1-1）
            const hitNames = new Set()
            for (const item of results) {
              for (const name of item.entities || []) hitNames.add(String(name))
              for (const file of item.files || []) hitNames.add(String(file).split(/[\\/]/).pop())
            }
            await bumpEntityHits(dataDir, [...hitNames])
          } catch {
            /* 记账失败不影响检索 */
          }
        }
        return { query, results }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chronicle_related',
      description:
        '起居注：给一个实体（项目名 / 文件名 / 插件名），返回它的图邻居与相关记录。' +
        '用于「这东西还牵扯到什么」这种关联问题。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '实体名' },
          limit: { type: 'number', description: '相关记录最多几条，默认 8' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      output: {
        schema: TOOL_SCHEMAS.chronicle_related,
        render(_args, value) {
          const neighbors = (value.neighbors || []).map((n) => `${n.name}(${n.weight})`).join(' ')
          const lines = (value.entries || []).map((e) => `★${e.importance} ${e.title} · \`${e.ref}\``)
          return [
            {
              type: 'text',
              text:
                `${value.name}：邻居 ${value.neighbors?.length || 0} 个${neighbors ? ` — ${neighbors}` : ''}\n` +
                (lines.length ? lines.join('\n') : '（没有直接提到它的记录）'),
            },
          ]
        },
      },
      async execute(args) {
        const name = String(args?.name || '').trim()
        const limit = Math.max(1, Math.min(50, Number(args?.limit) || 8))
        if (!name) return { name, neighbors: [], entries: [] }
        const neighbors = await neighborsOf(dataDir, name)
        const { entries } = await getCorpus()
        const key = name.toLowerCase()
        const related = entries
          .filter((entry) => (entry.entities || []).some((entity) => String(entity).toLowerCase() === key))
          .sort((a, b) => (b.importance || 1) - (a.importance || 1))
          .slice(0, limit)
        return { name, neighbors: neighbors.slice(0, 8), entries: related }
      },
    }),
  )

  /* ---------- 事实层工具（P5/P6）：读事实、查该复核的、导出规则 ---------- */

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chronicle_facts',
      description:
        '起居注事实库：列出不随日期过期的结论。可按 kind（decision/convention/pitfall/rejected/question）与项目过滤，' +
        '返回 title/status/hits 与事实 id。想读全文用 chronicle_read_fact 或直接看 vault/facts/<id>.md。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'decision | convention | pitfall | rejected | question' },
          project: { type: 'string', description: '项目名过滤' },
          q: { type: 'string', description: '关键词过滤（标题/结论/依据）' },
          scope: { type: 'string', description: 'general = 只看工作记忆；tool-self = 只看工具自身笔记；省略 = 全部' },
          limit: { type: 'number', description: '最多几条，默认 20' },
        },
        additionalProperties: false,
      },
      output: {
        schema: TOOL_SCHEMAS.chronicle_facts,
        render(_args, value) {
          if (!value.facts || value.facts.length === 0) return [{ type: 'text', text: '事实库还是空的（先收口一次）' }]
          const lines = value.facts.map(
            (fact) => `- [${fact.kind}] ${fact.title} · ${fact.project} · ${fact.status} · 命中${fact.hits || 0} · \`${fact.id}\``,
          )
          return [{ type: 'text', text: `事实 ${value.total} 条（显示 ${value.facts.length}）\n${lines.join('\n')}` }]
        },
      },
      async execute(args) {
        const facts = await readFacts(dataDir)
        const kind = typeof args?.kind === 'string' ? args.kind : ''
        const project = typeof args?.project === 'string' ? args.project : ''
        const q = String(args?.q || '').trim().toLowerCase()
        const scope = typeof args?.scope === 'string' ? args.scope : ''
        const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20))
        const filtered = facts.filter((fact) => {
          if (kind && fact.kind !== kind) return false
          if (project && String(fact.project) !== project) return false
          if (scope && String(fact.scope || 'general') !== scope) return false
          if (q) {
            const hay = [fact.title, fact.statement, fact.rationale, fact.detector].filter(Boolean).join(' ').toLowerCase()
            if (!hay.includes(q)) return false
          }
          return true
        })
        return { total: filtered.length, facts: filtered.slice(0, limit) }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chronicle_review',
      description:
        '起居注：列出**该复核的旧结论**——单次得出且超过两周未复现的，或带「何时重评」条件的。' +
        '用于定期检查记忆是否过期。',
      parameters: {
        type: 'object',
        properties: {
          olderThanDays: { type: 'number', description: '多少天算旧，默认 14' },
          limit: { type: 'number', description: '最多几条，默认 8' },
        },
        additionalProperties: false,
      },
      output: {
        schema: TOOL_SCHEMAS.chronicle_review,
        render(_args, value) {
          if (!value.candidates || value.candidates.length === 0) {
            return [{ type: 'text', text: '没有该复核的条目：要么都很新，要么都已被复现验证过。' }]
          }
          const lines = value.candidates.map(
            (item) => `- [${item.kind}] ${item.title}（${item.project} · ${item.bornOn}）—— ${item.reason}`,
          )
          return [{ type: 'text', text: `该复核 ${value.candidates.length} 条\n${lines.join('\n')}` }]
        },
      },
      async execute(args) {
        const facts = await readFacts(dataDir)
        const candidates = reviewCandidates(facts, {
          olderThanDays: Math.max(1, Number(args?.olderThanDays) || 14),
          limit: Math.max(1, Math.min(50, Number(args?.limit) || 8)),
        })
        return { candidates }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chronicle_export_rules',
      description:
        '起居注：把「约定」「决策的失效条件」「坑的判别信号」导出成一段 Markdown 规则，' +
        '可直接粘进 AGENTS.md 或技能文件。write=true 时同时写进 vault/AGENTS.generated.md。',
      parameters: {
        type: 'object',
        properties: { write: { type: 'boolean', description: '是否落盘到 vault/AGENTS.generated.md' } },
        additionalProperties: false,
      },
      output: {
        schema: TOOL_SCHEMAS.chronicle_export_rules,
        render(_args, value) {
          return [
            {
              type: 'text',
              text: value.path ? `已写出 ${value.lines} 行规则 → ${value.path}\n\n${value.markdown}` : value.markdown,
            },
          ]
        },
      },
      async execute(args) {
        const facts = await readFacts(dataDir)
        const generatedAt = dayKey(Date.now())
        const markdown = renderRulesMarkdown(facts, { generatedAt })
        let path = ''
        // write 默认开：闭环的产物必须真的落盘，否则「规则导出」只是屏幕上的字
        if (args?.write !== false) {
          path = join(vaultDir, 'AGENTS.generated.md')
          await writeAtomic(path, markdown)
        }
        return { markdown, path, lines: markdown.split('\n').length }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chronicle_capsule',
      description: '起居注时间胶囊：给未来的自己留一句话，追加到 vault/capsules/YYYY.md（不参与打分，纯留存）。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要留下的一句话' } },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: TOOL_SCHEMAS.chronicle_capsule,
        render(_args, value) {
          return [{ type: 'text', text: `已存入 ${value.path}（${value.day}）` }]
        },
      },
      async execute(args) {
        const text = String(args?.text || '').trim()
        if (!text) throw new Error('text 不能为空')
        const day = dayKey(Date.now())
        const year = day.slice(0, 4)
        const path = join(vaultDir, 'capsules', `${year}.md`)
        const existing = (await readMaybe(path)) || `# 时间胶囊 ${year}\n`
        await writeAtomic(path, `${existing}${existing.endsWith('\n') ? '' : '\n'}- **${day}** ${text}\n`)
        return { day, path }
      },
    }),
  )

  /* ---------- 启动：先刷一次，再跑一次 tick（补偿漏掉的天） ---------- */
  //
  // 卸载标志：启动序列是异步的，apply() 返回后它还在写盘。
  // 没有这个标志的话，用户在启动过程中禁用插件 → 它仍会往 vault 写文件
  // （2026-11-10 实测：测试里 rm 临时目录撞 ENOTEMPTY）。
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
  })

  void (async () => {
    try {
      await ensureVault(vaultDir)
      if (disposed) return
      await flushNow()
      if (disposed) return
      // 启动即开始后台回捞（不 await）：165 个候选要分很多批，不能挡启动
      void backfillLoop(dayKey(Date.now()))
      await runTick('boot')
      if (disposed) return
      await refreshCorpus()
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 300)
    }
  })()
}
