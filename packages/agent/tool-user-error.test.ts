import { describe, expect, it } from 'vitest';
import { ToolUserError } from './src/driver';

/**
 * ToolUserError 的存活契约（2026-11-12 申报层删除后）：
 * message = 面向用户的安全话术（driver 直接作为最终回复，不再喂回模型）；code = 码级
 * 判据（失败分类等）读取的挂码。原 routeReceipt / delegationCompleted 标记随
 * repeat-request 转录分析（唯一读者）整体删除——不再有写入方或读取方，字段与用例一并退役。
 */
describe('ToolUserError', () => {
  it('默认无码：message 即用户可见话术', () => {
    const error = new ToolUserError('平台返回的用户可见话术');
    expect(error.name).toBe('ToolUserError');
    expect(error.message).toBe('平台返回的用户可见话术');
    expect(error.code).toBeUndefined();
  });

  it('挂码：code 原样保留给码级判据（失败分类/拒绝路径）', () => {
    const error = new ToolUserError('taskId 为空或不是字符串。', { code: 'TASK_ID_INVALID' });
    expect(error.code).toBe('TASK_ID_INVALID');
  });
});
