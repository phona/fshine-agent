/**
 * 确定性脚本化 `ModelRuntime`（测试夹具；只用公开 API）。
 *
 * 1.5.2 起驱动经 `ModelRuntime` 调模型（`streamSimple`；压缩摘要走 `completeSimple`，
 * 而 Pi 的 `completeSimple` 就是 `streamSimple(...).result()`）。本夹具用
 * `ModelRuntime.create` + `registerProvider({ streamSimple })` 按脚本返回 assistant 消息，
 * 不联网、不读宿主凭据。
 */
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

export const SCRIPTED_PROVIDER_ID = 'llm';
export const SCRIPTED_MODEL_ID = 'test-model';

export interface ScriptedRequestContext {
  messages: ReadonlyArray<{ role?: string; content?: unknown }>;
}

export interface ScriptedModelRuntimeOptions {
  modelId?: string;
  contextWindow?: number;
  maxTokens?: number;
  /**
   * 模型能力声明：是否支持思考档（缺省 false = 既有夹具行为逐字节不变）。
   * true 时 Pi 的档位钳制不再把非 off 档位压回 off——思考档接线用例需要它。
   */
  reasoning?: boolean;
  /**
   * 第 `callIndex` 次模型请求（含压缩摘要请求）返回的 assistant 消息；
   * 返回 undefined = 队列耗尽（抛错，测试立刻可见）。
   */
  script: (callIndex: number, context: ScriptedRequestContext) => AgentMessage | undefined;
}

export interface ScriptedModelRuntime {
  runtime: ModelRuntime;
  calls(): number;
  requests(): readonly ScriptedRequestContext[];
  /** 第 n 次请求 provider 实际收到的思考档（`options.reasoning`；未传 = undefined）。 */
  reasoningLevels(): readonly (string | undefined)[];
  modelId: string;
  contextWindow: number;
}

// 认证存储只用于 ModelRuntime 构造（本夹具从不写盘）：进程级唯一路径即可。
const AUTH_PATH = path.join(process.env.TMPDIR || tmpdir(), `fshine-scripted-rt-${process.pid}.json`);

export async function createScriptedModelRuntime(options: ScriptedModelRuntimeOptions): Promise<ScriptedModelRuntime> {
  const modelId = options.modelId ?? SCRIPTED_MODEL_ID;
  const contextWindow = options.contextWindow ?? 40_000;
  const maxTokens = options.maxTokens ?? 32_000;
  const runtime = await ModelRuntime.create({
    authPath: AUTH_PATH,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const requests: ScriptedRequestContext[] = [];
  const reasoningLevels: Array<string | undefined> = [];
  let calls = 0;
  runtime.registerProvider(SCRIPTED_PROVIDER_ID, {
    name: 'Scripted',
    api: 'openai-completions',
    apiKey: 'scripted-test-key',
    models: [{
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      reasoning: options.reasoning ?? false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    }],
    streamSimple: (_model, context, streamOptions) => {
      const index = calls;
      calls += 1;
      const request = context as unknown as ScriptedRequestContext;
      requests.push(request);
      reasoningLevels.push(typeof streamOptions?.reasoning === 'string' ? streamOptions.reasoning : undefined);
      const message = options.script(index, request);
      const stream = createAssistantMessageEventStream();
      if (message === undefined) {
        const exhausted = {
          role: 'assistant',
          content: [],
          api: 'openai-completions',
          provider: SCRIPTED_PROVIDER_ID,
          model: modelId,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'error',
          errorMessage: '脚本化模型运行时没有更多响应',
          timestamp: Date.now(),
        } as unknown as AgentMessage;
        queueMicrotask(() => {
          stream.push({ type: 'error', reason: 'error', error: exhausted as never });
          stream.end(exhausted as never);
        });
        return stream;
      }
      queueMicrotask(() => {
        const stop = (message as { stopReason?: string }).stopReason;
        if (stop === 'error' || stop === 'aborted') {
          stream.push({ type: 'error', reason: stop, error: message as never });
        } else {
          stream.push({ type: 'done', reason: stop === 'length' ? 'length' : 'stop', message: message as never });
        }
        stream.end(message as never);
      });
      return stream;
    },
  });
  return { runtime, calls: () => calls, requests: () => requests, reasoningLevels: () => reasoningLevels, modelId, contextWindow };
}
