/**
 * 渲染：把「某周若干天的打分结果」渲染成一份 Markdown。
 *
 * 硬性要求：**幂等**。同样的 entries + promptVersion 必须产出逐字节相同的文本，
 * 所以这里禁止出现生成时间、随机 id、当前时区之类会漂移的东西。
 * frontmatter 里的 `prompt` 就是幂等键之一：改打分口径 ⇒ 提升版本号 ⇒ 旧文件保留。
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * Obsidian 标签：去掉空白与方括号，中文保留。
 * 用它把每条记录挂到项目上，点标签就能筛出同一项目的全部记录。
 */
function tagOf(project) {
  const name = String(project || '').trim()
  if (!name || name === 'unknown') return ''
  return '#' + name.replace(/[\s#[\]|]+/g, '-')
}

function listItem(entry) {
  const claim = entry.claim ? ` — ${entry.claim}` : ''
  const where = entry.ws && entry.ws !== 'unknown' ? `（${entry.ws}）` : ''
  const tag = tagOf(entry.project)
  return '- ' + (tag ? tag + ' ' : '') + '**★' + entry.importance + ' ' + entry.title + '**' + claim + where + ' · `' + entry.ref + '`'
}

function fmtDay(day) {
  const d = new Date(`${day}T12:00:00`)
  return `${day} · ${WEEKDAYS[d.getDay()]}`
}

function entryBlock(entry) {
  const lines = [`### ★${entry.importance} ${entry.title}`]
  if (entry.claim) lines.push(`- 结论：${entry.claim}`)
  if (entry.basis) lines.push(`- 依据：${entry.basis}`)
  const where = [entry.ws && entry.ws !== 'unknown' ? `工作区 \`${entry.ws}\`` : '', `证据 \`${entry.ref}\``]
    .filter(Boolean)
    .join(' · ')
  lines.push(`- ${where}`)
  return lines.join('\n')
}

/**
 * @param {object} input
 * @param {string} input.weekId        例 2026-W45
 * @param {Array<{day:string, entries:Array}>} input.days
 * @param {number} [input.floor]       低于此分折叠进附录
 * @param {string} [input.promptVersion]
 * @param {string[]} [input.entities]  本周出现的实体（P2 起才有）
 */
export function renderWeek({ weekId, days, floor = 3, promptVersion = 'v1', entities = [] }) {
  const dates = days.map((d) => d.day).sort()
  const all = days.flatMap((d) => d.entries.map((e) => ({ ...e, day: d.day })))
  const importanceMax = all.reduce((m, e) => Math.max(m, e.importance || 1), 1)
  const high = all.filter((e) => (e.importance || 1) >= floor)
  const low = all.filter((e) => (e.importance || 1) < floor)

  // 跨工作区汇总：标签与计数都从条目里长出来，不额外维护
  const byWorkspace = new Map()
  for (const entry of all) {
    const ws = entry.ws && entry.ws !== 'unknown' ? entry.ws : 'unknown'
    byWorkspace.set(ws, (byWorkspace.get(ws) || 0) + 1)
  }
  const workspaces = [...byWorkspace.keys()].sort()

  const fm = [
    '---',
    `id: ${weekId}`,
    'kind: chronicle',
    `prompt: ${promptVersion}`,
    `dates: [${dates.join(', ')}]`,
    `importance_max: ${importanceMax}`,
    `entries: ${all.length}`,
    `sessions: ${new Set(all.map((e) => String(e.ref).split('#')[0])).size}`,
    `workspaces: [${workspaces.join(', ')}]`,
    entities.length ? `entities: [${entities.join(', ')}]` : 'entities: []',
    `tags: [chronicle/${weekId.slice(0, 4)}-${weekId.split('-W')[1] ? 'W' + weekId.split('-W')[1] : '00'}]`,
    '---',
    '',
    `# ${weekId}`,
    '',
    `本期 ${all.length} 条，其中 ★${floor} 及以上 ${high.length} 条。`,
    '',
    `按工作区：${[...byWorkspace.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([ws, count]) => `${ws} ${count} 条`)
      .join(' · ')}`,
    '',
  ]

  const body = []
  for (const day of days) {
    const mine = all.filter((e) => e.day === day.day)
    if (mine.length === 0) continue
    body.push(`## ${fmtDay(day.day)}`, '')

    // 日结：能独立读懂的一天。没有它，下面全是孤立碎片（用户实测反馈）
    if (day.summary) body.push(`> **日结**：${day.summary}`, '')

    const hi = mine.filter((e) => (e.importance || 1) >= floor)
    const lo = mine.filter((e) => (e.importance || 1) < floor)

    const sections = Array.isArray(day.sections) ? day.sections : []
    const threaded = new Set()
    const byRef = new Map(mine.map((entry) => [entry.ref, entry]))

    for (const section of sections) {
      const items = (section.refs || []).map((ref) => byRef.get(ref)).filter(Boolean)
      if (items.length === 0) continue
      body.push(`### ${section.title}`, '')
      if (section.key === 'threads') {
        for (const thread of section.threads || []) {
          const list = (thread.refs || []).map((ref) => byRef.get(ref)).filter(Boolean)
          if (list.length === 0) continue
          body.push(`**${thread.title}**${thread.why ? ' —— ' + thread.why : ''}`, '')
          for (const entry of list) {
            threaded.add(entry.ref)
            body.push(listItem(entry))
            if (entry.basis) body.push(`  - 依据：${entry.basis}`)
          }
          body.push('')
        }
        continue
      }
      for (const entry of items) {
        threaded.add(entry.ref)
        body.push(listItem(entry))
        if (entry.basis) body.push(`  - ${entry.section === 'pitfalls' ? '' : '依据：'}${entry.basis}`)
      }
      body.push('')
    }

    // 没被任何线索收走的条目（规则档、或模型漏归组）仍按原样列出，不静默丢
    const rest = hi.filter((e) => !threaded.has(e.ref))
    if (sections.length === 0 && rest.length === 0) body.push('_这一天没有达到门槛的记录。_', '')
    for (const entry of rest) body.push(entryBlock(entry), '')

    if (lo.length > 0) {
      body.push(`<details><summary>低分流水（★1–${Math.max(1, floor - 1)}，${lo.length} 条，点开看）</summary>`, '')
      for (const entry of lo) {
        body.push('- ★' + entry.importance + ' ' + entry.title + ' · `' + entry.ref + '`')
      }
      body.push('', '</details>', '')
    }
  }

  if (low.length === 0 && high.length === 0) {
    body.push('_本周没有记录。_', '')
  }

  return `${fm.concat(body).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/** 单日快照（调试 / P3 检索用）。 */
export function renderDay({ day, entries, promptVersion = 'v1' }) {
  return renderWeek({
    weekId: day.slice(0, 4) + '-D' + day.slice(5).replace('-', ''),
    days: [{ day, entries }],
    floor: 1,
    promptVersion,
  })
}
