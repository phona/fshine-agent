// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置（本文件按仓内 eval 夹具跑）：AGENT_CONFIG_PATH=scripts/eval/eval.agent.yaml +
// 脚本化驱动，不碰真平台。通用闭环只认 typecheck + unit + generic-mock，本文件证据不冒充通用证据。
/**
 * 离线全链 e2e：直连工具面下的真实生命周期四态（2026-11-12 建）。
 *
 * 覆盖四件事，每件都要求**真实触发**生产路径，不用"普通新请求碰巧成功"顶替：
 *   L1 原 taskId 续跑：第二回合带同一 taskId 重派 → 宿主持有同一条任务底账、同一子 Agent
 *      会话（转录断点续跑），平台夹具账本里**同一个 taskId 累计**（新建任务会多出一条键，
 *      这就是"不是新建任务碰巧成功"的机械判据）；
 *   L2 飞行中停止：后台任务运行途中用户说停 → task_control cancel 真实中止在飞 worker；
 *      停止后不再产生第二笔平台副作用；说停回合有限时间内返回；终态报告来自宿主事件链；
 *   L3 task_event 后台继续：多步计划的后台步完成后，宿主经真实事件订阅 → Main 在
 *      task_event 回合继续派下一步 → 全步完成后 Main 汇总并主动推送（不是用户再发一句）；
 *   L4 消息重复交付幂等：同一 messageId 投两次 → 第二次不重跑 worker、不产生第二笔副作用，
 *      重放原终稿（D-119 的直连工具面回归锁）。
 *
 * 替身边界（与其它 e2e 同哲学）：只假模型（脚本化 Main/worker）与执行器（仓内 dummy 夹具，
 * 读 FSHINE_EVAL_FIXTURE_STATE_DIR 的 per-case 状态根）；runtime 回合契约、计划门与激活令牌、
 * BackgroundTaskManager、SQLite 底账、handler 的会话串行队列、task_event 事件链全是生产代码。
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { evaluateAndActivatePlan, type PlanCall, type PlanCliRunner } from '../../packages/agent/src/plan-runtime';
import { gatewayExecPath } from '../../packages/agent/src/platform-contract';
import {
  LAST_TASK_ID_TOKEN,
  boot,
  fixtureAuditRows,
  fixturePlans,
  gatedWorker,
  gatewayCliPath,
  mainDriver,
  operationScripts,
  GATEWAY,
  PLATFORM_ROOT,
  type Boot,
} from './harness';

const PRINCIPAL = 'wecom:e2e_user';
const SESSION = 'wecom:e2e_user';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

/** 宿主持有的平台任务底账（platform_tasks：inline 与后台委派都写，按子任务 taskId 一条）。 */
async function platformTasksOf(booted: Boot) {
  return booted.assembly.store.platformTasks!.listBySession(PRINCIPAL, SESSION);
}

/** 后台运行底账（task_runs：只有后台派发才产生，一次派发一条 run）。 */
async function runsOf(booted: Boot) {
  return booted.assembly.store.taskRuns!.listBySession(PRINCIPAL, SESSION);
}

/** 仓内夹具账本里成功执行过的 dummy.query 行数（每次真实平台调用一行，拒绝行不带 exitCode 0）。 */
function fixtureQueryCalls(): number {
  return fixtureAuditRows().filter((row) => row['script'] === 'dummy.query' && row['exitCode'] === 0).length;
}

/** 一条 dummy 读调用（仓内夹具的中性域：collection + window，与真实执行层同协议形状）。 */
function dummyQuery(collection: string, window = 'W1'): PlanCall {
  return { operation: 'dummy.query', args: ['--collection', collection, '--window', window] };
}

/** 计划步骤请求：宿主只认「第N/M步：」前缀（domain 无关），这里用它触发后台步事件链。 */
function step(n: number, total: number, request: string): string {
  return `第${n}/${total}步：${request}`;
}

function planCliRunner(): PlanCliRunner {
  return ({ platformRoot, args, input, env }) => {
    const child = spawnSync(gatewayExecPath(platformRoot, GATEWAY), args, {
      input, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env },
    });
    return Promise.resolve({ code: child.status ?? 1, stdout: child.stdout ?? '', stderr: child.stderr ?? '' });
  };
}

describe('[L4 集成] 直连生命周期 · L1 原 taskId 续跑（同一任务、同一断点）', () => {
  it('第二回合带同一 taskId 重派：底账一条、会话续跑、平台账本同键累计', async () => {
    const taskIdBox = { value: '' };
    // 记录 worker 每次 run 收到的会话编号与转录（断点证据）。
    const inner = gatedWorker([
      { plan: [dummyQuery('alpha')] },
      { text: 'alpha 组查询完成：W1 有 2 条记录。' },
      { end: true },
      { plan: [dummyQuery('beta')] },
      { text: 'beta 组也查询完成：W1 有 1 条记录。全部完成。' },
      { end: true },
    ]);
    const workerRuns: Array<{ sessionId?: string; messages: unknown[] }> = [];
    const worker = {
      run: async (input: { sessionId?: string; messages: unknown[] }) => {
        workerRuns.push({ sessionId: input.sessionId, messages: input.messages });
        return inner.run(input as never);
      },
    };
    let booted: Boot | null = null;
    try {
      booted = await boot({
        main: mainDriver(
          [
            { kind: 'delegate', request: '查询 alpha 组的数据' },
            { kind: 'delegate', request: '继续查询 beta 组的数据', taskId: LAST_TASK_ID_TOKEN },
          ],
          undefined,
          { taskIdProvider: () => taskIdBox.value },
        ),
        worker: worker as never,
      });

      // 第一回合：普通单步委派，结果 terminate 成本轮回复
      const first = await booted.send('查一下 alpha 组的数据');
      expect(first).toContain('alpha 组查询完成');
      const afterFirst = await platformTasksOf(booted);
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0]!.outcome).toBe('done');
      taskIdBox.value = afterFirst[0]!.taskId;
      expect(taskIdBox.value).toMatch(/^task_/);
      const firstPlanState = fixturePlans();
      expect(Object.keys(firstPlanState.tasks ?? {})).toEqual([taskIdBox.value]);
      // 夹具的任务级 actual 不累计（累计账在计划级）：按该任务的 latestPlan 读本次计划的
      // 实际调用数——一次成功查询在平台侧留下 1 条真实计数。
      const firstLatest = firstPlanState.tasks?.[taskIdBox.value]?.latestPlanId ?? '';
      expect(firstPlanState.plans?.[firstLatest]?.version).toBe(1);
      expect(firstPlanState.plans?.[firstLatest]?.actual?.calls).toBe(1);
      expect(fixtureQueryCalls()).toBe(1);

      // 第二回合：用户说"继续"，Main 带 taskId 重派——宿主必须复用原任务
      const second = await booted.send('继续查 beta 组');
      expect(second).toContain('beta 组也查询完成');

      // ① 宿主底账仍只有一条，且是同一 taskId（新建任务会多一条记录）
      const records = await platformTasksOf(booted);
      expect(records).toHaveLength(1);
      expect(records[0]!.taskId).toBe(taskIdBox.value);
      expect(records[0]!.outcome).toBe('done');
      // 转录断点：第二回合的 task 条目里两轮内容都在
      const transcript = JSON.stringify(records[0]!.workerMessages);
      expect(transcript).toContain('alpha 组查询完成');
      expect(transcript).toContain('beta 组也查询完成');

      // ② worker 第二跑落在同一子 Agent 会话，且拿到了第一回合的转录（从断点继续，不从零重付）
      expect(workerRuns).toHaveLength(2);
      expect(workerRuns[1]!.sessionId).toBe(taskIdBox.value);
      const secondTranscript = JSON.stringify(workerRuns[1]!.messages);
      expect(secondTranscript).toContain('alpha 组查询完成');

      // ③ 平台夹具账本：同一个 taskId 键（不是新任务）、计划版本推进到 2、第二笔查询真实计数
      //    （新建任务会在 tasks 里多出一条新键；同一任务的新计划才是 version 2）
      const plans = fixturePlans();
      expect(Object.keys(plans.tasks ?? {})).toEqual([taskIdBox.value]);
      const latestPlanId = plans.tasks?.[taskIdBox.value]?.latestPlanId ?? '';
      expect(plans.plans?.[latestPlanId]?.taskId).toBe(taskIdBox.value);
      expect(plans.plans?.[latestPlanId]?.version).toBe(2);
      expect(plans.plans?.[latestPlanId]?.actual?.calls).toBe(1);
      // 平台侧审计：恰好两笔成功查询（两回合一笔）
      expect(fixtureQueryCalls()).toBe(2);
    } finally {
      await booted?.assembly.close();
    }
  }, 30_000);
});

describe('[L4 集成] 直连生命周期 · L2 飞行中停止（副作用在停点截止，状态如实回报）', () => {
  /**
   * 在飞 worker 替身：真提交计划、真跑第一笔调用，然后**等待中止信号**；被中止则不再发起
   * 第二笔（第二笔就是"停止后不得再产生的副作用"的探针），没被中止才继续跑完并如实记录。
   */
  function inFlightWorker(observation: {
    runs: number;
    executed: string[];
    abortedAtReturn: boolean;
    secondCallAfterAbort: boolean;
  }) {
    return {
      run: async (input: {
        sessionId?: string;
        requestId?: string;
        messages: unknown[];
        signal?: AbortSignal;
        onNotice?: (text: string) => Promise<void>;
      }) => {
        observation.runs += 1;
        const taskId = input.sessionId ?? 'task_unknown';
        const plan = await evaluateAndActivatePlan({
          platformRoot: PLATFORM_ROOT,
          taskId,
          requestId: input.requestId,
          calls: [dummyQuery('alpha'), dummyQuery('beta')],
          onNotice: input.onNotice,
          runCli: planCliRunner(),
          activationSecret: process.env['EXECUTION_PLAN_ACTIVATION_SECRET'],
        });
        if (plan.status !== 'active') {
          return { text: plan.message, messages: [...input.messages, { role: 'assistant', content: plan.message, timestamp: Date.now() }] };
        }
        const script = operationScripts.get('dummy.query');
        const runCall = (collection: string): void => {
          spawnSync(gatewayCliPath(), ['query', script!, '--collection', collection, '--window', 'W1'], {
            cwd: PLATFORM_ROOT, encoding: 'utf8', timeout: 30_000,
            env: { ...process.env, EXECUTION_PLAN_ID: plan.planId, EXECUTION_REQUIRE_PLAN: '1' },
          });
          observation.executed.push(collection);
        };
        runCall('alpha');
        // 停在两笔调用之间等用户说停：中止信号由 BackgroundTaskManager.cancel → AbortController
        const aborted = await until(() => input.signal?.aborted === true, 8_000);
        if (!aborted) {
          runCall('beta');
          observation.secondCallAfterAbort = true;
        }
        observation.abortedAtReturn = input.signal?.aborted === true;
        // 中止后的返回形状与真实驱动一致（WT-1/WT-3 同款）：**空 text** + 部分转录。
        // 宿主的取消分类走"空文本 → 抛 → 按 runSignal.aborted 分类 cancelled"这条
        // 生产路径；返回一段叙述文本反而会被当成完成结果。
        return {
          text: aborted ? '' : '两笔查询都已执行完成。',
          execution: { planId: plan.planId, version: plan.version, calls: observation.executed.length },
          messages: aborted
            ? [...input.messages, { role: 'assistant', content: '（部分转录）第一笔查询已完成，等待后续。', timestamp: Date.now() }]
            : [...input.messages, { role: 'assistant', content: '两笔查询都已执行完成。', timestamp: Date.now() }],
        };
      },
    };
  }

  it('说停 → 在飞 worker 被真实中止、零新副作用、终态事件如实推送', async () => {
    const observation = { runs: 0, executed: [] as string[], abortedAtReturn: false, secondCallAfterAbort: false };
    const taskIdBox = { value: '' };
    let booted: Boot | null = null;
    try {
      booted = await boot({
        workerDispatchMode: 'background',
        main: mainDriver(
          [
            { kind: 'delegate', request: '查询 alpha 组和 beta 组的数据' },
            { kind: 'task_control', action: 'cancel', taskId: LAST_TASK_ID_TOKEN, text: '已经请求停止，任务状态以宿主查询为准。' },
          ],
          undefined,
          { taskIdProvider: () => taskIdBox.value },
        ),
        worker: inFlightWorker(observation) as never,
      });

      // 第一回合：后台受理，回复是受理回执（不是结果）
      const accepted = await booted.send('查一下 alpha 组和 beta 组的数据');
      expect(accepted).toMatch(/受理|排队/);
      const acceptedRuns = await runsOf(booted);
      expect(acceptedRuns).toHaveLength(1);
      taskIdBox.value = acceptedRuns[0]!.taskId;

      // 等第一笔真实调用落地（证明任务在飞行中，而不是还没开跑）
      const flying = await until(() => fixtureQueryCalls() >= 1, 8_000);
      expect(flying).toBe(true);
      expect(observation.executed).toEqual(['alpha']);

      // 第二回合：用户说停——必须有限时间内返回（P0 停机死等的回归锁）
      const stopReply = await booted.send('停掉这个任务，不查了');
      expect(stopReply).not.toBe('');
      expect(stopReply).not.toContain('处理失败');

      // ① 在飞 worker 真实收到中止并在中止态收尾；第二笔调用没有发生
      const settled = await until(() => observation.abortedAtReturn, 8_000);
      expect(settled).toBe(true);
      expect(observation.secondCallAfterAbort).toBe(false);
      expect(observation.executed).toEqual(['alpha']);
      // ② 平台侧零新增副作用：成功查询仍只有第一笔
      expect(fixtureQueryCalls()).toBe(1);

      // ③ 终态如实：任务落 cancelled，宿主终态事件把"已取消"推给用户（不是静默）
      const cancelled = await until(async () => (await runsOf(booted)).some((run) => run.state === 'cancelled'), 8_000);
      expect(cancelled).toBe(true);
      const cancelledRun = (await runsOf(booted)).find((run) => run.state === 'cancelled');
      expect(cancelledRun?.taskId).toBe(taskIdBox.value);
      const reported = await until(() => booted!.sdk.sentMessages.some((message) => message.content.includes('已取消')), 8_000);
      expect(reported).toBe(true);
    } finally {
      await booted?.assembly.close();
    }
  }, 30_000);
});

describe('[L4 集成] 直连生命周期 · L3 task_event 后台继续（事件链驱动 Main，不靠用户再发话）', () => {
  it('两步后台计划：步完成事件真的唤回 Main 派下一步，全完成后 Main 汇总主动推送', async () => {
    const taskIdBox = { value: '' };
    const observedMessages: unknown[][] = [];
    const inner = gatedWorker([
      { plan: [dummyQuery('alpha')] },
      { text: '第 1 步完成：alpha 组 W1 有 2 条记录。' },
      { end: true },
      { plan: [dummyQuery('beta')] },
      { text: '第 2 步完成：beta 组 W1 有 1 条记录。' },
      { end: true },
    ]);
    const workerRuns: Array<{ sessionId?: string }> = [];
    const worker = {
      run: async (input: { sessionId?: string; messages: unknown[] }) => {
        workerRuns.push({ sessionId: input.sessionId });
        return inner.run(input as never);
      },
    };
    let booted: Boot | null = null;
    booted = await boot({
      workerDispatchMode: 'background',
      main: mainDriver(
        [
          { kind: 'delegate', request: step(1, 2, '查询 alpha 组的数据') },
          { kind: 'delegate', request: step(2, 2, '查询 beta 组的数据'), taskId: LAST_TASK_ID_TOKEN },
          { kind: 'conversation', text: '两步都完成了：alpha 组 2 条、beta 组 1 条。' },
        ],
        (input) => observedMessages.push(input.messages),
        { taskIdProvider: () => taskIdBox.value },
      ),
      worker: worker as never,
    });
    try {
      // 第一回合：第一步以后台受理收口（回执），任务编号来自宿主底账
      const accepted = await booted.send('把 alpha 和 beta 两组数据都查一遍');
      expect(accepted).toMatch(/受理|排队/);
      const firstRuns = await runsOf(booted);
      expect(firstRuns).toHaveLength(1);
      taskIdBox.value = firstRuns[0]!.taskId;

      // ① 第一步完成事件真实唤回了 Main：出现过 task_event 注入消息的回合
      const sawEvent = await until(
        () => observedMessages.some((messages) => messages.some((message) => (message as { customType?: string } | null)?.customType === 'background_task_event')),
        10_000,
      );
      expect(sawEvent).toBe(true);

      // ② 第二步真的被派出去并完成：两次 worker run、同一子 Agent 会话、同一计划两步事实
      const secondStepDone = await until(async () => {
        const records = await runsOf(booted!);
        return records.length === 2 && records.every((run) => run.state === 'completed');
      }, 10_000);
      expect(secondStepDone).toBe(true);
      expect(workerRuns).toHaveLength(2);
      expect(workerRuns.every((run) => run.sessionId === taskIdBox.value)).toBe(true);
      // 同一子任务与同一计划：两步 run 的 planId 相同、平台任务底账仍是一条
      const stepRuns = await runsOf(booted);
      expect(stepRuns[0]!.planId).toBeDefined();
      expect(stepRuns[1]!.planId).toBe(stepRuns[0]!.planId);
      const platformTasks = await platformTasksOf(booted);
      expect(platformTasks).toHaveLength(1);
      expect(platformTasks[0]!.taskId).toBe(taskIdBox.value);
      expect(platformTasks[0]!.outcome).toBe('done');

      // ③ 宿主把两步都作为事件链里的事实记账（计划投影可查），且两步都在平台上真跑过
      expect(fixtureQueryCalls()).toBe(2);

      // ④ 全步完成后 Main 的汇总**主动推送**到会话（不是用户又发了一句的回执）
      const pushed = await until(
        () => booted!.sdk.sentMessages.some((message) => message.content.includes('两步都完成了')),
        10_000,
      );
      expect(pushed).toBe(true);
    } finally {
      await booted?.assembly.close();
    }
  }, 30_000);
});

describe('[L4 集成] 直连生命周期 · L4 平台消息重复交付幂等（同一 messageId 两次）', () => {
  it('重投同一 messageId：不重跑 worker、零第二笔副作用、重放原终稿', async () => {
    let workerRuns = 0;
    const inner = gatedWorker([
      { plan: [dummyQuery('alpha')] },
      { text: 'alpha 组查询完成：W1 有 2 条记录。' },
      { end: true },
    ]);
    let booted: Boot | null = null;
    booted = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查询 alpha 组的数据' }]),
      worker: {
        run: async (input: { messages: unknown[] }) => {
          workerRuns += 1;
          return inner.run(input as never);
        },
      } as never,
    });
    try {
      const messageId = 'msg_redeliver_lifecycle_e2e';
      const first = await booted.send('查一下 alpha 组的数据', { messageId });
      expect(first).toContain('alpha 组查询完成');
      expect(workerRuns).toBe(1);
      expect(fixtureQueryCalls()).toBe(1);

      // 平台重投同一 messageId：命中消息级幂等，不重跑任何一方
      const second = await booted.send('查一下 alpha 组的数据', { messageId });
      expect(second).toContain('之前已处理过');
      expect(second).toContain('alpha 组查询完成');
      expect(workerRuns).toBe(1);
      expect(fixtureQueryCalls()).toBe(1);
    } finally {
      await booted?.assembly.close();
    }
  }, 30_000);
});
