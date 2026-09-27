/**
 * 平台契约适配层（platform-contract.ts）的码级判定测试（2026-09 第二波，任务3）。
 *
 * 这里是 fshine 仓库中唯一允许出现平台实现细节的模块，登录态判定也因此收口在
 * 这里：**码是数据，消息文案不是**——平台改文案不影响分类，新增登录态失败
 * 模式 = 往码集合里加一行。
 */
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_AUTH_ERROR_CODES,
  isPlatformAuthError,
  parseEnvelope,
  platformErrorCodeOf,
} from './src/platform-contract';

describe('平台登录态错误码集合（唯一适配层）', () => {
  it('覆盖 17dz 侧 AUTH_* 四档 + 脚本层归一码 NEEDS_LOGIN', () => {
    expect([...PLATFORM_AUTH_ERROR_CODES].sort()).toEqual([
      'AUTH_EXPIRED',
      'AUTH_REDIRECTED_TO_LOGIN',
      'AUTH_UNKNOWN',
      'AUTH_WORKBENCH_NOT_READY',
      'NEEDS_LOGIN',
    ]);
  });

  it('platformErrorCodeOf：挂码优先，其次消息的 CODE: 前缀（契约渲染格式）', () => {
    expect(platformErrorCodeOf(Object.assign(new Error('x'), { code: 'AUTH_EXPIRED' }))).toBe('AUTH_EXPIRED');
    expect(platformErrorCodeOf(new Error('AUTH_REDIRECTED_TO_LOGIN: 期望 …；实际 …；正确形态 …'))).toBe('AUTH_REDIRECTED_TO_LOGIN');
    // 信封的 error.code 经宿主侧载体传递时同样认码
    expect(platformErrorCodeOf({ error: { code: 'NEEDS_LOGIN', message: '…' } })).toBeNull();
    expect(platformErrorCodeOf({ code: 'NEEDS_LOGIN' })).toBe('NEEDS_LOGIN');
    // 纯自然语言（无码）→ null：交给上层过渡正则，不猜
    expect(platformErrorCodeOf(new Error('平台登录已过期，自动登录失败'))).toBeNull();
    expect(platformErrorCodeOf(new Error('科目编码不存在'))).toBeNull();
    expect(platformErrorCodeOf(null)).toBeNull();
  });

  it('isPlatformAuthError：只认集合内的码，其余一律 false', () => {
    expect(isPlatformAuthError(Object.assign(new Error('x'), { code: 'AUTH_EXPIRED' }))).toBe(true);
    expect(isPlatformAuthError(new Error('NEEDS_LOGIN: 请登录'))).toBe(true);
    expect(isPlatformAuthError(Object.assign(new Error('x'), { code: 'SUBJECT_NOT_FOUND' }))).toBe(false);
    expect(isPlatformAuthError(new Error('GATE_REFUSE: 期望 …'))).toBe(false);
    // 输入不足类码（纠错环用）不是登录态
    expect(isPlatformAuthError(new Error('INVALID_PERIOD: 期望 …'))).toBe(false);
  });

  it('信封解析不变：RESULT 信封的 error.code 是码级判据的源头', () => {
    const envelope = parseEnvelope('RESULT {"v":1,"op":"finance.query-receivables","status":"failed","data":null,"error":{"code":"AUTH_EXPIRED","message":"…"}}');
    expect(envelope?.error?.code).toBe('AUTH_EXPIRED');
    expect(isPlatformAuthError(envelope?.error)).toBe(true);
  });
});
