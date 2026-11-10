/**
 * 夹具辅助组（memory / breaker / cache）的 ambient 名与子进程清场helper
 * （issue #20 Codex major 修复，2026-11-10）。
 *
 * 以夹具读取点为准（`grep 'env2(' scripts/eval/fixtures`）：
 *   scripts/eval/fixtures/stock-platform/bin/stock.cjs 的 `auxPaths()` 以
 *   `env2('EXECUTION_MEMORY_STATE', 'STOCK_MEMORY_STATE', <状态根派生>)` 的形式
 *   优先读 **ambient**（breaker / cache 同款）。夹具的 env2 是「规范名 > 调试专名 >
 *   缺省」的查找顺序：只要评测进程把 shell 里的同名变量继承给子进程，一个打开中的
 *   熔断账本就会让 stock.query 得 BREAKER_OPEN，memory / cache 会跨用例共享或写到
 *   外部文件——即使 `--state-dir` 已把缺省路径按用例隔离。
 *   scripts/eval/fixtures/dummy-platform/bin/dummy.cjs **不实现**辅助组（文件头
 *   "Deliberately NOT implemented in v1 ... memory / breaker / cache"），零读取点，
 *   故没有 DUMMY_* 对应专名；这里不猜一个不存在的名字。
 *
 * 因此直接运行（不经 vitest setup）的评测 harness 必须在构造子进程 env 后删除这六个
 * 键，让缺省回落到 `--state-dir` 状态根（per-case 隔离恢复）。探针侧同款处理见
 * `scripts/probe-real-agent.ts` 的 ISOLATED_STATE_KEYS。
 */
export const FIXTURE_AUX_STATE_ENV_KEYS = [
  'EXECUTION_MEMORY_STATE', 'EXECUTION_BREAKER_STATE', 'EXECUTION_CACHE_STATE',
  'STOCK_MEMORY_STATE', 'STOCK_BREAKER_STATE', 'STOCK_CACHE_STATE',
] as const;

/** 复制 `source` 并删除全部辅助组 ambient 名；其余键原样保留。 */
export function withoutFixtureAuxState(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of FIXTURE_AUX_STATE_ENV_KEYS) delete env[key];
  return env;
}
