/**
 * 企微 × dummy 自动联调夹具（eval 侧；产品码零改动、零网络、零真实凭据）。
 *
 * 装配链（复用既有面，不另起装配——P0-T03 单一装配点守卫见 scripts/p0-assembly-single-point.test.ts）：
 *   · 真渠道适配：`WecomBotChannel`（packages/channel-wecom）+ `startChannelForMode('live')`，
 *     与 apps/server/main.ts 同形（fileDelivery 端口接 sendToConversation/sendText）；
 *   · 真 server：`apps/server/server.ts` 的 `createServer`（与 `npm start` 同一装配），
 *     **不注入 createExecutionFace**——缺省走装配链缺省 = 仓内 dummy CLI 真子进程
 *     （scripts/ask-runtime.ts 的 resolveExecutionFace 缺省分支）；
 *   · 假企微 SDK：`FakeWecomSdk implements SdkClientLike`（只记录、不发帧、不触网；
 *     downloadFile 从预置表取字节，绝不读真实素材）；WECOM_BOT_ID/SECRET 是夹具假值，
 *     进程 env 里的 WECOM_*（含 .env 加载的）一律不进装配 env；
 *   · 模型：真实 Pi 驱动（createPiTurnDriver）× 脚本化 provider（createScriptedModelRuntime，
 *     复用 business-e2e/shared-instance 的消息构造）——驱动链路真实、模型响应脚本化，
 *     脚本回复由**执行层真实返回**派生（dummy CLI 的信封 / run_js 的真实 stdout），
 *     断言面是用户可见结果：气泡文本、投递 receipt、message_done 执行事实。
 *
 * 时钟纪律：30s 主动追问经 `attachmentNudgeClock` 注入 ManualClock（不真 sleep）；
 * 渠道侧并窗（合并 3s / 回执 2s）是适配器真实定时器（无注入缝，见用例文件头说明），
 * 用例用事件驱动的 `waitFor` 等它到点，不写固定 sleep。
 *
 * W-04b 的系统注记 / 文件清单注入面：脚本可用 `book.requestMessagesOf` 读模型请求的
 * messages（injections 按 user 角色投影，见 pi-driver 的 sendCustomMessage）——
 * 这是驱动契约的入参（非私有字段），与 apps/server/server-attachment-nudge.test.ts 同面。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AppConfig } from '@fshine/contracts';
import { WecomBotChannel, type SdkClientLike } from '@fshine/channel-wecom';
import type { TurnDriver } from '../../../packages/agent/src/driver-contract';
import { createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import { createScriptedModelRuntime } from '../../../packages/agent/testing/scripted-model-runtime';
import { startChannelForMode } from '../../../apps/server/channel-mode';
import { createServer, type FileDeliveryPort, type Server } from '../../../apps/server/server';
import type { NudgeClock } from '../../../apps/server/attachment-nudge';
import { textAssistant, toolCallAssistant } from '../business-e2e/shared-instance';

/** 夹具复用的仓内 dummy 执行层根（与 apps/server 测试同一份真值来源）。 */
const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');

const DEFAULT_USER_ID = 'user-a';
const DEFAULT_CONVERSATION_ID = 'conv-w';
/** 追问延迟（用例引用同一常量，避免复制数字漂移）。 */
export const NUDGE_AFTER_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// 假企微 SDK：实现适配器用到的全部出站/下载面，只记录不触网
// ─────────────────────────────────────────────────────────────────────────────

/** 一次流式回复帧（用户可见气泡；finish=true = 终帧）。 */
export interface BubbleRecord {
  readonly kind: 'replyStream';
  readonly reqId: string;
  readonly streamId: string;
  readonly content: string;
  readonly finish: boolean;
}

/** 主动文字消息（aibot_send_msg 通道；追问走这里）。 */
export interface ProactiveTextRecord {
  readonly kind: 'sendMessage';
  readonly chatId: string;
  readonly content: string;
}

/** 媒体回传/主动投递（文件与图片）。 */
export interface MediaRecord {
  readonly kind: 'replyMedia' | 'sendMediaMessage';
  readonly chatId?: string;
  readonly mediaType: 'image' | 'file';
  readonly mediaId: string;
}

/** 一次素材上传（含真实字节，供断言「发出去的东西内容对得上」）。 */
export interface UploadRecord {
  readonly filename: string;
  readonly data: Buffer;
  readonly mediaId: string;
}

interface SdkFrame {
  headers?: { req_id?: string };
  body?: Record<string, unknown>;
}

/**
 * 假企微 SDK（SdkClientLike 全量替身）：replyStream/sendMessage/uploadMedia/
 * replyMedia/sendMediaMessage/downloadFile + on/connect/disconnect。
 * 下载只认 `stageFile` 预置的 url 表；没有触网路径，也没有任何真实凭据可读。
 */
export class FakeWecomSdk implements SdkClientLike {
  readonly bubbles: BubbleRecord[] = [];
  readonly proactiveTexts: ProactiveTextRecord[] = [];
  readonly media: MediaRecord[] = [];
  readonly uploads: UploadRecord[] = [];
  connected = 0;
  disconnected = 0;
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();
  private readonly staged = new Map<string, { filename: string; buffer: Buffer }>();
  private uploadSeq = 0;

  on(event: string, listener: (...args: never[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (...args: unknown[]) => void)(...args);
  }

  connect(): unknown {
    this.connected += 1;
    return this;
  }

  /** ask 名单里的 start/stop：长连接替身的同义入口（与 connect/disconnect 同记账）。 */
  start(): void {
    void this.connect();
  }

  stop(): void {
    this.disconnect();
  }

  disconnect(): void {
    this.disconnected += 1;
  }

  replyStream(frame: SdkFrame, streamId: string, content: string, finish: boolean): Promise<unknown> {
    this.bubbles.push({
      kind: 'replyStream',
      reqId: typeof frame.headers?.req_id === 'string' ? frame.headers.req_id : '',
      streamId,
      content,
      finish,
    });
    return Promise.resolve({});
  }

  sendMessage(chatid: string, body: { msgtype: 'markdown'; markdown: { content: string } }): Promise<unknown> {
    this.proactiveTexts.push({ kind: 'sendMessage', chatId: chatid, content: body.markdown.content });
    return Promise.resolve({});
  }

  uploadMedia(data: Buffer, options: { type: 'image' | 'file'; filename: string }): Promise<{ media_id: string }> {
    this.uploadSeq += 1;
    const mediaId = `sim-media-${this.uploadSeq}`;
    this.uploads.push({ filename: options.filename, data: Buffer.from(data), mediaId });
    return Promise.resolve({ media_id: mediaId });
  }

  replyMedia(frame: SdkFrame, mediaType: 'image' | 'file', mediaId: string): Promise<unknown> {
    void frame;
    this.media.push({ kind: 'replyMedia', mediaType, mediaId });
    return Promise.resolve({});
  }

  sendMediaMessage(chatid: string, mediaType: 'file', mediaId: string): Promise<unknown> {
    this.media.push({ kind: 'sendMediaMessage', chatId: chatid, mediaType, mediaId });
    return Promise.resolve({});
  }

  /** 预置一条可下载素材（url → 字节）；downloadFile 只认这张表。 */
  stageFile(url: string, filename: string, buffer: Buffer): void {
    this.staged.set(url, { filename, buffer });
  }

  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }> {
    void aesKey;
    const hit = this.staged.get(url);
    if (hit === undefined) {
      return Promise.reject(new Error(`（假 SDK）未预置的下载地址：${url}`));
    }
    return Promise.resolve({ buffer: Buffer.from(hit.buffer), filename: hit.filename });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 可控时钟（30s 追问的注入缝；与 apps/server/server-attachment-nudge.test.ts 同形）
// ─────────────────────────────────────────────────────────────────────────────

export class ManualClock implements NudgeClock {
  private current = Date.UTC(2026, 10, 18, 9, 0, 0);
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; run: () => void | Promise<void> }>();

  now = (): number => this.current;

  schedule = (run: () => void | Promise<void>, delayMs: number): unknown => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.current + delayMs, run });
    return id;
  };

  cancel = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  pending(): number {
    return this.timers.size;
  }

  /** 诊断面（用例失败排查用）：当前时间与未触发定时器的绝对到期时刻。 */
  debugTimers(): { current: number; at: number[] } {
    return { current: this.current, at: [...this.timers.values()].map((timer) => timer.at) };
  }

  /** 只推进注入时间并执行到期回调（回调可 await），不碰真实时间。 */
  async advance(ms: number): Promise<void> {
    if (!Number.isFinite(ms)) {
      throw new Error(`ManualClock.advance 收到非有限时长：${String(ms)}`);
    }
    const target = this.current + ms;
    while (true) {
      let due: [number, { at: number; run: () => void | Promise<void> }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at <= target && (due === undefined || entry[1].at < due[1].at)) due = entry;
      }
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.current = due[1].at;
      await due[1].run();
    }
    this.current = target;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 脚本表（p2-harness 的 P2ScriptBook 同形瘦身版：Main 按用户原文、Worker 按委派片段）
// ─────────────────────────────────────────────────────────────────────────────

export interface SimScriptCall {
  readonly driver: 'main' | 'worker';
  readonly callIndex: number;
  readonly messages: readonly unknown[];
  readonly text: string;
}

export type SimResponse = AgentMessage | ((call: SimScriptCall) => AgentMessage);

interface SimEntry {
  readonly responses: readonly SimResponse[];
}

export class SimScriptBook {
  private readonly main = new Map<string, SimEntry>();
  private readonly worker = new Map<string, SimEntry>();
  private readonly counters = new Map<string, number>();
  /** 每个键最近一次模型请求的完整 messages（读 injections 投影 / 派生回复用）。 */
  readonly requestMessages = new Map<string, readonly unknown[]>();

  mainTurn(text: string, responses: readonly SimResponse[]): this {
    this.main.set(text, { responses });
    return this;
  }

  workerTask(taskFragment: string, responses: readonly SimResponse[]): this {
    this.worker.set(taskFragment, { responses });
    return this;
  }

  respond(driver: 'main' | 'worker', context: unknown): AgentMessage {
    const messages = ((context as { messages?: readonly unknown[] } | undefined)?.messages ?? []) as readonly unknown[];
    const text = lastUserTextOf(messages);
    // 完成唤醒回合（宿主完成事实触发；2026-11-19 唤醒切片）：显式脚本优先；未显式脚本时按
    // 新形状脚本化——模型把事实里的结果正文原样说给用户（产品形状：宿主只喂事实 + 投递模型
    // 说的话；用户可见内容仍由用例断言钉住，宿主不再拼完成文案）。
    if (driver === 'main' && text.startsWith(COMPLETION_FACT_PREFIX) && !this.main.has(text)) {
      this.requestMessages.set(`main\u0000${text}`, messages);
      const body = completionResultBodyOf(text);
      if (body === undefined) {
        throw new Error(`完成事实形状不符（缺结果正文段）：${JSON.stringify(text.slice(0, 160))}`);
      }
      return textAssistant(body);
    }
    // 其余状态变化唤醒回合（失败 / 已停止 / 重启对账 / 久无动静；2026-11-19 唤醒切片）：
    // 显式脚本优先；未显式脚本时按同一产品形状脚本化——假模型按事实说一句人话（台词唯一
    // 来源见 simWakeLine，用例断言用同一函数，不硬编）。
    if (
      driver === 'main'
      && (text.startsWith(FAILURE_FACT_PREFIX)
        || text.startsWith(CANCELLED_FACT_PREFIX)
        || text.startsWith(RESTART_FACT_PREFIX)
        || text.startsWith(LONG_RUNNING_FACT_PREFIX))
      && !this.main.has(text)
    ) {
      this.requestMessages.set(`main\u0000${text}`, messages);
      return textAssistant(simWakeLine(text));
    }
    const { key, entry } = this.resolve(driver, text);
    this.requestMessages.set(`${driver}\u0000${key}`, messages);
    const counterKey = `${driver}\u0000${key}`;
    const callIndex = this.counters.get(counterKey) ?? 0;
    this.counters.set(counterKey, callIndex + 1);
    const slot = entry.responses[callIndex];
    if (slot === undefined) {
      throw new Error(`脚本响应耗尽（${driver} / ${JSON.stringify(key.slice(0, 80))} / 第 ${callIndex + 1} 次调用）`);
    }
    return typeof slot === 'function' ? slot({ driver, callIndex, messages, text }) : slot;
  }

  /** 读某键最近一次模型请求的 messages（W-18 的系统注记接线检查用）。 */
  requestMessagesOf(driver: 'main' | 'worker', key: string): readonly unknown[] | undefined {
    return this.requestMessages.get(`${driver}\u0000${key}`);
  }

  private resolve(driver: 'main' | 'worker', text: string): { key: string; entry: SimEntry } {
    if (driver === 'main') {
      const entry = this.main.get(text);
      if (entry === undefined) throw new Error(`脚本缺失 Main 回合：${JSON.stringify(text.slice(0, 120))}`);
      return { key: text, entry };
    }
    let best: string | undefined;
    for (const key of this.worker.keys()) {
      if (text.includes(key) && (best === undefined || key.length > best.length)) best = key;
    }
    if (best === undefined) throw new Error(`脚本缺失 Worker 任务：${JSON.stringify(text.slice(0, 160))}`);
    return { key: best, entry: this.worker.get(best)! };
  }
}

/** 从模型请求 messages 里取最后一条 user 文本（injections 先投影、真实 prompt 最后）。 */
function lastUserTextOf(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part;
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        })
        .join('\n');
    }
  }
  return '';
}

/** 完成事实前缀与结果正文段标记（与 apps/server/task-completion-delivery.ts 的拼装同源）。 */
export const COMPLETION_FACT_PREFIX = '[任务完成]';
const COMPLETION_RESULT_MARKER = '结果正文（逐字）：';
const COMPLETION_TAIL_MARKER = '。请把这件事告诉用户。';

/** 从完成事实里取逐字结果正文；形状不符返回 undefined（脚本立刻暴露事实形状漂移）。 */
export function completionResultBodyOf(factText: string): string | undefined {
  const start = factText.indexOf(COMPLETION_RESULT_MARKER);
  if (start === -1) return undefined;
  const rest = factText.slice(start + COMPLETION_RESULT_MARKER.length);
  const end = rest.lastIndexOf(COMPLETION_TAIL_MARKER);
  if (end === -1) return undefined;
  return rest.slice(0, end);
}

/**
 * 状态变化事实前缀（与宿主拼装同源；2026-11-19 唤醒切片四出口）：
 * 失败（task-completion-delivery 的 taskFailureFactText）/ 已停止（taskCancelledFactText）/
 * 重启对账（taskRestartFactText）/ 久无动静（task-runner 的 longRunningNoticeFactText）。
 */
export const FAILURE_FACT_PREFIX = '[任务失败]';
export const CANCELLED_FACT_PREFIX = '[已停止]';
export const RESTART_FACT_PREFIX = '[重启对账]';
export const LONG_RUNNING_FACT_PREFIX = '[久无动静]';

/** 事实里的业务名（「<名>」；中性指代 = undefined）。 */
export function factSubjectOf(factText: string): string | undefined {
  const hit = /「([^」]+)」/.exec(factText);
  return hit?.[1];
}

/**
 * 假模型在状态变化唤醒回合说的那几句（**产品形状**：宿主只喂事实，用户看到的话由模型写）。
 * 用例要断言「投递的就是模型说的那句」时 import 这里的唯一来源，不各自硬编。
 */
export function longRunningWakeLine(name?: string): string {
  return `${lineSubjectOf(name)}比预计久了。要我停下来，还是继续等？`;
}

export function failureWakeLine(name?: string): string {
  return `${lineSubjectOf(name)}这次没办成。要我再试一次，还是先放着？`;
}

export function cancelledWakeLine(name?: string): string {
  return `${lineSubjectOf(name)}已经停了。`;
}

export function restartWakeLine(name?: string): string {
  return `${lineSubjectOf(name)}我这边重启过，它的状态说不清了；你说一声我就重来一遍。`;
}

/** 假模型台词的主语（业务名缺省 / 空 = 中性指代，与宿主事实拼装同口径）。 */
function lineSubjectOf(name?: string): string {
  return name === undefined || name.trim() === '' ? '你交代的那件事' : `「${name}」`;
}

/** 按事实前缀派发到上面那位台词（respond 用；未知前缀立刻抛，脚本不静默）。 */
export function simWakeLine(factText: string): string {
  const name = factSubjectOf(factText);
  if (factText.startsWith(FAILURE_FACT_PREFIX)) return failureWakeLine(name);
  if (factText.startsWith(CANCELLED_FACT_PREFIX)) return cancelledWakeLine(name);
  if (factText.startsWith(RESTART_FACT_PREFIX)) return restartWakeLine(name);
  if (factText.startsWith(LONG_RUNNING_FACT_PREFIX)) return longRunningWakeLine(name);
  throw new Error(`未知的状态变化事实（脚本没有对应台词）：${JSON.stringify(factText.slice(0, 120))}`);
}

/** 最后一条工具结果（执行层真实返回 / run_js 真实出口 / 宿主拒绝话术）。 */
export function lastToolResultOf(messages: readonly unknown[]): { text: string; isError: boolean } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown; isError?: unknown } | undefined;
    if (message?.role !== 'toolResult') continue;
    const text = textOfContent(message.content);
    return { text, isError: message.isError === true };
  }
  return undefined;
}

/** 消息 content 的文本抽取（string / TextContent 块数组两种形状都收）。 */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .join('\n');
  }
  return '';
}

/** 模型请求 messages 的全量文本投影（injections 检查用；只读诊断面，不作断言主体）。 */
export function messagesTextOf(messages: readonly unknown[] | undefined): string {
  if (messages === undefined) return '';
  return messages
    .map((message) => {
      const record = message as { role?: unknown; content?: unknown };
      return textOfContent(record.content);
    })
    .join('\n');
}

/** 最后一条工具结果的 JSON（解析失败 = undefined，让脚本立即暴露形状漂移）。 */
export function lastToolResultJsonOf(messages: readonly unknown[]): Record<string, unknown> | undefined {
  const result = lastToolResultOf(messages);
  if (result === undefined) return undefined;
  try {
    return JSON.parse(result.text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 从会话 messages 里提取文件清单注入的 fileId（run_js inputs 只收 fileId）。 */
export function manifestFileIdsOf(messages: readonly unknown[]): string[] {
  const found = new Set<string>();
  for (const message of messages) {
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== 'user') continue;
    const text = textOfContent(record.content);
    for (const match of text.matchAll(/fileId[=:]\s*(file_[A-Za-z0-9]+)/g)) {
      found.add(match[1]!);
    }
  }
  return [...found];
}

// ─────────────────────────────────────────────────────────────────────────────
// 入站帧构造（假 SDK 的 emit 载荷；msgid 自动编号保证幂等键唯一）
// ─────────────────────────────────────────────────────────────────────────────

export interface FrameOptions {
  readonly chatType?: 'single' | 'group';
  readonly conversationId?: string;
  readonly userId?: string;
}

interface Frame {
  headers: { req_id: string };
  body: Record<string, unknown>;
}

function frameBase(reqId: string, messageId: string, options: FrameOptions): Record<string, unknown> {
  const chatType = options.chatType ?? 'single';
  const body: Record<string, unknown> = {
    msgid: messageId,
    aibotid: 'wecom-sim-bot',
    chattype: chatType,
    from: { userid: options.userId ?? DEFAULT_USER_ID },
  };
  if (chatType === 'group') {
    body['chatid'] = options.conversationId ?? 'group-w';
  }
  return body;
}

export function textFrame(reqId: string, messageId: string, content: string, options: FrameOptions = {}): Frame {
  const body = frameBase(reqId, messageId, options);
  body['msgtype'] = 'text';
  body['text'] = { content };
  return { headers: { req_id: reqId }, body };
}

export function fileFrame(reqId: string, messageId: string, url: string, options: FrameOptions = {}): Frame {
  const body = frameBase(reqId, messageId, options);
  body['msgtype'] = 'file';
  body['file'] = { url, aeskey: 'sim-aes-key' };
  return { headers: { req_id: reqId }, body };
}

// ─────────────────────────────────────────────────────────────────────────────
// 装配与会话面
// ─────────────────────────────────────────────────────────────────────────────

export interface WecomSimOptions {
  /** 渠道合并窗口（毫秒）。缺省 = 产品值；反向绊线传 0（立即 flush，逐条交付）。 */
  readonly mergeWindowMs?: number;
  /** 30s 追问延迟。缺省 30_000。 */
  readonly nudgeAfterMs?: number;
  /** 写面开关（runtime.allowWriteOperations）。缺省 false = 只读。 */
  readonly allowWriteOperations?: boolean;
  /**
   * 任务派发装配参数（不是配置键）：缺省 sync（无会话投递端口 = 进程内同步等结果）；
   * 'async' = 本部署有会话投递端口（fileDelivery）→ server 走后台派发/完成主动投递
   * （G 组任务面、E 组回传文件）。端口按此显式注入（有推送面就一律 async）。
   */
  readonly taskDispatch?: 'sync' | 'async';
  /** 短等待窗口（runtime.taskRunWaitMs）。缺省产品值 8000ms；1 = 确定性超窗。 */
  readonly taskRunWaitMs?: number;
  /** 单聊主体的角色（缺省 operator）。viewer = 只读（W-44 的权限拦截面）。 */
  readonly userRole?: string;
  /** 群主体的角色（缺省 viewer）。要让群里的任务真跑起来时给 operator（W-43 的群静默对照）。 */
  readonly groupRole?: string;
  /**
   * 「长时间没动静」提醒阈值（runtime.longRunningNoticeMs；只此一档——30 分钟「卡住」档已随
   * 2026-11-19 唤醒切片删除）。缺省 = 产品值（10 分钟）；用例把它调到几百毫秒确定性触发。
   */
  readonly longRunningNoticeMs?: number;
  /** 临时目录前缀（定位用）。 */
  readonly label?: string;
}

export interface TurnDone {
  readonly taskIds: readonly string[];
  readonly executions: ReadonlyArray<{ requestId: string; operation: string; status: string }>;
}

export interface WecomSimFixture {
  readonly sdk: FakeWecomSdk;
  readonly clock: ManualClock;
  readonly logs: ReadonlyArray<Record<string, unknown>>;
  readonly book: SimScriptBook;
  /** dummy 执行层状态根（audit.jsonl 所在；写面零写入的机械读数）。 */
  readonly execStateDir: string;
  /** 宿主底账（state.db；只读打开用于任务状态机械读数）。 */
  readonly dbPath: string;
  /** 单聊会话（conversationId；群聊另行传入）。 */
  readonly conversationId: string;
  /** 发一条文字入站帧（异步派发；返回 messageId 供 doneOf 精确取该回合终态）。 */
  sendText(text: string, options?: FrameOptions): string;
  /** 发一条纯附件入站帧（文件字节走假 SDK 预置表）。 */
  sendFile(filename: string, bytes: Buffer, options?: FrameOptions): string;
  /** 事件驱动等待：不写固定 sleep。 */
  waitFor(description: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /** message_done 终态（按 messageId）。 */
  doneOf(messageId: string): TurnDone | undefined;
  /** 终帧气泡（finish=true）——用户真正看到的回复。 */
  finalBubbles(): ReadonlyArray<BubbleRecord>;
  /** 主动追问文字（attachmentNudge → sendText → sendMessage 通道）。 */
  nudgeTexts(): ReadonlyArray<string>;
  close(): Promise<void>;
}

/** 事件驱动轮询（run.ts 与 vitest 共用；不用 vi.waitFor 以便双入口同源）。 */
export async function waitForCondition(description: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${description}`);
}

/**
 * 让渠道适配器把**在途文件下载**跑完并入合并窗（微任务/立即队列排空，确定性）。
 *
 * 为什么需要：适配器收到 file 帧后异步下载；若指令帧在下载完成前到达，走的是「文字先到」
 * 的旧逐条交付路径（adapter.ts 的 textWaiting 分支），而不是合并窗。live 上下载在毫秒级
 * 完成、用户指令在一两秒后到，合并窗必然生效；脚本里用一次 setImmediate 等价复现
 * 「文件已收完、指令在窗内到达」，不依赖墙钟（3s 窗口在微任务时间里不可能到点）。
 */
export async function settleDispatch(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

let fixtureSeq = 0;

/** 启动一条真装配链（channel + server + 真实 dummy 执行面 + 脚本化模型）。 */
export async function startWecomSim(options: WecomSimOptions = {}): Promise<WecomSimFixture> {
  const root = mkdtempSync(path.join(os.tmpdir(), `wecom-sim-${options.label ?? 'fx'}-`));
  const dbPath = path.join(root, 'state.db');
  const execStateDir = path.join(root, 'exec-state');
  const platformRoot = path.join(root, 'platform');
  const conversationId = DEFAULT_CONVERSATION_ID;
  const sdk = new FakeWecomSdk();
  const clock = new ManualClock();
  const logs: Array<Record<string, unknown>> = [];
  const book = new SimScriptBook();
  let messageSeq = 0;
  let frameSeq = 0;

  const channel = new WecomBotChannel({
    // 假凭据：只给适配器这一个面；进程 env / .env 里的 WECOM_* 不进装配。
    env: { WECOM_BOT_ID: 'wecom-sim-bot', WECOM_BOT_SECRET: 'wecom-sim-secret' },
    clientFactory: () => sdk,
    platformRoot,
    attachmentDir: path.join(platformRoot, 'tmp', 'attachments'),
    deliveryMode: 'live',
    ...(options.mergeWindowMs === undefined ? {} : { mergeWindowMs: options.mergeWindowMs }),
  });

  const config: AppConfig = {
    principals: {
      // 单聊主体：缺省 operator（读写）——写面仍受部署总闸 allowWriteOperations 约束（W-25）。
      [`wecom:${DEFAULT_USER_ID}`]: { enabled: true, role: options.userRole ?? 'operator' },
      // 群 = 独立主体（owner 2026-11-18）：群聊帧的 principal = `wecom:group:<群id>`，必须在
      // 名单里显式开通——W-16 群聊用例因此走真实路径，不靠「未开通所以什么都没跑」冒充。
      // 群主体按 viewer（只读）：跨群/跨人隔离不回归。
      'wecom:group:group-w': { enabled: true, role: options.groupRole ?? 'viewer' },
    },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    runtime: {
      attachmentNudgeAfterMs: options.nudgeAfterMs ?? NUDGE_AFTER_MS,
      ...(options.allowWriteOperations === true ? { allowWriteOperations: true } : {}),
      // 短等待窗口只在 async 装配（有推送面）下有意义；sync 装配直接同回合拿结果。
      ...(options.taskRunWaitMs === undefined ? {} : { taskRunWaitMs: options.taskRunWaitMs }),
      // 主动提醒阈值（缺省住策略层：10 分钟；只此一档）。
      ...(options.longRunningNoticeMs === undefined ? {} : { longRunningNoticeMs: options.longRunningNoticeMs }),
    },
  };

  // 执行层子进程只消费 PATH/HOME/TMPDIR（worker-env 白名单重建）+ 模型名；
  // 不整体透传进程 env——真实企微凭据（WECOM_*）与 LLM 密钥结构上进不了这条链。
  const env: NodeJS.ProcessEnv = {
    LLM_MODEL: 'test-model',
    ...(process.env['PATH'] === undefined ? {} : { PATH: process.env['PATH'] }),
    ...(process.env['HOME'] === undefined ? {} : { HOME: process.env['HOME'] }),
    ...(process.env['TMPDIR'] === undefined ? {} : { TMPDIR: process.env['TMPDIR'] }),
  };

  const makeDriver = async (driver: 'main' | 'worker'): Promise<TurnDriver> => {
    const scripted = await createScriptedModelRuntime({
      contextWindow: 40_000,
      script: (_index, context) => book.respond(driver, context),
    });
    return createPiTurnDriver({
      env,
      modelRuntime: scripted.runtime,
      ...(driver === 'main' ? { reuseConversation: true } : {}),
    });
  };

  // 会话投递端口（fileDelivery）：只在显式声明 async 的样本注入——有推送面就一律 async。
  const fileDeliveryPort: FileDeliveryPort = {
    deliveryMode: channel.deliveryMode,
    sendToConversation: (route, files) => channel.sendToConversation(route, { files }),
    sendText: (route, text) => channel.sendToConversation(route, { text }),
  };
  // createExecutionFace **不注入**：装配链缺省 = 仓内 dummy CLI（真实子进程，--state-dir 落 execStateDir）。
  const server: Server = await createServer({
    env,
    config,
    dbPath,
    stateDir: execStateDir,
    createDrivers: () => Promise.all([makeDriver('main'), makeDriver('worker')]).then(
      ([mainDriver, workerDriver]) => ({ mainDriver, workerDriver }),
    ),
    // 有推送面就一律 async；未声明 async 的样本不注入会话投递端口 → 进程内同步等结果
    // （与原 inline 装配逐字节同形：既有 A/B/C/D/F 组样本的语义不变）。
    ...(options.taskDispatch === 'async' ? { fileDelivery: fileDeliveryPort } : {}),
    attachmentNudgeClock: clock,
    logger: (line) => logs.push(line),
  });

  // 与 apps/server/channel-mode.test.ts 同形：先拿到启动 promise，emit authenticated（假连接
  // 建立），再 await——start 的 30s 连接超时等的就是这一帧。
  const starting = startChannelForMode('live', channel, server.handler);
  sdk.emit('authenticated');
  await starting;

  const nextMessageId = (): string => {
    messageSeq += 1;
    return `w-sim-${fixtureSeq}-${messageSeq}`;
  };

  const fixture: WecomSimFixture = {
    sdk,
    clock,
    logs,
    book,
    execStateDir,
    dbPath,
    conversationId,
    sendText(text, frameOptions = {}) {
      frameSeq += 1;
      const messageId = nextMessageId();
      sdk.emit('message.text', textFrame(`req-${frameSeq}`, messageId, text, frameOptions));
      return messageId;
    },
    sendFile(filename, bytes, frameOptions = {}) {
      frameSeq += 1;
      const url = `https://wecom-sim.invalid/media/${frameSeq}-${encodeURIComponent(filename)}`;
      sdk.stageFile(url, filename, bytes);
      const messageId = nextMessageId();
      sdk.emit('message.file', fileFrame(`req-${frameSeq}`, messageId, url, frameOptions));
      return messageId;
    },
    async waitFor(description, predicate, timeoutMs) {
      await waitForCondition(description, predicate, timeoutMs);
    },
    doneOf(messageId) {
      const done = [...logs].reverse().find((line) => line['event'] === 'message_done' && line['messageId'] === messageId);
      if (done === undefined) return undefined;
      return {
        taskIds: (done['taskIds'] as readonly string[] | undefined) ?? [],
        executions: (done['executions'] as TurnDone['executions'] | undefined) ?? [],
      };
    },
    finalBubbles() {
      return sdk.bubbles.filter((bubble) => bubble.finish);
    },
    nudgeTexts() {
      return sdk.proactiveTexts.map((record) => record.content);
    },
    async close() {
      await channel.stop();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  fixtureSeq += 1;
  return fixture;
}

// ─────────────────────────────────────────────────────────────────────────────
// 共享小件：脚本回复由执行层真实返回派生
// ─────────────────────────────────────────────────────────────────────────────

interface QueryData {
  collection?: string;
  window?: string | null;
  items?: ReadonlyArray<{ value?: number; name?: string }>;
  count?: number;
  query?: string;
  candidates?: ReadonlyArray<{ name?: string }>;
}

/** 信封 completed（有行）→ 用户可读事实（数字来自真实 items，不读真值表）。 */
export function describeCompleted(data: QueryData): string {
  const items = data.items ?? [];
  const values = items.map((item) => (typeof item.value === 'number' ? String(item.value) : '?'));
  const name = data.collection ?? '';
  const window = data.window === null || data.window === undefined ? '' : ` ${String(data.window)}`;
  return `${name}${window} 共 ${data.count ?? items.length} 条，金额分别是 ${values.join('、')} 元。`;
}

/** 执行层真实返回 → 如实话术（completed/failed/refused/not_found 四态，不给编造数字）。 */
export function describeOutcome(outcome: Record<string, unknown>): string {
  const status = outcome['status'];
  const data = (outcome['data'] ?? {}) as QueryData;
  const error = (outcome['error'] ?? {}) as { code?: string; message?: string };
  const name = data.collection ?? data.query ?? '该集合';
  if (status === 'completed') {
    if ((data.count ?? 0) === 0 && (data.items ?? []).length === 0 && data.query !== undefined) {
      const candidates = (data.candidates ?? []).map((entry) => entry.name).filter((entry) => entry !== undefined);
      return `${name} 这个集合不存在，没有查到任何记录${candidates.length > 0 ? `；相近的集合有：${candidates.join('、')}` : ''}。`;
    }
    if ((data.count ?? data.items?.length ?? 0) === 0) {
      return `${name} ${String(data.window ?? '')} 没有记录（0 条），这次没有数据可给。`;
    }
    return describeCompleted(data);
  }
  if (status === 'needs_input') {
    // 执行层显式要补充输入（fixture 的 requires 或歧义）：原样转述「缺什么」。
    const raw = Array.isArray(outcome['missing']) ? (outcome['missing'] as unknown[]) : [];
    const missing = raw.map((entry) => {
      if (typeof entry === 'string') return entry;
      const record = (entry ?? {}) as { description?: unknown; name?: unknown };
      if (typeof record.description === 'string' && record.description !== '') return record.description;
      return typeof record.name === 'string' ? record.name : '';
    }).filter((entry) => entry !== '');
    return `执行层要求补充输入：${missing.length > 0 ? missing.join('、') : (error.message ?? '未说明')}。`;
  }
  if (status === 'refused') {
    // 模型可见面收口（2026-11-19）：refused 投影只带 kind + note（无原始码/原文）。
    // 脚本如实转述用户话术——用户不需要、也不该看到 GATE_REFUSE 这类内部码。
    const note = typeof outcome['note'] === 'string' && outcome['note'] !== ''
      ? outcome['note']
      : '这件事没权限，这次没有取得任何数据。';
    return note;
  }
  if (status === 'failed') {
    // 同上：failed 投影只带 kind + note。kind 由执行层码归类（业务语义），note 是用户
    // 话术；模型与用户都不再见原始码与原文（原文只进 execution_failure_classified 日志）。
    const note = typeof outcome['note'] === 'string' && outcome['note'] !== ''
      ? outcome['note']
      : '这次没办成，没有取得任何数据。';
    return note;
  }
  return `执行层返回了未预期的形态：${JSON.stringify(outcome).slice(0, 200)}`;
}

/** 一次查询任务的 Worker 脚本：发起真实 op_* 工具调用，再按真实返回汇报。 */
export function workerQueryResponses(operation: string, args: Record<string, string>): readonly SimResponse[] {
  const toolName = `op_${operation.replace(/[^A-Za-z0-9_]/g, '_')}`;
  // 调用方历史上用执行层原样名（`--collection`）；op_* 工具只认业务字段名，宿主翻回 `--`。
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) fields[key.replace(/^--/, '')] = value;
  return [
    toolCallAssistant(toolName, fields),
    (call) => {
      const outcome = lastToolResultJsonOf(call.messages);
      if (outcome === undefined) throw new Error('Worker 脚本没有拿到执行工具的真实返回。');
      return textAssistant(describeOutcome(outcome));
    },
  ];
}

/** Main 的转述脚本：把 task_run 真实摘要（Worker 汇报）转给用户。 */
export function mainRelayResponses(task: string): readonly SimResponse[] {
  return [
    toolCallAssistant('task_run', { task }),
    (call) => {
      const result = lastToolResultJsonOf(call.messages);
      const summary = typeof result?.['summary'] === 'string' ? result['summary'] : '';
      if (summary === '') throw new Error('Main 脚本没有拿到 task_run 的真实摘要。');
      return textAssistant(summary);
    },
  ];
}

/** 销售明细汇总的 run_js 代码（真实 exceljs 读写；writeOutFile=true 时产出回传新表）。 */
export function salesSummaryRunJs(writeOutFile: boolean): string {
  const writeBlock = writeOutFile
    ? `
  const out = new ExcelJS.Workbook();
  const sheet = out.addWorksheet('汇总');
  sheet.addRow(['客户', '金额']);
  for (const [customer, amount] of byCustomer) sheet.addRow([customer, amount]);
  sheet.addRow(['合计', total]);
  fs.mkdirSync('out', { recursive: true });
  await out.xlsx.writeFile(path.join('out', '销售汇总.xlsx'));
`
    : '';
  return `(async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ExcelJS = require('exceljs');
  const entry = fs.readdirSync('in').find((name) => name.endsWith('.xlsx'));
  if (entry === undefined) { console.error('没有 xlsx 输入'); process.exit(1); }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fs.readFileSync(path.join('in', entry)));
  const ws = wb.worksheets[0];
  const byCustomer = new Map();
  let total = 0;
  ws.eachRow((row, index) => {
    if (index === 1) return;
    const customer = String(row.getCell(1).value ?? '').trim();
    const amount = Number(row.getCell(3).value ?? 0);
    if (customer === '') return;
    byCustomer.set(customer, (byCustomer.get(customer) ?? 0) + amount);
    total += amount;
  });
  console.log('SUM ' + JSON.stringify({ total, byCustomer: Object.fromEntries(byCustomer) }));
${writeBlock}
})().catch((error) => { console.error(error && error.message ? error.message : String(error)); process.exit(1); });
`;
}

/** 解析 run_js 真实 stdout 的 SUM 行。 */
export function parseSumStdout(stdout: string): { total: number; byCustomer: Record<string, number> } | undefined {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('SUM '));
  if (line === undefined) return undefined;
  try {
    const parsed = JSON.parse(line.slice(4)) as { total: number; byCustomer: Record<string, number> };
    return parsed;
  } catch {
    return undefined;
  }
}

/** Main 的附件汇总脚本：从文件清单注入取 fileId，真实 run_js 汇总，按真实出口汇报。 */
export function mainAttachmentSummaryResponses(writeOutFile: boolean): readonly SimResponse[] {
  return [
    (call) => {
      const fileIds = manifestFileIdsOf(call.messages);
      if (fileIds.length === 0) throw new Error('Main 脚本没有从文件清单注入里拿到 fileId。');
      return toolCallAssistant('run_js', { code: salesSummaryRunJs(writeOutFile), inputs: fileIds });
    },
    (call) => {
      const output = lastToolResultJsonOf(call.messages);
      const stdout = typeof output?.['stdout'] === 'string' ? output['stdout'] : '';
      const sum = parseSumStdout(stdout);
      if (sum === undefined) throw new Error(`run_js 真实出口没有 SUM 行：${stdout.slice(0, 120)}`);
      const parts = Object.entries(sum.byCustomer).map(([customer, amount]) => `${customer} ${amount} 元`);
      return textAssistant(`按客户汇总：${parts.join('，')}，合计 ${sum.total} 元。${writeOutFile ? '汇总表已生成，见附件。' : ''}`);
    },
  ];
}

/** 复用 business-e2e 的消息构造（不复制第二份）。 */
export { textAssistant, toolCallAssistant };

/**
 * 样例销售明细 xlsx（异步生成；数据与 scripts/eval/fixtures/make-sales-sample.mjs 同一份：
 * 12 行 / 2 客户，期望 华远贸易 21000 / 明达物流 18000 / 合计 39000）。
 */
export async function salesSampleXlsxAsync(): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('销售明细');
  sheet.columns = [
    { header: '客户', key: 'customer', width: 16 },
    { header: '月份', key: 'period', width: 12 },
    { header: '金额', key: 'amount', width: 12 },
  ];
  const rows: Array<[string, string, number]> = [
    ['华远贸易', '2025-01', 1000],
    ['华远贸易', '2025-02', 2000],
    ['华远贸易', '2025-03', 3000],
    ['华远贸易', '2025-04', 4000],
    ['华远贸易', '2025-05', 5000],
    ['华远贸易', '2025-06', 6000],
    ['明达物流', '2025-07', 500],
    ['明达物流', '2025-08', 1500],
    ['明达物流', '2025-09', 2500],
    ['明达物流', '2025-10', 3500],
    ['明达物流', '2025-11', 4500],
    ['明达物流', '2025-12', 5500],
  ];
  for (const [customer, period, amount] of rows) sheet.addRow({ customer, period, amount });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
