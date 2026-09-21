/**
 * 部署配置类型。YAML 形状见 config/agent.yaml(架构 §8);
 * 秘密与本地参数从 .env / 环境变量并入,加载实现属 packages/core。
 */

export interface PrincipalConfig {
  accountSetIds: string[];
  /** 账套发现/授权范围；旧配置缺省为 allowlist。 */
  accountSetScope?: AccountSetScope;
  enabled: boolean;
  /** V1 authority capabilities. Omitted values default to read for backwards compatibility. */
  capabilities?: PrincipalCapability[];
}

export type AccountSetScope = 'all' | 'allowlist';

export type PrincipalCapability = 'read' | 'validate' | 'write';

/** Trusted filesystem context mounted for the platform subagent. */
export interface ContextProfileConfig {
  /** Absolute path configured by the operator; never supplied by the model. */
  root: string;
  /** Paths relative to root containing Pi-compatible SKILL.md files. */
  skillRoots: string[];
  /** Maximum wall-clock budget for one Worker turn. Defaults to 10 minutes. */
  workerTimeoutMs?: number;
  /** 平台仓知识面（worker read/ls 白名单）；缺省 = .md/.schema.json/.agents//docs/ */
  knowledgePaths?: string[];
  /** 平台仓敏感路径（worker 禁读）；缺省 = .env/.runtime//auth.json/.browser-profile// */
  sensitivePaths?: string[];
}

export interface AppConfig {
  principals: Record<string, PrincipalConfig>;
  /** Trusted platform subagent context profiles. */
  contextProfiles: Record<string, ContextProfileConfig>;
  channel: {
    port: number;
    publicUrl: string;
    callbackPath: string;
  };
  /** 澄清候选等瞬态会话状态的过期时间(ms) */
  sessionTtlMs: number;
}
