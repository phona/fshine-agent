/**
 * P2 业务端到端验收 · 数据面类型（eval 胶水层；零产品码改动）。
 *
 * 口径来源：`docs/history/business-e2e-batch2-prereg.md`（冻结预注册）。本文件只声明形状，
 * **不判定**（判定归 `./p2-oracle`）、**不装配**（装配归 `./p2-harness`）。
 *
 * 目标与真值分离（预注册 §一 要求 ①）：
 *   · `turns[]` 是用户话术（会进模型请求）；
 *   · `truth` 只进 Oracle 与证据的 expected 字段，**不进**任何模型提示/脚本。
 */
import type { FactExpectation, TaskTurnFact, TaskView } from '../long-session/oracle';
import type { CompactionAttempt } from '../long-session/compaction';
import type { ModelCallRecord } from '../long-session/accounting';
import type { SessionEvidence, SessionJudgement } from '../long-session/evidence';
import type { MuDeliveryRecord } from '../long-session/multiuser/mu-support';
import type { DriverToolCallRecord } from '../business-e2e/shared-instance';
import type { GrantedScope } from '../business-e2e/judge';

/** 七类场景 × S7 三子例（预注册 §一 / §2.1 冻结）。 */
export type P2ScenarioId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7a' | 'S7b' | 'S7c';

/** 一次执行事实（执行层真实返回的投影；判定底座，不是模型自述）。 */
export interface P2ExecRecord {
  readonly requestId: string;
  readonly operation: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly collection: string | null;
  readonly status: string;
  readonly errorCode?: string;
  readonly data?: unknown;
}

/** 逐次模型调用 + 记账类别 + 所属脚本键（主/摘要/重试/溢出恢复四类区分）。 */
export interface P2ModelCall extends ModelCallRecord {
  /** 该次调用服务的脚本键（用户原文 / 委派任务原文），用于把调用归到回合/会话。 */
  readonly key: string;
  readonly driver: 'main' | 'worker';
}

/** 一次样本的完整观测（逐会话）。 */
export interface P2Observation {
  readonly caseId: string;
  readonly scenario: P2ScenarioId;
  readonly principalId: string;
  readonly sessionId: string;
  readonly mode: 'inline' | 'background';
  readonly turns: readonly { index: number; text: string; reply: string; taskIds: readonly string[] }[];
  readonly taskTurns: readonly TaskTurnFact[];
  readonly tasksFinal: readonly TaskView[];
  readonly execRecords: readonly P2ExecRecord[];
  readonly toolCalls: readonly DriverToolCallRecord[];
  readonly deliveries: readonly MuDeliveryRecord[];
  readonly modelCalls: readonly P2ModelCall[];
  readonly compactionAttempts: readonly CompactionAttempt[];
  readonly transcriptTexts: readonly string[];
  readonly evidence: SessionEvidence;
  readonly judgement: SessionJudgement;
  /** 场景机械事实（闸计数、重启计数、取消事实等）。 */
  readonly extras: Readonly<Record<string, unknown>>;
}

/** 覆盖维度判定（预注册 §5.1 `p2Coverage`）。 */
export interface P2Coverage {
  readonly scenario: P2ScenarioId;
  readonly satisfied: boolean;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly gaps: readonly string[];
}

/** 一条场景特判（附加在通用 Oracle 之上；任一不通过即不通过）。 */
export interface P2Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
  /** true = 本检查属硬零（不可被其它指标抵消）。 */
  readonly hardZero?: boolean;
}

/** 用例定义：话术 + 装配旋钮 + 真值 + 硬零清单 + 覆盖/特判谓词。 */
export interface P2CaseDefinition {
  readonly id: string;
  readonly scenario: P2ScenarioId;
  readonly title: string;
  /** 用户视角目标（给人读；不构成对模型的提示）。 */
  readonly objective: string;
  /** 逐轮用户话术（固定；仅替换对象/窗口）。 */
  readonly turns: readonly string[];
  readonly mode: 'inline' | 'background';
  /** 用户授予的范围（机械越权/越界判据的输入；来自请求语义，不来自执行事实）。 */
  readonly granted: readonly GrantedScope[];
  /** 策略锁定集合（写尝试 = 越权）。 */
  readonly lockedCollections?: readonly string[];
  /** 预注册 §一 本场景的硬零清单（名称级；由 Oracle 逐项落实）。 */
  readonly hardZeros: readonly string[];
  readonly failureCriteria: readonly string[];
  /** 真值：只给 Oracle。 */
  readonly truth: {
    readonly facts: readonly { readonly turn: number; readonly expectation: FactExpectation }[];
  };
  /** 覆盖维度（预注册 §5.1 逐类必要机械事实）。 */
  readonly coverage: (obs: P2Observation) => P2Coverage;
  /** 场景特判（硬零/如实性/不重放等）。 */
  readonly checks: (obs: P2Observation) => readonly P2Check[];
  /** 预注册口径说明 / 已登记冲突（人读）。 */
  readonly notes?: readonly string[];
  /**
   * 预注册自身矛盾（已登记、待 owner 裁定）。设置后样本**不作为**产品通过/失败结论
   * （`P2Judgement.preregBlocked=true`），确定性命中仍照常判定并落证。
   */
  readonly preregConflict?: string;
}
