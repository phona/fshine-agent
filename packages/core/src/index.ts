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
export { openTaskStore, operationKeyOf, storedTaskProgressOf, TASK_STORE_SCHEMA_VERSION } from './task-store';
export {
  TASK_PROGRESS_REPORT_FIELDS,
  TASK_PROGRESS_STARTED_COLUMN,
  TASK_PROGRESS_WAITING_FIELD,
  TASK_TERMINATION_COLUMNS,
  TASK_TERMINATION_KINDS,
  TASK_TERMINATIONS_TABLE,
  stillProgressingOf,
  stillProgressingSqlWhere,
  taskAcceptedInFlightOf,
  taskEndedOf,
  taskProgressEndedOf,
  taskReportedOf,
  taskStartedOf,
  taskUnstartedOf,
} from './task-progress';
export type { TaskProgressFacts, TaskTermination, TaskTerminationKind } from './task-progress';
export type {
  OperationClaimRequest,
  OperationRow,
  OperationStateWrite,
  TaskRow,
  TaskEventRow,
  ExecutionRow,
  StoredTask,
  TaskStore,
  FileRefRow,
  FileRefResolution,
} from './task-store';
