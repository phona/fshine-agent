/**
 * 返回给 runtime 前的结果预算闸门(17dz-mcp-spec §11.7)。
 *
 * 契约(对齐裁决 2026-09-17):数据准入由生产者的分页负责,用户通过上一页/下一页驱动;
 * 本层**不做静默裁剪**——超预算的结果是设计外状态,直接 fail-loud 返回错误指引,
 * 让模型改用分页参数;同时由调用方(host)记录告警,契约破坏必须可观测。
 * 原始信封留在 host 内(审计另存),不被修改。
 */
import type { ToolOutcome } from '@fshine/contracts';

export const RESULT_BUDGET_CHARS = 4000;

export function trimForRuntime(outcome: ToolOutcome, maxChars = RESULT_BUDGET_CHARS): ToolOutcome {
  if (!outcome.ok) return outcome; // 错误信封体积小,原样透传
  let json: string;
  try {
    json = JSON.stringify(outcome.data) ?? String(outcome.data);
  } catch {
    json = String(outcome.data);
  }
  if (json.length <= maxChars) return outcome;
  return {
    ok: false,
    error: {
      code: 'INTERNAL',
      message: `工具结果过大(${json.length} 字符 > 单页预算 ${maxChars}),已拒绝进入上下文。`
        + '请改用分页方式获取数据:list_vouchers 用 cursor 翻下一页/用 pageNo 回翻,或缩小查询范围(更具体的期间/科目/凭证号)。',
      retryable: false,
    },
    meta: outcome.meta,
  };
}
