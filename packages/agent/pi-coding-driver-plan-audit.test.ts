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
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai/compat';
import { createPiCodingTurnDriver, createPiCodingWorkerSession, type PiCodingWorkerSession } from './src/pi-coding-driver';
import type { DriverMessage, TurnDriver, TurnDriverInput } from './src/driver';
import type { ServeGateEvent } from './src/serve-gate';
import { messageTextFor } from './src/error-codes';
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
  capabilities?: readonly string[];
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
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
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

/** 提交即激活（execute 档）：不等通知、不等确认。 */
const activatingRunner: PlanCliRunner = async ({ args }) => {
  if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 't', planId: null, version: null, status: 'none' }), stderr: '' };
  if (args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify({ planId: 'plan_audit', version: 1, decision: 'execute', estimate: { calls: 1, seconds: 1 }, delta: {}, cumulative: {}, status: 'active' }), stderr: '' };
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
      if (args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify({ planId: 'plan_confirm', version: 3, decision: 'confirm', estimate: { calls: 30, seconds: 600 }, delta: {}, cumulative: {}, reasonCode: 'CONFIRM_THRESHOLD', status: 'confirming', noticeText: '第 1 批查询' }), stderr: '' };
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
        stdout: `${JSON.stringify({ planId: 'plan_stop', version: 2, decision: 'stop', estimate: { calls: 60, seconds: 3600 }, delta: { addedCalls: 60 }, cumulative: { calls: 120, seconds: 7200 }, reasonCode: 'HARD_LIMIT', status: 'stopped', noticeText: '累计查询已达本任务硬上限。' })}\n`,
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
    // 写开放：不走前置扫描，这句话必须来自 evaluate 失败分支的分流
    const worker = await workerWith({ sessionId: 'notplannable', events, planCliRunner: rejectingRunner, semantics: SEMANTICS, capabilities: ['read', 'write'] });

    const verdict = await submit(worker, PLAN_COMMAND);

    expect(verdict?.reason).toContain(messageTextFor('PLAN_NOT_PLANNABLE'));
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe(verdict?.reason);
    worker.session.dispose();
  });

  it('平台按"只读"拒绝计划，语义表说要用户确认 → WRITE_NOT_ENABLED，照旧落一行', async () => {
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
      capabilities: ['read', 'write'],
    });

    const verdict = await submit(worker, 'bin/17dz plan {"calls":[{"operation":"voucher.commit","args":["幻骥达","202608"]}]}');

    expect(verdict?.reason).toContain(messageTextFor('WRITE_NOT_ENABLED'));
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

  it('写关闭前置拦截（部署未开放 write）→ WRITE_NOT_ENABLED，落一行', async () => {
    const { events } = auditSink();
    // 能力面不含 write + 语义表说 voucher.commit 要用户确认：宿主在 evaluate 之前就拦
    const worker = await workerWith({
      sessionId: 'prewrite',
      events,
      planCliRunner: activatingRunner,
      semantics: SEMANTICS,
      capabilities: ['read'],
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
    expect(reasons[5]).toContain('DECLINED_PLAN_LIMIT');
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
