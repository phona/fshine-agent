import type Database from 'better-sqlite3';

/**
 * 计划门拒绝明细（D-087）：把审计库里已经记着的东西带到人眼前。
 *
 * 断口：计划门的每一跳裁决都落在 `tool_calls` 表里——`pi-coding-driver.ts` 的
 * `reportPlanSubmission` 在 `decidePlanSubmission` 的 `finally` 里保证每个出口都落一行，
 * `assembly.ts` 的 `serveGateAudit` 落库时写 `tool_name='serve_gate:plan_submit'`、
 * `status='error'`、`error_code='GATE_BLOCKED'`，拒绝理由住在 `safe_arguments.reason` 里。
 * 而三类最需要人看见的拒绝（实体越权 / PLAN_NOT_PLANNABLE / DECLINED_PLAN_LIMIT）在宿主侧
 * **全静默**——它们只作为 tool_result 回给 worker。2026-10-13 定位 ENTITY_OUT_OF_SCOPE 假拒时，
 * 验收报告里只有 worker 终稿说"操作申请已用尽"，真正的拒绝原因一直在库里记着，却没有任何出口
 * 把它带到人眼前：每一次这类缺陷的定位成本都从"读报告"变成"手工查 sqlite"。
 *
 * 为什么出口是审计库而不是再加几条 console.info：日志解决"这次看得见"，不解决"每次定位都要
 * 手工查 sqlite"。库里已经有完整三要素（码 + 期望/实际 + 正确形态），缺的只是读它的那行代码。
 *
 * **本模块只做报告，不做判定**：下面那个分类是给报告分组与计数用的，没有任何门、任何运行时
 * 路径读它。判据只认宿主自己的协议前缀（PLAN DECLINED / STOP / ACTIVE / …），那是结构标记，
 * 不是按错误码名猜语义（D-089 立下的纪律）。
 */

/** 计划门裁决在审计库里的 tool 名（assembly 的 serveGateAudit 加 `serve_gate:` 前缀）。 */
const PLAN_SUBMIT_TOOL = 'serve_gate:plan_submit';

/**
 * 按 request 取该回合的全部计划门裁决。
 *
 * `idx_tool_calls_request_id` 索引已存在，参数化查询。`safe_arguments` 是 JSON
 * （`{detail, reason}`），该表没有独立的 reason 列——理由住在 JSON 里，用 json_extract 取。
 */
export const PLAN_REJECT_SQL =
  'SELECT id, status, error_code AS errorCode, '
  + 'json_extract(safe_arguments, ?) AS reason, '
  + "json_extract(safe_arguments, '$.detail') AS detail, started_at "
  + `FROM tool_calls WHERE request_id = ? AND tool_name = '${PLAN_SUBMIT_TOOL}' ORDER BY id`;

/** reason 键在 safe_arguments 里的 JSON 路径。 */
export const PLAN_REJECT_REASON_PATH = '$.reason';

export interface PlanRejectRow {
  id: number;
  status: string;
  errorCode: string | null;
  /** 门的拒绝理由 / 计划裁决原文（三要素文本，worker 协议文本，不上屏）。 */
  reason: string | null;
  /** 命令摘要 / 计划 calls 摘要（宿主解析出的确定性事实）。 */
  detail: string | null;
  startedAt: string;
}

/** 报告里的裁决分类：只按宿主自己的协议前缀归组，不解释错误码语义。 */
export type PlanRejectKind = 'declined' | 'active' | 'confirm' | 'paused' | 'other';

/**
 * 协议前缀 → 分类。顺序即优先级（都是互斥前缀，但 `NEEDS_USER_CONFIRM` 比泛化的更长，
 * 写在前面更稳）。
 *
 * `PLAN STOP` 归到 declined：它覆盖 DECLINED_PLAN_LIMIT / PLAN_NOT_PLANNABLE 一族，
 * 语义都是"这一跳不许真调平台、worker 被挡回来"。（WRITE_NOT_ENABLED 是 2026-11-08 前
 * 这一族里的一员：宿主合成写关闭话术的分支已随架构裁定删除，本分类器按前缀归组、
 * 不解释错误码语义，历史报告里的那一族照旧归 declined。）
 */
const PLAN_VERDICT_PREFIXES: ReadonlyArray<readonly [string, PlanRejectKind]> = [
  ['PLAN NEEDS_USER_CONFIRM', 'confirm'],
  ['PLAN DECLINED', 'declined'],
  ['PLAN STOP', 'declined'],
  ['PLAN ACTIVE', 'active'],
  ['PLAN PAUSED', 'paused'],
];

export function classifyPlanReject(reason: string | null): PlanRejectKind {
  if (!reason) return 'other';
  for (const [prefix, kind] of PLAN_VERDICT_PREFIXES) {
    if (reason.startsWith(prefix)) return kind;
  }
  return 'other';
}

/** 报告 bullet 行的截断长度：够人认出是哪个调用、又不把 worker 协议文本整段铺进报告。 */
const REPORT_VALUE_MAX_CHARS = 200;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…(截断)` : text;
}

/** 缺值走 `无`（与验收报告其余字段同一约定）。 */
function orNone(value: string | null): string {
  return value && value.trim() ? truncate(value, REPORT_VALUE_MAX_CHARS) : '无';
}

/**
 * 报告行（沿用验收报告既有的 `- 字段:值` bullet 约定）。
 *
 * 一份裁决一行；被挡回来的（declined）在前，其余按库里的顺序跟在后面——读报告时第一眼要
 * 看到的是"为什么被挡"，不是"计划激活了"。
 */
export function renderPlanRejectLines(rows: readonly PlanRejectRow[]): string[] {
  if (rows.length === 0) return ['- 计划门拒绝明细:无'];
  const ordered = [
    ...rows.filter((row) => classifyPlanReject(row.reason) === 'declined'),
    ...rows.filter((row) => classifyPlanReject(row.reason) !== 'declined'),
  ];
  return ordered.flatMap((row) => [
    `- 计划门裁决#${row.id}（${classifyPlanReject(row.reason)}）:${orNone(row.reason)}`,
    `- 计划门摘要#${row.id}:${orNone(row.detail)}`,
  ]);
}

/** 汇总一行：几次裁决、其中几次把 worker 挡了回来。 */
export function renderPlanRejectSummary(rows: readonly PlanRejectRow[]): string {
  if (rows.length === 0) return '- 计划门裁决:0 次';
  const declined = rows.filter((row) => classifyPlanReject(row.reason) === 'declined').length;
  return `- 计划门裁决:${rows.length} 次（declined ${declined} / active `
    + `${rows.filter((r) => classifyPlanReject(r.reason) === 'active').length} / confirm `
    + `${rows.filter((r) => classifyPlanReject(r.reason) === 'confirm').length} / paused `
    + `${rows.filter((r) => classifyPlanReject(r.reason) === 'paused').length} / other `
    + `${rows.filter((r) => classifyPlanReject(r.reason) === 'other').length}）`;
}

/**
 * 按 request 读该回合的计划门裁决。
 *
 * 存储抛错由调用方兜底（验收脚本的既有约定：降级并留痕，不让一次查询失败毁掉整份报告）。
 */
export function planRejectsOf(db: Database.Database, requestId: string): PlanRejectRow[] {
  return db.prepare(PLAN_REJECT_SQL)
    .all(PLAN_REJECT_REASON_PATH, requestId) as PlanRejectRow[];
}
