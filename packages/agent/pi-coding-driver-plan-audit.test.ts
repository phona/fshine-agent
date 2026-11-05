/**
 * 计划提交的审计落账：worker 每提交一次方案，tool_calls 里就必须有一行。
 *
 * 为什么值得单独立一个文件（2026-10-10 实证的审计缺口）：整条计划分支在
 * beforeToolCall 里**提前 return**，不经 serve-gate 的 gate()，门的 onEvent 一次都不
 * 触发。于是"worker 提交了什么方案"在 tool_calls 里完全查不到——而同一轮里别的门拒绝
 * （形式错、无计划、越界路径）全有记录，排查时对不上：看得见门在工作，看不见门前面
 * 还发生过什么。真实运行里 worker 连提 6 次方案（`platform_tasks.calls` 记着最后一次
 * 的 calls），tool_calls 里 0 行。
 *
 * 这里守三件事：
 *   ① **每个出口都落账**：写关闭 / 拒次收敛 / 实体越权 / 激活 / 待确认 / STOP /
 *      平台拒绝 / 评估失败 / 形状不合法——裁决出口新增一条，这里就多一行参数；
 *      漏挂任何一条都是静默不落账（无报错、无日志，只是查不到）；
 *   ② **一次提交一行**：同一个提交不许落两行（重复上报会把 tool_calls 撑成噪音）；
 *   ③ **detail 是摘要不是全文**：operation + args 摘要，按 describeKeyArgs 同一套截断
 *      预算——计划 JSON 可以很长，全文进审计会把重点埋掉。
 *
 * 前两组用生产接线（createServeGateAuditSink + assembly 同款落账替身）驱动真
 * createPiCodingWorkerSession；第三组走**真 SDK AgentSession**（假 LLM 端点回一个
 * bash 计划提交），因为缺口恰好出在"钩子在生产里到底跑不跑"这一层——只调
 * beforeToolCall 的替身测不出这一层，这正是上一轮漏掉它的原因。
 */
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai/compat';
import { createPiCodingTurnDriver, createPiCodingWorkerSession, type PiCodingWorkerSession } from './src/pi-coding-driver';
import type { DriverMessage, TurnDriver, TurnDriverInput } from './src/driver';
import { AUDIT_DETAIL_MAX_CHARS, type ServeGateEvent } from './src/serve-gate';
import { messageFor, messageTextFor } from './src/error-codes';
import type { PlanCliRunner } from './src/plan-runtime';
import type { AccessSemantics, OperationSemantics } from './src/operation-labels';
import type { PlanEntitySources } from './src/turn-contract';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

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

/** 平台 access 语义表（`operation list --json` 派生面的替身）：本地处理 + 要确认的写类。 */
const SEMANTICS: OperationSemantics = new Map<string, AccessSemantics>([
  ['payroll.transform', { plan: false, confirm: false, mock: false }],
  ['voucher.commit', { plan: true, confirm: true, mock: true }],
]);

/** 审计事件收集器 + 落账替身（与 assembly 的 serveGateAudit 同形状：event → 一行）。 */
function auditSink(): { events: ServeGateEvent[]; sink: (event: ServeGateEvent) => void } {
  const events: ServeGateEvent[] = [];
  return { events, sink: (event) => { events.push(event); } };
}

const PLAN_COMMAND = 'bin/17dz plan {"calls":[{"operation":"payroll.transform","args":["幻骥达","202608"]}]}';

/** 造一个挂了审计替身的 worker 会话（计划 CLI 与能力面由各用例注入）。 */
async function workerWith(options: {
  sessionId: string;
  events: ServeGateEvent[];
  planCliRunner?: PlanCliRunner;
  writeEnabled?: boolean;
  entitySources?: PlanEntitySources;
  semantics?: OperationSemantics;
  onNotice?: (text: string) => Promise<void>;
}): Promise<PiCodingWorkerSession> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-plan-audit-'));
  roots.push(root);
  const modelConfig = await fakeModelRuntime();
  return createPiCodingWorkerSession({
    cwd: root,
    skillRoots: [],
    systemPrompt: 'plan audit test',
    sessionId: options.sessionId,
    requestId: `req_${options.sessionId}`,
    agentDir: path.join(root, '.fshine-agent'),
    modelConfig,
    ...(options.planCliRunner ? { planCliRunner: options.planCliRunner } : {}),
    ...(options.writeEnabled !== undefined ? { writeEnabled: options.writeEnabled } : {}),
    ...(options.entitySources ? { entitySources: options.entitySources } : {}),
    ...(options.semantics ? { operationSemantics: options.semantics } : {}),
    ...(options.onNotice ? { onNotice: options.onNotice } : {}),
    // 与生产同一口径：worker 会话的 serveGateAudit 就是驱动侧 createServeGateAuditSink
    // 包出来的那个（assembly 的落账挂在最外层）。
    serveGateAudit: (event) => { options.events.push({ ...event, requestId: `req_${options.sessionId}` }); },
  });
}

function submit(worker: PiCodingWorkerSession, command: string) {
  return worker.session.agent.beforeToolCall?.({
    assistantMessage: {} as never,
    toolCall: { id: 'call_audit', type: 'toolCall', name: 'bash', arguments: { command } } as never,
    args: { command },
    context: {} as never,
  });
}

/**
 * 造一个带本轮工作区（tmp/task_file/）与计划文件的 worker 会话；返回 root 供用例在
 * 工作区里布设边界 fixture（穿越/符号链接靶子）。模块级：文件通道 describe 与收敛
 * 计数器 describe 共用（Round 1 补强的跨通道归零用例在后者）。
 */
async function fileWorkerWith(options: {
  sessionId: string;
  events: ServeGateEvent[];
  planCliRunner?: PlanCliRunner;
  /** 工作区内计划文件的内容；不给则不建文件（测"文件不存在"）。 */
  planContent?: string;
  /** 计划文件名（相对工作区，可带子目录）；缺省 plan.json。 */
  planName?: string;
  /** 实体来源（越权判定的输入）；不给 = 不启用实体校验。 */
  entitySources?: PlanEntitySources;
  /** 通知出口（确认门 fail-closed：没配就暂停执行）。 */
  onNotice?: (text: string) => Promise<void>;
  /** 不注入 scratchDir（测缺省拒）。 */
  noScratch?: boolean;
}): Promise<{ worker: PiCodingWorkerSession; root: string; scratch: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-plan-file-'));
  roots.push(root);
  const scratch = 'tmp/task_file';
  await mkdir(path.join(root, scratch), { recursive: true });
  if (options.planContent !== undefined) {
    const name = options.planName ?? 'plan.json';
    await mkdir(path.dirname(path.join(root, scratch, name)), { recursive: true });
    await writeFile(path.join(root, scratch, name), options.planContent, 'utf8');
  }
  const modelConfig = await fakeModelRuntime();
  const worker = await createPiCodingWorkerSession({
    cwd: root,
    skillRoots: [],
    systemPrompt: 'plan audit test',
    sessionId: options.sessionId,
    requestId: `req_${options.sessionId}`,
    agentDir: path.join(root, '.fshine-agent'),
    modelConfig,
    ...(options.planCliRunner ? { planCliRunner: options.planCliRunner } : {}),
    ...(options.entitySources ? { entitySources: options.entitySources } : {}),
    ...(options.onNotice ? { onNotice: options.onNotice } : {}),
    ...(options.noScratch ? {} : { scratchDir: scratch }),
    // 与生产同一口径：worker 会话的 serveGateAudit 就是驱动侧 createServeGateAuditSink
    // 包出来的那个（assembly 的落账挂在最外层）。
    serveGateAudit: (event) => { options.events.push({ ...event, requestId: `req_${options.sessionId}` }); },
  });
  return { worker, root, scratch };
}

/** 提交即激活（execute 档）：不等通知、不等确认。 */
const activatingRunner: PlanCliRunner = async ({ args }) => {
  if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 't', planId: null, version: null, status: 'none' }), stderr: '' };
  if (args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify({ planId: 'plan_audit', version: 1, decision: 'execute', estimate: { calls: 1, seconds: 1, weight: 2 }, delta: {}, cumulative: {}, status: 'active' }), stderr: '' };
  throw new Error(`unexpected CLI call: ${args.join(' ')}`);
};

describe('计划提交审计：每个裁决出口都落一行 tool_calls', () => {
  it('方案被平台激活（PLAN ACTIVE）→ 落一行，detail 是 operation + args 摘要', async () => {
    const { events } = auditSink();
    const worker = await workerWith({ sessionId: 'active', events, planCliRunner: activatingRunner });

    const verdict = await submit(worker, PLAN_COMMAND);

    expect(verdict?.reason).toContain('PLAN ACTIVE');
    // 一次提交一行：不多不少
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.tool).toBe('plan_submit');
    // 计划分支每个出口都是 block：记的是判定结果，不是放行
    expect(event?.allowed).toBe(false);
    expect(event?.reason).toBe(verdict?.reason);
    expect(event?.requestId).toBe('req_active');
    // 摘要口径：operation + args，单值按 describeKeyArgs 的预算截断，不是计划 JSON 全文
    expect(event?.detail).toBe('payroll.transform 幻骥达 202608');
    expect(event?.detail).not.toContain('{"calls"');
    worker.session.dispose();
  });

  it('方案停在用户确认门（PLAN NEEDS_USER_CONFIRM）→ 落一行', async () => {
    const { events } = auditSink();
    const confirmingRunner: PlanCliRunner = async ({ args }) => {
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 't', planId: null, version: null, status: 'none' }), stderr: '' };
      if (args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify({ planId: 'plan_confirm', version: 3, decision: 'confirm', estimate: { calls: 30, seconds: 600, weight: 2 }, delta: {}, cumulative: {}, reasonCode: 'CONFIRM_THRESHOLD', status: 'confirming', noticeText: '第 1 批查询' }), stderr: '' };
      throw new Error('unexpected CLI call');
    };
    // 确认门要求宿主持有通知出口（fail-closed：没配就暂停执行），否则 evaluate 直接抛
    const notices: string[] = [];
    const worker = await workerWith({
      sessionId: 'confirm',
      events,
      planCliRunner: confirmingRunner,
      onNotice: async (text) => { notices.push(text); },
    });

    const verdict = await submit(worker, PLAN_COMMAND);

    expect(verdict?.reason).toContain('PLAN NEEDS_USER_CONFIRM');
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toBe('payroll.transform 幻骥达 202608');
    worker.session.dispose();
  });

  it('平台结构化 stop 裁决（exit 3 + decision JSON）→ 落一行', async () => {
    const { events } = auditSink();
    const stopRunner: PlanCliRunner = async ({ args }) => {
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 't', planId: null, version: null, status: 'none' }), stderr: '' };
      if (args[1] === 'evaluate') return {
        code: 3,
        stdout: `${JSON.stringify({ planId: 'plan_stop', version: 2, decision: 'stop', estimate: { calls: 60, seconds: 3600, weight: 2 }, delta: { addedCalls: 60 }, cumulative: { calls: 120, seconds: 7200 }, reasonCode: 'HARD_LIMIT', status: 'stopped', noticeText: '累计查询已达本任务硬上限。' })}\n`,
        stderr: '',
      };
      throw new Error('unexpected CLI call');
    };
    const worker = await workerWith({ sessionId: 'stop', events, planCliRunner: stopRunner });

    const verdict = await submit(worker, PLAN_COMMAND);

    expect(verdict?.reason).toContain('PLAN STOP');
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe(verdict?.reason);
    worker.session.dispose();
  });

  it('平台按"只读"拒绝计划，语义表说该调用不需要计划 → PLAN_NOT_PLANNABLE，照旧落一行', async () => {
    const { events } = auditSink();
    const rejectingRunner: PlanCliRunner = async ({ args }) => {
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 't', planId: null, version: null, status: 'none' }), stderr: '' };
      if (args[1] === 'evaluate') return { code: 3, stdout: '', stderr: 'PLAN_REFUSE PLAN_OPERATION_NOT_READ_ONLY\n' };
      throw new Error('unexpected CLI call');
    };
    // 写开放（平台声明 writeEnabled）：不走前置扫描，这句话必须来自 evaluate 失败分支的分流
    const worker = await workerWith({ sessionId: 'notplannable', events, planCliRunner: rejectingRunner, semantics: SEMANTICS, writeEnabled: true });

    const verdict = await submit(worker, PLAN_COMMAND);

    expect(verdict?.reason).toContain(messageTextFor('PLAN_NOT_PLANNABLE'));
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe(verdict?.reason);
    worker.session.dispose();
  });

  it('平台按"只读"拒绝计划，语义表说要用户确认：写开放时点名该 operation，照旧落一行', async () => {
    const { events } = auditSink();
    const rejectingRunner: PlanCliRunner = async ({ args }) => {
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 't', planId: null, version: null, status: 'none' }), stderr: '' };
      if (args[1] === 'evaluate') return { code: 3, stdout: '', stderr: 'PLAN_REFUSE PLAN_OPERATION_NOT_READ_ONLY\n' };
      throw new Error('unexpected CLI call');
    };
    const worker = await workerWith({
      sessionId: 'writeclosed',
      events,
      planCliRunner: rejectingRunner,
      semantics: SEMANTICS,
      writeEnabled: true,
    });

    const verdict = await submit(worker, 'bin/17dz plan {"calls":[{"operation":"voucher.commit","args":["幻骥达","202608"]}]}');

    // 2026-10-14 修正：写已开放时这不是权限问题而是形状问题，点名它（假归因修复）。
    // 审计一侧的要求不变：每个裁决出口仍落一行，detail 照旧是 calls 摘要。
    expect(verdict?.reason).toContain(messageTextFor('PLAN_NOT_PLANNABLE_OPERATIONS', { operations: 'voucher.commit' }));
    expect(verdict?.reason).not.toContain('当前未开放写入权限');
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toBe('voucher.commit 幻骥达 202608');
    worker.session.dispose();
  });

  it('计划 CLI 直接失败（拿不出结构化裁决）→ PLAN PAUSED，照旧落一行', async () => {
    const { events } = auditSink();
    const failingRunner: PlanCliRunner = async ({ args }) => {
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 't', planId: null, version: null, status: 'none' }), stderr: '' };
      if (args[1] === 'evaluate') return { code: 1, stdout: '', stderr: 'spawn ENOENT' };
      throw new Error('unexpected CLI call');
    };
    const worker = await workerWith({ sessionId: 'paused', events, planCliRunner: failingRunner });

    const verdict = await submit(worker, PLAN_COMMAND);

    expect(verdict?.reason).toContain('PLAN PAUSED');
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe(verdict?.reason);
    worker.session.dispose();
  });

  it('计划参数不在任何实体来源里 → ENTITY_OUT_OF_SCOPE，落一行', async () => {
    const { events } = auditSink();
    const worker = await workerWith({
      sessionId: 'entity',
      events,
      planCliRunner: activatingRunner,
      entitySources: { currentMessage: '帮我做幻骥达 202608 的工资表' },
    });

    const verdict = await submit(worker, 'bin/17dz plan {"calls":[{"operation":"payroll.transform","args":["查无此实体","202608"]}]}');

    expect(verdict?.reason).toContain('ENTITY_OUT_OF_SCOPE');
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toBe('payroll.transform 查无此实体 202608');
    worker.session.dispose();
  });

  it('写关闭前置拦截（平台声明写未开放）→ WRITE_NOT_ENABLED，落一行', async () => {
    const { events } = auditSink();
    // 平台声明写未开放 + 语义表说 voucher.commit 要用户确认：宿主在 evaluate 之前就拦
    const worker = await workerWith({
      sessionId: 'prewrite',
      events,
      planCliRunner: activatingRunner,
      semantics: SEMANTICS,
    });

    const verdict = await submit(worker, 'bin/17dz plan {"calls":[{"operation":"voucher.commit","args":["幻骥达","202608"]}]}');

    expect(verdict?.reason).toContain(messageTextFor('WRITE_NOT_ENABLED'));
    expect(events).toHaveLength(1);
    worker.session.dispose();
  });

  it('方案形状不合法（JSON 解析不了）→ 也落一行（提交事实本身要可查），detail 为空', async () => {
    const { events } = auditSink();
    const worker = await workerWith({ sessionId: 'shape', events, planCliRunner: activatingRunner });

    // 真实运行里 worker 的第一种错法：把 JSON 用单引号包起来（2026-10-10 实证）
    const verdict = await submit(worker, `bin/17dz plan '{"calls":[{"operation":"payroll.transform","args":["A","202608"]}]}'`);

    expect(verdict?.reason).toContain('PLAN DECLINED');
    expect(verdict?.reason).toContain('PLAN_JSON_PARSE');
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe(verdict?.reason);
    // 解析不出 calls 就没有摘要可记：detail 为空，而不是把计划 JSON 倒进审计
    expect(events[0]?.detail).toBe('');
    worker.session.dispose();
  });

  it('连续被拒达到收敛上限 → 第 6 次落 DECLINED_PLAN_LIMIT，前 5 次各落一行', async () => {
    const { events } = auditSink();
    const worker = await workerWith({
      sessionId: 'limit',
      events,
      planCliRunner: activatingRunner,
      entitySources: { currentMessage: '帮我做幻骥达 202608 的工资表' },
    });
    const command = 'bin/17dz plan {"calls":[{"operation":"payroll.transform","args":["查无此实体","202608"]}]}';

    const reasons: (string | undefined)[] = [];
    for (let i = 0; i < 6; i += 1) {
      const verdict = await submit(worker, command);
      reasons.push(verdict?.reason);
    }

    // 前 5 次逐次暴露同一个越权参数，第 6 次收敛
    expect(reasons.slice(0, 5).every((reason) => reason?.includes('ENTITY_OUT_OF_SCOPE'))).toBe(true);
    // 措辞与数字逐字钉死（码表唯一来源 messageFor）。这一段历史里 6 次全是越权拒绝、
    // 零激活，所以"连续 6 次提交方案均未激活"里的 6 同时就是真实拒绝次数——数字与事实
    // 一致正是 D-099 要的诚实（混合历史下它是提交次数，见 pi-coding-driver.test.ts 那条）。
    expect(reasons[5]).toBe(`PLAN STOP：${messageFor('DECLINED_PLAN_LIMIT', '连续 6 次提交方案均未激活')}`);
    // 每次提交一行：6 次提交 6 行，一行不少
    expect(events).toHaveLength(6);
    expect(events[5]?.reason).toBe(reasons[5]);
    worker.session.dispose();
  });

  it('连续形状失败也收敛：第 6 次落 DECLINED_PLAN_LIMIT（C1 表征 golden 随 C3 翻转）', async () => {
    const { events } = auditSink();
    const worker = await workerWith({ sessionId: 'shape-loop', events, planCliRunner: activatingRunner });
    // 2026-10-23 实测形状（req_368b68b3）：worker 把计划 JSON 用单引号包起来连提
    // 11 次——367s / 657k tokens，其中 4 分 11 秒是这 11 连撞。C3 前形状失败在
    // parsePlanCallsCommand 抛出点提前返回、从不计数，熔断器整类失效；C3 起形状
    // 失败计入同一 declinedPlans（语义不变：自上次成功激活以来未激活的提交数，
    // 归零点仍只有 ACTIVE——本会话零激活，所以第 6 次即终局）。
    const command = `bin/17dz plan '{"calls":[{"operation":"payroll.transform","args":["A","202608"]}]}'`;

    const reasons: (string | undefined)[] = [];
    for (let i = 0; i < 6; i += 1) {
      const verdict = await submit(worker, command);
      reasons.push(verdict?.reason);
    }

    // 前 5 次逐次给出同一个形状诊断（自愈通道不变），第 6 次收敛为 PLAN STOP
    expect(reasons.slice(0, 5).every((reason) => reason?.includes('PLAN_JSON_PARSE'))).toBe(true);
    // 措辞与数字逐字钉死（码表唯一来源 messageFor；混合历史下它是提交次数，D-099）
    expect(reasons[5]).toBe(`PLAN STOP：${messageFor('DECLINED_PLAN_LIMIT', '连续 6 次提交方案均未激活')}`);
    // 每次提交一行：6 次提交 6 行，一行不少
    expect(events).toHaveLength(6);
    expect(events[5]?.reason).toBe(reasons[5]);
    worker.session.dispose();
  });

  it('非计划的 bash 调用不走计划上报（仍走 G1 门的 onEvent，不重复落账）', async () => {
    const { events } = auditSink();
    const worker = await workerWith({ sessionId: 'nonplan', events, planCliRunner: activatingRunner });

    // 无活动计划时的普通网关调用：被 G1 门拦下，落的是门那一行（detail = 命令原文），
    // 不是计划摘要那一行
    const verdict = await submit(worker, 'bin/17dz query payroll-transform.js A 202608');

    expect(verdict?.block).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toBe('bin/17dz query payroll-transform.js A 202608');
    worker.session.dispose();
  });
});

/**
 * 真 SDK 链路的落账探针：缺口恰好出在"钩子在生产里到底跑不跑"这一层。
 *
 * 上一轮的替身只直接调 `beforeToolCall`（本文件前两组也是这样），那一层证明不了
 * "SDK 真的会把工具调用送进这个钩子"。这里用假 LLM 端点让**真 AgentSession** 自己
 * 发起一次 bash 计划提交，审计事件必须经 createServeGateAuditSink 这条生产接线出来
 * ——删掉上报那一行，这个用例就红。
 */
describe('计划提交审计：真 SDK AgentSession 链路', () => {
  let server: Server | undefined;
  afterAll(() => { server?.close(); });

  it('模型发起一次 bash 计划提交 → 生产接线落一行（含 requestId 与摘要）', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'fshine-plan-audit-sdk-'));
    roots.push(cwd);
    // 假 OpenAI 兼容端点（SDK 走流式）：第一轮回一个 bash 计划提交，第二轮回文本收尾。
    let turn = 0;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        void body;
        turn += 1;
        const chunk = (delta: unknown, finish: unknown): string => JSON.stringify({
          id: 'chatcmpl-audit', object: 'chat.completion.chunk', created: turn, model: 'audit-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        const lines = turn === 1
          ? [
            chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_audit_1', type: 'function', function: { name: 'bash', arguments: '' } }] }, null),
            chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: PLAN_COMMAND }) } }] }, null),
            chunk({}, 'tool_calls'),
          ]
          : [chunk({ role: 'assistant', content: '方案已提交。' }, null), chunk({}, 'stop')];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const line of lines) res.write(`data: ${line}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server!.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const events: ServeGateEvent[] = [];
    const steps: string[] = [];
    const driver: TurnDriver = createPiCodingTurnDriver({
      env: { LLM_API_BASE_URL: `http://127.0.0.1:${port}`, LLM_API_KEY: 'test-key', LLM_MODEL: 'audit-model' },
      agentDir: path.join(cwd, '.fshine-agent'),
      planCliRunner: activatingRunner,
      serveGateAudit: (event) => { events.push(event); },
    });
    const input: TurnDriverInput = {
      systemPrompt: 'plan audit sdk test',
      tools: [],
      messages: [{ role: 'user', content: '帮我做幻骥达 202608 的工资表', timestamp: 1 } as unknown as DriverMessage],
      cwd,
      skillRoots: [],
      sessionId: 'task_audit_sdk',
      requestId: 'req_audit_sdk',
      onStep: (text) => { steps.push(text); },
      exec: async () => { throw new Error('worker 只能使用其工作目录内配置的原生工具'); },
      deadline: Date.now() + 60_000,
    };

    await driver.run(input);

    // 计划提交帧确实发过（证明这一轮真的走到了提交那一步），审计也落了一行
    expect(steps).toContain('正在向平台提交执行方案…');
    const planEvents = events.filter((event) => event.reason?.includes('PLAN ACTIVE'));
    expect(planEvents).toHaveLength(1);
    expect(planEvents[0]?.tool).toBe('plan_submit');
    expect(planEvents[0]?.allowed).toBe(false);
    expect(planEvents[0]?.requestId).toBe('req_audit_sdk');
    expect(planEvents[0]?.detail).toBe('payroll.transform 幻骥达 202608');

    // 落库后的行必须可辨识（这才是缺口的真故事：行一直在，但查不出来）。
    // 映射口径与 assembly.ts 的 serveGateAudit 落账同一行：
    //   tool_name = `serve_gate:${event.tool}`、status = allowed ? 'ok' : 'error'、
    //   safe_arguments = { detail, ...(reason ? { reason } : {}) }
    const rows = events.map((event) => ({
      toolName: `serve_gate:${event.tool}`,
      status: event.allowed ? 'ok' : 'error',
      safeArguments: { detail: event.detail ?? '', ...(event.reason ? { reason: event.reason } : {}) },
    }));
    // 一条 SQL 就能问出"本轮提交过计划吗"：tool_name 独立于所有门事件
    const planRows = rows.filter((row) => row.toolName === 'serve_gate:plan_submit');
    expect(planRows).toHaveLength(1);
    expect(planRows[0]?.safeArguments.detail).toBe('payroll.transform 幻骥达 202608');
    // 裁决原文也落账：只看 detail 分不清"激活 / 拒绝 / 越权"，原文让这一行自述其结局
    expect(planRows[0]?.safeArguments.reason).toContain('PLAN ACTIVE');
  }, 60_000);
});

/**
 * --file 提交通道的 driver 侧落地（C2）：边界、读取、审计 detail。
 *
 * 守五件事：① 工作区内的计划文件提交能激活，audit detail 带工作区相对路径（方案
 * 来自哪个文件要可复盘）；② 工作区外路径 fail-closed（PLAN_FILE_OUT_OF_WORKSPACE），
 * 平台 CLI 一次都不调；③ 文件内容坏 → PLAN_JSON_PARSE（与 inline 同一份校验，
 * 文件通道不宽松）；④ 文件不存在 → 读取失败带上下文（哪个文件、真实原因）；
 * ⑤ 没配 scratchDir（测试替身 / 老路径）→ 拒，不缺省放行。
 */
describe('计划提交审计：--file 文件通道（C2）', () => {
  const PLAN_JSON = '{"calls":[{"operation":"payroll.transform","args":["A","202608"]}]}';

  it('工作区内的计划文件提交成功：detail 带工作区相对路径 + calls 摘要', async () => {
    const { events } = auditSink();
    const { worker } = await fileWorkerWith({ sessionId: 'file-ok', events, planCliRunner: activatingRunner, planContent: PLAN_JSON });

    const verdict = await submit(worker, 'bin/17dz plan --file tmp/task_file/plan.json');

    expect(verdict?.reason).toContain('PLAN ACTIVE');
    expect(events).toHaveLength(1);
    // 方案来自哪个文件要可复盘（inline 通道只有 calls 摘要，文件通道多一段路径）
    expect(events[0]?.detail).toBe('tmp/task_file/plan.json payroll.transform A 202608');
    worker.session.dispose();
  });

  it('工作区外路径 fail-closed：PLAN_FILE_OUT_OF_WORKSPACE，平台 CLI 一次都不调', async () => {
    const { events } = auditSink();
    const cliCalls: string[] = [];
    const spyRunner: PlanCliRunner = async (request) => {
      cliCalls.push(request.args.join(' '));
      return { code: 1, stdout: '', stderr: '不该被调用' };
    };
    const { worker } = await fileWorkerWith({ sessionId: 'file-out', events, planCliRunner: spyRunner, planContent: PLAN_JSON });

    const verdict = await submit(worker, 'bin/17dz plan --file ../outside-plan.json');

    expect(verdict?.reason).toContain('PLAN DECLINED');
    expect(verdict?.reason).toContain('PLAN_FILE_OUT_OF_WORKSPACE');
    // 平台从没 evaluate/activate 过这份方案（`plan current` 是会话初始化的状态查询，
    // 与本次提交无关；拒绝发生在读文件之前，evaluate 那一跳根本不会发生）
    expect(cliCalls.filter((call) => call.includes('evaluate') || call.includes('activate'))).toEqual([]);
    expect(events).toHaveLength(1);
    worker.session.dispose();
  });

  it('文件内容坏：PLAN_JSON_PARSE（文件通道与 inline 同一份校验，不宽松）', async () => {
    const { events } = auditSink();
    const { worker } = await fileWorkerWith({ sessionId: 'file-bad', events, planCliRunner: activatingRunner, planContent: '{"calls":[}' });

    const verdict = await submit(worker, 'bin/17dz plan --file tmp/task_file/plan.json');

    expect(verdict?.reason).toContain('PLAN DECLINED');
    expect(verdict?.reason).toContain('PLAN_JSON_PARSE');
    // Round 2 加固：坏内容的交付形态必须与 inline 一致（PLAN DECLINED：PLAN_JSON_PARSE
    // 开头）——parsePlanCallsPayload 若被挪进读文件 try，错误会被包成"计划文件读取失败
    // （…）：PLAN_JSON_PARSE…"，上面两条 toContain 仍绿，这条才杀得掉那个变异
    expect(verdict?.reason).not.toContain('计划文件读取失败');
    expect(events).toHaveLength(1);
    worker.session.dispose();
  });

  it('文件不存在：读取失败带上下文（哪个文件、真实原因），不静默', async () => {
    const { events } = auditSink();
    const { worker } = await fileWorkerWith({ sessionId: 'file-missing', events, planCliRunner: activatingRunner });

    const verdict = await submit(worker, 'bin/17dz plan --file tmp/task_file/nope.json');

    expect(verdict?.reason).toContain('PLAN DECLINED');
    expect(verdict?.reason).toContain('计划文件读取失败');
    // Round 2 加固：测试名承诺的"哪个文件、真实原因"两条都要有断言——只断言前缀时，
    // 把包装简化成不含路径与原文的裸消息（`计划文件读取失败`）也能全绿
    expect(verdict?.reason).toContain('tmp/task_file/nope.json');
    expect(verdict?.reason).toContain('ENOENT');
    expect(events).toHaveLength(1);
    worker.session.dispose();
  });

  it('没配 scratchDir：--file 一律拒（fail-closed，不缺省放行）', async () => {
    const { events } = auditSink();
    const { worker } = await fileWorkerWith({ sessionId: 'file-noscratch', events, planCliRunner: activatingRunner, planContent: PLAN_JSON, noScratch: true });

    const verdict = await submit(worker, 'bin/17dz plan --file tmp/task_file/plan.json');

    expect(verdict?.reason).toContain('PLAN DECLINED');
    expect(verdict?.reason).toContain('PLAN_FILE_OUT_OF_WORKSPACE');
    expect(events).toHaveLength(1);
    worker.session.dispose();
  });

  it('计划文件超过 256KB：PLAN_FILE_TOO_LARGE，平台 CLI 一次都不调', async () => {
    const { events } = auditSink();
    const cliCalls: string[] = [];
    const spyRunner: PlanCliRunner = async (request) => {
      cliCalls.push(request.args.join(' '));
      return { code: 1, stdout: '', stderr: '不该被调用' };
    };
    // bash（python3 落盘）绕得过 write 工具的 256KB 上限，宿主读路径必须有自己的界
    const { worker } = await fileWorkerWith({ sessionId: 'file-huge', events, planCliRunner: spyRunner, planContent: `{"calls":[{"operation":"payroll.transform","args":["${'x'.repeat(300 * 1024)}"]}]}` });

    const verdict = await submit(worker, 'bin/17dz plan --file tmp/task_file/plan.json');

    expect(verdict?.reason).toContain('PLAN DECLINED');
    expect(verdict?.reason).toContain('PLAN_FILE_TOO_LARGE');
    // Round 2 加固：钉住是 stat 预检先拦（"根本不读"）而非读后复核兜底——两条消息的
    // 差别就在（读取后 N 字节）文案里；删掉预检只留复核时本条要能红
    expect(verdict?.reason).not.toContain('读取后');
    expect(cliCalls.filter((call) => call.includes('evaluate') || call.includes('activate'))).toEqual([]);
    expect(events).toHaveLength(1);
    worker.session.dispose();
  });

  it('工作区内 .. 穿越：归一后越界即拒（判别性——认原始串前缀的朴素实现放不过它）', async () => {
    const { events } = auditSink();
    const { worker, root } = await fileWorkerWith({ sessionId: 'file-traverse', events, planCliRunner: activatingRunner });
    // 合法计划放在 tmp/ 下（工作区外、平台 tmp 内）：原始串以 tmp/task_file/ 开头
    await writeFile(path.join(root, 'tmp', 'evil.json'), PLAN_JSON, 'utf8');

    const verdict = await submit(worker, 'bin/17dz plan --file tmp/task_file/../evil.json');

    expect(verdict?.reason).toContain('PLAN DECLINED');
    expect(verdict?.reason).toContain('PLAN_FILE_OUT_OF_WORKSPACE');
    expect(events).toHaveLength(1);
    worker.session.dispose();
  });

  it('工作区内符号链接指向工作区外：realpath 判出界即拒', async () => {
    const { events } = auditSink();
    const { worker, root } = await fileWorkerWith({ sessionId: 'file-symlink', events, planCliRunner: activatingRunner });
    const outside = path.join(root, 'tmp', 'evil.json');
    await writeFile(outside, PLAN_JSON, 'utf8');
    await symlink(outside, path.join(root, 'tmp', 'task_file', 'link.json'));

    const verdict = await submit(worker, 'bin/17dz plan --file tmp/task_file/link.json');

    expect(verdict?.reason).toContain('PLAN DECLINED');
    expect(verdict?.reason).toContain('PLAN_FILE_OUT_OF_WORKSPACE');
    worker.session.dispose();
  });

  it('工作区内绝对路径（worker 自然发射形态）：放行，审计 detail 记相对路径不外泄服务器路径', async () => {
    const { events } = auditSink();
    const { worker, root } = await fileWorkerWith({ sessionId: 'file-abs', events, planCliRunner: activatingRunner, planContent: PLAN_JSON });

    const verdict = await submit(worker, `bin/17dz plan --file ${path.join(root, 'tmp', 'task_file', 'plan.json')}`);

    expect(verdict?.reason).toContain('PLAN ACTIVE');
    // 2026-10-18 实证：worker 手里拿到的 write 回执就是绝对路径，"拒绝对路径"的加固
    // 会把主通道变成死路——这条钉住放行 + detail 归一为相对路径（审计不含服务器路径）
    expect(events[0]?.detail).toBe('tmp/task_file/plan.json payroll.transform A 202608');
    worker.session.dispose();
  });

  it('工作区子目录里的计划文件：放行（isInsideScratch 前缀规则覆盖子目录）', async () => {
    const { events } = auditSink();
    const { worker } = await fileWorkerWith({ sessionId: 'file-subdir', events, planCliRunner: activatingRunner, planContent: PLAN_JSON, planName: 'sub/plan.json' });

    const verdict = await submit(worker, 'bin/17dz plan --file tmp/task_file/sub/plan.json');

    expect(verdict?.reason).toContain('PLAN ACTIVE');
    expect(events[0]?.detail).toBe('tmp/task_file/sub/plan.json payroll.transform A 202608');
    worker.session.dispose();
  });

  it('--file 指向目录：不是普通文件分支拒绝（消息可行动），不挂不逃逸', async () => {
    const { events } = auditSink();
    const { worker } = await fileWorkerWith({ sessionId: 'file-dir', events, planCliRunner: activatingRunner });

    const verdict = await submit(worker, 'bin/17dz plan --file tmp/task_file');

    expect(verdict?.reason).toContain('PLAN DECLINED');
    expect(verdict?.reason).toContain('计划文件读取失败');
    // isFile 分支的消息（没有它，这里会是 EISDIR 原文——这条因此判别该守卫在不在）
    expect(verdict?.reason).toContain('不是普通文件');
    expect(events).toHaveLength(1);
    worker.session.dispose();
  });

  it('文件内容坏连提 6 次：第 6 次收敛（文件通道与 inline 共享计数器，C3 覆盖主通道）', async () => {
    const { events } = auditSink();
    const { worker } = await fileWorkerWith({ sessionId: 'file-loop', events, planCliRunner: activatingRunner, planContent: '{"calls":[}' });
    const command = 'bin/17dz plan --file tmp/task_file/plan.json';

    const reasons: (string | undefined)[] = [];
    for (let i = 0; i < 6; i += 1) {
      reasons.push((await submit(worker, command))?.reason);
    }

    expect(reasons.slice(0, 5).every((reason) => reason?.includes('PLAN_JSON_PARSE'))).toBe(true);
    // Round 2 加固：文件通道坏内容的交付形态与 inline 一致——parse 若被挪进读文件
    // try，错误会被包成"计划文件读取失败…PLAN_JSON_PARSE"，上面那条 every 仍绿
    expect(reasons[0]).not.toContain('计划文件读取失败');
    expect(reasons[5]).toBe(`PLAN STOP：${messageFor('DECLINED_PLAN_LIMIT', '连续 6 次提交方案均未激活')}`);
    expect(events).toHaveLength(6);
    worker.session.dispose();
  });

  it('plan --schema 2>&1 | head（带元字符尾巴）：门软放行留痕，不当计划提交', async () => {
    const { events } = auditSink();
    const { worker } = await fileWorkerWith({ sessionId: 'file-schema-tail', events, planCliRunner: activatingRunner });

    const verdict = await submit(worker, 'bin/17dz plan --schema 2>&1 | head -20');

    // 元数据白名单是前缀匹配（与 operation list 同族），尾巴按元字符软放行政策留痕放行
    expect(verdict?.block).toBeUndefined();
    // 不是计划提交：没有 plan_submit 行
    expect(events.filter((event) => event.tool === 'plan_submit')).toEqual([]);
    // Round 2 加固：留痕本身也要有断言——删掉 gate 的（含元字符，软放行）标记，上面
    // 两条仍绿。"不计收敛"由计数器 describe 的 --schema 连提用例守，本条不越界代言
    expect(events.some((event) => event.detail?.includes('含元字符，软放行'))).toBe(true);
    worker.session.dispose();
  });

  it('文件里的 user_confirmed:true 不授权：撞确认门照旧停（提取点由 parsePlanCallsPayload 单测钉住）', async () => {
    const { events } = auditSink();
    // 模型自报确认对文件通道与 inline 同权：evaluate 给 confirm 档裁决时照样停在确认门
    const confirmingRunner: PlanCliRunner = async ({ args }) => {
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 't', planId: null, version: null, status: 'none' }), stderr: '' };
      if (args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify({ planId: 'plan_confirm', version: 3, decision: 'confirm', estimate: { calls: 30, seconds: 600, weight: 2 }, delta: {}, reasonCode: 'CONFIRM_THRESHOLD', status: 'confirming', noticeText: '第 1 批查询' }), stderr: '' };
      throw new Error('unexpected CLI call');
    };
    const notices: string[] = [];
    const { worker } = await fileWorkerWith({
      sessionId: 'file-userconfirmed',
      events,
      planCliRunner: confirmingRunner,
      planContent: '{"calls":[{"operation":"payroll.transform","args":["A","202608"]}],"user_confirmed":true}',
      onNotice: async (text) => { notices.push(text); },
    });

    const verdict = await submit(worker, 'bin/17dz plan --file tmp/task_file/plan.json');

    expect(verdict?.reason).toContain('PLAN NEEDS_USER_CONFIRM');
    // 通知送达是激活授权的一部分：模型声明不能替代它（与 inline 通道同一判据）
    expect(notices).toHaveLength(1);
    worker.session.dispose();
  });

  it('超长工作区路径：审计 detail 截到 AUDIT_DETAIL_MAX_CHARS（R1 新挂的尺子要有判别用例）', async () => {
    const { events } = auditSink();
    // rel 本身约 240 字符：不截断的 detail（rel + calls 摘要 ≈ 266）会越过 200 上限。
    // Round 2 指出 reportPlanSubmission 的 slice 是 R1 新挂的守卫但无判别用例——
    // 删掉 slice 时这条红（266 ≠ 200）。
    const longName = `${'x'.repeat(220)}.json`;
    const { worker } = await fileWorkerWith({ sessionId: 'file-longname', events, planCliRunner: activatingRunner, planContent: PLAN_JSON, planName: longName });

    const verdict = await submit(worker, `bin/17dz plan --file tmp/task_file/${longName}`);

    expect(verdict?.reason).toContain('PLAN ACTIVE');
    expect(events[0]?.detail?.length).toBe(AUDIT_DETAIL_MAX_CHARS);
    worker.session.dispose();
  });
});

/**
 * 收敛计数器的跨形态语义（C3 + Round 1 补强）：两个自增点（形状失败 catch 与
 * decidePlanSubmission）是同一个计数器；归零点只有 ACTIVE；旗标/元数据形态不计入。
 *
 * 2026-10-23 Round 1 review 列出的缺口：原有覆盖只有"纯形状 6 次"与"纯越权 6 次"
 * 两条——混合历史、终局后续跳、元数据不计入、跨通道归零四个性质无主人。
 */
describe('计划提交审计：收敛计数器的跨形态语义（C3）', () => {
  const SHAPE_COMMAND = `bin/17dz plan '{"calls":[{"operation":"payroll.transform","args":["A","202608"]}]}'`;
  const ROGUE_COMMAND = 'bin/17dz plan {"calls":[{"operation":"payroll.transform","args":["查无此实体","202608"]}]}';

  it('形状失败与实体越权混合计数：3+3 后第 6 次收敛，终局串与纯形状历史逐字一致', async () => {
    const { events } = auditSink();
    const worker = await workerWith({
      sessionId: 'mixed',
      events,
      planCliRunner: activatingRunner,
      entitySources: { currentMessage: '帮我做幻骥达 202608 的工资表' },
    });

    const reasons: (string | undefined)[] = [];
    for (let i = 0; i < 3; i += 1) reasons.push((await submit(worker, SHAPE_COMMAND))?.reason);
    for (let i = 0; i < 3; i += 1) reasons.push((await submit(worker, ROGUE_COMMAND))?.reason);

    // 前 3 次形状诊断、第 4/5 次越权——两个自增点各管各的一段历史
    expect(reasons.slice(0, 3).every((reason) => reason?.includes('PLAN_JSON_PARSE'))).toBe(true);
    expect(reasons.slice(3, 5).every((reason) => reason?.includes('ENTITY_OUT_OF_SCOPE'))).toBe(true);
    // 第 6 次收敛；措辞与纯形状历史逐字相同（一个计数器，不按失败类分预算）
    expect(reasons[5]).toBe(`PLAN STOP：${messageFor('DECLINED_PLAN_LIMIT', '连续 6 次提交方案均未激活')}`);
    expect(events).toHaveLength(6);
    worker.session.dispose();
  });

  it('终局后继续提交：第 7/8/9 次仍是 PLAN STOP 且 N 如实递增，不产生新计划', async () => {
    const { events } = auditSink();
    const worker = await workerWith({ sessionId: 'beyond', events, planCliRunner: activatingRunner });

    const reasons: (string | undefined)[] = [];
    for (let i = 0; i < 9; i += 1) reasons.push((await submit(worker, SHAPE_COMMAND))?.reason);

    // 被删的 C1"20 连撞"golden 的性质由这条接棒：熔断一直存在，且数字如实递增
    for (const [index, n] of [[6, 7], [7, 8], [8, 9]] as const) {
      expect(reasons[index]).toBe(`PLAN STOP：${messageFor('DECLINED_PLAN_LIMIT', `连续 ${n} 次提交方案均未激活`)}`);
    }
    expect(events).toHaveLength(9);
    worker.session.dispose();
  });

  it('plan --schema 连提 6 次不计收敛：之后再提合法计划照常激活', async () => {
    const { events } = auditSink();
    const worker = await workerWith({ sessionId: 'schema-nocount', events, planCliRunner: activatingRunner });

    for (let i = 0; i < 6; i += 1) {
      const verdict = await submit(worker, 'bin/17dz plan --schema');
      expect(verdict?.block).toBeUndefined();
    }
    const verdict = await submit(worker, PLAN_COMMAND);
    expect(verdict?.reason).toContain('PLAN ACTIVE');
    // 自救通道不烧预算：6 次元数据查询 + 1 次提交，plan_submit 行只有 1 条
    expect(events.filter((event) => event.tool === 'plan_submit')).toHaveLength(1);
    worker.session.dispose();
  });

  it('--file 成功激活归零共享计数器：4 败→文件激活→再 5 败，第 5 次仍越权、第 6 次才收敛', async () => {
    const { events } = auditSink();
    // 文件里的实体可在当前消息逐字找到（幻骥达/202608）——否则实体校验会先拒
    const { worker } = await fileWorkerWith({
      sessionId: 'file-reset',
      events,
      planCliRunner: activatingRunner,
      planContent: '{"calls":[{"operation":"payroll.transform","args":["幻骥达","202608"]}]}',
      entitySources: { currentMessage: '帮我做幻骥达 202608 的工资表' },
    });

    const reasons: (string | undefined)[] = [];
    // 前 4 次越权计数 1-4；第 5 跳是文件提交（计数 5，未越限）→ 激活 → 归零。
    // 为什么是 4 不是 5：熔断判据是 >5，第 6 跳在抵达 evaluate 之前就被 cap 挡下——
    // "5 败后接合法提交"里那次合法提交自己就是第 6 跳，根本到不了激活。
    for (let i = 0; i < 4; i += 1) reasons.push((await submit(worker, ROGUE_COMMAND))?.reason);
    reasons.push((await submit(worker, 'bin/17dz plan --file tmp/task_file/plan.json'))?.reason);
    // 归零后预算足额：再 5 次越权全部逐次暴露（计数 1-5），第 6 次才收敛。
    // 判别点：若归零没发生，文件激活后的第 1 次失败（计数 6）就会立即 STOP。
    for (let i = 0; i < 6; i += 1) reasons.push((await submit(worker, ROGUE_COMMAND))?.reason);

    expect(reasons.slice(0, 4).every((reason) => reason?.includes('ENTITY_OUT_OF_SCOPE'))).toBe(true);
    expect(reasons[4]).toContain('PLAN ACTIVE');
    expect(reasons.slice(5, 10).every((reason) => reason?.includes('ENTITY_OUT_OF_SCOPE'))).toBe(true);
    expect(reasons[10]).toBe(`PLAN STOP：${messageFor('DECLINED_PLAN_LIMIT', '连续 6 次提交方案均未激活')}`);
    worker.session.dispose();
  });
});
