/**
 * P3-B 长会话执行扩散 · S2 正式会话执行器（真实模型 step-3.7-flash；W=8192；执行器硬停）。
 *
 * 预注册（.runtime/r5phase3/prereg.md）：S2 maxModelCalls=80 / maxTokens=1.2M / 墙钟 60min；
 * 一次采样、不重采样、全样本保留（含失败样本）。
 *
 * 轮次设计（P3-B）：交办 → 多任务并发 → 话题切换 → 失败接续 → 取消 → 取消后核查 →
 * 多任务交替读回 → 最终汇总清单。判据：执行调用数无理由增长、任务不自行裂变、
 * 无重复执行/错误对象/取消后仍派发；轨2 四档分级 + D6 指标。
 *
 * 装配与生产同源（与 p3a-session.ts 同链）；额外落 D6 run-dir 面（tool-calls.json /
 * task-facts.jsonl / meta.json / tasks.json），跑完调轨2 extractD6 只读抽取。
 *
 * 运行：LLM_API_KEY 在 .env；node --import tsx scripts/eval/p3/p3b-session.ts <workDir>
 */

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import type { AppConfig } from '@fshine/contracts';
import { estimateContextTokens } from '../token-estimate';
import { createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import type { TurnDriver, TurnDriverInput } from '../../../packages/agent/src/driver-contract';
import { createResourcePolicy } from '../../../packages/agent/src/resource-policy';
import { createSqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import type { TaskScope } from '../../../packages/agent/src/task-registry';
import { materializeEvalConfig } from '../../resolve-config-path';
import {
  assembleSessionCore,
  contextWindowFrom,
  createBackgroundDispatch,
  resolveExecutionFace,
} from '../../ask-runtime';
import { assessEvalIsolation, assertEvalIsolation } from '../safety-gate';
import { extractD6 } from '../business-e2e/d6-metrics';
import {
  createBudgetLedger,
  createEnforcingDriver,
  P3BudgetHardStopError,
  type P3BudgetStop,
} from './enforce';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');

// ── S2 预注册预算（prereg.md 表：80 calls / 1.2M tokens / 60min）────────────────
const LIMITS = { maxModelCalls: 80, maxTokens: 1_200_000, wallMs: 60 * 60 * 1000 } as const;

// ── 自然多轮业务语料（P3-B：交办/多任务/话题切换/失败接续/取消/交替读回）──────────
const TURNS: string[] = [
  // ① 交办首个任务。
  '先帮我查一下 alpha 集合 W1 窗口的记录总额，一共几条、总金额多少，把任务编号告诉我。',
  // ② 多任务：再开一个并行任务。
  '同时再帮我开一个任务：查 beta 集合 W1 的记录，回头我要和 alpha 对比。',
  // ③ 话题切换（插入另一业务域）。
  '对了，插一件事：documents 集合 W202611 第二条记录金额是多少？有没有同名不同值的情况？',
  // ④ 状态 + 读回。
  '刚才 alpha 和 beta 两个任务跑完了吗？分别告诉我结论。',
  // ⑤ 对比（只用已有结论）。
  'alpha@W1 和 beta@W1 哪个总额更高？差多少？只用已有结论回答。',
  // ⑥ 歧义名（可能触发澄清）。
  '再开一个任务：查 contoso 在 W1 的记录。',
  // ⑦ 澄清答复接续。
  '我指的是贸易那家，就是 contoso-trade。',
  // ⑧ 失败注入（readFault → failed）。
  'faulty-one 集合 W1 也查一下有什么。',
  // ⑨ 失败接续（重试）。
  '刚才 faulty-one 失败了？再试一次。',
  // ⑩ 放弃失败任务 + 新任务。
  '还是不行的话就别管 faulty-one 了，改查 empty-one W1 是不是空的。',
  // ⑪ 受限集合（GATE_REFUSE → refused）。
  'denied-one W1 也查一下。',
  // ⑫ 大任务（多对象汇总）。
  '现在帮我开个大任务：把 bankflow-oct 2025-10、documents 两个窗口、contoso-trade W1 的记录全部汇总核对，逐项说明异常。',
  // ⑬ 取消。
  '等等，刚才那个汇总任务先取消，不要做了。',
  // ⑭ 取消后核查（状态）。
  '确认一下：被取消的任务现在是什么状态？现在还有没有在跑的任务？',
  // ⑮ 取消后核查（残留执行）。
  '取消之后它有没有继续出结果或者重复执行？如实说。',
  // ⑯ 多任务交替读回 1。
  '回来继续：alpha@W1 和 beta@W1 的结论分别是什么？不要重新查询。',
  // ⑰ 交替读回 2。
  'documents W202610 与 W202611 的记录条数差多少？',
  // ⑱ 交替读回 3。
  'contoso-trade W1 的总额再确认一遍。',
  // ⑲ 交替读回 4（含失败/空集合结论）。
  'empty-one 的结论是什么？faulty-one 最终结论是什么？denied-one 呢？',
  // ⑳ 最终汇总清单（含取消任务）。
  '把今天所有任务按编号列一个总清单：每个任务查的对象、当前状态、一句话结论；被取消的那个也要列出来。',
];

const DRIVER_EVENT_NAMES: ReadonlySet<string> = new Set([
  'context_emergency_compact', 'context_compacted', 'context_compact_failed',
  'context_compact_no_cut', 'context_compact_degraded', 'context_compact_trimmed',
  'pi_driver_empty_reply', 'pi_driver_model_error', 'pi_driver_error',
  'pi_driver_failed_assistant', 'pi_driver_context_overflow_recovered', 'pi_driver_final_text_nudge',
]);

interface ToolCallFact {
  turn: number; agent: 'main' | 'worker'; seq: number; tool: string;
  args: unknown; resultSummary: string; startedAt: string; elapsedMs: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}：超时（${ms}ms）`)), Math.max(ms, 1));
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

interface TaskSnapshot { taskId: string; taskNo?: number; request: string; status: string }

async function run(): Promise<void> {
  const workDir = process.argv[2]!;
  mkdirSync(workDir, { recursive: true });
  const stateDir = path.join(workDir, 'state');
  const dbDir = path.join(workDir, 'db');
  const configDir = path.join(workDir, 'config');
  for (const d of [stateDir, dbDir, configDir]) mkdirSync(d, { recursive: true });
  const dbPath = path.join(dbDir, 'state.db');
  const configCopy = path.join(configDir, 'agent-config.yaml');
  materializeEvalConfig(FIXTURE_CONFIG, configCopy);
  const fs = await import('node:fs');
  const doc = parseYaml(fs.readFileSync(configCopy, 'utf8')) as Record<string, unknown>;
  doc['store'] = { dbPath };
  writeFileSync(configCopy, stringifyYaml(doc));

  const config: AppConfig = loadConfig({ yamlPath: configCopy });
  const env = effectiveDeploymentEnv(config, { ...process.env, LLM_MODEL: 'step-3.7-flash', LLM_CONTEXT_WINDOW: '8192' });
  if ((env['LLM_API_KEY'] ?? '').trim() === '') throw new Error('未检测到 LLM_API_KEY（fail-closed）。');
  const windowOpts = contextWindowFrom(env);
  if (windowOpts.contextWindow !== 8192) throw new Error(`窗口装配漂移：${windowOpts.contextWindow}`);

  const profile = config.contextProfiles[Object.keys(config.contextProfiles)[0]!]!;
  const principalId = Object.entries(config.principals).find(([, p]) => p.enabled)![0];
  const sessionId = `p3b-s2-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
  const scope: TaskScope = { principalId, sessionId };

  const calls: ToolCallFact[] = [];
  const perTurnDriverEvents: Array<{ turn: number } & Record<string, unknown>> = [];
  const turnStats: Array<Record<string, unknown>> = [];
  const replies: Array<{ turn: number; text: string }> = [];
  const taskFacts: Array<{ ts: string; taskId: string; taskNo?: number; to: string; turn: number }> = [];
  const ledger = createBudgetLedger(LIMITS);
  let stopped: P3BudgetStop | null = null;
  const turnRef = { turn: 0 };
  let seqRef = 0;
  let prevStatus = new Map<string, string>();

  function snapshotTaskFacts(): void {
    const ts = new Date().toISOString();
    // 由调用方在拿到 tasks() 后传入；此函数在 main 内闭包不易，改为独立实现（见循环内）。
    void ts;
  }
  void snapshotTaskFacts;

  function recordingDriver(inner: TurnDriver, agent: 'main' | 'worker'): TurnDriver {
    const wrapped: TurnDriver = {
      async run(input: TurnDriverInput) {
        const wrappedInput: TurnDriverInput = {
          ...input,
          exec: async (tool, args, signal) => {
            const startedMs = Date.now();
            const argsCopy = JSON.parse(JSON.stringify(args));
            try {
              const result = await input.exec(tool, args, signal);
              let summary = '';
              try { summary = JSON.stringify(result) ?? ''; } catch { summary = String(result); }
              seqRef += 1;
              calls.push({ turn: turnRef.turn, agent, seq: seqRef, tool, args: argsCopy, resultSummary: summary.length <= 400 ? summary : `${summary.slice(0, 400)}…`, startedAt: new Date(startedMs).toISOString(), elapsedMs: Date.now() - startedMs });
              return result;
            } catch (error) {
              seqRef += 1;
              calls.push({ turn: turnRef.turn, agent, seq: seqRef, tool, args: argsCopy, resultSummary: `ERROR: ${error instanceof Error ? error.message : String(error)}`, startedAt: new Date(startedMs).toISOString(), elapsedMs: Date.now() - startedMs });
              throw error;
            }
          },
        };
        return await inner.run(wrappedInput);
      },
      ...(inner.synthesizeAssistant ? { synthesizeAssistant: inner.synthesizeAssistant.bind(inner) } : {}),
    };
    return wrapped;
  }

  const registry = createSqliteTaskRegistry(dbPath);
  const policy = createResourcePolicy();
  try {
    const face = await resolveExecutionFace({ profile, env, stateDir, emptyOperationsMessage: '空允许集合，拒绝' });
    const base = {
      mainDriver: createPiTurnDriver({ env, ...windowOpts }),
      workerDriver: createPiTurnDriver({ env, ...windowOpts }),
    };
    const drivers = {
      mainDriver: createEnforcingDriver(recordingDriver(base.mainDriver, 'main'), 'main', ledger),
      workerDriver: createEnforcingDriver(recordingDriver(base.workerDriver, 'worker'), 'worker', ledger),
    };
    const dispatch = await createBackgroundDispatch({
      env, profile, stateDir, registry, policy, emptyOperationsMessage: '空允许集合，拒绝',
      face, workerDriver: drivers.workerDriver,
    });
    const assembled = await assembleSessionCore({
      env, profile, principalId, sessionId, dbPath, stateDir, setAuditPath: true,
      assertIsolation: () => assertEvalIsolation(assessEvalIsolation({ env, platformRoot: profile.root, gateway: profile.gateway }), 'p3b-s2'),
      emptyOperationsMessage: '空允许集合，拒绝',
      taskRegistry: registry, policy,
      createDrivers: () => drivers,
      createExecutionFace: async () => face,
      taskRunner: dispatch.runner,
      taskDispatch: 'async',
    });
    const session = assembled.session;

    const saved = { warn: console.warn, info: console.info, error: console.error, log: console.log };
    const wrap = (orig: (...a: unknown[]) => void) => (...args: unknown[]): void => {
      const text = args.map((a) => (typeof a === 'string' ? a : '')).join(' ').trim();
      if (text.startsWith('{')) {
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          if (parsed['event'] !== undefined && DRIVER_EVENT_NAMES.has(String(parsed['event']))) {
            perTurnDriverEvents.push({ turn: turnRef.turn, ...parsed });
          }
        } catch { /* 非 JSON */ }
      }
      orig(...args);
    };
    console.warn = wrap(saved.warn.bind(console));
    console.info = wrap(saved.info.bind(console));
    console.error = wrap(saved.error.bind(console));
    console.log = wrap(saved.log.bind(console));

    const wallStart = Date.now();
    let tasksJson: unknown = [];
    let currentTaskIds: string[] = [];
    const metaTurns: Array<{ index: number; durationMs: number; modelCalls: number; taskIds: string[] }> = [];
    try {
      for (let index = 0; index < TURNS.length; index += 1) {
        turnRef.turn = index + 1;
        currentTaskIds = [];
        const startedMs = Date.now();
        const callsBefore = ledger.used.calls;
        const remaining = LIMITS.wallMs - (Date.now() - wallStart);
        let reply = '';
        try {
          const result = await withTimeout(Promise.resolve(session.send(TURNS[index]!)), remaining, 'S2 会话墙钟');
          reply = result?.reply ?? '';
          await dispatch.runner.whenIdle();
          currentTaskIds = [...(result?.taskIds ?? [])];
        } catch (error) {
          if (error instanceof P3BudgetHardStopError) {
            stopped = error.stop;
            replies.push({ turn: index + 1, text: `<<P3BudgetHardStop: ${JSON.stringify(error.stop)}>>` });
            turnStats.push({ turn: index + 1, hardStop: true, durationMs: Date.now() - startedMs });
            metaTurns.push({ index: index + 1, durationMs: Date.now() - startedMs, modelCalls: ledger.used.calls - callsBefore, taskIds: currentTaskIds });
            break;
          }
          throw error;
        }
        const ts = new Date().toISOString();
        const tasksNow = JSON.parse(JSON.stringify(session.tasks())) as TaskSnapshot[];
        for (const t of tasksNow) {
          if (prevStatus.get(t.taskId) !== t.status) {
            taskFacts.push({ ts, taskId: t.taskId, ...(t.taskNo !== undefined ? { taskNo: t.taskNo } : {}), to: t.status, turn: turnRef.turn });
            prevStatus.set(t.taskId, t.status);
          }
        }
        const transcript = [...session.transcript()];
        turnStats.push({
          turn: turnRef.turn, replyChars: reply.length,
          transcriptTokens: estimateContextTokens(transcript as never).tokens,
          transcriptMessages: transcript.length,
          taskIds: currentTaskIds, durationMs: Date.now() - startedMs,
        });
        metaTurns.push({ index: turnRef.turn, durationMs: Date.now() - startedMs, modelCalls: ledger.used.calls - callsBefore, taskIds: currentTaskIds });
        replies.push({ turn: turnRef.turn, text: reply });
      }
      tasksJson = JSON.parse(JSON.stringify(session.tasks()));
    } finally {
      console.warn = saved.warn; console.info = saved.info; console.error = saved.error; console.log = saved.log;
      // ── D6 run-dir 面（轨2 extractD6 只读消费）────────────────────
      writeFileSync(path.join(workDir, 'tool-calls.json'), JSON.stringify({ toolCalls: calls }, null, 2));
      const factsFile = path.join(workDir, 'task-facts.jsonl');
      writeFileSync(factsFile, '');
      for (const f of taskFacts) appendFileSync(factsFile, `${JSON.stringify(f)}\n`);
      writeFileSync(path.join(workDir, 'meta.json'), JSON.stringify({ turns: metaTurns, driverEvents: perTurnDriverEvents, notes: ['P3-B S2 会话；task-facts 为逐轮快照差分（ts=轮末），非亚秒级事件流'] }, null, 2));
      writeFileSync(path.join(workDir, 'tasks.json'), JSON.stringify(tasksJson, null, 2));
      writeFileSync(path.join(workDir, 'evidence.json'), JSON.stringify({
        manifest: {
          sample: 'S2', purpose: 'P3-B 长会话执行扩散（真实模型会话）', date: new Date().toISOString(),
          model: env['LLM_MODEL'] ?? null, contextWindow: windowOpts.contextWindow ?? null,
          sessionId, principalId, limits: LIMITS,
          budgetStopped: stopped, budgetUsed: ledger.used,
        },
        turns: TURNS.map((text, i) => ({ index: i + 1, text })),
        replies, turnStats, driverEvents: perTurnDriverEvents, toolCalls: calls,
        budgetEvents: ledger.events,
      }, null, 2));
      assembled.close();
    }
  } finally {
    registry.close();
  }

  // ── D6 抽取（轨2 纯函数，只读 run-dir）──────────────────────────
  const d6 = extractD6(workDir);
  writeFileSync(path.join(workDir, 'd6.json'), JSON.stringify(d6, null, 2));
  console.log(JSON.stringify({ manifest: { model: env['LLM_MODEL'], contextWindow: windowOpts.contextWindow, budgetStopped: stopped, budgetUsed: ledger.used }, turnStats, d6 }, null, 2));
}

if (import.meta.main) {
  await run().catch((error: unknown) => {
    console.error('p3b-session 失败：', error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
