/**
 * P3-A 压缩与恢复 · S1 正式会话执行器（真实模型 step-3.7-flash；W=8192；执行器硬停）。
 *
 * 预注册（.runtime/r5phase3/prereg.md）：S1 maxModelCalls=60 / maxTokens=900k / 墙钟 45min；
 * 一次采样、不重采样、全样本保留（含失败样本）。
 *
 * 装配与生产同源：materializeEvalConfig + assembleSessionCore + resolveExecutionFace +
 * createBackgroundDispatch（Main 委派 Worker → Execution Contract 结构化调用 dummy 执行层）。
 * 驱动链：pi 真实驱动 → recordingDriver（工具调用/回合证据）→ createEnforcingDriver（硬停）。
 * 压缩机械证据：pi-driver console 结构化事件（context_emergency_compact / context_compacted）
 * + 转录「此前会话摘要」标记 + 逐回合 estimateContextTokens（压缩前后 token 曲线）。
 *
 * 运行：LLM_API_KEY 在 .env；node --import tsx scripts/eval/p3/p3a-session.ts <workDir>
 */

import { mkdirSync, writeFileSync } from 'node:fs';
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
import {
  createBudgetLedger,
  createEnforcingDriver,
  P3BudgetHardStopError,
  type P3BudgetEvent,
  type P3BudgetStop,
} from './enforce';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');

// ── S1 预注册预算（prereg.md 表：60 calls / 900k tokens / 45min）────────────────
const LIMITS = { maxModelCalls: 60, maxTokens: 900_000, wallMs: 45 * 60 * 1000 } as const;

// ── 自然多轮业务语料（不用无意义填充；每轮有真实业务对象与接续关系）──────────────
const TURNS: string[] = [
  // ① 首个任务：建立「需要保留的任务上下文」（编号 + 对象 + 结论）。
  '帮我查一下 alpha 集合在 W1 窗口的记录，核对一共有几条、总金额是多少，并把这次委派任务的编号告诉我——这个编号、对象和结论后面还要用，请务必保留好。',
  '再查一下 beta 集合 W1 窗口的记录，和刚才 alpha@W1 的结果对比一下，告诉我两个集合哪个总额更高、差多少。',
  '接着查 alpha 集合在 W2 窗口的记录，和 alpha@W1 对比，说明同一个集合两个窗口的记录数差异。',
  '帮我查一下 documents 集合在 W202611 窗口的记录，核对第二条金额有没有问题，把结论记下来。',
  '再查 documents 在 W202610 窗口的记录，和 W202611 对比，两个窗口的记录数差多少。',
  '查一下 alpha-group 集合 W1 窗口的记录，把它和 alpha@W1 的结果放在一起汇总给我。',
  '把到目前为止所有查过的集合（alpha、beta、documents、alpha-group）各自的任务编号和结论列一个清单，按时间顺序。',
  '查一下 locked-one 集合 W1 窗口有什么记录，如果有异常请说明。',
  '查一下 empty-one 集合 W1 窗口，确认是不是空的，并把这个结论补充进刚才的清单。',
  '回到 documents 的核对：W202611 里同名不同值的那两条，各自金额是多少？结合之前的查询结果回答。',
  '把 alpha 集合两个窗口（W1、W2）的全部记录名称和数值列出来，标注所属窗口。',
  'beta@W1 三条记录里，单条金额最高的是哪条？多少？',
  '把今天所有核对过的集合按总金额从高到低排个序，给我最终汇总。',
  'documents W202610 与 W202611 的记录条数分别是多少？只用已有结论回答，若不确定再查。',
  '帮我确认 alpha@W1 和 alpha-group@W1 的记录加起来一共几条、总金额多少。',
  '把 documents 两个窗口的核对结论再整理一遍：哪个窗口有异常、异常是什么。',
  // ④ 压缩后继续交办（探针：引用早前编号/对象，不重新查询）。
  '现在回到最开始那个任务：不要重新查询，凭你保留的上下文告诉我——最早那次委派的任务编号是多少？查的是哪个集合哪个窗口？当时的结论是什么？',
  '也不要重新查询：把 alpha@W1 那个任务里两条记录的名称和数值原样复述出来，并重算总金额。',
  '基于你保留的全部上下文做最终汇总：今天一共委派了哪些任务（编号）、每个任务查的对象和一句话结论。',
  '最后确认一次（不要查询）：我们第一个任务的对象和结论，与第 17、18 轮你复述的一致吗？如有不一致请指出。',
];

// ── 压缩机械事件捕获（单会话无并发，直接 console 补丁；名字集与 business-e2e 同源）──
const DRIVER_EVENT_NAMES: ReadonlySet<string> = new Set([
  'context_emergency_compact', 'context_compacted', 'context_compact_failed',
  'context_compact_no_cut', 'context_compact_degraded', 'context_compact_trimmed',
  'pi_driver_empty_reply', 'pi_driver_model_error', 'pi_driver_error',
  'pi_driver_failed_assistant', 'pi_driver_context_overflow_recovered', 'pi_driver_final_text_nudge',
]);

interface ToolCallFact { turn: number; agent: 'main' | 'worker'; tool: string; args: unknown; resultSummary: string }

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}：超时（${ms}ms）`)), Math.max(ms, 1));
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

// 汇总写盘在 main 外再包一层（replies 在 main 内部才可见）。
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
  const sessionId = `p3a-s1-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
  const scope: TaskScope = { principalId, sessionId };

  const calls: ToolCallFact[] = [];
  const perTurnDriverEvents: Array<{ turn: number } & Record<string, unknown>> = [];
  const turnStats: Array<Record<string, unknown>> = [];
  const replies: Array<{ turn: number; text: string }> = [];
  const ledger = createBudgetLedger(LIMITS);
  let stopped: P3BudgetStop | null = null;
  const turnRef = { turn: 0 };

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
              calls.push({ turn: turnRef.turn, agent, tool, args: argsCopy, resultSummary: summary.length <= 400 ? summary : `${summary.slice(0, 400)}…` });
              return result;
            } catch (error) {
              calls.push({ turn: turnRef.turn, agent, tool, args: argsCopy, resultSummary: `ERROR: ${error instanceof Error ? error.message : String(error)}` });
              throw error;
            }
          },
        };
        return await inner.run(wrappedInput);
      },
      ...(inner.compact ? { compact: inner.compact.bind(inner) } : {}),
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
      assertIsolation: () => assertEvalIsolation(assessEvalIsolation({ env, platformRoot: profile.root, gateway: profile.gateway }), 'p3a-s1'),
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
    try {
      for (let index = 0; index < TURNS.length; index += 1) {
        turnRef.turn = index + 1;
        currentTaskIds = [];
        const startedMs = Date.now();
        const remaining = LIMITS.wallMs - (Date.now() - wallStart);
        let reply = '';
        try {
          const result = await withTimeout(Promise.resolve(session.send(TURNS[index]!)), remaining, 'S1 会话墙钟');
          reply = result?.reply ?? '';
          await dispatch.runner.whenIdle();
          currentTaskIds = [...(result?.taskIds ?? [])];
        } catch (error) {
          if (error instanceof P3BudgetHardStopError) {
            stopped = error.stop;
            replies.push({ turn: index + 1, text: `<<P3BudgetHardStop: ${JSON.stringify(error.stop)}>>` });
            turnStats.push({ turn: index + 1, hardStop: true, durationMs: Date.now() - startedMs });
            break;
          }
          throw error;
        }
        const transcript = [...session.transcript()];
        turnStats.push({
          turn: index + 1, replyChars: reply.length,
          transcriptTokens: estimateContextTokens(transcript as never).tokens,
          transcriptMessages: transcript.length,
          hasSummaryMarker: JSON.stringify(transcript).includes('此前会话摘要'),
          taskIds: currentTaskIds, durationMs: Date.now() - startedMs,
        });
        replies.push({ turn: index + 1, text: reply });
      }
      tasksJson = JSON.parse(JSON.stringify(session.tasks()));
    } finally {
      console.warn = saved.warn; console.info = saved.info; console.error = saved.error; console.log = saved.log;
      writeFileSync(path.join(workDir, 'tasks.json'), JSON.stringify(tasksJson, null, 2));
      assembled.close();
    }
  } finally {
    registry.close();
  }

  const evidence = {
    manifest: {
      sample: 'S1', purpose: 'P3-A 压缩与恢复（真实模型会话）', date: new Date().toISOString(),
      model: env['LLM_MODEL'] ?? null, contextWindow: windowOpts.contextWindow ?? null,
      sessionId, principalId, limits: LIMITS,
      budgetStopped: stopped, budgetUsed: ledger.used,
    },
    turns: TURNS.map((text, i) => ({ index: i + 1, text })),
    replies, turnStats, driverEvents: perTurnDriverEvents, toolCalls: calls,
    budgetEvents: ledger.events,
  };
  writeFileSync(path.join(workDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ manifest: evidence.manifest, turnStats, compactionEvents: perTurnDriverEvents.filter((e) => String(e['event']).startsWith('context_')) }, null, 2));
}

if (import.meta.main) {
  await run().catch((error: unknown) => {
    console.error('p3a-session 失败：', error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
