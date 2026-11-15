#!/usr/bin/env node
/**
 * 阶段 D 入口：A 长对话 / B 业务任务 / C 跨轮协作 / D 多用户稳定性。
 *
 * 真实模型 `step-3.7-flash`；执行层 = 仓内 dummy 平台 + 可控 mock（create_record / 故障注入）。
 * 零真实企微、零真实 SaaS、零真实业务写。
 *
 * 用法：
 *   # 只做装配自检（零模型、零网络）
 *   node --import tsx scripts/eval/pi152-stageD/run.ts --selftest
 *   # 真实运行（需 .env；预算已冻结在 BUDGET.md / .runtime/pi152-stageD/budget.md）
 *   node --env-file-if-exists=.env --import tsx scripts/eval/pi152-stageD/run.ts --run
 *
 * 硬停：任一预算达限即停全部后续回合/组，保留已完成部分，不补跑、不筛绿。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TurnDriver } from '../../../packages/agent/src/driver-contract';
import { createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import { createScriptedModelRuntime } from '../../../packages/agent/testing/scripted-model-runtime';
import type { TaskScope } from '../../../packages/agent/src/task-registry';
import {
  buildSession,
  createBudgetMeter,
  finalizeRestart,
  prepareGroup,
  restartSession,
  seedCompletedTask,
  seedWaitingTask,
  sendTurn,
  type BudgetMeter,
  type GroupEvidence,
  type SessionHandle,
} from './harness';
import { computeMetrics, renderReport } from './metrics';
import {
  A_TURNS,
  B_TURNS,
  C_TURNS,
  C_WAITING_SEED,
  D_USERS,
  STAGE_D_BUDGET,
  STAGE_D_CONFIG,
  type GroupId,
  type StageTurn,
} from './scenarios';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_OUT = path.join(REPO_ROOT, '.runtime', 'pi152-stageD');
const BUDGET_DOC = path.join(REPO_ROOT, 'scripts', 'eval', 'pi152-stageD', 'BUDGET.md');

interface Args {
  mode: 'gate' | 'selftest' | 'selftest-restart' | 'selftest-d' | 'run';
  groups: GroupId[];
  out: string;
  maxModelCalls: number;
  maxTokens: number;
  wallMs: number;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = {
    mode: 'gate',
    groups: ['A', 'B', 'C', 'D'],
    out: DEFAULT_OUT,
    maxModelCalls: STAGE_D_BUDGET.maxModelCalls,
    maxTokens: STAGE_D_BUDGET.maxTokens,
    wallMs: STAGE_D_BUDGET.wallMs,
  };
  for (const arg of argv) {
    if (arg === '--run') args.mode = 'run';
    else if (arg === '--selftest') args.mode = 'selftest';
    else if (arg === '--selftest-restart') args.mode = 'selftest-restart';
    else if (arg === '--selftest-d') args.mode = 'selftest-d';
    else if (arg === '--gate' || arg === '--infra-gate') args.mode = 'gate';
    else if (arg.startsWith('--out=')) args.out = path.resolve(REPO_ROOT, arg.slice('--out='.length));
    else if (arg.startsWith('--group=') || arg.startsWith('--groups=')) {
      const raw = arg.slice(arg.indexOf('=') + 1).split(',').map((item) => item.trim().toUpperCase()).filter((item) => item !== '');
      const invalid = raw.filter((item) => !['A', 'B', 'C', 'D'].includes(item));
      if (invalid.length > 0) return { error: `--group 只接受 A/B/C/D：${invalid.join(',')}` };
      args.groups = raw as GroupId[];
    } else if (arg.startsWith('--max-model-calls=')) {
      const n = Number.parseInt(arg.slice('--max-model-calls='.length), 10);
      if (!Number.isSafeInteger(n) || n < 1) return { error: '--max-model-calls 需要正整数' };
      if (n > STAGE_D_BUDGET.maxModelCalls) return { error: `--max-model-calls ${n} 超过冻结上限 ${STAGE_D_BUDGET.maxModelCalls}` };
      args.maxModelCalls = n;
    } else if (arg.startsWith('--max-tokens=')) {
      const n = Number.parseInt(arg.slice('--max-tokens='.length), 10);
      if (!Number.isSafeInteger(n) || n < 1) return { error: '--max-tokens 需要正整数' };
      if (n > STAGE_D_BUDGET.maxTokens) return { error: `--max-tokens ${n} 超过冻结上限 ${STAGE_D_BUDGET.maxTokens}` };
      args.maxTokens = n;
    } else if (arg.startsWith('--wall-ms=')) {
      const n = Number.parseInt(arg.slice('--wall-ms='.length), 10);
      if (!Number.isSafeInteger(n) || n < 1) return { error: '--wall-ms 需要正整数' };
      if (n > STAGE_D_BUDGET.wallMs) return { error: `--wall-ms ${n} 超过冻结上限 ${STAGE_D_BUDGET.wallMs}` };
      args.wallMs = n;
    } else {
      return { error: `未知参数：${arg}` };
    }
  }
  return args;
}

function jsonSafe<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return String(value) as unknown as T;
  }
}

async function runGroupA(prepared: Awaited<ReturnType<typeof prepareGroup>>, meter: BudgetMeter): Promise<GroupEvidence> {
  const started = Date.now();
  const scope: TaskScope = { principalId: 'wecom:stage-d-a', sessionId: 'stage-d-a-session' };
  const build = (resumeFile?: string) => buildSession({
    group: 'A',
    prepared,
    key: 'a',
    principalId: scope.principalId,
    sessionId: scope.sessionId,
    scope,
    dispatchMode: 'inline',
    withRunner: false,
    ...(resumeFile === undefined ? {} : { resumeFile }),
  });
  let handle = await build();
  const sessions = [handle.sink];
  const restarts: GroupEvidence['restarts'] = [];
  try {
    for (let index = 0; index < A_TURNS.length; index += 1) {
      if (meter.reached() !== null) break;
      const turn = A_TURNS[index]!;
      const afterRestart = index > 0 && A_TURNS[index - 1]!.restartAfter === true;
      await sendTurn(handle, turn, index + 1, { afterRestart });
      if (afterRestart && restarts.length > 0) finalizeRestart(restarts[restarts.length - 1]!, handle, '蓝鲸-42');
      if (turn.restartAfter === true) {
        const resumeFile = handle.sessionFile();
        if (resumeFile === undefined) throw new Error('A 重启前没有落盘会话文件');
        const restarted = await restartSession({
          handle,
          build: () => build(resumeFile),
          priorMarker: '蓝鲸-42',
        });
        handle = restarted.handle;
        sessions.push(handle.sink);
        restarts.push(restarted.record);
      }
    }
  } finally {
    handle.close();
  }
  return { group: 'A', keys: ['a'], sessions, restarts, usageWallMs: Date.now() - started };
}

async function runGroupB(prepared: Awaited<ReturnType<typeof prepareGroup>>, meter: BudgetMeter): Promise<GroupEvidence> {
  const started = Date.now();
  const scope: TaskScope = { principalId: 'wecom:stage-d-b', sessionId: 'stage-d-b-session' };
  let handle = await buildSession({
    group: 'B', prepared, key: 'b', principalId: scope.principalId, sessionId: scope.sessionId, scope,
    dispatchMode: 'inline',
    withRunner: true,
  });
  const sessions = [handle.sink];
  try {
    for (let index = 0; index < B_TURNS.length; index += 1) {
      if (meter.reached() !== null) break;
      await sendTurn(handle, B_TURNS[index]!, index + 1, { afterRestart: false });
      await handle.assembled.runner?.whenIdle();
    }
  } finally {
    handle.close();
  }
  return { group: 'B', keys: ['b'], sessions, restarts: [], usageWallMs: Date.now() - started };
}

async function runGroupC(prepared: Awaited<ReturnType<typeof prepareGroup>>, meter: BudgetMeter): Promise<GroupEvidence> {
  const started = Date.now();
  const scope: TaskScope = { principalId: 'wecom:stage-d-c', sessionId: 'stage-d-c-session' };
  seedWaitingTask({
    registry: prepared.registry,
    scope,
    request: C_WAITING_SEED.request,
    missing: C_WAITING_SEED.missing,
  });
  let handle = await buildSession({
    group: 'C', prepared, key: 'c', principalId: scope.principalId, sessionId: scope.sessionId, scope,
    dispatchMode: 'inline',
    withRunner: true,
  });
  const sessions = [handle.sink];
  try {
    for (let index = 0; index < C_TURNS.length; index += 1) {
      if (meter.reached() !== null) break;
      await sendTurn(handle, C_TURNS[index]!, index + 1, { afterRestart: false });
      await handle.assembled.runner?.whenIdle();
    }
  } finally {
    handle.close();
  }
  return { group: 'C', keys: ['c'], sessions, restarts: [], usageWallMs: Date.now() - started };
}

async function runGroupD(prepared: Awaited<ReturnType<typeof prepareGroup>>, meter: BudgetMeter): Promise<GroupEvidence> {
  const started = Date.now();
  const scopes = new Map(D_USERS.map((user) => [user.key, { principalId: user.principalId, sessionId: user.sessionId } satisfies TaskScope]));
  // 预置 alice #1（确定性编号）：请求/结果都带私事代号，用于跨用户隔离探针。
  const aliceScope = scopes.get('alice')!;
  seedCompletedTask({
    registry: prepared.registry,
    scope: aliceScope,
    request: '核对 alpha 集合 W1 的记录（alice 私事 ALICE-SECRET-7788）',
    resultText: 'alpha W1：2 条记录；私事代号 ALICE-SECRET-7788。',
  });

  const handles = new Map<string, SessionHandle>();
  const build = (userKey: string, resumeFile?: string) => {
    const user = D_USERS.find((entry) => entry.key === userKey)!;
    return buildSession({
      group: 'D',
      prepared,
      key: user.key,
      principalId: user.principalId,
      sessionId: user.sessionId,
      scope: scopes.get(user.key)!,
      dispatchMode: 'background',
      withRunner: true,
      ...(user.faultWindow === undefined ? {} : { faultWindow: user.faultWindow }),
      ...(resumeFile === undefined ? {} : { resumeFile }),
    });
  };

  const sessions: GroupEvidence['sessions'] = [];
  const restarts: GroupEvidence['restarts'] = [];
  try {
    for (const user of D_USERS) {
      const handle = await build(user.key);
      handles.set(user.key, handle);
      sessions.push(handle.sink);
    }
    const maxRounds = Math.max(...D_USERS.map((user) => user.turns.length));
    for (let round = 0; round < maxRounds; round += 1) {
      if (meter.reached() !== null) break;
      const active = D_USERS.filter((user) => round < user.turns.length);
      // alice 在第 4 回合结束后重启（第 5 回合在重启后）。
      if (round === 4) {
        const alice = handles.get('alice');
        if (alice !== undefined) {
          const resumeFile = alice.sessionFile();
          if (resumeFile === undefined) throw new Error('D/alice 重启前没有落盘会话文件');
          const restarted = await restartSession({
            handle: alice,
            build: () => build('alice', resumeFile),
            priorMarker: 'ALICE-SECRET-7788',
          });
          handles.set('alice', restarted.handle);
          sessions.push(restarted.handle.sink);
          restarts.push(restarted.record);
        }
      }
      await Promise.all(active.map(async (user) => {
        const handle = handles.get(user.key)!;
        const turn: StageTurn = user.turns[round]!;
        await sendTurn(handle, turn, round + 1, { afterRestart: user.key === 'alice' && round === 4 });
        await handle.assembled.runner?.whenIdle();
        if (user.key === 'alice' && round === 4 && restarts.length > 0) finalizeRestart(restarts[restarts.length - 1]!, handle, 'ALICE-SECRET-7788');
      }));
    }
  } finally {
    for (const handle of handles.values()) handle.close();
  }
  return { group: 'D', keys: D_USERS.map((user) => user.key), sessions, restarts, usageWallMs: Date.now() - started };
}

// ---------------------------------------------------------------- selftest (zero model)

function fakeMain(): TurnDriver {
  let turn = 0;
  return {
    async run(input) {
      turn += 1;
      if (turn === 1) await input.exec('run_task', { task: '核对 alpha 集合 W1 的记录' });
      if (turn === 2) await input.exec('task_status', {});
      const text = turn === 1 ? '已交办。' : '任务在办。';
      return { text, messages: [...input.messages, { role: 'assistant', content: text } as never] };
    },
  };
}

function fakeWorker(): TurnDriver {
  return {
    async run(input) {
      const tool = input.tools.find((entry) => entry.name === 'execute_operation') ?? input.tools[0]!;
      await input.exec(tool.name, { operation: 'dummy.query', args: { collection: 'alpha', window: 'W1' } });
      const text = '查询完成：2 条记录。';
      return { text, messages: [...input.messages, { role: 'assistant', content: text } as never] };
    },
  };
}

async function runSelftest(out: string): Promise<number> {
  const root = path.join(out, 'selftest');
  rmSync(root, { recursive: true, force: true });
  const meter = createBudgetMeter({ maxModelCalls: 0, maxTokens: 0, wallMs: 60_000 });
  const prepared = await prepareGroup({
    group: 'B',
    root,
    meter,
    envOverride: {
      LLM_API_KEY: 'selftest-placeholder',
      LLM_API_BASE_URL: 'http://127.0.0.1:9/v1',
      LLM_MODEL: 'test-model',
    },
  });
  const scope: TaskScope = { principalId: 'wecom:selftest', sessionId: 'selftest-session' };
  const handle = await buildSession({
    group: 'B',
    prepared,
    key: 'selftest',
    principalId: scope.principalId,
    sessionId: scope.sessionId,
    scope,
    dispatchMode: 'inline',
    withRunner: true,
    driverFactory: () => ({ mainDriver: fakeMain(), workerDriver: fakeWorker() }),
  });
  try {
    const first = await sendTurn(handle, { text: '帮我核对 alpha W1。', label: 'selftest-1' }, 1, { afterRestart: false });
    await handle.assembled.runner?.whenIdle();
    const second = await sendTurn(handle, { text: '任务状态？', label: 'selftest-2' }, 2, { afterRestart: false });
    await handle.assembled.runner?.whenIdle();
    const tasks = handle.assembled.session.tasks();
    const tools = handle.sink.toolCalls.map((call) => `${call.agent}:${call.tool}`);
    const assertions = [
      ['reply non-empty', first.reply.trim() !== '' && second.reply.trim() !== ''],
      ['run_task called', tools.includes('main:run_task')],
      ['execute_operation called', tools.includes('worker:execute_operation')],
      ['task_status called', tools.includes('main:task_status')],
      ['exactly 1 task', tasks.length === 1],
      ['task completed', tasks[0]?.status === 'completed'],
      ['main reply archived', tasks[0]?.replyText !== undefined && tasks[0]?.replyText !== null],
      ['execute once', tasks[0]?.executions.length === 1],
    ] as const;
    const failed = assertions.filter(([, ok]) => !ok);
    writeFileSync(path.join(root, 'selftest.json'), JSON.stringify({ assertions, tools, tasks, first, second }, null, 2));
    if (failed.length > 0) {
      console.error(`selftest FAIL：${failed.map(([name]) => name).join('、')}`);
      return 1;
    }
    console.log(`selftest PASS：${assertions.length} 项；tools=${tools.join(', ')}`);
    return 0;
  } finally {
    handle.close();
    prepared.registry.close();
  }
}



/** D 组装配自检：background runner + 共享 SQLite registry + 两用户并发（假驱动，零模型）。 */
async function runDSelftest(out: string): Promise<number> {
  const root = path.join(out, 'selftest-d');
  rmSync(root, { recursive: true, force: true });
  const meter = createBudgetMeter({ maxModelCalls: 10, maxTokens: 100_000, wallMs: 120_000 });
  const prepared = await prepareGroup({
    group: 'D', root, meter,
    envOverride: { LLM_API_KEY: 'selftest-placeholder', LLM_API_BASE_URL: 'http://127.0.0.1:9/v1', LLM_MODEL: 'test-model' },
  });
  const aliceScope: TaskScope = { principalId: 'wecom:selftest-alice', sessionId: 'selftest-alice-s' };
  const bobScope: TaskScope = { principalId: 'wecom:selftest-bob', sessionId: 'selftest-bob-s' };
  seedCompletedTask({
    registry: prepared.registry, scope: aliceScope,
    request: '核对 alpha 集合 W1 的记录（alice 私事 ALICE-SECRET-7788）',
    resultText: 'alpha W1：2 条记录；ALICE-SECRET-7788。',
  });
  const mainFor = (mode: 'run' | 'status'): TurnDriver => ({
    async run(input) {
      if (mode === 'run') await input.exec('run_task', { task: '核对 beta 集合 W1 的记录' });
      else await input.exec('task_status', { ref: '#1' });
      const text = mode === 'run' ? '已交办。' : '查不到该任务。';
      return { text, messages: [...input.messages, { role: 'assistant', content: text } as never] };
    },
  });
  const worker = (): TurnDriver => ({
    async run(input) {
      const tool = input.tools.find((entry) => entry.name === 'execute_operation') ?? input.tools[0]!;
      await input.exec(tool.name, { operation: 'dummy.query', args: { collection: 'beta', window: 'W1' } });
      const text = '查询完成。';
      return { text, messages: [...input.messages, { role: 'assistant', content: text } as never] };
    },
  });
  const alice = await buildSession({
    group: 'D', prepared, key: 'alice', principalId: aliceScope.principalId, sessionId: aliceScope.sessionId, scope: aliceScope,
    dispatchMode: 'background', withRunner: true,
    driverFactory: () => ({ mainDriver: mainFor('run'), workerDriver: worker() }),
  });
  const bob = await buildSession({
    group: 'D', prepared, key: 'bob', principalId: bobScope.principalId, sessionId: bobScope.sessionId, scope: bobScope,
    dispatchMode: 'background', withRunner: true,
    driverFactory: () => ({ mainDriver: mainFor('status'), workerDriver: worker() }),
  });
  try {
    await Promise.all([
      sendTurn(alice, { text: '核对 beta W1。', label: 'run' }, 1, { afterRestart: false }),
      sendTurn(bob, { text: '查 #1。', label: 'status' }, 1, { afterRestart: false }),
    ]);
    await Promise.all([alice.assembled.runner?.whenIdle(), bob.assembled.runner?.whenIdle()]);
    const aliceTasks = alice.assembled.session.tasks();
    const bobTasks = bob.assembled.session.tasks();
    const bobStatus = bob.sink.toolCalls.find((call) => call.tool === 'task_status');
    const assertions = [
      ['alice tasks completed', aliceTasks.length === 2 && aliceTasks.every((task) => task.status === 'completed')],
      ['bob has no task', bobTasks.length === 0],
      ['bob #1 not found', bobStatus?.isError === true],
      ['registry has 2 tasks', prepared.registry.list().length === 2],
    ] as const;
    const failed = assertions.filter(([, ok]) => !ok);
    writeFileSync(path.join(root, 'selftest-d.json'), JSON.stringify({ assertions, aliceTasks, bobTasks, bobStatus }, null, 2));
    if (failed.length > 0) {
      console.error(`selftest-d FAIL：${failed.map(([name]) => name).join('、')}`);
      return 1;
    }
    console.log(`selftest-d PASS：${assertions.length} 项`);
    return 0;
  } finally {
    alice.close();
    bob.close();
    prepared.registry.close();
  }
}

/** 重启自检：真实 Pi 驱动 + 脚本化 ModelRuntime（零网络），验证 sessionDir/resumeSessionFile 接法。 */
async function runRestartSelftest(out: string): Promise<number> {
  const root = path.join(out, 'selftest-restart');
  rmSync(root, { recursive: true, force: true });
  const meter = createBudgetMeter({ maxModelCalls: 20, maxTokens: 100_000, wallMs: 120_000 });
  const prepared = await prepareGroup({
    group: 'B',
    root,
    meter,
    envOverride: { LLM_API_KEY: 'selftest-placeholder', LLM_API_BASE_URL: 'http://127.0.0.1:9/v1', LLM_MODEL: 'test-model' },
  });
  const scripted = await createScriptedModelRuntime({
    modelId: 'test-model',
    contextWindow: 8_192,
    maxTokens: 2_048,
    script: (index) => ({
      role: 'assistant',
      content: [{ type: 'text', text: index === 0 ? '收到。' : 'TEST-9' }],
      api: 'openai-completions',
      provider: 'llm',
      model: 'test-model',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    } as never),
  });
  const sessionDir = path.join(root, 'sessions', 'restart');
  const workspaceDir = path.join(root, 'cwd', 'restart');
  const makeDrivers = (options: { resumeFile?: string }) => ({
    mainDriver: createPiTurnDriver({
      env: prepared.env,
      modelId: 'test-model',
      modelRuntime: scripted.runtime,
      contextWindow: 8_192,
      maxTokens: 2_048,
      reuseConversation: true,
      sessionDir,
      workspaceDir,
      ...(options.resumeFile === undefined ? {} : { resumeSessionFile: options.resumeFile }),
    }),
    workerDriver: createPiTurnDriver({
      env: prepared.env,
      modelId: 'test-model',
      modelRuntime: scripted.runtime,
      contextWindow: 8_192,
      maxTokens: 2_048,
      reuseConversation: false,
      workspaceDir: path.join(root, 'cwd', 'restart-worker'),
    }),
  });
  const scope: TaskScope = { principalId: 'wecom:selftest-restart', sessionId: 'selftest-restart-session' };
  const build = (resumeFile?: string) => buildSession({
    group: 'B', prepared, key: 'restart', principalId: scope.principalId, sessionId: scope.sessionId, scope,
    dispatchMode: 'inline',
    withRunner: false,
    driverFactory: makeDrivers,
    ...(resumeFile === undefined ? {} : { resumeFile }),
  });
  let handle = await build();
  try {
    const first = await sendTurn(handle, { text: '记住代号 TEST-9。' }, 1, { afterRestart: false });
    const file = handle.sessionFile();
    if (file === undefined) throw new Error('重启自检：会话未落盘');
    const restarted = await restartSession({ handle, build: () => build(file), priorMarker: 'TEST-9' });
    handle = restarted.handle;
    const second = await sendTurn(handle, { text: '代号是什么？' }, 2, { afterRestart: true });
    finalizeRestart(restarted.record, handle, 'TEST-9');
    const assertions = [
      ['first reply', first.reply.trim() !== ''],
      ['same session file', restarted.record.sameFile],
      ['prior marker present after reopen', restarted.record.priorUserMarkerPresent],
      ['no re-execution on reopen', restarted.record.reExecutedOnReopen === 0],
      ['second reply', second.reply.trim() !== ''],
    ] as const;
    const failed = assertions.filter(([, ok]) => !ok);
    writeFileSync(path.join(root, 'selftest-restart.json'), JSON.stringify({ assertions, first, second, restart: restarted.record }, null, 2));
    if (failed.length > 0) {
      console.error(`selftest-restart FAIL：${failed.map(([name]) => name).join('、')}`);
      return 1;
    }
    console.log(`selftest-restart PASS：${assertions.length} 项；file=${path.basename(file)}`);
    return 0;
  } finally {
    handle.close();
    prepared.registry.close();
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(parsed.error);
    return 2;
  }
  if (parsed.mode === 'selftest') return runSelftest(parsed.out);
  if (parsed.mode === 'selftest-restart') return runRestartSelftest(parsed.out);
  if (parsed.mode === 'selftest-d') return runDSelftest(parsed.out);
  if (parsed.mode === 'gate') {
    const hasKey = (process.env.LLM_API_KEY ?? '').trim() !== '';
    console.log(JSON.stringify({
      mode: 'infra-gate',
      budgetDoc: existsSync(BUDGET_DOC),
      llmKeyConfigured: hasKey,
      model: STAGE_D_CONFIG.model,
      note: '未发起任何真实模型请求；--run 才执行。',
    }, null, 2));
    return hasKey && existsSync(BUDGET_DOC) ? 0 : 2;
  }

  if (!existsSync(BUDGET_DOC)) {
    console.error('缺少冻结预算文档 scripts/eval/pi152-stageD/BUDGET.md——拒绝在未预注册的情况下运行真实模型。');
    return 2;
  }
  mkdirSync(parsed.out, { recursive: true });
  const meter = createBudgetMeter({ maxModelCalls: parsed.maxModelCalls, maxTokens: parsed.maxTokens, wallMs: parsed.wallMs });
  const startedAt = new Date().toISOString();
  const groups: GroupEvidence[] = [];
  let hardStop: string | null = null;

  for (const group of parsed.groups) {
    if (meter.reached() !== null) { hardStop = meter.reached(); break; }
    let prepared: Awaited<ReturnType<typeof prepareGroup>> | undefined;
    try {
      prepared = await prepareGroup({ group, root: parsed.out, meter });
      const evidence = group === 'A' ? await runGroupA(prepared, meter)
        : group === 'B' ? await runGroupB(prepared, meter)
          : group === 'C' ? await runGroupC(prepared, meter)
            : await runGroupD(prepared, meter);
      evidence.registryTasks = prepared.registry.list().map((task) => ({
        taskId: task.taskId,
        taskNo: task.taskNo ?? null,
        name: task.name ?? '',
        status: task.status,
        reason: task.reason ?? null,
        request: task.request,
        resultText: task.resultText ?? null,
        replyText: task.replyText ?? null,
        failureReason: task.failureReason ?? null,
        executions: task.executions.map((execution) => ({ requestId: execution.requestId, operation: execution.operation, status: execution.status })),
      }));
      groups.push(evidence);
      console.log(`[${group}] turns=${evidence.sessions.flatMap((s) => s.turns).length} calls=${evidence.sessions.flatMap((s) => s.modelCalls).length} wall=${evidence.usageWallMs}ms`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      groups.push({ group, keys: [], sessions: [], restarts: [], usageWallMs: 0, error: message });
      console.error(`[${group}] 失败：${message}`);
      if (meter.reached() !== null) { hardStop = meter.reached(); break; }
    } finally {
      prepared?.registry.close();
    }
    if (meter.reached() !== null) { hardStop = meter.reached(); break; }
  }

  const endedAt = new Date().toISOString();
  const report = computeMetrics(groups);
  const blocked = hardStop !== null || report.metrics.some((metric) => metric.verdict === 'FAIL');
  const evidence = {
    stage: 'D',
    startedAt,
    endedAt,
    model: STAGE_D_CONFIG.model,
    config: STAGE_D_CONFIG,
    budget: {
      samplesPerGroup: STAGE_D_BUDGET.samplesPerGroup,
      maxTurnsPerSession: STAGE_D_BUDGET.maxTurnsPerSession,
      maxModelCalls: parsed.maxModelCalls,
      maxTokens: parsed.maxTokens,
      wallMs: parsed.wallMs,
    },
    hardStop,
    blocked,
    meter: { modelCalls: meter.modelCalls, tokens: meter.tokens, wallMs: Date.now() - meter.startedAt },
    groups: jsonSafe(groups),
    metrics: report,
  };
  writeFileSync(path.join(parsed.out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  writeFileSync(path.join(parsed.out, 'metrics.json'), JSON.stringify(report, null, 2));
  writeFileSync(path.join(parsed.out, 'report.md'), renderReport({
    report,
    groups,
    budget: {
      maxModelCalls: parsed.maxModelCalls,
      maxTokens: parsed.maxTokens,
      wallMs: parsed.wallMs,
      samplesPerGroup: STAGE_D_BUDGET.samplesPerGroup,
      maxTurnsPerSession: STAGE_D_BUDGET.maxTurnsPerSession,
    },
    startedAt,
    endedAt,
    hardStop,
  }));
  const summary = {
    blocked,
    hardStop,
    totals: report.totals,
    metrics: report.metrics.map((metric) => ({ id: metric.id, name: metric.name, rate: metric.rate, verdict: metric.verdict })),
  };
  writeFileSync(path.join(parsed.out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  return blocked ? 1 : 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { main, runDSelftest, runSelftest, runRestartSelftest };
