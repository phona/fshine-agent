/**
 * 黑盒消息适配器（issue #10 切片 B）：ask CLI 与 eval runner 共用的唯一消息入口。
 *
 * 一次消息调用的统一输入/通知/进度/最终回复/异常表示都在这里；同进程多轮、固定
 * conversationId、同一用户由一个**活跃 Assembly** 承载——绝不每轮重启进程来模拟连续
 * 会话（会话状态、计划确认门、附件池、执行层状态都要在同一个进程里连续演化，重启
 * 就不是连续会话了）。CLI 只负责解析参数与输出，链路逻辑全在本适配器。
 *
 * 装配唯一来源 = `apps/server/assembly.ts#createServerAssembly()`（切片 A）：本适配器
 * 不自己拼 driver/runtime/platformTask/handler——生产有什么门与链路，这里就过什么门
 * 与链路；「CLI 绿、生产红」的漂移从结构上不可能再出现。
 *
 * 证据链（切片 D）随每条消息采集：messageId → 宿主库 requestId → task/delegation →
 * 执行层审计行；状态阶梯 authorized/invoked/completed/verified/delivered，断链或无
 * 证据标 INCONCLUSIVE（scripts/eval/evidence.ts）。**不向 Agent 注入任何测试期望**：
 * sendMessage 只把调用方给的文本逐字放进 IncomingChannelMessage.text，期望值只活在
 * 判定层（调用方对返回值断言），不进 prompt/system prompt/skill。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { closeStore, firstEnabledPrincipalId, loadConfig } from '@fshine/core';
import { resolveActiveProfileId } from '@fshine/contracts';
import type { ChannelReply, IncomingChannelMessage } from '@fshine/contracts';
import { createServerAssembly, repoRoot as serverRepoRoot, type ServerAssembly, type ServerAssemblyOverrides } from '../apps/server/assembly';
import {
  aggregateMetrics,
  classifyExecutionCall,
  collectHostFacts,
  collectIntentFacts,
  messageLadderRung,
  readExecutionAuditLog,
  sessionKeyOfChannel,
  type AggregateMetrics,
  type CallLadderEntry,
  type ExecutionAuditRow,
  type HostDelegationFacts,
  type HostIntentFacts,
  type LadderRung,
  type MessageEvidenceChain,
  type MetricCaseInput,
} from './eval/evidence';
import { assessEvalIsolation, assertEvalIsolation } from './eval/safety-gate';

/** 一次消息调用的统一结果（切片 B：输入/通知/进度/最终回复/异常的统一表示）。 */
export interface MessageTurn {
  /** 宿主收到的消息 id（幂等键；关联链的起点）。 */
  messageId: string;
  conversationId: string;
  /** 发送给 Agent 的原文（逐字，未注入任何期望）。 */
  text: string;
  /** 最终回复；ChannelReply 的图片回复形态归一为占位说明。 */
  reply: string;
  /** 计划通知（plan notice）原文列表。 */
  notices: string[];
  /** 进度帧原文列表（生产中经企微流式帧送达）。 */
  progress: string[];
  /** 本轮墙钟。 */
  ms: number;
  /** 异常表示：handler 抛错时为错误消息、reply 为空串；正常为 null。 */
  error: string | null;
  /** 关联 ID 链 + 三源证据（执行层审计日志 / 宿主审计库 / handler 返回）。 */
  evidence: MessageEvidenceChain;
  /** 逐条平台调用的状态阶梯。 */
  ladder: CallLadderEntry[];
  /** 本轮整体阶梯（链上最低档；无执行层证据 = INCONCLUSIVE）。 */
  ladderRung: LadderRung | 'INCONCLUSIVE';
}

export interface AskSessionOptions {
  /** 进程 env（配置、LLM_*、EXECUTION_* 都从这里读）；缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 独立 SQLite 库路径（--db）。缺省 data/ask-<ts>.db——独立验收库，不碰生产库。 */
  dbPath?: string;
  /** 固定会话 id（--conversation）。缺省随机 ask-<uuid8>。 */
  conversationId?: string;
  /** 授权用户。缺省 = 当前配置首个 enabled principal（fail-closed，不回落写死值）。 */
  userId?: string;
  /**
   * 评测安全门（fail-closed）：真 = 要求活跃 profile 是仓内夹具 + gateway 可达 + 审计
   * 通道可写读，否则拒绝建会话。ask CLI 不设（它是生产联调入口）；eval runner 设。
   */
  requireIsolatedFixture?: boolean;
  /** 离线 harness 注入整条渠道（装配硬前提 D-126/D-134 的失败形态注入用）；缺省真渠道。 */
  channel?: ServerAssemblyOverrides['channel'];
  /** 离线 harness 注入企微 SDK 替身；缺省真 WSClient。 */
  channelClientFactory?: ServerAssemblyOverrides['channelClientFactory'];
  /** 离线 harness 注入 Main/worker/Context 替身驱动（createServerAssembly 的既定覆写位）；CLI 不传。 */
  driver?: ServerAssemblyOverrides['driver'];
  workerDriver?: ServerAssemblyOverrides['workerDriver'];
  contextModelDriver?: ServerAssemblyOverrides['contextModelDriver'];
  memoryCandidateExtractor?: ServerAssemblyOverrides['memoryCandidateExtractor'];
}

export interface AskSession {
  readonly conversationId: string;
  readonly userId: string;
  readonly dbPath: string;
  /** 活跃 Assembly（评测需要更深的宿主事实时只读使用）。 */
  readonly assembly: ServerAssembly;
  /**
   * 同进程多轮：上一轮证据采集完才发下一轮（handler 自身按会话串行，这里保证调用侧
   * 也不并发发入同一会话）。文本逐字进 handler，不注入任何期望。
   */
  sendMessage(text: string): Promise<MessageTurn>;
  /** 本会话迄今逐轮的最小聚合指标（通过率/干预/安全违规/耗时/Token）。 */
  metrics(): AggregateMetrics;
  close(): Promise<void>;
}

function replyText(reply: ChannelReply): string {
  return typeof reply === 'string' ? reply : (reply.text ?? '(图片回复)');
}

// ── 评测 run 级关联（evalRunId / caseId）──

let evalRunId = 'local';
let caseId = 'default';

/** 标注评测 run id（eval runner 每次运行开始时调用一次）。 */
export function setAskEvalRunId(id: string): void {
  evalRunId = id;
}

/** 标注当前用例 id（eval runner 每个用例开始时调用）。 */
export function setAskCaseId(id: string): void {
  caseId = id;
}

/**
 * 建会话：生产装配一次，多轮复用。授权用户缺省 fail-closed（配置里没有 enabled
 * principal 就抛错，绝不回落写死值——真实 UserID 曾是这里的硬编码）。
 */
export async function createAskSession(options: AskSessionOptions = {}): Promise<AskSession> {
  const env = options.env ?? process.env;
  const dbPath = options.dbPath
    ? path.resolve(options.dbPath)
    : path.join(serverRepoRoot, 'data', `ask-${Date.now()}.db`);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const config = loadConfig({ env, yamlPath: env['AGENT_CONFIG_PATH'] || undefined });
  const resolvedUser = options.userId ?? firstEnabledPrincipalId(config);
  if (!resolvedUser) {
    throw new Error(`配置 ${env['AGENT_CONFIG_PATH'] || 'config/agent.yaml（缺省）'} 里没有 enabled 的 principal——无法派生授权用户（fail-closed，不回落写死值）`);
  }
  const userId: string = resolvedUser;
  const conversationId = options.conversationId ?? `ask-${randomUUID().slice(0, 8)}`;

  if (options.requireIsolatedFixture) {
    // 与 assembly 同一派生（C5）：单 profile 取其键；零/多 → undefined，安全门按未配置拒。
    const profile = config.contextProfiles[resolveActiveProfileId(config.contextProfiles) ?? ''];
    assertEvalIsolation(assessEvalIsolation({
      env,
      ...(profile?.root ? { platformRoot: profile.root } : {}),
      ...(profile?.gateway ? { gateway: profile.gateway } : {}),
    }), 'ask-session（requireIsolatedFixture）');
  }

  // 唯一装配：driver/runtime/platformTask/计划确认门/handler 全在 createServerAssembly
  // 里接线（含 profile.gateway → worker 驱动的穿线），这里不再有第二份。driver 覆写位
  // 是装配自己的离线注入点（e2e harness 同款），不是第二份装配。
  const assembly = await createServerAssembly({
    env,
    dbPath,
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.channelClientFactory ? { channelClientFactory: options.channelClientFactory } : {}),
    ...(options.driver ? { driver: options.driver } : {}),
    ...(options.workerDriver ? { workerDriver: options.workerDriver } : {}),
    ...(options.contextModelDriver ? { contextModelDriver: options.contextModelDriver } : {}),
    ...(options.memoryCandidateExtractor ? { memoryCandidateExtractor: options.memoryCandidateExtractor } : {}),
  });
  // 只读旁路连接：change_intents 的完整清单查询（AuditStore 契约只暴露 pending 查询，
  // 与 scripts/eval/write-chain.ts 同一条 SQL、同一张表）。库打不开 = 意图档降级为空。
  let intentsDb: Database.Database | null = null;
  try {
    intentsDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    intentsDb = null;
  }

  const turns: MessageTurn[] = [];
  // 干预停点去重账（pending 意图/挂起 run 会话级常驻，只在首次出现计一次）。
  const countedIntents = new Set<string>();
  const countedDelegations = new Set<string>();
  // 调用侧串行：上一轮证据采集完才发下一轮（同一会话内消息本就按序处理）。
  let tail: Promise<unknown> = Promise.resolve();

  const session: AskSession = {
    conversationId,
    userId,
    dbPath,
    assembly,
    sendMessage(text: string): Promise<MessageTurn> {
      const run = tail.then(() => sendOne(text));
      tail = run.catch(() => undefined);
      return run;
    },
    metrics(): AggregateMetrics {
      return aggregateMetrics(turns.map((turn) => metricInputOf(turn)));
    },
    close(): Promise<void> {
      return tail.then(async () => {
        intentsDb?.close();
        intentsDb = null;
        await assembly.close();
      });
    },
  };
  return session;

  function metricInputOf(turn: MessageTurn): MetricCaseInput {
    // 干预停点（机械口径）：本轮首次出现的 pending 提案意图 + 挂起等人的委派 run。
    let interventionPoints = 0;
    for (const intent of turn.evidence.intents) {
      if (intent.status !== 'pending') continue;
      if (!countedIntents.has(intent.intentId)) {
        countedIntents.add(intent.intentId);
        interventionPoints += 1;
      }
    }
    for (const run of turn.evidence.delegations) {
      if (run.state !== 'waiting_confirmation' && run.state !== 'waiting_input') continue;
      const key = run.runId ?? run.taskId;
      if (!countedDelegations.has(key)) {
        countedDelegations.add(key);
        interventionPoints += 1;
      }
    }
    return {
      caseId: turn.messageId,
      pass: turn.error === null && turn.ladderRung !== 'INCONCLUSIVE',
      evidence: turn.evidence,
      ladder: turn.ladder,
      interventionPoints,
      durationMs: turn.ms,
    };
  }

  async function sendOne(text: string): Promise<MessageTurn> {
    const messageId = `ask_${randomUUID()}`;
    const progress: string[] = [];
    const notices: string[] = [];
    const startedAt = Date.now();
    // 审计窗口游标（执行层证据的采集边界）：窗口只圈住这条消息 await 的 handler 调用；
    // 链上归因仍以持久化 id（messageId → requestId → taskId）为准——窗口不是归因依据，
    // 只是执行层审计文件的读取边界（并发/后台完成时宁可多读，由 id 归因裁决）。
    const auditPath = env['EXECUTION_AUDIT_PATH'];
    const auditBefore = readExecutionAuditLog(auditPath)?.length ?? 0;
    const message: IncomingChannelMessage = {
      wecomUserId: userId,
      conversationId,
      messageId,
      chatType: 'single',
      text,
      receivedAt: new Date().toISOString(),
    };
    let reply = '';
    let error: string | null = null;
    try {
      // notice 与生产渠道语义一致：送达后才继续执行；无渠道时收集/打印即"送达"。
      const channelReply = await assembly.handler(message, (frame) => {
        progress.push(frame);
      }, async (notice) => {
        notices.push(notice);
      });
      reply = replyText(channelReply);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    // ── 关联 ID 链（持久化 id 逐档反查，断链如实置 null/缺席）──
    // 主会话键 = handler 同款 `channel:conversationId`。**不能**用 principalId 代替：
    // handler.ts:571 定义"session = 聊天窗口、principal = 发消息的人，两个身份分开…
    // 不互相推导"。单聊时两者同形所以旧写法蒙混过关，但本适配器支持固定且独立的
    // conversationId（--conversation），一旦不同，按 principalId 反查 change_intents /
    // taskRuns 会整批查空，把真实发生的确认与读回事实报成断链（PR #21 审查 major）。
    const sessionKey = sessionKeyOfChannel(conversationId);
    const host = await collectHostFacts(assembly.store, messageId, sessionKey);
    const intents: HostIntentFacts[] = intentsDb ? collectIntentFacts(intentsDb, sessionKey) : [];
    const auditAfter = readExecutionAuditLog(auditPath);
    const executionRows: ExecutionAuditRow[] = auditAfter === null
      ? [] // 审计路径未设/读失败：执行层证据缺席，阶梯如实 INCONCLUSIVE
      : auditAfter.slice(auditBefore);
    const readbackVerified = intents.some((intent) => intent.status === 'committed' && intent.hasReadback);
    const delivered = error === null && reply.length > 0;
    const ladder = executionRows.map((row) => classifyExecutionCall({ row, readbackVerified, delivered }));
    const evidence: MessageEvidenceChain = {
      evalRunId,
      caseId,
      messageId,
      // 断链如实置 null：宿主库里查不到这条消息（受理行缺失/库异常）就是断链，不猜。
      requestId: host.request?.requestId ?? null,
      delegations: host.delegations,
      intents,
      gateRows: host.gateRows,
      executionRows,
      finalReply: delivered ? reply : null,
    };
    const turn: MessageTurn = {
      messageId,
      conversationId,
      text,
      reply,
      notices,
      progress,
      ms: Date.now() - startedAt,
      error,
      evidence,
      ladder,
      ladderRung: messageLadderRung(ladder),
    };
    turns.push(turn);
    return turn;
  }
}

/**
 * 一次多轮会话的便捷封装：同进程、同一会话 id、同一用户，逐条发完返回。
 * 供 eval runner / 冒烟脚本直接用（CLI 走 createAskSession + sendMessage 以便打印逐帧）。
 */
export async function askSession(
  options: AskSessionOptions,
  messages: readonly string[],
): Promise<{ conversationId: string; turns: MessageTurn[]; metrics: AggregateMetrics }> {
  const session = await createAskSession(options);
  const turns: MessageTurn[] = [];
  try {
    for (const text of messages) {
      turns.push(await session.sendMessage(text));
    }
    return { conversationId: session.conversationId, turns, metrics: session.metrics() };
  } finally {
    await session.close();
  }
}

/** 评测报告消费方的便利再导出（不必穿透 evidence.ts 的命名）。 */
export type { HostDelegationFacts, HostIntentFacts };
