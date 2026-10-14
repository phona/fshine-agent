import { parseEnvelope, textFromContent, type PlatformEnvelope, type TranscriptMessageLike } from './platform-contract';
import { cleanEntityValue, dedupe } from './session-entities';

/**
 * 平台证据的两个通道（D-085）。
 *
 * 为什么单独一个模块（而不是留在 pi-coding-driver 里）：`session-entities.ts` 的头部写着
 * "只认宿主持有的结构化底账，**绝不从结果原文/worker 文本解析**"——那是对**来源 A**（执行过
 * 的任务 calls 快照）的纪律。这里读的却是转录里的 tool_result 原文，两者判据相反、却服务同
 * 一道门禁。合并在同一个文件里，下一个人会删掉其中没有书面理由的那一个；分成两个文件，
 * 各自的律法写在各自头部，读者才不会把"该删哪一个"猜错。
 *
 * 与 `session-entities.ts` 的关系：那边产出**实体值**（结构化、有用户来源），这边产出
 * **响应原文 + 信封叶值**（平台说过的话）。两者都是 haystack 的材料，投影不同，不可互相替代。
 * 取值卫生（`cleanEntityValue` / `dedupe` / `ENTITY_VALUE_MAX_CHARS`）从那边导入——同一把尺，
 * 不写第二份。
 */

/** 本任务迄今的平台证据：原文与结构化实体值（同一批响应的两种投影）。 */
export interface TaskPlatformSources {
  responses: string[];
  entities: string[];
}

/**
 * 这条 tool_result 是不是**宿主自己拦下的那一跳**（D-086：按身份，不按 isError、不按文案）。
 *
 * `beforeToolCall` 返回 `{block:true, reason}` 时，SDK 会把 reason 合成一条
 * `isError:true` 的 tool_result 落进转录（agent-loop.js 的 createErrorToolResult +
 * createToolResultMessage）。那条正文是**宿主写的拒绝理由**，可能逐字带着 worker 刚提交的
 * 越权 token——把它收进 haystack，"先故意提一个越权实体、拿到拒绝理由、再原样提一次"就能过
 * 实体门（2026-10-14 驱动级实证：改前第二次提交确实放行）。
 *
 * 三个被判据依次排除的做法及理由：
 *   · **按 `isError` 过滤 —— 不行**。SDK 的 bash 工具在退出码非零时 throw，平台 CLI exit 3
 *     的真错误信封同样以 `isError:true` 落在转录里。按它过滤会把真平台证据一起删掉，制造新
 *     的假拒（与 D-085 同向的另一个标定错误）。
 *   · **按协议前缀嗅探文案 —— 不行**。那是从结果原文猜语义，且要维护一份跟着每个新裁决
 *     （PLAN DECLINED/STOP/ACTIVE/NEEDS_USER_CONFIRM/PAUSED、提案三态、门拒绝…）增长的名单；
 *     平台响应只要引用了宿主的一句话就能绕过。
 *   · **按 `toolCallId` 身份 —— 就是这一条**。宿主在拦下的那一刻记下 id，收集时逐条排除。
 *     判据是"这一跳是不是我拦的"这个事实，不是对内容的任何猜测。
 */
function isHostBlocked(message: TranscriptMessageLike, blockedToolCallIds: ReadonlySet<string>): boolean {
  const id = message.toolCallId;
  return typeof id === 'string' && id.length > 0 && blockedToolCallIds.has(id);
}

/**
 * 信封 `data` 的字符串叶（递归数组 / 对象）。
 *
 * **只取 `data`，不取 `error`**：`error.message` 是给人看的一句解释、`error.correctForm`
 * 是平台的改法指引，两者都不是"平台确立的值"。把解释性文案算成实体来源，等于让任意一句
 * 平台错误消息把自己的文本送进 haystack。
 *
 * 取值卫生复用 `session-entities` 的那把尺（剥引号、超长值丢弃）：实体名是短字段，
 * 超过 40 字符的形状不是实体名。
 */
function dataLeaves(envelope: PlatformEnvelope): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      const cleaned = cleanEntityValue(node);
      if (cleaned) out.push(cleaned);
      return;
    }
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (node && typeof node === 'object') { for (const value of Object.values(node)) walk(value); }
  };
  walk(envelope.data);
  return out;
}

/** 一条 tool_result 正文的两路投影：原文照收，能解析出信封就再收一份结构化叶值。 */
function project(text: string): TaskPlatformSources {
  const envelope = parseEnvelope(text);
  return {
    responses: [text],
    entities: envelope?.data ? dataLeaves(envelope) : [],
  };
}

/**
 * 转录通道：会话里现存的全部 tool_result，不含宿主自己拦下的那些。
 *
 * 条数不设上限——上限由任务自己的形状给（平台预算门 + 执行超时；42 个历史验收库里单请求的
 * tool_call 数 9…87）。早先这里取"最后 N 条"，早期响应里确立的实体会静默滑出判定材料，
 * 而 `turn-contract.ts` 的注释点名要支持的正是"名称检索拿到唯一候选、再按候选名查"。
 */
export function transcriptPlatformSources(
  messages: readonly TranscriptMessageLike[],
  blockedToolCallIds: ReadonlySet<string> = new Set(),
): TaskPlatformSources {
  const responses: string[] = [];
  const entities: string[] = [];
  for (const message of messages) {
    if (message?.role !== 'toolResult') continue;
    if (isHostBlocked(message, blockedToolCallIds)) continue;
    const text = textFromContent(message.content);
    if (!text.trim()) continue;
    const projected = project(text);
    responses.push(...projected.responses);
    entities.push(...projected.entities);
  }
  return { responses, entities: dedupe(entities) };
}

/**
 * 账本通道（压缩免疫）：宿主在 `afterToolCall` 上记下每一条**执行完**的工具结果。
 *
 * 为什么不能只读转录：SDK 默认开自动压缩（`DEFAULT_COMPACTION_SETTINGS`，阈值 =
 * contextWindow − reserveTokens），一到阈值 `agent.state.messages` 被换成
 * `[压缩摘要] + [保留尾段]`，`firstKeptEntryId` 之前的 tool_result 整条消失
 * （session-manager 的 buildContextEntries）。单请求 87 次 tool_call 的长任务必然触发，
 * 只读转录等于把"本任务迄今"偷偷换成"压缩后还剩多少"。
 *
 * 顺带第二道保证：SDK **不给被拦下的调用调 afterToolCall**（agent-loop 的
 * finalizeExecutedToolCall 只跑在执行路径上），所以这个通道结构上不可能含宿主拒绝文本。
 */
export interface TaskPlatformRecorder {
  record(content: unknown): void;
  snapshot(): TaskPlatformSources;
}

export function createTaskPlatformRecorder(): TaskPlatformRecorder {
  const responses: string[] = [];
  const entities: string[] = [];
  return {
    record(content) {
      const text = textFromContent(content);
      if (!text.trim()) return;
      const projected = project(text);
      responses.push(...projected.responses);
      entities.push(...projected.entities);
    },
    snapshot() {
      return { responses: [...responses], entities: dedupe(entities) };
    },
  };
}

/**
 * 两通道合并去重（与 `mergeSessionEntities` 同族）：同一份响应在转录和账本里各出现一次时
 * 只判一次。实体值并集去重保序。
 */
export function mergeTaskPlatformSources(...groups: TaskPlatformSources[]): TaskPlatformSources {
  const seen = new Set<string>();
  const responses: string[] = [];
  const entities: string[] = [];
  for (const group of groups) {
    for (const text of group.responses) {
      if (seen.has(text)) continue;
      seen.add(text);
      responses.push(text);
    }
    entities.push(...group.entities);
  }
  return { responses, entities: dedupe(entities) };
}
