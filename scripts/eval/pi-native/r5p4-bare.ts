/**
 * R5-P4 真实模型 · Pi 原生核心（被测对象：AgentHarness + MemorySessionRepo 单会话多轮）。
 *
 * 与产品驱动同一批 Pi 公开入口与产品配置适配（piCompactionSettings），但使用**单一长生命周期
 * 会话**（Pi 设计用法：转录与压缩由该会话持有），并直接订阅 Pi 原生事件：
 *   compaction_start / compaction_end（reason / status）、run_end、retry_scheduled、usage、turn_end。
 * 工具 = 仓内 dummy 夹具只读 operation（execute_operation），真实执行、真实工具结果。
 *
 * 用法：
 *   LLM_MODEL=step-3.7-flash node --import tsx scripts/eval/pi-native/r5p4-bare.ts --scenario=A [--window=8192] [--maxtokens=2048]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHarness, type AgentMessage } from '@earendil-works/pi-agent-core';
import { MemorySessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { createPiModelRuntime, piCompactionSettings } from '../../../packages/agent/src/pi-driver';
import { createDummyCliClient, readOnlyOperationNames } from '../../../packages/agent/src/dummy-cli-client';

const CTX = BACKGROUND_CONTEXT;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');
const OUT_ROOT = path.join(REPO_ROOT, '.runtime', 'r5p4');

function argValue(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const FILLER = (n: number, tag: string): string => {
  const s = [
    '把这件事拆成可执行的小步，每一步只解决一个明确的问题，做完就地记录事实。',
    '过程中的中间结论要能追溯到来源，不能凭印象补全，也不能把没发生的动作说成发生了。',
    '遇到信息不足时，先如实说明缺什么，再请对方补齐，不要自己替对方假设一个答案。',
    '结果交付时只讲用户看得懂的话，数字用平台返回的原文，不四舍五入也不修饰。',
    '长期运行要能续跑：状态可查、任务可数、失败可解释、取消要有回执。',
  ];
  let out = '';
  for (let i = 0; i < n; i += 1) out += `[${tag}-${i}] ${s[i % s.length]}\n`;
  return out;
};
const fill = (tag: string, n = 130): string => `背景补充（${tag}），读完即可：\n${FILLER(n, tag)}`;

const SCEN = {
  A: [
    `先记住两件事：(1) 项目代号是「蓝鲸-42」；(2) 一律用简体中文回答。\n${fill('A1')}`,
    `请用 execute_operation 查 dummy.query collection=alpha（window=recent），把条数和第一条内容告诉我。`,
    fill('A2'),
    `刚才 alpha 查询的条数是多少？`,
    fill('A3'),
    fill('A4'),
    `我最开始让你记住的项目代号是什么？用哪种语言回答？`,
    fill('A5'),
    `再查一次 collection=alpha 的条数。`,
    fill('A6'),
    fill('A7'),
    `到目前为止聊过哪几个主题？按顺序列一下。`,
    fill('A8'),
    `再确认：项目代号与必须使用的语言分别是什么？`,
    fill('A9'),
    `最后复述我最早那段背景（A1）的主题。`,
  ],
  C: [
    `第 1 段背景：\n${fill('C1')}`,
    `第 2 段背景：\n${fill('C2')}`,
    `用 execute_operation 查 dummy.query collection=alpha（window=recent）记录，给出条数。`,
    `第 3 段背景：\n${fill('C3')}`,
    `第 4 段背景：\n${fill('C4')}`,
    `用 execute_operation 再查一次 collection=alpha。`,
    `第 5 段背景：\n${fill('C5')}`,
    `第 6 段背景：\n${fill('C6')}`,
    `请概括你对我每一段背景的要点。`,
    `第 7 段背景：\n${fill('C7')}`,
    `第 8 段背景：\n${fill('C8')}`,
    `第 9 段背景：\n${fill('C9')}`,
    `请确认你仍能正常工作，并复述第 1 段背景的主题。`,
  ],
} as const;

function lastAssistantText(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
    if (m.role !== 'assistant') continue;
    const content = m.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) for (const b of content as Array<{ type?: string; text?: string }>) if (b.type === 'text') text += b.text ?? '';
    return `${text}`.trim() === '' ? `[[no-text:${m.stopReason ?? '?'}:${(m.errorMessage ?? '').slice(0, 80)}]]` : text;
  }
  return '[[none]]';
}

async function main(): Promise<void> {
  const scenarioId = argValue('scenario', 'A')!;
  const windowSize = Number(argValue('window', '8192'));
  const maxOut = Number(argValue('maxtokens', '2048'));
  const limit = Number(argValue('limit', '0'));
  const turnsText = SCEN[scenarioId as keyof typeof SCEN];
  if (turnsText === undefined) throw new Error(`未知场景：${scenarioId}`);

  const env: NodeJS.ProcessEnv = { ...process.env };
  env.LLM_MODEL = process.env.LLM_MODEL ?? 'step-3.7-flash';
  if ((env.LLM_API_KEY ?? '').trim() === '') throw new Error('缺 LLM_API_KEY');
  const modelId = env.LLM_MODEL!;

  const outDir = path.join(OUT_ROOT, `${scenarioId}-bare`);
  mkdirSync(outDir, { recursive: true });

  const stateDir = path.join(outDir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const client = createDummyCliClient({ root: FIXTURE_ROOT, gateway: 'bin/dummy', stateDir, env });
  const operations = await client.listOperations();
  const allowed = readOnlyOperationNames(operations as never);
  const manifest = await client.capabilities();

  const records: Array<Record<string, unknown>> = [];
  const execs: Array<Record<string, unknown>> = [];
  const rt = createPiModelRuntime(env, modelId, { contextWindow: windowSize, maxTokens: maxOut });
  const models = new Proxy(rt.models, {
    get(target, prop, receiver) {
      if (prop === 'streamSimple' || prop === 'completeSimple') {
        return async (model: unknown, ctx: unknown, opts: unknown) => {
          const started = Date.now();
          const rec: Record<string, unknown> = { kind: prop, callIndex: records.length, startedAt: started, ctxMessages: ((ctx as { messages?: unknown[] })?.messages ?? []).length };
          records.push(rec);
          try {
            if (prop === 'completeSimple') {
              const m = await (target as { completeSimple: (...a: unknown[]) => Promise<unknown> }).completeSimple(model, ctx, opts);
              rec.ms = Date.now() - started;
              rec.usage = (m as { usage?: unknown })?.usage;
              rec.stopReason = (m as { stopReason?: string })?.stopReason;
              return m;
            }
            const stream = (target as { streamSimple: (...a: unknown[]) => object }).streamSimple(model, ctx, opts);
            return new Proxy(stream, {
              get(st, p) {
                if (p === Symbol.asyncIterator) {
                  return () => {
                    const it = (st as AsyncIterable<unknown>)[Symbol.asyncIterator]();
                    return {
                      next: async () => {
                        const n = await it.next();
                        if (n.done) { rec.ms ??= Date.now() - started; return n; }
                        const ev = n.value as { type?: string; message?: unknown };
                        if (ev.type === 'done') { rec.usage = (ev.message as { usage?: unknown })?.usage; rec.stopReason = (ev.message as { stopReason?: string })?.stopReason; rec.ms = Date.now() - started; }
                        if (ev.type === 'error') { rec.stopReason = 'error'; rec.error = JSON.stringify(ev).slice(0, 300); rec.ms = Date.now() - started; }
                        return n;
                      },
                      return: it.return === undefined ? undefined : it.return.bind(it),
                      throw: it.throw === undefined ? undefined : it.throw.bind(it),
                    };
                  };
                }
                const v = Reflect.get(st, p, st);
                return typeof v === 'function' ? v.bind(st) : v;
              },
            });
          } catch (error) {
            rec.ms = Date.now() - started;
            rec.error = error instanceof Error ? error.message : String(error);
            throw error;
          }
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });

  const execTool = {
    name: 'execute_operation',
    label: 'execute_operation',
    description: '发起一次只读结构化查询：operation 取能力快照里的 read operation，args 按声明填写。',
    parameters: Type.Unsafe({
      type: 'object',
      properties: {
        operation: { type: 'string' },
        args: { type: 'object' },
      },
      required: ['operation'],
    }),
    execute: async (_id: string, params: Record<string, unknown>) => {
      const operation = typeof params['operation'] === 'string' ? params['operation'] : '';
      const args = (params['args'] ?? {}) as Record<string, unknown>;
      if (!allowed.includes(operation)) {
        execs.push({ operation, status: 'refused-before-exec', allowed: false });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'refused', message: 'operation 不在允许集合' }) }], details: {} };
      }
      const outcome = await client.execute({ requestId: `req_${randomUUID()}`, operation, args });
      execs.push({ operation, status: outcome.status, requestId: (outcome as { requestId?: string }).requestId });
      return { content: [{ type: 'text' as const, text: JSON.stringify(outcome) }], details: {} };
    },
  };

  const capabilitySnapshot = JSON.stringify({ contractVersion: manifest.contractVersion, operations: manifest.operations.filter((o) => allowed.includes(o.name)) }, null, 2);
  const systemPrompt = [
    '你是 fshine 的执行层助手：用 execute_operation 查询平台只读数据，只依据返回事实回答，不要编造。',
    `能力快照（只能调用这里登记的 operation）：\n${capabilitySnapshot}`,
  ].join('\n\n');

  const compaction = piCompactionSettings(windowSize);
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, CTX);
  const created = await AgentHarness.create({
    session,
    models: models as never,
    model: rt.model,
    tools: [execTool] as never,
    activeToolNames: ['execute_operation'],
    systemPrompt,
    compaction,
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 },
  }, CTX);
  const harness = created.harness;
  const lane = await harness.lane('main', CTX);

  const events: Array<Record<string, unknown>> = [];
  for (const t of ['compaction_start', 'compaction_end', 'run_end', 'retry_scheduled', 'retry_end', 'turn_end', 'usage', 'handler_error', 'fault']) {
    harness.events.on(t as never, (e: Record<string, unknown>) => { events.push({ at: Date.now(), type: t, ...e }); });
  }

  const startedAt = Date.now();
  const turns: Array<Record<string, unknown>> = [];
  const LIMITS = { maxCalls: 80, maxTokens: 500_000, wallMs: 40 * 60_000 };
  let stopped = false;

  for (let i = 0; i < turnsText.length; i += 1) {
    if (limit > 0 && i >= limit) break;
    const text = turnsText[i]!;
    const t0 = Date.now();
    let error: string | null = null;
    try {
      await lane.prompt(text, undefined, CTX);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const entries = [...await lane.findEntries(undefined, CTX)].sort((a, b) => (a as { seq: number }).seq - (b as { seq: number }).seq);
    const messages: AgentMessage[] = [];
    const compactions: Array<Record<string, unknown>> = [];
    for (const entry of entries) {
      const e = entry as { type: string; message?: AgentMessage; summary?: string; retainedTail?: AgentMessage[]; tokensBefore?: number; seq: number };
      if (e.type === 'compaction') {
        compactions.push({ seq: e.seq, tokensBefore: e.tokensBefore, retainedTailRoles: (e.retainedTail ?? []).map((m) => (m as { role?: string }).role), retainedCount: (e.retainedTail ?? []).length });
        messages.push(...(e.retainedTail ?? []));
      } else if (e.type === 'message' && e.message) {
        messages.push(e.message);
      }
    }
    const reply = lastAssistantText(messages);
    turns.push({ index: i + 1, userLen: text.length, reply, replyEmpty: reply.startsWith('[[no-text'), error, ms: Date.now() - t0, compactionEntriesInTranscript: compactions });
    writeFileSync(path.join(outDir, 'turns.json'), JSON.stringify(turns, null, 2));
    writeFileSync(path.join(outDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeFileSync(path.join(outDir, 'model-calls.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(path.join(outDir, 'execs.json'), JSON.stringify(execs, null, 2));

    const calls = records.length;
    const tokens = records.reduce((s, r) => s + (Number(((r['usage'] as { totalTokens?: number })?.totalTokens) ?? 0)), 0);
    const wall = Date.now() - startedAt;
    if (calls > LIMITS.maxCalls || tokens > LIMITS.maxTokens || wall > LIMITS.wallMs) { stopped = true; break; }
  }

  const compStarts = events.filter((e) => e['type'] === 'compaction_start');
  const compEnds = events.filter((e) => e['type'] === 'compaction_end');
  const summary = {
    scenario: scenarioId,
    mode: 'bare-AgentHarness',
    model: modelId,
    provider: 'openai-completions',
    configuredContextWindow: windowSize,
    windowLowered: windowSize < 262144,
    maxOutputTokens: maxOut,
    compactionSettings: compaction,
    wallMs: Date.now() - startedAt,
    turns: turns.length,
    emptyTurns: turns.filter((t) => t['replyEmpty'] === true).length,
    modelCalls: records.length,
    summaryCalls: records.filter((r) => r['kind'] === 'completeSimple').length,
    totalTokens: records.reduce((s, r) => s + (Number(((r['usage'] as { totalTokens?: number })?.totalTokens) ?? 0)), 0),
    totalInputTokens: records.reduce((s, r) => s + (Number(((r['usage'] as { input?: number })?.input) ?? 0)), 0),
    totalOutputTokens: records.reduce((s, r) => s + (Number(((r['usage'] as { output?: number })?.output) ?? 0)), 0),
    compactionStarts: compStarts.map((e) => e['reason']),
    compactionEnds: compEnds.map((e) => ({ status: e['status'], reason: e['reason'], error: (e['error'] as { code?: string } | undefined)?.code })),
    retryScheduled: events.filter((e) => e['type'] === 'retry_scheduled').length,
    toolExecs: execs.length,
    execStatuses: execs.reduce((acc: Record<string, number>, e) => { const k = String(e['status']); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
    stoppedAtLimit: stopped,
  };
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  await harness.close(CTX).catch(() => undefined);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`done → ${outDir}`);
}

await main().catch((error: unknown) => {
  console.error('r5p4-bare 失败：', error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
