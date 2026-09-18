import { describe, expect, it } from 'vitest';
import { KIMI_THINKING_LEVEL_MAP, createProviderToolNameMap, toAgentTool } from './src/pi-driver';
import type { DiscoveredTool } from '@fshine/contracts';
import type { TurnDriverInput } from './src/driver';

describe('Pi driver safety helpers', () => {
  it('does not opt into unsupported Kimi extended thinking levels', () => {
    expect(KIMI_THINKING_LEVEL_MAP.low).toBe('low');
    expect(KIMI_THINKING_LEVEL_MAP.medium).toBe('medium');
    expect(KIMI_THINKING_LEVEL_MAP.high).toBe('high');
    expect(KIMI_THINKING_LEVEL_MAP.xhigh).toBeNull();
    expect(KIMI_THINKING_LEVEL_MAP.max).toBeNull();
  });

  it('maps domain tool names with dots to provider-safe names while preserving valid names', () => {
    const tools: DiscoveredTool[] = [
      { name: 'workflow.start', description: 'start', inputSchema: { type: 'object' } },
      { name: 'search_references', description: 'search', inputSchema: { type: 'object' } },
    ];

    const names = createProviderToolNameMap(tools);

    expect(names.get('workflow.start')).toBe('workflow_start');
    expect(names.get('search_references')).toBe('search_references');
    for (const name of names.values()) {
      expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });

  it('avoids collisions between rewritten and already-valid names', () => {
    const tools: DiscoveredTool[] = [
      { name: 'workflow_start', description: 'existing', inputSchema: { type: 'object' } },
      { name: 'workflow.start', description: 'rewritten', inputSchema: { type: 'object' } },
    ];

    const names = createProviderToolNameMap(tools);

    expect(names.get('workflow_start')).toBe('workflow_start');
    expect(names.get('workflow.start')).not.toBe('workflow_start');
    expect(names.get('workflow.start')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('restores the original domain tool name when the provider-safe tool executes', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const input = {
      exec: async (tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args });
        return { ok: true };
      },
      onStep: () => undefined,
    } as unknown as TurnDriverInput;
    const tool: DiscoveredTool = {
      name: 'workflow.start',
      description: 'start',
      inputSchema: { type: 'object', properties: {} },
    };

    const agentTool = toAgentTool(tool, input, new Map(), 'workflow_start');
    await agentTool.execute('call_1', { accountSetId: 'as_003', progress: '启动工作流' });

    expect(calls).toEqual([{ tool: 'workflow.start', args: { accountSetId: 'as_003' } }]);
  });

  it('keeps long and non-ASCII domain tool names within provider limits', () => {
    const original = `${'超长工具名'.repeat(20)}.start`;
    const names = createProviderToolNameMap([{
      name: original,
      description: 'long',
      inputSchema: { type: 'object' },
    }]);
    const providerName = names.get(original)!;

    expect(providerName).toHaveLength(64);
    expect(providerName).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
