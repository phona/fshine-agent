/**
 * 缺口 3 · 压缩窗口装配接线（LLM_CONTEXT_WINDOW → 驱动 PiTurnDriverOptions.contextWindow）。
 *
 * 缺口本体：配置层把 `llm.contextWindow` 写进 env（config.ts:442 `put('LLM_CONTEXT_WINDOW', …)`），
 * 但生产装配两处 `createPiTurnDriver({ env: input.env })`（ask-runtime.ts:288、:385）从不把该 env
 * 经既有 `parseContextWindow` 传进驱动——压缩阈值永远按写死的 128k 算。窗口比 128k 小的真实
 * 模型会在超窗后才知道要压缩（T7 贴边空回复的成因类别）。
 *
 * 判据（TDD：实现前红 → 装配层接线后绿）：
 *   ① 缺省（env 无 LLM_CONTEXT_WINDOW / 空串）→ 驱动 128k：长转录原样返回、零 warn（缺省逐字节不变）；
 *   ② `LLM_CONTEXT_WINDOW=40000` → 驱动吃该值：长转录触发一次压缩尝试（context_compact_failed 就是
 *      "尝试发生了"的机械证据）——这正是 §7.6 反向绊线依赖的行为；
 *   ③ 非法值（abc / 0 / 1.5）→ 装配期 fail-fast，报错文案点名 LLM_CONTEXT_WINDOW（parseContextWindow 语义）；
 *   ④ 装配点静态守卫：ask-runtime.ts 两处 createPiTurnDriver 调用都必须经 contextWindowFrom 接线
 *      （删掉 `...contextWindowFrom(...)` 即红，防「参数没人传」的死代码回潮）。
 *
 * 只测装配层接线，pi-driver 零改动；驱动层金样仍在 pi-model-capability.test.ts。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createPiTurnDriver } from '../packages/agent/src/pi-driver';
import { contextWindowFrom } from './ask-runtime';

const ENV = { LLM_API_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'context-window-key', LLM_MODEL: 'step-3.7-flash' };
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** ~30k token 的转录（4 字符 ≈ 1 token）：越过 40k 能力的阈值，不越 128k 的阈值。 */
function longTranscript(): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < 133; index += 1) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: `第 ${index} 段资料：${'x'.repeat(900)}` }],
      stopReason: 'stop',
      timestamp: index,
    } as unknown as AgentMessage);
  }
  return messages;
}

/** 装配层构造驱动的同一方式（两调用点共享）：env + contextWindowFrom(env) 展开。 */
function assembleDriver(env: Record<string, string | undefined>) {
  return createPiTurnDriver({ env, ...contextWindowFrom(env) });
}

describe('缺口 3 · 压缩窗口装配接线（contextWindowFrom → 驱动 contextWindow）', () => {
  it('未设置 → 装配产物缺省 128k：长转录原样返回且零 warn（缺省逐字节不变）', async () => {
    const messages = longTranscript();
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(String(args[0])); });
    try {
      expect(contextWindowFrom(ENV), '未设置必须回落空对象（驱动不收到 contextWindow）').toEqual({});
      const out = await assembleDriver(ENV).compact!(messages);
      expect(out, '缺省 128k：阈值未到，必须原样返回').toBe(messages);
      expect(warns, '缺省 128k 不应触发任何压缩尝试').toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('LLM_CONTEXT_WINDOW=40000 → 装配产物吃该值：长转录触发压缩尝试（接线生效）', async () => {
    const messages = longTranscript();
    const env = { ...ENV, LLM_CONTEXT_WINDOW: '40000' };
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(String(args[0])); });
    try {
      expect(contextWindowFrom(env)).toEqual({ contextWindow: 40_000 });
      await assembleDriver(env).compact!(messages);
      expect(
        warns.some((line) => line.includes('context_compact_failed')),
        '装配层没把 LLM_CONTEXT_WINDOW 传进驱动：仍按 128k 判阈值，压缩尝试没发生',
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('空串 = 未设置（parseContextWindow 语义）→ 回落缺省', () => {
    expect(contextWindowFrom({ ...ENV, LLM_CONTEXT_WINDOW: '' })).toEqual({});
  });

  it('非法值 → 装配期 fail-fast，报错点名 LLM_CONTEXT_WINDOW（不静默回落）', () => {
    expect(() => contextWindowFrom({ ...ENV, LLM_CONTEXT_WINDOW: 'abc' })).toThrow('LLM_CONTEXT_WINDOW');
    expect(() => contextWindowFrom({ ...ENV, LLM_CONTEXT_WINDOW: '0' })).toThrow('LLM_CONTEXT_WINDOW');
    expect(() => contextWindowFrom({ ...ENV, LLM_CONTEXT_WINDOW: '1.5' })).toThrow('LLM_CONTEXT_WINDOW');
  });

  it('装配点静态守卫：ask-runtime 三处 createPiTurnDriver 都经 contextWindowFrom 接线', () => {
    const wired = createPiTurnDriverWiring();
    expect(wired.total, 'ask-runtime.ts 的 createPiTurnDriver 调用应恰好三处（:288 worker + :385 main/worker）').toBe(3);
    expect(wired.wired, '每处 createPiTurnDriver 必须展开 ...contextWindowFrom(...)；删掉即缺口回潮').toBe(3);
  });
});

/**
 * 静态读取装配点：找出 scripts/ask-runtime.ts 里所有 createPiTurnDriver(...) 调用，
 * 逐个判定首个对象参数是否含 `...contextWindowFrom(...)` 展开。用 AST 事实，不做文本猜测。
 */
function createPiTurnDriverWiring(): { total: number; wired: number } {
  const file = path.resolve(__dirname, 'ask-runtime.ts');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let total = 0;
  let wired = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'createPiTurnDriver') {
      total += 1;
      const first = node.arguments[0];
      if (first !== undefined && ts.isObjectLiteralExpression(first)) {
        const hasSpread = first.properties.some((property) => ts.isSpreadAssignment(property)
          && ts.isCallExpression(property.expression)
          && property.expression.expression.getText(source) === 'contextWindowFrom');
        if (hasSpread) wired += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { total, wired };
}
