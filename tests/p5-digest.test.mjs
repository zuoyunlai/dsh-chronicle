/**
 * 「日结 + 线索」结构：这是对「条目孤立毫无意义」的直接回应。
 *
 * 用户实测看着面板说：14 条平级的 ★4 修复，读不出今天到底干了什么。
 * 所以模型必须先给能独立读懂的一天（summary），再把条目挂到 2–5 条线索下。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { extractJsonObject, normalizeDigest, scoreDayWithLlm, verifyRootCauses } from '../lib/llm.js'
import { renderWeek } from '../lib/render.js'
import { assignProjects } from '../lib/close.js'
import { condense } from '../lib/outline.js'

const REFS = ['s-1#1', 's-1#2', 's-1#3', 's-1#4']

function turn(ref, user) {
  return condense({
    sid: ref.split('#')[0],
    seq: Number(ref.split('#')[1]),
    ts: `2026-11-09T10:0${ref.split('#')[1]}:00+08:00`,
    ws: 'dsh-chronicle',
    user,
    assistant: '',
    tools: ['edit'],
    files: ['E:/x/lib/llm.js'],
    failures: 0,
    userChars: user.length,
  })
}

const DIGEST = JSON.stringify({
  summary: '今天把面板从空白做到可用：404 真因是路由形状写错；同时把日报结构从条目清单改成日结+四块。',
  projects: [{ name: 'dsh-chronicle', progress: '从 0.6.4 推到 0.8.0', ref: 's-1#1' }],
  decisions: [
    { title: '日报改成日结+四块', decision: '不再输出平级条目清单', why: '用户反馈条目孤立无意义', ref: 's-1#2' },
  ],
  pitfalls: [
    { title: '面板 404', symptom: '面板报 HTTP 404 且 body 为空', rootCause: '路由按 Fetch 风格注册，宿主只认 Node 风格', fix: '改成 exact+prefix 双注册', ref: 's-1#3' },
  ],
  threads: [
    { title: '主题跟随', why: '样式不跟主题', entries: [
      { ref: 's-1#4', title: '修正主题令牌', claim: '令牌名是编的', basis: '改 client.js', importance: 3, kind: 'pitfall', entities: ['client.js'] },
    ] },
  ],
})

test('解析：容忍围栏与前后废话', () => {
  const obj = extractJsonObject('前言\n```json\n{"a":1}\n```\n后语')
  assert.equal(obj.a, 1)
  assert.equal(extractJsonObject('没有对象'), null)
})

test('归一：四块都在，条目带 section 归属', () => {
  const digest = normalizeDigest(DIGEST, REFS)
  assert.match(digest.summary, /面板/)
  const keys = digest.sections.map((section) => section.key)
  assert.deepEqual(keys, ['projects', 'decisions', 'pitfalls', 'threads'])
  assert.equal(digest.entries.length, 4, '项目/决策/坑/其余各一')

  const project = digest.entries.find((e) => e.section === 'projects')
  assert.equal(project.title, 'dsh-chronicle')
  assert.match(project.claim, /0.8.0/)

  const decision = digest.entries.find((e) => e.section === 'decisions')
  assert.equal(decision.kind, 'decision')
  assert.match(decision.basis, /孤立无意义/)

  const pitfall = digest.entries.find((e) => e.section === 'pitfalls')
  assert.equal(pitfall.kind, 'pitfall')
  assert.match(pitfall.basis, /根因：路由按 Fetch 风格注册/)
  assert.ok(pitfall.basis.includes('绕过：改成 exact+prefix 双注册'), pitfall.basis)
})

test('归一：编造 ref 与非法字段照样丢弃', () => {
  const dirty = JSON.stringify({
    summary: '这是一条足够长的日结，用来通过长度校验，避免测试被误伤。',
    threads: [
      {
        title: '线索',
        why: '',
        entries: [
          { ref: 's-1#1', title: '好条目', claim: 'a', basis: 'b', importance: 4, kind: 'delivery', entities: [] },
          { ref: '不存在#9', title: '编造', claim: 'a', basis: 'b', importance: 5, kind: 'delivery', entities: [] },
          { ref: 's-1#2', title: '坏枚举', claim: 'a', basis: 'b', importance: 4, kind: 'nonsense', entities: [] },
        ],
      },
    ],
  })
  const digest = normalizeDigest(dirty, REFS)
  assert.equal(digest.entries.length, 1)
  assert.equal(digest.entries[0].title, '好条目')
})

test('归一：没有任何有效条目时返回 null（交给规则分）', () => {
  assert.equal(normalizeDigest(JSON.stringify({ summary: 'x', threads: [] }), REFS), null)
  assert.equal(normalizeDigest('不是 JSON', REFS), null)
})

test('scoreDayWithLlm：优先走日结结构，元数据挂在数组上', async () => {
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: DIGEST }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const entries = await scoreDayWithLlm({
    turns: [turn('s-1#1', '修路由'), turn('s-1#2', '定结构'), turn('s-1#3', '接入'), turn('s-1#4', '改令牌')],
    llm,
    provider: 'p',
    model: 'm',
  })
  assert.equal(entries.length, 4, "项目/决策/坑/其余各一条")
  assert.match(entries.summary, /面板/)
  assert.deepEqual(entries.sections.map((x) => x.key), ['projects', 'decisions', 'pitfalls', 'threads'])
})

test('scoreDayWithLlm：旧格式（平铺数组）仍然兼容', async () => {
  const legacy = JSON.stringify([
    { ref: 's-1#1', title: '老格式', claim: 'a', basis: 'b', importance: 4, kind: 'delivery', entities: [] },
  ])
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: legacy }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const entries = await scoreDayWithLlm({ turns: [turn('s-1#1', '修路由')], llm, provider: 'p', model: 'm' })
  assert.equal(entries.length, 1)
  assert.equal(entries.summary, undefined)
})

test('渲染：日结在顶部，四块按固定顺序出现', () => {
  const digest = normalizeDigest(DIGEST, REFS)
  const md = renderWeek({
    weekId: '2026-W46',
    days: [
      {
        day: '2026-11-09',
        entries: digest.entries.map((entry) => ({ ...entry, ws: 'dsh-chronicle' })),
        summary: digest.summary,
        sections: digest.sections,
      },
    ],
    floor: 3,
  })
  assert.match(md, /\*\*日结\*\*：今天把面板从空白做到可用/)
  assert.match(md, /### 项目进展/)
  assert.match(md, /### 结论与决策/)
  assert.match(md, /### 坑与根因/)
  assert.match(md, /### 其余进展/)
  assert.ok(md.includes('★4 dsh-chronicle'), '项目条目应以列表项出现')
  assert.match(md, /#dsh-chronicle/, '每条记录要带项目标签')
  assert.match(md, /根因：路由按 Fetch 风格注册/)
  // 顺序锁死：项目 → 决策 → 坑
  assert.ok(md.indexOf('### 项目进展') < md.indexOf('### 结论与决策'))
  assert.ok(md.indexOf('### 结论与决策') < md.indexOf('### 坑与根因'))
})

test('根因核对：原文有据保留，编造降级，未定位不动', () => {
  const text = new Map([['a#1', '插件工具消失 因为 ctx.timer 没有 inject 导致 apply 抛错']])
  const entries = [
    { ref: 'a#1', section: 'pitfalls', basis: '根因：ctx.timer 未 inject 导致 apply 抛错 · 绕过：改用 ctx.get' },
    { ref: 'a#1', section: 'pitfalls', basis: '根因：peer 依赖写法不兼容 · 绕过：修正 peer' },
    { ref: 'a#1', section: 'pitfalls', basis: '根因：尚未定位' },
  ]
  verifyRootCauses(entries, text)
  assert.equal(entries[0].rootCauseUnverified, undefined, '有据的根因不该被动')
  assert.equal(entries[1].rootCauseUnverified, true, '编造的根因必须降级')
  assert.ok(entries[1].basis.includes('尚未定位'), entries[1].basis)
  assert.ok(entries[1].basis.includes('peer 依赖写法不兼容'), '推断内容要留作参考')
  assert.equal(entries[2].rootCauseUnverified, undefined, '本来就写未定位的不动')
})

test('项目归属：文本命中优先，单项目工作区兜底，都不中才退工作区', () => {
  const entries = [
    { ref: 'p1', section: 'projects', title: 'dsh-chronicle', ws: 'ws-a' },
    { ref: 'p2', section: 'projects', title: 'WSL 迁移与磁盘优化', ws: 'ws-a' },
    { ref: 'x1', section: 'decisions', title: '压缩参数', claim: 'WSL vhdx 51G→29G', basis: '', entities: [], ws: 'ws-a' },
    { ref: 'x2', section: 'pitfalls', title: '面板 404', claim: '', basis: '改 api.js', entities: ['api.js'], ws: 'ws-a' },
    { ref: 'x3', section: 'projects', title: 'dsh-chronicle', ws: 'ws-b' },
    { ref: 'x4', section: 'decisions', title: '某决定', claim: '', basis: '', entities: [], ws: 'ws-b' },
  ]
  assignProjects(entries, ['dsh-chronicle', 'WSL 迁移与磁盘优化'])
  assert.equal(entries.find((e) => e.ref === 'x1').project, 'WSL 迁移与磁盘优化', '文本里 WSL 命中')
  assert.equal(entries.find((e) => e.ref === 'x2').project, 'ws-a', '两个项目的工作区无法判定，退回工作区名')
  assert.equal(entries.find((e) => e.ref === 'x4').project, 'dsh-chronicle', '单项目工作区兜底到该项目')
})

test('根因核对：英文标识符命中就算有据（避免误杀真根因）', () => {
  const text = new Map([['a#1', '插件先于 webServer 加载，注册时拿到 undefined']])
  const entries = [
    { ref: 'a#1', section: 'pitfalls', basis: '根因：挂载时调用 webServer，资源树尚未加载完成' },
    { ref: 'a#1', section: 'pitfalls', basis: '根因：peer 依赖写法不兼容' },
  ]
  verifyRootCauses(entries, text)
  assert.equal(entries[0].rootCauseUnverified, undefined, 'webServer 在原文出现，应保留')
  assert.equal(entries[1].rootCauseUnverified, true, 'peer 不在原文，应降级')
})
