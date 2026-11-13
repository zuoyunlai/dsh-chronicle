/**
 * 生成工具的 output.schema。
 *
 * 为什么需要（审计 P2-18）：原来 10 个工具的 `output.schema` 全是
 * `{ type:'object', properties:{} }` —— 宿主校验**会通过**（只要是对象就行），
 * 但一个字段都没声明。于是：程序化消费者无法依赖任何字段；
 * 宿主 pipeline 用它校验 execute 返回值也等于「只要是对象就放过」。
 */
export const TOOL_SCHEMAS = {
  chronicle_ping: {
    type: 'object',
    properties: {
      phase: { type: 'string' },
      version: { type: 'string' },
      dataDir: { type: 'string' },
      vaultDir: { type: 'string' },
      closeMode: { type: 'string' },
      revisited: { type: 'array', items: { type: 'string' } },
      floor: { type: 'number' },
      scoring: { type: 'string' },
      scoringTarget: { type: 'string' },
      gitCommit: { type: 'boolean' },
      weekFile: { type: 'boolean' },
      lastClosedDay: { type: 'string' },
      buffered: { type: 'number' },
      eventsToday: { type: 'number' },
      lastError: { type: 'string' },
      catchUpDropped: { type: 'string' },
      llmError: { type: 'string' },
      services: { type: 'object', additionalProperties: true },
      routes: { type: 'object', additionalProperties: true },
      backfill: { type: 'object', additionalProperties: true },
    },
    required: ['phase', 'version', 'dataDir', 'vaultDir', 'services'],
  },
  chronicle_close: {
    type: 'object',
    properties: {
      closed: { type: 'boolean' },
      day: { type: 'string' },
      week: { type: 'string' },
      entries: { type: 'number' },
      daysIncluded: { type: 'number' },
      scoring: { type: 'string' },
      path: { type: 'string' },
      summary: { type: 'string' },
      warnings: { type: 'array', items: { type: 'string' } },
      llmError: { type: 'string' },
      llmNote: { type: 'string' },
      graph: { type: 'object', additionalProperties: true },
      git: { type: 'object', additionalProperties: true },
      facts: { type: 'object', additionalProperties: true },
      arcs: { type: 'object', additionalProperties: true },
      stats: { type: 'object', additionalProperties: true },
      reason: { type: 'string' },
      dryRun: { type: 'boolean' },
    },
    // dryRun 预览没有 closed 字段，所以这里不能把它列为必需
    required: ['day'],
  },
  chronicle_doctor: {
    type: 'object',
    properties: {
      day: { type: 'string' },
      rows: { type: 'number' },
      unique: { type: 'number' },
      badLines: { type: 'number' },
      kinds: { type: 'object', additionalProperties: true },
      turns: { type: 'number' },
      placeholderTurns: { type: 'number' },
      sessions: { type: 'number' },
      reasoningSuspect: { type: 'number' },
      reasoningSamples: { type: 'array', items: { type: 'object', additionalProperties: true } },
      weekFile: { type: 'boolean' },
      weekFileExists: { type: 'boolean' },
      dropped: { type: 'number' },
      droppedTotal: { type: 'number' },
      duplicateKeys: { type: 'number' },
      lastClosedDay: { type: 'string' },
      // 收口台账体检（2026-11-13 审计 P0-1/P0-2 的守卫）
      pendingDays: { type: 'array', items: { type: 'string' } },
      revisitedDays: { type: 'array', items: { type: 'string' } },
      missingStamps: { type: 'array', items: { type: 'string' } },
      // 事实层体检
      staleCount: { type: 'number' },
      staleInconsistent: { type: 'array', items: { type: 'string' } },
    },
    required: ['day', 'rows'],
  },
  chronicle_today: {
    type: 'object',
    properties: {
      day: { type: 'string' },
      total: { type: 'number' },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string' },
            title: { type: 'string' },
            claim: { type: 'string' },
            importance: { type: 'number' },
            kind: { type: 'string' },
            section: { type: 'string' },
            project: { type: 'string' },
            ws: { type: 'string' },
            ts: { type: 'string' },
          },
          required: ['ref', 'title'],
        },
      },
    },
    required: ['day', 'total', 'entries'],
  },
  chronicle_search: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string' },
            title: { type: 'string' },
            claim: { type: 'string' },
            score: { type: 'number' },
            importance: { type: 'number' },
            lexical: { type: 'number' },
            entityHits: { type: 'number' },
            hopHit: { type: 'number' },
          },
          required: ['ref', 'title', 'score'],
        },
      },
    },
    required: ['query', 'results'],
  },
  chronicle_related: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      neighbors: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, weight: { type: 'number' } },
          required: ['name'],
        },
      },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: { ref: { type: 'string' }, title: { type: 'string' }, importance: { type: 'number' } },
          required: ['ref', 'title'],
        },
      },
    },
    required: ['name', 'neighbors', 'entries'],
  },
  chronicle_facts: {
    type: 'object',
    properties: {
      total: { type: 'number' },
      facts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string' },
            scope: { type: 'string' },
            title: { type: 'string' },
            statement: { type: 'string' },
            rationale: { type: 'string' },
            expiresWhen: { type: 'string' },
            detector: { type: 'string' },
            project: { type: 'string' },
            bornOn: { type: 'string' },
            status: { type: 'string' },
            hits: { type: 'number' },
            evidenceStale: { type: 'boolean' },
            evidence: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'kind', 'title'],
        },
      },
    },
    required: ['total', 'facts'],
  },
  chronicle_review: {
    type: 'object',
    properties: {
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string' },
            title: { type: 'string' },
            project: { type: 'string' },
            bornOn: { type: 'string' },
            ageDays: { type: 'number' },
            reason: { type: 'string' },
            statement: { type: 'string' },
          },
          required: ['id', 'title', 'reason'],
        },
      },
    },
    required: ['candidates'],
  },
  chronicle_export_rules: {
    type: 'object',
    properties: {
      markdown: { type: 'string' },
      path: { type: 'string' },
      lines: { type: 'number' },
      project: { type: 'string' },
    },
    required: ['markdown'],
  },
  chronicle_capsule: {
    type: 'object',
    properties: {
      day: { type: 'string' },
      path: { type: 'string' },
    },
    required: ['day', 'path'],
  },
}
