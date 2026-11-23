/**
 * 写确认回环·宿主接线（2026-11-17 切片）：允许集派生 + 会话级句柄 + 下一回合原话透传。
 *
 * 业务形态（7 条用例，全部真 dummy 夹具、零网络）：
 *   1. 正常：prepare → 用户「确认」→ commit 成功 → query 读回新增记录；
 *   2. 不确认、改说别的：零写入，提案未被消费且仍可被正确拒绝；
 *   3. 重复确认：同一句柄只执行一次（第二次确定性拒绝，账本只有一次写入）；
 *   4. 越权：另一个 (principal,session) 拿同一句柄 → 拒绝，话术与「不存在」一致；
 *   5. 过期：构造过期提案 → 拒绝并明确告知过期；
 *   6. 关闭开关（缺省）：write op 不在允许集，写请求确定性拒绝、零写入；
 *   7. 读回不一致：执行层返回 failed/readback short，宿主如实呈现失败，不输出成功话术。
 *
 * 宿主只做三件事（本文件钉住的边界）：
 *   · 允许集：装配层从执行层自述 `access=write` 派生写面，由 `runtime.allowWriteOperations`
 *     开关控制（缺省 false = 零行为变化）；
 *   · 会话级最小状态：收到 needs_confirmation 时按会话记 { handle, summary, expiresAt }，
 *     只把 summary 交回模型转述（句柄不进模型转录）；
 *   · 下一回合透传：同一会话再调 execute_operation 时把句柄与本回合用户原话原样放进
 *     `ExecutionRequest.confirmation`；执行层返回后清除。宿主不判断用户是不是在确认，
 *     不拦截、不排队、不裁决——绑定/有效期/一次性/业务校验全在执行层。
 *
 * 模型面用脚本化 TurnDriver（零网络、确定性）；执行层是仓内 `bin/dummy` 真夹具，
 * 状态根经 `--state-dir` 按用例隔离。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@fshine/core';
import type {
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { createDummyCliClient } from '../packages/agent/src/dummy-cli-client';
import type {
  DriverMessage,
  TurnDriver,
  TurnDriverInput,
  TurnDriverResult,
} from '../packages/agent/src/driver-contract';
import {
  EXECUTE_OPERATION_TOOL,
  TASK_RUN_TOOL,
  type Session,
} from '../packages/agent/src/execution-runtime';
import { createSqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskMayBeRunningOf, taskReportedOf, taskUnstartedOf, taskWaitingOf } from '../packages/agent/testing/task-facts';
import { createFileStore } from '../packages/agent/src/file-store';
import {
  assembleSessionCore,
  resolveExecutionFace,
  type ExecutionFaceFactory,
} from './ask-runtime';
import { materializeEvalConfig } from './resolve-config-path';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

/** 宿主允许集合的确定性拒绝话术（execution-runtime.ts；不依赖模型自觉，且不含 operation 名）。 */
const WRITE_NOT_ALLOWED_MESSAGE = '当前权限不支持这个操作';
/** 夹具声明的写 operation（access=write；开关关闭时一个都不进允许集）。 */
const WRITE_OPERATIONS = [
  'dummy.longtask',
  'dummy.prepare',
  'dummy.commit',
  'dummy.proposal',
  'dummy.proposal-commit',
  'ballot.prepare',
  'ballot.commit',
  'ballot.proposal',
  'ballot.proposal-commit',
] as const;

const PREPARE_ARGS: Record<string, unknown> = { '--collection': 'alpha', '--window': 'W1', '--count': 2 };
const COMMIT_ARGS: Record<string, unknown> = { '--collection': 'alpha', '--window': 'W1', '--count': 2 };

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function baseEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] };
}

function materializedConfig(dir: string) {
  const configPath = materializeEvalConfig(FIXTURE_CONFIG, path.join(dir, 'agent-config.yaml'));
  return loadConfig({ yamlPath: configPath, env: {} });
}

// ── 脚本化驱动（零网络；步骤按 send 顺序消费） ────────────────────────────────

type ToolArgs = Record<string, unknown> | ((context: { delegation: string }) => Record<string, unknown>);
type StepText = string | ((results: readonly unknown[], toolError: string | undefined) => string);

interface DriverStep {
  calls?: ReadonlyArray<{ tool: string; args: ToolArgs }>;
  text: StepText;
}

class ScriptedDriver implements TurnDriver {
  private readonly steps: DriverStep[] = [];
  readonly toolNames: string[][] = [];
  readonly toolResults: unknown[] = [];
  readonly toolErrors: string[] = [];
  readonly prompts: string[] = [];

  push(step: DriverStep): void {
    this.steps.push(step);
  }

  async run(input: TurnDriverInput): Promise<TurnDriverResult> {
    this.toolNames.push(input.tools.map((tool) => tool.name));
    const last = input.messages[input.messages.length - 1] as unknown as { content?: unknown } | undefined;
    const content = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    this.prompts.push(content);
    const step = this.steps.shift();
    if (step === undefined) throw new Error('（测试）没有更多驱动步骤');
    const results: unknown[] = [];
    let toolError: string | undefined;
    for (const call of step.calls ?? []) {
      try {
        const args = typeof call.args === 'function' ? call.args({ delegation: content }) : call.args;
        const result = await input.exec(call.tool, args);
        results.push(result);
        this.toolResults.push(result);
      } catch (error) {
        toolError = error instanceof Error ? error.message : String(error);
        this.toolErrors.push(toolError);
        break;
      }
    }
    const text = typeof step.text === 'function' ? step.text(results, toolError) : step.text;
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text }],
      timestamp: Date.now(),
    } as unknown as DriverMessage;
    return { text, messages: [...input.messages, message] };
  }
}

// ── 装配夹具（真 assembleSessionCore + 真 dummy 执行层） ─────────────────────

interface HostFixture {
  stateDir: string;
  session: Session;
  main: ScriptedDriver;
  worker: ScriptedDriver;
  /** 宿主实际发给执行层的请求（仅 captureRequests=true 时记录）。 */
  requests: ExecutionRequest[];
  close(): void;
}

interface HostFixtureOptions {
  dir: string;
  allowWrite?: boolean;
  principalId?: string;
  sessionId?: string;
  captureRequests?: boolean;
  confirmationConfig?: Record<string, unknown>;
}

async function createHostFixture(options: HostFixtureOptions): Promise<HostFixture> {
  const stateDir = path.join(options.dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  if (options.confirmationConfig !== undefined) {
    writeFileSync(path.join(stateDir, 'confirmation-config.json'), JSON.stringify(options.confirmationConfig));
  }
  const config = materializedConfig(options.dir);
  const profile = config.contextProfiles['dummy'];
  if (profile === undefined) throw new Error('fixture 配置缺少 dummy contextProfile');
  // 载荷型参数（records）需要任务文件桥的 fileStore 与底账 store：与生产装配同一实例形状。
  const taskRegistry = createSqliteTaskRegistry(path.join(options.dir, 'state.db'));
  const fileStore = createFileStore({ store: taskRegistry.store, workspaceRoot: path.join(options.dir, 'workspace') });

  const main = new ScriptedDriver();
  const worker = new ScriptedDriver();
  const requests: ExecutionRequest[] = [];
  let createExecutionFace: ExecutionFaceFactory | undefined;
  if (options.captureRequests === true) {
    const face = await resolveExecutionFace({
      profile,
      env: baseEnv(),
      stateDir,
      emptyOperationsMessage: '（测试）空允许集合',
      allowWriteOperations: options.allowWrite === true,
      allowedPermissions: options.allowWrite === true ? ['read', 'write'] : ['read'],
    });
    const client: ExecutionClient = {
      capabilities: () => face.client.capabilities(),
      execute: async (request, callOptions) => {
        requests.push(request);
        return await face.client.execute(request, callOptions);
      },
    };
    createExecutionFace = async () => ({
      client,
      allowedOperations: face.allowedOperations,
      readOnlyOperations: face.readOnlyOperations,
    });
  }

  const assembled = await assembleSessionCore({
    env: baseEnv(),
    profile,
    principalId: options.principalId ?? 'wecom:fixture-writer',
    sessionId: options.sessionId ?? 'sess_host_write_confirm',
    dbPath: path.join(options.dir, 'state.db'),
    stateDir,
    setAuditPath: true,
    ...(options.allowWrite === true ? { runtime: { allowWriteOperations: true }, allowedPermissions: ['read', 'write'] } : {}),
    emptyOperationsMessage: '执行层没有声明任何只读 operation——测试拒绝。',
    taskRegistry,
    // 载荷型参数（records）的宿主装信封需要任务文件桥：与生产装配同一条注入
    // （不注入 = 宿主无法 lint/落盘，会按「内容不行」在发起执行前拒绝）。
    taskExecutionBridge: { store: fileStore },
    mainSystemPrompt: '你是测试主 Agent。',
    workerSkills: [],
    createDrivers: async () => ({ mainDriver: main, workerDriver: worker }),
    ...(createExecutionFace === undefined ? {} : { createExecutionFace }),
  });
  return {
    stateDir,
    session: assembled.session,
    main,
    worker,
    requests,
    close: () => {
      assembled.close();
      taskRegistry.close();
    },
  };
}

// ── Worker/Main 的忠实转述脚本（文本来自工具结果，不预设结论） ───────────────

/** Worker：把执行层返回的确认摘要原样转述；宿主只应给 summary（句柄不进模型转录）。 */
function prepareReport(results: readonly unknown[], toolError: string | undefined): string {
  if (toolError !== undefined) return `预演失败：${toolError}`;
  const outcome = results[0] as { status?: string; summary?: string; confirmation?: { summary?: string } };
  const summary = outcome.summary ?? outcome.confirmation?.summary ?? '';
  return `执行层要求确认：${summary}`;
}

/** Worker：按执行层状态如实汇报（completed/refused/failed 不混用）。 */
function commitReport(results: readonly unknown[], toolError: string | undefined): string {
  if (toolError !== undefined) return `提交失败：${toolError}`;
  const outcome = results[0] as {
    status?: string;
    data?: { readBack?: { delta?: number }; added?: number };
    error?: { code?: string; message?: string };
  };
  if (outcome.status === 'completed') {
    return `写入完成，读回新增 ${String(outcome.data?.readBack?.delta ?? outcome.data?.added)} 条。`;
  }
  return `写入失败（${outcome.status ?? '未知'}）：${outcome.error?.code ?? ''} ${outcome.error?.message ?? ''}`;
}

/** Main：只看 task_run 回执里的执行事实（needs_confirmation ≠ completed ≠ failed）。 */
function mainRelay(results: readonly unknown[], toolError: string | undefined): string {
  if (toolError !== undefined) return `任务失败：${toolError}`;
  const receipt = results[0] as { summary?: string; executions?: Array<{ status?: string }> };
  const executions = receipt.executions ?? [];
  if (executions.some((execution) => execution.status === 'needs_confirmation')) {
    return `等待确认：${receipt.summary ?? ''}`;
  }
  if (executions.length > 0 && executions.every((execution) => execution.status === 'completed')) {
    return `已完成：${receipt.summary ?? ''}`;
  }
  return `未完成：${receipt.summary ?? ''}`;
}

// ── 执行层直连探针（读回 / 越权 / 绑定拒绝；不经宿主） ───────────────────────

let directSequence = 0;
async function directExecute(
  stateDir: string,
  operation: string,
  args: Record<string, unknown>,
  confirmation?: { handle: string; userText?: string },
): Promise<ExecutionOutcome> {
  directSequence += 1;
  const client = createDummyCliClient({ root: FIXTURE_ROOT, gateway: 'bin/dummy', stateDir, env: baseEnv() });
  return await client.execute({
    requestId: `req_host_wc_${directSequence}`,
    dispatchKey: `dk_host_wc_${directSequence}`,
    operation,
    args,
    ...(confirmation === undefined ? {} : { confirmation }),
  });
}

interface QueryData {
  collection: string;
  window: string | null;
  items: Array<{ id: string; name: string; value: number }>;
  count: number;
}

async function queryData(stateDir: string, collection = 'alpha', window = 'W1'): Promise<QueryData> {
  const outcome = await directExecute(stateDir, 'dummy.query', { '--collection': collection, '--window': window });
  expect(outcome.status).toBe('completed');
  if (outcome.status !== 'completed') throw new Error(`query 未完成：${outcome.status}`);
  return outcome.data as QueryData;
}

interface ConfirmationRecord {
  handle: string;
  collection: string;
  window: string;
  count: number;
  expiresAt: string;
  usedAt?: string | null;
}

function confirmationRecord(stateDir: string, handle: string): ConfirmationRecord {
  const store = JSON.parse(readFileSync(path.join(stateDir, 'confirmations.json'), 'utf8')) as {
    confirmations?: Record<string, ConfirmationRecord>;
  };
  const record = store.confirmations?.[handle];
  if (record === undefined) throw new Error(`（测试）没有确认记录：${handle}`);
  return record;
}

/** 最近一次 prepare 发放的句柄（执行层状态文件是测试可查的机械事实）。 */
function latestHandle(stateDir: string): string {
  const store = JSON.parse(readFileSync(path.join(stateDir, 'confirmations.json'), 'utf8')) as {
    confirmations?: Record<string, ConfirmationRecord>;
  };
  const handles = Object.keys(store.confirmations ?? {});
  const handle = handles[handles.length - 1];
  if (handle === undefined) throw new Error('（测试）没有确认记录');
  return handle;
}

function auditLines(stateDir: string): string[] {
  const file = path.join(stateDir, 'audit.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '') : [];
}

/** 一次「用户要求写入」的回合：Main 交办 + Worker 发一次执行调用。 */
async function runWriteTurn(
  fx: HostFixture,
  input: {
    userText: string;
    task: string;
    operation: string;
    args: Record<string, unknown>;
    report: StepText;
  },
): Promise<Awaited<ReturnType<Session['send']>>> {
  fx.worker.push({
    calls: [{ tool: EXECUTE_OPERATION_TOOL, args: { operation: input.operation, args: input.args } }],
    text: input.report,
  });
  fx.main.push({ calls: [{ tool: TASK_RUN_TOOL, args: { task: input.task } }], text: mainRelay });
  return await fx.session.send(input.userText);
}

describe('写确认回环·带逐条内容（records 载荷：宿主 lint + 物化文件）', () => {
  const records = [{ name: 'alpha-item-3', value: 100 }, { name: 'alpha-item-4', value: 200 }];
  // 模型给的是结构化数组（不是 JSON 字符串）：宿主按声明 schema lint 后物化成文件，执行层逐项校验。
  const prepareArgs = { collection: 'alpha', window: 'W1', records };
  const commitArgs = { ...prepareArgs };

  it('1b 摘要列出用户给的内容；commit 写入的正是这些 name/value；读回可见', async () => {
    const fx = await createHostFixture({ dir: tempDir('host-wc-records-'), allowWrite: true, captureRequests: true });
    try {
      const turn1 = await runWriteTurn(fx, {
        userText: '在 alpha 集合 W1 新增 alpha-item-3=100、alpha-item-4=200',
        task: '在 alpha 集合新增两条指定内容',
        operation: 'dummy.prepare',
        args: prepareArgs,
        report: '等你确认',
      });
      expect(turn1.executions.map((execution) => execution.status)).toEqual(['needs_confirmation']);
      // 预演不写数据
      expect((await queryData(fx.stateDir)).count).toBe(2);
      // 摘要必须把「要写什么」说清（不能只说条数）
      const prepared = fx.worker.toolResults[0] as { summary?: string };
      expect(prepared.summary).toContain('alpha-item-3=100');
      expect(prepared.summary).toContain('alpha-item-4=200');

      const turn2 = await runWriteTurn(fx, {
        userText: '确认',
        task: '用户已确认，提交刚才的写入提案',
        operation: 'dummy.commit',
        args: commitArgs,
        report: '已写入',
      });
      expect(turn2.executions.map((execution) => execution.status)).toEqual(['completed']);
      // 写入的是用户给的内容，不是平台自动生成的占位记录
      const after = await queryData(fx.stateDir);
      expect(after.count).toBe(4);
      expect(after.items.slice(2).map((item) => ({ name: item.name, value: item.value }))).toEqual(records);
    } finally {
      fx.close();
    }
  });
});

describe('写确认回环·宿主接线（真 dummy 夹具）', () => {
  it('1 正常：prepare → 用户「确认」→ commit 成功 → query 读回看到新增记录', async () => {
    const fx = await createHostFixture({ dir: tempDir('host-wc-normal-'), allowWrite: true, captureRequests: true });
    try {
      const turn1 = await runWriteTurn(fx, {
        userText: '帮我在 alpha 集合里新增两条记录',
        task: '在 alpha 集合新增两条记录',
        operation: 'dummy.prepare',
        args: PREPARE_ARGS,
        report: prepareReport,
      });
      // 预演只出提案：执行事实 needs_confirmation，数据未写。
      expect(turn1.executions.map((execution) => execution.status)).toEqual(['needs_confirmation']);
      expect(turn1.reply).toContain('等待确认');
      expect((await queryData(fx.stateDir)).count).toBe(2);
      // 模型只拿到机械摘要；句柄留在宿主的会话小表里，不进模型转录。
      const prepared = fx.worker.toolResults[0] as { status?: string; summary?: string };
      expect(prepared.status).toBe('needs_confirmation');
      expect(prepared.summary).toContain('alpha');
      expect(prepared.summary).toContain('W1');
      expect(prepared.summary).toContain('2');
      // 摘要必须是用户能直接读的中文 + 本地时间，不得是英文模板或原始 ISO（live 实测过）
      expect(prepared.summary).toContain('不可撤销');
      expect(prepared.summary).toContain('将向集合「alpha」');
      expect(prepared.summary).not.toMatch(/cannot be undone/i);
      expect(prepared.summary).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(JSON.stringify(prepared)).not.toContain('cf_');
      expect(fx.requests).toHaveLength(1);
      expect(fx.requests[0]!.confirmation).toBeUndefined();

      const turn2 = await runWriteTurn(fx, {
        userText: '确认，写入这两条',
        task: '用户已确认，提交刚才的写入提案',
        operation: 'dummy.commit',
        args: COMMIT_ARGS,
        report: commitReport,
      });
      // 下一回合透传：句柄 + 本回合用户原话原样到执行层（宿主不解释原话）。
      expect(fx.requests).toHaveLength(2);
      const commitRequest = fx.requests[1]!;
      expect(commitRequest.operation).toBe('dummy.commit');
      expect(commitRequest.confirmation).toBeDefined();
      expect(commitRequest.confirmation!.handle).toMatch(/^cf_/);
      expect(commitRequest.confirmation!.userText).toBe('确认，写入这两条');
      // 执行层提交成功，宿主按契约原样转述；读回能看到新增记录。
      expect(turn2.executions.map((execution) => execution.status)).toEqual(['completed']);
      expect(turn2.reply).toContain('已完成');
      const after = await queryData(fx.stateDir);
      expect(after.count).toBe(4);
      expect(after.items).toHaveLength(4);
    } finally {
      fx.close();
    }
  });

  it('2 不确认、改说别的：零写入，提案未被消费且仍可被正确拒绝', async () => {
    const fx = await createHostFixture({ dir: tempDir('host-wc-noconfirm-'), allowWrite: true });
    try {
      await runWriteTurn(fx, {
        userText: '帮我在 alpha 集合里新增两条记录',
        task: '在 alpha 集合新增两条记录',
        operation: 'dummy.prepare',
        args: PREPARE_ARGS,
        report: prepareReport,
      });
      const handle = latestHandle(fx.stateDir);

      // 用户改说别的：Worker 只查询；宿主不应把未消费的句柄塞给只读调用。
      const turn2 = await runWriteTurn(fx, {
        userText: '先别写，我再想想，查一下 alpha 现在有什么',
        task: '只查询 alpha 的记录，不要写入',
        operation: 'dummy.query',
        args: { '--collection': 'alpha', '--window': 'W1' },
        report: (results, toolError) => {
          if (toolError !== undefined) return `查询失败：${toolError}`;
          const outcome = results[0] as { status?: string; data?: { count?: number } };
          return outcome.status === 'completed' ? `只读查询到 ${String(outcome.data?.count)} 条。` : '查询失败。';
        },
      });
      expect(turn2.reply).toContain('2');
      expect((await queryData(fx.stateDir)).count).toBe(2);
      // 提案没被旁路调用烧掉：usedAt 仍为空。
      expect(confirmationRecord(fx.stateDir, handle).usedAt ?? null).toBeNull();
      // 提案仍可被正确拒绝：绑定不一致 → 确定性拒绝、零写入。
      const mismatch = await directExecute(
        fx.stateDir,
        'dummy.commit',
        { '--collection': 'alpha', '--window': 'W1', '--count': 3 },
        { handle },
      );
      expect(mismatch).toMatchObject({ status: 'refused', error: { code: 'CONFIRMATION_BINDING_MISMATCH' } });
      expect((await queryData(fx.stateDir)).count).toBe(2);
    } finally {
      fx.close();
    }
  });

  it('3 重复确认：同一句柄只执行一次（第二次确定性拒绝，账本只有一次写入）', async () => {
    const fx = await createHostFixture({ dir: tempDir('host-wc-duplicate-'), allowWrite: true });
    try {
      await runWriteTurn(fx, {
        userText: '帮我在 alpha 集合里新增两条记录',
        task: '在 alpha 集合新增两条记录',
        operation: 'dummy.prepare',
        args: PREPARE_ARGS,
        report: prepareReport,
      });
      const handle = latestHandle(fx.stateDir);
      await runWriteTurn(fx, {
        userText: '确认，写入这两条',
        task: '用户已确认，提交刚才的写入提案',
        operation: 'dummy.commit',
        args: COMMIT_ARGS,
        report: commitReport,
      });
      expect((await queryData(fx.stateDir)).count).toBe(4);
      expect(confirmationRecord(fx.stateDir, handle).usedAt).toBeTruthy();

      // 再次确认：即使调用方自行携带同一句柄（放进 args，模拟句柄被留在上下文里），
      // 执行层的一次性校验也必须拒绝，账本仍只有一次写入。
      const turn3 = await runWriteTurn(fx, {
        userText: '确认，再写一次',
        task: '再次提交同一提案',
        operation: 'dummy.commit',
        args: { ...COMMIT_ARGS, '--confirmation': handle },
        report: commitReport,
      });
      expect(turn3.executions.map((execution) => execution.status)).toEqual(['refused']);
      // 2026-11-19 模型可见面收口：refused 投影不带原始码（CONFIRMATION_USED 只进底账
      // execution.error 与日志），模型只见 kind + note（表外码 → executor_failed）。
      const refused = fx.worker.toolResults[fx.worker.toolResults.length - 1] as {
        status?: string;
        kind?: string;
        error?: unknown;
      };
      expect(refused.status).toBe('refused');
      expect(refused.error).toBeUndefined();
      expect(refused.kind).toBe('executor_failed');
      expect((await queryData(fx.stateDir)).count).toBe(4);
    } finally {
      fx.close();
    }
  });

  it('4 越权：另一个 (principal,session) 拿同一句柄 → 拒绝，话术与「不存在」一致', async () => {
    const sessionA = await createHostFixture({
      dir: tempDir('host-wc-cross-a-'),
      allowWrite: true,
      principalId: 'wecom:fixture-writer',
      sessionId: 'sess_host_wc_a',
    });
    const sessionB = await createHostFixture({
      dir: tempDir('host-wc-cross-b-'),
      allowWrite: true,
      principalId: 'wecom:other-user',
      sessionId: 'sess_host_wc_b',
    });
    try {
      await runWriteTurn(sessionA, {
        userText: '帮我在 alpha 集合里新增两条记录',
        task: '在 alpha 集合新增两条记录',
        operation: 'dummy.prepare',
        args: PREPARE_ARGS,
        report: prepareReport,
      });
      const handleA = latestHandle(sessionA.stateDir);
      // A 的模型转录里没有句柄。
      expect(JSON.stringify(sessionA.worker.toolResults)).not.toContain('cf_');

      // B 拿 A 的句柄提交（放进 args，模拟句柄泄漏）：B 的执行层状态里没有该句柄 → 找不到。
      await runWriteTurn(sessionB, {
        userText: '确认',
        task: '提交这个提案',
        operation: 'dummy.commit',
        args: { ...COMMIT_ARGS, '--confirmation': handleA },
        report: commitReport,
      });
      const stolen = sessionB.worker.toolResults[sessionB.worker.toolResults.length - 1] as {
        status?: string;
        kind?: string;
        note?: string;
        error?: unknown;
      };
      // B 再拿一个不存在的句柄：话术必须与上一条完全一致（不泄漏该句柄在别处存在）。
      await runWriteTurn(sessionB, {
        userText: '确认',
        task: '提交这个提案',
        operation: 'dummy.commit',
        args: { ...COMMIT_ARGS, '--confirmation': 'cf_does-not-exist' },
        report: commitReport,
      });
      const unknown = sessionB.worker.toolResults[sessionB.worker.toolResults.length - 1] as {
        status?: string;
        kind?: string;
        note?: string;
        error?: unknown;
      };
      expect(stolen.status).toBe('refused');
      expect(unknown.status).toBe('refused');
      // 2026-11-19 模型可见面收口：refused 投影不带原始码（error 不下放）；越权与不存在
      // 在模型/用户可见面完全一致（kind/note 同值）——存在性不泄露的断言因此更强。
      expect(stolen.error).toBeUndefined();
      expect(unknown.error).toBeUndefined();
      expect(stolen.kind).toBe(unknown.kind);
      expect(stolen.note).toBe(unknown.note);
      expect(stolen).toEqual(unknown);
      // 两个会话都没有被写；A 的提案也没有因越权尝试被消费。
      expect((await queryData(sessionA.stateDir)).count).toBe(2);
      expect((await queryData(sessionB.stateDir)).count).toBe(2);
      expect(confirmationRecord(sessionA.stateDir, handleA).usedAt ?? null).toBeNull();
    } finally {
      sessionA.close();
      sessionB.close();
    }
  });

  it('5 过期：构造过期提案 → 拒绝，明确告知过期，零写入', async () => {
    const fx = await createHostFixture({
      dir: tempDir('host-wc-expired-'),
      allowWrite: true,
      confirmationConfig: { ttlSeconds: -1 },
    });
    try {
      const turn1 = await runWriteTurn(fx, {
        userText: '帮我在 alpha 集合里新增两条记录',
        task: '在 alpha 集合新增两条记录',
        operation: 'dummy.prepare',
        args: PREPARE_ARGS,
        report: prepareReport,
      });
      expect(turn1.executions.map((execution) => execution.status)).toEqual(['needs_confirmation']);
      const handle = latestHandle(fx.stateDir);
      expect(new Date(confirmationRecord(fx.stateDir, handle).expiresAt).getTime()).toBeLessThanOrEqual(Date.now());

      const turn2 = await runWriteTurn(fx, {
        userText: '确认，写入这两条',
        task: '用户已确认，提交刚才的写入提案',
        operation: 'dummy.commit',
        args: COMMIT_ARGS,
        report: commitReport,
      });
      expect(turn2.executions.map((execution) => execution.status)).toEqual(['refused']);
      // 2026-11-19 模型可见面收口：refused 投影不带原始码/原文（CONFIRMATION_EXPIRED 与
      // 'expired' 原文只进底账与日志）；模型只见 kind + note。底账执行事实仍是 refused。
      expect(turn2.executions.map((execution) => execution.status)).toEqual(['refused']);
      const refused = fx.worker.toolResults[fx.worker.toolResults.length - 1] as {
        status?: string;
        kind?: string;
        error?: unknown;
      };
      expect(refused.status).toBe('refused');
      expect(refused.error).toBeUndefined();
      expect(refused.kind).toBe('executor_failed');
      expect((await queryData(fx.stateDir)).count).toBe(2);
    } finally {
      fx.close();
    }
  });

  it('6 关闭开关（缺省）：write op 不在允许集，写请求确定性拒绝、零写入', async () => {
    const fx = await createHostFixture({ dir: tempDir('host-wc-switch-off-') });
    try {
      fx.worker.push({
        calls: [{ tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.prepare', args: PREPARE_ARGS } }],
        text: '不应执行。',
      });
      fx.main.push({
        calls: [{ tool: TASK_RUN_TOOL, args: { task: '在 alpha 集合新增两条记录' } }],
        text: (_results, toolError) => `拒绝：${toolError ?? ''}`,
      });
      const turn = await fx.session.send('帮我在 alpha 集合里新增两条记录');
      // 拒绝来自宿主允许集合（发起执行前），不是模型自觉。
      expect(fx.worker.toolErrors).toHaveLength(1);
      expect(fx.worker.toolErrors[0]).toContain(WRITE_NOT_ALLOWED_MESSAGE);
      expect(turn.executions).toHaveLength(0);
      expect(executionsOf(fx.session.tasks()[0]!)).toEqual([]);
      expect((await queryData(fx.stateDir)).count).toBe(2);
      // 审计里没有任何写 operation 行（零执行）。
      expect(auditLines(fx.stateDir).filter((line) => line.includes('"dummy.prepare"'))).toHaveLength(0);

      // 装配事实：缺省只读允许集；显式开关打开后写面才进入允许集合（只读集合不变）。
      const config = materializedConfig(fx.stateDir);
      const profile = config.contextProfiles['dummy'];
      if (profile === undefined) throw new Error('fixture 配置缺少 dummy contextProfile');
      const defaultFace = await resolveExecutionFace({
        profile,
        env: baseEnv(),
        stateDir: fx.stateDir,
        emptyOperationsMessage: '（测试）空允许集合',
      });
      expect(defaultFace.allowedOperations).toEqual(defaultFace.readOnlyOperations);
      for (const operation of WRITE_OPERATIONS) {
        expect(defaultFace.allowedOperations).not.toContain(operation);
        expect(defaultFace.readOnlyOperations).not.toContain(operation);
      }
      const writeFace = await resolveExecutionFace({
        profile,
        env: baseEnv(),
        stateDir: fx.stateDir,
        emptyOperationsMessage: '（测试）空允许集合',
        allowWriteOperations: true,
        allowedPermissions: ['read', 'write'],
      });
      expect(writeFace.allowedOperations).toEqual([...writeFace.readOnlyOperations, ...WRITE_OPERATIONS]);
    } finally {
      fx.close();
    }
  });

  it('7 读回不一致：执行层返回 failed/readback short，宿主如实呈现失败，不输出成功话术', async () => {
    const fx = await createHostFixture({
      dir: tempDir('host-wc-readback-'),
      allowWrite: true,
      confirmationConfig: { readbackShort: true },
    });
    try {
      await runWriteTurn(fx, {
        userText: '帮我在 alpha 集合里新增两条记录',
        task: '在 alpha 集合新增两条记录',
        operation: 'dummy.prepare',
        args: PREPARE_ARGS,
        report: prepareReport,
      });
      const turn2 = await runWriteTurn(fx, {
        userText: '确认，写入这两条',
        task: '用户已确认，提交刚才的写入提案',
        operation: 'dummy.commit',
        args: COMMIT_ARGS,
        report: commitReport,
      });
      // 执行层如实返回 failed（读回 1/2）；宿主不得把它变成 completed。
      // 2026-11-19 模型可见面收口：failed 投影不带原始码（CONFIRMATION_READBACK_SHORT
      // 只进底账 execution.error 与日志），模型只见 kind + note（表外码 → executor_failed）。
      const committed = fx.worker.toolResults[fx.worker.toolResults.length - 1] as {
        status?: string;
        kind?: string;
        error?: unknown;
      };
      expect(committed.status).toBe('failed');
      expect(committed.error).toBeUndefined();
      expect(committed.kind).toBe('executor_failed');
      expect(turn2.executions.map((execution) => execution.status)).toEqual(['failed']);
      // 用户可见回复来自执行事实：失败/待核对，不含成功话术。
      expect(turn2.reply).toContain('失败');
      expect(turn2.reply).not.toContain('成功');
      expect(turn2.reply).not.toContain('已完成');
      const commitTask = fx.session.tasks().find((task) => task.executions.some((execution) => execution.operation === 'dummy.commit'));
      expect(commitTask).toBeDefined();
      expect(['failed', 'refused']).toContain(lastExecutionOf(commitTask!)?.status);
      expect(lastFailureOf(commitTask!)?.error?.message).toMatch(/readback short/i);
      const commitExecution = commitTask?.executions.find((execution) => execution.operation === 'dummy.commit');
      expect(commitExecution?.status).toBe('failed');
      expect(commitExecution?.error?.code).toBe('CONFIRMATION_READBACK_SHORT');
      // 数据事实：只写了 1 条（读回不一致的现场），不是谎报的 2 条。
      expect((await queryData(fx.stateDir)).count).toBe(3);
    } finally {
      fx.close();
    }
  });

  it('边界：同一回合内 prepare 后立刻 commit 不执行（提案等用户下一回合表态；A2 同回合拒）', async () => {
    const fx = await createHostFixture({ dir: tempDir('host-wc-same-turn-'), allowWrite: true, captureRequests: true });
    try {
      // 一个回合里连续两次执行调用：prepare 发了句柄，紧接着 commit——宿主不得在同回合透传。
      // 2026-11-18 A2 收紧：旧纪律只挡句柄透传（同回合 commit 仍打到执行层的
      // CONFIRMATION_NOT_FOUND，live 实测单任务 15 次 operation）；现在同一回合内再发起
      // 非只读 operation 一律在**发起前**拒绝——不发起执行、不落执行事实。
      fx.worker.push({
        calls: [
          { tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.prepare', args: PREPARE_ARGS } },
          { tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.commit', args: COMMIT_ARGS } },
        ],
        text: commitReport,
      });
      fx.main.push({ calls: [{ tool: TASK_RUN_TOOL, args: { task: '在 alpha 集合新增两条记录' } }], text: mainRelay });
      const turn = await fx.session.send('帮我在 alpha 集合里新增两条记录');
      // 只有 prepare 到达执行层；同回合 commit 被宿主在发起前拒收（零执行、零执行事实）。
      expect(fx.requests).toHaveLength(1);
      expect(fx.requests[0]!.operation).toBe('dummy.prepare');
      expect(fx.requests[0]!.confirmation).toBeUndefined();
      // 工具错误如实告知模型：提案已生成，等用户下一回合表态。
      expect(fx.worker.toolErrors).toHaveLength(1);
      expect(fx.worker.toolErrors[0]).toContain('提案');
      expect(fx.worker.toolErrors[0]).toContain('下一回合');
      expect(turn.executions.map((execution) => execution.status)).toEqual(['needs_confirmation']);
      expect((await queryData(fx.stateDir)).count).toBe(2);
    } finally {
      fx.close();
    }
  });
});
