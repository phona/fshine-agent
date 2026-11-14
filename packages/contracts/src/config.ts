/**
 * 部署配置类型。YAML 形状见 config/agent.yaml(架构 §8);
 * 秘密与本地参数从 .env / 环境变量并入,加载实现属 packages/core。
 */

export interface PrincipalConfig {
  /** 账套发现/授权范围（遗留数据位：实体授权归执行层，宿主不再读它裁决任何路径）。 */
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
  /**
   * Gateway invocation relative to root (e.g. `bin/<name>`), declared by the
   * operator per profile, never supplied by the model. This is the only
   * place a gateway name is configured: spawn paths must be derived from
   * it (see `gatewayExecPathForProfile`), not from a hardcoded constant.
   * Optional for backward compatibility with profiles written before this
   * field existed; a profile without it cannot be used for host-spawned
   * gateway calls (those call sites fail closed instead of guessing).
   */
  gateway?: string;
  /**
   * Operator-declared display name for this execution layer's subagent,
   * injected into the host Main Agent role text by replacing the
   * `{{executorLabel}}` placeholder in `.agents/agents/fshine-main/agent.md`.
   * Never supplied by the model. Omitted profiles fall back to the neutral
   * host default (`DEFAULT_EXECUTOR_LABEL`) — the host never silently adopts
   * an instance name as its default.
   */
  executorLabel?: string;
  /**
   * Operator-declared delegation tool name for this profile — the
   * model-visible protocol name published for this deployment. Never
   * supplied by the model. Omitted profiles fall back to the neutral host
   * default (`RUN_EXECUTION_TASK_TOOL` = `run_task`); an instance's
   * already-published tool protocol name keeps working by declaring it here.
   */
  toolName?: string;
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

/**
 * Active profile ID 的解析（C5）：宿主不把任何执行层实例名当缺省。
 *
 * 判定规则：显式指定优先；未指定且恰有一个 profile → 该键（单执行层部署零配置可用）；
 * 未指定且 0 个或多个 profile → undefined——由消费方 fail-closed（如
 * resolveContextProfile 拒绝启动回合），绝不静默挑一个或回退实例名。
 * 纯函数：装配派生（assembly）与 runner 缺省（context.ts）共用同一份判定，不新增 env。
 */
export function resolveActiveProfileId(
  profiles: Record<string, ContextProfileConfig>,
  explicit?: string,
): string | undefined {
  if (explicit !== undefined && explicit.trim() !== '') return explicit;
  const keys = Object.keys(profiles);
  return keys.length === 1 ? keys[0] : undefined;
}

/**
 * LLM 连接与模型选择（部署配置，issue #20 切片 C+D）。
 *
 * 源 = config/agent.yaml 的 `llm` 段（gitignored）；同名环境变量（LLM_*）只作
 * 非空值覆盖口。键缺省 = 未配置，由消费方按既有缺省或启动校验处理——加载期不拒启。
 */
export interface LlmConfig {
  apiBaseUrl?: string;
  apiKey?: string;
  model?: string;
  mainModel?: string;
  thinkingLevel?: string;
  mainThinkingLevel?: string;
  /**
   * Main 模型的上下文窗口（token，部署层能力声明）。
   * 压缩阈值 = contextWindow − 摘要预留：窗口声明错了，压缩要么永远不触发、要么过早触发；
   * 缺省（未声明）= 驱动内的 128k 缺省，行为与接线前一致。
   */
  contextWindow?: number;
}

/** 企微智能机器人凭据（部署配置；同名环境变量 WECOM_* 只作非空值覆盖口）。 */
export interface WecomConfig {
  botId?: string;
  botSecret?: string;
}

/**
 * 宿主运行参数（原 FSHINE_* 部署面，issue #20 切片 C）。
 *
 * 源 = config/agent.yaml 的 `host` 段；同名 FSHINE_* 环境变量只作非空值覆盖口。
 *
 * 2026-11-14 P5（分诊 #6「删除未消费键；随 P5 建最小 runtime 段」）：旧
 * platformQueueCapacity / shutdownDrainMs / workerDispatchMode / workerStepCap /
 * inboundDebounceMs / piAgentDir 键**删除**——它们被解析并派生 env 却零生产读取点，
 * 属「写着不生效」的假配置；资源旋钮的唯一入口改为 `runtime` 段（RuntimeConfig）。
 * 仅保留有真实读取点的 attachmentDir（渠道适配器经 FSHINE_ATTACHMENT_DIR 消费，
 * packages/channel-wecom/src/adapter.ts）。旧 YAML 里的已删键由加载层原样忽略。
 */
export interface HostConfig {
  attachmentDir?: string;
}

/**
 * 任务级预算（分诊 #10：时长 + 调用数先落地；token 采集为增强项）。
 * 父任务 → 子 Worker 共享同一份（不复制、不放大）。
 */
export interface TaskBudgetConfig {
  /** 任务总墙钟预算（ms）：跨该任务的全部 Worker 回合与子委派累计。 */
  ms: number;
  /** 任务总执行层调用次数预算。 */
  calls: number;
  /**
   * 任务总 token 预算。仅当 Pi `assistant.usage` 可验证时才配置——否则不设硬上限，
   * 消费方按 `tokens: unavailable` 如实登记，不得伪造限额。
   */
  tokens?: number;
}

/**
 * 资源强制配置段（P5；联合接口约定 §2 冻结的最小字段；P0 注记承接）。
 *
 * 单一配置入口：config/agent.yaml 的 `runtime` 段，**无同名 env 覆盖口**。
 * 与其它部署段的判据刻意不同：非法值 fail-fast（不按「非法 = 未配置」回落）、
 * 未知键拒绝——资源限额静默失效比缺省危险，拼错的旋钮不允许被默认值吞掉。
 * 缺省值不住加载层：由 `packages/agent/src/resource-policy.ts` 的
 * `resolveRuntimeConfig` 按「缺省 = 现行为」补齐（单并发 / 无队列 / 无任务级预算 /
 * 回合时限沿用执行侧现缺省）。
 */
export interface RuntimeConfig {
  /** 前台（Main 交互回合）并发准入上限。缺省 1（现行为：单并发）。 */
  mainConcurrency?: number;
  /** 后台（委派 Worker / 后台任务）并发准入上限；0 = 关闭后台准入（确定性拒绝）。缺省 1。 */
  backgroundConcurrency?: number;
  /** 前台/后台各自的等待队列容量（独立队列）。缺省 0（现行为：无队列，满即拒绝）。 */
  queueCapacity?: number;
  /** Main 回合墙钟上限（ms）。缺省 300000（与执行侧现行缺省一致）。 */
  mainTurnMs?: number;
  /** Worker 回合墙钟上限（ms）。缺省 180000（与执行侧现行缺省一致）。 */
  workerTurnMs?: number;
  /** 委派深度上限；0 = 不允许委派。缺省 1（Main → Worker 一层）。 */
  maxDelegationDepth?: number;
  /** 任务级共享预算；缺省未配置 = 无任务级预算（现行为）。 */
  taskBudget?: TaskBudgetConfig;
  /** waiting_user 等待答复的上限（ms）。缺省 86400000（24h，与 sessionTtl 同量级）。 */
  waitUserTimeoutMs?: number;
}

/**
 * 宿主存储配置（2026-11-10 仲裁修订令：DB_PATH 从 env 升为部署配置）。
 *
 * 源 = config/agent.yaml 的 `store` 段；同名 `DB_PATH` 环境变量只作非空值覆盖口
 * （与 llm / wecom / host / execution 同一判据）。缺键 = 未配置，由装配点按既有
 * 缺省（`data/agent.db`）兜底——加载层不复制缺省值。
 */
export interface StoreConfig {
  /** SQLite 审计 / 任务库路径；相对路径按进程 cwd 解析。 */
  dbPath?: string;
}

/**
 * 执行层交接的宿主持有配置（issue #20 切片 D）。
 *
 * 目前只有计划激活令牌密钥：宿主读入后随 worker 环境逐次注入执行层，不在宿主内解释
 * 业务含义。缺省 = 装配进程内生成（重启失效）。
 */
export interface ExecutionConfig {
  planActivationSecret?: string;
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
  /** LLM 连接与模型选择（yaml `llm` 段；env 非空值覆盖）。 */
  llm?: LlmConfig;
  /** 企微机器人凭据（yaml `wecom` 段；env 非空值覆盖）。 */
  wecom?: WecomConfig;
  /** 宿主运行参数（yaml `host` 段；env 非空值覆盖）。 */
  host?: HostConfig;
  /** 资源强制配置（yaml `runtime` 段；单一入口，无 env 覆盖口，非法值 fail-fast）。 */
  runtime?: RuntimeConfig;
  /** 宿主存储配置（yaml `store` 段；env 非空值覆盖）。 */
  store?: StoreConfig;
  /** 执行层交接配置（yaml `execution` 段；env 非空值覆盖）。 */
  execution?: ExecutionConfig;
}
