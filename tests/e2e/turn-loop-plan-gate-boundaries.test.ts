// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：计划与预算门禁边界（A 组：A2 档位边界 / A3 累计账本 / A4 收敛保护 /
 * A5 写关闭三闸）。共享替身见 ./harness.ts。
 *
 * 覆盖与驱动方式：
 *   A2：AUTO=2 / NOTIFY=10 / CONFIRM=20 钉死档位边界——1、2 次直执行（execute），
 *       3 次（>AUTO）notify 且通知送达后才执行，10 次（=NOTIFY 上界，开区间）仍 notify，
 *       21 次（>CONFIRM）停在确认门、确认前零执行。
 *       （平台 decision 语义：calls > 档位才算越档，见执行层 src/execution/plan.js
 *       decision()——"达到"档位不升档。）
 *   A3：同一任务连提两个计划（1 调 → 2 调），ledger() 钉累计 actual 与 evaluate 看到的
 *       累计值（第二个计划若按新任务算落在 AUTO 档，实际触发 notify = evaluate 看见了
 *       1+2=3），delta 只计净新增。
 *   A4：收敛保护计数器在真实驱动 pi-coding-driver 的 beforeToolCall 里（harness 的
 *       gatedWorker 替身不复刻它），这里用真 createPiCodingWorkerSession + 真 CLI 驱动：
 *       实体越权计划连提 6 次，前 5 次 PLAN DECLINED，第 6 次 PLAN STOP：
 *       DECLINED_PLAN_LIMIT，且 evaluate 从未被调用（第 6 次不再产生新计划）。
 *   A5：写入口的新边界（2026-11-08 架构裁定：写能不能真落地归执行层，宿主不判"这个部署
 *       允不允许写"）——
 *       ① 计划扫描那一支已删：含写类 operation 的计划照常提交平台评估，平台计划门被真实
 *          咨询（原"evaluate 前拦截 + 合成 WRITE_NOT_ENABLED 终稿"整支退役）；
 *       ② 提案路径的办调前复核已删：worker 的提案创建命令照旧被驱动拦下交宿主办调，
 *          执行层自己的拒绝走 failed 分支上行（原"写声明关闭即确定性拒绝"整支退役）；
 *       ③ 平台计划门兜底保留并成为唯一分流点：voucher.commit 被平台 canonicalCall 以
 *          PLAN_OPERATION_NOT_READ_ONLY exit 3 拒绝，宿主只按平台语义表点名该调用、
 *          让它移出计划改为直接调用——不合成"未开放写入权限"的归因。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai/compat';
import { createPiCodingWorkerSession, type PiCodingWorkerSession } from '../../packages/agent/src/pi-coding-driver';
import { messageFor, messageTextFor } from '../../packages/agent/src/error-codes';
import type { PlanCliRunner } from '../../packages/agent/src/plan-runtime';
import type { PlanEntitySources } from '../../packages/agent/src/turn-contract';
import {
  LAST_TASK_ID_TOKEN,
  boot,
  gatewayProposalWorker,
  gatedWorker,
  growingPlan,
  heavyPlan,
  ledger,
  mainDriver,
  GATEWAY,
  gatewayCliPath,
  neutralizePlanGateNonCallLines,
  PLATFORM_ROOT,
  totalActualCalls,
} from './harness';

// ── 真实 pi-coding-worker 会话辅助（A4 / A5③ 用：替身不复刻这两段生产逻辑）────────

const sessionRoots: string[] = [];
afterEach(() => {
  for (const root of sessionRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fakeModelRuntime(): Promise<{ runtime: ModelRuntime; model: Model<any> }> {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('test', {
    name: 'Test',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'test-key',
    models: [{
      id: 'worker-test',
      name: 'worker-test',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_000,
      maxTokens: 1_000,
    }],
  });
  const model = runtime.getModel('test', 'worker-test');
  if (!model) throw new Error('test model was not registered');
  return { runtime, model };
}

/** 真 spawn 的 CLI runner（真计划门/账本），顺带计数 evaluate 调用。 */
function countingCliRunner(counter: { evaluates: number }): PlanCliRunner {
  return ({ args, input, env }) => new Promise((resolve, reject) => {
    if (args[1] === 'evaluate') counter.evaluates += 1;
    const child = spawnSync(gatewayCliPath(), args, {
      input, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env },
    });
    if (child.error) return reject(child.error);
    resolve({ code: child.status ?? 1, stdout: child.stdout ?? '', stderr: child.stderr ?? '' });
  });
}

interface SessionExtra {
  sessionId: string;
  entitySources?: PlanEntitySources;
  capabilities?: readonly string[];
  /** 平台 access 语义表替身（判据是平台数据：不在测试里跑 CLI 派生它）。 */
  operationSemantics?: ReadonlyMap<string, { plan: boolean; confirm: boolean; mock: boolean }>;
}

async function makeWorkerSession(counter: { evaluates: number }, extra: SessionExtra): Promise<PiCodingWorkerSession> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fshine-gate-boundaries-'));
  sessionRoots.push(root);
  const modelConfig = await fakeModelRuntime();
  return createPiCodingWorkerSession({
    cwd: PLATFORM_ROOT,
    skillRoots: [],
    systemPrompt: 'gate boundary test',
    agentDir: path.join(root, '.fshine-agent'),
    modelConfig,
    planCliRunner: countingCliRunner(counter),
    gateway: GATEWAY,
    ...extra,
    ...(extra.operationSemantics ? { operationSemantics: extra.operationSemantics } : {}),
  });
}

/** 复刻 pi-coding-driver.test.ts 的 beforeToolCall 驱动形态：worker 提交一条 bash。 */
function bashCall(
  worker: PiCodingWorkerSession,
  id: string,
  command: string,
): Promise<{ block?: boolean; reason?: string } | undefined> {
  return worker.session.agent.beforeToolCall?.({
    assistantMessage: {} as never,
    toolCall: { id, type: 'toolCall', name: 'bash', arguments: { command } } as never,
    args: { command },
    context: {} as never,
  }) as Promise<{ block?: boolean; reason?: string } | undefined>;
}

// ── A2：档位边界 ─────────────────────────────────────────────────────────

describe('[L4 集成] 离线全链 e2e：计划门档位边界（AUTO=2 / NOTIFY=10 / CONFIRM=20）', () => {
  it('A2 AUTO 档内：1 次调用直执行，零通知帧零确认帧', async () => {
    const { send, sdk, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查幻辰财税账套近 1 个月的应收账款' }]),
      worker: gatedWorker([{ plan: growingPlan(1) }]),
    });
    const reply = await send('查幻辰财税账套近 1 个月的应收账款');

    // 1 次在 AUTO 档（≤2）：不通知、不确认，门后直接执行
    expect(sdk.noticeTexts()).toHaveLength(0);
    expect(reply).not.toContain('确认继续');
    expect(totalActualCalls()).toBe(1);
    await assembly.close();
  });

  it('A2 AUTO 档上沿：2 次调用（=AUTO 档）仍直执行，零通知帧零确认帧', async () => {
    // D-145：隔离权重线与估时秒线（阈值设极大），本用例专测次数线边界——mock 查询每条
    // weight 6 / est 60 秒：权重线 2×6=12 越过 autoWeight 6，秒线 2×60=120 越过
    // autoSeconds 60（est 15→60 来自换芯 cda6ba9），不隔离都会把 execute 档抢推到 notify。
    onTestFinished(neutralizePlanGateNonCallLines());
    const { send, sdk, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查幻辰财税账套近 2 个月的应收账款' }]),
      worker: gatedWorker([{ plan: growingPlan(2) }]),
    });
    const reply = await send('查幻辰财税账套近 2 个月的应收账款');

    // 2 = AUTO 档不越界（decision 是 calls > autoCalls 才升档）
    expect(sdk.noticeTexts()).toHaveLength(0);
    expect(reply).not.toContain('确认继续');
    expect(totalActualCalls()).toBe(2);
    await assembly.close();
  });

  it('A2 AUTO→NOTIFY 边界：3 次调用（>AUTO=2）先通知，通知送达后才执行', async () => {
    const { send, sdk, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查幻辰财税账套近 3 个月的应收账款' }]),
      worker: gatedWorker([{ plan: growingPlan(3) }]),
    });
    const reply = await send('查幻辰财税账套近 3 个月的应收账款');

    const notices = sdk.noticeTexts();
    expect(notices.length).toBeGreaterThan(0);
    // notify 档不是确认档：用户不需要回复，通知送达即放行
    expect(reply).not.toContain('确认继续');
    // 通知帧早于最终回复帧：门在通知送达前不放行执行
    const noticeIndex = sdk.frames.findIndex((frame) => frame.content.startsWith('计划通知：'));
    const finalIndex = sdk.frames.map((frame) => frame.finish).lastIndexOf(true);
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeLessThan(finalIndex);
    expect(totalActualCalls()).toBe(3);
    await assembly.close();
  });

  it('A2 NOTIFY 档上沿：10 次调用（=NOTIFY 档，开区间上界）仍是通知档不是确认档', async () => {
    // D-145：隔离权重线与估时秒线，本用例专测次数线边界——10×6=60 已达 budgetWeight 60，
    // 不隔离的话权重线会把 notify 档抢推到 confirm（BUDGET_WEIGHT），"上界仍是通知档"
    // 就测不到了。
    onTestFinished(neutralizePlanGateNonCallLines());
    const { send, sdk, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查幻辰财税账套近 10 个月的应收账款' }]),
      worker: gatedWorker([{ plan: growingPlan(10) }]),
    });
    const reply = await send('查幻辰财税账套近 10 个月的应收账款');

    // decision() 是 calls > notifyCalls 才升档：10 = NOTIFY 档不越界
    expect(sdk.noticeTexts().length).toBeGreaterThan(0);
    expect(reply).not.toContain('确认继续');
    expect(totalActualCalls()).toBe(10);
    await assembly.close();
  });

  it('A2 CONFIRM 档：21 次调用（>CONFIRM=20）停在确认门，确认前零执行、确认后全量执行', async () => {
    const resumeInputs: string[] = [];
    const { send, sdk, assembly } = await boot({
      main: mainDriver([
        { kind: 'delegate', request: '查幻辰财税账套全年的应收账款' },
        { kind: 'delegate', request: '查幻辰财税账套全年的应收账款' },
      ], (input) => resumeInputs.push(JSON.stringify(input.messages))),
      worker: gatedWorker([
        { plan: heavyPlan(), stopAtConfirm: true },
        { execute: heavyPlan() },
        { text: '已按你确认的范围查完全年。' },
      ]),
    });
    const asked = await send('查幻辰财税账套全年的应收账款');

    expect(asked).toContain('确认继续');
    expect(sdk.noticeTexts().length).toBeGreaterThan(0);
    // 确认门与通知门的差别：通知送达即放行，确认必须等真实用户回复
    expect(totalActualCalls()).toBe(0);

    const done = await send('确认继续');
    expect(done).toContain('整理完成');
    // worker 按已激活计划真跑完 21 次调用，结果随续跑回合交还宿主
    expect(resumeInputs.join('')).toContain('查完全年');
    expect(totalActualCalls()).toBe(21);
    await assembly.close();
  });
});

// ── A3：账本累计 ─────────────────────────────────────────────────────────

describe('[L4 集成] 离线全链 e2e：计划累计账本', () => {
  it('A3 同一任务第二个计划看到累计 actual：2 调计划触发 notify，delta 只计净新增', async () => {
    const { send, sdk, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '先查幻辰财税 1 月应收，再扩到 1 至 2 月' }]),
      worker: gatedWorker([
        // 错误态快路径 v2 对齐：原首计划是单调用查 202601（无余额键）——快路径会在第二
        // 个计划提交前就以宿主话术收束本跳，"evaluate 看到累计 actual"的意图就观察不到
        // 了。本用例的意图是账本累计，首计划改查 202606（有余额键，真实成功），第二计划
        // 保留 202606（重复项）+ 202601（净新增 1）——累计 1+2=3 > AUTO=2 的档位判据不变。
        { plan: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202606'] }] },
        { plan: [
          { operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202606'] },
          { operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202601'] },
        ] },
      ]),
    });
    const reply = await send('先查幻辰财税 1 月应收，再扩到 1 至 2 月');

    // 关键证据：计划 2 只有 2 次调用——按新任务算落在 AUTO 档（≤2）应直执行；
    // 实际触发了唯一一条通知，证明 evaluate 看到的是累计值 1（actual）+ 2 = 3 > AUTO=2。
    expect(sdk.noticeTexts()).toHaveLength(1);
    expect(reply).not.toContain('确认继续');
    expect(totalActualCalls()).toBe(3);

    const state = ledger() as {
      tasks?: Record<string, { actual?: { calls?: number }; evaluateCount?: number }>;
      plans?: Record<string, { version: number; decision: string; delta?: { addedCalls?: number } }>;
    };
    const taskId = Object.keys(state.tasks ?? {})[0];
    expect(taskId).toBeTruthy();
    const task = state.tasks![taskId!]!;
    // 累计账本：同一任务 actual 跨计划累计，两个计划都 evaluate 过
    expect(task.actual?.calls).toBe(3);
    expect(task.evaluateCount).toBe(2);
    // delta 正确性：计划 2 的 calls 里有 1 次与计划 1 重复，净新增只有 1 次
    const plans = Object.values(state.plans ?? {}).sort((a, b) => a.version - b.version);
    expect(plans.map((plan) => plan.decision)).toEqual(['execute', 'notify']);
    expect(plans[1]?.delta?.addedCalls).toBe(1);
    await assembly.close();
  });
});

// ── A4：收敛保护（真驱动 + 真 CLI）────────────────────────────────────────

describe('[L4 集成] 离线全链 e2e：被拒计划收敛保护（DECLINED_PLAN_LIMIT）', () => {
  it('A4 同一任务连续 6 次提交越权计划：前 5 次 PLAN DECLINED，第 6 次收敛且不再产生新计划', async () => {
    const counter = { evaluates: 0 };
    const worker = await makeWorkerSession(counter, {
      sessionId: 'task_declined_limit',
      // 当前消息里没有任何账套名：计划里的账套参数必然越权（实体来源校验拒绝）
      entitySources: { currentMessage: '只查当前期间的应收账款' },
    });
    try {
      const command = `${GATEWAY} plan {"calls":[{"operation":"finance.query-receivables","args":["--query","幽灵账套有限公司","--period","202609"]}]}`;
      const verdicts: Array<{ block?: boolean; reason?: string } | undefined> = [];
      for (let i = 1; i <= 6; i += 1) {
        verdicts.push(await bashCall(worker, `call_declined_${i}`, command));
      }

      // 前 5 次：逐次 PLAN DECLINED（实体越权），且不预告收敛
      for (let i = 0; i < 5; i += 1) {
        expect(verdicts[i]?.block).toBe(true);
        expect(verdicts[i]?.reason).toContain('PLAN DECLINED');
        expect(verdicts[i]?.reason).toContain('ENTITY_OUT_OF_SCOPE');
        expect(verdicts[i]?.reason).not.toContain('DECLINED_PLAN_LIMIT');
      }
      // 第 6 次：超过 MAX_DECLINED_PLANS_PER_TASK=5，收敛为 PLAN STOP——
      // 话术与计数逐字钉死（码表唯一来源 messageFor）。D-099：计数是"自上次成功激活以来
      // 的提交次数"（本用例 6 次全是越权拒绝、零激活，所以它同时就是真实拒绝次数），不再
      // 说成"已被连续拒绝 N 次"——那种措辞在混合历史下是谎。
      expect(verdicts[5]?.block).toBe(true);
      expect(verdicts[5]?.reason).toBe(`PLAN STOP：${messageFor('DECLINED_PLAN_LIMIT', '连续 6 次提交方案均未激活')}`);
      // 第 6 次不再产生新计划：实体校验在 evaluate 之前，平台计划门全程未被咨询
      expect(counter.evaluates).toBe(0);
      expect(Object.keys(ledger().plans ?? {})).toEqual([]);
    } finally {
      worker.session.dispose();
    }
  });

  it('A4b 同一任务连续 6 次提交形状非法的计划：前 5 次 PLAN DECLINED（PLAN_JSON_PARSE），第 6 次收敛', async () => {
    const counter = { evaluates: 0 };
    const worker = await makeWorkerSession(counter, { sessionId: 'task_shape_limit' });
    try {
      // 2026-10-23 实测形状（req_368b68b3）：worker 把计划 JSON 用单引号包起来。
      // C3 前这类失败在 parsePlanCallsCommand 抛出点提前返回、从不计入 declinedPlans，
      // 11 连撞空转 4 分 11 秒 / 657k tokens；C3 起形状失败计入同一收敛计数器。
      const command = `${GATEWAY} plan '{"calls":[{"operation":"finance.query-receivables","args":["--query","幻辰财税","--period","202609"]}]}'`;
      const verdicts: Array<{ block?: boolean; reason?: string } | undefined> = [];
      for (let i = 1; i <= 6; i += 1) {
        verdicts.push(await bashCall(worker, `call_shape_${i}`, command));
      }

      // 前 5 次：逐次 PLAN DECLINED（形状诊断），且不预告收敛
      for (let i = 0; i < 5; i += 1) {
        expect(verdicts[i]?.block).toBe(true);
        expect(verdicts[i]?.reason).toContain('PLAN DECLINED');
        expect(verdicts[i]?.reason).toContain('PLAN_JSON_PARSE');
        expect(verdicts[i]?.reason).not.toContain('DECLINED_PLAN_LIMIT');
      }
      // 第 6 次：同一熔断器收敛（措辞与计数逐字钉死，D-099：提交次数不是拒绝次数）
      expect(verdicts[5]?.block).toBe(true);
      expect(verdicts[5]?.reason).toBe(`PLAN STOP：${messageFor('DECLINED_PLAN_LIMIT', '连续 6 次提交方案均未激活')}`);
      // 形状失败在解析期就被拦下：evaluate 从未被调用，平台计划门全程未被咨询
      expect(counter.evaluates).toBe(0);
      expect(Object.keys(ledger().plans ?? {})).toEqual([]);
    } finally {
      worker.session.dispose();
    }
  });
});

// ── A6：plan --schema 元数据自救通道（C4）──────────────────────────────────

describe('[L4 集成] 离线全链 e2e：plan --schema 元数据自救通道（C4）', () => {
  it('A6 --schema 不被 driver 当计划提交拦下，门的元数据白名单放行，CLI 逐字打印计划 schema', async () => {
    const counter = { evaluates: 0 };
    const worker = await makeWorkerSession(counter, { sessionId: 'task_plan_schema' });
    try {
      // 2026-10-23 实证的死命令：driver 的计划解析曾把 `plan ` 之后任何东西当 JSON
      // 草案，--schema 吃 PLAN_JSON_PARSE——门里为元数据写的白名单因 driver 先行
      // 拦截而不可达。C4 起分发器认出旗标形态返回 null，这一跳落门的元数据分支。
      const verdict = await bashCall(worker, 'call_schema', `${GATEWAY} plan --schema`);
      // 放行 = 不拦（verdict 无 block）；若被拦 reason 会带 PLAN DECLINED 或教学话术
      expect(verdict?.block).toBeUndefined();
      // 不是提交：不计数、不碰平台计划门
      expect(counter.evaluates).toBe(0);

      // 平台 CLI 确实认这个出口（本地打印 plan-schema.json，不触平台会话）
      const printed = spawnSync(gatewayCliPath(), ['plan', '--schema'], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env, EXECUTION_EXECUTOR: 'mock' },
      });
      expect(printed.status).toBe(0);
      expect(printed.stdout).toContain('"calls"');
    } finally {
      worker.session.dispose();
    }
  });

  it('A6b schema 无横线写法同样放行（门白名单对两种写法归一同键）', async () => {
    const counter = { evaluates: 0 };
    const worker = await makeWorkerSession(counter, { sessionId: 'task_plan_schema_alias' });
    try {
      const verdict = await bashCall(worker, 'call_schema_alias', `${GATEWAY} plan schema`);
      expect(verdict?.block).toBeUndefined();
      expect(counter.evaluates).toBe(0);
    } finally {
      worker.session.dispose();
    }
  });

  it('A6c 未知旗标（--stdin）落门的计划教学分支：教两种提交形态，而不是坏 JSON 诊断', async () => {
    const counter = { evaluates: 0 };
    const worker = await makeWorkerSession(counter, { sessionId: 'task_plan_unknown_flag' });
    try {
      const verdict = await bashCall(worker, 'call_unknown_flag', `${GATEWAY} plan --stdin`);
      expect(verdict?.block).toBe(true);
      // 话术唯一来源 error-codes.ts（C2 起教两种形态：inline 裸 JSON + --file）
      expect(verdict?.reason).toBe(messageTextFor('PLAN_SHAPE_GATE_TEACHING', undefined, GATEWAY));
      expect(verdict?.reason).toContain('--file');
    } finally {
      worker.session.dispose();
    }
  });
});

describe('[L4 集成] 离线全链 e2e：写入口的新边界（宿主不判写权限）', () => {
  it('A5 闸① 含写类 operation 的计划不被前置拦：直达平台评估，平台门自己裁决', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '帮我录入一笔办公费凭证' }]),
      worker: gatedWorker([
        { text: '我先核实一下范围、日期与借贷平衡。' },
        { plan: [{ operation: 'voucher.commit', args: ['幻辰财税', '202609'] }] },
        { text: '已提交录入。' },
      ]),
    });
    await assembly.store.principalScopes.upsert({
      wecomUserId: 'e2e_user', accountSetIds: [], accountSetScope: 'all', enabled: true, capabilities: ['read'],
    });

    const reply = await send('帮我录入一笔办公费凭证');

    // 平台计划门被真实咨询（账本里出现计划条目 = evaluate 真发生过）——宿主不再在
    // evaluate 之前判"这个部署允不允许写"（原 D-075 前置扫描已删）。
    expect(Object.keys(ledger().plans ?? {}).length).toBeGreaterThan(0);
    // 终稿不出现宿主的权限归因（WRITE_NOT_ENABLED 码已随合成话术退役）
    expect(reply).not.toContain('当前未开放写入权限');
    expect(reply).not.toContain('请联系管理员开通');
    await assembly.close();
  });

  it('A5 闸② 提案路径没有办调前复核：提案照常登记并给出确认码', async () => {
    const before = totalActualCalls();
    // 网关提案路径（C 波后唯一的提案入口，开关已退役）：worker 的提案创建命令被驱动
    // 恒定拦下，交到宿主的 createProposalViaGateway 办调——2026-11-08 起那里不再有
    // "平台写开放声明复核"，办调照常发生，执行层的拒绝走 failed 分支上行。
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '帮我录入一笔办公费凭证' }]),
      worker: gatewayProposalWorker({
        type: 'change_proposal',
        domain: 'voucher',
        accountSet: '幻辰财税',
        period: '202609',
        contracts: [{ voucherDate: '2026-09-30', entries: [{ subject: '660203', debit: 100, credit: 0 }] }],
        summary: { count: 1, debit: 100, credit: 100 },
      }),
    });
    await assembly.store.principalScopes.upsert({
      wecomUserId: 'e2e_user', accountSetIds: [], accountSetScope: 'all', enabled: true, capabilities: ['read'],
    });

    const reply = await send('帮我录入一笔办公费凭证');

    // 提案真被登记：确认码出现在确定性回复里（mock 之下这是唯一可达形态；真平台的
    // 落账授权由执行层自己的门把守，宿主不代判）。
    const code = /确认\s*([A-Z0-9]{6})/.exec(reply)?.[1];
    expect(code, `提案登记后应给出确认码：${reply.slice(0, 120)}`).toBeTruthy();
    expect(reply).not.toContain('当前未开放写入权限');
    const events = await assembly.store.conversationLog.list({ principalId: 'wecom:e2e_user', limit: 10 });
    const sessionId = events[0]?.sessionId ?? '';
    expect(sessionId).not.toBe('');
    expect(await assembly.store.changeIntents.findPendingBySession('wecom:e2e_user', sessionId)).not.toBeNull();
    await assembly.close();
  });

  it('A5 闸③ 平台计划门兜底：写类被平台拒绝，宿主只点名该调用、不假称权限', async () => {
    const counter = { evaluates: 0 };
    // 2026-11-08 后这是唯一的分流点：宿主不再有前置扫描，含写类 operation 的计划照常
    // 提交平台评估；serve 法域的 plan 只接受 read operation，voucher.commit（write-flag）
    // 被平台 canonicalCall 确定性拒绝（CLI exit 3）。
    const worker = await makeWorkerSession(counter, {
      sessionId: 'task_platform_write_gate',
      capabilities: ['read', 'write'],
      // 平台语义表替身：voucher.commit 要用户确认（confirm=true）。为什么不经平台 CLI 派生：
      // 语义表是**判据**不是普通数据，平台侧顶层 accessSemantics 正在并行改造、尚未下发，
      // 此刻派生只会得到空表——宿主 fail-closed 到"不该进计划"（PLAN_NOT_PLANNABLE），
      // 这条"平台门兜底 → 点名该调用"的断言就静默失真。平台下发该表后可换回派生。
      operationSemantics: new Map([
        ['commit', { plan: true, confirm: true, mock: true }],
        ['voucher.commit', { plan: true, confirm: true, mock: true }],
      ]),
    });
    try {
      const command = `${GATEWAY} plan {"calls":[{"operation":"voucher.commit","args":["幻辰财税","202609"]}]}`;
      const verdict = await bashCall(worker, 'call_platform_gate', command);

      expect(verdict?.block).toBe(true);
      // 驱动的 evaluate 失败分支把平台拒绝码换成用户/worker 可行动的话术：点名
      // voucher.commit、让它移出计划改为直接调用。2026-10-14 起不再回 WRITE_NOT_ENABLED
      // （那是假归因：worker 原样转达给用户"请联系管理员开通写入权限"，而写明明是开的）；
      // 2026-11-08 起那一支整个删除，宿主不判这个部署允不允许写。
      expect(verdict?.reason).toBe(
        `PLAN STOP\n${messageTextFor('PLAN_NOT_PLANNABLE_OPERATIONS', { operations: 'voucher.commit' })}`,
      );
      // 平台内部错误码不得透传给 worker
      expect(verdict?.reason).not.toContain('PLAN_OPERATION_NOT_READ_ONLY');
      // 平台门确实被咨询了（evaluate 真发生过）
      expect(counter.evaluates).toBe(1);
      // 拒绝发生在账本写入之前：平台侧无计划残留
      expect(Object.keys(ledger().plans ?? {})).toEqual([]);
    } finally {
      worker.session.dispose();
    }
  });
});
