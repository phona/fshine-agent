/**
 * McpError → 用户可懂话术(架构 §6)。
 * 红线:绝不透出 message 原文里的堆栈、路径、凭据或越权数据,统一安全话术。
 */
import type { McpError } from '@fshine/contracts';
import { parseAccountSetArray } from './session';

export const NEEDS_LOGIN_MESSAGE = '系统登录需要处理,暂时无法查询,请稍后再试';

export function toUserMessage(error: McpError): string {
  switch (error.code) {
    case 'NEEDS_LOGIN':
      return NEEDS_LOGIN_MESSAGE;
    case 'ACCOUNT_SET_FORBIDDEN':
      // 不重试、不透露范围外的任何账套信息
      return '没有该账套的访问权限';
    case 'ACCOUNT_SET_AMBIGUOUS':
      return ambiguousMessage(error);
    case 'NEEDS_USER_INPUT':
      return needsUserInputMessage(error);
    case 'PROFILE_BUSY':
    case 'TIMEOUT':
      return '系统繁忙,请稍后再试';
    default:
      return '查询失败,请稍后再试或联系管理员';
  }
}

function ambiguousMessage(error: McpError): string {
  const candidates = parseAccountSetArray(error.details?.candidates);
  if (candidates.length > 0) {
    const list = candidates.map((candidate, index) => `${index + 1}. ${candidate.name}`).join(' ');
    return `匹配到多个账套,请回复编号选择:${list}`;
  }
  return '匹配到多个账套,请告知更具体的账套名称';
}

function needsUserInputMessage(error: McpError): string {
  const needs = error.details?.needs;
  if (typeof needs === 'string' && needs.trim()) {
    return `还需要补充信息:${needs}`;
  }
  if (Array.isArray(needs) && needs.length > 0) {
    const items = needs.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('、');
    return `还需要补充信息:${items}`;
  }
  return '查询还需要补充一些信息,请补充后重试';
}
