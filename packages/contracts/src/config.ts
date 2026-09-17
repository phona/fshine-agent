/**
 * 部署配置类型。YAML 形状见 config/agent.yaml(架构 §8);
 * 秘密与本地参数从 .env / 环境变量并入,加载实现属 packages/core。
 */

export interface PrincipalConfig {
  mcpProfile: string;
  accountSetIds: string[];
  /** 账套发现/授权范围；旧配置缺省为 allowlist。 */
  accountSetScope?: AccountSetScope;
  enabled: boolean;
  /** V1 authority capabilities. Omitted values default to read for backwards compatibility. */
  capabilities?: PrincipalCapability[];
}

export type AccountSetScope = 'all' | 'allowlist';

export type PrincipalCapability = 'read' | 'validate' | 'write';

export interface McpProfileConfig {
  command: string;
  args?: string[];
  cwd: string;
  /** 单次工具调用尝试预算(ms);退避等待不占此预算,但受渠道总预算约束 */
  requestTimeoutMs: number;
  maxRetries: number;
  /** 传给 server 进程的 env(如 ALLOWED_ACCOUNT_SETS);凭据类 env 禁止 */
  env?: Record<string, string>;
  /** MCP resources/read 的显式 URI allowlist；未配置时禁止读取资源。 */
  allowedResourceUris?: string[];
}

export interface AppConfig {
  principals: Record<string, PrincipalConfig>;
  mcpProfiles: Record<string, McpProfileConfig>;
  channel: {
    port: number;
    publicUrl: string;
    callbackPath: string;
  };
  /** 澄清候选等瞬态会话状态的过期时间(ms) */
  sessionTtlMs: number;
}
