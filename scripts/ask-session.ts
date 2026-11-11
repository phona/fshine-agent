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
  mechanicallyPassed,
  mergeCallPhases,
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
  /** 离线 harness 注入 Main/worker 替身驱动（createServerAssembly 的既定覆写位）；CLI 不传。 */
  driver?: ServerAssemblyOverrides['driver'];
  workerDriver?: ServerAssemblyOverrides['workerDriver'];
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
/**
 * 逐轮指标输入（**纯函数**，导出供单测；同一次聚合内去重，不碰任何会话状态）。
 *
 * 2026-11-09 六审 minor：旧写法把 countedIntents/countedDelegations 做成**会话级可变集合并
 * 在遍历时写入**——于是第一次 metrics() 之后，停点已进集合，再读一次同一会话的指标就全计
 * 成 0；继续发消息后也只剩新停点，累计干预数不升反降。读取指标必须是幂等的：去重集合在每次
 * 聚合时重建，跨轮只计首次出现（同一 pending 意图常在多轮 evidence 里复现）。
 */
export function metricInputsOf(turns: readonly MessageTurn[]): MetricCaseInput[] {
  const seenIntents = new Set<string>();
  const seenDelegations = new Set<string>();
  const out: MetricCaseInput[] = [];
  for (const turn of turns) {
    // 干预停点（机械口径）：本轮首次出现的 pending 提案意图 + 挂起等人的委派 run。
    let interventionPoints = 0;
    for (const intent of turn.evidence.intents) {
      if (intent.status !== 'pending') continue;
      if (!seenIntents.has(intent.intentId)) {
        seenIntents.add(intent.intentId);
        interventionPoints += 1;
      }
    }
    for (const run of turn.evidence.delegations) {
      if (run.state !== 'waiting_confirmation' && run.state !== 'waiting_input') continue;
      const key = run.runId ?? run.taskId;
      if (!seenDelegations.has(key)) {
        seenDelegations.add(key);
        interventionPoints += 1;
      }
    }
    out.push({
      caseId: turn.messageId,
      // pass 的机械下界（2026-11-08 三审 blocking）：旧写法把"有证据"当"通过"——执行层明确
      // refused 的调用、exitCode≠0 的调用阶梯都是 invoked，handler 没抛错就算 passed。现在
      // 要求最低档 ≥ completed 且链上无 refused 行。这仍是机械下界，不是用例判定（那由
      // score.ts 的期望值层 + 基线说了算）。
      pass: turn.error === null && mechanicallyPassed(turn.ladder),
      evidence: turn.evidence,
      ladder: turn.ladder,
      interventionPoints,
      durationMs: turn.ms,
    });
  }
  return out;
}

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
    // 指标聚合走纯函数 metricInputsOf（六审 minor）：去重集合每次聚合重建、不写回会话，
    // 重复读取 metrics() 得到同一结果。
    metrics(): AggregateMetrics {
      return aggregateMetrics(metricInputsOf(turns));
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

  async function sendOne(text: string): Promise<MessageTurn> {
    const messageId = `ask_${randomUUID()}`;
    const progress: string[] = [];
    const notices: string[] = [];
    const startedAt = Date.now();
    // 审计窗口游标（执行层证据的采集边界）：窗口只圈住这条消息 await 的 handler 调用。
    //
    // **归因依据目前就是时间窗口，不是持久化 id**（2026-11-08 三审 major，D-205）：
    // 原注释写"链上归因以 messageId → requestId → taskId 为准，窗口只是读取边界"——那句是
    //  aspirational，代码从没做到。执行层审计行（ExecutionAuditRow）不带 requestId/taskId，
    // 没有任何 join 键能把窗口里的某一行钉到这条消息上；于是并发会话或后台任务在同一窗口
    // 里完成的成功查询，会被算成这条消息的 delivered。
    // 正确的修法 = 让执行层把关联 id 写进审计行（宿主经 env 注入、夹具落账），那是跨层协议
    // 变更，不在本轮做；在它落地前，这里**不声称**自己按 id 归因。
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
    // delivered 的授予条件（2026-11-09 七审 blocking 收口一个机械口子）：
    //   ① handler 没抛错且回复非空（用户面事实）；
    //   ② **宿主认得出这条消息**（host.request 非 null）——messageId → requestId 反查得到，
    //      说明这一轮确实走过宿主的受理与门。反查为空 = 断链，此时窗口里的审计行无从归因，
    //      不许拿"有回复"给它们背书（旧写法在 host.request 缺失时照样升 delivered）。
    // 剩余的归因粒度受 D-205 约束：窗口内是否只有本消息的行，取决于"同一装配内是否有多会话
    // 并发共享 EXECUTION_AUDIT_PATH"。评测路径上不可达——sendMessage 经 tail 链串行、
    // background-delivery 不 spawn 平台、dispatch 缺省 inline；生产上并发会话可达，须靠执行层
    // 审计行带关联 id 才能真正按请求过滤（D-205 闭环判据）。
    const attributable = host.request !== null;
    const delivered = error === null && reply.length > 0 && attributable;
    // 读回证据**逐条调用**关联，不拿会话级的"任意一条历史意图读过回"给本轮所有调用背书
    // （PR #21 审查 blocking）：旧写法 `intents.some(...)` 在同一会话早先成功提交过一笔后
    // 恒真，后续另一笔完全没读回的写只要 exitCode=0 就会被标 verified 甚至 delivered——
    // 用历史成功给新调用造假证据。关联键 = 该行的 proposalId ↔ 意图的 proposalId；
    // 读类调用（无 proposalId）不适用读回，由 classifyExecutionCall 的 mode=query 分支处理。
    // 关联不上 = 这条调用未验证，宁可停在 completed。
    const verifiedProposals = new Set(
      intents
        .filter((intent) => intent.status === 'committed' && intent.hasReadback && intent.proposalId)
        .map((intent) => intent.proposalId!),
    );
    // 起止两行按 callId 合并成一次调用一行（十一审 major）：提案路径记「开始 + 结果」，
    // 不合并时开始行（无 exitCode）永远停在 invoked，把成功的提交拖成 invoked/机械失败。
    const ladder = mergeCallPhases(executionRows).map((row) => classifyExecutionCall({
      row,
      readbackVerified: row.proposalId !== undefined && verifiedProposals.has(row.proposalId),
      delivered,
    }));
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
