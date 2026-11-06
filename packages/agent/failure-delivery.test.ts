import { describe, expect, it } from 'vitest';
import {
  failureClassFor,
  deliverFailure,
  type ClassifiedFailure,
  type DeliverFailureInput,
  type DeliverFailureResult,
} from './src/failure-delivery';
import { RESOURCE_EXHAUSTED_CLASS } from './src/resource-exhausted';
import { toolUserErrorFor } from './src/error-codes';
import type { FailureClass } from '@fshine/contracts';

describe('failure-delivery：五类协议分类映射 + 宿主送达义务', () => {
  // ── 映射矩阵 ──────────────────────────────────────────────
  describe('failureClassFor：runtime 五档 → 协议五类', () => {
    const mapping: Array<{ input: ClassifiedFailure['subReason']; expected: FailureClass }> = [
      { input: 'cancelled', expected: 'NEEDS_INPUT' },
      { input: 'timeout', expected: 'RESOURCE_EXHAUSTED' },
      { input: 'model_transient', expected: 'PLATFORM_ERROR' },
      { input: 'auth', expected: 'PLATFORM_ERROR' },
      { input: 'executor_error', expected: 'PLATFORM_ERROR' },
    ];

    for (const { input, expected } of mapping) {
      it(`${input} → ${expected}`, () => {
        const result = failureClassFor(input);
        expect(result.protocolClass).toBe(expected);
        expect(result.subReason).toBe(input);
      });
    }

    it('未分类不离网：未知 runtime 档位记 unclassified（subReason 原样保留，protocolClass 降级为 PLATFORM_ERROR）', () => {
      const result = failureClassFor('unknown' as any);
      expect(result.protocolClass).toBe('PLATFORM_ERROR');
      expect(result.subReason).toBe('unknown');
    });
  });

  // ── 送达义务矩阵 ──────────────────────────────────────────
  describe('deliverFailure：五类各自的用户话术 + 审计字段', () => {
    const baseInput = (overrides: Partial<DeliverFailureInput> = {}): DeliverFailureInput => ({
      classification: { protocolClass: 'PLATFORM_ERROR', subReason: 'executor_error' },
      ...overrides,
    });

    it('NEEDS_INPUT：原样转达缺口，不改写不折损', () => {
      const result = deliverFailure(baseInput({
        classification: { protocolClass: 'NEEDS_INPUT', subReason: 'cancelled' },
        needs: { missing: ['date'], reason: '缺少日期', suggestion: '请提供日期' },
      }));
      expect(result.userMessage).toContain('缺少日期');
      expect(result.userMessage).toContain('date');
      expect(result.auditFields.protocolClass).toBe('NEEDS_INPUT');
      expect(result.auditFields.subReason).toBe('cancelled');
      expect(result.needsEnrichment).toBe(false);
    });

    it('CAPABILITY_UNAVAILABLE：能力边界消息（当前路径缺口，error-codes.ts 尚无独立条目）', () => {
      const result = deliverFailure(baseInput({
        classification: { protocolClass: 'CAPABILITY_UNAVAILABLE', subReason: 'executor_error' },
      }));
      expect(result.userMessage).toBe('当前能力不足以完成该请求。');
      expect(result.auditFields.protocolClass).toBe('CAPABILITY_UNAVAILABLE');
      expect(result.auditFields.gap).toBe('no_error_code_entry');
      expect(result.needsEnrichment).toBe(false);
    });

    it('PLATFORM_ERROR / auth：取 error-codes.ts 既有话术', () => {
      const result = deliverFailure(baseInput({
        classification: { protocolClass: 'PLATFORM_ERROR', subReason: 'auth' },
      }));
      expect(result.userMessage).toBe(toolUserErrorFor('DELEGATION_AUTH_FAILURE').message);
      expect(result.auditFields.code).toBe('DELEGATION_AUTH_FAILURE');
      expect(result.needsEnrichment).toBe(false);
    });

    it('PLATFORM_ERROR / model_transient：取 error-codes.ts 既有话术', () => {
      const result = deliverFailure(baseInput({
        classification: { protocolClass: 'PLATFORM_ERROR', subReason: 'model_transient' },
      }));
      expect(result.userMessage).toBe(toolUserErrorFor('DELEGATION_MODEL_TRANSIENT_FAILURE').message);
      expect(result.auditFields.code).toBe('DELEGATION_MODEL_TRANSIENT_FAILURE');
    });

    it('PLATFORM_ERROR / executor_error：取 error-codes.ts 既有话术', () => {
      const result = deliverFailure(baseInput({
        classification: { protocolClass: 'PLATFORM_ERROR', subReason: 'executor_error' },
      }));
      expect(result.userMessage).toBe(toolUserErrorFor('DELEGATION_EXECUTOR_FAILURE').message);
      expect(result.auditFields.code).toBe('DELEGATION_EXECUTOR_FAILURE');
    });

    it('RESOURCE_EXHAUSTED：复用 renderResourceExhaustedReply（缺底账时降级）', () => {
      const result = deliverFailure(baseInput({
        classification: { protocolClass: 'RESOURCE_EXHAUSTED', subReason: 'timeout' },
        doneSteps: ['step1'],
      }));
      expect(result.userMessage).toContain('已完成');
      expect(result.auditFields.protocolClass).toBe('RESOURCE_EXHAUSTED');
      expect(result.auditFields.subReason).toBe('timeout');
      // 缺底账时 needsEnrichment = false，降级为无事实版本。
      expect(result.needsEnrichment).toBe(false);
      expect(result.auditFields.degraded).toBe(true);
    });

    it('HARD_REJECTED：拒绝结果消息（当前路径缺口，error-codes.ts 尚无独立条目）', () => {
      const result = deliverFailure(baseInput({
        classification: { protocolClass: 'HARD_REJECTED', subReason: 'executor_error' },
      }));
      expect(result.userMessage).toBe('请求被执行层拒绝。');
      expect(result.auditFields.protocolClass).toBe('HARD_REJECTED');
      expect(result.auditFields.gap).toBe('no_error_code_entry');
      expect(result.needsEnrichment).toBe(false);
    });

    it('措辞纪律：本模块零内部词、零错误码硬编码（全部来自 error-codes.ts / resource-exhausted.ts）', () => {
      const src = require('fs').readFileSync(require('path').join(__dirname, 'src/failure-delivery.ts'), 'utf8');
      // 不允许出现 error-codes.ts 未导出的消息硬编码。
      const forbiddenLiterals = [
        '子任务已取消。',
        '平台响应超时，请稍后重试。',
        '模型服务瞬时中断，已自动重试仍未成功，请稍后再试。',
        '子任务执行失败，请稍后再试。',
        '平台登录态过期，需要重新登录后才能继续查询。',
      ];
      for (const literal of forbiddenLiterals) {
        expect(src).not.toContain(literal);
      }
    });
  });

  // ── 审计字段完整性 ────────────────────────────────────────
  describe('审计字段：protocolClass + subReason 必现，可归因', () => {
    for (const subReason of ['cancelled', 'timeout', 'model_transient', 'auth', 'executor_error'] as const) {
      it(`subReason=${subReason} 的审计字段含 protocolClass + subReason`, () => {
        const classification = failureClassFor(subReason);
        const result = deliverFailure({
          classification,
        });
        expect(result.auditFields.protocolClass).toBe(classification.protocolClass);
        expect(result.auditFields.subReason).toBe(subReason);
      });
    }
  });
});
