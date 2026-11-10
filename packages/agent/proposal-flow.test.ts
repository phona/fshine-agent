/**
 * 网关提案路径（方案 1 · B 波 B3）：拦截点 + 宿主办调 + 三态分流 + 确认落账四态。
 *
 * 分两半，都不起 driver harness：
 *   · **宿主半**（context.ts 的 onCreateProposal / confirmProposalViaGateway）：用一个
 *     "捕获回调"的替身 worker 驱动直接调到那个回调——平台信封三态、意图条目形状、用户可见
 *     文本拼法、env 纪律（剥 EXECUTION_REQUIRE_PLAN）、确认落账四态；
 *   · **驱动半**（pi-coding-driver 的 beforeToolCall 拦截点）：用真 createPiCodingWorkerSession
 *     + 直接调 beforeToolCall（与 plan-audit 同一手法）——认不认这条命令、payload 路径越界
 *     拦不拦、三态各交还什么。
 *
 * B 波那两个写流程开关（一个管提案创建走不走网关、一个管落账后端接不接）已退役：
 * 宿主恒定注入回调、驱动恒定拦截、落账后端恒接，本文件因此**不再设任何 env 开关**——
 * "不设开关也走网关路径"本身就是被钉住的行为（原先"开关关着"的两条用例已改为恒真断言）。
 *
 * 2026-11-08 架构裁定后进一步删掉两处宿主持有的写判断：提案创建前的"平台写开放声明复核"
 * 与确认时点的"落账放行复核"（原 writeEnabled / proposalCommitEnabled 两位，由部署 env 经
 * isCommitEnabled 派生）。写能不能真落地归执行层，宿主只如实描述"提交什么"，执行层的拒绝 /
 * warning / dryrun 提示由平台信封给出并走既有失败链路上行。
 *
 * 为什么值得单独立一个文件：这条路径是"平台有提案、宿主持确认码"的唯一接缝。任一半失效
 * （不拦 / 拦了不办调 / 办调了不落条目 / 落了条目不给用户码）用户侧的表现都是同一个——
 * 拿不到确认码——所以每一半都要有机械判据，不能只靠 e2e 端到端看着绿。
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai/compat';
import { createContextTaskRunner, type ConfirmationReply, type ProposalCommitRequest, type ProposalCommitResult } from './src/context';
import { createPiCodingWorkerSession, type PiCodingWorkerSession } from './src/pi-coding-driver';
import type { ProposalCreateCall } from './src/proposal-runtime';
import type { PlanCliRunner } from './src/plan-runtime';
import type { OperationProtocols } from './src/operation-labels';
import type { ChangeIntentRecord, ChangeIntentRepo, DiscoveredTool, PlatformTaskRecord, PlatformTaskRepo, TrustedContext } from '@fshine/contracts';
import { createPlatformExecutionGate } from './src/platform-execution-gate';
import type { DriverMessage, ProposalCreationOutcome, TurnDriver, TurnDriverInput, TurnDriverResult } from './src/driver';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 平台 protocol 列替身：创建提案 / 提交提案两个角色（A 波新增列的形状）。 */
const PROTOCOLS: OperationProtocols = new Map<string, string>([
  ['voucher.proposal', 'proposal.create'],
  ['proposal', 'proposal.create'],
  ['voucher.commit', 'proposal.commit'],
]);

/** 假模型运行时：只为让 worker 会话建得起来，本文件的用例不跑模型回合。 */
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

/** 平台 RESULT 信封（schema v1 末行）。 */
function envelope(op: string, status: string, data: Record<string, unknown> | null, error: { code: string; message: string } | null): string {
  return `RESULT ${JSON.stringify({ v: 1, op, status, data, error })}\n`;
}

const COMPLETED_ENVELOPE = envelope('voucher.proposal', 'completed', {
  proposalId: 'prop_abc123',
  summaryText: '待确认提案 prop_abc123：账套「幻辰财税」2026年9月，共 2 张凭证，借方合计 1,500.00，贷方合计 1,500.00。确认后由系统执行录入；有效期至 2026-10-12T02:30:00.000Z。',
  accountSet: '幻辰财税',
  period: '202609',
  count: 2,
  expiresAt: '2026-10-12T02:30:00.000Z',
  status: 'pending',
}, null);

// ── 宿主半：context.ts 的 onCreateProposal ──────────────────────────────────

const noopTool: DiscoveredTool = { name: 'x', description: '', inputSchema: {} };
const noopTasks: PlatformTaskRepo = { get: async () => null, upsert: async () => {}, listBySession: async () => [] };

/** 内存版 ChangeIntentRepo：语义镜像 SQLite 实现（过期就地置 expired）。 */
function fakeIntents() {
  const rows = new Map<string, ChangeIntentRecord>();
  const repo: ChangeIntentRepo = {
    async create(r) { rows.set(r.intentId, { ...r }); },
    async get(id) { return rows.get(id) ?? null; },
    async findPendingByConfirm(principalId, sessionId, codeHash, now) {
      for (const r of rows.values()) {
        if (r.principalId !== principalId || r.sessionId !== sessionId) continue;
        if (r.confirmCodeHash !== codeHash || r.status !== 'pending') continue;
        if (new Date(r.expiresAt).getTime() <= now.getTime()) { r.status = 'expired'; return null; }
        return r;
      }
      return null;
    },
    async findPendingBySession(principalId, sessionId, taskId) {
      for (const r of rows.values()) {
        if (r.principalId !== principalId || r.sessionId !== sessionId || r.status !== 'pending') continue;
        if (taskId !== undefined && r.taskId !== taskId) continue;
        return r;
      }
      return null;
    },
    async findByCodeHash(principalId, sessionId, codeHash) {
      let latest: ChangeIntentRecord | null = null;
      for (const r of rows.values()) {
        if (r.principalId === principalId && r.sessionId === sessionId && r.confirmCodeHash === codeHash) {
          if (!latest || r.createdAt > latest.createdAt) latest = r;
        }
      }
      return latest;
    },
    async updateStatus(id, status, result) {
      const r = rows.get(id);
      if (r) { r.status = status; r.decidedAt = new Date().toISOString(); if (result !== undefined) r.result = result; }
    },
  };
  return { repo, rows };
}

interface HostSetup {
  /** 直接调到宿主注入的 onCreateProposal（未配 changeIntents 时为 undefined）。 */
  invoke: (call?: ProposalCreateCall) => Promise<ProposalCreationOutcome | null>;
  /** 同任务续跑（continueTaskId）后再回调 onCreateProposal：D-117 同任务二次提案用。 */
  invokeSameTask: (taskId: string, call?: ProposalCreateCall) => Promise<ProposalCreationOutcome | null>;
  /** 往任务仓库替身里放一条本会话任务：continueTaskId 续跑前置。 */
  seedTask: (taskId: string) => void;
  rows: Map<string, ChangeIntentRecord>;
  /** 办调平台时替身收到的请求（含 env）。 */
  calls: Array<{ platformRoot: string; args: string[]; env: NodeJS.ProcessEnv }>;
}

/**
 * 装配一个"捕获回调"的替身 worker 驱动：它不跑模型，只把宿主经 run 输入注入的
 * onCreateProposal 交出来给用例直接调——于是宿主半的每条判定都能不起 harness 地钉住。
 */
function setupHost(options: {
  stdout?: string;
  gatewayRunner?: PlanCliRunner;
}): HostSetup {
  const intents = fakeIntents();
  const tasks = fakeTasks();
  const calls: HostSetup['calls'] = [];
  const runner = options.gatewayRunner ?? (async ({ platformRoot, args, env }) => {
    calls.push({ platformRoot, args, env: env ?? {} });
    return { code: 0, stdout: options.stdout ?? COMPLETED_ENVELOPE, stderr: '' };
  });
  let captured: TurnDriverInput['onCreateProposal'];
  const workerDriver: TurnDriver = {
    run: async (input: TurnDriverInput): Promise<TurnDriverResult> => {
      captured = input.onCreateProposal;
      return { text: 'worker 终稿', messages: [] };
    },
  };
  const taskRunner = createContextTaskRunner({
    profiles: { 'example-gateway': { root: '/tmp', skillRoots: [] } },
    tasks: tasks.repo,
    workerDriver,
    changeIntents: intents.repo,
    proposalGatewayRunner: runner,
    generateCode: () => 'D3F2K9',
    intentTtlMs: 10 * 60_000,
    // 第 2 包生产契约：提案创建必须经过隔离复核 + 真实下发的 schema，
    // 旧测试“无复核也完成”的前提已不存在，故宿主半默认注入一致复核与
    // dummy schema；fail-closed 的反向情形由 production-wiring.test.ts 钉住。
    proposalReviewTurn: async () => ({ verdict: 'consistent', fields: [] }),
    proposalSchemaLoader: async () => ({ $id: 'ChangeProposalPayload', type: 'object' }),
  });
  return {
    rows: intents.rows,
    calls,
    seedTask: (taskId: string) => {
      tasks.rows.set(taskId, {
        taskId, parentSessionId: 'wecom:u1:c1', principalId: 'wecom:u1', workerMessages: [],
        createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z', outcome: 'done',
      });
    },
    invoke: async (call = { operation: 'voucher.proposal', payloadPath: 'tmp/req_1/proposal.json' }) => {
      await taskRunner.run({ request: '录入两笔往来款' }, {
        trusted: {
          requestId: 'req_1',
          principalId: 'wecom:u1',
          sessionId: 'wecom:u1:c1',
        },
      });
      if (!captured) return null;
      return captured(call);
    },
    /** 同任务续跑（continueTaskId）：D-117 用例需要"同一 taskId 再出一张提案"。 */
    invokeSameTask: async (taskId: string, call = { operation: 'voucher.proposal', payloadPath: 'tmp/req_1/proposal3.json' }) => {
      await taskRunner.run({ request: '按补充信息再录', taskId }, {
        trusted: {
          requestId: 'req_1',
          principalId: 'wecom:u1',
          sessionId: 'wecom:u1:c1',
        },
      });
      if (!captured) return null;
      return captured(call);
    },
  };
}

describe('网关提案路径 · 宿主办调（context.ts 的 onCreateProposal）', () => {
  it('没有任何开关可设：宿主恒定注入回调（B 波开关已退役，拦截不再有条件）', async () => {
    const host = setupHost({});
    // 不设任何 env：回调照旧注入——"开关关着就不注入"的旧形态已随那个开关一起删除，
    // 进程 env 里既没有也不该有它的名字（leak-lint 的 FSHINE_* 登记表同理只减不增）。
    expect(await host.invoke()).not.toBeNull();
    expect(host.calls).toHaveLength(1);
    expect(host.rows.size).toBe(1);
  });

  it('没有办调前的写开放复核：平台拒绝由平台信封说，宿主如实转述', async () => {
    // 2026-11-08 裁定前这里还有一支"平台声明写未开放 ⇒ 当场合成写关闭话术、零平台调用"。
    // 裁定后宿主不再持那个布尔，办调照常发生；执行层自己的拒绝走 failed 分支的
    // errorCode/workerText 上交，终稿由用户看到的那句话来自平台而不是宿主代判。
    const host = setupHost({
      stdout: envelope('voucher.proposal', 'failed', null, { code: 'WRITE_NOT_OPEN', message: '当前 dryrun 模式，未落账' }),
    });

    const outcome = await host.invoke();

    expect(outcome?.status).toBe('failed');
    expect(outcome && 'errorCode' in outcome ? outcome.errorCode : '').toBe('WRITE_NOT_OPEN');
    // 办调真发生了（宿主不替执行层提前拒），平台的拒绝原样进入转述材料
    expect(host.calls).toHaveLength(1);
    expect(host.rows.size).toBe(0);
  });

  it('completed：办调平台 → 落零业务字段的意图条目 → 用户文本 = 平台 summaryText 原样 + 通用确认行', async () => {
    const host = setupHost({});

    const outcome = await host.invoke();

    expect(outcome?.status).toBe('completed');
    // 办调形态：prepare <operation> <payloadPath>，operation 名来自拦截到的目标 token
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0]?.args).toEqual(['prepare', 'voucher.proposal', 'tmp/req_1/proposal.json']);
    // env 纪律（修 D-081）：宿主直调显式剥 EXECUTION_REQUIRE_PLAN——那个 mandate 是 worker 子进程的
    process.env.EXECUTION_REQUIRE_PLAN = '1';
    const withMandate = setupHost({});
    await withMandate.invoke();
    expect(withMandate.calls[0]?.env.EXECUTION_REQUIRE_PLAN).toBeUndefined();
    delete process.env.EXECUTION_REQUIRE_PLAN;

    if (!outcome || outcome.status !== 'completed') throw new Error('expected completed');
    expect(outcome.proposalId).toBe('prop_abc123');
    // 给 worker 的消息不含确认码（码只出现在给用户的文本里）
    expect(outcome.workerText).not.toContain('D3F2K9');
    expect(outcome.workerText).toContain('已在平台登记');
    // 用户可见文本：平台 summaryText 原样 + 通用确认行，宿主不拼任何业务摘要
    expect(outcome.userText).toBe([
      '待确认提案 prop_abc123：账套「幻辰财税」2026年9月，共 2 张凭证，借方合计 1,500.00，贷方合计 1,500.00。确认后由系统执行录入；有效期至 2026-10-12T02:30:00.000Z。',
      // 确认行只描述"提交什么"（2026-11-08：删掉"当前落账执行未启用——确认不会写入任何数据"
      // 那一支，写能不能真落地归执行层，它的拒绝/warning 由平台信封给出并上行转述）
      '回复「确认 D3F2K9」执行录入；回复「取消 D3F2K9」作废。10 分钟内有效。',
    ].join('\n'));

    // 意图条目：proposalId（取物单）+ taskId + 通用确认字段，零业务字段、零 payload
    expect(host.rows.size).toBe(1);
    const record = [...host.rows.values()][0]!;
    expect(record.proposalId).toBe('prop_abc123');
    expect(record.taskId).toMatch(/^task_/);
    expect(record.status).toBe('pending');
    expect(record.confirmCodeHash).not.toContain('D3F2K9');
    for (const field of ['kind', 'accountSet', 'period', 'payload', 'summary']) {
      expect(field in record).toBe(false);
    }
  });

  it('completed 但平台不给 proposalId/summaryText：按失败处理，不建条目', async () => {
    const host = setupHost({ stdout: envelope('voucher.proposal', 'completed', { status: 'pending' }, null) });

    const outcome = await host.invoke();

    expect(outcome?.status).toBe('failed');
    expect(outcome && 'workerText' in outcome ? outcome.workerText : '').toContain('proposalId');
    expect(host.rows.size).toBe(0);
  });

  it('needs_input：按平台结构化线索交还，不建条目', async () => {
    const host = setupHost({
      stdout: envelope('voucher.proposal', 'needs_input', { needs: [{ type: 'assistant', name: '幻电设备有限公司' }] }, null),
    });

    const outcome = await host.invoke();

    expect(outcome?.status).toBe('needs_input');
    if (!outcome || outcome.status !== 'needs_input') throw new Error('expected needs_input');
    // missing 只取平台 data.needs[].name：确定性，零 worker 文本解析
    expect(outcome.needs.missing).toEqual(['幻电设备有限公司']);
    expect(host.rows.size).toBe(0);
  });

  it('failed：交还平台错误码，不建条目', async () => {
    const host = setupHost({
      stdout: envelope('voucher.proposal', 'failed', null, { code: 'RESOLVE_INVALID', message: '账套不存在: 某账套' }),
    });

    const outcome = await host.invoke();

    expect(outcome?.status).toBe('failed');
    if (!outcome || outcome.status !== 'failed') throw new Error('expected failed');
    expect(outcome.errorCode).toBe('RESOLVE_INVALID');
    expect(outcome.workerText).toContain('RESOLVE_INVALID');
    expect(host.rows.size).toBe(0);
  });

  // ── D-117（2026-10-26 拍板 I2：一任务一码）：同任务只留一个待确认提案，跨任务
  // 并存——后台长任务出提案不应作废用户前台正要确认的另一个任务（I1 的代价形态）。
  // 代价（已接受）：同一用户可同时持多个任务的有效确认码，回错码=确认错任务；
  // 由确认码三元绑定（principal/session/task）+ TTL 兜底。改前 inline 枝 supersede
  // 全会话 pending——该期望随政策决定翻转。
  it('同任务二次提案作废旧 pending；跨任务提案并存（D-117 I2：一任务一码）', async () => {
    const host = setupHost({});
    await host.invoke();
    const first = [...host.rows.values()][0]!;
    // 不同任务的新提案：first 存活（跨任务并存）。
    await host.invoke({ operation: 'voucher.proposal', payloadPath: 'tmp/req_1/proposal2.json' });
    expect(first.status).toBe('pending');
    const pendings = [...host.rows.values()].filter((row) => row.status === 'pending');
    expect(pendings).toHaveLength(2);
    expect(new Set(pendings.map((row) => row.taskId)).size).toBe(2);

    // 同任务再建提案：旧 pending 被作废（一任务一码）。
    const second = pendings[1]!;
    const secondTaskId = second.taskId!;
    host.seedTask(secondTaskId);
    const intents = host.rows;
    const before = new Set(intents.keys());
    await host.invokeSameTask(secondTaskId);
    expect(second.status).toBe('superseded');
    // I2 语义：first（其他任务）不受影响仍 pending；同任务的在窗提案恰一张（新那张）。
    expect(first.status).toBe('pending');
    expect([...intents.values()].filter((row) => row.status === 'pending' && row.taskId === secondTaskId)).toHaveLength(1);
    expect(intents.size).toBe(before.size + 1);
  });
});

// ── 驱动半：beforeToolCall 的拦截点 ─────────────────────────────────────────

/** 造一个挂了协议表/宿主出口替身的 worker 会话（与 plan-audit 同一手法）。 */
async function workerWith(options: {
  requestId: string;
  protocols?: OperationProtocols;
  onCreateProposal?: (call: ProposalCreateCall) => Promise<ProposalCreationOutcome>;
}): Promise<{ worker: PiCodingWorkerSession; cwd: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fshine-proposal-flow-'));
  roots.push(cwd);
  const modelConfig = await fakeModelRuntime();
  const worker = await createPiCodingWorkerSession({
    gateway: 'bin/example-gateway',
    cwd,
    skillRoots: [],
    systemPrompt: 'proposal flow test',
    sessionId: `task_${options.requestId}`,
    requestId: options.requestId,
    agentDir: path.join(cwd, '.fshine-agent'),
    modelConfig,
    // 平台清单派生表显式注入：单测里绝不 spawn 平台 CLI
    operationLabels: new Map(),
    operationArgStyles: new Map(),
    operationSemantics: new Map(),
    operationProtocols: options.protocols ?? PROTOCOLS,
    // 工作区按任务注入（⑨）：payload 边界检查的判据输入（与 write 门同一把尺）
    scratchDir: `tmp/${options.requestId}`,
    ...(options.onCreateProposal ? { onCreateProposal: options.onCreateProposal } : {}),
  });
  return { worker, cwd };
}

function submit(worker: PiCodingWorkerSession, command: string) {
  return worker.session.agent.beforeToolCall?.({
    assistantMessage: {} as never,
    toolCall: { id: 'call_proposal', type: 'toolCall', name: 'bash', arguments: { command } } as never,
    args: { command },
    context: {} as never,
  });
}

describe('网关提案路径 · 驱动拦截点（pi-coding-driver 的 beforeToolCall）', () => {
  const PAYLOAD = 'tmp/req_gate/proposal.json';

  it('命中 proposal.create：拦下并办调，交还确定性消息（不含确认码）', async () => {
    const calls: ProposalCreateCall[] = [];
    const { worker, cwd } = await workerWith({
      requestId: 'req_gate',
      onCreateProposal: async (call) => {
        calls.push(call);
        return { status: 'completed', proposalId: 'prop_x', userText: '用户文本', workerText: '提案已登记，等待用户确认。' };
      },
    });
    // payload 落在本轮 scratchDir 内（门的写边界同一把尺）
    await mkdir(path.join(cwd, 'tmp', 'req_gate'), { recursive: true });

    const verdict = await submit(worker, `bin/example-gateway prepare voucher.proposal ${PAYLOAD}`);

    expect(calls).toEqual([{ operation: 'voucher.proposal', payloadPath: PAYLOAD }]);
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('PROPOSAL CREATED');
    expect(verdict?.reason).not.toContain('用户文本');
    worker.session.dispose();
  });

  it('payload 路径越界（scratchDir 外 / 绝对路径 / ../）：拒绝且不办调', async () => {
    const calls: ProposalCreateCall[] = [];
    const { worker } = await workerWith({
      requestId: 'req_gate',
      onCreateProposal: async (call) => { calls.push(call); return { status: 'completed', proposalId: 'p', userText: 'u', workerText: 'w' }; },
    });

    for (const payloadPath of ['tmp/other/proposal.json', '/etc/passwd', 'tmp/req_gate/../../secrets.json']) {
      const verdict = await submit(worker, `bin/example-gateway prepare voucher.proposal ${payloadPath}`);
      expect(verdict?.block, payloadPath).toBe(true);
      expect(verdict?.reason, payloadPath).toContain('PROPOSAL REFUSED');
    }
    // 越界 = 一次平台调用都不发生（否则等于让 worker 指使平台读工作区任意文件）
    expect(calls).toHaveLength(0);
    worker.session.dispose();
  });

  it('不设任何 env 也拦截：提案命令落不到 serve 门（B 波开关退役后没有"不拦"这一态）', async () => {
    const calls: ProposalCreateCall[] = [];
    const { worker } = await workerWith({
      requestId: 'req_gate',
      onCreateProposal: async (call) => { calls.push(call); return { status: 'completed', proposalId: 'p', userText: 'u', workerText: 'w' }; },
    });

    const verdict = await submit(worker, `bin/example-gateway prepare voucher.proposal ${PAYLOAD}`);

    expect(calls).toHaveLength(1);
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('PROPOSAL CREATED');
    worker.session.dispose();
  });

  it('protocol 表为空（平台还没下发这一列）：不拦截，落回 serve 门', async () => {
    const calls: ProposalCreateCall[] = [];
    const { worker } = await workerWith({
      requestId: 'req_gate',
      protocols: new Map(),
      onCreateProposal: async (call) => { calls.push(call); return { status: 'completed', proposalId: 'p', userText: 'u', workerText: 'w' }; },
    });

    const verdict = await submit(worker, `bin/example-gateway prepare voucher.proposal ${PAYLOAD}`);

    expect(calls).toHaveLength(0);
    expect(verdict?.reason).not.toContain('PROPOSAL');
    worker.session.dispose();
  });

  it('没配宿主出口：fail-closed 拦下（不放到平台去建一个宿主没有条目的提案）', async () => {
    const { worker } = await workerWith({ requestId: 'req_gate' });

    const verdict = await submit(worker, `bin/example-gateway prepare voucher.proposal ${PAYLOAD}`);

    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('PROPOSAL REFUSED');
    expect(verdict?.reason).toContain('未配置');
    worker.session.dispose();
  });

  it('needs_input：按确定性线索交还 worker（不匹配 worker 自由文本）', async () => {
    const { worker } = await workerWith({
      requestId: 'req_gate',
      onCreateProposal: async () => ({
        status: 'needs_input',
        needs: { missing: ['幻电设备有限公司'], reason: '平台返回 needs_input' },
        workerText: '平台返回 needs_input',
      }),
    });

    const verdict = await submit(worker, `bin/example-gateway prepare voucher.proposal ${PAYLOAD}`);

    expect(verdict?.reason).toContain('PROPOSAL NEEDS_INPUT');
    // 纠错环线索随会话留痕（宿主计划拦截同一机制）
    expect(worker.needsClue()).toEqual({ missing: ['幻电设备有限公司'], reason: '平台返回 needs_input' });
    worker.session.dispose();
  });

  it('failed：平台拒绝创建提案，交还平台错误码（宿主不代判写权限）', async () => {
    const { worker } = await workerWith({
      requestId: 'req_gate',
      onCreateProposal: async () => ({ status: 'failed', workerText: '平台拒绝创建提案：WRITE_NOT_OPEN：当前 dryrun 模式，未落账（exit 3）', errorCode: 'WRITE_NOT_OPEN' }),
    });

    const verdict = await submit(worker, `bin/example-gateway prepare voucher.proposal ${PAYLOAD}`);

    expect(verdict?.reason).toContain('PROPOSAL FAILED');
    expect(verdict?.reason).toContain('WRITE_NOT_OPEN');
    worker.session.dispose();
  });

  it('审计：拦截与结果都落一行（serve-gate 审计形状）', async () => {
    const events: Array<{ tool: string; allowed: boolean; reason: string }> = [];
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'fshine-proposal-flow-'));
    roots.push(cwd);
    const modelConfig = await fakeModelRuntime();
    const worker = await createPiCodingWorkerSession({
      gateway: 'bin/example-gateway',
      cwd,
      skillRoots: [],
      systemPrompt: 'proposal flow test',
      sessionId: 'task_audit',
      requestId: 'req_gate',
      agentDir: path.join(cwd, '.fshine-agent'),
      modelConfig,
      operationLabels: new Map(),
      operationArgStyles: new Map(),
      operationSemantics: new Map(),
      operationProtocols: PROTOCOLS,
      scratchDir: 'tmp/req_gate',
      onCreateProposal: async () => ({ status: 'completed', proposalId: 'p', userText: 'u', workerText: 'w' }),
      serveGateAudit: (event) => { events.push({ tool: event.tool, allowed: event.allowed, reason: event.reason ?? '' }); },
    });

    await submit(worker, `bin/example-gateway prepare voucher.proposal ${PAYLOAD}`);

    // 一次拦截一行，tool 名独立（与 plan_submit 同族：这一跳提前 return，不经 gate()）
    expect(events).toHaveLength(1);
    expect(events[0]?.tool).toBe('proposal_create');
    expect(events[0]?.allowed).toBe(false);
    worker.session.dispose();
  });
});

// ── 宿主半：matchConfirmation 的新路径落账（B 波 B4）─────────────────────────

/**
 * 确认步的宿主任意半边替身：种子条目直接塞进 fake 意图库（不走创建路径），于是每条判定
 * （后端缺失 / 成败 / 不可用三态）都能不起平台地钉住。2026-11-08 裁定后没有"落账放行复核"
 * 一支（原 proposalCommitEnabled 由部署 env 派生）——执行层自己的拒绝走 commit 信封的
 * `unavailable` / `!ok` 分支上行。
 * 任务仓库也是假的，用来断言 D-082 的终态回写。
 */
const CONFIRM_CODE = 'D3F2K9';
const CONFIRM_CODE_HASH = createHash('sha256').update(CONFIRM_CODE, 'utf8').digest('hex');
const INTENT_ID = 'intent_confirm_b4';
const TASK_ID = 'task_confirm_b4';

/** 假任务仓库：get/upsert 落内存，upserts 留下每次回写的终态（D-082 的断言面）。 */
function fakeTasks() {
  const rows = new Map<string, PlatformTaskRecord>();
  const upserts: Array<{ taskId: string; outcome: PlatformTaskRecord['outcome'] }> = [];
  const repo: PlatformTaskRepo = {
    async get(taskId) { return rows.get(taskId) ?? null; },
    async upsert(record) { rows.set(record.taskId, record); upserts.push({ taskId: record.taskId, outcome: record.outcome }); },
    async listBySession() { return [...rows.values()]; },
  };
  rows.set(TASK_ID, {
    taskId: TASK_ID,
    parentSessionId: 'wecom:u1:c1',
    principalId: 'wecom:u1',
    workerMessages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // 网关路径创建提案时任务已是 done（见 context.ts 的 proposalCreated 分支）；
    // 落账失败要把它翻成 failed——这正是 D-082 要回写的原因。
    outcome: 'done',
  });
  return { repo, rows, upserts };
}

interface ConfirmSetup {
  reply: () => Promise<ConfirmationReply | null>;
  rows: Map<string, ChangeIntentRecord>;
  taskUpserts: Array<{ taskId: string; outcome: PlatformTaskRecord['outcome'] }>;
  commitCalls: ProposalCommitRequest[];
}

function setupConfirm(options: {
  commitRunner?: (req: ProposalCommitRequest) => Promise<ProposalCommitResult>;
  result?: Partial<ProposalCommitResult>;
  /** 不注入落账后端（"放行说接了但执行器没配"的配置故障形态）。 */
  withoutRunner?: boolean;
  /** 建一条**不带 proposalId** 的条目 = 迁移前的旧行业（W5 fail-closed 的判据来源）。 */
  legacyRow?: boolean;
} = {}): ConfirmSetup {
  const intents = fakeIntents();
  const tasks = fakeTasks();
  const commitCalls: ProposalCommitRequest[] = [];
  const runner = options.commitRunner ?? (async (req: ProposalCommitRequest) => {
    commitCalls.push(req);
    return {
      ok: true,
      verified: true,
      summaryText: '平台渲染的落账摘要（原样转述）',
      output: 'VERIFY before=1 after=2 delta=1 required=1',
      ...options.result,
    };
  });
  const taskRunner = createContextTaskRunner({
    profiles: { 'example-gateway': { root: '/tmp', skillRoots: [] } },
    tasks: tasks.repo,
    workerDriver: { run: async (): Promise<TurnDriverResult> => ({ text: '（本组不委派 worker）', messages: [] }) },
    changeIntents: intents.repo,
    ...(options.withoutRunner ? {} : { proposalCommitRunner: runner }),
    generateCode: () => CONFIRM_CODE,
    intentTtlMs: 10 * 60_000,
  });
  void intents.repo.create({
    intentId: INTENT_ID,
    principalId: 'wecom:u1',
    sessionId: 'wecom:u1:c1',
    taskId: TASK_ID,
    ...(options.legacyRow ? {} : { proposalId: 'prop_abc123' }),
    confirmCodeHash: CONFIRM_CODE_HASH,
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  const ctx: TrustedContext = {
    requestId: 'req_confirm',
    principalId: 'wecom:u1',
    sessionId: 'wecom:u1:c1',
  };
  return {
    reply: () => taskRunner.matchConfirmation!(ctx, `确认 ${CONFIRM_CODE}`),
    rows: intents.rows,
    taskUpserts: tasks.upserts,
    commitCalls,
  };
}

describe('网关提案路径 · 确认落账（matchConfirmation 的 proposalId 分流）', () => {
  it('平台说提案已过期（执行层自己的拒绝）：confirm_stale + 意图 expired、零谎称', async () => {
    // 2026-11-08 裁定后确认时点没有宿主侧的"落账放行复核"。执行层自己的拒绝/warning 走
    // commit 信封的 unavailable / !ok 分支上行：这一支钉"平台说过期"——提案在平台侧不可用，
    // 宿主如实转述，不借"过期"说谎也不谎称执行失败。
    const setup = setupConfirm({
      result: { ok: false, verified: false, summaryText: '', output: '', error: '平台侧有效期已过', unavailable: 'expired' },
    });

    const reply = await setup.reply();

    expect(reply?.outcome).toBe('confirm_stale');
    expect(reply?.text).toContain('已过期（超过有效期）');
    expect(setup.rows.get(INTENT_ID)?.status).toBe('expired');
    expect(setup.commitCalls).toHaveLength(1);
    expect(setup.taskUpserts).toHaveLength(0);
  });

  it('后端没注入（宿主自己的配置故障）：fail-closed → confirm_failed + 意图 failed + 任务终态 failed', async () => {
    const setup = setupConfirm({ withoutRunner: true });

    const reply = await setup.reply();

    expect(reply?.outcome).toBe('confirm_failed');
    expect(reply?.text).toContain('落账执行器未配置');
    expect(setup.rows.get(INTENT_ID)?.status).toBe('failed');
    expect(setup.taskUpserts.map((u) => u.outcome)).toEqual(['failed']);
  });

  it('落账成功：用户文本 = 平台 summaryText 原样 + 通用状态行；意图 committed + 任务终态 done', async () => {
    const setup = setupConfirm({});

    const reply = await setup.reply();

    expect(reply?.text).toBe('平台渲染的落账摘要（原样转述）\n确认码已核销，落账已完成。');
    expect(reply?.outcome).toBe('confirm_executed');
    expect(setup.commitCalls).toEqual([{ proposalId: 'prop_abc123' }]);
    expect(setup.rows.get(INTENT_ID)?.status).toBe('committed');
    expect(setup.taskUpserts.map((u) => u.outcome)).toEqual(['done']);
  });

  it('落账失败：通用失败话术（宿主不拼业务摘要）+ 意图 failed + 任务终态 failed', async () => {
    const setup = setupConfirm({
      result: { ok: false, verified: false, summaryText: '', output: 'SAVE_REJECTED', error: 'SAVE_REJECTED: 此会计期已结账' },
    });

    const reply = await setup.reply();

    expect(reply?.outcome).toBe('confirm_failed');
    expect(reply?.text).toBe('执行失败：落账未完成，系统已停止并留痕。请联系管理员核对平台实际状态后，再重新发起录入。');
    expect(setup.rows.get(INTENT_ID)?.status).toBe('failed');
    expect(setup.taskUpserts.map((u) => u.outcome)).toEqual(['failed']);
  });

  it('提案在平台侧已过期：confirm_stale + 意图 expired，不谎称执行失败', async () => {
    const setup = setupConfirm({
      result: { ok: false, verified: false, summaryText: '', output: '', error: '平台侧有效期已过', unavailable: 'expired' },
    });

    const reply = await setup.reply();

    expect(reply?.outcome).toBe('confirm_stale');
    expect(reply?.text).toContain('已过期（超过有效期）');
    expect(setup.rows.get(INTENT_ID)?.status).toBe('expired');
  });

  it('提案在平台侧已终结：confirm_stale + 意图 expired，明说无需重复确认', async () => {
    const setup = setupConfirm({
      result: { ok: false, verified: false, summaryText: '', output: '', error: '平台侧状态=committed', unavailable: 'not_pending' },
    });

    const reply = await setup.reply();

    expect(reply?.outcome).toBe('confirm_stale');
    expect(reply?.text).toContain('已终结');
    expect(setup.rows.get(INTENT_ID)?.status).toBe('expired');
  });

  it('W5：不带 proposalId 的旧行业 → 一律按过期处理，confirm_stale + 零办调', async () => {
    // 迁移前的旧 shape（宿主持有冻结载荷的时代）在库里仍有 pending 行。判别只有一个：
    // 有没有 proposalId。没有 → 拿不到取物单就无法定位平台提案，commit 等于盲写。
    const setup = setupConfirm({
      legacyRow: true,
      commitRunner: async () => { throw new Error('旧行业不该被办调'); },
    });

    const reply = await setup.reply();

    expect(reply?.outcome).toBe('confirm_stale');
    // 话术走 PROPOSAL_UNAVAILABLE_TEXT.expired（与新路径"平台说过期"同一句，不造第二份）
    expect(reply?.text).toContain('该确认码对应的提案已过期（超过有效期），请重新发起录入。');
    expect(setup.rows.get(INTENT_ID)?.status).toBe('expired');
    expect(setup.commitCalls).toHaveLength(0);
    // 意图归档不回写任务终态：一次写入都没发生，不是执行失败
    expect(setup.taskUpserts).toHaveLength(0);
  });

  it('宿主待办已满：确认按 confirm_held 返回且提案保持 pending；槽释放后重发确认成功', async () => {
    // 2026-11-10 仲裁后闸不再限制平台并发，也不再排队等待：别会话的长 worker 不会把确认
    // 回执堵在闸外。唯一还能拦下确认的是宿主待办深度已满（maxQueue）——那是宿主自己的
    // 背压阈值，不是平台并发策略。被拒时走 confirm_held（提案不被作废），可重试。
    const intents = fakeIntents();
    const tasks = fakeTasks();
    const gate = createPlatformExecutionGate({ maxQueue: 1 });
    const commitCalls: ProposalCommitRequest[] = [];
    const taskRunner = createContextTaskRunner({
      profiles: { 'example-gateway': { root: '/tmp', skillRoots: [] } },
      tasks: tasks.repo,
      workerDriver: { run: async (): Promise<TurnDriverResult> => ({ text: '（本组不委派 worker）', messages: [] }) },
      changeIntents: intents.repo,
      proposalCommitRunner: async (req) => {
        commitCalls.push(req);
        return { ok: true, verified: true, summaryText: '平台渲染的落账摘要（原样转述）', output: 'VERIFY delta=1' };
      },
      generateCode: () => CONFIRM_CODE,
      executionGate: gate,
    });
    await intents.repo.create({
      intentId: INTENT_ID,
      principalId: 'wecom:u1',
      sessionId: 'wecom:u1:c1',
      taskId: TASK_ID,
      proposalId: 'prop_abc123',
      confirmCodeHash: CONFIRM_CODE_HASH,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    const ctx: TrustedContext = { requestId: 'req_confirm_gate', principalId: 'wecom:u1', sessionId: 'wecom:u1:c1' };

    // 占满宿主待办深度：另一件作业持有唯一槽位
    const holder = gate.enqueue({ requestId: 'other-session-worker' });
    const holderLease = await holder.acquired;
    holderLease.start();

    const held = await taskRunner.matchConfirmation!(ctx, `确认 ${CONFIRM_CODE}`);

    expect(held?.outcome).toBe('confirm_held');
    expect(held?.text).toContain('仍待确认');
    // 提案保持 pending（confirm_held 语义：无状态变化），零办调、零任务终态回写
    expect(intents.rows.get(INTENT_ID)?.status).toBe('pending');
    expect(commitCalls).toHaveLength(0);
    expect(tasks.upserts).toHaveLength(0);

    // 槽释放后重发同一确认码：照常落账（队列已满只放弃"这一次"，不作废提案）
    holderLease.release();
    const executed = await taskRunner.matchConfirmation!(ctx, `确认 ${CONFIRM_CODE}`);

    expect(executed?.outcome).toBe('confirm_executed');
    expect(commitCalls).toEqual([{ proposalId: 'prop_abc123' }]);
    expect(intents.rows.get(INTENT_ID)?.status).toBe('committed');
  }, 3_000);
});
