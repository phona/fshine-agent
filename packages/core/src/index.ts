/**
 * 最小 reset 后的 core 面：只保留配置加载（resolve-config-path 与后续最小入口的配置依赖）。
 * 原 SQLite 审计存储（store.ts）与待确认计划仓库（plan-confirmation-store.ts）随旧 hub 删除。
 */
export { loadConfig, deploymentEnvOf, effectiveDeploymentEnv, principalScopeRecords, firstEnabledPrincipalId } from './config';
export type { LoadConfigOptions } from './config';
