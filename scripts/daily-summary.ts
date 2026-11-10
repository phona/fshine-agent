/**
 * 日终运营摘要：从审计库聚合指定日期（UTC 日界）的请求结果、任务时长分位、
 * 门控拦截与变更意图状态。零基础设施——纯 SQLite 聚合；人工查看，或由系统
 * 定时任务调用后接告警。
 *
 * 用法: node --import tsx scripts/daily-summary.ts [YYYY-MM-DD] [--db <path>]
 * 库路径优先级:--db > DB_PATH 环境变量(部署配置 store.dbPath 的同名非空覆盖口) > data/agent.db。
 * 本脚本按纯 node 直跑,不加载 config/agent.yaml(配置加载在 @fshine/core,服务装配才用);
 * yaml 里的 store.dbPath 是服务的库路径源,本脚本要连同一个库时用 --db 或导出 DB_PATH。
 */
import Database from 'better-sqlite3';
import path from 'node:path';

const day = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const dbArgIdx = process.argv.indexOf('--db');
const dbPath = dbArgIdx > 0 ? process.argv[dbArgIdx + 1]! : (process.env.DB_PATH ?? path.resolve('data/agent.db'));

const db = new Database(dbPath, { readonly: true });

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[idx]!);
}

const like = `${day}%`;

const requests = db.prepare(
  'SELECT outcome, COUNT(*) AS n FROM agent_requests WHERE created_at LIKE ? GROUP BY outcome',
).all(like) as { outcome: string; n: number }[];

const taskRows = db.prepare(
  'SELECT created_at, updated_at FROM platform_tasks WHERE created_at LIKE ?',
).all(like) as { created_at: string; updated_at: string }[];
const durations = taskRows.map((r) => Date.parse(r.updated_at) - Date.parse(r.created_at)).filter((ms) => ms >= 0);

// 门拦截与计划提交分开计数：两者都落 tool_calls、都带 status='error'，但不是一回事——
// 门拦截是"这一跳不许真调平台"，计划提交是"方案被评估后给出的裁决"（PLAN ACTIVE /
// NEEDS_USER_CONFIRM / STOP 的含义都是暂停执行，不是工具被拒）。合成一个数会让
// "门拦了多少次"和"计划被退了多少次"互相污染，两个都看不准。
const gateBlocked = db.prepare(
  "SELECT COUNT(*) AS n FROM tool_calls WHERE started_at LIKE ? AND tool_name LIKE 'serve_gate:%' AND tool_name != 'serve_gate:plan_submit' AND status = 'error'",
).get(like) as { n: number };

const planSubmitted = db.prepare(
  "SELECT COUNT(*) AS n FROM tool_calls WHERE started_at LIKE ? AND tool_name = 'serve_gate:plan_submit'",
).get(like) as { n: number };

const gateAllowed = db.prepare(
  "SELECT COUNT(*) AS n FROM tool_calls WHERE started_at LIKE ? AND tool_name LIKE 'serve_gate:%' AND status = 'ok'",
).get(like) as { n: number };

const intents = db.prepare(
  'SELECT status, COUNT(*) AS n FROM change_intents WHERE created_at LIKE ? GROUP BY status',
).all(like) as { status: string; n: number }[];

const slowest = db.prepare(
  "SELECT task_id, created_at, updated_at, CAST((julianday(updated_at) - julianday(created_at)) * 86400000 AS INTEGER) AS duration_ms FROM platform_tasks WHERE created_at LIKE ? ORDER BY duration_ms DESC LIMIT 5",
).all(like) as { task_id: string; duration_ms: number }[];

const summary = {
  day,
  db: dbPath,
  requests: Object.fromEntries(requests.map((r) => [r.outcome, r.n])),
  delegations: {
    count: taskRows.length,
    durationMs: { p50: percentile(durations, 50), p95: percentile(durations, 95), max: percentile(durations, 100) },
    slowest: slowest.map((s) => ({ taskId: s.task_id.slice(0, 24), durationMs: s.duration_ms })),
  },
  serveGate: { allowed: gateAllowed.n, blocked: gateBlocked.n, planSubmitted: planSubmitted.n },
  changeIntents: Object.fromEntries(intents.map((r) => [r.status, r.n])),
};

console.log(JSON.stringify(summary, null, 2));
db.close();
