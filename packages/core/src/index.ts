/**
 * core 面（按用例重建）：配置加载 + 任务底账的 SQLite 引擎。
 * 原 SQLite 审计存储（store.ts）与待确认计划仓库（plan-confirmation-store.ts）随旧 hub 删除；
 * 按用例重建的持久化只有 task-store 两张表（最小形状，不含旧计划字段）。
 */
export { loadConfig, deploymentEnvOf, effectiveDeploymentEnv } from './config';
export type { LoadConfigOptions } from './config';
export { openTaskStore, TASK_STORE_SCHEMA_VERSION } from './task-store';
export type {
  TaskRow,
  ExecutionRow,
  StoredTask,
  TaskStore,
} from './task-store';
