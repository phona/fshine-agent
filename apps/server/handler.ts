/**
 * 消息处理主链路:授权 → 审计 → Agent(runtime + LLM)→ Context Worker → 回复。
 * 被 apps/server/main.ts 与 tests/e2e 共用,保证测的就是跑的。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  AgentReply,
  AgentRequestRepo,
  AgentRuntime,
  AuditStore,
  BackgroundTaskEvent,
  ChannelReply,
  ChannelRoute,
  DeliveryReceipt,
  IncomingAttachment,
  IncomingChannelMessage,
  NoticeFn,
  ProgressFn,
  ReplyHandler,
} from '@fshine/contracts';
import { formatFileReceipt } from '@fshine/contracts';
import { newId } from '@fshine/core';
import { ATTACHMENT_PATHS_MARKER } from '@fshine/agent';
import { appendArtifactManifest, finalizeWithArtifacts, loadArtifactManifest } from './artifact-store';
import { createBackgroundNoticeSender, createBackgroundTaskEventProcessor, redactNotice } from './background-delivery';
import type { WorkerDispatchMode } from './dispatch-mode';

export interface HandlerDeps {
  /** 环境变量源（读 FSHINE_INBOUND_DEBOUNCE_MS）；缺省 process.env。 */
  env?: Record<string, string | undefined>;
  /** 平台工作区根：用于收集本轮回传给用户的产物文件（只认 tmp/ 下的）。 */
  platformRoot?: string;
  /**
   * 会话产物库的字节根（W2）：交付即入库的落盘位置，形如 `<repo>/data`（库内布局
   * `sessions/<sessionId>/artifacts/`）。缺省 = 不入库、不注入清单（旧部署/测试替身
   * 退化：交付仍按流式附件走，与 W2 之前一致）。
   */
  dataRoot?: string;
  /**
   * 入站防抖窗口（毫秒）：**burst 内**带正文的消息在进入会话队列前先等这么久，让同一
   * burst 里稍晚到达的附件先落地。缺省取 env `FSHINE_INBOUND_DEBOUNCE_MS`，再缺省 2000。
   *
   * 为什么需要：企微的模型里"3 个文件 + 1 条指令"是 4 条独立消息（`MixedMsgItem` 只支持
   * text/image，文件无法与文字同条），而会话队列是串行的——指令那条一启动，晚到的文件
   * 只能排到它后面，于是这一轮用不上（2026-10-08 实测：4 条消息同一秒内到达，顺序是
   * 文件→指令→文件，指令那轮只带了 2 个）。
   * 参照 OpenClaw `messages.inbound.debounceMs`：文本参与防抖，媒体/附件立即 flush。
   * 附件-only 消息因此**不等待**（用户发完文件立刻看到"已收到"）。
   *
   * 2026-10-16 首帧提速改成"首条零防抖"：窗口内**首条**消息立即处理、后续到达才合并——
   * 判据是本条到达前的一个窗口里有没有先行消息（任何消息，含附件）。冷启动的对话不再
   * 白等 2s；只有 burst 进行中（先行消息打开了窗口）的指令回合才等。
   *
   * 2026-10-19 乱序到达：等的判据从"睡满一个窗口"改成**静默**（一个窗口内没有新到达才算
   * burst 结束，见 waitForBurstSettle），最多 4 个窗口。企微不保证同批消息按发送顺序投递，
   * 固定窗治不了"第三个文件落在指令回合开跑之后"——实测跨度 3s 就超过了 2s 窗，那一轮会
   * 拿着不完整的文件集算完。真的等到了触顶还没稳的文件不丢：进暂存池，由下一条指令带上。
   */
  inboundDebounceMs?: number;
  /**
   * 回合心跳帧间隔（毫秒）：受理帧之后如果整整这么久没有任何帧（模型一轮还没说完话、
   * 也没有委派帧），补一帧「仍在处理中」，填掉会话轮 10–20s 的盲段。缺省 8000。
   * 只补一帧（一次性定时器）：重复心跳会挤占渠道的 4 帧进度硬顶，让真实进度帧反被丢掉。
   * 真实帧已在流动（或披露已上屏）时保持静默——用户不再盲等，就不添噪。0 或负数 = 关闭。
   */
  turnHeartbeatMs?: number;
  /**
   * 到达时刻的来源（缺省进程内严格递增钟，见 createArrivalClock）。
   *
   * 注入点留缝用：判据本体只认识 `next()`，多实例部署时换一个共享单调源即可，
   * 不必改规则一。生产默认值就是进程内那把钟——现在没有第二个实例。
   */
  arrivalClock?: ArrivalClock;
  store: AuditStore;
  runtime: AgentRuntime;
  planConfirmation?: {
    handle(message: { origin: 'wecom_user'; messageId: string; principalId: string; sessionId: string; text: string; receivedAt: string }): Promise<{ status: string; planId?: string; version?: number; taskId?: string }>;
    savePending?: (pending: { planId: string; version: number; taskId: string; principalId: string; sessionId: string; requestId: string; userText: string }) => Promise<void>;
  };
  /** Host proactive delivery seam. It does not capture or reuse an inbound message frame. */
  pushToConversation?: (route: ChannelRoute, reply: ChannelReply) => Promise<DeliveryReceipt>;
  /** Background acceptance replies must not scan a Worker's output before its task event. */
  workerDispatchMode?: WorkerDispatchMode;
}

/** The WeCom adapter receives the callable reply handler; assembly also uses its event ingress. */
export type ServerReplyHandler = ReplyHandler & {
  enqueueTaskEvent(event: BackgroundTaskEvent): Promise<void>;
};


/**
 * 池内附件：契约附件 + **何时到达**。
 *
 * 为什么必须记住到达时刻：交付集按"自上次委派开始以来新到达的"算（规则一，见
 * selectDeliveredAttachments），没有时刻就分不出"这轮新给的"与"上轮已经交付过的"——
 * 而那正是同日多任务串味的根源：10:00 交 工资.xlsx 做工资表，11:30 交 进项票.xlsx
 * 做下一批，第二轮把两个文件一起交付，worker 没有任何线索知道哪个属于本次任务，
 * 于是安静地产出错误结果（P0：算错钱）。
 */
interface PooledAttachment extends IncomingAttachment {
  /**
   * 到达时刻（进程内同一把严格递增的钟，见 ArrivalClock）。
   *
   * `undefined` = 来自审计库恢复、到达时刻未知（服务重启后内存池失记时的兜底来源）。
   * 未知一律按"未消费"算——宁可多给，不可漏：漏一个文件会让 worker 回"没有数据"，
   * 而多给一个至少有规则二的披露兜底（用户几秒内就能看到本轮用了哪些文件）。
   */
  arrivedAt: number | undefined;
}

/**
 * 会话级委派账本：上次委派**开始**的时刻，以及那次交付了哪些文件。
 *
 * 只活在进程内存里，不落库：服务重启后按"全部未消费"降级（见 restoreAttachments），
 * 而 24h 窗口内的附件仍可由审计库恢复，方向是宁可多给。
 */
interface DelegationLedger {
  lastDelegationStartedAt: number;
  lastDelegationDelivered: IncomingAttachment[];
}

/**
 * 到达时刻的来源：进程内同一把严格递增的钟。
 *
 * 为什么不能直接存 `Date.now()`：① 时钟粒度是毫秒，而"附件到达"与"委派开始"完全可能
 * 落在同一毫秒里（测试里必然如此；生产上防抖 + 排队也只把差距拉到毫秒量级）。同毫秒时
 * `>` 分不出先后，而分错的代价是静默的——用户刚发的文件被当成"上次已交付"丢掉，或者
 * 旧文件在后续每一轮都被当成新到达。② `Date.now()` 本身也不严格单调（NTP 步进会回退）。
 * 所以每取一次都钳成"至少比上一次大 1"：值仍是毫秒墙钟（日志里看得懂、能与
 * lastDelegationStartedAt 对齐），序关系严格可靠。
 *
 * **为什么包成接口而不是模块级变量**（2026-10-20 留缝）：规则一的判据本体是"到达时刻 >
 * 上次委派开始时刻"，而这把钟目前活在进程内存里。第二个客户端（web/小程序）意味着多实例——
 * 那时"同一毫秒分不出先后"会原样回来，且要的是一个跨实例共享的单调源。提前焊死一个模块级
 * `let`，等于把那天的改造从"换一个实现"升级成"动判据本体"。所以：宿主持有一把钟
 * （`deps.arrivalClock` 可注入），判据只认识 `next()`。
 */
export interface ArrivalClock {
  next(): number;
}

/** 进程内严格递增钟的缺省实现（上面两条理由的落点）。 */
export function createArrivalClock(): ArrivalClock {
  let last = 0;
  return {
    next(): number {
      last = Math.max(Date.now(), last + 1);
      return last;
    },
  };
}

/**
 * 规则一的选择结果：本轮交付集，以及**这批文件是不是本轮新到的**。
 *
 * 为什么必须把 `fresh` 带出来：收据帧（规则二）只该在"用户本轮真的发了文件"时上屏。
 * 分支 ② 沿用上次委派交付集的那批文件，它们的收据早在到达那一轮就播过——2026-10-20
 * 用户观察（企微会话实录）：3 个文件 + 一条指令之后，用户又问了一句与附件无关的话，
 * 气泡里又冒出"已收到 3 个文件：…"，用户原话"怎么不管怎么样都会显示说收到附件？"。
 * 交付行为一个字节不改（worker 照旧拿到那批文件），只是不再复读旧清单。
 */
interface DeliveredSelection {
  files: IncomingAttachment[];
  /** true = 本轮有新到达（或账本失记、全量按未消费）；false = 沿用上次委派的交付集。 */
  fresh: boolean;
}

/**
 * 规则一：本轮交付集 = 自「上次委派开始」以来新到达的附件。
 *
 * 三种收尾，缺一不可：
 *   ① 有新到达的            → 用它们（同日多任务的第二个任务因此只拿到自己那几个）；
 *   ② 没有新到达的          → 沿用上次委派的交付集（纠正/重试流："社保填错了，重做"
 *                              时文件当然还是上轮那些，不能因为"没有新附件"就交空集）；
 *   ③ 两次都空              → 空。
 *
 * 为什么界取"委派**开始**"而不是"委派完成"：用完成时刻的话，委派执行过程中（可能 10 分钟）
 * 到达的附件会被算进这一轮，而它们其实是给下一轮的。附件后到因此被正确归到下一轮。
 */
function selectDeliveredAttachments(
  candidates: readonly PooledAttachment[],
  ledger: DelegationLedger | undefined,
): DeliveredSelection {
  // 从未委派过（全新会话，或重启后账本失记）：全部按未消费交付。
  if (!ledger) return { files: [...candidates], fresh: true };
  const fresh = candidates.filter(
    (file) => file.arrivedAt === undefined || file.arrivedAt > ledger.lastDelegationStartedAt,
  );
  if (fresh.length > 0) return { files: fresh, fresh: true };
  // ② 纠正/重试流：直接沿用上次交付的那一批（仍要过存在性检查——tmp/ 可能已被清理）。
  return { files: ledger.lastDelegationDelivered.filter((file) => existsSync(file.path)), fresh: false };
}

/**
 * 规则二的措辞：本轮用了哪些文件，只说事实。
 *
 * 纪律：短；只列**文件名**不列路径（路径刷屏对用户没有任何信息量，且属于实现细节）。
 * 句子本身由契约层的 `formatFileReceipt` 出——同一句"你发了哪些文件"在宿主回合首帧
 * 与渠道的孤儿收据（只发文件、迟迟没有指令时补的那条）两地出现，措辞必须只有一个
 * 权威位置，否则同一事实两种说法，迟早成一桩交互债。
 *
 * 2026-10-19 起它同时是**附件回合的收据**：附件-only 消息不再各自回一条"已收到 X"
 * （企微的流式回复按入站消息的 req_id 走，N 个文件必然是 N 个气泡，见
 * channel-wecom adapter），收据因此并到这一帧上——用户先看到"已收到 3 个文件：…"，
 * 再看到同一气泡里的进度与终稿。
 *
 * 2026-10-20 补一刀边界：这一帧**只在本轮真有新到达的附件时才播**（判据见
 * DeliveredSelection.fresh）。沿用上次交付集的回合（纠正/重试流）安静交付——
 * 那批文件的收据早在到达那一轮播过，每句后续指令都复读一遍就是刷屏。
 */
export function describeDeliveredFiles(files: readonly IncomingAttachment[]): string {
  if (files.length === 0) return '';
  return formatFileReceipt(files.map((file) => file.filename));
}

/**
 * 本轮交付集 + 它是不是"本轮新到的"。
 *
 * 为什么必须把 `fresh` 带出来：收据帧（规则二）只该在"用户本轮真的发了文件"时上屏。
 * 规则一在"没有新附件"时沿用上次委派的交付集（纠正/重试流），那批文件的首帧收据早在
 * 它们到达那一轮就播过——2026-10-20 用户观察（企微会话实录）：3 个文件 + 一条指令之后，
 * 用户又问了一句与附件无关的话（"发一下 幻骥达2026年08月个税申报.xlsx 给我"），气泡里
 * 又冒出"已收到 3 个文件：…"，用户原话"怎么不管怎么样都会显示说收到附件？"。
 * 交付行为不变（worker 仍拿到那批文件），只是不再复读。
 */
interface RestoredAttachments {
  delivered: IncomingAttachment[];
  /** 本轮是否真的有新到达的附件（含与正文同条到达的；账本失记时算新，见选择结果）。 */
  fresh: boolean;
}

/**
 * 取本轮要交付给 worker 的附件：内存优先，DB 兜底（重启恢复），**按委派边界取**。
 *
 * 四条纪律：① 去重按 path（同一文件不因"内存有、DB 也有"而重复进请求）；② 只保留最新
 * N 个（与暂存上限同一个数，避免无限增长把每个回合的输入撑爆）；③ 只保留**仍在盘上**的
 * ——tmp/ 会被 24h 清理回收，路径失效就该安静退出，而不是让 worker 拿一个打不开的路径；
 * ④ 交付集按规则一算，不是"会话里累积的全部"。
 *
 * ④ 与内存池的分工：池子记"这个会话有过哪些文件"（含已被委派交付过的），账本记"哪些
 * 已经被哪次委派用过"。交付从池子里按账本挑，池子本身不因交付而清空——纠正/重试流
 * 要靠它回看上一步。
 */
async function restoreAttachments(
  sessionKey: string,
  message: IncomingChannelMessage,
  store: HandlerDeps['store'],
  sessionAttachments: Map<string, PooledAttachment[]>,
  ledger: DelegationLedger | undefined,
  clock: ArrivalClock,
): Promise<RestoredAttachments> {
  const fromMemory = sessionAttachments.get(sessionKey) ?? [];
  const fromDb = await loadRecentAttachments(store, principalIdOf(message), sessionKey);
  const merged = new Map<string, PooledAttachment>();
  // DB 在前、内存在后：同 path 时内存覆盖 DB（内存是更新的那份，且带着到达时刻）
  for (const file of fromDb) merged.set(file.path, { ...file, arrivedAt: undefined });
  for (const file of fromMemory) merged.set(file.path, file);
  // 与正文同一条消息到达的附件当然是本轮的
  for (const file of message.attachments ?? []) merged.set(file.path, { ...file, arrivedAt: clock.next() });
  const candidates = [...merged.values()];
  // 池子：这个会话迄今有过的文件（含已交付过的），上限与暂存上限同一个数。
  // DB 恢复来的文件没有到达时刻，落池时补一个"现在"——它自此被记作"这次委派已见过"，
  // 否则重启恢复的那批会在后续每一轮都被当成新到达（规则一被绕过）。
  const pooled = [...candidates]
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(-MAX_PENDING_ATTACHMENTS)
    .filter((file) => existsSync(file.path))
    .map((file) => ({ ...file, arrivedAt: file.arrivedAt ?? clock.next() }));
  if (pooled.length > 0) sessionAttachments.set(sessionKey, pooled);
  const selection = selectDeliveredAttachments(candidates, ledger);
  return {
    delivered: selection.files
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(-MAX_PENDING_ATTACHMENTS)
      .filter((file) => existsSync(file.path)),
    fresh: selection.fresh,
  };
}

/**
 * 从审计存储读本 principal 最近的附件接收行，解析附件信封。
 *
 * 只认 outcome='attachment_received' 的行——那是"只发附件、没有指令"的登记；带附件的
 * 普通回合其附件已在自身 input 里，不需要在这里重复取。
 * 任何失败（旧库没有这个方法 / 查询抛错）都返回空数组：恢复是增强，不是前提。
 */
async function loadRecentAttachments(store: HandlerDeps['store'], principalId: string, sessionKey: string): Promise<IncomingAttachment[]> {
  const repo = store.requests as Partial<AgentRequestRepo>;
  if (typeof repo.listRecentAttachments !== 'function') return [];
  try {
    const rows = await repo.listRecentAttachments(
      principalId,
      new Date(Date.now() - ATTACHMENT_RESTORE_WINDOW_MS).toISOString(),
    );
    const seen = new Map<string, IncomingAttachment>();
    for (const row of rows) for (const file of parseAttachmentEnvelope(row.input, sessionKey)) seen.set(file.path, file);
    return [...seen.values()];
  } catch {
    return [];
  }
}

/** 入站防抖默认窗口：2 秒。参照 OpenClaw 默认 1500–2000ms；群聊可调更短。 */
const DEFAULT_INBOUND_DEBOUNCE_MS = 2000;

/**
 * 附件 burst 稳定器的窗口倍数上限：等"一个窗口内没有新到达"才收工，最多等这么多轮。
 *
 * 为什么不是睡满一个固定窗（2026-10-19，乱序到达）：企微不保证同一批消息按发送顺序投递，
 * 实测跨度就有 3 秒——3 个文件 + 1 条指令，第三个文件落在指令回合开跑之后。固定窗只覆盖
 * "指令之后 2 秒内到达"那一段，而且它治不了"文件落在指令之后"：那时防抖早就睡完了，
 * `restoreAttachments` 已经拍完快照，那一轮是拿着不完整的文件集算完的。
 *
 * 稳定器把判据从"睡了多久"换成**静默**：一个窗口内没有新到达，才算 burst 结束。
 *
 * 为什么是 4 轮而不是无限等：等待必须有上界，否则一条永远 trickle 的文件流能把回合无限期
 * 按住。4 × 2s = 8s，盖住实测的 3s 跨度并留一倍余量。触顶时仍未落定的文件不丢——进暂存池，
 * 由渠道并窗补一条收据、由下一条指令的回合首帧带上（见 attachmentOnly 分支）。
 */
const MAX_BURST_SETTLE_WINDOWS = 4;

/**
 * 受理帧文案（首帧提速，2026-10-16）：回合真正开跑时（防抖后、出队列、进 runtime 之前）
 * 由宿主经 progress 通道发的确定性回执。
 *
 * 与渠道 ack 的分工（2026-10-16 评审修正，如实叙事）：渠道层对**带正文**的消息无条件秒回
 * 「收到,正在处理…」（channel-wecom adapter 的 ACK_TEXT），"收达"那一层早已即时回执——
 * 用户从发消息起就不是盲等。本帧标记的是**回合真正开跑**：防抖结算完、出了会话队列、
 * 即将进 runtime。两帧语义递进（ack=已收达、受理帧=已开跑），不是近义重复。
 *
 * 为什么由宿主发而不是等模型：delegate 轮的第一帧「正在…」要等第一轮 LLM（10–20s），
 * conversation 轮直到终稿零帧——ack 之后到第一帧之间仍有一段只有"收达"没有"开跑"的
 * 空窗，这帧把它填上。文案纪律：不泄漏内部机制词（防抖/队列/runtime 一概不提）、不承诺
 * 时长（没有"马上/稍等 X 秒"）、群聊单聊同形（无人称、无 @）。它是宿主回执不是模型文本，
 * 不经过出口校验，也不进转录。
 *
 * 2026-10-19：**附件回合不发这一帧**——那类回合的第一帧是规则二的文件收据
 * （"已收到 N 个文件：…"，见 describeDeliveredFiles），它已经证明回合开跑且信息量更大，
 * 两帧挨着冒只是抖动。心跳因此改锚帧流量（announceAccepted），不再假设受理帧一定存在。
 */
export const TURN_ACCEPTED_TEXT = '开始处理你的请求';

/**
 * 心跳帧文案：布防之后整整一个心跳周期没有任何帧流过时补的这一帧。同受理帧的文案纪律，
 * 且只补一帧——真实帧一旦开始流动就静默，不挤占渠道的 4 帧进度硬顶。
 */
export const TURN_STILL_WORKING_TEXT = '仍在处理中';

/** 回合心跳帧缺省间隔：8s——低于会话轮第一轮 LLM 的典型下限（10s），只补真盲段。 */
const DEFAULT_TURN_HEARTBEAT_MS = 8_000;

/** 单会话附件暂存上限（模块级：restoreAttachments 在闭包外也要用）。 */
const MAX_PENDING_ATTACHMENTS = 8;

/** 恢复窗口：只认最近 24h 内登记的附件。更早的要么已用完，要么已被 tmp 清理回收。 */
const ATTACHMENT_RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 渠道前缀缺省值：消息没带 `channel` 时按企微算（存量调用方与测试替身都不用改）。
 *
 * 前缀会进请求审计、Conversation Log 与 sessionId，所以它从消息上取而不是宿主猜。授权
 * 存储和 handler 内存态目前仍按原始用户/会话 ID 取键，尚未跨渠道隔离；第二渠道接入前须
 * 先完成 D-112 的身份存储迁移与同 ID 隔离验收。
 */
const DEFAULT_CHANNEL = 'wecom';

/** principalId = 渠道前缀 + 渠道原生用户 id。见 DEFAULT_CHANNEL 的说明。 */
function principalIdOf(message: IncomingChannelMessage): string {
  return `${message.channel ?? DEFAULT_CHANNEL}:${message.wecomUserId}`;
}

/**
 * 等附件 burst 稳了：一个窗口内没有新到达就收工，触顶兜底。
 * 判据是**静默**而不是"睡满 N 秒"——文件持续 trickle 时就一直等，这正是乱序投递要的；
 * 每一轮都对照 `lastArrivalAt`，所以安静的 burst 仍然只等一个窗口（与旧行为同延迟，
 * 冷启动的首条零防抖也不受影响：调用方的 `burstInProgress` 门挡着它）。
 *
 * 为什么等的是"没有新到达"而不是"附件到齐"：后者要求预先知道一共有几个文件，而那正是
 * 乱序投递下不知道的事。
 */
async function waitForBurstSettle(
  lastArrivalAt: Map<string, number>,
  queueKey: string,
  windowMs: number,
  capMs: number,
): Promise<void> {
  let waited = 0;
  while (waited < capMs) {
    const before = lastArrivalAt.get(queueKey);
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    waited += windowMs;
    if (lastArrivalAt.get(queueKey) === before) return;
  }
}

export function createMessageHandler(deps: HandlerDeps): ServerReplyHandler {
  const { store, runtime } = deps;
  // 本实例持有的到达钟（缺省进程内严格递增钟）。判据本体只认识 next()，注入点留给
  // 多实例部署时换共享单调源——见 ArrivalClock 的注释。
  const arrivalClock = deps.arrivalClock ?? createArrivalClock();
  // 同一会话的消息串行处理(pi 的 steering/followUp 队列哲学):
  // 并发回合会竞态会话状态(候选/游标/历史互相覆盖),必须排队
  const sessionQueues = new Map<string, Promise<unknown>>();
  /**
   * 会话级附件池：用户"先发文件、再发指令"时，文件消息只登记不启回合。
   *
   * 否则 N 个文件 = N 次 LLM 调用，且串行堵住队列——真正带指令的那条排在后面出不来。
   * 2026-10-07 实测：3 个文件 + 1 条指令 → 4 个 ack、0 个最终回复，第一条文件回合在
   * LLM 上卡住（10 分钟预算内不返回），用户的指令被它挡死。
   *
   * 上限 8 个，FIFO 逐出最旧的（逐出要告知：用户不知道自己最早发的那个已不算数）。
   * 不设上限会把后续每个回合的输入撑爆，而那正是它要避免的问题。
   *
   * **池子只记"这个会话有过哪些文件、各自何时到达"**，"哪些已经被哪次委派用过"是
   * sessionDelegations 的账本。2026-10-07 曾把两者混为一谈：池子即交付集、整批交付且
   * 永不清空，于是同一天的第二个任务会拿到第一个任务的文件（10:00 交 工资.xlsx 做工资表、
   * 11:30 交 进项票.xlsx 做下一批，第二轮两个都交付）——worker 没有任何线索分辨归属，
   * 可能两个都读（浪费时间）、读错那个（做错），安静地产出错误结果。现在交付由账本按
   * 委派边界挑（规则一），池子不清空（纠正/重试流要靠它回看）。
   */
  const sessionAttachments = new Map<string, PooledAttachment[]>();
  /**
   * 会话级委派账本（规则一的另一本账）：上次委派何时开始、交付了哪些文件。
   *
   * 为什么必须有"交付了哪些文件"这一列：本轮没有新附件时（纠正/重试流）要能沿用上一步
   * 的那批，否则用户说"社保填错了，重做"会拿到一个空集——那正是 2026-10-07 "取走即清空"
   * 被翻案的原因（机器人回"没收到数据"，用户完全无法理解）。
   *
   * 只在进程内存里，不落库：重启后账本失记 → 按"全部未消费"降级（宁可多给，不可漏），
   * 24h 窗口内的附件仍由审计库恢复（restoreAttachments 的 DB 那条路）。
   */
  const sessionDelegations = new Map<string, DelegationLedger>();

  // 空串必须归一成 NaN 而不是 0：Number('') === 0，会被当成「显式配置了 0」，
  // 于是默认值永远不生效（2026-10-08 测试抓到的静默失效）。
  const rawDebounce = deps.env?.['FSHINE_INBOUND_DEBOUNCE_MS']?.trim();
  const fromEnv = rawDebounce ? Number(rawDebounce) : Number.NaN;
  const debounceMs = deps.inboundDebounceMs ?? (Number.isFinite(fromEnv) ? fromEnv : DEFAULT_INBOUND_DEBOUNCE_MS);
  const turnHeartbeatMs = deps.turnHeartbeatMs ?? DEFAULT_TURN_HEARTBEAT_MS;
  /**
   * 每会话最近一次消息到达时刻（进程内毫秒时钟）——「首条零防抖」的窗口判据。
   *
   * 为什么记所有消息（含附件-only）：附件正是 burst 的成员——"文件→指令"形状里，指令
   * 那条必须因为 0.5s 前的文件而知道自己处于 burst 中、要等窗口让尾随附件落地
   * （2026-10-08 的事故形状）。会话数即条目数，与 sessionAttachments 同量级，不另设清理。
   */
  const lastArrivalAt = new Map<string, number>();

  const processBackgroundTaskEvent = createBackgroundTaskEventProcessor({
    store,
    runtime,
    ...(deps.platformRoot ? { platformRoot: deps.platformRoot } : {}),
    ...(deps.dataRoot ? { dataRoot: deps.dataRoot } : {}),
    ...(deps.pushToConversation ? { pushToConversation: deps.pushToConversation } : {}),
    ...(deps.planConfirmation?.savePending ? { onPlanPending: deps.planConfirmation.savePending } : {}),
  });
  const enqueueTaskEvent = async (event: BackgroundTaskEvent): Promise<void> => {
    // 现行会话键 = 裸 conversationId（同下方主路径 queueKey）；旧 run（W1 之前）的 sessionId
    // 是三段 channel:principal:conversation——取末段才与该会话用户回合同队列；其余形态沿用
    // 剥首段的旧行为（W6 串行不变量不给过渡期数据开口）。
    const seg = event.run.sessionId.split(':');
    const queueKey = event.run.deliveryRoute?.conversationId ?? (seg.length === 3 ? seg[2]! : seg.length === 2 ? seg[1]! : event.run.sessionId.slice(event.run.sessionId.indexOf(':') + 1));
    const prev = sessionQueues.get(queueKey) ?? Promise.resolve();
    const task = prev.then(() => processBackgroundTaskEvent(event));
    const queued = task.catch((error: unknown) => {
      console.error(JSON.stringify({
        event: 'background_task_event_failed',
        resultEventId: event.eventId,
        taskId: event.run.taskId,
        runId: event.run.runId,
        error: error instanceof Error ? error.message : String(error),
      }));
    });
    sessionQueues.set(queueKey, queued);
    void queued.finally(() => {
      if (sessionQueues.get(queueKey) === queued) sessionQueues.delete(queueKey);
    });
    return queued;
  };

  const handler = async (message: IncomingChannelMessage, progress?: ProgressFn, notice?: NoticeFn): Promise<ChannelReply> => {
    // 两个键，两种职责（W6 群语义过堂）：
    //   · arrivalKey（发送者 × 会话）：burst 防抖的窗口判据——等的是"同一个人的一批
    //     消息"稳了；群里别人的闲聊不该重置这个窗口，否则忙群的回合被无限拖长。
    //   · queueKey（会话）：回合串行的队列键——W1 起会话状态（转录/附件池/委派账本/
    //     产物库）按聊天窗口共享，群里所有人的回合必须串行；用旧的复合键会让 A、B 的
    //     回合并发写同一份共享状态（竞态：交付集账本、附件池、产物 ref）。
    const arrivalKey = `${message.wecomUserId}:${message.conversationId}`;
    const queueKey = message.conversationId;
    // 首条零防抖（2026-10-16）：到达时刻先记账，再看本条之前的一个窗口内有没有先行消息。
    //   没有先行消息（冷启动）→ 立即处理，用户最快看到受理帧；
    //   有先行消息（burst 进行中）→ 等满窗口，让同一 burst 里稍晚到达的附件先落地——
    //   那些附件走"立即 flush"的路，窗口等的就是它们。
    // 防抖只在"带正文"的消息上生效；附件-only 消息从不等待（落盘+暂存很快，用户要立刻
    // 看到确认）。到达时刻在任何等待之前打点，否则窗口判据会被自己的等待污染。
    const now = Date.now();
    const prevArrival = lastArrivalAt.get(arrivalKey);
    const burstInProgress = prevArrival !== undefined && now - prevArrival < debounceMs;
    lastArrivalAt.set(arrivalKey, now);
    if (!message.attachmentOnly && debounceMs > 0 && burstInProgress) {
      // 等的是 burst 稳了，不是睡满一个窗。乱序投递下第三个文件可能落在指令之后
      // （2026-10-19 实测跨度 3s > 2s 窗），固定窗治不了那种形状：文件到达时防抖
      // 早已睡完，restoreAttachments 也拍完了快照，那一轮拿着不完整的文件集跑完。
      await waitForBurstSettle(lastArrivalAt, arrivalKey, debounceMs, debounceMs * MAX_BURST_SETTLE_WINDOWS);
    }
    const prev = sessionQueues.get(queueKey) ?? Promise.resolve();
    const task = prev.then(() => processMessage(message, progress, notice));
    // Keep a rejection-safe promise in the map (next turn can always start); exact identity kept for cleanup below.
    // 错误必须留痕：`task.catch(() => undefined)` 的语义是"别让一个失败回合毒化队列"，
    // 但它同时会把失败吞得无声无息——2026-10-07 实测有一个附件回合在队列里消失，
    // 没有任何痕迹，而会话队列又串行，后续请求全被它挡住。当时日志已被重启覆盖，
    // 于是连"它是失败了还是根本没跑"都无法判断。所以这里至少打一条。
    const queued = task.catch((error: unknown) => {
      console.error(JSON.stringify({
        event: 'wecom_turn_failed',
        messageId: message.messageId,
        principalId: principalIdOf(message),
        error: error instanceof Error ? error.message : String(error),
      }));
      return undefined;
    });
    sessionQueues.set(queueKey, queued);
    void queued.finally(() => {
      if (sessionQueues.get(queueKey) === queued) sessionQueues.delete(queueKey);
    });
    return task;
  };

  return Object.assign(handler, { enqueueTaskEvent });

  async function processMessage(
    message: IncomingChannelMessage,
    progress?: ProgressFn,
    notice?: NoticeFn,
  ): Promise<ChannelReply> {
    // 身份前缀从消息的 channel 取（缺省 wecom，见 DEFAULT_CHANNEL）：principalId 与
    // sessionId 都要带它，否则两个渠道的审计行会挤在同一套前缀里，接入时就得迁移历史数据。
    //
    // session = 聊天窗口（conversationId），principal = 发这条消息的人。两个身份分开：
    // 群里所有人共享一个 session（转录/附件池/委派账本/产物库都按窗口走），授权、确认门
    // 与审计仍逐消息钉在 principalId 上。单聊时 conversationId 就是 userid，sessionId 与
    // principalId 同形不同义（不同表不同列，不互相推导）。
    const channel = message.channel ?? DEFAULT_CHANNEL;
    const principalId = `${channel}:${message.wecomUserId}`;
    const sessionKey = message.conversationId;
    const sessionId = `${channel}:${sessionKey}`;
    const requestId = newId('req');
    const createdAt = new Date().toISOString();

    // ── 附件-only 消息：只暂存，不启回合 ──────────────────────────────────────
    // 仍要落一条审计（"这一轮用户给了什么"是排查时最缺的证据），但 outcome 区别于 replied，
    // 且不调 LLM。
    //
    // 2026-10-19：正常路径**不再回文本**（返回空串）。企微的流式回复按入站消息的 req_id
    // 走（SDK 的 reply() 只透传 frame.headers.req_id），一条用户消息就是一个气泡，没法
    // 把三个文件的回执并进同一个气泡——于是"3 个文件 + 1 条指令"在会话里是 3 条
    // "已收到 X"加上指令回合那一串帧互相穿插，用户读到的是顺序混乱的刷屏。
    // 收据因此并到**回合**上：带指令的那条进来时，规则二的披露帧（describeDeliveredFiles）
    // 就是合并收据，和进度、终稿同在同一个气泡里。只发文件、迟迟没有指令时，由渠道层
    // 的并窗补一条合并收据（channel-wecom adapter 的 RECEIPT_COALESCE_MS）。
    //
    // 空回复不会让客户端 spinner 永转：适配器对附件-only 消息**不起流**（连秒回 ack 都不发，
    // 见 adapter 的 dispatchMessage），没有流就没有 spinner；本条要么由并窗补一条收据
    // （finish=true 收尾），要么一句话都不说。起没起流是渠道层的决定，与这里返回什么无关。
    //
    // 2026-10-19 晚些时候（乱序到达）：迟到文件**也不再回文本**。企微不保证同批消息按发送
    // 顺序投递，"指令之后才到"是常态而不是异常；而旧那句"上一条指令已经处理完了"在回合还在
    // 飞时就是假的（当时还没有任何判据能区分这两种时序，`seenTextTurn` 又在 runtime 之前
    // 置位）。改成： burst 稳定器先把回合按住等文件落定（见 waitForBurstSettle），真的等到了
    // 触顶还没稳的那些，进暂存池、由渠道并窗补一句中性的"已收到 N 个文件"（2026-10-20 起
    // 不再带"等待你的指令"——气泡本身就是回应，那句把"存个档"误设成待办），并由下一条指令的
    // 回合首帧带上。收据因此永远只有一句措辞（contracts.formatFileReceipt），没有第二份。
    if (message.attachmentOnly && message.attachments && message.attachments.length > 0) {
      // 统一按"保留最新 N 个"：既覆盖会话日积月累挤掉最旧，也覆盖一次就发超过 N 个。
      // 最初分两条路写（先看出能不能装下本轮），结果一批超限时保留了**最先**的 N 个、
      // 丢掉最后发的——与"逐出最旧"自相矛盾，且丢的是最新那份。
      const before = sessionAttachments.get(sessionKey) ?? [];
      // 到达时刻在这里打：规则一靠它分辨"这轮新到的"与"上次委派已交付过的"。
      const arriving: PooledAttachment[] = message.attachments.map((file) => ({ ...file, arrivedAt: arrivalClock.next() }));
      const combined = [...before, ...arriving];
      const kept = combined.slice(-MAX_PENDING_ATTACHMENTS);
      const dropped = combined.slice(0, combined.length - kept.length);
      if (kept.length > 0) sessionAttachments.set(sessionKey, kept);
      const accepted = kept.slice(before.length); // 本轮真正新进来的
      await store.requests.insert({
        requestId, wecomMessageId: message.messageId, principalId,
        input: withAttachmentPaths(message.text, accepted, sessionKey), createdAt, outcome: 'attachment_received',
      });
      // 仍要张嘴的只剩一种："用户不知道的事"——暂存超限丢了文件。迟到文件不再由这里回话：
      // 乱序之下那不是异常，且那一句在回合还在飞时就是假的。收据与下一步由渠道并窗
      // （"已收到 N 个文件：…"，与回合披露同一句）与下一条指令的回合首帧承担。
      // 曾有"请告诉我需要做什么。"——那是噪音：用户当然知道要说话，而且一发 N 个文件就刷
      // N 条同样的话。
      const notes: string[] = [];
      if (dropped.length > 0) notes.push(`另有 ${dropped.length} 个超出暂存上限（${MAX_PENDING_ATTACHMENTS} 个）未收：${dropped.map((f) => f.filename).join('、')}`);
      if (notes.length === 0) return '';
      return notes.join('；');
    }

    // 本轮交付集（规则一）：自上次委派开始以来新到达的附件；没有新到来的才沿用上次交付的
    // 那批（纠正/重试流）。池子本身不清空，见 sessionAttachments / sessionDelegations 注释。
    // 另外并入 DB 里 Recent 的附件接收行——内存关联会随服务重启失记（2026-10-07 实测：
    // 连重启三次后，用户早先上传的文件还在盘上，但请求里一个路径都没有，worker 只能回
    // "没有数据"）。落库数据因此不只是审计，也是重启后的恢复源。
    // `attachmentsAreNew` 与交付集同源：它决定收据帧播不播（见 announceDeliveredFiles）。
    const { delivered: attachments, fresh: attachmentsAreNew } = await restoreAttachments(
      sessionKey, message, store, sessionAttachments, sessionDelegations.get(sessionKey), arrivalClock,
    );

    // 产物清单（W2）与附件路径同族：都是宿主把确定性事实注入模型输入。清单让模型
    // 每回合都看得见"本会话交付过什么"——重发请求因此有确定答案，不需要凭散文记忆。
    const input = appendArtifactManifest(
      withAttachmentPaths(message.text, attachments),
      await loadArtifactManifest(store, sessionId),
    );
    const base = { requestId, wecomMessageId: message.messageId, principalId, input, createdAt };

    const scope = await store.principalScopes.get(message.wecomUserId);
    if (!scope || !scope.enabled) {
      await store.requests.insert({ ...base, outcome: 'denied' });
      return `该账号(${principalId})未开通查询权限,请联系管理员开通。`;
    }
    await store.requests.insert({ ...base, outcome: 'replied' });

    // ── 首帧提速：受理即帧 + 一次性心跳（2026-10-16）─────────────────────────
    // 受理帧的发射点在两个 runtime.handleTurn 调用点之前，而不是 processMessage 开头：
    // 授权拒绝、确认状态机（取代/取消/过期/歧义）这些路都是毫秒级确定性回复，不需要帧；
    // 只有真的要进 runtime 的回合才发。progress 缺席（单测直调）时整段退化为无操作。
    // heartbeatTimer 声明在 try 之外——finally 要清它，声明进 try 就成了 try 块局部量。
    //
    // 2026-10-19：附件回合不再另发受理帧——规则二的披露帧（"已收到 N 个文件：…"）本身就是
    // "回合开跑了"的证据，且它先说。两帧挨着冒出近义文案，用户看到的是抖动不是信息。
    // 心跳因此不能再锚"受理帧之后"（那一条在附件回合根本不存在），改锚**帧流量**：
    // 布防之后一帧都没再流过，才补心跳。
    let framesEmitted = 0;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    const emitProgress = (text: string): void => {
      framesEmitted += 1;
      progress?.(text);
    };
    let acceptedAnnounced = false;
    /** 披露帧是否已经代替受理帧上屏（附件回合）。见 announceDeliveredFiles。 */
    let receiptAnnounced = false;
    const announceAccepted = (): void => {
      if (!progress || acceptedAnnounced) return;
      acceptedAnnounced = true;
      if (!receiptAnnounced) emitProgress(TURN_ACCEPTED_TEXT);
      if (turnHeartbeatMs <= 0) return;
      // 心跳只守"布防之后一片静默"的盲段：会话轮的第一轮 LLM 常要 10–20s，这帧填掉它。
      // 真实帧已在流动（或披露走了 notice 通道）时静默——用户不再盲等，多一帧只是噪音，
      // 还占渠道的进度硬顶。
      const armedAt = framesEmitted;
      heartbeatTimer = setTimeout(() => {
        if (framesEmitted === armedAt) emitProgress(TURN_STILL_WORKING_TEXT);
      }, turnHeartbeatMs);
    };

    try {
      // 本轮委派开始时刻：产物回传按它划界（collectProducedFiles 的 since）。
      //
      // 为什么不用 createdAt：那一刻还在队列里等防抖、等上一回合跑完，本轮 worker 一个文件
      // 都还没写；拿它当界会把**上一轮**落在 tmp/ 里的产物也算成本轮的，于是同一份文件被
      // 反复回传。而反过来，委派前一刻记的界又能覆盖整个 worker 执行期（含平台执行器在占用
      // 时改走 fallback 分支、晚一步才落盘的那份）——worker 无法预知分支，宿主也不必预知。
      const delegatedAt = new Date().toISOString();
      // 回合出口：把本轮产物挂到回复上回传用户。收集范围 = tmp/ 顶层 + **本会话**任务
      // 工作区里本轮新落盘的办公文档（worker 的 write 门只放行工作区，域执行器的输出
      // 输出位置由 worker 传参决定，交付物因此落在那里——2026-10-19 事故形状）。收到时落
      // 一条事件：回传成败必须可观测，那场事故最贵的成本就是全程零日志、零错误事件，
      // 只能靠人肉翻 tmp/ 才定位到"文件写了、没人收"。
      // 产物机器的完整收口在 artifact-store.ts（W2 抽取）：列任务 → 收集 → 入库 →
      // ref 改写 → 回挂。handler 只提供回合上下文，产物逻辑不再堆在主链路上。
      // W4：artifactRefs 是重发路由的产物 ref（runtime 零委派回合交回）——宿主依
      // 会话产物库解析成文件回挂，并合成确定性文本。
      const finishWithFiles = async (text: string, artifactRefs?: readonly string[]): Promise<ChannelReply> =>
        finalizeWithArtifacts({
          text,
          store,
          principalId,
          sessionId,
          requestId,
          ...(deps.platformRoot ? { platformRoot: deps.platformRoot } : {}),
          ...(deps.dataRoot ? { dataRoot: deps.dataRoot } : {}),
          delegatedAt,
          ...(deps.workerDispatchMode === 'background' ? { collectProduced: false } : {}),
          ...(artifactRefs && artifactRefs.length > 0 ? { artifactRefs } : {}),
        });
      let noticeSequence = 0;
      const onNotice: NoticeFn | undefined = notice ? async (text) => {
        await notice(text);
        // 送达成功才算一帧流过：心跳守的是"用户不再盲等"，通知没送到时用户仍在盲等，
        // 那一帧不能算数（宁可多补一帧，不可让用户对着静默的会话）。
        framesEmitted += 1;
        try {
          await store.conversationLog?.append({
            eventId: `${requestId}:plan_notice:${++noticeSequence}`,
            principalId,
            sessionId,
            kind: 'plan_event',
            content: redactNotice(text),
            createdAt: new Date().toISOString(),
            requestId,
          });
        } catch (error) {
          console.warn(JSON.stringify({ event: 'plan_notice_log_failed', requestId, error: error instanceof Error ? error.message : String(error) }));
        }
      } : undefined;
      // 规则一的账本在这里落：本次委派从这一刻开始。晚于它到达的附件属于下一轮，
      // 早于它的一律视为"已经交付过"——同日多任务因此不会把上一个任务的文件带进来。
      //
      // 界也从到达钟取而不是 Date.now()：它必须严格大于本回合之前打上的
      // 所有到达时刻，否则同一毫秒里到达的文件会被误判成"上次已交付"而静默丢掉
      // （2026-10-09 实测：附件到达与委派开始同在 982ms，`>` 比分不出先后）。
      // 与 delegatedAt（产物回传的 since）标的是同一时刻，只是各用各的尺子——那边比
      // tmp/ 里文件的 mtime，这边比附件到达时刻；两把尺子不能互换，也不必互换。
      sessionDelegations.set(sessionKey, {
        lastDelegationStartedAt: arrivalClock.next(),
        lastDelegationDelivered: attachments,
      });
      // 规则二：把"本轮用了哪些文件"说给用户听。
      //
      // 为什么这一条和规则一同样重要：规则一的假设可能错（用户以为文件跟着"这个对话"走，
      // 我们按"跟着这次任务"算）。假设错误时，用户在几秒内看到清单就能纠正；不说，就要
      // 等 10 分钟后拿到一份安静算错的结果——那时连"它读的是哪个文件"都难以复盘。
      //
      // 措辞纪律：短、只说事实、只列文件名不列路径（见 describeDeliveredFiles）。
      //
      // 2026-10-19 起它同时是**附件回合的收据**（附件-only 消息自己不再回气泡，见上方
      // attachmentOnly 分支），因此"这一帧上过屏"要记下来：announceAccepted 据此跳过
      // 受理帧——披露帧本身就是"回合开跑了"的证据，且它先说。
      //
      // 2026-10-20：只在本轮**真有新到达**的附件时才播（attachmentsAreNew）。沿用上次
      // 交付集的回合（纠正/重试流）安静交付：那批文件的收据早在到达那一轮播过，每句后续
      // 指令都复读一遍旧清单，用户看到的就是"不管发什么都在说收到附件"。
      const announceDeliveredFiles = async (): Promise<void> => {
        if (!attachmentsAreNew) return;                        // 沿用旧集：无可披露
        const text = describeDeliveredFiles(attachments);
        if (!text) return;                                   // 本轮没有附件：无可披露
        try {
          // notice 优先：它被 await、不被渠道节流，且与计划通知走同一条审计轨迹
          // （契约里没有单独的事件种类，可检索历史因此仍是一处）。
          // 没有 notice 时才退到 progress：进度帧有最小间隔与帧数硬顶，可能被丢掉，
          // 但总比完全不披露好。（两条路都经计数——披露已上屏，心跳就该静默。）
          if (onNotice) await onNotice(text);
          else if (progress) emitProgress(text);
          else return;                                       // 两个通道都没有：无从告知
          receiptAnnounced = true;
        } catch (error) {
          // 披露是增强，不是门：送达失败不能让这一轮失败（与计划通知的授权语义不同——
          // 那个必须送达后才激活，这个只是让假设可见）。
          console.warn(JSON.stringify({
            event: 'attachment_scope_notice_failed',
            requestId,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      };
      await announceDeliveredFiles();
      const trusted = {
        requestId,
        principalId,
        // 实体授权归执行层（⑥）：宿主不再向运行时传业务实体名单——TrustedContext 已无该
        // 字段，principal_scopes 的实体列保留不读。
        capabilities: scope.capabilities,
        sessionId,
        inputFiles: attachments.map(({ filename, path: filePath, bytes }) => ({ filename, path: filePath, bytes })),
        deliveryRoute: { channel, conversationId: message.conversationId },
        ...(deps.pushToConversation ? {
          onBackgroundNotice: createBackgroundNoticeSender({
            store,
            route: { channel, conversationId: message.conversationId },
            requestId,
            principalId,
            sessionId,
            pushToConversation: deps.pushToConversation,
          }),
        } : {}),
        // 帧计数经 emitProgress：runtime 的「正在…」帧算真实帧流动，心跳据此静默
        onStep: progress ? emitProgress : undefined,
        ...(onNotice ? { onNotice } : {}),
        ...(deps.planConfirmation?.savePending ? { onPlanPending: deps.planConfirmation.savePending } : {}),
      };
      if (deps.planConfirmation) {
        const confirmation = await deps.planConfirmation.handle({
          origin: 'wecom_user', messageId: message.messageId, principalId, sessionId,
          text: message.text, receivedAt: message.receivedAt,
        });
        if (confirmation.status === 'activated') {
          if (!confirmation.taskId) throw new Error('已确认的计划缺少原任务标识。');
          announceAccepted();
          const resumed = await runtime.handleTurn(
            { ...trusted, resumeTaskId: confirmation.taskId },
            input,
            message.messageReference ? { messageReference: message.messageReference } : undefined,
          );
          return finishWithFiles(resumed.text);
        }
        if (confirmation.status === 'superseded') return '这项扩大查询已经被更新的计划取代，之前的确认不再有效。请重新发起查询，我会按新的范围再问你一次。';
        if (confirmation.status === 'cancelled') return '已取消本次扩大查询。';
        if (confirmation.status === 'ambiguous') return '当前有多个待确认查询，请先说明要继续哪一个。';
        if (confirmation.status === 'expired') return '这项查询确认已过期，请重新发起查询。';
      }
      // 受理帧：进 runtime 前的最后一刻发——此刻授权已过、交付集已定，回合必然开始
      // 长时间运行（第一轮 LLM 10–20s 起）。更早的位置会让"很快返回"的确定性回复
      //（未授权拒绝、确认状态机的取代/取消/过期/歧义）也背上无用的一帧。
      announceAccepted();
      const reply = await runtime.handleTurn(
        trusted,
        input,
        message.messageReference ? { messageReference: message.messageReference } : undefined,
      );
      return finishWithFiles(reply.text, reply.artifactRefs);
    } catch (error) {
      await store.requests.setOutcome(requestId, 'failed');
      console.error(JSON.stringify({
        event: 'turn_failed',
        requestId,
        error: error instanceof Error ? error.message : String(error),
      }));
      return '处理失败,请稍后再试。';
    } finally {
      // 心跳定时器随回合终结：不清理会挂在事件循环上，把进程退出/测试收尾拖住
      if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
    }
  }
}

/**
 * 把附件路径拼进请求文本——**这是附件链路的最后一环**。
 *
 * 渠道层只把附件落盘并给出路径；路径若不出现在请求文本里，worker 就看不见它，
 * 于是"用户发了 3 个 Excel"和"用户什么都没发"对下游完全等价。 * 2026-10-07 之前正是如此：契约里没有附件概念，`[File: xxx.xlsx]` 只是渠道渲染的
 * 占位符，没有任何组件去下载它。
 *
 * 为什么放在宿主而不是渠道：渠道层只负责"拿到文件"，"worker 该看到什么形状的请求"
 * 是宿主策略（换任何渠道、任何执行层都该由宿主统一决定），不放适配器里。
 *
 * 审计含义：`input` 因此带上绝对路径——请求审计里能查到"这一轮到底用了哪个文件"，
 * 这正是当初排查"工资表为什么没出来"时最缺的那条证据。
 */
/** 把可写位置声明拼进请求文本（纯函数，便于单测；调用处见 processMessage）。 */
export function withScratchDir(text: string, scratchDir: string): string {
  return `${text}\n\n[本轮的可写位置：${scratchDir} —— 中间产物（契约、mapping、临时脚本）只写这里，别的路径不可写]`;
}

/**
 * 附件信封标记：一行 JSON，供宿主人群重建"这个会话有哪些附件"。
 *
 * 为什么需要：附件关联原本只在进程内存里，服务一重启就失记——2026-10-07 实测连重启三次
 * 之后，用户早先上传的文件仍在盘上，但 worker 拿到的请求里一个路径都没有，于是它如实回
 * "没有数据"，而用户完全无法理解（他明明传过）。附件接收行本来就落库（outcome=
 * attachment_received），只是 input 是自由文本、不好可靠解析；加一行信封即可机械取回。
 *
 * 放在这一行而不是别处：人类可读（就是路径清单）、模型无歧义（单行 JSON）、解析零启发式。
 */
const ATTACHMENT_ENVELOPE = '<!--attachments:';

/**
 * 从请求文本取回附件信封（重启恢复用）。
 *
 * **会话隔离在这里，不是可选项**：信封必须带 `sessionKey` 且与当前会话一致才恢复。
 * 2026-10-07 第一版只按用户维度恢复（`agent_requests` 也没有 session 列），于是同一个人
 * 在单聊里传的工资表，会出现在他后续在群里发的请求里——代账会计服务多家客户时，那就是把
 * 甲客户的文件递给处理乙请求的 worker。没有 sessionKey 的旧信封一律不恢复：宁可少恢复，
 * 也不能跨会话递文件。
 */
export function parseAttachmentEnvelope(text: string, sessionKey?: string): IncomingAttachment[] {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(ATTACHMENT_ENVELOPE) || !trimmed.endsWith('-->')) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(ATTACHMENT_ENVELOPE.length, -3)) as { sessionKey?: unknown; files?: unknown };
      if (!sessionKey || typeof parsed.sessionKey !== 'string' || parsed.sessionKey !== sessionKey) return [];
      const files = parsed.files;
      if (!files || typeof files !== 'object') return [];
      return Object.entries(files as Record<string, unknown>)
        .filter(([, filePath]) => typeof filePath === 'string' && filePath.startsWith('/'))
        .map(([filename, filePath]) => ({ filename, path: filePath as string, bytes: 0 }));
    } catch {
      return [];
    }
  }
  return [];
}

export function withAttachmentPaths(text: string, attachments?: readonly IncomingAttachment[], sessionKey?: string): string {
  if (!attachments || attachments.length === 0) return text;
  const lines = attachments.map((file) => `- ${file.filename}：${file.path}`);
  const envelope = `${ATTACHMENT_ENVELOPE}${JSON.stringify({
    sessionKey: sessionKey ?? null,
    files: Object.fromEntries(attachments.map((f) => [f.filename, f.path])),
  })}-->`;
  return `${text}\n\n${ATTACHMENT_PATHS_MARKER}，可按路径直接使用]\n${lines.join('\n')}\n${envelope}`;
}

/**
 * 本轮可写位置（每请求一个，随机源用 requestId）。
 *
 * 为什么必须是每请求一个而不是共享 tmp/：多个会话同时写 `tmp/contract.json` 会互相覆盖，
 * 而覆盖后的产物看不出被谁污染。宿主已有随机源（requestId），派生子位置即可——worker 自己
 * 没有随机手段，也不该由它编名字（编了还是会撞）。
 *
 * 这不是"告诉它一个约定"，是配套 serve-gate 的机械边界：门只放行 `tmp/<requestId>/`，
 * 所以这句话同时是**唯一可写的位置声明**。缺了它，worker 只能猜，猜错就被门拒。
 */
