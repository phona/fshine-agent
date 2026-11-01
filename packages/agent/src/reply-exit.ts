/**
 * 用户可见终稿的出口整理：几道都改"用户最终看到的那一版文本"的尺。
 *
 * 为什么单独一个模块：这些支原本散在 runtime.ts 的出口处，各自的判据住在别处
 * （`server-paths.ts` 的路径形状；本文件的数值溯源；`protocol-material.ts` 的申报形状），
 * 凑在一起只是因为**作用点相同**——都是本回合出口、落库与上屏之前。合成一个纯函数后，
 * runtime 只负责提供事实与打日志（与 `turn-exit.ts` 同一分工：那边判"外发什么、记什么"，
 * 这边判"文本改成什么、记什么"）。
 *
 * 位置由调用点保证，不在这里：turn-exit 之后、`saveTranscript` 与上屏之前。转录、
 * Conversation Log、turn_span 看到的都是用户真正收到的那一版，三处不会各说各话。
 *
 * 默认**不拦**（拦 = 整段替换成兜底话术）：该丢的只是用户没法用的那一截，数字与结论
 * 来自真实执行，整段扔掉比留着更糟。与 `conversation_unsourced_amounts` 一贯的判断——
 * 那道尺也只留痕。唯一例外是"整段=申报"（D-144）：整段都是申报结构时正文里没有任何
 * 用户可用的内容（标签是协议、参数值是申报字段），替换才有信息量——fallback 由调用方
 * 给（手里有真实执行产物时用它），整段协议删完无内容时沿用格式异常兜底。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { EXECUTION_LANGUAGE_SCRUB_PATTERNS } from './execution-language';
import { isWholeReplyRouteDeclaration } from './protocol-material';
import { stripServerPaths } from './server-paths';
import type { TurnExitEvent } from './turn-exit';

export interface ReplyExitInput {
  /** 模型本回合产出的文本（或纠错环/计划步骤的转达文本）。 */
  text: string;
  /**
   * 本轮是否真执行过（含在跑的计划步骤）：数值溯源探查只在零执行时做。
   * 有执行痕迹的轮次，数字天然有出处——模型做算术产生的新数值也不是问题。
   */
  executed: boolean;
  /**
   * 数值溯源的证据集（懒取）：历史转录 + 检索证据 + 当前消息。
   * 零执行且正文里没有千分位金额时根本不构造——多数回合不走这条。
   */
  evidence: () => string;
  /** 纠错环已进行的轮数（只进日志：同一条告警要能看出是不是回路里的轮次）。 */
  needsRounds: number;
  /**
   * 整段=申报被替换时优先使用的文本（D-144）：调用方手里真实的执行产物（如 worker
   * 整理文本）。缺省/为空 = 格式异常兜底话术（与整段协议删完无内容同一兜底）。
   */
  declarationFallback?: string;
}

export interface ReplyExitResult {
  /** 整理后的文本（两支都没命中时与输入同一引用）。 */
  text: string;
  /** 这一路要打的日志，顺序即打点顺序（级别由各支自己定）。 */
  events: readonly TurnExitEvent[];
}

export interface ServerPathExitInput {
  text: string;
  /** Omit when the direct exit cannot establish whether platform execution happened. */
  executed?: boolean;
}

/**
 * 千分位小数格式的金额（`123,456.78` / `1,000`）。
 *
 * 只认这种格式：它不可能由口语自然产生（用户不会打千分位），出现即说明模型在复述某个
 * 结构化数字——那它就该在证据里逐字找得到。判据与取舍见文件头。
 */
const THOUSANDS_AMOUNT_PATTERN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?/g;

/**
 * 出口整理。**纯函数**：不抛异常、不打日志、不碰存储——只回答"文本改成什么、记什么事件"。
 *
 * 顺序固定：先删路径，再拦整段=申报（D-144 第三形态——申报参数本身是自然语言，删除式
 * 救不了，只能整段替换，且要先于删除支判定：删了标签整段形状就认不出了），再删执行语言
 * （协议标记/错误码——删完之后正文里剩的才是用户真正看到的），最后扫金额（判据因此不受
 * 被删内容干扰）。
 */
export function sanitizeUserVisibleReply(input: ReplyExitInput): ReplyExitResult {
  const events: TurnExitEvent[] = [];
  const pathExit = sanitizeServerPathReply({ text: input.text, executed: input.executed });
  let text = pathExit.text;
  events.push(...pathExit.events);
  const declarationExit = replaceDeclarationReply(text, input.declarationFallback);
  if (declarationExit) return { text: declarationExit.text, events: [...events, ...declarationExit.events] };
  const scrubExit = scrubExecutionLanguageReply(text);
  text = scrubExit.text;
  events.push(...scrubExit.events);

  // 数值溯源探查：零执行轮次的回复若含千分位金额，而该数值在证据里逐字找不到，记一条
  // 告警。为什么不拦：模型对真实数字做算术（对比/合计）会产生新数值，宿主无法在"算术"
  // 与"编造"之间做确定性区分——那道线由探针与人工守，这里只让运维看得见。
  if (input.executed) return { text, events };
  const amounts = new Set<number>();
  for (const match of text.matchAll(THOUSANDS_AMOUNT_PATTERN)) {
    amounts.add(Number(match[0].replace(/,/g, '')));
  }
  if (amounts.size === 0) return { text, events };
  const haystack = input.evidence();
  const unsourced = [...amounts].filter(
    (value) => !haystack.includes(String(value)) && !haystack.includes(value.toLocaleString('en-US')),
  );
  if (unsourced.length === 0) return { text, events };
  events.push({
    level: 'warn',
    event: 'conversation_unsourced_amounts',
    detail: { count: unsourced.length, needsRounds: input.needsRounds },
  });
  return { text, events };
}

/** Path-only variant for direct exits, which do not run amount provenance checks. */
export function sanitizeServerPathReply(input: ServerPathExitInput): ReplyExitResult {
  const paths = stripServerPaths(input.text);
  if (paths.removed === 0) return { text: input.text, events: [] };
  return {
    text: paths.text,
    events: [{
      level: 'warn',
      event: 'server_path_leak',
      detail: { removed: paths.removed, ...(input.executed === undefined ? {} : { executed: input.executed }) },
    }],
  };
}

/** 整段都是协议原文时（删完剩不下可读内容）的兜底——格式异常的可行动话术。 */
const FORMAT_ANOMALY_FALLBACK = '这条回复的格式出现了异常，请重发你的问题或换个说法。';

/**
 * 整段=申报（D-144 第三形态，判据在 protocol-material.ts 的 isWholeReplyRouteDeclaration）
 * 的整段替换：**不是删标签**——申报参数（continueTaskId/request/progress）携带自然语言，
 * 删完标签正文里剩的就是申报字段的值，删除式救不了。替换优先调用方给的真实执行产物，
 * 缺省用格式异常兜底。未命中返回 null（调用方继续走删除支）。
 */
function replaceDeclarationReply(text: string, fallback?: string): ReplyExitResult | null {
  const form = isWholeReplyRouteDeclaration(text);
  if (!form) return null;
  return {
    text: fallback?.trim() || FORMAT_ANOMALY_FALLBACK,
    events: [{
      level: 'warn',
      event: 'route_declaration_reply_replaced',
      detail: { form, replacedLength: text.length },
    }],
  };
}

/**
 * direct 出口的终稿一把尺（D-144 出口收敛）：与 sanitizeUserVisibleReply 同一判据链的前
 * 三步——删路径、整段=申报替换、删执行语言——只缺数值溯源。direct 出口（finishDirectReply
 * 等）的文本是宿主/适配器合成或平台确定性给出的，不是本轮模型自由产出，"模型编造金额"
 * 的探查不适用（§22 的 direct 分工保留；删除支与申报替换按 D-144 收敛并入——direct 出口
 * 此前只删路径，经它直达终稿的模型/平台文本零检测）。
 */
export function sanitizeDirectExitReply(input: ServerPathExitInput): ReplyExitResult {
  const events: TurnExitEvent[] = [];
  const pathExit = sanitizeServerPathReply(input);
  let text = pathExit.text;
  events.push(...pathExit.events);
  const declarationExit = replaceDeclarationReply(text);
  if (declarationExit) return { text: declarationExit.text, events: [...events, ...declarationExit.events] };
  const scrubExit = scrubExecutionLanguageReply(text);
  text = scrubExit.text;
  events.push(...scrubExit.events);
  return { text, events };
}

/**
 * 执行语言删除（D-136/D-138）：判据在 execution-language.ts 的 SCRUB_PATTERNS（只收
 * 零争议形态）。删标记留其余——与删路径同纪律，该丢的只是用户没法用的那一截；删完
 * 剩不下可读内容时（整段都是协议）替换为兜底话术，不给用户一个空气泡。
 */
function scrubExecutionLanguageReply(text: string): ReplyExitResult {
  let tokens = 0;
  const labels: string[] = [];
  let scrubbed = text;
  for (const { label, pattern, whitelist } of EXECUTION_LANGUAGE_SCRUB_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, (matched) => {
      if (whitelist?.has(matched)) return matched;
      tokens += 1;
      if (!labels.includes(label)) labels.push(label);
      return '';
    });
  }
  if (tokens === 0) return { text, events: [] };
  // 整段协议的判定：标签删完后还有参数值残渣（"delegate" 之类 ASCII 标识符），
  // 但那不是给用户读的——以剩余的**非 ASCII 字符数**（中文等自然语言内容）< 4
  // 判"没有可读内容"，替换为兜底话术，不给用户一个只有残渣的气泡。
  const readableChars = [...scrubbed].filter((ch) => ch.codePointAt(0)! > 0x7f).length;
  if (readableChars < 4) {
    return {
      text: FORMAT_ANOMALY_FALLBACK,
      events: [{ level: 'warn', event: 'execution_language_scrubbed', detail: { labels, tokens } }],
    };
  }
  return {
    text: scrubbed,
    events: [{ level: 'warn', event: 'execution_language_scrubbed', detail: { labels, tokens } }],
  };
}

/**
 * Remove server paths from model and tool messages before saving the Pi transcript.
 * User messages stay byte-for-byte intact: a path supplied by the user is input, not
 * an assistant generated leak.  The returned array keeps message identity when no
 * path was found so the normal save path remains cheap.
 */
export function sanitizeTranscriptMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    const role = (message as { role?: unknown }).role;
    if (role !== 'assistant' && role !== 'toolResult') return message;
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
      const stripped = stripServerPaths(content);
      return stripped.removed > 0 ? ({ ...message, content: stripped.text } as AgentMessage) : message;
    }
    if (!Array.isArray(content)) return message;
    let changed = false;
    const sanitized = content.map((part) => {
      if (!part || typeof part !== 'object' || typeof (part as { text?: unknown }).text !== 'string') return part;
      const stripped = stripServerPaths((part as { text: string }).text);
      if (stripped.removed === 0) return part;
      changed = true;
      return { ...(part as Record<string, unknown>), text: stripped.text };
    });
    return changed ? ({ ...message, content: sanitized } as AgentMessage) : message;
  });
}
