import { describe, expect, it } from 'vitest';
import { ToolUserError } from './src/driver';

describe('ToolUserError route receipt', () => {
  it('marks background acceptance without claiming the delegation completed', () => {
    const error = new ToolUserError('任务已受理。', { routeReceipt: 'background' });
    expect(error.routeReceipt).toBe('background');
    expect(error.delegationCompleted).toBe(false);
  });

  it('preserves the legacy delegationCompleted constructor mapping', () => {
    const error = new ToolUserError('已完成。', { delegationCompleted: true });
    expect(error.routeReceipt).toBe('delegate');
    expect(error.delegationCompleted).toBe(true);
  });

  it('allows an explicit precondition receipt', () => {
    const error = new ToolUserError('请补充信息。', { routeReceipt: 'precondition' });
    expect(error.routeReceipt).toBe('precondition');
    expect(error.delegationCompleted).toBe(false);
  });
});
