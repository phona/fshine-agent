import { textFromContent, type TranscriptMessageLike } from './platform-contract';

/**
 * 本任务迄今的平台响应：会话转录里的 tool_result 正文（计划实体来源校验的第三个来源）。
 *
 * 为什么单独一个模块（而不是留在 pi-coding-driver 里）：`session-entities.ts` 的头部写着
 * "只认宿主持有的结构化底账，**绝不从结果原文/worker 文本解析**"——那是对**来源 A**（执行过
 * 的任务 calls 快照）的纪律。这里读的却是转录里的 tool_result 原文，两者判据相反、却服务同
 * 一道门禁。合并在同一个文件里，下一个人会删掉其中没有书面理由的那一个；分成两个文件，
 * 各自的律法写在各自头部，读者才不会把"该删哪一个"猜错。
 *
 * 与 `session-entities.ts` 的关系：那边产出**实体值**（结构化、有用户来源），这边产出
 * **响应原文**（平台说过的话）。两者都是 haystack 的材料，投影不同，不可互相替代。
 */

/**
 * 这条 tool_result 是不是**宿主自己拦下的那一跳**（D-086：按身份，不按 isError、不按文案）。
 *
 * `beforeToolCall` 返回 `{block:true, reason}` 时，SDK 会把 reason 合成一条
 * `isError:true` 的 tool_result 落进转录（agent-loop.js 的 createErrorToolResult +
 * createToolResultMessage）。那条正文是**宿主写的拒绝理由**，可能逐字带着 worker 刚提交的
 * 越权 token——把它收进 haystack，"先故意提一个越权实体、拿到拒绝理由、再原样提一次"就能过
 * 实体门（2026-10-14 实证：改前这一跳确实放行）。
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
 * 转录通道：会话里现存的全部 tool_result 正文，不含宿主自己拦下的那些。
 *
 * 条数不设上限——上限由任务自己的形状给（平台预算门 + 执行超时；42 个历史验收库里单请求的
 * tool_call 数 9…87）。早先这里取"最后 N 条"，早期响应里确立的实体会静默滑出判定材料。
 */
export function transcriptPlatformResponses(
  messages: readonly TranscriptMessageLike[],
  blockedToolCallIds: ReadonlySet<string> = new Set(),
): string[] {
  const responses: string[] = [];
  for (const message of messages) {
    if (message?.role !== 'toolResult') continue;
    if (isHostBlocked(message, blockedToolCallIds)) continue;
    const text = textFromContent(message.content);
    if (text.trim()) responses.push(text);
  }
  return responses;
}
