import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai/compat';
import {
  createPiCodingWorkerSession,
  createServeGateAuditSink,
  isInputInsufficientCode,
  keyArgsFragment,
  missingLabelFromCode,
  needsFromPlatformResponses,
  nonPlannableOperations,
  operationStepText,
  planNotReadOnlyReason,
  PLAN_SUBMIT_STEP,
  serveGateStepText,
} from './src/pi-coding-driver';
import type { ServeGateEvent } from './src/serve-gate';
import { messageTextFor } from './src/error-codes';
import type { PlanCliRunner } from './src/plan-runtime';

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

describe('pi-coding-agent context worker', () => {
  it('creates a headless cwd-bound session, loads skills, enables workspace tools, and restores messages', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-coding-'));
    roots.push(root);
    const skillRoot = path.join(root, '.agents', 'skills');
    await mkdir(path.join(skillRoot, '17dz'), { recursive: true });
    await writeFile(path.join(skillRoot, '17dz', 'SKILL.md'), [
      '---',
      'name: 17dz-platform',
      'description: 幻账平台工作规范',
      '---',
      '只读查询必须给出可复核证据。',
    ].join('\n'));
    const modelConfig = await fakeModelRuntime();
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [skillRoot],
      systemPrompt: 'worker-system-prompt',
      sessionId: 'task_test_001',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
    });
    expect(worker.session.sessionManager.getCwd()).toBe(root);
    // 2026-10-07 加 'write'。worker 与 coding agent 的差别是"审计更多、权限更窄"，不是"更笨"：
    // 没有 write 且 bash 禁重定向，它产出的中间产物（契约/mapping/临时抽取脚本）只能塞进回复
    // 让宿主持盘，等于逼宿主为每种产物写一条 protocol。边界不在工具面，在 serve-gate 的
    // write 分支（只准 tmp/、禁敏感路径、有体积上限）——那条才是防线。
    // 2026-10-08 加 'edit'：实测 worker 的 11KB 脚本崩在 KeyError，只想改一行却没有 edit
    // （原话 "No edit tool"），bash 门又只准网关调用（用不了 sed），只能整份重写——33 秒
    // 生成，而写 11KB 不可能一次对。edit 与 write 共用 decideFileWrite 那一份边界。
    expect(worker.session.getActiveToolNames()).toEqual(['read', 'ls', 'bash', 'write', 'edit']);
    expect(worker.skills.map((skill) => skill.name)).toContain('17dz-platform');
    expect(worker.session.systemPrompt).toContain('worker-system-prompt');
    worker.session.agent.state.messages = [{ role: 'user', content: '恢复任务', timestamp: Date.now() } as never];
    expect(worker.session.messages).toHaveLength(1);
    expect(worker.session.sessionManager.getSessionId()).toBe('task_test_001');
    worker.session.dispose();
  });

  it('restores the host active plan for a resumed task before allowing native CLI use', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-resume-plan-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const calls: string[][] = [];
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      calls.push(args);
      return {
        code: 0,
        stdout: JSON.stringify({ taskId: 'task_saved', planId: 'plan_saved', version: 4, status: 'active' }),
        stderr: '',
      };
    };
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'resume plan test',
      sessionId: 'task_saved',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
    });
    const command = 'bin/17dz query voucher.query-saved A 202609';
    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_1', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });
    expect(calls).toEqual([['plan', 'current', '--task-id', 'task_saved']]);
    expect(verdict?.block).toBeUndefined();
    worker.session.dispose();
  });

  it('a stop decision preserves the previous active plan restored for this task', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-stop-plan-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_saved', planId: 'plan_previous', version: 1, status: 'active' }), stderr: '' };
      if (args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify({
        planId: 'plan_stopped', version: 2, decision: 'stop', estimate: { calls: 60, seconds: 3600 },
        delta: { addedCalls: 60, addedSeconds: 3600 }, cumulative: { calls: 0, seconds: 0 }, reasonCode: 'hard_limit', status: 'stopped',
      }), stderr: '' };
      throw new Error('unexpected CLI call');
    };
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'stop plan test',
      sessionId: 'task_saved',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
    });
    const call = async (command: string) => worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_1', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });
    const stopped = await call('bin/17dz plan {"calls":[{"operation":"voucher.query-saved","args":["A","202609"]}]}');
    expect(stopped?.reason).toContain('PLAN STOP');
    const existingScope = await call('bin/17dz query voucher.query-saved A 202609');
    expect(existingScope?.block).toBeUndefined();
    worker.session.dispose();
  });

  it('真实 CLI 形态的 stop 裁决（exit 3 + decision JSON）到达结构化 stop 分支，平台摘要透传给 worker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-stop-exit3-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    // 平台对 decision === 'stop' 返回 exit 3、stdout 仍是合法 PlanEvaluation JSON（cli/index.js）。
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_stop3', planId: null, version: null, status: 'none' }), stderr: '' };
      if (args[1] === 'evaluate') return {
        code: 3,
        stdout: `${JSON.stringify({
          planId: 'plan_stop', version: 2, decision: 'stop', estimate: { calls: 60, seconds: 3600 },
          delta: { addedCalls: 60, addedSeconds: 3600 }, cumulative: { calls: 120, seconds: 7200 },
          reasonCode: 'HARD_LIMIT', status: 'stopped', noticeText: '累计查询已达本任务硬上限。',
        })}\n`,
        stderr: '',
      };
      throw new Error('unexpected CLI call');
    };
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'stop exit3 test',
      sessionId: 'task_stop3',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
    });
    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_stop3', type: 'toolCall', name: 'bash', arguments: { command: 'bin/17dz plan {"calls":[{"operation":"voucher.query-saved","args":["A","202609"]}]}' } } as never,
      args: { command: 'bin/17dz plan {"calls":[{"operation":"voucher.query-saved","args":["A","202609"]}]}' },
      context: {} as never,
    });
    // 走到结构化 stop 分支：PLAN STOP + formatPlanMessage 输出（计划通知前缀 + 平台安全摘要），
    // 而不是 catch 分支的泛化 "PLAN PAUSED：17dz plan CLI 失败（...）exit 3"
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('PLAN STOP');
    expect(verdict?.reason).toContain('计划通知：');
    expect(verdict?.reason).toContain('累计查询已达本任务硬上限');
    expect(verdict?.reason).not.toContain('exit 3');
    expect(verdict?.reason).not.toContain('PLAN PAUSED');
    worker.session.dispose();
  });

  it('计划门拒绝含"要用户确认"operation 的计划：拒绝原因是用户可行动的写关闭话术，不是 CLI 失败串', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-write-closed-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const evaluated: string[][] = [];
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_write', planId: null, version: null, status: 'none' }), stderr: '' };
      // 平台 canonicalCall 的确定性拒绝：计划里含非只读 operation（CLI exit 3，stderr 原样带出）
      if (args[1] === 'evaluate') { evaluated.push(args); return { code: 3, stdout: '', stderr: 'PLAN_REFUSE PLAN_OPERATION_NOT_READ_ONLY:voucher.fill\n' }; }
      throw new Error('unexpected CLI call');
    };
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'write closed test',
      sessionId: 'task_write',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
      operationSemantics: SEMANTICS_TABLE,
      // 写开放：前置扫描不触发，这句话必须来自 evaluate 失败分支（平台门真的被咨询了）
      capabilities: ['read', 'write'],
    });
    // 平台语义表说 voucher.fill 要用户确认（confirm=true）→ 部署没开放写的事实
    const command = 'bin/17dz plan {"calls":[{"operation":"voucher.fill","args":["幻辰财税","202609"]}]}';
    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_write', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });

    expect(verdict?.block).toBe(true);
    // 拒绝原因即用户可行动的话术：写未开放 + 找管理员（与提案路径 capability 检查同一句）
    expect(verdict?.reason).toContain('PLAN STOP');
    expect(verdict?.reason).toContain('当前未开放写入权限');
    expect(verdict?.reason).toContain('请联系管理员开通');
    // 不再是"等宿主验证确认"的暂停语义；平台内部错误码与 operation 名也不得透传上屏
    expect(verdict?.reason).not.toContain('PLAN PAUSED');
    expect(verdict?.reason).not.toContain('PLAN_OPERATION_NOT_READ_ONLY');
    expect(verdict?.reason).not.toContain('voucher.fill');
    // 平台门确实被咨询了（不是前置扫描拦的）
    expect(evaluated).toHaveLength(1);
    worker.session.dispose();
  });

  // ── 平台拒绝分流：按语义表的 confirm 列，不按错误码名 ────────────────────────
  // 平台按"是不是只读"拒绝计划，而拒绝名单里混着两类调用：要用户确认的写类调用
  // （部署没开放写 → WRITE_NOT_ENABLED）与根本不需要计划的本地处理（不该进计划 →
  // PLAN_NOT_PLANNABLE）。第二类曾被第一类的话术答复——纯本地处理被用户看到"请联系
  // 管理员开通写入权限"（已实证的误导）。匹配平台错误码只为定位失败点，语义判断读表。
  const NOT_READ_ONLY_REJECTION: PlanCliRunner = async ({ args }) => {
    if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_split', planId: null, version: null, status: 'none' }), stderr: '' };
    if (args[1] === 'evaluate') return { code: 3, stdout: '', stderr: 'PLAN_REFUSE PLAN_OPERATION_NOT_READ_ONLY\n' };
    throw new Error('unexpected CLI call');
  };

  /** 造一个注入了语义表的 worker 会话（计划提交走平台拒绝替身）。 */
  async function rejectingWorker(
    taskId: string,
    semantics: Map<string, { plan: boolean; confirm: boolean; mock: boolean }>,
    counter: { evaluates: number },
  ) {
    const root = await mkdtemp(path.join(os.tmpdir(), `fshine-pi-split-${taskId}-`));
    roots.push(root);
    const planCliRunner: PlanCliRunner = async (request) => {
      if (request.args[1] === 'evaluate') counter.evaluates += 1;
      return NOT_READ_ONLY_REJECTION(request);
    };
    return createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'plan split test',
      sessionId: taskId,
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig: await fakeModelRuntime(),
      planCliRunner,
      operationSemantics: semantics,
      // 写开放：前置扫描（D-075）不触发，裁决完全落到平台计划门——否则写类计划在
      // evaluate 之前就被拦下，测不到 evaluate 失败分支的分流。
      capabilities: ['read', 'write'],
    });
  }

  async function submitPlan(worker: Awaited<ReturnType<typeof createPiCodingWorkerSession>>, calls: string): Promise<string | undefined> {
    const command = `bin/17dz plan {"calls":[${calls}]}`;
    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_split', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });
    return verdict?.reason;
  }

  it('计划含 scratch（本地处理）类 operation 被平台拒绝 → PLAN_NOT_PLANNABLE，不是写未开放', async () => {
    // payroll.transform 是纯本地处理（plan=false / confirm=false）：它不该进计划，
    // 用户不该被要求"联系管理员开通写入权限"——那是已实证的误导。
    const counter = { evaluates: 0 };
    const worker = await rejectingWorker('task_split', SEMANTICS_TABLE, counter);
    const reason = await submitPlan(worker, '{"operation":"payroll.transform","args":["A","202609"]}');
    // 前置扫描没拦（scratch 不要用户确认）：平台门真的被咨询了，分流发生在 evaluate 失败分支
    expect(counter.evaluates).toBe(1);
    expect(reason).toContain('PLAN STOP');
    // 点名版（2026-10-13）：把 payroll.transform 点出来，worker 才知道该删哪一个
    expect(reason).toContain(messageTextFor('PLAN_NOT_PLANNABLE_OPERATIONS', { operations: 'payroll.transform' }));
    expect(reason).not.toContain('当前未开放写入权限');
    expect(reason).not.toContain('请联系管理员开通');
    worker.session.dispose();
  });

  it('计划含 write（要用户确认）类 operation 被平台拒绝 → WRITE_NOT_ENABLED', async () => {
    const counter = { evaluates: 0 };
    const worker = await rejectingWorker('task_split', SEMANTICS_TABLE, counter);
    const reason = await submitPlan(worker, '{"operation":"voucher.commit","args":["A","202609"]}');
    // 写开放部署：前置扫描不触发，这句话来自 evaluate 失败分支的分流（不是前置拦截）
    expect(counter.evaluates).toBe(1);
    expect(reason).toContain('PLAN STOP');
    expect(reason).toContain(messageTextFor('WRITE_NOT_ENABLED'));
    expect(reason).not.toContain('该调用不需要计划');
    worker.session.dispose();
  });

  it('拿不到语义表（平台还没下发 / 派生失败）→ 按"不该进计划"说，不猜是写未开放', async () => {
    const counter = { evaluates: 0 };
    const worker = await rejectingWorker('task_split', new Map(), counter);
    const reason = await submitPlan(worker, '{"operation":"voucher.commit","args":["A","202609"]}');
    expect(counter.evaluates).toBe(1);
    expect(reason).toContain(messageTextFor('PLAN_NOT_PLANNABLE'));
    expect(reason).not.toContain('当前未开放写入权限');
    worker.session.dispose();
  });

  // ── 点名不该进计划的 operation（2026-10-13 生产缺陷修复）────────────────────
  // 旧行为：只回一句"该调用不需要计划"而不说是哪个。worker 的计划里有 3-4 个调用，
  // 它无法定位该删哪一个，原样重提 5 次后撞 MAX_DECLINED_PLANS_PER_TASK terminal block，
  // 只能向用户承认"登记环节连续被拒后已关闭"。点名 = 自愈通道：删它、改直接调用、重提剩余。
  it('点名不该进计划的 operation（可多个）并说清下一步', async () => {
    const counter = { evaluates: 0 };
    const worker = await rejectingWorker('task_named', SEMANTICS_TABLE, counter);
    // 计划里混着两个本地处理类（plan=false）与一个正常查询（plan=true）：只点名前两个
    const reason = await submitPlan(worker, [
      '{"operation":"payroll.transform","args":["A","202609"]}',
      '{"operation":"voucher.precheck","args":["B"]}',
      '{"operation":"voucher.query-saved","args":["A","202609"]}',
    ].join(','));
    expect(counter.evaluates).toBe(1);
    expect(reason).toContain('PLAN STOP');
    // 措辞唯一出处是 error-codes 的表：模板 + 名单数据机械组装（调用点不拼句）
    expect(reason).toContain(messageTextFor('PLAN_NOT_PLANNABLE_OPERATIONS', {
      operations: 'payroll.transform、voucher.precheck',
    }));
    // 逐个点名，且不牵连计划里的合法调用（删错名字比不点名更糟）
    expect(reason).toContain('payroll.transform');
    expect(reason).toContain('voucher.precheck');
    expect(reason).not.toContain('voucher.query-saved');
    // 下一步三件套：从 calls 移除、改为直接调用、重提剩余部分
    expect(reason).toContain('移除');
    expect(reason).toContain('直接调用');
    expect(reason).toContain('重新提交剩余的 calls');
    worker.session.dispose();
  });

  it('同一个 operation 在计划里出现多次只点名一次（名单是数据不是噪音）', async () => {
    const counter = { evaluates: 0 };
    const worker = await rejectingWorker('task_dup', SEMANTICS_TABLE, counter);
    const reason = await submitPlan(worker, [
      '{"operation":"payroll.transform","args":["A","202609"]}',
      '{"operation":"payroll.transform","args":["B","202610"]}',
    ].join(','));
    expect(reason).toContain(messageTextFor('PLAN_NOT_PLANNABLE_OPERATIONS', { operations: 'payroll.transform' }));
    // 去重后的名单：整条理由里该名字只出现一次（模板里那次）
    expect(reason?.split('payroll.transform').length).toBe(2);
    worker.session.dispose();
  });

  it('混合场景（要确认的写类 + 非可计划）分流仍归 WRITE_NOT_ENABLED，不点名、不混成一句', async () => {
    const counter = { evaluates: 0 };
    const worker = await rejectingWorker('task_mixed', SEMANTICS_TABLE, counter);
    const reason = await submitPlan(worker, [
      '{"operation":"payroll.transform","args":["A","202609"]}',
      '{"operation":"voucher.commit","args":["A","202609"]}',
    ].join(','));
    expect(counter.evaluates).toBe(1);
    // 分流判据不变（平台语义表的 confirm 列）：写类在场就说"未开放写入权限"
    expect(reason).toContain(messageTextFor('WRITE_NOT_ENABLED'));
    // 不把"哪个调用不该进计划"混进那句话——两件事混一句，worker 又会开始猜
    expect(reason).not.toContain(messageTextFor('PLAN_NOT_PLANNABLE_OPERATIONS', { operations: 'payroll.transform' }));
    expect(reason).not.toContain('payroll.transform');
    worker.session.dispose();
  });

  it('未登记的 operation 不进点名名单（宁缺勿猜）：退回零名单措辞，不宣称它不需要计划', async () => {
    const counter = { evaluates: 0 };
    const worker = await rejectingWorker('task_unregistered', SEMANTICS_TABLE, counter);
    // voucher.batch 故意不在语义表里：plan 列取不到真值 → 不点名（与 serve-gate 的计划
    // 前置豁免同向：未知不等于免计划），但也不升格成"未开放写入权限"
    const reason = await submitPlan(worker, '{"operation":"voucher.batch","args":["A","202609"]}');
    expect(counter.evaluates).toBe(1);
    expect(reason).toContain(messageTextFor('PLAN_NOT_PLANNABLE'));
    expect(reason).not.toContain('voucher.batch');
    expect(reason).not.toContain('当前未开放写入权限');
    worker.session.dispose();
  });

  it('点名名单按平台 plan 列机械得出：不按错误码名猜、不按 access 词表猜', () => {
    // 纯函数：名单判据是平台语义表的 plan 列（serve-gate 的 planExempt 读同一列）
    expect(nonPlannableOperations([
      { operation: 'payroll.transform', args: [] },
      { operation: 'voucher.query-saved', args: [] },
      { operation: 'voucher.batch', args: [] },
    ], SEMANTICS_TABLE)).toEqual(['payroll.transform']);
    // 同一份表、写类在场也照实判：confirm 列归分流（planNotReadOnlyCode），plan 列归点名
    expect(planNotReadOnlyReason([
      { operation: 'voucher.query-saved', args: [] },
      { operation: 'payroll.transform', args: [] },
    ], SEMANTICS_TABLE)).toBe(messageTextFor('PLAN_NOT_PLANNABLE_OPERATIONS', { operations: 'payroll.transform' }));
    expect(planNotReadOnlyReason([
      { operation: 'payroll.transform', args: [] },
      { operation: 'voucher.commit', args: [] },
    ], SEMANTICS_TABLE)).toBe(messageTextFor('WRITE_NOT_ENABLED'));
    // 拿不到语义表 → 空名单 → 零名单措辞（不把整份计划统统说成不该进计划）
    expect(nonPlannableOperations([{ operation: 'voucher.commit', args: [] }], undefined)).toEqual([]);
    expect(planNotReadOnlyReason([{ operation: 'voucher.commit', args: [] }], new Map())).toBe(messageTextFor('PLAN_NOT_PLANNABLE'));
    // 点名版逐字包含零名单版的基础句：认"该调用不需要计划"的消费者在点名版上照旧认得出
    expect(messageTextFor('PLAN_NOT_PLANNABLE_OPERATIONS', { operations: 'payroll.transform' }))
      .toContain(messageTextFor('PLAN_NOT_PLANNABLE'));
  });

  // ── 写关闭前置拦截（D-075：计划扫描）────────────────────────────────────
  // T7 事故形态的机械版：用户发起录入请求，模型停在"录入准备"阶段、承诺"即可产出录入
  // 提案"，永不抵达提案步——写关闭话术原先只挂在提案路径与平台计划门拒绝上，模型不
  // 走到那儿用户就永远不知道。宿主在计划评估前（calls 已机械解析、尚未放模型执行的
  // 最早一点）自己判定：这份计划含"要用户确认"的 operation 而部署未开放 write，注定跑不完。
  // 判据是平台 access 语义表的 confirm 列（要不要用户确认），不是 access 字符串前缀。

  /** 平台 `operation list --json` 的语义表同形替身（三列由平台声明，宿主只读消费）。 */
  const SEMANTICS_TABLE = new Map<string, { plan: boolean; confirm: boolean; mock: boolean }>([
    ['query-receivables', { plan: true, confirm: false, mock: true }],
    ['finance.query-receivables', { plan: true, confirm: false, mock: true }],
    ['query-saved', { plan: true, confirm: false, mock: true }],
    ['voucher.query-saved', { plan: true, confirm: false, mock: true }],
    ['precheck', { plan: false, confirm: false, mock: false }],
    ['voucher.precheck', { plan: false, confirm: false, mock: false }],
    ['prepare', { plan: true, confirm: true, mock: true }],
    ['voucher.prepare', { plan: true, confirm: true, mock: true }],
    ['commit', { plan: true, confirm: true, mock: true }],
    ['voucher.commit', { plan: true, confirm: true, mock: true }],
    // 本地处理（scratch：不进计划、不要确认）与另一支写类（fill）分别覆盖两条分流
    ['transform', { plan: false, confirm: false, mock: false }],
    ['payroll.transform', { plan: false, confirm: false, mock: false }],
    ['fill', { plan: true, confirm: true, mock: true }],
    ['voucher.fill', { plan: true, confirm: true, mock: true }],
    // voucher.batch 故意不登记：未登记的 operation 不猜语义（宁缺勿猜那条用例要用）
  ]);

  /** 写关闭部署：计划含写类 operation 时宿主在 evaluate 前拦截，拒绝理由即写关闭话术。 */
  it('write-closed deployment: a plan with a write-class operation is blocked before the evaluator runs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-write-scan-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const calls: string[][] = [];
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      calls.push(args);
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_write_scan', planId: null, version: null, status: 'none' }), stderr: '' };
      throw new Error('写关闭拦截后不得再调平台计划门');
    };
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'write scan test',
      sessionId: 'task_write_scan',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
      operationSemantics: SEMANTICS_TABLE,
      capabilities: ['read'],
    });
    const command = 'bin/17dz plan {"calls":[{"operation":"voucher.query-saved","args":["A","202609"]},{"operation":"voucher.prepare","args":["A","202609"]}]}';
    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_scan', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });

    expect(verdict?.block).toBe(true);
    // 拒绝理由复用 error-codes.ts 的 WRITE_NOT_ENABLED 唯一来源（与平台门拒绝/提案路径同一句）
    expect(verdict?.reason).toContain('PLAN STOP');
    expect(verdict?.reason).toContain('当前未开放写入权限');
    expect(verdict?.reason).toContain('请联系管理员开通');
    // 拦在 evaluate 之前：平台计划门从未被调用（本任务只有会话创建时的 plan current）
    expect(calls.filter((args) => args[1] === 'evaluate')).toEqual([]);
    // 拦截事实上抛给驱动侧：结果时刻据此合成终稿
    expect(worker.writeClosed()).toBe(true);
    worker.session.dispose();
  });

  it('write-enabled deployment or read-only plan: the scan does not fire and evaluation proceeds', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-write-open-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const evaluated: string[][] = [];
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_write_open', planId: null, version: null, status: 'none' }), stderr: '' };
      evaluated.push(args);
      return { code: 0, stdout: JSON.stringify({ taskId: 'task_write_open', planId: 'plan_ok', version: 1, decision: 'execute', estimate: { calls: 2, seconds: 20 }, delta: { addedCalls: 2 }, cumulative: {}, reasonCode: 'ok', status: 'active' }), stderr: '' };
    };
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'write open test',
      sessionId: 'task_write_open',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
      operationSemantics: SEMANTICS_TABLE,
      // 写开放：同一份含写类 operation 的计划照常提交平台评估（平台门禁按既有规则裁决）
      capabilities: ['read', 'write'],
    });
    const command = 'bin/17dz plan {"calls":[{"operation":"voucher.prepare","args":["A","202609"]}]}';
    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_open', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });

    expect(verdict?.reason).toContain('PLAN ACTIVE');
    expect(evaluated).toHaveLength(1);
    expect(worker.writeClosed()).toBe(false);
    worker.session.dispose();
  });

  it('write-closed deployment but operation not in the access table: no pre-emptive block (宁缺勿猜)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-write-unknown-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const evaluated: string[][] = [];
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_write_unknown', planId: null, version: null, status: 'none' }), stderr: '' };
      evaluated.push(args);
      return { code: 0, stdout: JSON.stringify({ taskId: 'task_write_unknown', planId: 'plan_ok', version: 1, decision: 'execute', estimate: { calls: 1, seconds: 10 }, delta: { addedCalls: 1 }, cumulative: {}, reasonCode: 'ok', status: 'active' }), stderr: '' };
    };
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'write unknown test',
      sessionId: 'task_write_unknown',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
      operationSemantics: SEMANTICS_TABLE,
      capabilities: ['read'],
    });
    // 未登记的 operation：查不到 access 就不猜它是写类——平台计划门按既有路径裁决
    const command = 'bin/17dz plan {"calls":[{"operation":"voucher.batch","args":["A","202609"]}]}';
    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_unknown', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });

    expect(verdict?.reason).toContain('PLAN ACTIVE');
    expect(evaluated).toHaveLength(1);
    expect(worker.writeClosed()).toBe(false);
    worker.session.dispose();
  });

  it('blocks a platform plan whose entities appear in none of the three sources before calling the CLI evaluator', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-intent-scope-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const calls: string[][] = [];
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: null, version: null, status: 'none' }), stderr: '' };
    };
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'intent scope test',
      sessionId: 'task_scope',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
      entitySources: {
        currentMessage: '查一下幻辰财税账套里猫一杯的应收',
        referenceEvidence: '【宿主主动回溯】tool_result：幻东 202609 余额 51 元',
      },
    });
    const command = 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","幻州幻东制造有限公司","--customer","猫一杯"]},{"operation":"voucher.query-saved","args":["幻州幻东制造有限公司","202609"]}]}';
    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_scope', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });

    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('未在当前请求、检索证据、平台响应或本会话已确立实体中出现的参数');
    expect(calls).toEqual([['plan', 'current', '--task-id', 'task_scope']]);
    worker.session.dispose();
  });

  it('lets a plan through when its entities come from this task\'s platform responses (search→query)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-intent-scope-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const evaluated: string[][] = [];
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      evaluated.push(args);
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: 'plan_active', version: 1, status: 'active' }), stderr: '' };
      return { code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: 'plan_new', version: 1, status: 'active' }), stderr: '' };
    };
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'intent scope test',
      sessionId: 'task_scope',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
      entitySources: { currentMessage: '只查有没有胜利这个帐套' },
    });
    // 本任务此前的目录查询响应：唯一候选名逐字来自平台，宿主不懂业务也必须放行
    worker.session.agent.state.messages = [{
      role: 'toolResult',
      toolCallId: 'call_search',
      content: [{ type: 'text', text: 'RESULT {"op":"finance.search-account-sets","data":{"accountSets":[{"id":"as_1","name":"胜利五金有限责任公司"}]}}' }],
      timestamp: 1,
    } as never];
    const command = 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","胜利五金有限责任公司"]}]}';
    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_scope', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });

    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('PLAN ACTIVE');
    expect(evaluated.some((args) => args[1] === 'evaluate')).toBe(true);
    worker.session.dispose();
  });

  it('lets a plan through when it carries this task\'s own scratch artifact path (2026-10-13 实测假拒修复)', async () => {
    // 事故原形：worker 把提案 payload 写进本轮 scratch 后按路径排进 plan_submit，被
    // ENTITY_OUT_OF_SCOPE 拒；重提再拒，撞 DECLINED_PLAN_LIMIT 后终局 block。这里钉住
    // 驱动侧接线：requestId 派生出的边界判据必须真的传到 validatePlanEntities。
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-intent-scope-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const requestId = 'req_31776cfb-3bdd-4ec7-8389-d5d40ac4b4ea';
    const session = async (sources: { currentMessage: string }) => {
      const evaluated: string[][] = [];
      const planCliRunner: PlanCliRunner = async ({ args }) => {
        evaluated.push(args);
        if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: 'plan_active', version: 1, status: 'active' }), stderr: '' };
        return { code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: 'plan_new', version: 1, status: 'active' }), stderr: '' };
      };
      const worker = await createPiCodingWorkerSession({
        cwd: root,
        skillRoots: [],
        systemPrompt: 'intent scope test',
        sessionId: 'task_scope',
        requestId,
        agentDir: path.join(root, '.fshine-agent'),
        modelConfig,
        planCliRunner,
        entitySources: sources,
      });
      return { worker, evaluated };
    };
    const submit = async (worker: Awaited<ReturnType<typeof createPiCodingWorkerSession>>, command: string) =>
      worker.session.agent.beforeToolCall?.({
        assistantMessage: {} as never,
        toolCall: { id: 'call_scope', type: 'toolCall', name: 'bash', arguments: { command } } as never,
        args: { command },
        context: {} as never,
      });

    // 本轮 scratch 内的产物路径 → 放行（当前消息里没有这个路径，但它不是领域实体）
    const own = await session({ currentMessage: '把幻辰财税 202606 的应收做成提案' });
    const verdict = await submit(own.worker, `bin/17dz plan {"calls":[{"operation":"voucher.proposal","args":["tmp/${requestId}/proposal.json"]}]}`);
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('PLAN ACTIVE');
    expect(own.evaluated.some((args) => args[1] === 'evaluate')).toBe(true);
    own.worker.session.dispose();

    // 同一形状但落在别轮次的 scratch → 仍是越权参数（判据是路径解析结果，不是字符串长相）
    const foreign = await session({ currentMessage: '把幻辰财税 202606 的应收做成提案' });
    const rejected = await submit(foreign.worker, 'bin/17dz plan {"calls":[{"operation":"voucher.proposal","args":["tmp/req_别的任务/proposal.json"]}]}');
    expect(rejected?.reason).toContain('未在当前请求、检索证据、平台响应或本会话已确立实体中出现的参数');
    foreign.worker.session.dispose();
  });

  it('skips entity validation when the host injects no sources', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-no-sources-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const evaluated: string[][] = [];
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      evaluated.push(args);
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: 'plan_active', version: 1, status: 'active' }), stderr: '' };
      return { code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: 'plan_new', version: 1, status: 'active' }), stderr: '' };
    };
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'no sources test',
      sessionId: 'task_scope',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
    });
    const command = 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","任何名称"]}]}';
    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_scope', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });

    // 宿主没有注入来源（老路径）→ 不做实体校验，计划照常进平台评估
    expect(verdict?.reason).toContain('PLAN ACTIVE');
    expect(verdict?.reason).not.toContain('未在当前请求');
    expect(evaluated.some((args) => args[1] === 'evaluate')).toBe(true);
    worker.session.dispose();
  });

  // ── 纠错环：从确定性拒绝原因派生"缺什么"（roadmap Phase 5）──────────

  it('records a structured clue when the host declines a plan for out-of-scope entities', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-needs-clue-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const planCliRunner: PlanCliRunner = async ({ args }) => ({
      code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: null, version: null, status: 'none' }), stderr: '',
    });
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'needs clue test',
      sessionId: 'task_scope',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
      entitySources: { currentMessage: '查一下幻东的应收' },
    });
    expect(worker.needsClue()).toBeNull();

    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_scope', type: 'toolCall', name: 'bash', arguments: { command: 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","幻州幻东制造有限公司"]}]}' } } as never,
      args: { command: 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","幻州幻东制造有限公司"]}]}' },
      context: {} as never,
    });

    expect(verdict?.block).toBe(true);
    // 原因原文就是事实：宿主确定性拦截的理由，交给 Main Agent 决定澄清还是重派
    expect(worker.needsClue()).toMatchObject({ missing: ['请求中未给出的对象'] });
    expect(worker.needsClue()?.reason).toContain('未在当前请求、检索证据、平台响应或本会话已确立实体中出现的参数');
    worker.session.dispose();
  });

  it('converges after repeated plan rejections in one task instead of letting the worker spin', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-decline-cap-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const planCliRunner: PlanCliRunner = async ({ args }) => ({
      code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: null, version: null, status: 'none' }), stderr: '',
    });
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'decline cap test',
      sessionId: 'task_scope',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
      entitySources: { currentMessage: '查一下幻东的应收' },
    });
    const command = 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","幻州幻东制造有限公司"]}]}';
    const submit = () => worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_cap', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });
    // 前 5 次是普通 PLAN DECLINED（宽容试错）；第 6 次起 terminal block，worker 收手向用户说明
    for (let i = 0; i < 5; i += 1) {
      const verdict = await submit();
      expect(verdict?.block).toBe(true);
      expect(verdict?.reason).toContain('PLAN DECLINED');
    }
    const verdict = await submit();
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('PLAN STOP');
    expect(verdict?.reason).toContain('停止重新提交计划');
    worker.session.dispose();
  });

  it('derives the missing item from a platform error code, never from free text', async () => {
    // RESULT 信封里的确定性错误码才是线索来源；自由文本一律忽略（那是猜，不是事实）
    const envelope = (code: string, message: string) => [{
      role: 'toolResult',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: `stdout noise\nRESULT {"v":1,"op":"finance.query-receivables","status":"failed","data":null,"error":{"code":"${code}","message":"${message}"}}` }],
      timestamp: 1,
    } as never];

    expect(needsFromPlatformResponses(envelope('INVALID_PERIOD', '--period 须为 YYYYMM'))).toEqual({
      missing: ['period'],
      reason: '--period 须为 YYYYMM（平台返回 INVALID_PERIOD）',
    });
    expect(needsFromPlatformResponses(envelope('ACCOUNT_SET_NOT_FOUND', '未找到匹配账套: 猫一杯'))).toEqual({
      missing: ['account set'],
      reason: '未找到匹配账套: 猫一杯（平台返回 ACCOUNT_SET_NOT_FOUND）',
    });
    expect(needsFromPlatformResponses(envelope('ASSISTANT_AMBIGUOUS', '客户匹配到多个候选，请选择'))).toMatchObject({ missing: ['assistant'] });

    // 计划门裁决码不是"缺用户信息"：Main Agent 补不了，问用户也没有答案
    expect(needsFromPlatformResponses(envelope('PLAN_CALL_MISMATCH', '实际调用与激活计划不一致'))).toBeNull();
    expect(needsFromPlatformResponses(envelope('PLAN_OPERATION_NOT_READ_ONLY', '计划只能含只读操作'))).toBeNull();
    // 没有信封、没有错误码 → 没有线索，绝不退化成对 worker 自然语言的猜测
    expect(needsFromPlatformResponses([{ role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: '子 Agent：我觉得可能是期间的问题' }], timestamp: 1 } as never])).toBeNull();
    expect(needsFromPlatformResponses([])).toBeNull();
  });

  it('maps error codes to missing-item labels mechanically', () => {
    expect(isInputInsufficientCode('INVALID_PERIOD')).toBe(true);
    expect(isInputInsufficientCode('ACCOUNT_SET_NOT_FOUND')).toBe(true);
    expect(isInputInsufficientCode('SUBJECT_AMBIGUOUS')).toBe(true);
    expect(isInputInsufficientCode('MISSING_ESTIMATE')).toBe(true);
    expect(isInputInsufficientCode('PLAN_CALL_MISMATCH')).toBe(false);
    expect(isInputInsufficientCode('PLAN_HARD_LIMIT')).toBe(false);
    expect(missingLabelFromCode('INVALID_PERIOD')).toBe('period');
    expect(missingLabelFromCode('ACCOUNT_SET_NOT_FOUND')).toBe('account set');
    expect(missingLabelFromCode('ASSISTANT_AMBIGUOUS')).toBe('assistant');
  });

});

// ── 平台调用 → 用户可见进度帧（label 数据驱动，内部事件名禁出 progress） ──

/** 已有活跃计划时的计划 CLI 替身：恢复 current 即激活，其余一律视为意外调用。 */
const activePlanRunner: PlanCliRunner = async ({ args }) => {
  if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_progress', planId: 'plan_progress', version: 1, status: 'active' }), stderr: '' };
  throw new Error(`unexpected CLI call: ${args.join(' ')}`);
};

/** 评估即激活的计划 CLI 替身（用于计划提交帧）。 */
const evaluatingPlanRunner: PlanCliRunner = async ({ args }) => {
  if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_progress', planId: null, version: null, status: 'none' }), stderr: '' };
  if (args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify({
    planId: 'plan_new', version: 1, decision: 'execute', estimate: { calls: 1, seconds: 10 },
    delta: { addedCalls: 1 }, cumulative: {}, reasonCode: 'ok', status: 'active',
  }), stderr: '' };
  throw new Error(`unexpected CLI call: ${args.join(' ')}`);
};

/**
 * 驱动一次 worker 会话里的 bash 工具调用（现有替身模式），回收宿主侧看到的
 * 审计事件与进度帧。进度帧走的是生产接线 createServeGateAuditSink——
 * 测试不另写一套渲染。
 */
async function driveBash(options: {
  command: string;
  operationLabels?: Map<string, string>;
  operationArgStyles?: Map<string, 'name' | 'code'>;
  planCliRunner?: PlanCliRunner;
}): Promise<{ steps: string[]; events: ServeGateEvent[]; verdict: { block?: boolean; reason?: string } | undefined }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-progress-'));
  roots.push(root);
  const modelConfig = await fakeModelRuntime();
  const steps: string[] = [];
  const events: ServeGateEvent[] = [];
  const worker = await createPiCodingWorkerSession({
    cwd: root,
    skillRoots: [],
    systemPrompt: 'progress frame test',
    sessionId: 'task_progress',
    agentDir: path.join(root, '.fshine-agent'),
    modelConfig,
    ...(options.operationLabels ? { operationLabels: options.operationLabels } : {}),
    ...(options.operationArgStyles ? { operationArgStyles: options.operationArgStyles } : {}),
    onStep: (text) => steps.push(text),
    serveGateAudit: createServeGateAuditSink({
      onStep: (text) => steps.push(text),
      requestId: 'req_progress',
      audit: (event) => events.push(event),
    }),
    planCliRunner: options.planCliRunner ?? activePlanRunner,
  });
  try {
    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_progress', type: 'toolCall', name: 'bash', arguments: { command: options.command } } as never,
      args: { command: options.command },
      context: {} as never,
    });
    return { steps, events, verdict };
  } finally {
    worker.session.dispose();
  }
}

describe('进度帧渲染器（唯一模板，零 per-operation 分支）', () => {
  it('任意 label + 任意 keyArgs 都严格匹配同一条模板', () => {
    const pieces = ['查询', 'A', '「', '」', '…', '·', ' ', 'x', '1', '平台操作'];
    let seed = 20260930 >>> 0;
    const rand = (bound: number): number => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) % bound;
    };
    const randomText = (max: number): string => Array.from({ length: rand(max) }, () => pieces[rand(pieces.length)]!).join('');
    const seen = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      const label = randomText(4);
      const keyArgs = Array.from({ length: rand(4) }, () => randomText(3));
      const frame = operationStepText(label, keyArgs);
      seen.add(frame);
      // 唯一模板：正在 + label + 参数摘要 + …
      expect(frame).toBe(`正在${label}${keyArgsFragment(keyArgs)}…`);
      expect(frame.startsWith('正在')).toBe(true);
      expect(frame.endsWith('…')).toBe(true);
      expect(frame.slice(2, -1)).toBe(`${label}${keyArgsFragment(keyArgs)}`);
    }
    expect(seen.size).toBeGreaterThan(300); // 确实扫到了多样化输入，不是同一用例反复跑
  });

  it('参数摘要：无参数空串，多个用 · 分隔，不按内容分支', () => {
    expect(keyArgsFragment(undefined)).toBe('');
    expect(keyArgsFragment([])).toBe('');
    expect(keyArgsFragment(['「甲」', '202609'])).toBe('「甲」·202609');
    expect(keyArgsFragment(['「甲」'])).toBe('「甲」');
  });

  it('空 label → 不发帧（安全缺省，不回退脚本名/操作名）', () => {
    expect(serveGateStepText({ label: '', keyArgs: ['「甲」'] })).toBeNull();
    expect(serveGateStepText({ keyArgs: ['202609'] })).toBeNull();
    expect(serveGateStepText({})).toBeNull();
  });
});

describe('防泄漏：内部事件名不出现在用户可见进度帧里', () => {
  it('驱动一次带 bash 工具调用的 worker session：帧形如「正在…」，无 worker_ 前缀', async () => {
    const { steps, events } = await driveBash({
      command: 'bin/17dz query query-receivables.js --query 猫一杯 --period 202609',
      operationLabels: new Map([['query-receivables', '读取余额']]),
      // 平台 args 规格（flag → 样式）：生产中经 `operation list --json` 派生后注入，
      // 与 label 表同一条数据链；缺规格就不渲染参数摘要（D-012 后的安全缺省）。
      operationArgStyles: new Map([['--query', 'name'], ['--period', 'code']]),
    });
    expect(steps).toEqual(['正在读取余额「猫一杯」·202609…']);
    for (const step of steps) {
      expect(step).not.toMatch(/^worker_/);
      expect(step).not.toMatch(/tool_execution_start|agent_started|agent_finished|toolName/);
      expect(step).toMatch(/^正在.+…$/);
    }
    expect(events.at(-1)?.allowed).toBe(true);
  });

  it('驱动源码里不再发射内部事件名进度帧', async () => {
    const source = await readFile(path.join(__dirname, 'src', 'pi-coding-driver.ts'), 'utf8');
    expect(source).not.toMatch(/worker_(?:tool|agent)/);
    expect(source).not.toMatch(/onStep\(\s*['"`]worker/);
  });

  it('计划提交帧与业务无关，宿主评估方案前发出', async () => {
    const { steps, verdict } = await driveBash({
      command: 'bin/17dz plan {"calls":[{"operation":"voucher.query-saved","args":["甲","202609"]}]}',
      planCliRunner: evaluatingPlanRunner,
    });
    expect(verdict?.reason).toContain('PLAN ACTIVE');
    expect(steps).toEqual([PLAN_SUBMIT_STEP]);
    expect(steps[0]).not.toMatch(/^worker_/);
  });

  it('计划提交落审计：tool_calls 里查得到"worker 提交了什么方案"（operation 名 + args 摘要）', async () => {
    // 计划分支提前 return、不经 gate()，serve-gate 的 onEvent 不会触发——宿主必须自己
    // 上报一次，否则排查时对不上（已实证的审计缺口）。detail 是摘要不是计划 JSON 全文。
    const { events, verdict } = await driveBash({
      command: 'bin/17dz plan {"calls":[{"operation":"voucher.query-saved","args":["甲","202609"]},{"operation":"voucher.prepare","args":["甲","202609"]}]}',
      planCliRunner: evaluatingPlanRunner,
    });
    expect(verdict?.reason).toContain('PLAN ACTIVE');
    // 审计事件由宿主在计划分支上报（G1 门的 onEvent 这条路径不触发）
    expect(events).toHaveLength(1);
    const event = events[0]!;
    // tool 必须独立于所有门事件：否则落库后这一行与被门拦下的 bash 命令
    // 完全无法区分（同 tool_name、同 status，detail 还长得像命令）——
    // 2026-10-10 实证：行一直在 tool_calls 里，但 `safe_arguments like '%plan%'`
    // 查不到，人眼也分不出哪行是计划提交。assembly 据此落成
    // `serve_gate:plan_submit`，"本轮提交过计划吗"才成为一条 SQL。
    expect(event.tool).toBe('plan_submit');
    // 计划分支的每个出口都是 block：记的是判定结果，不是放行
    expect(event.allowed).toBe(false);
    expect(event.reason).toContain('PLAN ACTIVE');
    // operation 名 + args 摘要：两个 calls 都在，参数可辨
    expect(event.detail).toBe('voucher.query-saved 甲 202609 ; voucher.prepare 甲 202609');
    // 计划 JSON 全文绝不进审计（一份方案可以很长，全文会把 tool_calls 撑爆）
    expect(event.detail).not.toContain('"calls"');
    expect(event.detail).not.toContain('{');
    expect(event.detail).not.toContain('}');
    // 既不留 label 也不发帧：计划提交的进度帧只有 PLAN_SUBMIT_STEP 那一帧
    expect(event.label).toBeUndefined();
    expect(event.keyArgs).toBeUndefined();
    expect(event.requestId).toBe('req_progress');
  });
});
describe('降级：没有 label 就零进度帧，审计字段一字不少', () => {
  it('operationLabels 空表 → 零帧，审计事件四个既有字段照旧', async () => {
    const command = 'bin/17dz query query-receivables.js --query 甲 --period 202609';
    const { steps, events } = await driveBash({ command, operationLabels: new Map() });
    expect(steps).toEqual([]);
    expect(events.at(-1)).toEqual({
      tool: 'bash',
      allowed: true,
      reason: undefined,
      detail: command,
      label: undefined,
      keyArgs: undefined,
      // 形态族（A1 披露判据的输入）：既有消费者读的字段一字未动，只多这一个
      invocation: 'executor',
      requestId: 'req_progress',
    });
  });

  it('未注入 label 表且平台根没有 CLI → 派生为空表，零帧', async () => {
    const { steps, events } = await driveBash({ command: 'bin/17dz query query-receivables.js --query 甲 --period 202609' });
    expect(steps).toEqual([]);
    expect(events.at(-1)?.allowed).toBe(true);
    expect(events.at(-1)?.label).toBeUndefined();
  });

  it('被拦的调用既不留 label 也不发帧', async () => {
    const { steps, events } = await driveBash({
      command: 'bin/17dz query query-receivables.js --query 甲; cat .env',
      operationLabels: new Map([['query-receivables', '读取余额']]),
    });
    expect(steps).toEqual([]);
    expect(events.at(-1)?.allowed).toBe(false);
    expect(events.at(-1)?.label).toBeUndefined();
  });
});
