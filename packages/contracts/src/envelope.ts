/**
 * 17dz MCP v0.5 信封与错误协议。
 * 真相来源:docs/17dz-mcp-spec.md §6.1(信封)、§9(错误协议)。
 */

export const ERROR_CODES = [
  'NEEDS_LOGIN',
  'PROFILE_BUSY',
  'ACCOUNT_SET_NOT_FOUND',
  'ACCOUNT_SET_AMBIGUOUS',
  'ACCOUNT_SET_FORBIDDEN',
  'CONTRACT_INVALID',
  'NEEDS_USER_INPUT',
  'NEEDS_APPROVAL',
  'NEEDS_HUMAN_TAKEOVER',
  'IDEMPOTENCY_CONFLICT',
  'EXECUTION_FAILED',
  'TIMEOUT',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** meta.source:数据来源(spec §6.1),host 据此判断结果新鲜度。 */
export type McpSource = 'api_cache' | 'api_live' | 'browser' | 'cache';

export interface EnvelopeMeta {
  traceId?: string;
  accountSetId?: string;
  accountSetName?: string;
  /** ISO 8601 含时区,如 2026-09-15T10:00:00+08:00 */
  retrievedAt: string;
  source: McpSource;
}

/** 失败现场材料引用(spec §9);V0 经部署共享卷按 id 取回,不发给学生用户。 */
export interface ErrorArtifact {
  id: string;
  kind: string;
  contentType: string;
}

export interface McpError {
  code: ErrorCode;
  /** 人类可读,fail-loud */
  message: string;
  retryable: boolean;
  /** retryable=true 时建议退避时长;PROFILE_BUSY 必带 */
  retryAfterMs?: number;
  details?: Record<string, unknown>;
  artifact?: ErrorArtifact;
}

export interface SuccessEnvelope<T = unknown> {
  data: T;
  meta: EnvelopeMeta;
}

export interface ErrorEnvelope {
  error: McpError;
  meta: EnvelopeMeta;
}

/** tools/call 成功与业务失败都走 content[0].text 的 JSON 信封;isError 仅是传输层标记。 */
export type Envelope<T = unknown> = SuccessEnvelope<T> | ErrorEnvelope;

export function isErrorEnvelope<T>(envelope: Envelope<T>): envelope is ErrorEnvelope {
  return 'error' in envelope;
}
