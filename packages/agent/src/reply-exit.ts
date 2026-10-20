/**
 * 用户可见终稿的出口整理：两道都改"用户最终看到的那一版文本"的尺。
 *
 * 为什么单独一个模块：这两支原本散在 runtime.ts 的出口处，各自的判据住在别处
 * （`server-paths.ts` 的路径形状；本文件的数值溯源），凑在一起只是因为**作用点相同**——
 * 都是本回合出口、落库与上屏之前。合成一个纯函数后，runtime 只负责提供事实与打日志
 * （与 `turn-exit.ts` 同一分工：那边判"外发什么、记什么"，这边判"文本改成什么、记什么"）。
 *
 * 位置由调用点保证，不在这里：turn-exit 之后、`saveTranscript` 与上屏之前。转录、
 * Conversation Log、turn_span 看到的都是用户真正收到的那一版，三处不会各说各话。
 *
 * 两支都**不拦**（拦 = 整段替换成兜底话术）：该丢的只是用户没法用的那一截，数字与结论
 * 来自真实执行，整段扔掉比留着更糟。与 `conversation_unsourced_amounts` 一贯的判断——
 * 那道尺也只留痕。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
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
 * 顺序固定：先删路径，再扫金额（删完之后正文里剩的数字才是用户真正看到的数字）。
 */
export function sanitizeUserVisibleReply(input: ReplyExitInput): ReplyExitResult {
  const events: TurnExitEvent[] = [];
  const pathExit = sanitizeServerPathReply({ text: input.text, executed: input.executed });
  let text = pathExit.text;
  events.push(...pathExit.events);

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
