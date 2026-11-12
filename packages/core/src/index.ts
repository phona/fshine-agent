/** W1-B 实现:配置加载 + SQLite 审计存储。接口见 @fshine/contracts(store.ts / config.ts)。 */
export { loadConfig, deploymentEnvOf, effectiveDeploymentEnv, principalScopeRecords, firstEnabledPrincipalId } from './config';
export type { LoadConfigOptions } from './config';
export { createSqliteStore, closeStore, newId } from './store';
export {
  createSqlitePendingPlanConfirmationRepo,
  type SqlitePendingPlanConfirmationRepo,
  type StoredPendingPlanConfirmation,
} from './plan-confirmation-store';
