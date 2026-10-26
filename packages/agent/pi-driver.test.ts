import { describe, expect, it } from 'vitest';
import { KIMI_THINKING_LEVEL_MAP, createProviderToolNameMap, toAgentTool, plannerMessagesToLlm } from './src/pi-driver';
import type { DiscoveredTool } from '@fshine/contracts';
import { ToolUserError, type TurnDriverInput } from './src/driver';
import { createCompactionContextMessage } from './src/compaction-context';

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

  it('把历史引用 sidecar 作为明确的非直接陈述上下文投给模型，计数-only sidecar 不增用户内容', () => {
    const quoteSidecar = createCompactionContextMessage({
      version: 1,
      delegatedRequests: [{ requestKey: `request-v1:${'a'.repeat(64)}`, count: 2 }],
      quotedTurns: [{
        requestKey: `request-v1:${'a'.repeat(64)}`,
        bodyPreview: '这段是什么意思？',
        messageReference: { kind: 'text', text: '历史引用片段' },
      }],
      omittedQuotedTurns: 0,
    });
    const requestCountsOnly = createCompactionContextMessage({
      version: 1,
      delegatedRequests: [{ requestKey: `request-v1:${'b'.repeat(64)}`, count: 1 }],
      quotedTurns: [],
      omittedQuotedTurns: 0,
    });
    const converted = plannerMessagesToLlm([quoteSidecar, requestCountsOnly]);

    expect(converted).toHaveLength(1);
    expect(converted[0]?.role).toBe('user');
    expect(JSON.stringify(converted[0])).toContain('宿主压缩引用索引');
    expect(JSON.stringify(converted[0])).toContain('历史引用片段');
    expect(JSON.stringify(converted[0])).toContain('不是用户直接陈述');
    expect(JSON.stringify(converted[0])).not.toContain('request-v1:');
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

  it('ToolUserError 的委派标记只进 details，用户可见文本保持原样', async () => {
    const input = {
      exec: async () => {
        throw new ToolUserError('平台返回的用户可见话术', { delegationCompleted: true });
      },
      onStep: () => undefined,
    } as unknown as TurnDriverInput;
    const result = await toAgentTool({
      name: 'route_current_turn',
      description: 'route',
      inputSchema: { type: 'object', properties: {} },
    }, input, 'route_current_turn').execute('call_1', {});

    expect(result.content).toEqual([{ type: 'text', text: '平台返回的用户可见话术' }]);
    expect(result.details).toEqual({ routeReceipt: 'delegate' });
  });

  it('后台任务受理独立记账，不伪装成执行结果或前置失败', async () => {
    const input = {
      exec: async () => {
        throw Object.assign(new ToolUserError('任务已排队'), { routeReceipt: 'background' });
      },
      onStep: () => undefined,
    } as unknown as TurnDriverInput;
    const result = await toAgentTool({
      name: 'route_current_turn',
      description: 'route',
      inputSchema: { type: 'object' },
    }, input).execute('background_1', {});

    expect(result.terminate).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: '任务已排队' }]);
    expect(result.details).toEqual({ routeReceipt: 'background' });
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
 * 唯一位置。这里用生产函数驱动替身执行，钉住"内部工具不出帧"与"短语钳制"——
 * 空串进度帧会在渠道上投出一条空消息，所以 driver 侧必须整体跳过 onStep。
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

  it('宿主内部工具调用不发进度帧（默认帧与模型短语都不发）', async () => {
    for (const name of ['route_current_turn', 'search_history', 'get_messages']) {
      const { steps, input } = stepRecorder();
      const agentTool = toAgentTool(toolFor(name), input, name);
      // 模型照样可能自填 progress——内部工具对帧整体静默
      await agentTool.execute('call_1', { progress: '申报本轮动作' });
      expect(steps, name).toEqual([]);
    }
  });

  it('平台工具调用仍出帧：模型短语优先，泄漏/超长短语被钳制后回落默认帧', async () => {
    const clean = stepRecorder();
    await toAgentTool(toolFor('run_17dz_task'), clean.input, 'run_17dz_task')
      .execute('call_1', { progress: '查询往来记录' });
    expect(clean.steps).toEqual(['查询往来记录']);

    // 复读了协议材料 → 整条丢弃，回落到通用工具名帧
    const leaky = stepRecorder();
    await toAgentTool(toolFor('run_17dz_task'), leaky.input, 'run_17dz_task')
      .execute('call_1', { progress: '{"recorded":"delegate","step":"第 1/2 步"}' });
    expect(leaky.steps).toEqual(['正在调用 run_17dz_task…']);

    // 超长 → 截断到 50 字符
    const long = stepRecorder();
    const phrase = `正在核对${'x'.repeat(60)}`;
    await toAgentTool(toolFor('run_17dz_task'), long.input, 'run_17dz_task')
      .execute('call_1', { progress: phrase });
    expect(long.steps).toHaveLength(1);
    expect(long.steps[0]).toHaveLength(51);
    expect(long.steps[0]?.endsWith('…')).toBe(true);
  });
});
