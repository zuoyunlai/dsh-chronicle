# dsh-chronicle · 起居注 — 实施规划 v0.1

> 状态：待评审（P0 未开工）｜ 作者：lead ＋ 用户 2026-11-09 讨论稿
> 本文所有"宿主能力"结论来自 `cordis_inspect_query` 实时查询（host Service / Event 目录），
> 所有"本机现状"结论来自 2026-11-09 实测，未标来源的判断都标了【推断】。

---

## 0. 一屏摘要

| 项 | 内容 |
|---|---|
| 一句话 | 每天把自己用 DSH 做的所有事，按重要性收口成一份可审的 Markdown 编年史，并沉淀成可检索、可关联的本地记忆 |
| 包名 | `dsh-chronicle`（npm 已核：FREE；社区 4985 条目录无重名） |
| 中文名 | **起居注** |
| 依赖 | `dependencies: {}`，`peerDependencies` 只写宿主自带 `@deepseek-ai/*`。不依赖任何第三方插件 |
| 存储 | 纯文件：JSONL（原始事件）+ Markdown（人读产物）+ JSON（图与状态）。无 SQLite、无向量库、无分词库 |
| 默认产物 | Obsidian 可直接打开的独立 vault，按周一个文件 |
| 注入成本 | 常驻 **一行 ≤80 token**，其余全部按需工具调用 |
| 分五期 | P0 骨架（0.5d）→ P1 采集落盘（1d）→ P2 打分建图（1d）→ P3 检索召回（0.5d）→ **P4 Web 面板（1.5d）**；P5 事实层可选（1d） |
| 明确不做 | 向量语义检索、全量历史回填、实时工作记忆替代、多机同步 |

---

## 1. 为什么要自建（先把证据摆出来）

### 1.1 本机现状实测（2026-11-09）

| 已装的三套记忆 | 实测状态 | 结论 |
|---|---|---|
| `dsh-mnemon` | `~/.mnemon/data/` 两库：一库 1 条 insight，另一库 15 条 insight + 75 条边 | 图谱结构在（`edges` 表有四类边），**数据近乎空的**——`auto-capture` 策略默认关闭，没人往里写 |
| `@openviking/dsh-memory-plugin` | MCP 上游返回 **HTTP 402**；`pending/` 队列为空 | 每轮自动捕获链路**当前不可用**，跨会话召回拿不到东西 |
| `@yolk_vat-y/dsh-project-memory` | 按 `<root>/.dsh-project-memory/` 隔离 | 只在具体项目里积累，且是文档/符号/经验，不回答"我今天干了哪些对话" |

### 1.2 外部候选的缺口

社区 4985 条目录里，四件事（每天成文 / 覆盖全部会话 / 重要度 / 知识图谱）没有一把梭的插件：

| 候选 | 每天成文 | 重要度 | 图谱 |
|---|---|---|---|
| `dsh-annals` | ✅ 一天一个 md + 索引 + git | ⚠️ 靠模型按规矩写 | ❌ |
| `@zzerx/dsh-plugin-daily-log` | ✅ 日报/周报 md | ⚠️ LLM 归纳无评分 | ❌ |
| `dsh-weekly-report` | ✅ md 落报告库 | ⚠️ 按样例文风 | ❌ |
| `dsh-memory-eternal` | ⚠️ 知识卡非按天 | ⚠️ 以去重为主 | ✅ 可交互图 |
| `dsh-living-memory` | ❌ 只出快照 | ✅✅ 衰减/强化/冲突 | ✅✅ 图谱 + PPR |

**结论**：缺口不在"再找一个记忆插件"，而在两件没人做的事——
① 按天把当天**所有**会话收敛成一份**按重要性排序**的人可读文件；
② 把里面真正重要的几条**回写**成可修订、可追溯的记忆。

---

## 2. 命名

### 2.1 为什么叫「起居注」

起居注是中国古代逐日记录帝王言行的官方档案，由专职起居舍人执笔，**被记录者本人不能修改**。这个隐喻把我们全部设计约束压缩进了三个字：

- **逐日**：按天收口，天然时间轴。
- **言行**：不只记"做了什么"，也记"说了什么"（对话本身就是最有价值的素材）。
- **不可改**：日报是历史，append-only，不因新结论而回改。

### 2.2 三层与中国史学三体一一对应

这不是硬凑，是设计推着走出来的：

| 层 | 史学体例 | 组织方式 | 目录 |
|---|---|---|---|
| 事件 | **编年体** | 按时序 | `chronicle/2026-W45.md` |
| 实体 | **纪传体** | 按人/项目/概念立传 | `entities/柜门原型.md` |
| 联系 | **纪事本末体** | 按一件事的来龙去脉 | `facts/`（可修订） |

### 2.3 包名与标识符

- npm 包名：**`dsh-chronicle`**（已核 FREE，可直接占）
- 中文名：起居注（README 主标题用「dsh-chronicle · 起居注」）
- 工具前缀：`chronicle_*`；命令：`/chronicle`
- 数据目录：`~/.dsh/dsh-chronicle/`；默认 vault：`~/dsh-chronicle-vault/`

备选已核名（FREE，保留备用）：`dsh-qijuzhu`、`dsh-daybook`。
**不可用**（已被占）：`dsh-annals`、`dsh-journal`、`dsh-memoir`、`dsh-ledger`、`dsh-ephemeris`。

---

## 3. 设计原则（八条，每条附"违反会怎样"）

1. **零第三方依赖。** 只用宿主 `@deepseek-ai/*` 的 peer。
   *违反*：装一个插件带进 3 个传递依赖，宿主升级时最先炸的就是它们。
2. **事件不可变，事实可修订。** `chronicle/*.md` 只追加，`facts/` 可覆盖。
   *违反*：一旦用"更新后的事实"去改写日报，就失去了"那天我确实这么判断"的证据。
3. **不抢注入预算。** 常驻只给一行，其余按需。
   *违反*：变成第三个抢上下文的记忆插件，和 mnemon / OpenViking 互相打脸。
4. **幂等可重算。** 同一输入 + 同一 prompt 版本 → 逐字节相同输出。
   *违反*：每次重跑都产生假 diff，git 历史立刻失去价值。
5. **每条结论带证据。** 一律附 `sessionId#seq`，可回源核实。
   *违反*：三个月后没人敢信任何一条结论——`dsh-project-memory` 用 `路径:行号` 解决的就是这个问题。
6. **脱敏前置。** 任何内容进磁盘前先过脱敏，命中即替换并计数。
   *违反*：一次会话里粘贴的 API key 会被写进 Markdown，再被 git 推到远端。
7. **增量不回填。** 只从启用那天往前走。
   *违反*：首启若回填 90 天历史，会一次烧掉大量 token，并造出几百个空实体页。
8. **文件即接口。** 产物是纯 Markdown + YAML frontmatter，任何工具都能读。
   *违反*：数据被锁进私有格式，退出成本变高，用户不敢用。

---

## 4. 架构

### 4.1 数据流

```
session/event ──┐
                ├─► events/YYYY-MM-DD.jsonl   (原始，append-only，脱敏后)
sessionQuery ───┘            │
(补漏回捞)                    ▼
                     本地压「纲要」(零成本，不进模型)
                             │
                             ▼
                   ctx.llm.stream  ── 结构化打分 (importance/kind/entities/evidence)
                             │
                 ┌───────────┴────────────┐
                 ▼                        ▼
        outbox → chronicle/W45.md    graph/entities.json + edges.jsonl
        (原子 rename 落盘)                    │
                 │                            ▼
                 ▼                 chronicle_related (2 跳扩散)
             index.md
                 │
                 ▼
      systemPrompt 一行 ≤80 token  +  4 个按需工具
```

### 4.2 宿主服务映射（实时查证，P0 再核一遍精确签名）

| 用途 | 服务 / 事件 | 签名（摘要） |
|---|---|---|
| 抓对话 | Event `session/event` | `(this: Scoped<Session>, session: Session, event: SessionEvent): void`，**提交后逐条推送** |
| 补漏回捞 | Service `sessionQuery` | `listSessions(signal?)`、`searchEvents(request, exec?)`、`observeSession(sessionId, options?)` |
| 打分 | Service `llm` | `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`；`GenerateOptions` 需 `provider`/`model`/`messages` |
| 选模型 | Service `agentDefaultModel` | `currentSelection(): ModelSelection`（跟随用户当前选择） |
| 写文件 | Service `fs` | `resolve(path)` → `FsTarget`；`writeText(target, content, expected?, signal?, sandboxPolicy?)`，**接缝承诺原子发布**；另有 `readText` / `listDir` / `stat` |
| 定时 | Service `timer` | `interval(callback, delay): () => void`、`timeout` |
| 注册工具 | Service `tools` | `register(definition, options?): () => void` |
| 注入 | Service `systemPrompt` | `context(context: PromptContext): () => void`、`section()` |
| 命令 | Service `commands` | `register(definition): () => void` |
| 状态持久 | Service `storageDomain` 或纯 JSON 文件 | 优先纯文件（可人工检查、可备份） |

**进程模型**：全部在宿主进程内，不起子进程；LLM 走 `ctx.llm`（复用用户的凭据与路由），**自己不发 HTTP**。

---

## 5. 目录布局

数据和产物**必须分开**：vault 可以随手删、能重跑；插件数据删了不可重建。

```
~/.dsh/dsh-chronicle/            # 插件私有数据（不给人读）
├── state.json                   # 游标/锁/用量/脱敏计数
├── events/2026-11-09.jsonl      # 当天原始事件（脱敏后）
├── cache/outline-2026-11-09.json# 纲要缓存（可重建）
└── outbox/                      # 原子写的中转区

~/dsh-chronicle-vault/           # 默认 vault（Obsidian 打开这个）
├── chronicle/2026-W45.md        # 编年体：按周一个文件
├── entities/柜门原型.md          # 纪传体：实体页（靠 backlink 关联）
├── facts/2026/11/*.md           # 纪事本末体：可修订的事实（P4）
├── index.md                     # 兜底索引（Dataview 可用时退化为可选）
├── .gitignore
└── .obsidian/                   # Obsidian 自建，不进 git
```

**为什么按周而不是按天**：一年 365 个文件会把 Obsidian 的 graph view 拖垮，Dataview 也会变慢。按周 ÷7，日粒度靠 frontmatter 的 `dates: [2026-11-09]` 保留。默认 `weekFile: true`，可切 `false` 退回按天。

---

## 6. 数据模型

### 6.1 事件行（JSONL，append-only）

```json
{"v":1,"ts":"2026-11-09T19:04:12+08:00","sid":"s-4a1f","seq":812,"turn":7,"kind":"user",
 "text":"这个插件也可以当记忆插件用吗？","chars":18}
{"v":1,"ts":"2026-11-09T19:05:03+08:00","sid":"s-4a1f","seq":820,"turn":7,"kind":"tool",
 "tool":"ops_inspect_local_file","args":{"path":"…"},"ok":true,"cwd":"E:/…"}
```

去重键 `(sid, seq)`。同一天重跑只会补缺失行，不会重复。

### 6.2 周文件结构

```markdown
---
id: 2026-W45
kind: chronicle
prompt: v1
dates: [2026-11-09, 2026-11-10]
importance_max: 5
entries: 37
sessions: 9
entities: [柜门原型, dsh-theme-palette, 论衡]
tags: [chronicle/2026-11]
---

## ★5 定稿：日报插件改零依赖方案
决策：不走 mnemon / OpenViking，全部用宿主自带服务。
证据：`s-4a1f#812` · [[柜门原型]] [[dsh-theme-palette]]

## ★4 修掉 ops_bash 长参数被改写
...

## 附：当天低分流水（★1–2，折叠）
```

- ★ 级小节**按 important 降序**，同级按时间正序。
- 每条最多 3 行：结论 / 依据 / 证据链接。**日报不是纪要，宁可短。**
- 低分不丢弃，折叠进附录（可搜索，但不占版面）——丢弃会让人怀疑"是不是漏了"。

### 6.3 事实（P4）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | `sha1(text)[:12]`，稳定可重算 |
| `text` | string | 一句话事实，≤200 字 |
| `kind` | enum | `preference` / `decision` / `fact` / `pitfall` / `procedure` |
| `scope` | enum | `global` / `workspace:<name>` |
| `bornOn` | date | 首次得出日 |
| `sourceSeq` | string[] | 支撑它的 `sid#seq` 列表 |
| `confidence` | 0–1 | 单次得出 0.6，被复述 +0.1，被推翻 ×0.2 |
| `lastUsed` | date | 被召回命中的最后日期（驱动衰减） |
| `supersededBy` | string? | 被哪条新事实取代（**不删除，保留链条**） |

### 6.4 图

- `graph/entities.json`：`{name, kind, aliases[], firstSeen, mentions[]}`
- `graph/edges.jsonl`：`{a, b, type, weight, evidence[]}`，`type ∈ {cooccur, replaces, causes, blocks, belongs_to}`
- 边的抽取：同一周条目共现实体 → `cooccur`；LLM 判定的因果/取代只在 ★≥4 的条目上做（省成本）

### 6.5 state.json

```json
{"v":1,"lastTick":"…","lastClosedDay":"2026-11-08","lock":null,
 "cursor":{"s-4a1f":812},"redact":{"apiKey":2},"usage":{"2026-11-09":{"in":8120,"out":1420}},
 "promptVersion":"v1"}
```

---

## 7. 采集层细则

**订阅**：`ctx.on('session/event', (session, event) => …)`（emit 模式，fire-and-forget，**绝不能阻塞**；任何异常吞掉并计数）。

**取什么**：

| 事件/消息 | 处理 |
|---|---|
| user 消息 | 全文存（≤4KB，超长截断 + 标 `truncated`） |
| assistant 文本 | 存首段 ≤800 字（只做定位，不做摘要） |
| tool 调用 | 只存 `name` + 关键参数（path/cmd 前 120 字）+ 成败 |
| tool 结果 | **默认不存正文**，只存 `ok/size` |
| 插件注入消息 | 丢弃（`source.kind` 以 `plugin:` 开头，或 `system-prompt` 来源） |
| subagent 会话 | 默认丢弃（`header.origin === 'subagent'`），配置项可开 |

**纲要压缩（零成本，纯本地）**：每轮压成
`{turn, userHead:前200字, tools:[名…], files:[改动/读取路径…], ok:bool}`
这一步的意义：**进模型的只有纲要，不是原文**——既是成本控制，也是隐私边界。

**上限**：单日 400 条 / 2MB 封顶，超出后降级为"只留 user 首行 + 文件路径"。

**脱敏（写入前强制）**：正则族命中即替换为 `«REDACTED:type»`，并写 `state.redact` 计数。

| 类型 | 形态 |
|---|---|
| API key | `sk-…`、`ak-…`、`ghp_…`、`github_pat_…`、`AKIA…` |
| 令牌 | `Bearer `、JWT（三段 base64）、`-----BEGIN … PRIVATE KEY-----` 整块 |
| 凭据对 | `password=`、`api_key=`、`token=` 后跟值 |
| 个人信息 | 手机号（11 位）、身份证（18 位含校验位）、邮箱 |

> 注意 `ak-`/`sk-` 必须带 `(?<![A-Za-z0-9])` 左边界，否则 `task-…`、`disk-…` 会被误吃（这是 `dsh-living-memory` 踩过的坑，已记录）。

---

## 8. 评分口径（本插件最核心的一张表）

### 8.1 importance

| 分 | 判据 | 例 |
|---|---|---|
| **5** | 不可逆外部动作，或"定稿级"决策 | 发版 / 推送 / 部署 / 删除数据 / 架构拍板 |
| **4** | 产出交付物，或修复真实缺陷，或推翻旧结论 | 新功能上线、bug 定位到根因、方案改向 |
| **3** | 常规实现、调查、讨论 | 写代码、查文档、对比方案 |
| **2** | 有信息量的闲聊 | 闲聊里夹了一句有用的判断 |
| **1** | 寒暄 / 重复 / 失败重试 | "你好"、"再试一次"、连续报错 |

### 8.2 kind

`decision` / `pitfall` / `delivery` / `research` / `chore` / `chat` / `todo`

### 8.3 三档降级（成本与可用性）

| 档 | 条件 | 行为 |
|---|---|---|
| A | `ctx.llm` 可用（默认） | 一次调用，强制 JSON schema 输出，`maxTokens ≤ 2000/天` |
| B | LLM 不可用 / 未配置 | **规则分**：命中不可逆动词 +2、改文件 +1、工具失败 ≥3 次 +1、轮次 ≥10 +1，封顶 5 |
| C | 当天 0 条事件 | **不生成文件**（避免制造空壳，并防止 graph 里长出死链） |

**规则分为什么必须有**：LLM 会 402、会超时、会换模型。没有 B 档，一次故障就整天没有记录——而"记录缺失"比"记录平庸"更难被发现。

**成本**：每天 1 次调用，输入约 6–12k（纲要）、输出约 1–2k。按当前模型价格是每天可忽略的量级；具体价格不写死在文档里，由 `state.usage` 记账后自算。

---

## 9. 落盘规则

1. **原子写**：单文件原子性由 `ctx.fs.writeText` 的接缝保证（它承诺 atomic publication），**不需要自己 outbox + rename**。outbox 只留给"跨文件事务"——周文件 + `index.md` + graph 三处要么全成要么全退。中途崩溃不留半份日报。
2. **幂等**：输出只依赖 `(事件集合, promptVersion, config)`；集合相同则逐字节相同（时间戳不进正文，只进 frontmatter 的 `dates`）。
3. **不可变**：已生成的周文件默认不重写。要重算必须 `--force` 或提升 `promptVersion`——旧文件保留为 `2026-W45.v1.md`。
4. **互斥**：`state.lock = {pid, at}`，超 10 分钟视为死锁可抢占。
5. **AI 输出校验**：LLM 返回的 JSON 必须过 schema；`evidence` 里的 `sid#seq` 要能在当天事件里查到，**查不到就整条丢弃**（防幻觉证据）。

---

## 10. 检索与召回

**索引**：进程内倒排（`term → entryId`）。中文按 2-gram 切 + 实体表精确匹配命中加权；不做 BM25（收益低于维护成本）【推断】。

**评分**：

```
score = 3.0×实体命中 + 1.5×2跳扩散 + 1.0×importance/5
      + 0.8×exp(-Δdays/60)  + 0.5×hitHistory
```

**工具面（4 个）**：

| 工具 | 用途 |
|---|---|
| `chronicle_today` | 今天的记录（或 `--date`） |
| `chronicle_search` | 关键词 / 实体 / 日期范围 |
| `chronicle_related` | 给实体或条目，返回 2 跳邻居（这就是"关联推理"） |
| `chronicle_note` | 写一条事实（P4 才有） |

**注入（唯一常驻内容）**：

```
[chronicle] 今天 12 条 · 最近高分：日报插件改零依赖方案（11-08 ★5）
```

- 硬上限 80 token；当天无记录则不注入（连这一行都不出现）。
- 只注入"标题级"信息，正文永远靠工具取——这样它既是记忆插件，又不会成为新的预算黑洞。

**不做**：向量检索、每轮全量记忆块注入、embedding 通道（省掉 key 与外部服务）。

---

## 11. Obsidian 适配

**约定**

- wikilink 只连**实体页**与**周文件**，不连事实页（事实页只被正文提及）。
- 实体页名全局唯一，禁 ` / # | ^ [ ]` 与首尾空格（`[[ ]]` 按文件名解析，不是按路径）。
- frontmatter 只写确定性字段：不写 `mtime` / `generatedAt` / 随机 id。
- Obsidian 侧**只读**；手改只改 `facts/`（那层本来就设计成可修订的）。

**给用户的现成视图**（写进 README）

```dataview
TABLE importance_max AS 最高分, entries AS 条目数, entities AS 实体
FROM "chronicle"
SORT id DESC LIMIT 12
```

```dataview
LIST FROM "chronicle" WHERE contains(entities, "柜门原型") SORT id DESC
```

**五个已知坑**（都写进 README 的「坑」一节）

1. `[[ ]]` 按文件名解析——同名即断链或错链。
2. 一天一个文件会在一年后拖垮 graph view → 按周。
3. frontmatter 抖动 = 假 diff，毁 git 历史。
4. 放同步盘要排除 `.obsidian/workspace.json` 与 `events/*.jsonl`。
5. 允许在 vault 里改日报，就要处理"外部改动 vs 按 seq 重算"的冲突 → 索性只读。

---

## 11.5 Web 面板（P4，已定：**要做**）

### 形态决策

**右侧栏一个 tab，三个视图**，不做整页。理由：整页要接管导航结构，成本高一个量级，而"看今天记了啥 / 搜一句话 / 顺着实体看看相关"全是窄栏场景。整页与力导向图留到 v0.3 再评估。

### 三个视图

| 视图 | 内容 | 数据量 |
|---|---|---|
| **近期** | 最近 7 天，按天分组，★ 级条目 + 证据链接 | 一次 ≤50 条 |
| **检索** | 一个输入框 + 结果列表（与 `chronicle_search` 同一后端） | 分页 30 |
| **关联** | 输入/点选实体 → 2 跳邻居的**列表式**扩散（不做力导向图） | 一次 ≤80 条 |

### 硬性约束（每条都有理由）

1. **面板不直接读文件。** 一律走 Host 侧 `@Remote` 暴露的只读命名空间（`chronicle.status / recent / search / related`），客户端拿数据。理由：渲染进程没有文件系统权限，绕过 Host 等于重造一条安全边界。
2. **与工具共用同一后端。** 面板的"检索"和模型的 `chronicle_search` 必须调同一个函数——两套实现必然分叉，届时面板显示 A、模型看到 B，是排查噩梦。
3. **面板只读。** 不提供编辑、不提供删除。唯一写操作是「标记已读/忽略」，它只影响命中历史（进而影响召回排序），不改任何文件。理由：文件是唯一真相，UI 不参与写。
4. **分页 + 虚拟化。** 列表一次 30 条，滚动取下一页；一次加载全库会在几千条时卡住渲染进程。
5. **React 错误边界。** 面板抛错只让 tab 显示错误态，不能把整个会话页拖垮。
6. **零第三方 UI 库。** 用宿主提供的组件与主题 token，不自带 antd/tailwind。理由：自带样式表会和用户的 `dsh-theme-palette` 打架。

### 实现要点

- 服务端：P0 建一个空的 `chronicle` Remote 命名空间（返回 `{status:'empty'}`），P4 再填四个方法。
- 客户端：`dsh.client` manifest + 在 P4 第一步用 `cordis_inspect_query`（client `Slots.listSubTree`）确认可挂的 slot 与注册参数，**先确认再动手写 UI**。
- 证据跳转：v1 只提供「复制 `sid#seq`」；点开原会话需要跨会话深链，留 v0.2 再评估。
- 面板不参与生成：它只读。生成永远发生在定时/命令路径，面板不持有任何定时器。

### 验收

① 面板能显示最近 7 天且与磁盘上的周文件一致；
② 检索结果与 `chronicle_search` 工具结果**逐条相同**（同一后端）；
③ 拉黑 3000 条数据后滚动不卡；
④ 面板内抛异常的注入点被错误边界拦住，会话页仍可用；
⑤ 卸载插件后 tab 消失、不残留空壳。

---

## 12. 配置（Config v1）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `vaultDir` | string | `~/dsh-chronicle-vault` | 产物目录（Obsidian 库根） |
| `dataDir` | string | `$DSH_HOME/dsh-chronicle` | 私有数据 |
| `closeAt` | string | `23:50` | 当天收口时刻（本地时区） |
| `tickMinutes` | number | `5` | 轮询间隔；只做"是否该收口"的判断，不重活 |
| `weekFile` | boolean | `true` | 按周一个文件；`false` 退回按天 |
| `includeSubagent` | boolean | `false` | 是否收录子代理会话 |
| `followModel` | boolean | `true` | 打分用当前选中模型；`false` 用 `scoringModel` |
| `scoringModel` | string | `""` | `provider/model`，仅当 `followModel:false` |
| `importanceFloor` | number | `3` | 低于此分折叠进附录 |
| `injectLine` | boolean | `true` | 是否注入那一行 |
| `injectBudget` | number | `80` | 注入 token 硬上限 |
| `redact` | boolean | `true` | 脱敏（**强烈建议不要关**） |
| `maxEventsPerDay` | number | `400` | 单日事件上限 |
| `gitCommit` | boolean | **`true`** | 每次生成后自动 `git commit`（**只本地，不 push**） |
| `entityRule` | enum | **`on-hit`** | 实体页建立门槛：`on-hit`（被召回命中过一次）/ `score`（★≥4） |
| `entityMinScore` | number | `4` | 当 `entityRule: score` 时生效 |
| `panel` | boolean | **`true`** | 是否注册 Web 面板入口 |
| `keepDays` | number | `0` | 原始 JSONL 保留天数，0 = 永久 |

---

## 13. 分阶段实施

### P0 · 骨架（0.5 天）

交付：包结构 + `cordis.patch.yml` + Config schema + `chronicle_ping` 工具 + 空事件订阅 + 能装能卸。
验收：`plugin_manager install_bundle` 后 `application: applied`；`chronicle_ping` 可调用；卸装后 `~/.dsh/dsh-chronicle` 不被误删（保留数据，明确提示）。
风险：宿主 `fs` / `llm` 精确签名与本文假设有偏差 → P0 第一件事是取契约，**不是写业务**。

### P1 · 采集 + 落盘（1 天）

交付：事件落盘 + 纲要 + 规则分（B 档）+ 周文件生成 + 启动补跑 + 原子写 + 脱敏。
验收：
① 手动造 3 个假会话日志，跑完生成一份周文件，内容可读、分档正确；
② 同一天跑两次，第二次产出的文件**逐字节相同**；
③ 注入假 API key / 手机号，磁盘上搜不到原文；
④ 杀掉进程再启动，漏掉的天被补齐。
风险：`session/event` 在压缩/裁剪场景下漏采 → 靠 `sessionQuery.searchEvents` 回捞兜底（同一去重键）。

### P2 · 打分 + 建图（1 天）

交付：A 档 LLM 打分（schema 校验 + 证据核验）、实体抽取、edges、frontmatter 完整化。
验收：★ 分布合理（不出现"全是 3 分"或"全是 5 分"）；每条 ★≥4 的都能用 `sid#seq` 回查到原事件；实体页自动生成且 backlink 正确。
风险：模型打分漂移（同一天两次跑给出不同分）→ 用 `temperature: 0`、固定 schema、promptVersion 记录；漂移仍存在就降级 B 档兜底。

### P3 · 检索 + 召回（0.5 天）

交付：倒排 + 图扩散 + 4 工具 + 一行注入 + `/chronicle` 命令。
验收：问"上周那个 ops_bash 的坑"能命中；注入那一行在预算内；没有记录时不注入。
风险：注入行被别家插件挤掉 → 只在 `systemPrompt.context` 里占一个槽，不自建 section。

### P4 · Web 面板（1.5 天）

交付：Host 侧 `chronicle` Remote 命名空间（`status/recent/search/related`）+ 客户端 manifest + 右侧栏 tab + 三个视图 + 分页虚拟化 + 错误边界。
验收：§11.5 的五条验收全过。
风险：宿主 slot 与文档不一致 → **第一步先 `Slots.listSubTree` 确认可挂点，再写 UI**，不按记忆中的 slot 名硬写。

### P5 · 事实层（可选，1 天）

交付：`facts/` 生成与合并、`supersededBy` 链、衰减与容量上限、`chronicle_note`。
验收：同一事实重复出现不产生重复条目；被推翻的旧事实保留链但不再召回。
**前置条件**：P1–P3 跑满两周，从真实记录里把"什么值得长期记"的判据写出来——**先拍脑袋定规则八成会错**。

---

## 14. 测试计划

**单测（12 条）**：脱敏六类各一、去重键、纲要压缩、规则分边界、原子写中断恢复、frontmatter 稳定、证据核验丢弃、空日不生成、跨天时区、索引 2-gram、图 2 跳、注入预算。

**金文件测试**：固定 fixture → 生成结果与 `expected.md` 逐字节比对。

**幂等测试**：同一 fixture 跑 3 次，hash 一致。

**性能**：10k 事件下 `chronicle_search` < 300ms；10 万实体边下 2 跳 < 200ms【推断，实测校正】。

**真实观察期**：P2 完成后连续 3 天不调 prompt，看产出是否"想读"；这是唯一能验证重要度口径的办法。

**宿主契约**：`engines.dsh` 与 peer 声明正确；在 0.2.2-rc.1 实测安装与卸载。

---

## 15. 发布与后续

- 版本：`0.1.0` 起，语义化；`CHANGELOG.md` 每版一节。
- README：中英双语；若按家族规则则补齐五语（英/中/日/西/葡/印地）。
- 隐私声明放显著位置：**全程本地；进模型的只有纲要；原文不出机器**。
- 投稿：`dshfind`、`awesome-dsh-plugin`、`dshmarket`（你们已有投稿经验，YAML 里 `description` 含半角 `: ` 必须整体加单引号——踩过）。
- 观测：`DEBUG=chronicle` 输出到 `~/.dsh/dsh-chronicle/debug.log`；每日 token 记账进 `state.usage`。

---

## 16. 风险登记册

| # | 风险 | 触发 | 影响 | 缓解 |
|---|---|---|---|---|
| 1 | 注入预算失控 | 后来加了"相关记忆全文注入" | 每轮多烧几千 token | 一行硬上限 + 单测锁死 |
| 2 | LLM 不可用 | 402 / 超时 / 换模型 | 当天无记录 | B 档规则分兜底 |
| 3 | 事件漏采 | 宿主崩溃、压缩裁剪 | 记录残缺 | 启动补跑 + `searchEvents` 回捞 |
| 4 | vault 膨胀 | 空实体页、重复条目 | 库变垃圾场 | 实体页只在 ★≥4 或被命中时建 |
| 5 | 隐私泄漏 | 粘贴密钥 | 密钥进 git | 写入前脱敏 + 单测 |
| 6 | 与已有记忆重复 | 两套都在记同一件事 | 上下文互相打脸 | 定位为冷层，只注入标题级 |
| 7 | 跨天/时区错乱 | 用户换时区、DST | 记录落到错误日期 | 全用本地偏移时间戳，`dates[]` 显式 |
| 8 | 卸载残留 | 用户卸装 | 数据成孤儿 | 卸装打印数据路径，不自动删 |
| 9 | **本地 link 装时 peer 解析失败**（P0 已实测踩到） | `dsh plugin add <本地路径>` | 插件整体加载失败 | index.js 改容错动态导入（拿不到就不声明 Config）+ devDependencies 落地；npm 安装不受影响 |

---

## 17. 明确的非目标

- ❌ 向量语义检索 / embedding 通道
- ❌ 全量历史回填
- ❌ 替代实时工作记忆（那是 mnemon 与 OpenViking 的地盘）
- ❌ 多机同步（vault 放你自己的同步盘即可）
- ❌ 力导向图 / 整页面板（P4 只做右侧栏三个视图，力导向留 v0.3）
- ❌ 不做"自动执行"——它只记录与检索，不代替你做决定

---

## 18. 决议（2026-11-09 已拍板，含连带影响）

| # | 问题 | 决议 | 连带影响 |
|---|---|---|---|
| 1 | vault 位置 | **独立**：`~/dsh-chronicle-vault` | 与主库互不影响；想看时 Open as vault 切一下；插件数据与产物仍分开 |
| 2 | 收口时刻 | **23:50**（本地时区） | 跨天靠启动补偿；23:50 之后到 0 点的会话落到次日文件（`dates[]` 记实际日期） |
| 3 | 打分模型 | **跟随当前选中模型** | 口径可能随你切模型而变 → `state.usage` 记下每次的 provider/model；promptVersion 进 frontmatter，便于回溯"这条为什么是这个分" |
| 4 | git 自动提交 | **要**（只 commit，**不 push**） | vault 建库时 `git init`；提交信息统一 `chronicle: 2026-W45`；`.gitignore` 排除 `events/`、`.obsidian/workspace.json` |
| 5 | 实体页门槛 | **被召回命中过一次**（`entityRule: on-hit`） | 首周可能一个实体页都没有——这是对的，说明还没被用过；★≥4 建页作为 `score` 兜底选项保留 |
| 6 | Web 面板 | **要**（§11.5） | 工期 +1.5 天；新增客户端半边；唯一写操作限"标记已读/忽略"；面板只读文件 |

**由此确认的范围变化**

- 总工期：0.5 + 1 + 1 + 0.5 + 1.5 = **4.5 天**（P5 事实层另计 1 天，看 P1–P3 跑两周的结果再定）。
- 交付物多出：Host Remote 命名空间、`dsh.client` manifest、右侧栏 tab、图标与 locale。
- 一个新的风险进登记册：**面板与工具两套后端分叉** → 已用"共用同一函数"约束（§11.5 第 2 条）。
- `gitCommit: true` 之后，vault 必须是独立 git 仓库：**不放进 DSH 工作区**，否则会被工作区的 git 一起带走、把提交历史搅乱。

---

## 附录 A · 打分 prompt 草案（可直接用）

```
你是工作日志编辑。给你一天的会话纲要，请输出严格 JSON。

对每个**值得记录**的条目输出：
{"turn_ref":"sid#seq","title":"≤30字，动词开头","importance":1-5,
 "kind":"decision|pitfall|delivery|research|chore|chat|todo",
 "claim":"一句话结论，≤80字","basis":"依据，≤60字",
 "entities":["实体名"]}   // 只填专有名词：项目、文件、工具、产品

importance 判据：
5 = 不可逆外部动作（发布/推送/部署/删除/付款）或定稿级决策
4 = 产出交付物 / 修复真实缺陷 / 推翻旧结论
3 = 常规实现、调查、讨论
2 = 有信息量的闲聊
1 = 寒暄、重复、失败重试（这类不要输出，除非占当天一半以上）

硬约束：
- 只输出 JSON 数组，不要解释、不要 Markdown 代码块。
- turn_ref 必须来自输入，禁止编造；不确定就换一条。
- 合并重复条目；同一天同类小事合并成一条。
- 宁少勿多：一天 5–20 条。
```

## 附录 B · 与已装/候选插件的定位对照

| | 本插件 | mnemon | OpenViking | project-memory | dsh-annals | daily-log |
|---|---|---|---|---|---|---|
| 按天成文 | ✅ md | ❌ | ❌ | ❌ | ✅ | ✅ |
| 重要度排序 | ✅ 1–5 + 判据 | ✅ 1–5 | ❌ | ⚠️ 分层 | ⚠️ 靠模型 | ⚠️ 归纳 |
| 跨会话/跨工作区 | ✅ | ⚠️ | ✅ | ❌ 按 root | ✅ | ✅ |
| 知识关联 | ✅ 实体 + 2 跳 | ✅ 类型边 | ⚠️ 语义 | ⚠️ doc↔symbol | ❌ | ❌ |
| 每轮注入 | 一行 ≤80t | 多块 | 多块 | 多块 | 规矩段 | 1 工具 |
| 可审（证据 seq） | ✅ 强制 | ⚠️ | ⚠️ | ✅ 路径:行号 | ❌ | ❌ |
| 第三方依赖 | 0 | 8 provider | MCP 服务 | 0 | ~0 | 多个 |

## 附录 C · 术语

- **纲要**：原文的本地压缩表示，只有它进模型。
- **收口**：把某一天的事件固化成一份周文件的动作。
- **证据 seq**：`sessionId#seq`，回到原会话的指针。
- **冷层 / 热层**：冷 = 只在被问时读；热 = 每轮注入。本插件只做冷层 + 一行提示。
