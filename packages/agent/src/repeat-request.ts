/**
 * 请求身份键（requestKey）：本会话内"用户说了什么"的稳定机械身份。
 *
 * 用途（2026-11-12 收窄后的 RR1 窄门）：用户把**完全相同**的一条请求再发一遍、而本轮
 * 没有任何新执行时，宿主用精确身份（requestKey 逐字相等，与任务条目里的快照对比）
 * 判定"这是已执行过的同一请求"，把历史答复替换掉——不允许历史结果冒充本轮结果。
 * 改写过的问句 = 不同身份，不拦（不新增业务语义分类器）。
 *
 * 判据全部来自宿主持有的确定性材料，**零领域知识**：
 *   · 归一化正文（剥掉宿主追加的附件路径后缀、折叠空白）；
 *   · 引用指纹（kind / 规范化文本 / 截断标记 / sourceMessageId 规范化后的投影）。
 *
 * 归一化的必要性（2026-10-19 真机实测）：同一条指令带 1 个文件和带 3 个文件时，
 * 宿主追加的附件路径后缀内容不同而用户意图完全相同，不剥就永远判不出同文。
 * 宿主侧注入的结构不该参与"用户说了什么"的判定。
 *
 * 2026-11-12 申报层正式删除：本模块原先还承载重复请求的转录分析（findRepeatedDelegatedRequest
 * / collectDelegatedRequestCounts 等，读者只有申报层的退回重填）——对象随申报工具一起删除；
 * 判据由 RR1 窄门（runtime 的精确身份读取 + turn-exit 的替换决策）承接。
 */
import { createHash } from 'node:crypto';
import type { TurnInputContext } from '@fshine/contracts';
import { normalizeMessageReference } from './message-reference';

/**
 * 宿主追加在用户消息尾部的附件路径后缀起始标记。
 *
 * 单一来源：`apps/server/handler.ts` 的 `withAttachmentPaths` 与这里的归一化共用一份。
 * 归一化必须先剥它——同一条指令带 1 个文件和带 3 个文件时后缀内容不同而用户意图
 * 完全相同（本次实测：16:06 带 1 个、16:10 带 3 个，指令一字不差），不剥就永远判不
 * 出同文。宿主侧注入的结构不该参与"用户说了什么"的判定。
 */
export const ATTACHMENT_PATHS_MARKER = '[本次消息附带的文件路径';

/** 归一化用户请求：剥掉宿主追加的附件路径后缀，折叠空白，去首尾空。 */
export function normalizeUserRequest(text: string): string {
  const cut = text.indexOf(ATTACHMENT_PATHS_MARKER);
  const head = cut === -1 ? text : text.slice(0, cut);
  return head.replace(/\s+/g, ' ').trim();
}

/** Stable body + quote key; with no quote the request still matches legacy body-only behavior. */
export function buildRequestKey(currentMessage: string, inputContext?: TurnInputContext): string {
  const request = normalizeUserRequest(currentMessage);
  const reference = normalizeMessageReference(inputContext?.messageReference);
  const payload = JSON.stringify({
    version: 1,
    request,
    messageReference: reference ? {
      kind: reference.kind,
      text: normalizeReferenceText(reference.text ?? ''),
      truncated: reference.truncated === true,
      ...(reference.sourceMessageId ? { sourceMessageId: reference.sourceMessageId } : {}),
    } : null,
  });
  return `request-v1:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

function normalizeReferenceText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
