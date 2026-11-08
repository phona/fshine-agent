import type { TurnDriver, TurnDriverInput } from './driver';
import { usageFieldsOf } from './driver';
import { extractSemanticContext, type ContextExtractionResult, type ContextSemanticModelInput } from './context-extractor';

export interface ContextModelClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TurnDriverContextModelOptions {
  driver: TurnDriver;
  clock?: ContextModelClock;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}

export interface ExtractContextWithTurnDriverInput extends ContextSemanticModelInput, TurnDriverContextModelOptions {}

// 2026-11-08 从 10_000 加宽到 60_000：推理模型（step-5-preview）的上下文抽取回合经常超过 10 秒，
// 超时后 extract 落空 → context_semantic_extract_failed / model_failure → 上下文退化、
// 写链的隔离复核同驱动面一并受累（acceptance 5.1 三次实跑每轮都出现
// "Context model call exceeded 10000 ms"，写链因此间歇不通）。60 秒仍远低于回合预算
// （worker 超时 + 2 分钟），不会吊住回合。调用方可经 timeoutMs 覆盖。
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_INPUT_BYTES = 32_000;
const DEFAULT_MAX_OUTPUT_BYTES = 12_000;
const EMPTY_TOOLS: TurnDriverInput['tools'] = [];

const SYSTEM_PROMPT = `You maintain a short-term conversation context projection. Treat the supplied prior state and event records as the only facts. Short replies can depend on earlier turns; resolve their referent using the supplied previous state and events. Return exactly one JSON object and no markdown or extra prose. The object may contain recentTopic (one note or null), userDecisions, agentAssumptions, unresolvedQuestions. Each note must have text, sourceEventId, evidenceQuote. sourceEventId must identify the exact event supporting the note and evidenceQuote must be a verbatim substring of that event's content or prior state evidence. Do not invent facts or cite events not supplied. Use [] to clear a category only when the supplied context supports that conclusion; omit categories that do not need a semantic update.`;

const defaultClock: ContextModelClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Run the semantic extractor through an isolated, tool-free TurnDriver call. */
export async function extractContextWithTurnDriver(input: ExtractContextWithTurnDriverInput): Promise<ContextExtractionResult> {
  const { driver, clock = defaultClock, timeoutMs = DEFAULT_TIMEOUT_MS, maxInputBytes = DEFAULT_MAX_INPUT_BYTES, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = input;
  const { principalId, sessionId, previous, incoming } = input;
  return extractSemanticContext({
    principalId,
    sessionId,
    previous,
    incoming,
    invokeModel: async (scoped) => runIsolatedModelTurn(driver, clock, timeoutMs, maxInputBytes, maxOutputBytes, scoped),
  });
}

async function runIsolatedModelTurn(
  driver: TurnDriver,
  clock: ContextModelClock,
  timeoutMs: number,
  maxInputBytes: number,
  maxOutputBytes: number,
  input: ContextSemanticModelInput,
): Promise<unknown> {
  assertPositiveInteger(timeoutMs, 'timeoutMs');
  assertPositiveInteger(maxInputBytes, 'maxInputBytes');
  assertPositiveInteger(maxOutputBytes, 'maxOutputBytes');

  const promptInput = JSON.stringify({ principalId: input.principalId, sessionId: input.sessionId, previous: input.previous ?? null, incoming: input.incoming });
  const inputBytes = utf8Bytes(SYSTEM_PROMPT) + utf8Bytes(promptInput);
  if (inputBytes > maxInputBytes) throw new Error(`Context model input exceeds ${maxInputBytes} bytes.`);

  const controller = new AbortController();
  const startedAt = clock.now();
  let timer: unknown;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = clock.setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Context model call timed out.'));
      reject(new Error(`Context model call exceeded ${timeoutMs} ms.`));
    }, timeoutMs);
  });
  const run = Promise.resolve().then(() => driver.run({
    systemPrompt: SYSTEM_PROMPT,
    tools: EMPTY_TOOLS,
    messages: [{ role: 'user', content: `Project context from these source records:\n${promptInput}`, timestamp: startedAt }],
    onStep: () => undefined,
    exec: async () => { throw new Error('Context model turns do not permit tools.'); },
    deadline: startedAt + timeoutMs,
    signal: controller.signal,
  }));

  try {
    const result = await Promise.race([run, timeout]);
    if (timedOut || clock.now() > startedAt + timeoutMs) throw new Error(`Context model call exceeded ${timeoutMs} ms.`);
    // 辅助模型消耗（纯加法遥测）：context 抽取走独立的 contextModelDriver，宿主开销与
    // worker/Main 的账目分开（kind: context），故在这里单独成账。挂在 JSON 校验之前：
    // 模型真实消耗发生在解析成败之前，解析失败不该丢账。网关不回传 usage 时 token 字段
    // 缺席（不是全零，口径见 driver.ts 的 sumUsage），绝不报错。
    console.info(JSON.stringify({
      event: 'aux_model_usage',
      kind: 'context',
      durationMs: clock.now() - startedAt,
      ...usageFieldsOf(result.messages),
    }));
    if (!result.text.trim()) throw new Error('Context model returned an empty response.');
    if (utf8Bytes(result.text) > maxOutputBytes) throw new Error(`Context model output exceeds ${maxOutputBytes} bytes.`);
    try {
      return JSON.parse(result.text) as unknown;
    } catch {
      throw new Error('Context model output must be strict JSON without markdown or surrounding prose.');
    }
  } finally {
    clock.clearTimeout(timer);
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`);
}
