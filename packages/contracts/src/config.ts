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

/**
 * worker 单回合超时的缺省值（D-014：这个 600_000 曾在 5 处各写一遍——改一次 worker
 * 超时语义要改五个地方，现在只剩这一处定义）。与 config/agent.yaml 的
 * `workerTimeoutMs: 600000`（注释"默认 10 分钟"）同一口径，两边同步只改这里。
 */
export const DEFAULT_WORKER_TIMEOUT_MS = 600_000;

/**
 * 主 Agent 回合预算的收尾余量：worker 撞上自己的截止后，Main Agent 还要时间解读子
 * Agent 的最终文本。公式（worker 超时 + 2 分钟）只此一份，assembly/ask/验收脚本
 * 全部调 `turnBudgetMsFor`，不再各写一遍（D-014）。
 */
export const TURN_BUDGET_MARGIN_MS = 120_000;

/** 主 Agent 回合预算 = worker 超时（缺省见 DEFAULT_WORKER_TIMEOUT_MS）+ 收尾余量。 */
export function turnBudgetMsFor(profile?: Pick<ContextProfileConfig, 'workerTimeoutMs'>): number {
  return (profile?.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS) + TURN_BUDGET_MARGIN_MS;
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
