import { describe, expect, it } from 'vitest';
import { boundedToolResult, KIMI_THINKING_LEVEL_MAP } from './src/pi-driver';

describe('Pi driver safety helpers', () => {
  it('bounds serialized tool output and marks truncation', () => {
    const result = boundedToolResult({ docs: ['x'.repeat(100)] }, 40);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toContain('结果已截断');
  });

  it('does not opt into unsupported Kimi extended thinking levels', () => {
    expect(KIMI_THINKING_LEVEL_MAP.low).toBe('low');
    expect(KIMI_THINKING_LEVEL_MAP.medium).toBe('medium');
    expect(KIMI_THINKING_LEVEL_MAP.high).toBe('high');
    expect(KIMI_THINKING_LEVEL_MAP.xhigh).toBeNull();
    expect(KIMI_THINKING_LEVEL_MAP.max).toBeNull();
  });
});
