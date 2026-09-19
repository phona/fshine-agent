/**
 * 日终运营摘要：从审计库聚合指定日期（UTC 日界）的请求结果、任务时长分位、
 * 门控拦截与变更意图状态。零基础设施——纯 SQLite 聚合；人工查看，或由系统
 * 定时任务调用后接告警。
 *
 * 用法: node --import tsx scripts/daily-summary.ts [YYYY-MM-DD] [--db <path>]
 * 库默认取 DB_PATH 环境变量，缺省 data/agent.db。
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

const gateBlocked = db.prepare(
  "SELECT COUNT(*) AS n FROM tool_calls WHERE started_at LIKE ? AND tool_name LIKE 'serve_gate:%' AND status = 'error'",
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
  serveGate: { allowed: gateAllowed.n, blocked: gateBlocked.n },
  changeIntents: Object.fromEntries(intents.map((r) => [r.status, r.n])),
};

console.log(JSON.stringify(summary, null, 2));
db.close();
