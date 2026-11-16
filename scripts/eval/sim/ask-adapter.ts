/**
 * SimCase 薄机制 · 被测系统适配器（复用 `scripts/ask-runtime.ts` 的生产同源装配）。
 *
 * 只在 `scripts/eval/sim` 内做**接线**：把 `assembleAskRuntime` 产出的 `Session.send`
 * 投影成 `SimSystemUnderTest`。不改产品码、不加任何宿主机制、不引框架/服务/数据库。
 *
 * 诚实边界（不编造）：
 *   · 用量只从**公开只读**的 `Session.transcript()` 派生（Pi 原生 assistant 消息带 usage）：
 *     按 assistant 消息的 `usage.totalTokens` 做累计差分，逐个新调用记 `kind: main`；
 *     转录里若拿不到任何 usage → `calls` 留 undefined，记账标注不可得，不补零；
 *     `summary/retry/overflow_recovery` 在转录投影里不可分离 → 不伪造这几类，报告里标注；
 *   · ask 装配没有故障注入接缝 → 注入指令一律回报 `injectionApplied: false`
 *     （唯一例外：锚点未到达时本就无需应用）；
 *   · 本适配器需要 `LLM_API_KEY`（`assembleAskRuntime` 缺省 fail-closed 拒绝），
 *     单元测试一律用确定性假件，不在这里烧真实样本。
 */
import path from 'node:path';
import { assembleAskRuntime } from '../../ask-runtime';
import type { DriverMessage } from '../../../packages/agent/src/driver-contract';
import type { SimSystemCall, SimSystemTurn, SimSystemUnderTest } from './run';

export interface AskRuntimeSystemInput {
  /** 该 trial 独立运行目录（sessionDir 的上层；state.db 也落这里）。 */
  readonly runtimeDir: string;
  readonly sessionId: string;
  readonly principalId?: string;
  readonly env: NodeJS.ProcessEnv;
  /** 透传给装配的 argv（只读其中的 --config=）。 */
  readonly argv?: readonly string[];
}

export interface AskRuntimeSystem extends SimSystemUnderTest {
  close(): void;
  /** 系统侧用量是否可观测（false = 转录里没有可用 usage，报告标注不可得）。 */
  usageObservable(): boolean;
}

interface AssistantUsage {
  readonly key: string;
  readonly tokens: { readonly input: number; readonly output: number; readonly total: number };
}

/**
 * 转录投影里每个有 usage 的 assistant 消息 = 一次可观测模型调用。
 * 投影每次重建，因此用「timestamp|usage」做稳定键去重（不依赖对象身份）。
 */
function assistantUsages(messages: readonly DriverMessage[]): AssistantUsage[] {
  const usages: AssistantUsage[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const record = message as {
      readonly timestamp?: unknown;
      readonly usage?: { readonly input?: number; readonly output?: number; readonly totalTokens?: number };
    };
    const usage = record.usage;
    if (usage === undefined) continue;
    const total = usage.totalTokens;
    if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) continue;
    const input = typeof usage.input === 'number' ? usage.input : 0;
    const output = typeof usage.output === 'number' ? usage.output : 0;
    usages.push({
      key: `${typeof record.timestamp === 'number' ? record.timestamp : '?'}|${total}|${input}|${output}`,
      tokens: { input, output, total },
    });
  }
  return usages;
}

/** 用生产同源装配起一个被测系统会话（每 trial 一个实例，目录互不共享）。 */
export async function createAskRuntimeSystem(input: AskRuntimeSystemInput): Promise<AskRuntimeSystem> {
  const runtime = await assembleAskRuntime({
    purpose: 'sim-eval',
    argv: input.argv ?? [],
    env: input.env,
    runtimeDir: input.runtimeDir,
    sessionId: input.sessionId,
    ...(input.principalId === undefined ? {} : { principalId: input.principalId }),
    dbPath: path.join(input.runtimeDir, 'state.db'),
  });
  /** 已上报过的 assistant 调用键（转录重投影是只读的；压缩丢弃旧消息也不重报）。 */
  const seen = new Set<string>();
  let observable = false;
  return {
    async send(text): Promise<SimSystemTurn> {
      const turn = await runtime.session.send(text);
      const fresh: SimSystemCall[] = [];
      for (const usage of assistantUsages(runtime.session.transcript())) {
        observable = true;
        if (seen.has(usage.key)) continue;
        seen.add(usage.key);
        fresh.push({ kind: 'main', tokens: usage.tokens, tokensObserved: true });
      }
      // 一次 usage 都没拿到 → undefined（run.ts 据此标注系统面记账不可得，不补零）。
      const calls: SimSystemCall[] | undefined = observable ? fresh : undefined;
      return {
        visibleReply: turn.reply,
        toolCalls: turn.executions.length,
        events: 0,
        executions: turn.executions.map((execution) => ({
          operation: execution.operation,
          status: execution.status,
          object: execution.requestId,
          // U3：逻辑操作身份逐条透传（写场景的「同一身份不得重复执行」判定靠它）。
          ...(execution.dispatchKey === undefined ? {} : { dispatchKey: execution.dispatchKey }),
        })),
        // ask 装配未暴露注入接缝：如实回报未应用（不伪造命中）。
        injectionApplied: false,
        injectionReason: 'ask 装配未暴露注入接缝',
        ...(calls === undefined ? {} : { calls }),
      };
    },
    close() {
      runtime.close();
    },
    usageObservable() {
      return observable;
    },
  };
}
