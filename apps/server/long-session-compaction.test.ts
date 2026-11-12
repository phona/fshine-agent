/**
 * T4 长会话必须真压缩（架构调整相位 1）。
 *
 * 今天实测 context_compacted = 0：装配把 contextStates 接给了 runtime，转录回填于是
 * "成功"，运行时停在 state_recent 模式——runtime.ts 的每回合压缩与过期恢复两个调用点
 * 都在 transcript 分支里，**谁都到不了**。本文件从生产装配（createServerAssembly）起跑，
 * 断言两个调用点真的到了。
 *
 * 机械判据：
 *   ① 长会话（转录越过能力阈值）必须产生 context_compacted 事件 > 0，短会话不产生；
 *   ② 压缩之后的召回轮，回复数字仍对夹具——被摘要掉的旧转录段里的旧数字（42）不得
 *      出现在本轮材料里，夹具数字（51）来自保留尾段里的真实执行结果（相位 1 的 T9
 *      裁定删除了宿主台账注入，压缩后的召回只能读保留下来的转录）；
 *   ③ 会话过期恢复（session_resume_seeding）走强制压缩，同样留下 context_compacted。
 *
 * 压缩实现用生产函数 compactTranscriptWithPi（内存假模型运行时返回夹具摘要，离线），
 * 驱动替身只负责脚本化回合与转发压缩调用——压缩与阈值判定是生产代码。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { MutableModels } from '@earendil-works/pi-ai';
import { compactTranscriptWithPi, type PiModelRuntime, type TurnDriver, type TurnDriverInput } from '@fshine/agent';
import type { TrustedContext } from '@fshine/contracts';
import { createServerAssembly } from './assembly';

const SESSION_ID = 'sess_long';
const PRINCIPAL_ID = 'wecom:long_user';
const MODEL_ID = 'step-3.7-flash';
/** 真实窗口量级的能力声明（T7 实测 tokensIn 贴着 40000 窗口）：阈值 = 40000 − 16384 = 23616。 */
const CONTEXT_WINDOW = 40_000;
/** 保留尾段里的夹具数字（压缩之后召回轮的唯一依据）。 */
const FIXTURE_NUMBER = '51';
/** 被摘要掉的旧转录段里的旧数字：不得出现在压缩后的本轮材料里。 */
const STALE_NUMBER = '42';
const SUMMARY_TEXT = '【夹具摘要】此前在核对应收余额，旧结论已作废，必须按保留下来的执行结果回答。';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 假模型运行时：摘要由夹具返回，断言只碰生产压缩逻辑，不发网络请求。 */
function fakeRuntime(): PiModelRuntime {
  return {
    model: {
      id: MODEL_ID, name: MODEL_ID, api: 'openai-completions', provider: 'llm',
      baseUrl: 'http://127.0.0.1:9', reasoning: true, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: CONTEXT_WINDOW, maxTokens: 32_000,
    } as unknown as PiModelRuntime['model'],
    models: {
      completeSimple: async () => ({
        role: 'assistant',
        content: [{ type: 'text', text: SUMMARY_TEXT }],
        stopReason: 'stop',
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 20 },
        timestamp: Date.now(),
      }),
    } as unknown as MutableModels,
  };
}

function makeCtx(requestId: string): TrustedContext {
  return { requestId, principalId: PRINCIPAL_ID, sessionId: SESSION_ID };
}

/** 生产装配（最小 yaml：只配 principals；无 platformRoot → 不触平台 lint/CLI，离线）。 */
async function boot(options: {
  sessionTtlMs: number;
  driver: TurnDriver;
}): Promise<Awaited<ReturnType<typeof createServerAssembly>>> {
  const root = mkdtempSync(path.join(tmpdir(), 'long-session-compaction-'));
  roots.push(root);
  writeFileSync(path.join(root, 'agent.yaml'), [
    'principals:',
    `  ${PRINCIPAL_ID}:`,
    '    accountSetScope: all',
    '    enabled: true',
    `sessionTtlMs: ${options.sessionTtlMs}`,
    '',
  ].join('\n'));
  return createServerAssembly({
    env: {
      AGENT_CONFIG_PATH: path.join(root, 'agent.yaml'),
      LLM_API_BASE_URL: 'http://127.0.0.1:9',
      LLM_API_KEY: 'long-session-key',
      LLM_MODEL: MODEL_ID,
    },
    dbPath: path.join(root, 'agent.db'),
    driver: options.driver,
  });
}

/** 转录填充段：120 段 × 905 字符 ≈ 27k token，越过 40000 能力的阈值。 */
function fillerMessages(): AgentMessage[] {
  return Array.from({ length: 120 }, (_, index) => ({
    role: 'assistant',
    content: [{ type: 'text', text: `第 ${index} 段资料：${'x'.repeat(900)}` }],
    stopReason: 'stop',
    timestamp: Date.now() + index,
  } as unknown as AgentMessage));
}

interface Script {
  text: string | ((input: TurnDriverInput) => string);
  extra?: AgentMessage[];
}

/**
 * 脚本化驱动替身：run 追加脚本消息；compact 转发生产压缩实现。
 * 压缩是否发生、产物是什么，全部由生产代码决定（直连后普通回合不再需要任何前置工具调用）。
 */
function scriptedDriver(runtime: PiModelRuntime, scripts: Script[]) {
  const inputs: TurnDriverInput[] = [];
  const driver: TurnDriver = {
    async run(input) {
      inputs.push(input);
      const script = scripts.shift() ?? { text: '好的。' };
      const text = typeof script.text === 'function' ? script.text(input) : script.text;
      return { text, messages: [...input.messages, ...(script.extra ?? [])] };
    },
    async compact(messages, opts) {
      return compactTranscriptWithPi(messages, opts, runtime);
    },
  };
  return { driver, inputs };
}

/** 观测日志：context_compacted（压缩真的发生）与 session_resume_seeding（过期恢复）。 */
function logSpy() {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => { lines.push(String(args[0])); };
  const info = vi.spyOn(console, 'info').mockImplementation(capture);
  const log = vi.spyOn(console, 'log').mockImplementation(capture);
  return {
    lines,
    compacted: () => lines.filter((line) => line.includes('context_compacted')).length,
    restore: () => { info.mockRestore(); log.mockRestore(); },
  };
}

/** 从本轮材料里读夹具数字（保留尾段缺席时模型拿不到数字）。 */
function answerFromTranscript(input: TurnDriverInput): string {
  const flattened = input.messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    return typeof content === 'string' ? content : JSON.stringify(content);
  }).join('\n');
  const found = flattened.match(/余额为 ([\d,]+) 元/u)?.[1];
  return found ? `应收余额为 ${found} 元。` : '材料里没有可引用的余额数字。';
}

describe('T4 长会话压缩真发生（生产装配起跑）', () => {
  it('长会话产生 context_compacted；压缩后的召回轮数字仍对夹具（且只能来自保留尾段）', async () => {
    const spy = logSpy();
    const runtime = fakeRuntime();
    const { driver, inputs } = scriptedDriver(runtime, [
      // 第一轮：旧结论（42）在前段，长填充在中间，夹具结果在**最尾部**——压缩摘要掉
      // 前段、保留尾段时，42 消失而 51 留下。
      {
        text: '第一轮答复。',
        extra: [
          // 生产转录里的消息内容一律是内容块数组（pi 原生形状）；字符串 content 不是
          // 合法 AgentMessage，pi 的 token 估算会直接抛错（曾把压缩路径炸成
          // context_compact_threw，断言读到的 0 次压缩是夹具形状错误、不是调用点不可达）。
          { role: 'assistant', content: [{ type: 'text', text: `旧结论：幻辰财税 202609 应收余额为 ${STALE_NUMBER} 元。` }], stopReason: 'stop', timestamp: Date.now() } as unknown as AgentMessage,
          ...fillerMessages(),
          { role: 'assistant', content: [{ type: 'text', text: `真实执行结果：幻辰财税 202609 应收余额为 ${FIXTURE_NUMBER} 元。` }], stopReason: 'stop', timestamp: Date.now() + 10_000 } as unknown as AgentMessage,
        ],
      },
      { text: '第二轮答复。' },
      // 第三轮：召回轮，答案只能从本轮材料（压缩后保留的尾巴）里的数字生成。
      { text: answerFromTranscript },
    ]);
    const assembly = await boot({ sessionTtlMs: 3_600_000, driver });
    try {
      await assembly.runtime.handleTurn(makeCtx('req_long_1'), '第一轮：随便聊聊。');
      expect(spy.compacted(), '短转录不该压缩：阈值没被尊重').toBe(0);

      await assembly.runtime.handleTurn(makeCtx('req_long_2'), '第二轮：继续。');
      expect(spy.compacted(), '长会话没有产生 context_compacted：每回合压缩的调用点不可达').toBeGreaterThan(0);
      const compactedBeforeRecall = spy.compacted();

      const reply = await assembly.runtime.handleTurn(makeCtx('req_long_3'), '刚才查出来的应收余额是多少？');

      const lastInput = inputs.at(-1)!;
      const material = JSON.stringify(lastInput.messages);
      expect(material, '转录不是压缩后的那一份').toContain('【此前会话摘要】');
      expect(material, '被摘要掉的旧转录段里的旧数字还在本轮材料里：压缩没真的裁掉前段').not.toContain(`${STALE_NUMBER} 元`);
      expect(reply.text, '压缩之后的召回轮回复数字对不上夹具').toContain(`${FIXTURE_NUMBER} 元`);
      // 压缩发生在召回轮之前（不是召回轮自己压出来的），且本轮没有又一次压缩。
      expect(compactedBeforeRecall).toBeGreaterThan(0);
      expect(spy.compacted(), '召回轮又压缩了一次：保留尾段被再次裁掉').toBe(compactedBeforeRecall);
    } finally {
      spy.restore();
      await assembly.close();
    }
  });

  it('会话过期恢复：强制压缩（session_resume_seeding + context_compacted）', async () => {
    const spy = logSpy();
    const { driver } = scriptedDriver(fakeRuntime(), [{ text: '第一轮答复。' }, { text: '第二轮答复。' }]);
    const assembly = await boot({ sessionTtlMs: 1, driver });
    try {
      await assembly.runtime.handleTurn(makeCtx('req_expire_1'), '第一轮：随便聊聊。');
      await new Promise((resolve) => setTimeout(resolve, 5));
      await assembly.runtime.handleTurn(makeCtx('req_expire_2'), '第二轮：继续。');

      expect(spy.lines.some((line) => line.includes('session_resume_seeding')), '过期会话没有走恢复软着陆：调用点不可达').toBe(true);
      expect(spy.compacted(), '过期恢复没有强制压缩：旧转录原样续跑').toBeGreaterThan(0);
    } finally {
      spy.restore();
      await assembly.close();
    }
  });
});
