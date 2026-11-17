/**
 * 纯附件后的主动追问（目标 B）。
 *
 * 触发条件（全部满足才发）：
 *   ① 单聊；② 纯附件已登记；③ 此后该会话没有任何新消息/回合（任何新入站消息都取消
 *   待发追问；新附件重新计时并并入同一批）；④ 这批没问过（发过即清批）；⑤ 不在冷却期
 *   （同一会话 10 分钟）。
 *
 * 时间：`runtime.attachmentNudgeAfterMs`（缺省 30s；0 = 关闭，零行为变化）。
 * 文案：一句短问 + 2~4 个业务化选项（表格/文档/图片/未知各一套；写类选项只在
 * `allowWriteOperations=true` 时列出），可用数字回复。多个文件合并成一句。
 *
 * 投递纪律：走宿主既有主动投递面。非 live 部署**不发起真实投递**，只记
 * `attachment_nudge_suppressed`；只有真实送达才记 `attachment_nudge_sent`。
 * 追问发出后把**同一份选项**作为系统注记入队（模型可见 / 用户不可见 / 不触发回合），
 * 用户回「1」时模型才知道指什么。
 *
 * 定时器：注入时钟/调度器（测试确定性）；`close()` 清全部定时器与批次。进程重启不补发。
 */
import type { ChannelRoute, DeliveryReceipt } from '@fshine/contracts';
import { displayFileName, type AttachmentFactInput } from './attachment-facts';

/** 同一会话两次主动追问的最小间隔（10 分钟）。 */
export const ATTACHMENT_NUDGE_COOLDOWN_MS = 10 * 60 * 1000;

/** 注入时钟：now + 调度/撤销（缺省 = 真实 setTimeout，测试注入手动时钟）。 */
export interface NudgeClock {
  now(): number;
  schedule(run: () => void | Promise<void>, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

/** 宿主主动投递面（与文件投递同一端口；文字追问只要求 sendText）。 */
export interface AttachmentNudgeDelivery {
  readonly deliveryMode: 'live' | 'silent';
  sendText?(route: ChannelRoute, text: string): Promise<DeliveryReceipt>;
}

export interface AttachmentNudgeOptions {
  /** 追问延迟（ms）；<= 0 = 关闭。由 `runtime.attachmentNudgeAfterMs` 解析而来。 */
  afterMs: number;
  cooldownMs?: number;
  /** 写面开关：决定是否列出写类选项（只影响文案，不构成任何授权）。 */
  allowWriteOperations: boolean;
  /** 注入时钟；缺省真实时钟（定时器 unref，不拖住进程退出）。 */
  clock?: NudgeClock;
  /** 主动投递面；缺省 = 无投递面（按 suppressed 记账，绝不记 sent）。 */
  delivery?: AttachmentNudgeDelivery;
  /** 系统注记入队（与附件事实同一 injections 机制，下一次回合注入）。 */
  enqueueSystemNote: (principalId: string, sessionId: string, note: string) => void;
  /** 结构化事件出口（只含 scope/计数/模式，不含文件名与内容）。 */
  log: (line: Record<string, unknown>) => void;
}

/** 真实时钟（缺省）：定时器 unref，避免测试/部署收尾被 30s 定时器拖住。 */
const SYSTEM_CLOCK: NudgeClock = {
  now: () => Date.now(),
  schedule: (run, delayMs) => {
    const timer = setTimeout(() => {
      void run();
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  cancel: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

type FileKind = 'spreadsheet' | 'document' | 'image' | 'unknown';

const KIND_OPTIONS: Readonly<Record<FileKind, { readonly read: readonly [string, string]; readonly write: string }>> = {
  spreadsheet: {
    read: ['汇总统计（求和/计数/分类）', '核对异常数据'],
    write: '生成新的汇总表',
  },
  document: {
    read: ['提取要点', '总结全文'],
    write: '改写并生成新文档',
  },
  image: {
    read: ['识别图片中的文字', '描述图片内容'],
    write: '整理成新的文档',
  },
  unknown: {
    read: ['查看并提取文件内容', '说明文件结构'],
    write: '整理并生成新文件',
  },
};

const GENERIC_WRITE_OPTION = '生成新的结果文件';
const OTHER_OPTION = '其他（直接说你的要求）';
const FILE_NAME_LIST_LIMIT = 3;

function kindOf(name: string): FileKind {
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (['xlsx', 'xls', 'csv', 'tsv', 'xlsm'].includes(extension)) return 'spreadsheet';
  if (['doc', 'docx', 'pdf', 'txt', 'md', 'rtf', 'ppt', 'pptx'].includes(extension)) return 'document';
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'heic'].includes(extension)) return 'image';
  return 'unknown';
}

function fileListLine(files: readonly AttachmentFactInput[]): string {
  const names = [...new Set(files.map((file) => displayFileName(file.name)))];
  const listed = names.slice(0, FILE_NAME_LIST_LIMIT).join('、') || '（未命名）';
  return `收到 ${files.length} 个文件：${listed}${names.length > FILE_NAME_LIST_LIMIT ? ' 等' : ''}`;
}

/** 选项集合：单类型用它自己的一套；混合类型取前两个类型各一条 + 通用写类。2~4 个。 */
function optionsFor(files: readonly AttachmentFactInput[], allowWriteOperations: boolean): string[] {
  const kinds: FileKind[] = [];
  for (const file of files) {
    const kind = kindOf(file.name);
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  const primary = kinds[0] ?? 'unknown';
  const readOptions = kinds.length <= 1
    ? [...KIND_OPTIONS[primary].read]
    : kinds.slice(0, 2).map((kind) => KIND_OPTIONS[kind].read[0]);
  const writeOption = allowWriteOperations
    ? (kinds.length <= 1 ? KIND_OPTIONS[primary].write : GENERIC_WRITE_OPTION)
    : undefined;
  return [...readOptions, ...(writeOption === undefined ? [] : [writeOption]), OTHER_OPTION];
}

export interface RenderedAttachmentNudge {
  /** 用户可见文案：一句短问 + 数字选项。 */
  text: string;
  /** 模型可见、用户不可见的系统注记（同一份选项，明确标注“系统主动提示”）。 */
  note: string;
  options: readonly string[];
}

export function renderAttachmentNudge(
  files: readonly AttachmentFactInput[],
  options: { allowWriteOperations: boolean },
): RenderedAttachmentNudge {
  const headline = fileListLine(files);
  const choices = optionsFor(files, options.allowWriteOperations);
  const numbered = choices.map((choice, index) => `${index + 1}. ${choice}`);
  return {
    text: `${headline}。你想让我先做什么？回复数字即可：\n${numbered.join('\n')}`,
    note: `[系统主动提示] 用户收到附件后没有立即给指令，宿主已向用户发出追问（${headline}）。用户可见选项：${numbered.join('；')}。若用户只回复数字，按上述编号理解。`,
    options: choices,
  };
}

interface PendingNudge {
  principalId: string;
  sessionId: string;
  route: ChannelRoute;
  /** fileId → 事实（同 fileId 只算一次；不含路径/内容）。 */
  files: Map<string, AttachmentFactInput>;
  timer: unknown;
  /** 每次重新计时递增；旧定时器回调据此确定性地失效。 */
  token: number;
}

function scopeKeyOf(principalId: string, sessionId: string): string {
  return `${principalId}\u0000${sessionId}`;
}

export class AttachmentNudge {
  private readonly afterMs: number;
  private readonly cooldownMs: number;
  private readonly allowWriteOperations: boolean;
  private readonly clock: NudgeClock;
  private readonly delivery: AttachmentNudgeDelivery | undefined;
  private readonly enqueueSystemNote: AttachmentNudgeOptions['enqueueSystemNote'];
  private readonly log: AttachmentNudgeOptions['log'];
  private readonly pending = new Map<string, PendingNudge>();
  private readonly cooldownUntil = new Map<string, number>();
  /** scopeKey → 最近一次入站消息的活动令牌（异步登记完成时据此判断是否已过期）。 */
  private readonly activity = new Map<string, number>();
  private closed = false;

  constructor(options: AttachmentNudgeOptions) {
    this.afterMs = options.afterMs;
    this.cooldownMs = options.cooldownMs ?? ATTACHMENT_NUDGE_COOLDOWN_MS;
    this.allowWriteOperations = options.allowWriteOperations;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.delivery = options.delivery;
    this.enqueueSystemNote = options.enqueueSystemNote;
    this.log = options.log;
  }

  /**
   * 任何入站消息到达时调用：取消待发追问（条件③“此后没有任何新消息/回合”）。
   * 非附件消息还会丢弃本批（用户已经给出指令，这批不再需要追问）；纯附件消息保留
   * 已累积的批次，由随后的 `onAttachments` 并入新文件并重新计时。
   *
   * 返回本会话的**活动令牌**：附件登记是异步的（下载/落盘），登记完成时可能已有更新的
   * 消息到达。调用方把令牌原样交给 `onAttachments`；令牌过期 = 登记期间用户已说话，
   * 这次登记不得再补排追问。
   */
  onInboundMessage(input: { principalId: string; sessionId: string; attachmentOnly: boolean }): number {
    if (this.afterMs <= 0 || this.closed) return 0;
    const key = scopeKeyOf(input.principalId, input.sessionId);
    const token = (this.activity.get(key) ?? 0) + 1;
    this.activity.set(key, token);
    const state = this.pending.get(key);
    if (state === undefined) return token;
    this.clock.cancel(state.timer);
    state.timer = undefined;
    if (!input.attachmentOnly) this.pending.delete(key);
    return token;
  }

  /**
   * 纯附件登记成功后调用：把文件并入本会话批次并重新计时（30s 从最后一个文件算起）。
   * 非单聊 / 关闭 / 冷却期 → 不排定时器（冷却内不追问；批次不保留）。
   * `activity` = 该附件消息到达时 `onInboundMessage` 返回的令牌；与当前令牌不一致
   * （登记期间来了更新的消息）→ 不排（由更新的那条消息自己的路径决定）。
   */
  onAttachments(input: {
    principalId: string;
    sessionId: string;
    chatType?: 'single' | 'group';
    route: ChannelRoute;
    files: readonly AttachmentFactInput[];
    activity?: number;
  }): void {
    if (this.afterMs <= 0 || this.closed) return;
    if (input.chatType !== 'single') return;
    if (input.files.length === 0) return;
    const key = scopeKeyOf(input.principalId, input.sessionId);
    if (input.activity !== undefined && input.activity !== (this.activity.get(key) ?? 0)) return;
    const cooldown = this.cooldownUntil.get(key);
    if (cooldown !== undefined && this.clock.now() < cooldown) return;

    let state = this.pending.get(key);
    if (state === undefined) {
      state = {
        principalId: input.principalId,
        sessionId: input.sessionId,
        route: input.route,
        files: new Map(),
        timer: undefined,
        token: 0,
      };
      this.pending.set(key, state);
    }
    state.route = { ...input.route };
    for (const file of input.files) {
      if (!state.files.has(file.fileId)) state.files.set(file.fileId, file);
    }
    if (state.timer !== undefined) this.clock.cancel(state.timer);
    state.token += 1;
    const token = state.token;
    state.timer = this.clock.schedule(() => this.fire(key, token), this.afterMs);
  }

  /** 停机/会话关闭：清全部定时器与批次（进程重启不补发）。 */
  close(): void {
    this.closed = true;
    for (const state of this.pending.values()) {
      this.clock.cancel(state.timer);
    }
    this.pending.clear();
    this.cooldownUntil.clear();
    this.activity.clear();
  }

  private async fire(key: string, token: number): Promise<void> {
    if (this.closed) return;
    const state = this.pending.get(key);
    if (state === undefined || state.token !== token) return;
    this.pending.delete(key);
    const files = [...state.files.values()];
    if (files.length === 0) return;

    const now = this.clock.now();
    const cooldown = this.cooldownUntil.get(key);
    if (cooldown !== undefined && now < cooldown) return;
    // 不论送达还是抑制都记冷却：避免 silent 部署每个批次都刷一条抑制事件。
    this.cooldownUntil.set(key, now + this.cooldownMs);

    const rendered = renderAttachmentNudge(files, { allowWriteOperations: this.allowWriteOperations });
    const base = {
      principalId: state.principalId,
      sessionId: state.sessionId,
      files: files.length,
    };
    const delivery = this.delivery;
    if (delivery === undefined || delivery.deliveryMode !== 'live' || typeof delivery.sendText !== 'function') {
      this.log({
        event: 'attachment_nudge_suppressed',
        ...base,
        deliveryMode: delivery?.deliveryMode ?? 'unavailable',
      });
      return;
    }
    try {
      const receipt = await delivery.sendText(state.route, rendered.text);
      this.log({
        event: 'attachment_nudge_sent',
        ...base,
        deliveryMode: 'live',
        parts: receipt.parts.length,
      });
      // 只有用户真的看到了选项，系统注记才有意义（模型据此解释用户的数字回复）。
      this.enqueueSystemNote(state.principalId, state.sessionId, rendered.note);
    } catch (error) {
      this.log({
        event: 'attachment_nudge_failed',
        ...base,
        deliveryMode: 'live',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
