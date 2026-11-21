/**
 * 对话形态断言层（纯函数 + 类型；2026-11-21 要求 D，ops 交接门「对话形态四条」的通用实现）。
 *
 * 为什么需要它（准入 ①最小可复现失败）：交接门已把四条对话形态立为门（docs/ops/handover.md
 * §三），但守卫此前只有三处点状实现——缺陷 A（回合内终态抑制）、缺陷 B（降级引用行）、
 * 要求 C（wecom-sim M 组手写断言）。同一条形态在 wecom-sim / write-loop /
 * write-loop-scenarios / convergence-r1 四个面各写一份断言就是四份漂移的副本；本模块把它们
 * 收成**一个纯函数**：输入=规范化事件流，输出=违规列表（每条带 code，便于逐条红）。
 *
 * 判据全部机械（不判措辞、不判质量），唯一的字符串判断是 ③ 的「含用户原话片段（≥8 字）或
 * 任务名」——这是交接门原文要求的包含检查（「非线程推送必须自含话题」的机械下界），不是
 * 措辞评估：
 *   · inbound-reply-duplicate  ① 同一条用户消息 >1 条线程回复（回合回复重复播报）；
 *   · fact-delivered-twice     ② 同一 (taskId, factKind) 的用户可见投递 >1 次（同一件事
 *     说两遍；provenance 缺省的投递无法归属，不参与本条——宁可漏报不误报，见下）；
 *   · push-needs-subject       ③ 非线程推送（降级回复 / **无归属**投递）的正文既不含任何
 *     用户原话片段（≥8 字）也不含任何任务名（降级新消息/主动投递不自含话题 = 客户端把它
 *     排到最新消息下面，读起来像答非所问——缺陷 B 的模式）；有归属（provenance 齐全）的
 *     投递不判本条，见下「已知边界」；
 *   · reply-misattached        ④ 线程回复的 inReplyTo 不在其之前的 inbound 里，或 at 早于
 *     该 inbound（不错挂：回复挂到别的消息/时间倒挂）。
 *
 * 事件形状（三个；调用方按各面的事实源装配）：
 *   · inbound  { messageId, at, text }  一条用户消息（线程的锚点）；
 *   · reply    { inReplyTo, at, text }  inReplyTo 有值=线程回复；空=主动推送（与 delivery
 *     一样参与 ③）；
 *   · delivery { at, text, provenance? } 宿主主动投递（非线程推送）；provenance =
 *     { taskId, factKind }，来自宿主记账（task_result_delivery_sent 事件的归属字段）。
 *
 * `at` 是可比的毫秒数（墙钟或单调逻辑时钟都行），只用于 ④ 的时序分支与流内排序；规则不
 * 依赖绝对时刻。流必须按发生顺序给出。
 *
 * 已知边界（如实登记，不冒充覆盖）：
 *   · ② 只数 provenance 齐全的投递；归属补填（createDeliveryProvenanceAttributor）按
 *     「sent 记账行 ↔ 最近一条未归属推送」配对，与 write-loop-scenarios 既有的 taskId
 *     补填同式。并发跨会话投递极端交错时可能配错对——配错只影响违规上下文引用的文本，
 *     (taskId, factKind) 多重集不变（每条 sent 行恰补一条推送）。
 *   · ③ 的原话片段是 8 字滑窗包含检查：推文里出现原话中任意连续 8 字即算自含话题。这是
 *     机械下界（恒偏向放行），语义层面的「答非所问」归用户级 eval。
 *   · ③ **不判有归属的投递**（2026-11-21 实测假红后收紧）：模型会自然改写主语——stop 场景
 *     的取消推送写「去年全年的凭证导出任务已取消」，而任务名是「导出去年（2025 年）全年的
 *     凭证…」；要求逐字包含任务名会误报。语义层面的「推送跑题」无法机械化，宁漏勿误：
 *     有归属投递的重复由 ② 守、降级回复的引用行由 L1 常跑用例守。
 */
/** 任务事实种类（与宿主 task_result_delivery_* 记账行的 factKind 字段同值域）。 */
export type TaskFactKind = 'completed' | 'failed' | 'cancelled' | 'waiting_user' | 'warning';

/** 一条用户消息（线程锚点）。 */
export interface InboundEvent {
  readonly kind: 'inbound';
  /** 渠道/夹具的入站消息 id（sim = 帧的 msgid；回合面 = 合成 turn-N）。 */
  readonly messageId: string;
  readonly at: number;
  readonly text: string;
}

/**
 * 一条回复。inReplyTo 有值 = 线程回复（挂在某条 inbound 上）；undefined = 主动推送
 * （与 delivery 一样参与 ③；④ 不适用于它）。
 */
export interface ReplyEvent {
  readonly kind: 'reply';
  readonly inReplyTo: string | undefined;
  readonly at: number;
  readonly text: string;
}

/** 一条宿主主动投递（非线程推送）。provenance 来自宿主记账；取不到 = undefined。 */
export interface DeliveryEvent {
  readonly kind: 'delivery';
  readonly at: number;
  readonly text: string;
  readonly provenance?: { readonly taskId: string; readonly factKind: TaskFactKind };
}

export type ConversationEvent = InboundEvent | ReplyEvent | DeliveryEvent;

/** 四条规则的 code（交接门原文四条一一对应）。 */
export const SHAPE_VIOLATION_CODES = [
  'inbound-reply-duplicate',
  'fact-delivered-twice',
  'push-needs-subject',
  'reply-misattached',
] as const;

export type ShapeViolationCode = (typeof SHAPE_VIOLATION_CODES)[number];

/** 一条形态违规（code + 人读上下文 + 相关事件在输入流里的下标，可回到现场）。 */
export interface ShapeViolation {
  readonly code: ShapeViolationCode;
  readonly detail: string;
  readonly eventIndexes: readonly number[];
}

export interface CheckConversationShapeInput {
  /** 规范化事件流（按发生顺序）。 */
  readonly events: readonly ConversationEvent[];
  /** 任务名集合（③ 的「任务名」判据；缺省 = 空——只按原话片段判）。 */
  readonly taskNames?: readonly string[];
  /** 原话片段的最短长度（缺省 8，交接门口径）。 */
  readonly quoteMinLength?: number;
  /**
   * 该会话按**群主体隐私口径**跑（owner 2026-11-18：群里的提醒不带业务名——业务名是任务
   * 原文，可能是个人数据；实现见 apps/server/server.ts 的 createLongRunningNoticePort，
   * 只对久无动静（warning）出口剥名）。此口径与交接门 ③「推送必须自含话题」在群久无动静
   * 推送上结构性冲突（剥名后既无原话片段也无任务名，话题形态=宿主中性主语），隐私是
   * B 类不变量、优先——本流内 factKind=warning 的投递豁免 ③（其余推送照判，不放水）。
   */
  readonly groupPrivacy?: boolean;
}

/** 文本摘要（违规上下文用；只截断显示，不改判据）。 */
function excerptOf(text: string, maxLength = 80): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength)}…`;
}

/** ③ 的原话片段判定：推文里是否出现任一 inbound 原话中连续 minLen 字的片段。 */
function containsInboundQuote(pushText: string, inbounds: readonly InboundEvent[], minLen: number): boolean {
  if (minLen <= 0) return inbounds.length > 0;
  for (const inbound of inbounds) {
    const text = inbound.text;
    if (text.length < minLen) continue;
    for (let start = 0; start + minLen <= text.length; start += 1) {
      if (pushText.includes(text.slice(start, start + minLen))) return true;
    }
  }
  return false;
}

/** ③ 的任务名判定：推文里是否出现任一任务名（逐字包含；空白两端裁掉）。 */
function containsTaskName(pushText: string, taskNames: readonly string[]): boolean {
  return taskNames.some((name) => {
    const trimmed = name.trim();
    return trimmed !== '' && pushText.includes(trimmed);
  });
}

/**
 * 对话形态判定（纯函数；同输入同输出，不读文件、不取时钟）。
 * 违规按规则序（①②③④）输出，同规则内按流序稳定。
 */
export function checkConversationShape(input: CheckConversationShapeInput): ShapeViolation[] {
  const { events } = input;
  const minLen = input.quoteMinLength ?? 8;
  const taskNames = input.taskNames ?? [];
  const violations: ShapeViolation[] = [];

  // ① 同一条用户消息 >1 条线程回复。
  const inboundIndexes = new Map<string, number[]>();
  events.forEach((event, index) => {
    if (event.kind !== 'inbound') return;
    const bucket = inboundIndexes.get(event.messageId);
    if (bucket === undefined) inboundIndexes.set(event.messageId, [index]);
    else bucket.push(index);
  });
  const repliesByInbound = new Map<string, number[]>();
  events.forEach((event, index) => {
    if (event.kind !== 'reply' || event.inReplyTo === undefined) return;
    const bucket = repliesByInbound.get(event.inReplyTo);
    if (bucket === undefined) repliesByInbound.set(event.inReplyTo, [index]);
    else bucket.push(index);
  });
  for (const [messageId, replyIndexes] of repliesByInbound) {
    if (replyIndexes.length <= 1) continue;
    violations.push({
      code: 'inbound-reply-duplicate',
      detail: `消息 ${messageId} 有 ${replyIndexes.length} 条线程回复（≥2 条即重复播报）：`
        + replyIndexes.map((index) => `#${index}「${excerptOf((events[index] as ReplyEvent).text)}」`).join('；'),
      eventIndexes: replyIndexes,
    });
  }

  // ② 同一 (taskId, factKind) 的用户可见投递 >1 次（provenance 缺省 = 无法归属，不参与）。
  const deliveriesByFact = new Map<string, number[]>();
  events.forEach((event, index) => {
    if (event.kind !== 'delivery' || event.provenance === undefined) return;
    const key = `${event.provenance.taskId}\u0000${event.provenance.factKind}`;
    const bucket = deliveriesByFact.get(key);
    if (bucket === undefined) deliveriesByFact.set(key, [index]);
    else bucket.push(index);
  });
  for (const [key, deliveryIndexes] of deliveriesByFact) {
    if (deliveryIndexes.length <= 1) continue;
    const [taskId, factKind] = key.split('\u0000');
    violations.push({
      code: 'fact-delivered-twice',
      detail: `任务 ${taskId} 的 ${factKind} 事实投递了 ${deliveryIndexes.length} 次：`
        + deliveryIndexes.map((index) => `#${index}「${excerptOf((events[index] as DeliveryEvent).text)}」`).join('；'),
      eventIndexes: deliveryIndexes,
    });
  }

  // ③ 非线程推送必须自含话题：原话片段（≥8 字）或任务名。适用范围（2026-11-21 边界收紧）：
  //   · reply(inReplyTo=undefined)（降级回复）——必须带宿主加的引用行；
  //   · **无归属**的 delivery——没有 provenance，只能靠文本判；
  //   · **有归属**的 delivery 不判 ③：模型会自然改写主语（实测「去年全年的凭证导出任务」
  //     与任务名「导出去年（2025 年）全年的凭证…」不一致），语义话题无法机械判定——宁可
  //     漏报不误报；这类投递的重复由 ② 守，降级回复的引用行由 L1 常跑用例（wecom-sim M 组）守。
  //   群隐私流（见输入注释）对 warning 投递豁免。
  const inboundEvents = events.filter((event): event is InboundEvent => event.kind === 'inbound');
  events.forEach((event, index) => {
    const text = event.kind === 'reply' || event.kind === 'delivery' ? event.text : undefined;
    if (text === undefined) return;
    if (event.kind === 'reply' && event.inReplyTo !== undefined) return;
    if (event.kind === 'delivery' && event.provenance !== undefined) return;
    if (input.groupPrivacy === true
      && event.kind === 'delivery'
      && event.provenance?.factKind === 'warning') return;
    if (containsInboundQuote(text, inboundEvents, minLen)) return;
    if (containsTaskName(text, taskNames)) return;
    const source = event.kind === 'reply' ? '主动回复（无线程锚点）' : '主动投递';
    const provenance = event.kind === 'delivery' && event.provenance !== undefined
      ? `（${event.provenance.factKind} · 任务 ${event.provenance.taskId}）`
      : '';
    violations.push({
      code: 'push-needs-subject',
      detail: `${source}${provenance}正文既不含用户原话片段（≥${minLen} 字）也不含任务名：「${excerptOf(text)}」`,
      eventIndexes: [index],
    });
  });

  // ④ 线程回复不错挂：inReplyTo 必须能在**之前**的 inbound 里找到，且不早于它。
  events.forEach((event, index) => {
    if (event.kind !== 'reply' || event.inReplyTo === undefined) return;
    let inboundIndex: number | undefined;
    for (const candidate of inboundIndexes.get(event.inReplyTo) ?? []) {
      if (candidate < index) inboundIndex = candidate; // 取最近（最后）一条在此之前同 id 的 inbound
    }
    if (inboundIndex === undefined) {
      violations.push({
        code: 'reply-misattached',
        detail: `回复 #${index} 挂到消息 ${event.inReplyTo}，但它不在之前的 inbound 里（不错挂）：`
          + `「${excerptOf(event.text)}」`,
        eventIndexes: [index],
      });
      return;
    }
    const inboundAt = (events[inboundIndex] as InboundEvent).at;
    if (event.at < inboundAt) {
      violations.push({
        code: 'reply-misattached',
        detail: `回复 #${index}（at=${event.at}）早于它所挂的 inbound #${inboundIndex}（at=${inboundAt}）——时序倒挂：`
          + `「${excerptOf(event.text)}」`,
        eventIndexes: [index, inboundIndex],
      });
    }
  });

  return violations;
}

// ─────────────────────────────────────────────────────────────────────────────
// 归属补填（② 的前提）：宿主记账行的 factKind → 推送记录
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一条推送记录的归属槽位（与推送数组按下标对齐）。
 * `excluded` = 不是文字推送（如 write-loop 的 file_push 占位），补填时跳过。
 */
export interface DeliveryProvenanceTarget {
  taskId?: string;
  factKind?: TaskFactKind;
  excluded?: boolean;
}

/**
 * 从宿主结构化日志给推送记录补填投递归属（live 逐条调用；write-loop-scenarios 既有
 * taskId 补填的共享化）：`task_result_delivery_sent` 行在 deliverText 里紧跟 sendText
 * resolve 之后写出——那一刻「最近一条未归属的文字推送」就是这次投递的那条。只补 sent 行
 * （failed/suppressed = 用户没看到，不进对话形态面；带 factKind 与否都不补）。
 *
 * 返回的闭包供各面 logger 逐行调用；targets 是**活数组**（各面的推送数组或其平行数组）。
 */
export function createDeliveryProvenanceAttributor(
  targets: Array<DeliveryProvenanceTarget>,
): (line: Record<string, unknown>) => void {
  const stamped = new Set<number>();
  return (line) => {
    if (line['event'] !== 'task_result_delivery_sent') return;
    const taskId = line['taskId'];
    const factKind = line['factKind'];
    if (typeof taskId !== 'string' || typeof factKind !== 'string') return;
    for (let index = targets.length - 1; index >= 0; index -= 1) {
      if (stamped.has(index) || targets[index]!.excluded === true) continue;
      stamped.add(index);
      targets[index]!.taskId = taskId;
      targets[index]!.factKind = factKind as TaskFactKind;
      return;
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 回合面（write-loop / write-loop-scenarios / convergence-r1 同形）的事件流构造
// ─────────────────────────────────────────────────────────────────────────────

/** 回合面的一条用户回合（三个回合面共有的形状：回合号 + 用户原话 + 回复）。 */
export interface TurnStreamTurn {
  readonly index: number;
  readonly userText: string;
  readonly reply: string;
  /** 回合开始时刻（毫秒）；缺省用回合号（有推送时建议提供，保证流内排序正确）。 */
  readonly atMs?: number;
  /** 回合耗时（毫秒）；回复 at = atMs + durationMs。 */
  readonly durationMs?: number;
}

/** 回合面的一条推送（PushEvidence 形状子集；file_push / 未送达的由调用方过滤或标 excluded）。 */
export interface TurnStreamPush {
  readonly at: string | number;
  readonly text: string;
  readonly excluded?: boolean;
  readonly taskId?: string;
  readonly factKind?: TaskFactKind;
}

/**
 * 回合面的事件流：每条用户回合 = inbound + 同锚点线程回复（回合面里回复由 handler 同步
 * 返回，天然挂在本回合消息上）；推送 = delivery（归属已补填的带 provenance）。
 * 事件按 at 排序（稳定），保证「之前的 inbound」语义成立。
 */
export function buildTurnPushStream(
  turns: readonly TurnStreamTurn[],
  pushes: readonly TurnStreamPush[],
): ConversationEvent[] {
  const events: Array<{ at: number; event: ConversationEvent; order: number }> = [];
  turns.forEach((turn) => {
    const at = turn.atMs ?? turn.index;
    const messageId = `turn-${turn.index}`;
    events.push({ at, order: events.length, event: { kind: 'inbound', messageId, at, text: turn.userText } });
    const replyAt = turn.atMs === undefined ? turn.index : at + (turn.durationMs ?? 0);
    events.push({ at: replyAt, order: events.length, event: { kind: 'reply', inReplyTo: messageId, at: replyAt, text: turn.reply } });
  });
  pushes.forEach((push) => {
    if (push.excluded === true) return;
    const at = typeof push.at === 'number' ? push.at : Date.parse(push.at);
    const safeAt = Number.isFinite(at) ? at : 0;
    const provenance = push.taskId !== undefined && push.factKind !== undefined
      ? { taskId: push.taskId, factKind: push.factKind }
      : undefined;
    events.push({
      at: safeAt,
      order: events.length,
      event: { kind: 'delivery', at: safeAt, text: push.text, ...(provenance === undefined ? {} : { provenance }) },
    });
  });
  events.sort((left, right) => (left.at !== right.at ? left.at - right.at : left.order - right.order));
  return events.map((entry) => entry.event);
}

/** 把违规列表拼成一条可打印的失败信息（各面复用同一格式，不各自拼）。 */
export function formatShapeViolations(violations: readonly ShapeViolation[], header?: string): string {
  const lines = [header ?? '对话形态违规'];
  for (const violation of violations) {
    lines.push(`  [${violation.code}] ${violation.detail}`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 多会话批量判定（一个夹具里同时有单聊/群聊会话的面复用；会话之间互不参照）
// ─────────────────────────────────────────────────────────────────────────────

/** 一个会话的规范化流 + 任务名集合（groupPrivacy 见 CheckConversationShapeInput）。 */
export interface ConversationStreamSpec {
  readonly conversationId: string;
  readonly events: readonly ConversationEvent[];
  readonly taskNames?: readonly string[];
  readonly groupPrivacy?: boolean;
}

/** 批量判定结果（逐会话；违规为空 = 该会话绿）。 */
export interface ConversationStreamResult {
  readonly conversationId: string;
  readonly violations: ShapeViolation[];
}

/** 逐会话跑同一套四规则（同一实现，不按面复制）。 */
export function checkConversationStreams(specs: readonly ConversationStreamSpec[]): ConversationStreamResult[] {
  return specs.map((spec) => ({
    conversationId: spec.conversationId,
    violations: checkConversationShape({
      events: spec.events,
      ...(spec.taskNames === undefined ? {} : { taskNames: spec.taskNames }),
      ...(spec.groupPrivacy === undefined ? {} : { groupPrivacy: spec.groupPrivacy }),
    }),
  }));
}

/**
 * 回合面（write-loop / write-loop-scenarios / convergence-r1）的一步式判定：回合 + 推送 +
 * 任务名 → 违规列表。三个面共用同一实现（不许各自复制）。
 */
export function checkTurnFaceShape(
  turns: readonly TurnStreamTurn[],
  pushes: readonly TurnStreamPush[],
  taskNames?: readonly string[],
): ShapeViolation[] {
  return checkConversationShape({
    events: buildTurnPushStream(turns, pushes),
    ...(taskNames === undefined || taskNames.length === 0 ? {} : { taskNames }),
  });
}
