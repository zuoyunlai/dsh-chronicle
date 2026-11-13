/**
 * dsh-chronicle · 起居注 —— Client 半边（右侧栏面板）
 *
 * 三个视图共用 Host 的只读 JSON API（`/chronicle/api/*`）。
 * 面板只读：没有编辑、没有删除、没有收口按钮（规划 §11.5）。
 *
 * v0.5.1 修了两处**接口形状猜错**（不是逻辑错）：
 *   ① 令牌名：宿主里没有 `--dsw-alias-text-primary` / `--dsw-alias-bg-l2` / `--dsw-alias-brand`，
 *      正确的是 `--dsw-alias-label-primary` / `--dsw-alias-bg-layer-2` / `--dsw-alias-brand-primary`。
 *      （查 `cordis_inspect_query` client Theme.listTokens 得到的真实清单）
 *   ② 正文槽未知宿主按 `id` 还是 `kind` 分发 ⇒ 两个 key 都注册，谁生效都不会空白。
 */
window.__ModuleLoader__.load({
  id: 'dsh-chronicle',
  factory(require) {
    'use strict'
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const TAG = '[dsh-chronicle]'

    /**
     * 面板文案表。
     *
     * 为什么自带而不挂宿主 locale：宿主 slot 注册的 locale 参数形状没法从
     * app.asar 核实（客户端代码已打包），与其猜一个可能不存在的 API，
     * 不如让插件自己能中英切换 —— 面板里的文字全部走这里。
     */
    const I18N = {
      zh: {
        recent: '近期', search: '检索', related: '关联', facts: '事实', arcs: '线索', graph: '图谱',
        loading: '读取中…', loadingGraph: '载入中…',
        emptyGraph: '还没有实体：收口一次之后才会有图。',
        emptyFacts: '事实库还是空的：收口一次之后才会产出。',
        emptyArcs: '还没有跨天线索：同一件事至少要在两天里出现过。',
        emptyRecent: '还没有记录。', emptySearch: '没命中。换个词，或先收口几天。',
        factsHint: '不随日期过期的结论：约定 / 决策 / 坑（含判别信号）',
        arcsHint: '同一件事被追了几天',
        graphHint: '实体关系图：谁和谁一起出现',
        legend: '绿=结论与坑 · 黄=项目 · 褐=文件',
        hint: '滚轮缩放 / 拖背景平移 / 拖节点 / 双击复位',
        focus: '聚焦：', clear: '清除', error: '起居注面板出错：', retry: '重试',
        title: '起居注',
      },
      en: {
        recent: 'Recent', search: 'Search', related: 'Related', facts: 'Facts', arcs: 'Threads', graph: 'Graph',
        loading: 'Loading…', loadingGraph: 'Loading…',
        emptyGraph: 'No entities yet — close a day first.',
        emptyFacts: 'Fact library is empty — close a day first.',
        emptyArcs: 'No cross-day threads yet — a thread needs at least two days.',
        emptyRecent: 'Nothing recorded yet.', emptySearch: 'No hit. Try other words, or close a few days first.',
        factsHint: 'Conclusions that do not expire: conventions / decisions / pitfalls',
        arcsHint: 'Things that took several days',
        graphHint: 'Entity graph: what shows up together',
        legend: 'green=conclusions · amber=projects · brown=files',
        hint: 'wheel=zoom · drag=pan · drag node · double-click=reset',
        focus: 'Focus: ', clear: 'clear', error: 'Chronicle panel error: ', retry: 'Retry',
        title: 'Chronicle',
      },
    }
    /**
     * 界面语言。
     *
     * 检测顺序（都失败就中文）：
     *   1. 宿主注入的 getPreference('uiLocale')（用户在插件设置里手动选）
     *   2. document.documentElement.lang（宿主的界面语言会写在这里）
     *   3. navigator.language（兜底）
     *
     * 为什么不用宿主的 locale 服务：客户端代码在 app.asar 里是打包过的，
     * 核实不到那个服务的真实形状。与其猜一个可能不存在的 API，
     * 不如用标准 DOM + 一个可手动覆盖的配置项。
     */
    // apply 里把 ctx 存下来：Panel 是工厂级组件，拿不到 apply 的参数，
    // 但要订阅宿主的 locale 服务。
    let runtimeCtx = null

    /**
     * 解析界面语言。优先级：
     *   ① 配置 uiLocale（手动指定）
     *   ② 宿主 locale 服务的 active —— 宿主界面真正的语言
     *   ③ document.lang → navigator.language（浏览器/OS 兜底）
     */
    function resolveLocale(pinned, hostActive) {
      const pin = String(pinned || '').trim()
      if (pin === 'zh' || pin === 'en') return pin
      const active = String(hostActive || '').trim()
      if (/^en/i.test(active)) return 'en'
      if (/^zh/i.test(active)) return 'zh'
      const docLang = typeof document !== 'undefined' && document.documentElement && document.documentElement.lang
      if (docLang) return /^en/i.test(String(docLang)) ? 'en' : 'zh'
      const nav = typeof navigator !== 'undefined' ? navigator.language : ''
      return /^en/i.test(String(nav || '')) ? 'en' : 'zh'
    }

    let currentLocale = resolveLocale('', '')

    /** 设置页改了语言时调用（由宿主配置推下来）。 */
    function setLocale(next) {
      if (next === 'zh' || next === 'en') {
        currentLocale = next
        return true
      }
      if (next === 'auto' || !next) {
        currentLocale = resolveLocale('', '')
        return true
      }
      return false
    }

    const isZh = () => currentLocale === 'zh'
    const T2 = (key) => (currentLocale === 'zh' ? I18N.zh : I18N.en)[key] || key
    const VERSION = '2.4.1'
    const KIND = 'chronicle'

    /**
     * 起居注图标：三片竹简（内联 SVG）。
     *
     * 几何与 icon.svg 完全一致 —— 那是同一张图的矢量版：
     *   底板   x4 y4 w56 h56 rx7.2  #2E3138
     *   竹片   x12.57/26.37/40.18  w11.26 h38.86  #B39B77
     *   米色列 x16.08/29.88/43.69  w4.23 h19.04   #F1E7D4
     *   小横条 y41.25 / y44.98                    #F1E7D4
     *
     * 为什么内联而不是 <img src="icon.svg">：
     * 面板跑在 web 端，插件的静态文件没有公开 URL；内联 SVG 还能跟着
     * 主题走 currentColor（这里只有底板与竹色是固定色，条纹用固定米色）。
     *
     * 宿主的两处用法：
     *   · 指南卡片 entry.icon —— 不给就显示默认的 CubeGlyph 立方体占位符
     *   · 标签 chip —— chip 里只有标题槽的内容，宿主自己不加图标
     */
    function ChronicleIcon({ size = 22, className }) {
      const bars = []
      const xs = [12.57, 26.37, 40.18]
      const cx = [16.08, 29.88, 43.69]
      for (let i = 0; i < 3; i += 1) {
        bars.push(h('rect', { key: 'bar' + i, x: xs[i], y: 12.57, width: 11.26, height: 38.86, rx: 0.6, fill: '#B39B77' }))
        bars.push(h('rect', { key: 'col' + i, x: cx[i], y: 16.42, width: 4.23, height: 19.04, fill: '#F1E7D4' }))
        bars.push(h('rect', { key: 'r1' + i, x: cx[i], y: 41.25, width: 4.23, height: 2.15, fill: '#F1E7D4' }))
        bars.push(h('rect', { key: 'r2' + i, x: cx[i], y: 44.98, width: 4.23, height: 2.15, fill: '#F1E7D4' }))
      }
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 64 64',
          className,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', { x: 4, y: 4, width: 56, height: 56, rx: 7.2, fill: '#2E3138' }),
        ...bars,
      )
    }
    const IMPL_ID = 'dsh-chronicle.panel'

    /** 全部走宿主主题 token；token 名取自 Theme.listTokens 的真实清单，带 fallback。 */
    const T = {
      fg: 'var(--dsw-alias-label-primary, #e8eaed)',
      dim: 'var(--dsw-alias-label-secondary, rgba(232,234,237,.62))',
      faint: 'var(--dsw-alias-label-tertiary, rgba(232,234,237,.42))',
      line: 'var(--dsw-alias-border-l1, rgba(127,127,127,.2))',
      surface: 'var(--dsw-alias-bg-layer-1, transparent)',
      chip: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))',
      accent: 'var(--dsw-alias-brand-primary, #4c78ff)',
      onAccent: 'var(--dsw-alias-label-primary-inverted, #fff)',
      warn: 'var(--dsw-alias-state-warn-primary, #e8a33d)',
    }

    async function call(path, params) {
      const qs = params ? '?' + new URLSearchParams(params).toString() : ''
      const response = await fetch('/chronicle/api/' + path + qs, { headers: { accept: 'application/json' } })
      const text = await response.text()
      if (!response.ok) throw new Error('HTTP ' + response.status + ' · ' + text.slice(0, 120))
      try {
        return JSON.parse(text)
      } catch {
        // 落到 SPA fallback 会拿回 HTML —— 这里把证据留着，便于下次一眼定位
        throw new Error('返回的不是 JSON：' + text.slice(0, 80).replace(/\s+/g, ' '))
      }
    }

    function Row({ entry }) {
      const [open, setOpen] = useState(false)
      return h(
        'div',
        {
          onClick: () => setOpen(!open),
          style: { padding: '8px 2px', borderBottom: '1px solid ' + T.line, cursor: 'pointer' },
        },
        h(
          'div',
          { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
          h(
            'span',
            {
              title: '重要度 ' + (entry.importance || 1) + '/5',
              style: { color: entry.importance >= 4 ? T.warn : T.accent, fontSize: 11, flex: '0 0 auto', letterSpacing: 1 },
            },
            '★'.repeat(Math.max(1, Math.min(5, Math.round(Number(entry.importance) || 1)))),
          ),
          entry.project && entry.project !== 'unknown'
            ? h(
                'span',
                {
                  style: {
                    fontSize: 10,
                    flex: '0 0 auto',
                    padding: '0 5px',
                    borderRadius: 999,
                    background: T.chip,
                    color: T.dim,
                  },
                },
                '#' + entry.project,
              )
            : null,
          h('span', { style: { color: T.fg, fontSize: 13, lineHeight: 1.45, flex: 1, minWidth: 0 } }, entry.title || '(无标题)'),
        ),
        entry.claim
          ? h(
              'div',
              {
                style: {
                  color: T.dim,
                  fontSize: 12,
                  marginTop: 2,
                  lineHeight: 1.5,
                  display: '-webkit-box',
                  WebkitLineClamp: open ? 99 : 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                },
              },
              entry.claim,
            )
          : null,
        h(
          'div',
          { style: { color: T.faint, fontSize: 11, marginTop: 3, fontFamily: 'ui-monospace, monospace' } },
          (entry.ws && entry.ws !== 'unknown' ? entry.ws + ' · ' : '') +
            (entry.day || String(entry.ts || '').slice(0, 10)) +
            ' · ' +
            (entry.ref || ''),
        ),
        open && entry.basis
          ? h('div', { style: { color: T.dim, fontSize: 12, marginTop: 4, lineHeight: 1.5 } }, '依据：' + entry.basis)
          : null,
      )
    }

    /** 事实行：类型徽标 + 标题 + 项目 + 状态 + 命中数。 */
    function FactRow({ fact, onSelect, highlight }) {
      const badge = { decision: '决策', convention: '约定', pitfall: '坑', rejected: '被否', question: '疑问' }[fact.kind] || fact.kind
      const stateText = fact.status === 'superseded' ? '已推翻' : fact.status === 'repeated' ? '复现' : '单次'
      return h(
        'div',
        {
          onClick: onSelect ? () => onSelect(fact.title) : undefined,
          title: onSelect ? '在关系图里定位' : undefined,
          style: {
            padding: '8px 2px',
            borderBottom: '1px solid ' + T.line,
            cursor: onSelect ? 'pointer' : 'default',
            background: highlight && fact.title === highlight ? T.chip : 'transparent',
            borderRadius: highlight && fact.title === highlight ? 4 : 0,
          },
        },
        h(
          'div',
          { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
          h(
            'span',
            { style: { fontSize: 10, padding: '0 5px', borderRadius: 999, background: T.chip, color: T.dim } },
            badge,
          ),
          h('span', { style: { color: T.fg, fontSize: 13, flex: 1, minWidth: 0 } }, fact.title || '(无标题)'),
        ),
        h(
          'div',
          { style: { color: T.faint, fontSize: 11, marginTop: 3 } },
          `${fact.project} · ${stateText} · 命中${fact.hits || 0}`,
        ),
        fact.statement
          ? h(
              'div',
              {
                style: {
                  color: T.dim,
                  fontSize: 12,
                  marginTop: 3,
                  lineHeight: 1.5,
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                },
              },
              fact.statement,
            )
          : null,
      )
    }

    /** 线索行：跨了几天、哪天到哪天。 */
    function ArcRow({ arc, onSelect }) {
      return h(
        'div',
        {
          onClick: onSelect ? () => onSelect(arc.title) : undefined,
          title: onSelect ? '在关系图里定位' : undefined,
          style: {
            padding: '8px 2px',
            borderBottom: '1px solid ' + T.line,
            cursor: onSelect ? 'pointer' : 'default',
          },
        },
        h('div', { style: { color: T.fg, fontSize: 13 } }, arc.title || '(无标题)'),
        h(
          'div',
          { style: { color: T.faint, fontSize: 11, marginTop: 3 } },
          `${arc.project} · 跨 ${arc.days?.length || 0} 天 · ${arc.span}`,
        ),
      )
    }

    /**
     * 力导向布局（静态计算，不跑 requestAnimationFrame）。
     *
     * 为什么自己写：这个插件零第三方依赖，不能引 d3/vis。
     * 只需要"看起来像关系图"就够——节点数 ≤80 时 O(n²) 排斥 + 弹簧边
     * 迭代 200 次足够收敛，算一次不到 10ms。
     */
    function layoutGraph(nodes, edges, width, height) {
      const count = nodes.length || 1
      const points = nodes.map((node, index) => {
        const angle = (index / count) * Math.PI * 2
        return {
          ...node,
          x: width / 2 + Math.cos(angle) * width * 0.32,
          y: height / 2 + Math.sin(angle) * height * 0.32,
          vx: 0,
          vy: 0,
        }
      })
      const indexOf = new Map(points.map((point, index) => [String(point.name).toLowerCase(), index]))
      const links = edges
        .map((edge) => ({
          a: points[indexOf.get(String(edge.a).toLowerCase())],
          b: points[indexOf.get(String(edge.b).toLowerCase())],
          weight: edge.weight || 1,
        }))
        .filter((link) => link.a && link.b)

      for (let step = 0; step < 200; step += 1) {
        const repel = 1400 / Math.sqrt(step + 1)
        for (let i = 0; i < points.length; i += 1) {
          for (let j = i + 1; j < points.length; j += 1) {
            let dx = points[i].x - points[j].x
            let dy = points[i].y - points[j].y
            let d2 = dx * dx + dy * dy
            if (d2 < 0.01) {
              dx = (i - j) * 0.1 || 0.1
              dy = 0.1
              d2 = 0.02
            }
            const d = Math.sqrt(d2)
            const force = repel / d2
            const fx = (force * dx) / d
            const fy = (force * dy) / d
            points[i].vx += fx
            points[i].vy += fy
            points[j].vx -= fx
            points[j].vy -= fy
          }
        }
        for (const link of links) {
          const dx = link.b.x - link.a.x
          const dy = link.b.y - link.a.y
          const d = Math.sqrt(dx * dx + dy * dy) || 0.01
          const force = (d - 62) * 0.015
          const fx = (force * dx) / d
          const fy = (force * dy) / d
          link.a.vx += fx
          link.a.vy += fy
          link.b.vx -= fx
          link.b.vy -= fy
        }
        for (const point of points) {
          point.vx += (width / 2 - point.x) * 0.002
          point.vy += (height / 2 - point.y) * 0.002
          point.x = Math.max(12, Math.min(width - 12, point.x + point.vx * 0.6))
          point.y = Math.max(12, Math.min(height - 12, point.y + point.vy * 0.6))
          point.vx *= 0.62
          point.vy *= 0.62
        }
      }
      points.sort((a, b) => (a.degree || 0) - (b.degree || 0))
      return { points, links }
    }

    /** 事实节点的颜色：绿，和截图里那种分类色一致（深浅两套主题下都看得清）。 */
    const FACT_COLOR = '#4caf7d'

    /**
     * 力导向仿真：每帧 step() 一次，供 rAF 驱动，所以图是动的。
     * 节点数 ≤100 时 O(n²) 完全够用（40 节点约 800 对，每帧可忽略）。
     */
    function makeSim(nodes, edges, width, height) {
      const count = nodes.length || 1
      const points = nodes.map((node, index) => {
        const angle = (index / count) * Math.PI * 2
        return {
          ...node,
          x: width / 2 + Math.cos(angle) * width * 0.3,
          y: height / 2 + Math.sin(angle) * height * 0.3,
          vx: 0,
          vy: 0,
          fixed: false,
        }
      })
      const indexOf = new Map(points.map((point, index) => [String(point.name).toLowerCase(), index]))
      const links = edges
        .map((edge) => ({
          a: points[indexOf.get(String(edge.a).toLowerCase())],
          b: points[indexOf.get(String(edge.b).toLowerCase())],
          weight: edge.weight || 1,
        }))
        .filter((link) => link.a && link.b)

      let alpha = 1
      return {
        points,
        links,
        reheat() {
          alpha = 0.8
          if (typeof this.onReheat === 'function') this.onReheat()
        },
        step() {
          alpha *= 0.985
          const repel = 1400 * alpha + 120
          for (let i = 0; i < points.length; i += 1) {
            for (let j = i + 1; j < points.length; j += 1) {
              let dx = points[i].x - points[j].x
              let dy = points[i].y - points[j].y
              let d2 = dx * dx + dy * dy
              if (d2 < 0.01) {
                dx = (i - j) * 0.1 || 0.1
                dy = 0.1
                d2 = 0.02
              }
              const d = Math.sqrt(d2)
              const force = repel / d2
              const fx = (force * dx) / d
              const fy = (force * dy) / d
              points[i].vx += fx
              points[i].vy += fy
              points[j].vx -= fx
              points[j].vy -= fy
            }
          }
          for (const link of links) {
            const dx = link.b.x - link.a.x
            const dy = link.b.y - link.a.y
            const d = Math.sqrt(dx * dx + dy * dy) || 0.01
            const force = (d - 58) * 0.02
            const fx = (force * dx) / d
            const fy = (force * dy) / d
            link.a.vx += fx
            link.a.vy += fy
            link.b.vx -= fx
            link.b.vy -= fy
          }
          for (const point of points) {
            if (point.fixed) {
              point.vx = 0
              point.vy = 0
              continue
            }
            point.vx += (width / 2 - point.x) * 0.0025
            point.vy += (height / 2 - point.y) * 0.0025
            point.x = Math.max(10, Math.min(width - 10, point.x + point.vx * 0.6))
            point.y = Math.max(10, Math.min(height - 10, point.y + point.vy * 0.6))
            point.vx *= 0.6
            point.vy *= 0.6
          }
        },
      }
    }

    /**
     * 关系图谱：文件 / 项目 / 事实三类节点，支持缩放、拖动、节点拖拽。
     *
     * 三条实测反馈都在这里修：
     * ① 图是动的（rAF 逐步降温，看得见收敛过程）
     * ② 能缩放（滚轮）与平移（拖背景），双击复位
     * ③ 节点不再只是文件名——事实（决策/坑/约定）才是主角，绿色高亮
     */
    function GraphView({ data, focus, onClear, onNodeClick }) {
      const width = 420
      const height = 300
      const [view, setView] = React.useState({ k: 1, x: 0, y: 0 })
      const [frame, setFrame] = React.useState(0)
      const simRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const clickRef = React.useRef(null)
      const panRef = React.useRef(null)

      React.useEffect(() => {
        const focusName = String(focus || '').trim().toLowerCase()
        const sim = makeSim(data?.nodes || [], data?.edges || [], width, height)
        simRef.current = sim
        setView({ k: 1, x: 0, y: 0 })
        let handle = 0
        let count = 0
        let running = true
        const tick = () => {
          if (!running) return
          sim.step()
          count += 1
          if (count % 2 === 0) setFrame((value) => value + 1)
          // 关键修复（审计 P2-15）：原来 140 帧后**永久停掉**，
          // 于是 reheat() 无人消费 —— 拖拽只写 point.x/y，其它节点与连边完全不响应。
          // 现在上限变成"连续无活动 140 帧"，reheat 会重新点亮循环。
          if (count < 140 || sim.alpha > 0.05) handle = requestAnimationFrame(tick)
          else setFrame((value) => value + 1)
        }
        handle = requestAnimationFrame(tick)
        // reheat 时重新点亮 rAF 循环
        sim.onReheat = () => {
          count = 0
          if (!running) return
          cancelAnimationFrame(handle)
          handle = requestAnimationFrame(tick)
        }
        // 收敛后把焦点节点拖到画布中心（k=1.6）：从事实/线索点进来时直接看到它
        if (focusName) {
          const timer = setTimeout(() => {
            const target = sim.points.find((item) => String(item.name).toLowerCase() === focusName)
            if (target) {
              const k = 1.6
              setView({ k, x: width / 2 - target.x * k, y: height / 2 - target.y * k })
            }
          }, 900)
          return () => {
            running = false
            cancelAnimationFrame(handle)
            clearTimeout(timer)
          }
        }
        return () => {
          running = false
          cancelAnimationFrame(handle)
        }
      }, [data, focus])

      const sim = simRef.current
      if (!sim) {
        // 首帧：仿真还没建好，不是「没有数据」——别显示误导性的空态（审计 P2-17）
        return h('div', { style: { color: T.faint, fontSize: 12, padding: 12 } }, T2('loadingGraph'))
      }
      if (sim.points.length === 0) {
        return h('div', { style: { color: T.faint, fontSize: 12, padding: 12 } }, T2('emptyGraph'))
      }

      const toLocal = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        return {
          x: ((event.clientX - rect.left) / rect.width) * width,
          y: ((event.clientY - rect.top) / rect.height) * height,
        }
      }

      const maxDegree = Math.max(1, ...sim.points.map((point) => point.degree || 0))
      const focusKey = String(focus || '').trim().toLowerCase()
      const radiusOf = (point) => {
        const base = point.kind === 'fact' ? 3.4 : 2 + 3.4 * ((point.degree || 0) / maxDegree)
        const boosted = focusKey && String(point.name).toLowerCase() === focusKey ? base * 1.6 : base
        return boosted * Math.sqrt(view.k)
      }

      return h(
        'div',
        null,
        focusKey
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 10,
                  color: T.dim,
                  marginTop: 4,
                },
              },
              h('span', null, T2('focus') + focus),
              h(
                'span',
                {
                  onClick: onClear,
                  title: '取消聚焦',
                  style: { cursor: 'pointer', color: T.faint, border: '1px solid ' + T.line, borderRadius: 999, padding: '0 5px' },
                },
                T2('clear'),
              ),
            )
          : null,
        h(
          'svg',
          {
            viewBox: `0 0 ${width} ${height}`,
            width: '100%',
            // 高度交给 CSS：`height="auto"` 是无效的 SVG 属性，
            // 浏览器每次渲染都会报 "Expected length, auto"（实测刷屏 8 条）
            style: {
              display: 'block',
              height: 'auto',
              background: T.chip,
              borderRadius: 8,
              marginTop: 4,
              touchAction: 'none',
              cursor: 'grab',
            },
            onWheel: (event) => {
              const factor = event.deltaY > 0 ? 0.9 : 1.1
              setView((value) => ({ ...value, k: Math.max(0.4, Math.min(3, value.k * factor)) }))
            },
            onPointerDown: (event) => {
              panRef.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y }
              event.currentTarget.setPointerCapture?.(event.pointerId)
            },
            onPointerMove: (event) => {
              if (dragRef.current) {
                const local = toLocal(event)
                const point = dragRef.current.point
                point.x = Math.max(6, Math.min(width - 6, local.x))
                point.y = Math.max(6, Math.min(height - 6, local.y))
                sim.reheat()
                setFrame((value) => value + 1)
                return
              }
              const pan = panRef.current
              if (!pan) return
              // 必须在调用 setView 之前把 ref 的值取出来。
              // setState 的 updater 是延迟执行的：等它跑时 onPointerUp 可能已经把
              // panRef.current 置成 null，读 ref 就会炸（2026-11-10 实测：
              // “Cannot read properties of null (reading 'vx')”）。
              const dx = event.clientX - pan.x
              const dy = event.clientY - pan.y
              const nextX = pan.vx + dx
              const nextY = pan.vy + dy
              setView((value) => ({ ...value, x: nextX, y: nextY }))
            },
            onPointerUp: () => {
              if (dragRef.current) {
                dragRef.current.point.fixed = false
                dragRef.current = null
                sim.reheat()
              }
              panRef.current = null
            },
            onDoubleClick: () => setView({ k: 1, x: 0, y: 0 }),
          },
          h(
            'g',
            { transform: `translate(${view.x} ${view.y}) scale(${view.k}) translate(${width / 2 - width / 2} 0)` },
            sim.links.map((link, index) =>
              h('line', {
                key: 'e' + index,
                x1: link.a.x,
                y1: link.a.y,
                x2: link.b.x,
                y2: link.b.y,
                stroke: T.line,
                strokeWidth: 0.4 + Math.min(1.2, (link.weight || 1) * 0.2),
                opacity: 0.5,
              }),
            ),
            sim.points
              .filter((point) => focusKey && String(point.name).toLowerCase() === focusKey)
              .map((point) =>
                h('circle', {
                  key: 'ring-' + point.name,
                  cx: point.x,
                  cy: point.y,
                  r: radiusOf(point) + 3,
                  fill: 'none',
                  stroke: FACT_COLOR,
                  strokeWidth: 1.2,
                  opacity: 0.9,
                }),
              ),
            sim.points.map((point) =>
              h(
                'circle',
                {
                  key: 'n' + point.name,
                  cx: point.x,
                  cy: point.y,
                  r: radiusOf(point),
                  fill: point.kind === 'fact' ? FACT_COLOR : point.kind === 'llm' ? T.warn : T.accent,
                  stroke: point.kind === 'fact' ? T.chip : 'none',
                  strokeWidth: 1,
                  style: { cursor: 'pointer' },
                  onPointerDown: (event) => {
                    event.stopPropagation()
                    // 自己捕获指针：否则指针移出 circle 后 onPointerMove/onPointerUp 都不再触发，
                    // dragRef 残留、point.fixed 永远 true ⇒ 节点被永久钉死（审计 P2-16）
                    try {
                      event.target.setPointerCapture?.(event.pointerId)
                    } catch {
                      /* 某些环境不支持捕获，忽略 */
                    }
                    dragRef.current = { point }
                    clickRef.current = { name: point.name, kind: point.kind, x: event.clientX, y: event.clientY, moved: false }
                    point.fixed = true
                  },
                  onPointerMove: (event) => {
                    const click = clickRef.current
                    if (!click) return
                    if (Math.abs(event.clientX - click.x) + Math.abs(event.clientY - click.y) > 4) click.moved = true
                  },
                  onPointerUp: () => {
                    // 拖动过就不算点击：否则每次拖节点都会误跳视图
                    const click = clickRef.current
                    clickRef.current = null
                    if (click && !click.moved && typeof onNodeClick === 'function') {
                      onNodeClick(click.name, click.kind)
                    }
                  },
                },
                h('title', null, `${point.name}${point.factKind ? ' · ' + point.factKind : ''} · 度数 ${point.degree || 0}`),
              ),
            ),
            sim.points
              .filter(
                (point) =>
                  point.kind === 'fact' ||
                  (point.degree || 0) >= maxDegree * 0.45 ||
                  view.k >= 1.8,
              )
              .map((point) =>
                h(
                  'text',
                  {
                    key: 't' + point.name,
                    x: point.x,
                    y: point.y - radiusOf(point) - 2,
                    fontSize: point.kind === 'fact' ? 6.6 : 6.2,
                    fill: point.kind === 'fact' ? T.fg : T.dim,
                    textAnchor: 'middle',
                  },
                  point.name.length > 16 ? point.name.slice(0, 15) + '…' : point.name,
                ),
              ),
          ),
        ),
        h(
          'div',
          { style: { color: T.faint, fontSize: 10.5, padding: '6px 0', lineHeight: 1.6 } },
          `${sim.points.length} 节点 / ${sim.links.length} 边 · `,
          h('span', { style: { color: FACT_COLOR } }, '绿=结论与坑'),
          ' · ',
          h('span', { style: { color: T.warn } }, '黄=项目'),
          ' · ',
          h('span', { style: { color: T.accent } }, '褐=文件'),
          ' · 滚轮缩放 / 拖背景平移 / 拖节点 / 双击复位',
        ),
      )
    }

    /* ---------- 图表（HTML/CSS，不用 SVG） ----------
       教训（2026-11-10 实测）：窄栏里用固定 viewBox 的 SVG，文字会被横向压扁甚至裁掉，
       列一多数字就重叠。条形/柱状这类东西交给 flex 与百分比，浏览器自己分配宽度更稳。
       只有关系图那种需要坐标变换的才用 SVG。 */

    const CHART = {
      head: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 10, marginBottom: 4 },
      row: { display: 'flex', alignItems: 'center', gap: 6, height: 16, fontSize: 10 },
      label: { flex: '0 0 30px', color: 'inherit', whiteSpace: 'nowrap', overflow: 'hidden' },
      track: { flex: 1, position: 'relative', height: 7, borderRadius: 2, background: 'currentColor', opacity: 1 },
      fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 2 },
      count: { flex: '0 0 34px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', opacity: 0.85 },
    }

    /** C1 · 事实构成 + 缺口：一行一类，条内左段=可用、右段=缺口。 */
    function FactsBars({ data }) {
      if (!data || !data.rows || data.rows.length === 0) return null
      const colorOf = (kind) =>
        kind === 'pitfall' ? T.warn : kind === 'decision' ? T.accent : kind === 'convention' ? FACT_COLOR : T.dim
      return h(
        'div',
        { style: { marginTop: 12 } },
        h(
          'div',
          { style: { ...CHART.head, color: T.dim } },
          h('span', null, `事实构成 · ${data.total} 条`),
          h('span', { style: { color: data.debt > 0 ? T.warn : T.faint } }, data.debt > 0 ? `缺口 ${data.debt}` : '无缺口'),
        ),
        data.rows.map((row) =>
          h(
            'div',
            { key: row.kind, style: { ...CHART.row, color: T.fg } },
            h('span', { style: CHART.label }, row.label),
            h(
              'span',
              { style: { ...CHART.track, background: T.line } },
              h('span', {
                style: {
                  ...CHART.fill,
                  width: `${Math.max(2, (row.filled / Math.max(1, row.total)) * 100)}%`,
                  background: colorOf(row.kind),
                },
              }),
            ),
            h('span', { style: CHART.count }, `${row.filled}/${row.total}`),
          ),
        ),
        h('div', { style: { fontSize: 9.5, marginTop: 4, color: data.debt > 0 ? T.dim : T.faint, lineHeight: 1.5 } }, data.headline),
      )
    }

    /** C2 · 近 N 天堆叠柱：0 条的那天画 1px 基线块，区分「没干活」与「没数据」。 */
    function DailyBars({ data, dropped }) {
      if (!data || !data.days || data.days.length === 0) return null
      const colorOf = (key) =>
        key === 'pitfalls' ? T.warn : key === 'decisions' ? T.accent : key === 'projects' ? FACT_COLOR : T.dim
      return h(
        'div',
        { style: { marginTop: 12 } },
        h(
          'div',
          { style: { ...CHART.head, color: T.dim } },
          h('span', null, `近 ${data.span} 天 · ${data.total} 条`),
          dropped > 0 ? h('span', { style: { color: T.warn } }, `丢弃 ${dropped}`) : h('span', null, ''),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-end', gap: 2, height: 54 } },
          data.days.map((day) => {
            const segments = [
              ['projects', day.projects],
              ['decisions', day.decisions],
              ['pitfalls', day.pitfalls],
              ['others', day.others],
            ].filter(([, value]) => value > 0)
            return h(
              'div',
              {
                key: day.day,
                title: `${day.day} · ${day.total} 条`,
                style: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', minWidth: 0 },
              },
              day.total === 0
                ? h('div', { style: { height: 1, background: T.line } })
                : segments.map(([key, value]) =>
                    h('div', {
                      key,
                      style: {
                        height: `${Math.max(6, (value / data.max) * 46)}px`,
                        background: colorOf(key),
                        borderRadius: 1,
                        marginTop: 1,
                      },
                    }),
                  ),
            )
          }),
        ),
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', fontSize: 9, color: T.faint, marginTop: 3 } },
          h('span', null, data.days[0].day.slice(5)),
          h('span', null, data.days[data.days.length - 1].day.slice(5)),
        ),
      )
    }

    /** C3 · 跨天线索：和堆叠柱共用日轴；无线索时整体不渲染。 */
    function ArcSpans({ data, axis }) {
      if (!data || !data.rows || data.rows.length === 0) return null
      const days = (axis && axis.days) || []
      const indexOf = new Map(days.map((item, index) => [item.day, index]))
      const span = Math.max(1, days.length)
      return h(
        'div',
        { style: { marginTop: 12 } },
        h(
          'div',
          { style: { ...CHART.head, color: T.dim } },
          h('span', null, `跨天线索 · ${data.rows.length}${data.rest ? '+' + data.rest : ''}`),
          h('span', null, ''),
        ),
        data.rows.map((arc) => {
          const first = indexOf.has(arc.days[0]) ? indexOf.get(arc.days[0]) : 0
          const last = indexOf.has(arc.days[arc.days.length - 1]) ? indexOf.get(arc.days[arc.days.length - 1]) : span - 1
          return h(
            'div',
            { key: arc.id || arc.title, style: { ...CHART.row, height: 18, color: T.fg } },
            h(
              'span',
              { style: { ...CHART.label, flex: '0 0 96px', color: T.dim } },
              arc.title.length > 12 ? arc.title.slice(0, 11) + '…' : arc.title,
            ),
            h(
              'span',
              { style: { ...CHART.track, height: 5, background: T.line } },
              h('span', {
                style: {
                  ...CHART.fill,
                  left: `${(first / span) * 100}%`,
                  width: `${Math.max(4, ((last - first + 1) / span) * 100)}%`,
                  background: FACT_COLOR,
                },
              }),
            ),
          )
        }),
        data.rest > 0 ? h('div', { style: { fontSize: 9, color: T.faint } }, `还有 ${data.rest} 条未显示`) : null,
      )
    }

    /**
     * 「近期」= 按天的**时间轴**。
     *
     * 改版原因（2026-11-10 用户实测）：「近期里没有时间轴」。
     * 旧版把 7 天的条目按板块混在一起平铺，跨天不分区，
     * 于是「哪件事是哪天做的」完全看不出来 —— 又回到了「条目孤立无意义」。
     *
     * 现在每天一块：
     *   日期 + 星期 + 条数
     *   当天日结（LLM 写的；没有就提示怎么产出）
     *   当天条目，按 项目/决策/坑/其余 分组
     */
    const SECTION_ORDER = ['projects', 'decisions', 'conventions', 'pitfalls', 'rejected', 'questions', 'threads']
    const SECTION_TITLES = {
      projects: '项目进展',
      decisions: '结论与决策',
      conventions: '约定与口径',
      pitfalls: '坑与根因',
      rejected: '被否方案',
      questions: '未答问题',
      threads: '其余进展',
    }

    const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

    /** 某天的星期（用本地时区，别用 UTC 否则跨时区会差一天）。 */
    function weekdayOf(day) {
      const date = new Date(day + 'T12:00:00')
      return Number.isNaN(date.getTime()) ? '' : WEEKDAYS[date.getDay()]
    }

    /** 渲染一天之内的条目：按板块分组，组内保持已排好的顺序。 */
    function renderDayEntries(entries) {
      const groups = new Map()
      for (const entry of entries) {
        const key = SECTION_ORDER.includes(entry.section) ? entry.section : 'threads'
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(entry)
      }
      const nodes = []
      for (const key of SECTION_ORDER) {
        const list = groups.get(key)
        if (!list || list.length === 0) continue
        nodes.push(
          h(
            'div',
            {
              key: 'sec-' + key,
              style: { fontSize: 10, color: T.faint, margin: '6px 0 2px', letterSpacing: '.04em' },
            },
            `${SECTION_TITLES[key]} · ${list.length}`,
          ),
        )
        for (const entry of list) nodes.push(h(Row, { key: entry.ref, entry }))
      }
      return nodes
    }

    /** 一天的卡片：日期头 + 日结 + 当天条目。 */
    function renderDay(bucket) {
      const nodes = []
      nodes.push(
        h(
          'div',
          {
            key: 'day-' + bucket.day,
            style: {
              display: 'flex',
              alignItems: 'baseline',
              gap: 6,
              margin: '14px 0 4px',
              paddingBottom: 3,
              borderBottom: '1px solid ' + T.line,
            },
          },
          h('span', { style: { fontSize: 12, fontWeight: 600, color: T.fg } }, bucket.day),
          h('span', { style: { fontSize: 10, color: T.faint } }, weekdayOf(bucket.day)),
          h('span', { style: { fontSize: 10, color: T.faint, marginLeft: 'auto' } }, `${bucket.count} 条`),
        ),
      )
      if (bucket.summary) {
        nodes.push(
          h(
            'div',
            {
              key: 'sum-' + bucket.day,
              style: {
                margin: '6px 0 4px',
                padding: '7px 10px',
                borderLeft: '2px solid ' + T.accent,
                background: T.chip,
                borderRadius: 4,
                color: T.fg,
                fontSize: 12,
                lineHeight: 1.65,
                whiteSpace: 'pre-wrap',
              },
            },
            bucket.summary,
          ),
        )
      } else {
        nodes.push(
          h(
            'div',
            {
              key: 'nosum-' + bucket.day,
              style: { fontSize: 10, color: T.faint, margin: '4px 0 2px', fontStyle: 'italic' },
            },
            '这一天还没有日结（用 llm 档收口那天即可生成）',
          ),
        )
      }
      nodes.push(...renderDayEntries(bucket.entries))
      return nodes
    }

    /** 时间轴主体：新的一天在上。 */
    function renderTimeline(dayList, entries) {
      // 后端没给 dayList 时（老版本 / 空数据）退化成按 entry.day 自己分
      const buckets =
        Array.isArray(dayList) && dayList.length > 0
          ? dayList
          : (() => {
              const map = new Map()
              for (const entry of entries) {
                const key = String(entry.day || '')
                if (!map.has(key)) map.set(key, { day: key, summary: '', count: 0, entries: [] })
                const bucket = map.get(key)
                if (!bucket.summary && entry.daySummary) bucket.summary = entry.daySummary
                bucket.count += 1
                bucket.entries.push(entry)
              }
              return [...map.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
            })()

      if (buckets.length === 0) return null
      const nodes = []
      for (const bucket of buckets) nodes.push(...renderDay(bucket))
      return nodes
    }

    function Panel() {
      const [view, setView] = useState('recent')
      const [query, setQuery] = useState('')
      const [state, setState] = useState({ loading: true, error: '', entries: [], summary: null, dayList: [] })
      // 宿主界面语言：订阅 locale 服务（active 就是它当前的语言）。
      // 用 state 存 —— 模块级变量改了不会触发 React 重渲染。
      const [hostLocale, setHostLocale] = useState('')
      useEffect(() => {
        const service =
          runtimeCtx && typeof runtimeCtx.get === 'function' ? runtimeCtx.get('locale') : null
        if (!service || typeof service.getSnapshot !== 'function') return
        const sync = () => {
          const snapshot = service.getSnapshot()
          setHostLocale(snapshot && snapshot.active ? String(snapshot.active) : '')
        }
        sync()
        if (typeof service.subscribe !== 'function') return
        return service.subscribe(sync)
      }, [])
      // 渲染期把语言同步给 T2（模块级），这样同一趟渲染里取到的就是对的
      currentLocale = resolveLocale(state.summary && state.summary.uiLocale, hostLocale)
      // 从「事实 / 线索」点进图谱时记住要聚焦哪个节点
      const [focus, setFocus] = useState('')
      // 从图谱点进「事实」时高亮那一条
      const [highlight, setHighlight] = useState('')
      const seq = useRef(0)
      // 渲染期同步语言：state.summary.uiLocale 由宿主下发。
      // 不能只在 load() 里 setLocale —— 重渲染时（比如切视图）就拿不到了。
      if (state.summary && (state.summary.uiLocale === 'zh' || state.summary.uiLocale === 'en')) {
        currentLocale = state.summary.uiLocale
      }

      // 图谱 → 视图：绿点（事实）去事实库定位，褐点/黄点（文件/项目）去检索
      const nodeClick = useCallback((name, kind) => {
        const label = String(name || '').trim()
        if (!label) return
        if (kind === 'fact') {
          setHighlight(label)
          setView('facts')
          return
        }
        setHighlight('')
        setQuery(label)
        setView('search')
      }, [])

      const focusOn = useCallback((name) => {
        setFocus(String(name || ''))
        setView('graph')
      }, [])

      const load = useCallback(async (nextView, nextQuery) => {
        const mine = ++seq.current
        setState((prev) => ({ ...prev, loading: true, error: '' }))
        try {
          const summary = await call('summary')
          let entries = []
          let view2 = nextView
          let dayList = []
          if (nextView === 'recent') {
            const data = await call('recent', { days: '7', limit: '50' })
            entries = data.entries || []
            // 时间轴：按天分块，每块带当天日结（原来是平铺，跨天混成一锅）
            dayList = data.dayList || []
          } else if (nextView === 'facts') {
            const data = await call('facts', { limit: '100' })
            entries = data.facts || []
          } else if (nextView === 'arcs') {
            const data = await call('arcs')
            entries = data.arcs || []
          } else if (nextView === 'graph') {
            const [data, viz] = await Promise.all([call('graph', { limit: '80' }), call('viz', { days: '14' })])
            data.viz = viz
            entries = data.nodes && data.nodes.length > 0 ? [data] : []
          } else if (nextQuery.trim()) {
            const key = nextView === 'search' ? 'search' : 'related'
            const param = nextView === 'search' ? { q: nextQuery.trim() } : { name: nextQuery.trim() }
            const data = await call(key, param)
            entries = data.results || data.entries || []
          }
          if (mine !== seq.current) return
          // 宿主下发的界面语言优先于自动检测（'auto' 时保持检测结果）
          if (summary && typeof summary.uiLocale === 'string' && summary.uiLocale !== 'auto') setLocale(summary.uiLocale)
          setState({ loading: false, error: '', entries, summary, view: view2, dayList })
        } catch (error) {
          if (mine !== seq.current) return
          setState({ loading: false, error: String((error && error.message) || error), entries: [], summary: null })
        }
      }, [])

      useEffect(() => {
        void load(view, query)
      }, [view, load])

      const submit = useCallback(
        (event) => {
          if (event && event.preventDefault) event.preventDefault()
          void load(view, query)
        },
        [load, view, query],
      )

      const tabs = [
        ['recent', T2('recent')],
        ['search', T2('search')],
        ['related', T2('related')],
        ['facts', T2('facts')],
        ['arcs', T2('arcs')],
        ['graph', T2('graph')],
      ]
      const summary = state.summary

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            padding: '0 10px',
            color: T.fg,
            fontFamily: 'inherit',
            boxSizing: 'border-box',
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              gap: 6,
              padding: '8px 0',
              borderBottom: '1px solid ' + T.line,
              flex: '0 0 auto',
            },
          },
          tabs.map(([key, label]) =>
            h(
              'button',
              {
                key,
                type: 'button',
                onClick: () => setView(key),
                style: {
                  padding: '3px 10px',
                  fontSize: 12,
                  lineHeight: 1.6,
                  borderRadius: 999,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  border: '1px solid ' + (view === key ? T.accent : T.line),
                  background: view === key ? T.accent : 'transparent',
                  color: view === key ? T.onAccent : T.fg,
                },
              },
              label,
            ),
          ),
        ),
        view === 'recent'
          ? h(
              'div',
              { style: { color: T.faint, fontSize: 11, padding: '6px 0', flex: '0 0 auto' } },
              summary ? `共 ${summary.entries} 条 · ${summary.edges} 条边 · 今日 ${summary.todayEntries} 条` : '',
            )
          : view === 'facts' || view === 'arcs' || view === 'graph'
            ? h(
                'div',
                { style: { color: T.faint, fontSize: 11, padding: '6px 0', flex: '0 0 auto' } },
                view === 'facts'
                  ? T2('factsHint')
                  : view === 'arcs'
                    ? T2('arcsHint')
                    : T2('graphHint'),
              )
            : h(
              'form',
              { onSubmit: submit, style: { display: 'flex', gap: 6, padding: '8px 0', flex: '0 0 auto' } },
              h('input', {
                value: query,
                onChange: (event) => setQuery(event.target.value),
                placeholder: view === 'search' ? '关键词 / 实体 / 一句话' : '实体名，如 dsh-chronicle',
                style: {
                  flex: 1,
                  minWidth: 0,
                  padding: '4px 8px',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  color: T.fg,
                  background: T.chip,
                  border: '1px solid ' + T.line,
                  borderRadius: 6,
                  outline: 'none',
                },
              }),
              h(
                'button',
                {
                  type: 'submit',
                  style: {
                    padding: '4px 10px',
                    fontSize: 12,
                    fontFamily: 'inherit',
                    cursor: 'pointer',
                    borderRadius: 6,
                    border: '1px solid ' + T.line,
                    background: T.surface,
                    color: T.fg,
                  },
                },
                '查',
              ),
            ),
        h(
          'div',
          { style: { flex: 1, overflowY: 'auto', minHeight: 0, paddingBottom: 8 } },
          state.loading
            ? h('div', { style: { color: T.faint, fontSize: 12, padding: 12 } }, T2('loading'))
            : state.error
              ? h(
                  'div',
                  { style: { color: T.dim, fontSize: 12, padding: 12, lineHeight: 1.6 } },
                  '读不到数据：',
                  h('code', { style: { fontSize: 11, wordBreak: 'break-all' } }, state.error),
                )
              : state.entries.length === 0
                ? h(
                    'div',
                    { style: { color: T.faint, fontSize: 12, padding: 12, lineHeight: 1.6 } },
                    view === 'recent'
                      ? `还没有记录（${summary ? summary.entries : 0} 条）。说一句「收口今天」，或等收口时刻。`
                      : view === 'facts'
                        ? T2('emptyFacts')
                        : view === 'arcs'
                          ? T2('emptyArcs')
                          : view === 'graph'
                            ? T2('emptyGraph')
                          : '没命中。换个词，或先收口几天。',
                  )
                : view === 'facts'
                  ? state.entries.map((fact) => h(FactRow, { key: fact.id, fact, onSelect: focusOn, highlight }))
                  : view === 'arcs'
                    ? state.entries.map((arc) => h(ArcRow, { key: arc.id, arc, onSelect: focusOn }))
                    : view === 'graph'
                      ? h(
                          'div',
                          null,
                          h(GraphView, {
                            data: state.entries[0],
                            focus: focus,
                            onClear: () => setFocus(''),
                            onNodeClick: nodeClick,
                          }),
                          h(FactsBars, { data: state.entries[0]?.viz?.facts }),
                          h(DailyBars, {
                            data: state.entries[0]?.viz?.daily,
                            dropped: state.summary?.dropped,
                          }),
                          h(ArcSpans, { data: state.entries[0]?.viz?.arcs, axis: state.entries[0]?.viz?.daily }),
                        )
                    : renderTimeline(state.dayList, state.entries),
        ),
      )
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      /** 复位：面板出错后给宿主一个「重试」入口，否则一次异常要重启 DSH。 */
      reset = () => this.setState({ error: null })

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { style: { padding: 12, fontSize: 12, color: T.dim, lineHeight: 1.6 } },
            h('div', null, T2('error')),
            h(
              'div',
              { style: { marginTop: 4, color: T.faint, wordBreak: 'break-all' } },
              String((this.state.error && this.state.error.message) || this.state.error),
            ),
            // 复位入口：没有它，一次异常会让面板在本次宿主生命周期内永久报废
            h(
              'button',
              {
                type: 'button',
                onClick: this.reset,
                style: {
                  marginTop: 10,
                  padding: '3px 10px',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  borderRadius: 6,
                  border: '1px solid ' + T.line,
                  background: T.surface,
                  color: T.fg,
                },
              },
              T2('retry'),
            ),
          )
        }
        return this.props.children
      }
    }

    const Body = () => h(Boundary, null, h(Panel))

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'locale'],
      apply(ctx) {
        runtimeCtx = ctx
        try {
          console.info(TAG, 'client v' + VERSION + ' loaded')
        } catch {
          /* ignore */
        }

        ctx.effect(() =>
          ctx.inject(['sidebarRightTabs', 'sidebarRight'], (injected) => {
            const tabs = injected.get('sidebarRightTabs')
            if (!tabs || typeof tabs.register !== 'function') return
            const disposers = []
            try {
              disposers.push(
                tabs.register({
                  id: IMPL_ID,
                  kind: KIND,
                  keepMounted: true,
                  priority: 'extension',
                  title: () => T2('title'),
                  // icon 必须给：不给的话宿主会用默认的 CubeGlyph（一个立方体占位符）
                  guide: [{ id: KIND, order: 60, title: () => T2('title'), icon: ChronicleIcon }],
                }),
              )
            } catch (error) {
              console.warn(TAG, '注册 tab 类型失败：', (error && error.message) || error)
              return
            }

            // 正文：宿主按 id 还是按 kind 分发没有文档，两个 key 都注册。
            // 两个不同 key 不冲突；命中哪个都能渲染，避免"tab 在、内容空"。
            for (const key of [IMPL_ID, KIND]) {
              try {
                disposers.push(
                  ctx.slots.inject('sidebar.right.pane.tab', () =>
                    ctx.slots.register({ name: 'sidebar.right.pane.tab', key }, Body),
                  ),
                )
                disposers.push(
                  ctx.slots.inject('sidebar.right.pane.tab.title', () =>
                    ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key }, () =>
                      // 标签 chip 里只有这个槽的内容（宿主不加图标），
                      // 所以「标签前的图标」就得自己画在这里。
                      h(
                        'span',
                        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                        h(ChronicleIcon, { size: 16 }),
                        h('span', { style: { fontSize: 12 } }, T2('title')),
                      ),
                    ),
                  ),
                )
              } catch (error) {
                console.warn(TAG, '注册面板槽失败（key=' + key + '）：', (error && error.message) || error)
              }
            }

            return () => {
              for (const dispose of disposers) {
                try {
                  if (typeof dispose === 'function') dispose()
                } catch {
                  /* ignore */
                }
              }
            }
          }),
        )
      },
    }
  },
})
