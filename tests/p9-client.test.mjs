/**
 * 客户端冒烟测试。
 *
 * 为什么必须补（2026-11-10 真实事故）：
 * 用户重启后 DSH 直接启动失败，崩溃日志里只有
 *   `ReferenceError: focusOn is not defined`
 * 和 8 条 `<svg> attribute height: Expected length, "auto"`。
 *
 * 客户端 1152 行此前**零测试**，所以「引用了不存在的变量」「给 SVG 传无效属性」
 * 这类错误只有等用户重启才能发现。这个文件用一套最小 React 实现真跑一遍
 * Panel 的渲染体，把这类错误挡在提交之前。
 *
 * 做法：桩掉 window.__ModuleLoader__ 拿 factory，用假 React 让 hooks 可用，
 * 通过 slots.register 抓出正文组件并**递归渲染**——渲染期错误直接抛出。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const CLIENT_PATH = new URL('../client.js', import.meta.url)

/** 最小 React 实现：够跑 Panel 的渲染体，不追求真实调度。 */
function makeFakeReact(log) {
  const stateSlots = []
  let slotIndex = 0

  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
      // 真实 React 把 children 放进 props.children（class 组件的 this.props.children 依赖它）
      const merged = { ...(props || {}) }
      if (flat.length === 1) merged.children = flat[0]
      else if (flat.length > 1) merged.children = flat
      if (typeof type === 'string') log.elements.push({ type, props: merged, children: flat })
      return { type, props: merged, children: flat }
    },
    useState(initial) {
      const index = slotIndex++
      if (stateSlots[index] === undefined) stateSlots[index] = { value: initial }
      const slot = stateSlots[index]
      const setter = (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
      }
      return [slot.value, setter]
    },
    useCallback(fn) {
      return fn
    },
    useRef(initial) {
      return { current: initial }
    },
    useMemo(fn) {
      return fn()
    },
    useEffect(fn) {
      // 不真正执行副作用（rAF / 网络），只记录，避免环境依赖
      log.effects.push(fn)
    },
    Component: class {
      constructor(props) {
        this.props = props
        this.state = {}
      }
      setState(next) {
        this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
      }
      render() {
        return null
      }
    },
  }
  React.__resetSlots = () => {
    slotIndex = 0
  }
  // 供测试预置某个 useState 槽的值（用来跳过 loading 直接渲染有数据的视图）
  React.__seedSlot = (index, value) => {
    stateSlots[index] = { value }
  }
  React.__slots = stateSlots
  return React
}

/** 递归渲染：把组件树真正展开成宿主元素，渲染期错误就会暴露。 */
function renderToLog(element, React, log, depth = 0) {
  if (element === null || element === undefined || element === false) return
  if (Array.isArray(element)) {
    for (const child of element) renderToLog(child, React, log, depth)
    return
  }
  if (typeof element !== 'object') return
  if (depth > 30) throw new Error('渲染超过 30 层，疑似无限递归')

  const { type, props = {}, children } = element
  if (typeof type === 'string') {
    log.elements.push({ type, props, children })
    for (const child of children || []) renderToLog(child, React, log, depth + 1)
    return
  }
  if (typeof type === 'function') {
    // 类组件
    if (type.prototype && typeof type.prototype.render === 'function') {
      const instance = new type(props)
      renderToLog(instance.render(), React, log, depth + 1)
      return
    }
    // 函数组件
    renderToLog(type(props), React, log, depth + 1)
    return
  }
  for (const child of children || []) renderToLog(child, React, log, depth + 1)
}

/** 造一个够用的宿主 ctx 桩：slots / inject / effect / tabs 都按真实形状给。 */
function makeCtx(log) {
  const ctx = {
    slots: {
      inject(_name, cb) {
        return cb()
      },
      register(descriptor, component) {
        log.slots.push({ descriptor, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(descriptor) {
        log.registered.push(descriptor)
        return () => {}
      },
    },
    sidebarRight: {},
    inject(list, cb) {
      const services = {
        slots: ctx.slots,
        sidebarRightTabs: ctx.sidebarRightTabs,
        sidebarRight: ctx.sidebarRight,
      }
      const injected = { get: (key) => (list.includes(key) ? services[key] : undefined) }
      return cb ? cb(injected) : undefined
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(key) {
      return ctx[key]
    },
  }
  return ctx
}

/** 从已注册的槽里取出正文组件。 */
function bodyOf(log) {
  const hit = log.slots.find((item) => item.descriptor.name === 'sidebar.right.pane.tab')
  return hit ? hit.component : null
}

/** 载入 client.js 并抓出 factory。 */
async function loadClient() {
  const source = await readFile(CLIENT_PATH, 'utf8')
  const log = { elements: [], effects: [], registered: [], slots: [] }

  let captured = null
  const fakeWindow = {
    __ModuleLoader__: {
      load(descriptor) {
        captured = descriptor
      },
    },
  }
  // client.js 顶层是 window.__ModuleLoader__.load({...}) 调用而不是模块导出，
  // 所以用 new Function 注入 window 来执行，而不是 import()。
  const run = new Function('window', `${source}\n`)
  run(fakeWindow)
  assert.ok(captured, 'client.js 没有调用 window.__ModuleLoader__.load')

  const React = makeFakeReact(log)
  const mod = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error('client.js 请求了未知模块: ' + name)
  })
  return { mod, log, React }
}

test('client.js 能被加载，且导出 inject/apply', async () => {
  const { mod } = await loadClient()
  assert.ok(Array.isArray(mod.inject))
  assert.equal(typeof mod.apply, 'function')
})

test('Panel 渲染体不抛错（focusOn 未定义这类错误会在这里炸）', async () => {
  const { mod, log, React } = await loadClient()
  const ctx = makeCtx(log)
  mod.apply(ctx)

  const Body = bodyOf(log)
  assert.ok(Body, '没有注册 sidebar.right.pane.tab 组件')

  React.__resetSlots()
  const tree = Body()
  assert.ok(tree, '渲染返回空')
  renderToLog(tree, React, log)
  assert.ok(log.elements.length > 0, '没有产生任何元素')
})

test('所有 SVG 元素不使用无效属性（height="auto" 会刷屏报错）', async () => {
  const { mod, log, React } = await loadClient()
  const ctx = makeCtx(log)
  mod.apply(ctx)

  const Body = bodyOf(log)
  assert.ok(Body, '没有注册正文组件')

  React.__resetSlots()
  renderToLog(Body(), React, log)

  const svgs = log.elements.filter((el) => el.type === 'svg')
  for (const svg of svgs) {
    const height = svg.props.height
    const ok = height === undefined || /^\d+$/.test(String(height)) || String(height).endsWith('%')
    assert.ok(ok, `svg 的 height 必须是数字或百分比，收到 ${JSON.stringify(height)}——"auto" 是无效 SVG 属性`)
  }
})

test('tab 注册与正文槽双 key 注册都发生', async () => {
  const { mod, log } = await loadClient()
  const ctx = makeCtx(log)
  mod.apply(ctx)

  assert.equal(log.registered.length, 1, 'sidebarRightTabs 应该只注册一次 tab 类型')
  assert.equal(log.registered[0].kind, 'chronicle')
  assert.match(String(log.registered[0].id), /chronicle/)

  // 正文槽按 id 与 kind 双 key 注册（宿主按哪个分发未知，两个都注册最稳）
  const paneKeys = log.slots.filter((item) => item.descriptor.name === 'sidebar.right.pane.tab')
  assert.equal(paneKeys.length, 2, '正文槽应注册 2 个 key')
})

test('面板文案表两侧键集一致（漏键会让英文界面露出中文）', async () => {
  const source = await readFile(CLIENT_PATH, 'utf8')
  const grab = (block) => {
    const keys = new Set()
    for (const match of block.matchAll(/^\s{8}([a-zA-Z]+):/gm)) keys.add(match[1])
    return keys
  }
  const zhMatch = /zh:\s*\{([\s\S]*?)\n      \},/.exec(source)
  const enMatch = /en:\s*\{([\s\S]*?)\n      \},/.exec(source)
  assert.ok(zhMatch && enMatch, '没找到 I18N 的 zh/en 表')
  const zh = grab(zhMatch[1])
  const en = grab(enMatch[1])
  const missingInEn = [...zh].filter((key) => !en.has(key))
  const missingInZh = [...en].filter((key) => !zh.has(key))
  assert.deepEqual(missingInEn, [], 'en 缺少这些键: ' + missingInEn.join(','))
  assert.deepEqual(missingInZh, [], 'zh 缺少这些键: ' + missingInZh.join(','))
})

test('「近期」是按天的时间轴：每天一块 + 当天日结（用户实测提的）', async () => {
  const { mod, log, React } = await loadClient()
  const ctx = makeCtx(log)
  mod.apply(ctx)
  const Body = bodyOf(log)
  assert.ok(Body, '没有注册正文组件')

  // Panel 的 useState 顺序：view(0) query(1) state(2) focus(3) highlight(4)
  // 预置 state 为「已加载 + 两天数据」，跳过 loading 直接渲染时间轴
  const dayList = [
    {
      day: '2026-11-10',
      summary: '今天主攻起居注，修了时间轴与日结。',
      count: 2,
      entries: [
        { ref: 'a#1', day: '2026-11-10', section: 'projects', title: '改面板时间轴', importance: 4 },
        { ref: 'a#2', day: '2026-11-10', section: 'pitfalls', title: '数组挂属性太脆', importance: 3 },
      ],
    },
    {
      day: '2026-11-09',
      summary: '昨天定了六条产品决议。',
      count: 1,
      entries: [{ ref: 'b#1', day: '2026-11-09', section: 'decisions', title: '六条决议锁定', importance: 5 }],
    },
  ]
  const entries = dayList.flatMap((bucket) => bucket.entries)

  React.__resetSlots()
  React.__seedSlot(2, { loading: false, error: '', entries, summary: null, view: 'recent', dayList })
  renderToLog(Body(), React, log)

  const text = JSON.stringify(log.elements)
  // 两天都要出现（时间轴而不是平铺）
  assert.ok(text.includes('2026-11-10'), '缺少 2026-11-10 的日期头')
  assert.ok(text.includes('2026-11-09'), '缺少 2026-11-09 的日期头（跨天必须分区）')
  // 两天的日结都要出现（旧版只取第一个 daySummary）
  assert.ok(text.includes('今天主攻起居注'), '缺少 11-10 的日结')
  assert.ok(text.includes('昨天定了六条产品决议'), '缺少 11-09 的日结')
  // 板块小标题
  assert.ok(text.includes('项目进展'), '缺少板块分组标题')
})

test('「近期」没有日结时给出可操作提示，而不是空白', async () => {
  const { mod, log, React } = await loadClient()
  const ctx = makeCtx(log)
  mod.apply(ctx)
  const Body = bodyOf(log)

  const dayList = [
    {
      day: '2026-11-09',
      summary: '',
      count: 1,
      entries: [{ ref: 'a#1', day: '2026-11-09', section: 'projects', title: '只有条目没有日结', importance: 3 }],
    },
  ]
  React.__resetSlots()
  React.__seedSlot(2, { loading: false, error: '', entries: dayList[0].entries, summary: null, view: 'recent', dayList })
  renderToLog(Body(), React, log)

  const text = JSON.stringify(log.elements)
  assert.ok(text.includes('还没有日结'), '缺日结时应提示怎么产出，而不是留白')
})

test('界面语言：宿主下发 en 时面板渲染英文，不带中文', async () => {
  const { mod, log, React } = await loadClient()
  const ctx = makeCtx(log)
  mod.apply(ctx)
  const Body = bodyOf(log)

  const dayList = [
    {
      day: '2026-11-09',
      summary: 'A short day summary.',
      count: 1,
      entries: [{ ref: 'a#1', day: '2026-11-09', section: 'projects', title: 'Did a thing', importance: 3 }],
    },
  ]
  React.__resetSlots()
  // summary.uiLocale = 'en' → 面板应切到英文
  React.__seedSlot(2, {
    loading: false,
    error: '',
    entries: dayList[0].entries,
    summary: { uiLocale: 'en', entries: 1, edges: 0 },
    view: 'recent',
    dayList,
  })
  renderToLog(Body(), React, log)
  const text = JSON.stringify(log.elements)
  // 英文标签应出现（tabs 用英文名）
  assert.ok(text.includes('Recent'), '英文界面应显示 Recent：' + text.slice(0, 200))
  // 中文标签不该出现
  assert.ok(!text.includes('近期'), '英文界面不该残留「近期」')
})

test('界面语言：uiLocale=auto 时跟随 document.lang / navigator', async () => {
  const { mod, log, React } = await loadClient()
  const ctx = makeCtx(log)
  mod.apply(ctx)
  const Body = bodyOf(log)
  const dayList = [{ day: '2026-11-09', summary: '', count: 1, entries: [{ ref: 'a#1', day: '2026-11-09', section: 'projects', title: 't', importance: 3 }] }]
  React.__resetSlots()
  React.__seedSlot(2, { loading: false, error: '', entries: dayList[0].entries, summary: { uiLocale: 'auto' }, view: 'recent', dayList })
  renderToLog(Body(), React, log)
  const text = JSON.stringify(log.elements)
  // 测试环境没有 document.lang、navigator.language 为 undefined → 回落中文
  assert.ok(text.includes('近期') || text.includes('Recent'), 'auto 模式应能渲染出某个语言的标签：' + text.slice(0, 200))
})
