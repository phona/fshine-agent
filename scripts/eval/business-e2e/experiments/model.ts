/**
 * bizbatch2 三实验（缺口 1/2/3 落地后）——数据类型、硬上限登记与机械展开。
 *
 * 只提供数据面与机械展开：不跑模型、不判定、不采集（判定归 `./judge`，执行归 `./executor`，
 * 入口归 `./run`）。与探测基线（`../scenarios`）并行的**新实验面**，不改动既有套件与冻结面。
 *
 * 三实验（预注册见 `docs/product/business-e2e-prereg-addendum.md` §五）：
 *   ① task-surface：缺口 1 对话面四工具（task_status/result/cancel/resume）。工具面与分派同源
 *      门控 `taskRunner`——bizprobe/ask 装配路径缺省无 runner（inline），四工具**不注册**；本实验
 *      用例以 `withTaskRunner` 在 **inline 模式直接注入 runner**（缺口 1 设计 §3.3 明示的合法装配：
 *      「inline 模式需要治理工具的调用方直接传 input.taskRunner 即可」），维持本批 inline-only。
 *   ② compaction：缺口 3 压缩窗口（小 LLM_CONTEXT_WINDOW）下的长会话上下文恢复。
 *   ③ skill-arm：缺口 2 三臂对照（无 Skill / 正文注入 inline / 目录+按需读取 catalog）。
 */
import type { GrantedScope } from '../judge';

export type ExperimentKind = 'task-surface' | 'compaction' | 'skill-arm';

/** Skill 实验臂（缺口 2）：none=缺省不投递；inline=臂 A 正文注入；catalog=臂 B 目录+按需读取。 */
export type SkillArm = 'none' | 'inline' | 'catalog';

/** 确定性预置任务（夹具，不经模型）：用于构造挂起/越权探针状态。 */
export interface ExpSeed {
  /** 预置一个 waiting_user 任务（本会话）：request 为任务原文，missing 原文转述；接续由 task_resume 触发。 */
  waitingQuestion?: { request: string; missing: readonly string[] };
  /** 预置一个属于其他 principal/session 的任务（越权探针）：本会话按其 #编号查必须「找不到」。 */
  foreign?: { principalId: string; sessionId: string; request: string };
}

/** 一个实验用例：多轮会话脚本 + 装配选项 + 判据。 */
export interface ExpCase {
  id: string;
  kind: ExperimentKind;
  title: string;
  /** 逐回合用户输入（多轮会话；空行跳过）。 */
  turns: readonly string[];
  /** 每个用例的样本数 N（每样本独立 config/db/state/session）。 */
  trials: number;
  /** 用户授予的范围（机械判定的授权集合）。 */
  granted: readonly GrantedScope[];
  /** skill-arm 的臂（kind='skill-arm' 必填）。 */
  arm?: SkillArm;
  /** 派发模式；缺省 'inline'（本批 inline-only）。 */
  dispatchMode?: 'inline' | 'background';
  /** inline 下直接注入 TaskRunner（缺口 1 四工具同源门控；非 background 的合法装配）。 */
  withTaskRunner?: boolean;
  /** Main 技能根（相对 profile.root）；skill-arm 用。 */
  mainSkillRoots?: readonly string[];
  /** Main 技能投递臂；skill-arm 用。 */
  mainSkillMode?: 'inline' | 'catalog';
  /** 逐用例环境变量（如 LLM_CONTEXT_WINDOW）；键值进进程 env/物化配置，不入证据。 */
  env?: Readonly<Record<string, string>>;
  /** 确定性预置任务。 */
  seed?: ExpSeed;
  /**
   * 灌轮材料：在 turns 之后追加 repeat 轮、每轮 charsEach 字符的中性填充（compaction 用），
   * 用于把转录推过小窗口的压缩阈值。填充文本中性、无业务实体。
   */
  bulkFiller?: { repeat: number; charsEach: number };
  /** bulkFiller 之后的中后段探针回合（compaction 用：探针安排在长会话中后段）。 */
  postFillerTurns?: readonly string[];
  /** 判据：必须真实发生的工具调用名（任一命中即视为发生）。 */
  toolsMustBeCalled?: readonly string[];
  /** 判据：最终回合回复必须包含的中性标记。 */
  replyMustInclude?: readonly string[];
  /** 判据：最终回合回复不得包含的标记。 */
  replyMustExclude?: readonly string[];
  /** 判据：会话中观察到的任务状态须命中其一的集合（空=不判）。 */
  expectTaskStatuses?: readonly string[];
  /** 判据说明（人读；机械面由 judge 落实）。 */
  criteria: readonly string[];
}

/** 一个待跑样本：用例 × trial 展开项。 */
export interface ExpItem {
  id: string;
  caseId: string;
  kind: ExperimentKind;
  arm: SkillArm | null;
  trial: number;
  sessionId: string;
}

/** 展开用例集为待跑样本；每样本稳定 id（`<caseId>#<trial>`）。 */
export function expandExpItems(cases: readonly ExpCase[], trialsOverride?: number): ExpItem[] {
  const items: ExpItem[] = [];
  for (const caseDef of cases) {
    const trials = trialsOverride ?? caseDef.trials;
    for (let trial = 1; trial <= trials; trial += 1) {
      items.push({
        id: `${caseDef.id}#${trial}`,
        caseId: caseDef.id,
        kind: caseDef.kind,
        arm: caseDef.kind === 'skill-arm' ? (caseDef.arm ?? 'none') : null,
        trial,
        sessionId: `bizbatch2-${caseDef.id}-t${trial}`,
      });
    }
  }
  return items;
}

/** 把用例的 turns 与 bulkFiller/postFillerTurns 展开成实际逐回合输入。 */
export function effectiveTurns(caseDef: ExpCase): string[] {
  const turns = [...caseDef.turns];
  const filler = caseDef.bulkFiller;
  if (filler !== undefined) {
    // 中性填充：仅用于把转录推过压缩阈值，不含业务实体/命令。
    const unit = '（以下为中性填充文本，与任务无关，仅用于把会话推长：'
      + '核对流程的一般性说明、注意事项与背景铺垫，逐条罗列，不含任何对象名、命令或结论。）';
    for (let i = 0; i < filler.repeat; i += 1) {
      let text = '';
      let n = 0;
      while (text.length < filler.charsEach) { text += `${n}. ${unit}\n`; n += 1; }
      turns.push(text.slice(0, filler.charsEach));
    }
  }
  for (const probe of caseDef.postFillerTurns ?? []) turns.push(probe);
  return turns;
}

/**
 * 硬上限登记（bizbatch2；缺一不跑）。
 * 会话上限 90（owner 2026-11-15：本批真实模型会话 ≤90；累计 ≤150，已耗 54，余 96）。
 * 并发 4 ≤ `HARD_LIMIT_REGISTRY.evalBatchConcurrency.max=8`。
 * maxTokens 驱动面不可预注册 → 如实标注 unavailable，不编造。
 */
export const EXP_HARD_LIMITS = {
  maxSessions: 90,
  maxModelCallsPerExperiment: { 'task-surface': 72, compaction: 240, 'skill-arm': 108 } as Readonly<Record<ExperimentKind, number>>,
  maxTokens: 'unavailable' as const,
  maxWallMsPerSession: 600_000,
  maxWallMsPerExperiment: 1_800_000,
  concurrency: 4,
  hardLimitName: 'evalBatchConcurrency' as const,
} as const;

/** 断言某实验的样本数与并发不越硬上限；越界即抛（缺一不跑）。 */
export function assertWithinExpHardLimits(input: {
  kind: ExperimentKind;
  sessions: number;
  concurrency: number;
  maxModelCalls: number;
  maxWallMs: number;
}): void {
  if (input.sessions > EXP_HARD_LIMITS.maxSessions) {
    throw new Error(`实验会话数 ${input.sessions} 超过硬上限 ${EXP_HARD_LIMITS.maxSessions}（超出即停、留证、不擅自扩容）`);
  }
  if (input.concurrency > EXP_HARD_LIMITS.concurrency) {
    throw new Error(`并发 ${input.concurrency} 超过本批硬要求 ${EXP_HARD_LIMITS.concurrency}（硬上限登记 max=8）`);
  }
  const cap = EXP_HARD_LIMITS.maxModelCallsPerExperiment[input.kind];
  if (input.maxModelCalls > cap) {
    throw new Error(`实验 ${input.kind} 模型调用上限 ${input.maxModelCalls} 超过登记值 ${cap}`);
  }
  if (input.maxWallMs > EXP_HARD_LIMITS.maxWallMsPerExperiment) {
    throw new Error(`墙钟上限 ${input.maxWallMs} 超过登记值 ${EXP_HARD_LIMITS.maxWallMsPerExperiment}`);
  }
}

/** 有效硬上限登记行（供报告/证据；含 maxTokens 不可得标注）。 */
export function expHardLimitRegistration(kind: ExperimentKind): Record<string, unknown> {
  return {
    experiment: kind,
    maxSessions: EXP_HARD_LIMITS.maxSessions,
    maxModelCalls: EXP_HARD_LIMITS.maxModelCallsPerExperiment[kind],
    maxTokens: EXP_HARD_LIMITS.maxTokens,
    maxTokensNote: '驱动面 token 计数不可预注册——如实标注不可得，不编造',
    maxWallMsPerSession: EXP_HARD_LIMITS.maxWallMsPerSession,
    maxWallMsPerExperiment: EXP_HARD_LIMITS.maxWallMsPerExperiment,
    concurrency: EXP_HARD_LIMITS.concurrency,
    hardLimitName: EXP_HARD_LIMITS.hardLimitName,
  };
}
