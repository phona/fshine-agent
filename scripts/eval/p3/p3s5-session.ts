/**
 * R5 P3 追加调查 · S5 机制定位会话执行器（真实模型 step-3.7-flash；W=8192；执行器硬停）。
 *
 * 目的：据 S4 证据（压缩塌缩致空答 + turn19/20 取消无对象的控制意图执行失败），定位
 * 机制层：探针覆盖**明确取消（按编号）**、**指代取消（描述/序数指代）**、**结果找回
 * （跨压缩引用既有任务）**、**连续多轮交办**；前段（未压缩）与后段（真实压缩后）成对
 * 相同指令原文，逐项判控制意图是否落地（取消后任务是否仍在跑、是否后续派发、是否重复
 * 执行）。压缩时点/任务状态由既有 driverEvents + turnStats 机械记录。
 * 预算：maxModelCalls=80 / maxTokens=1.2M / 墙钟 60min；一次采样、不重采样、全样本保留。
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
import { estimateContextTokens } from '@earendil-works/pi-agent-core';
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
// --dry 干跑：maxModelCalls=0 ⇒ 首轮回合前即硬停，零模型调用（装配校验用）。
const DRY = process.env['P3S5_DRY'] === '1';
const EFFECTIVE_LIMITS = DRY ? { ...LIMITS, maxModelCalls: 0 } : LIMITS;

// probe 标注：轮号 → {probeId, 段（pre/post/filler）}，供判复现时对照。
const PROBES: Record<number, { probeId: string; phase: 'pre' | 'filler' | 'post' }> = {
  1: { probeId: 'establish-alpha', phase: 'pre' }, 2: { probeId: 'establish-beta', phase: 'pre' },
  3: { probeId: 'establish-logistics', phase: 'pre' },
  4: { probeId: 'K1-explicit-cancel-no2', phase: 'pre' }, 5: { probeId: 'K1-cancel-check', phase: 'pre' },
  6: { probeId: 'K2-anaphoric-cancel', phase: 'pre' }, 7: { probeId: 'K2-cancel-check', phase: 'pre' },
  8: { probeId: 'K3-result-recovery', phase: 'pre' },
  9: { probeId: 'filler-bankflow', phase: 'filler' }, 10: { probeId: 'filler-documents', phase: 'filler' },
  11: { probeId: 'filler-fabrikam', phase: 'filler' }, 12: { probeId: 'filler-contoso-trade', phase: 'filler' },
  13: { probeId: 'establish-trade', phase: 'post' }, 14: { probeId: 'establish-documents', phase: 'post' },
  15: { probeId: 'K4-explicit-cancel-no5', phase: 'post' }, 16: { probeId: 'K4-cancel-check', phase: 'post' },
  17: { probeId: 'K5-anaphoric-cancel', phase: 'post' }, 18: { probeId: 'K5-cancel-check', phase: 'post' },
  19: { probeId: 'K6-result-recovery-post', phase: 'post' },
  20: { probeId: 'K7-multi-dispatch', phase: 'post' }, 21: { probeId: 'K7-multi-check', phase: 'post' },
  22: { probeId: 'K8-anaphoric-cancel-last', phase: 'post' },
};

// ── 自然多轮业务语料（P3-B：交办/多任务/话题切换/失败接续/取消/交替读回）──────────
const TURNS: string[] = [
  // ── 前段：建立 3 个编号任务，随后控制意图探针 ──────────
  '先帮我查一下 alpha 集合 W1 窗口的记录总额，把任务编号告诉我。',
  '同时再帮我开一个任务：查 beta 集合 W1 的记录，把任务编号告诉我。',
  'contoso-logistics W1 也查一下有什么，把任务编号告诉我。',
  // K1 明确取消（按编号）。
  '把 2 号任务取消，不要做了。',
  // K1 取消核查。
  '确认一下：2 号任务现在是什么状态？现在还有没有在跑的任务？',
  // K2 指代取消（描述指代=物流）。
  '把那个物流的停掉。',
  // K2 取消核查。
  '现在还有没有在跑的任务？有没有任务被重复执行？如实说。',
  // K3 结果找回（压缩前基线：1 号已完成）。
  '1 号任务的结果再给我一遍，不要重新查询。',
  // ── 填充段：抬升转录迫使真实压缩发生 ──────────────────
  '再开一个任务：查 bankflow-oct 2025-10 的记录，逐条列出来，说明有没有异常。',
  'documents W202610 的记录也查一下，第二条金额是多少？',
  'fabrikam W1 查一下记录。我指的是 fabrikam-retail。',
  'contoso-trade W1 也查一下有什么。',
  // ── 后段（目标：真实压缩已发生后）────────────────────
  '再开一个任务：重新查 contoso-trade W1，把任务编号告诉我。',
  '再开一个任务：查 documents W202610，把任务编号告诉我。',
  // K4 明确取消（按编号）。
  '把 5 号任务取消，不要做了。',
  // K4 取消核查。
  '确认一下：5 号任务现在是什么状态？现在还有没有在跑的任务？',
  // K5 指代取消（描述性指代=贸易）。
  '把贸易那个也停掉。',
  // K5 取消核查 + 重复执行探针。
  '现在还有没有在跑的任务？刚才取消的有有没有继续出结果或者重复执行？如实说。',
  // K6 压缩后结果找回（跨压缩引用 1 号）。
  '1 号任务的结果再给我一遍，不要重新查询。',
  // K7 连续多轮交办（一次两个）。
  '马上再帮我开两个任务：一个查 fabrikam-retail W1，一个查 bankflow-oct 2025-10。',
  // K7 交办核查（编号与状态）。
  '这两个新任务的编号分别是多少？各自现在什么状态？',
  // K8 指代取消（序数指代=后开的）。
  '把后开的那个取消掉。',
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
  const sessionId = `p3s5-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
  const scope: TaskScope = { principalId, sessionId };

  const calls: ToolCallFact[] = [];
  const perTurnDriverEvents: Array<{ turn: number } & Record<string, unknown>> = [];
  const turnStats: Array<Record<string, unknown>> = [];
  const replies: Array<{ turn: number; text: string }> = [];
  const taskFacts: Array<{ ts: string; taskId: string; taskNo?: number; to: string; turn: number }> = [];
  const ledger = createBudgetLedger(EFFECTIVE_LIMITS);
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
      assertIsolation: () => assertEvalIsolation(assessEvalIsolation({ env, platformRoot: profile.root, gateway: profile.gateway }), 'p3s5'),
      emptyOperationsMessage: '空允许集合，拒绝',
      taskRegistry: registry, policy,
      createDrivers: () => drivers,
      createExecutionFace: async () => face,
      taskRunner: dispatch.runner,
      dispatchMode: 'background',
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
          const result = await withTimeout(Promise.resolve(session.send(TURNS[index]!)), remaining, 'S5 会话墙钟');
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
      writeFileSync(path.join(workDir, 'meta.json'), JSON.stringify({ turns: metaTurns, driverEvents: perTurnDriverEvents, probes: PROBES, notes: ['S5 机制定位会话；task-facts 为逐轮快照差分（ts=轮末），非亚秒级事件流'] }, null, 2));
      writeFileSync(path.join(workDir, 'tasks.json'), JSON.stringify(tasksJson, null, 2));
      writeFileSync(path.join(workDir, 'evidence.json'), JSON.stringify({
        manifest: {
          sample: 'S5', purpose: 'R5 P3 追加调查·S5 机制定位（控制意图落地：明确取消/指代取消/结果找回/连续多轮交办；压缩前后对照）', date: new Date().toISOString(),
          model: env['LLM_MODEL'] ?? null, contextWindow: windowOpts.contextWindow ?? null,
          sessionId, principalId, limits: EFFECTIVE_LIMITS,
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
    console.error('p3s5-session 失败：', error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
