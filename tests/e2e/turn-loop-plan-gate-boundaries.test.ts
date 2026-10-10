/**
 * 离线全链 e2e：计划与预算门禁边界（A 组：A2 档位边界 / A3 累计账本 / A4 收敛保护 /
 * A5 写关闭三闸）。共享替身见 ./harness.ts。
 *
 * 覆盖与驱动方式：
 *   A2：AUTO=2 / NOTIFY=10 / CONFIRM=20 钉死档位边界——1、2 次直执行（execute），
 *       3 次（>AUTO）notify 且通知送达后才执行，10 次（=NOTIFY 上界，开区间）仍 notify，
 *       21 次（>CONFIRM）停在确认门、确认前零执行。
 *       （平台 decision 语义：calls > 档位才算越档，见 17dz src/execution/plan.js
 *       decision()——"达到"档位不升档。）
 *   A3：同一任务连提两个计划（1 调 → 2 调），ledger() 钉累计 actual 与 evaluate 看到的
 *       累计值（第二个计划若按新任务算落在 AUTO 档，实际触发 notify = evaluate 看见了
 *       1+2=3），delta 只计净新增。
 *   A4：收敛保护计数器在真实驱动 pi-coding-driver 的 beforeToolCall 里（harness 的
 *       gatedWorker 替身不复刻它），这里用真 createPiCodingWorkerSession + 真 CLI 驱动：
 *       实体越权计划连提 6 次，前 5 次 PLAN DECLINED，第 6 次 PLAN STOP：
 *       DECLINED_PLAN_LIMIT，且 evaluate 从未被调用（第 6 次不再产生新计划）。
 *   A5：写关闭三个入口各一条——
 *       ① 计划扫描（gatedWorker enforceWriteClosure 复刻宿主 beforeToolCall 拦截）；
 *       ② 提案路径 capability 拒（worker 直出 change_proposal 文本，走 context.ts
 *          finalizeProposal；终稿是"已收到录入提案，但" + 唯一话术——finalizeProposal
 *          在 WRITE_NOT_ENABLED 前有一句收件确认，故对"内嵌话术一字不差"断言，而不是
 *          对整句相等断言）；
 *       ③ 平台计划门兜底（真 createPiCodingWorkerSession + 真 CLI：capabilities 声明
 *          含 write 使宿主前置扫描不触发，voucher.commit 被平台 canonicalCall 以
 *          PLAN_OPERATION_NOT_READ_ONLY exit 3 拒绝，驱动 catch 分支按平台语义表的
 *          confirm 列分流——要用户确认 → 写关闭话术）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai/compat';
import { createPiCodingWorkerSession, type PiCodingWorkerSession } from '../../packages/agent/src/pi-coding-driver';
import { messageFor, messageTextFor } from '../../packages/agent/src/error-codes';
import type { PlanCliRunner } from '../../packages/agent/src/plan-runtime';
import type { PlanEntitySources } from '../../packages/agent/src/turn-contract';
import {
  LAST_TASK_ID_TOKEN,
  boot,
  gatedWorker,
  growingPlan,
  heavyPlan,
  ledger,
  mainDriver,
  totalActualCalls,
} from './harness';

const PLATFORM_ROOT = process.env['DZ_PLATFORM_ROOT'] ?? path.resolve(__dirname, '..', '..', '..', '17dz-platform');
const CLI = path.join(PLATFORM_ROOT, 'bin', '17dz');

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
    const child = spawnSync(CLI, args, {
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

describe('离线全链 e2e：计划门档位边界（AUTO=2 / NOTIFY=10 / CONFIRM=20）', () => {
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

describe('离线全链 e2e：计划累计账本', () => {
  it('A3 同一任务第二个计划看到累计 actual：2 调计划触发 notify，delta 只计净新增', async () => {
    const { send, sdk, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '先查幻辰财税 1 月应收，再扩到 1 至 2 月' }]),
      worker: gatedWorker([{ plan: growingPlan(1) }, { plan: growingPlan(2) }]),
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

describe('离线全链 e2e：被拒计划收敛保护（DECLINED_PLAN_LIMIT）', () => {
  it('A4 同一任务连续 6 次提交越权计划：前 5 次 PLAN DECLINED，第 6 次收敛且不再产生新计划', async () => {
    const counter = { evaluates: 0 };
    const worker = await makeWorkerSession(counter, {
      sessionId: 'task_declined_limit',
      // 当前消息里没有任何账套名：计划里的账套参数必然越权（实体来源校验拒绝）
      entitySources: { currentMessage: '只查当前期间的应收账款' },
    });
    try {
      const command = 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","幽灵账套有限公司","--period","202609"]}]}';
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
      // 话术与计数逐字钉死（码表唯一来源 messageFor）
      expect(verdicts[5]?.block).toBe(true);
      expect(verdicts[5]?.reason).toBe(`PLAN STOP：${messageFor('DECLINED_PLAN_LIMIT', '已被连续拒绝 6 次')}`);
      // 第 6 次不再产生新计划：实体校验在 evaluate 之前，平台计划门全程未被咨询
      expect(counter.evaluates).toBe(0);
      expect(Object.keys(ledger().plans ?? {})).toEqual([]);
    } finally {
      worker.session.dispose();
    }
  });
});

// ── A5：写关闭三闸 ────────────────────────────────────────────────────────

describe('离线全链 e2e：写关闭三闸（WRITE_NOT_ENABLED 唯一话术）', () => {
  it('A5 闸① 计划扫描拒：含 voucher.commit 的计划在 evaluate 前被拦，终稿一字不差', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '帮我录入一笔办公费凭证' }]),
      worker: gatedWorker([
        { text: '我先核实一下范围、日期与借贷平衡。' },
        { plan: [{ operation: 'voucher.commit', args: ['幻辰财税', '202609'] }] },
        { text: '已提交录入。' },
      ], { enforceWriteClosure: true }),
    });
    // 生产保真：principal 的能力声明显示为只读（与 config/agent.yaml 的 capabilities: ["read"] 同形态）
    await assembly.store.principalScopes.upsert({
      wecomUserId: 'e2e_user', accountSetIds: [], accountSetScope: 'all', enabled: true, capabilities: ['read'],
    });

    const reply = await send('帮我录入一笔办公费凭证');

    // 终稿 = error-codes.ts 的 WRITE_NOT_ENABLED 唯一来源，一字不差；
    // worker 的准备/承诺文本没有成为终稿
    expect(reply).toBe(messageTextFor('WRITE_NOT_ENABLED'));
    expect(reply).not.toContain('已提交录入');
    // 零平台调用：evaluate 从未发生（账本里没有任何计划条目）
    expect(Object.keys(ledger().plans ?? {})).toEqual([]);
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });

  it('A5 闸② 提案路径 capability 拒：无 write 能力的 principal 走到提案步也被确定性拒绝', async () => {
    const proposal = {
      type: 'change_proposal',
      domain: 'voucher',
      accountSet: '幻辰财税',
      period: '202609',
      contracts: [{ voucherDate: '2026-09-30', entries: [{ subject: '660203', debit: 100, credit: 0 }] }],
      summary: { count: 1, debit: 100, credit: 100 },
    };
    const proposalText = `已洗好契约。\n\`\`\`json\n${JSON.stringify(proposal, null, 2)}\n\`\`\`\n请确认。`;
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '帮我录入一笔办公费凭证' }]),
      // worker 不停在计划步，直接产出提案文本——只有走到 finalizeProposal 的
      // capability 检查才能拦住它（T7 事故形态里模型永不抵达的那条路径）
      worker: gatedWorker([{ text: proposalText }]),
    });
    await assembly.store.principalScopes.upsert({
      wecomUserId: 'e2e_user', accountSetIds: [], accountSetScope: 'all', enabled: true, capabilities: ['read'],
    });

    const reply = await send('帮我录入一笔办公费凭证');

    // finalizeProposal（context.ts）在唯一话术前加了一句收件确认——内嵌话术一字不差，
    // 整句不是裸话术（这是该入口的生产契约，不是泄漏）；该入口不带 writeClosed 标记，
    // 出口校验按零执行回合追加其标准标注（runtime.ts finishDirectReply）
    expect(reply).toBe(
      `已收到录入提案，但${messageTextFor('WRITE_NOT_ENABLED')}\n\n（以上是子 Agent 的说明；本轮没有真正查到平台数据。）`,
    );
    // 提案载荷与预检都不发生：提案 JSON 不上屏、零平台调用
    expect(reply).not.toContain('change_proposal');
    expect(Object.keys(ledger().plans ?? {})).toEqual([]);
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });

  it('A5 闸③ 平台计划门兜底：宿主前置扫描放行后，平台以 PLAN_OPERATION_NOT_READ_ONLY 拒绝', async () => {
    const counter = { evaluates: 0 };
    // capabilities 声明含 write：闸①的 planWriteClosed 前置扫描不触发（D-075 判据），
    // 裁决完全落到平台计划门——serve 法域的 plan 只接受 read operation，
    // voucher.commit（write-flag）被平台 canonicalCall 确定性拒绝（CLI exit 3）。
    const worker = await makeWorkerSession(counter, {
      sessionId: 'task_platform_write_gate',
      capabilities: ['read', 'write'],
      // 平台语义表替身：voucher.commit 要用户确认（confirm=true）。为什么不经平台 CLI 派生：
      // 语义表是**判据**不是普通数据，平台侧顶层 accessSemantics 正在并行改造、尚未下发，
      // 此刻派生只会得到空表——宿主 fail-closed 到"不该进计划"（PLAN_NOT_PLANNABLE），
      // 这条"平台门兜底 → 写关闭话术"的断言就静默失真。平台下发该表后可换回派生。
      operationSemantics: new Map([
        ['commit', { plan: true, confirm: true, mock: true }],
        ['voucher.commit', { plan: true, confirm: true, mock: true }],
      ]),
    });
    try {
      const command = 'bin/17dz plan {"calls":[{"operation":"voucher.commit","args":["幻辰财税","202609"]}]}';
      const verdict = await bashCall(worker, 'call_platform_gate', command);

      expect(verdict?.block).toBe(true);
      // 驱动的 evaluate 失败分支把平台拒绝码换成用户可行动的写关闭话术（与闸①②同一句）
      expect(verdict?.reason).toBe(`PLAN STOP\n${messageTextFor('WRITE_NOT_ENABLED')}`);
      // 平台内部错误码与 operation 名不得透传给 worker
      expect(verdict?.reason).not.toContain('PLAN_OPERATION_NOT_READ_ONLY');
      expect(verdict?.reason).not.toContain('voucher.commit');
      // 平台门确实被咨询了（与闸①的差别：这是最后一道闸，发生在 evaluate 时）
      expect(counter.evaluates).toBe(1);
      // 拒绝发生在账本写入之前：平台侧无计划残留
      expect(Object.keys(ledger().plans ?? {})).toEqual([]);
    } finally {
      worker.session.dispose();
    }
  });
});
