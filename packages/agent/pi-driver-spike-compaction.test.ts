import { describe, expect, it, vi } from 'vitest';

/**
 * SPIKE 通用模式：压缩只跳过宿主 sidecar，pi 原生摘要 + 保留尾巴照跑。
 *
 * 这里把 generateSummary 与 sidecar 两个函数换成可计数的替身：摘要替身让紧凑路径
 * 不起网络，sidecar 替身保留真实实现、只加调用计数——断言打开时两个函数都是零调用，
 * 关闭时各一次，且两臂保留的尾巴完全相同。
 */
vi.mock('@earendil-works/pi-agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-agent-core')>();
  return {
    ...actual,
    generateSummary: vi.fn(async () => ({ ok: true as const, value: 'SPIKE-摘要' })),
  };
});

vi.mock('./src/compaction-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./src/compaction-context')>();
  return {
    ...actual,
    buildCompactionContextSidecar: vi.fn(actual.buildCompactionContextSidecar),
    compactedTranscriptWithContext: vi.fn(actual.compactedTranscriptWithContext),
  };
});

import { generateSummary, type AgentMessage } from '@earendil-works/pi-agent-core';
import { createPiTurnDriver } from './src/pi-driver';
import { buildCompactionContextSidecar, compactedTranscriptWithContext, COMPACTION_CONTEXT_MESSAGE_TYPE } from './src/compaction-context';
import { SPIKE_GENERIC_MODE_ENV } from './src/spike-generic-mode';

const BASE_ENV = {
  LLM_API_BASE_URL: 'http://127.0.0.1:9/v1',
  LLM_API_KEY: 'spike-test-key',
  LLM_MODEL: 'spike-test-model',
};

/** 100k 字符 ≈ 25k token，三条保证保留尾巴之外的头部至少含第一条引用消息。 */
function longUser(tag: string, withQuote: boolean): AgentMessage {
  return {
    role: 'user',
    content: `${tag} ${'x'.repeat(100_000)}`,
    timestamp: 1,
    ...(withQuote ? { hostContext: { messageReference: { kind: 'text', text: '历史引用片段' } } } : {}),
  } as unknown as AgentMessage;
}

function longAssistant(tag: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: `${tag} ${'y'.repeat(100_000)}` }],
    timestamp: 2,
    api: 'openai-completions',
    provider: 'llm',
    model: 'spike-test-model',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
  } as unknown as AgentMessage;
}

const MESSAGES: AgentMessage[] = [
  longUser('first', true),
  longAssistant('second'),
  longUser('last', false),
];

function driverWith(env: Record<string, string | undefined>) {
  return createPiTurnDriver({ env: { ...BASE_ENV, ...env } });
}

describe('SPIKE 通用模式：pi 原生压缩照跑，宿主 sidecar 跳过', () => {
  it('关闭时 sidecar 各调用一次；打开时零调用，摘要与保留尾巴两臂一致', async () => {
    const off = await driverWith({}).compact!(MESSAGES, { force: true });
    expect(vi.mocked(generateSummary)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildCompactionContextSidecar)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(compactedTranscriptWithContext)).toHaveBeenCalledTimes(1);
    expect(off.filter((message) => (message as { customType?: string }).customType === COMPACTION_CONTEXT_MESSAGE_TYPE)).toHaveLength(1);

    const on = await driverWith({ [SPIKE_GENERIC_MODE_ENV]: '1' }).compact!(MESSAGES, { force: true });
    // 原生压缩没有被跳过：摘要模型调用与 sidecar 计数都只增加摘要那一次。
    expect(vi.mocked(generateSummary)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(buildCompactionContextSidecar)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(compactedTranscriptWithContext)).toHaveBeenCalledTimes(1);
    expect(on.filter((message) => (message as { customType?: string }).customType === COMPACTION_CONTEXT_MESSAGE_TYPE)).toHaveLength(0);

    // 摘要消息保留（native 摘要成功 + 保留尾巴），且两臂的保留尾巴逐条相同。
    expect((on[0] as { content?: string }).content).toContain('【此前会话摘要】');
    expect((on[0] as { content?: string }).content).toContain('SPIKE-摘要');
    expect(on.slice(1)).toEqual(off.slice(2));
    expect(on).toHaveLength(2);
    expect(off).toHaveLength(3);
  });
});
