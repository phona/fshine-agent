import { describe, expect, it } from 'vitest';
import { KIMI_THINKING_LEVEL_MAP, createProviderToolNameMap, toAgentTool, plannerMessagesToLlm } from './src/pi-driver';
import type { DiscoveredTool } from '@fshine/contracts';
import { ToolUserError, type TurnDriverInput } from './src/driver-contract';

describe('Pi driver safety helpers', () => {
  it('把宿主任務事件和任务清单转换给真实模型，同时保留原生转录中的 custom 来源', () => {
    const event = { role: 'custom', customType: 'background_task_event', content: '宿主事件：原始请求A与执行结果', timestamp: 1 };
    const roster = { role: 'custom', customType: 'background_task_roster', content: '正在运行的任务A', timestamp: 2 };
    const user = { role: 'user', content: '现在做到哪了？', timestamp: 3 };
    const converted = plannerMessagesToLlm([event, roster, user] as never);
    expect(converted.map((message) => message.role)).toEqual(['user', 'user', 'user']);
    expect(JSON.stringify(converted)).toContain('原始请求A与执行结果');
    expect(JSON.stringify(converted)).toContain('正在运行的任务A');
    expect(event.role).toBe('custom');
    expect(converted[2]).toBe(user);
  });

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

    const agentTool = toAgentTool(tool, input, 'workflow_start');
    await agentTool.execute('call_1', { accountSetId: 'as_003', progress: '启动工作流' });

    expect(calls).toEqual([{ tool: 'workflow.start', args: { accountSetId: 'as_003' } }]);
  });

  it('ToolUserError 终结语义：用户可见文本原样、terminate=true，不进任何宿主标记', async () => {
    const input = {
      exec: async () => {
        throw new ToolUserError('平台返回的用户可见话术');
      },
      onStep: () => undefined,
    } as unknown as TurnDriverInput;
    const result = await toAgentTool({
      name: 'run_task',
      description: 'delegate',
      inputSchema: { type: 'object', properties: {} },
    }, input, 'run_task').execute('call_1', {});

    expect(result.terminate).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: '平台返回的用户可见话术' }]);
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

/**
 * 进度帧的生产接线（F6）：toAgentTool 是 driver 构造原生工具并调用 onStep 的
 * 唯一位置。这里用生产函数驱动替身执行，钉住"协议材料短语整条丢弃"与"短语钳制"——
 * 空串进度帧会在渠道上投出一条空消息，所以判据必须由 renderToolStepText 一处给出。
 */
describe('Pi driver 进度帧接线', () => {
  function stepRecorder() {
    const steps: string[] = [];
    const input = {
      exec: async () => ({ ok: true }),
      onStep: (text: string) => { steps.push(text); },
    } as unknown as TurnDriverInput;
    return { steps, input };
  }

  function toolFor(name: string): DiscoveredTool {
    return { name, description: name, inputSchema: { type: 'object', properties: {} } };
  }

  it('平台工具调用仍出帧：模型短语优先，泄漏/超长短语被钳制后回落默认帧', async () => {
    const clean = stepRecorder();
    await toAgentTool(toolFor('run_task'), clean.input, 'run_task')
      .execute('call_1', { progress: '查询往来记录' });
    expect(clean.steps).toEqual(['查询往来记录']);

    // 复读了协议材料 → 整条丢弃，回落到通用工具名帧
    const leaky = stepRecorder();
    await toAgentTool(toolFor('run_task'), leaky.input, 'run_task')
      .execute('call_1', { progress: '{"recorded":"delegate","step":"第 1/2 步"}' });
    expect(leaky.steps).toEqual(['正在调用 run_task…']);

    // 超长 → 截断到 50 字符
    const long = stepRecorder();
    const phrase = `正在核对${'x'.repeat(60)}`;
    await toAgentTool(toolFor('run_task'), long.input, 'run_task')
      .execute('call_1', { progress: phrase });
    expect(long.steps).toHaveLength(1);
    expect(long.steps[0]).toHaveLength(51);
    expect(long.steps[0]?.endsWith('…')).toBe(true);
  });
});
