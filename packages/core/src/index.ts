/**
 * core 面（按用例重建）：配置加载 + 任务底账的 SQLite 引擎。
 * 原 SQLite 审计存储（store.ts）与待确认计划仓库（plan-confirmation-store.ts）随旧 hub 删除；
 * 按用例重建的持久化 = task-store 的 tasks/executions/operations + file_refs（CAP-01 S0，
 * 最小形状，不含旧计划字段）。
 */
export {
  loadConfig,
  deploymentEnvOf,
  effectiveDeploymentEnv,
  effectiveRoleOf,
  permissionsOfPrincipal,
  permissionsOfRole,
} from './config';
export type { LoadConfigOptions } from './config';
export { openTaskStore, operationKeyOf, TASK_STORE_SCHEMA_VERSION } from './task-store';
export type {
  OperationClaimRequest,
  OperationRow,
  OperationStateWrite,
  TaskRow,
  ExecutionRow,
  StoredTask,
  TaskStore,
  FileRefRow,
  FileRefResolution,
} from './task-store';
