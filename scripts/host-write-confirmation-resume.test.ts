/**
 * 写确认续跑·载荷跟着句柄走（2026-11-19 真模型验收实跑修法）——**后台（server 同一装配）**面。
 *
 * 缺陷（实跑证据齐全）：用户确认之后，续跑的 Worker 拿不到机器可读的载荷，只能从人话摘要
 * 反推——`renderConfirmationResumeFact` 只给 `摘要：<summary>`，而摘要**最多列 10 条**
 * （执行层只列前 10 条，其余以「（其余 N 条略）」收口）；续跑的 Worker 又是新会话、没有转录。
 * 于是 Worker 只能重编 `--records`，实测审计行出现 `commit … refused=CONFIRMATION_BINDING_MISMATCH`
 * （漏条目），再试又 CONFIRMATION_REQUIRED——确认三轮、写入始终没落地、句柄全部未被消耗。
 *
 * 修法：提案被接受时把那次的参数**原文**（不透明数据）与句柄**并列落同一条底账记录**
 * （PendingConfirmation.args）；用户确认后续跑时，这份参数随委派原样交回 Worker（机器可读）。
 *
 * 本文件钉住的主形状（全部走真装配 `assembleSessionCore` + 仓内 dummy 夹具 + 后台派发）：
 *   ① 主形状：12 条记录（超过摘要 10 条截断阈值）→ 用户确认 → 续跑 Worker 按委派里的机械
 *      事实**逐字段原样**提交（与提案时的执行层请求逐字节相等）→ 写入落地、句柄被消耗、
 *      读回 12 条；
 *   ② 小载荷（1 条）路径不变；
 *   ③ 用户改口径（task_resume）：委派**不带**旧提案的载荷，旧提案作废；重新提案拿新载荷，
 *      按新载荷提交落地的是新内容；
 *   ④ 句柄过期（执行层 TTL）→ 重新提案：过期提案的载荷不得被复用（委派里没有它的调用原文），
 *      旧句柄不被消耗；新提案（新句柄）确认后写入落地；
 *   ⑤ 反向绊线：把「交回原载荷」改回「只给摘要」→ ① 必红（确认回合的 Worker 只能按人话
 *      摘要重编，摘要把 12 条截成 10 条 → CONFIRMATION_BINDING_MISMATCH，写入不落地）。
 *
 * 边界：只驱动仓内 dummy 夹具与脚本模型（零网络）；句柄一次性、绑定校验、有效期都归执行层。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { loadConfig } from '@fshine/core';
import { createDummyCliClient } from '../packages/agent/src/dummy-cli-client';
import type {
  DriverMessage,
  TurnDriver,
  TurnDriverInput,
  TurnDriverResult,
} from '../packages/agent/src/driver-contract';
import {
  EXECUTE_OPERATION_TOOL,
  renderConfirmationResumeFact,
  TASK_CONFIRM_TOOL,
  TASK_RESUME_TOOL,
  TASK_RUN_TOOL,
  type Session,
} from '../packages/agent/src/execution-runtime';
import { createSqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';
import { createFileStore } from '../packages/agent/src/file-store';
import { assembleSessionCore, resolveExecutionFace, type ExecutionFaceFactory } from './ask-runtime';
import { materializeEvalConfig } from './resolve-config-path';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');

const PRINCIPAL_ID = 'wecom:fixture-writer';
const SCOPE = { principalId: PRINCIPAL_ID, sessionId: 'sess_host_wc_resume' };

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

// ── 脚本化驱动（零网络；步骤按 send/回合顺序消费） ───────────────────────────

type ToolArgs = Record<string, unknown> | ((context: { delegation: string }) => Record<string, unknown>);

interface DriverStep {
  calls?: ReadonlyArray<{ tool: string; args: ToolArgs }>;
  text: string;
}

class ScriptedDriver implements TurnDriver {
  private readonly steps: DriverStep[] = [];
  /** 每次 run 收到的委派/提示原文（断言 Worker 看到什么）。 */
  readonly prompts: string[] = [];
  readonly toolResults: unknown[] = [];
  readonly toolErrors: string[] = [];

  push(step: DriverStep): void {
    this.steps.push(step);
  }

  async run(input: TurnDriverInput): Promise<TurnDriverResult> {
    const last = input.messages[input.messages.length - 1] as unknown as { content?: unknown } | undefined;
    const content = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    this.prompts.push(content);
    const step = this.steps.shift();
    if (step === undefined) throw new Error('（测试）没有更多驱动步骤');
    for (const call of step.calls ?? []) {
      try {
        const args = typeof call.args === 'function' ? call.args({ delegation: content }) : call.args;
        this.toolResults.push(await input.exec(call.tool, args));
      } catch (error) {
        this.toolErrors.push(error instanceof Error ? error.message : String(error));
        break;
      }
    }
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: step.text }],
      timestamp: Date.now(),
    } as unknown as DriverMessage;
    return { text: step.text, messages: [...input.messages, message] };
  }
}

// ── 装配夹具（真 assembleSessionCore + 真 dummy 执行层 + 后台派发） ──────────

interface HostFixture {
  stateDir: string;
  session: Session;
  taskRegistry: Awaited<ReturnType<typeof assembleSessionCore>>['taskRegistry'];
  runner: Awaited<ReturnType<typeof assembleSessionCore>>['runner'];
  main: ScriptedDriver;
  worker: ScriptedDriver;
  /** 宿主实际发给执行层的请求（按下发顺序；真夹具的绑定校验用同一份 args）。 */
  requests: ExecutionRequest[];
  close(): void;
}

async function createHostFixture(options: { dir: string; confirmationConfig?: Record<string, unknown> }): Promise<HostFixture> {
  const stateDir = path.join(options.dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  if (options.confirmationConfig !== undefined) {
    writeFileSync(path.join(stateDir, 'confirmation-config.json'), JSON.stringify(options.confirmationConfig));
  }
  const config = materializedConfig(options.dir);
  const profile = config.contextProfiles['dummy'];
  if (profile === undefined) throw new Error('fixture 配置缺少 dummy contextProfile');

  const main = new ScriptedDriver();
  const worker = new ScriptedDriver();
  const requests: ExecutionRequest[] = [];
  // 载荷型参数（records）需要任务文件桥：与生产装配同一条注入（fileStore 与底账 store 同一实例）。
  const taskRegistry = createSqliteTaskRegistry(path.join(options.dir, 'state.db'));
  const fileStore = createFileStore({ store: taskRegistry.store, workspaceRoot: path.join(options.dir, 'workspace') });
  // 真执行面（仓内 dummy CLI）外面包一层只做记录：请求原样向下、回执原样向上。
  const face = await resolveExecutionFace({
    profile,
    env: baseEnv(),
    stateDir,
    emptyOperationsMessage: '（测试）空允许集合',
    allowWriteOperations: true,
    allowedPermissions: ['read', 'write'],
  });
  const client: ExecutionClient = {
    capabilities: () => face.client.capabilities(),
    execute: async (request, callOptions) => {
      requests.push(request);
      return await face.client.execute(request, callOptions);
    },
  };
  const createExecutionFace: ExecutionFaceFactory = async () => ({
    client,
    allowedOperations: face.allowedOperations,
    readOnlyOperations: face.readOnlyOperations,
  });

  const assembled = await assembleSessionCore({
    env: baseEnv(),
    profile,
    principalId: PRINCIPAL_ID,
    sessionId: SCOPE.sessionId,
    dbPath: path.join(options.dir, 'state.db'),
    stateDir,
    setAuditPath: true,
    runtime: { allowWriteOperations: true, taskRunWaitMs: 0 },
    allowedPermissions: ['read', 'write'],
    emptyOperationsMessage: '（测试）空执行面',
    taskRegistry,
    taskExecutionBridge: { store: fileStore },
    mainSystemPrompt: '你是测试主 Agent。',
    workerSkills: [],
    createDrivers: async () => ({ mainDriver: main, workerDriver: worker }),
    createExecutionFace,
    // 后台派发：与 server（`npm start` / eval:write-loop）同一语义——确认句柄走底账记录。
    taskDispatch: 'async',
  });
  return {
    stateDir,
    session: assembled.session,
    taskRegistry: assembled.taskRegistry,
    runner: assembled.runner,
    main,
    worker,
    requests,
    close: () => {
      assembled.close();
      taskRegistry.close();
    },
  };
}

/** 一次 send：Main 交办（后台受理）并等后台回合落定。 */
async function sendTurn(fx: HostFixture, userText: string): Promise<Awaited<ReturnType<Session['send']>>> {
  const turn = await fx.session.send(userText);
  await fx.runner?.whenIdle();
  return turn;
}

// ── 脚本模型·确认续跑回合的诚实读法（绊线即在此） ────────────────────────────

interface ResumedCall {
  operation: string;
  args: Record<string, unknown>;
  /** 载荷来源：'fact' = 委派里的机械事实（修法后）；'summary' = 只能从人话摘要重编（修法前）。 */
  source: 'fact' | 'summary';
}

/** 从委派里取「提案时的调用参数原文」（renderConfirmationResumeFact 的 JSON 行）。2026-11-20 起不带 operation 名（只 {"args":…}）。 */
function proposalFactOf(delegation: string): { operation?: string; args?: Record<string, unknown> } | undefined {
  const line = delegation.split('\n').find((candidate) => candidate.trim().startsWith('{"args":'));
  if (line === undefined) return undefined;
  try {
    return JSON.parse(line.trim()) as { args?: Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/**
 * 确认续跑回合的调用（模型视角）：有机械事实就**逐字段原样照抄**，用清单里的提交 operation
 * 提交；没有事实时退化成「只能从人话摘要重编」——摘要最多列 10 条（其余写「（其余 N 条略）」），
 * 按它重编正是真模型实跑走出的错法（漏条目 → 执行层 CONFIRMATION_BINDING_MISMATCH）。
 */
function resumedCommitCall(delegation: string): { operation: string; args: Record<string, unknown> } {
  const fact = proposalFactOf(delegation);
  if (fact?.args !== undefined) {
    return { operation: 'dummy.commit', args: fact.args };
  }
  const summary = /摘要：([^。]*)。/.exec(delegation)?.[1] ?? '';
  const head = /将向集合「([^」]+)」的 (\S+) 窗口新增记录/.exec(summary);
  const collection = head?.[1] ?? '';
  const windowCode = head?.[2] ?? '';
  // 摘要最多列 10 条，其余以「……（其余 N 条略）」收口——按它重编必然漏条目。
  const listed = /条：([^；]*)；/.exec(summary)?.[1] ?? '';
  const records = listed
    .split('、')
    .map((entry) => entry.replace(/……（其余[^）]*）$/, '').trim())
    .flatMap((entry) => {
      const match = /^([^=]+)=(\d+(?:\.\d+)?)$/.exec(entry);
      return match === null ? [] : [{ name: match[1], value: Number(match[2]) }];
    });
  return {
    operation: 'dummy.commit',
    args: {
      '--collection': collection,
      '--window': windowCode,
      ...(records.length === 0 ? {} : { records }),
    },
  };
}

// ── 执行层直连探针 / 事实读取（不经宿主） ────────────────────────────────────

const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

interface ConfirmationRecord {
  handle: string;
  collection: string;
  window: string;
  count: number;
  expiresAt: string;
  usedAt?: string | null;
}

function confirmationsOf(stateDir: string): Record<string, ConfirmationRecord> {
  const file = path.join(stateDir, 'confirmations.json');
  if (!existsSync(file)) return {};
  const store = JSON.parse(readFileSync(file, 'utf8')) as { confirmations?: Record<string, ConfirmationRecord> };
  return store.confirmations ?? {};
}

function auditLines(stateDir: string): string[] {
  const file = path.join(stateDir, 'audit.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '') : [];
}

/** 读回（独立探针：直连执行层查询 operation，不经宿主、不经本用例的任何中间态）。 */
async function queryWindow(
  stateDir: string,
  collection: string,
  window: string,
): Promise<{ status: string; count: number; items: Array<{ name: string; value: number }> }> {
  directSequence += 1;
  const outcome = await createDummyCliClient({
    root: FIXTURE_ROOT,
    gateway: 'bin/dummy',
    stateDir,
    env: baseEnv(),
  }).execute({
    requestId: `req_wc_resume_${directSequence}`,
    dispatchKey: `dk_wc_resume_${directSequence}`,
    operation: 'dummy.query',
    args: { '--collection': collection, '--window': window },
  });
  if (outcome.status !== 'completed') throw new Error(`（测试）读回未完成：${outcome.status}`);
  const data = outcome.data as { count?: number; items?: Array<{ name: string; value: number }> };
  return { status: outcome.status, count: data.count ?? 0, items: data.items ?? [] };
}

let directSequence = 0;

function recordsOf(count: number, start = 3): Array<{ name: string; value: number }> {
  return Array.from({ length: count }, (_, index) => ({ name: `alpha-item-${start + index}`, value: 100 + index }));
}

// ── 用户话术（业务面：只说要什么，不说参数） ─────────────────────────────────

const PREPARE_12_ARGS: Record<string, unknown> = {
  '--collection': 'alpha',
  '--window': 'W1',
  records: recordsOf(12),
};
const RECORDS_12 = PREPARE_12_ARGS['records'] as Array<{ name: string; value: number }>;

const PREPARE_1_ARGS: Record<string, unknown> = {
  '--collection': 'alpha',
  '--window': 'W1',
  records: [{ name: 'alpha-item-3', value: 100 }],
};

describe('写确认续跑：提案载荷随底账记录交回 Worker（后台派发·真 dummy 夹具）', () => {
  it('① 主形状：12 条（超摘要 10 条截断阈值）→ 确认 → 续跑逐字段原样提交 → 写入落地、句柄被消耗、读回 12 条', async () => {
    const fx = await createHostFixture({ dir: tempDir('host-wc-resume-12-') });
    try {
      // 回合 1：交办 + Worker 提案（真实结构化数组）。
      fx.worker.push({
        calls: [{ tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.prepare', args: PREPARE_12_ARGS } }],
        text: '已生成待确认提案。',
      });
      fx.main.push({ calls: [{ tool: TASK_RUN_TOOL, args: { task: '在 alpha 集合 W1 窗口新增 12 条记录' } }], text: '等你确认。' });
      await sendTurn(fx, '在 alpha 集合 W1 窗口新增 12 条记录');

      // 提案落底账：摘要只列前 10 条（截断事实由执行层拥有），载荷原文与句柄并列落同一条记录。
      const taskId = fx.session.tasks()[0]!.taskId;
      const proposal = fx.taskRegistry.get(taskId, SCOPE).pendingQuestion?.confirmation;
      expect(proposal).toBeDefined();
      expect(proposal!.args).toEqual(PREPARE_12_ARGS);
      expect(proposal!.summary).toContain('其余 2 条略'); // 摘要确实被截断（只有人话时必漏 2 条）
      expect(proposal!.summary).not.toContain('alpha-item-13');
      const handle = proposal!.handle;
      // 预演不写数据；提案的那次调用的参数就是用户要的 12 条。
      expect((await queryWindow(fx.stateDir, 'alpha', 'W1')).count).toBe(2);
      expect(fx.requests).toHaveLength(1);
      const proposalArgs = JSON.parse(JSON.stringify(fx.requests[0]!.args)) as Record<string, unknown>;
      // 交回执行层的参数：records 已被宿主物化成文件路径（其余字段原样），文件内容 = 用户给的 12 条。
      expect(proposalArgs['--collection']).toBe('alpha');
      expect(proposalArgs['--window']).toBe('W1');
      expect(typeof proposalArgs['records']).toBe('string');
      expect(JSON.parse(readFileSync(proposalArgs['records'] as string, 'utf8'))).toEqual(RECORDS_12);

      // 回合 2：用户确认 → task_confirm → 后台续跑；Worker **只**按委派里的机械事实提交。
      fx.worker.push({
        calls: [{ tool: EXECUTE_OPERATION_TOOL, args: ({ delegation }) => resumedCommitCall(delegation) }],
        text: '已提交。',
      });
      fx.main.push({ calls: [{ tool: TASK_CONFIRM_TOOL, args: {} }], text: '已按你的确认提交。' });
      await sendTurn(fx, '确认');

      const delegation = fx.worker.prompts[fx.worker.prompts.length - 1]!;
      // 机械事实：JSON 行只带提案时的 args 原文（不带 operation 名，避免误导重跑 prepare）。
      const fact = proposalFactOf(delegation)!;
      expect(fact.operation).toBeUndefined();
      const factLine = delegation.split('\n').find((line) => line.trim().startsWith('{"args":'));
      expect(factLine).toBeDefined();
      expect(factLine).not.toContain('dummy.prepare'); // 事实块本身不含误导的 prepare 名（清单里有是正常的）
      expect(fact.args).toEqual(PREPARE_12_ARGS);
      // 逐字段比对提案时落底账的结构化原文（不是执行层侧的路径载体）+ 用户的 12 条原文。
      expect(fact.args).toEqual(PREPARE_12_ARGS);
      expect((fact.args!['records'] as unknown[])).toEqual(RECORDS_12);
      // 句柄不进委派文本（Worker 永远看不到凭据）。
      expect(delegation).not.toContain(handle);

      // 续跑提交到达执行层的参数与提案时**逐字节相等**（载荷原样，不经人话摘要中转）。
      expect(fx.requests).toHaveLength(2);
      expect(fx.requests[1]!.operation).toBe('dummy.commit');
      expect(JSON.stringify(fx.requests[1]!.args)).toBe(JSON.stringify(fx.requests[0]!.args));
      expect(fx.requests[1]!.confirmation).toEqual({ handle, userText: '确认' });

      // 写入落地：12 条都在、句柄被消耗、任务终态 completed。
      const after = await queryWindow(fx.stateDir, 'alpha', 'W1');
      expect(after.count).toBe(14); // seed 2 + 新增 12
      expect(after.items.slice(2).map((item) => ({ name: item.name, value: item.value }))).toEqual(RECORDS_12);
      expect(confirmationsOf(fx.stateDir)[handle]!.usedAt).toBeTruthy();
      expect(fx.taskRegistry.get(taskId, SCOPE).status).toBe('completed');
      expect(auditLines(fx.stateDir).some((line) => line.includes('CONFIRMATION_BINDING_MISMATCH'))).toBe(false);
    } finally {
      fx.close();
    }
  });

  it('② 不回归：小载荷（1 条）路径不变——同样随事实提交、写入落地', async () => {
    const dir = tempDir('host-wc-resume-1-');
    const fx = await createHostFixture({ dir });
    try {
      fx.worker.push({
        calls: [{ tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.prepare', args: PREPARE_1_ARGS } }],
        text: '已生成待确认提案。',
      });
      fx.main.push({ calls: [{ tool: TASK_RUN_TOOL, args: { task: '在 alpha 集合 W1 窗口新增 1 条记录' } }], text: '等你确认。' });
      await sendTurn(fx, '在 alpha 集合 W1 窗口新增 1 条记录');
      const taskId = fx.session.tasks()[0]!.taskId;
      const proposal = fx.taskRegistry.get(taskId, SCOPE).pendingQuestion?.confirmation;
      expect(proposal!.args).toEqual(PREPARE_1_ARGS);
      // 小载荷摘要不截断（10 条以内全列）——但事实仍随行（同一条路径，不按大小分叉）。
      expect(proposal!.summary).not.toContain('略');

      fx.worker.push({
        calls: [{ tool: EXECUTE_OPERATION_TOOL, args: ({ delegation }) => resumedCommitCall(delegation) }],
        text: '已提交。',
      });
      fx.main.push({ calls: [{ tool: TASK_CONFIRM_TOOL, args: {} }], text: '已提交。' });
      await sendTurn(fx, '确认');

      expect(proposalFactOf(fx.worker.prompts[fx.worker.prompts.length - 1]!)!.args).toEqual(PREPARE_1_ARGS);
      expect(JSON.stringify(fx.requests[1]!.args)).toBe(JSON.stringify(fx.requests[0]!.args));
      const after = await queryWindow(fx.stateDir, 'alpha', 'W1');
      expect(after.count).toBe(3);
      expect(after.items[2]).toMatchObject({ name: 'alpha-item-3', value: 100 });
      expect(fx.taskRegistry.get(taskId, SCOPE).status).toBe('completed');
    } finally {
      fx.close();
    }
  });

  it('③ 用户改口径（task_resume）：委派不带旧载荷、旧提案作废；重新提案拿新载荷并按它落地', async () => {
    const fx = await createHostFixture({ dir: tempDir('host-wc-resume-reissue-') });
    try {
      fx.worker.push({
        calls: [{ tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.prepare', args: PREPARE_12_ARGS } }],
        text: '已生成待确认提案。',
      });
      fx.main.push({ calls: [{ tool: TASK_RUN_TOOL, args: { task: '在 alpha 集合 W1 窗口新增 12 条记录' } }], text: '等你确认。' });
      await sendTurn(fx, '在 alpha 集合 W1 窗口新增 12 条记录');
      const taskId = fx.session.tasks()[0]!.taskId;
      const oldProposal = fx.taskRegistry.get(taskId, SCOPE).pendingQuestion?.confirmation!;
      const oldHandle = oldProposal.handle;

      // 回合 2：用户改口径（不是确认）→ task_resume（不带旧载荷）→ Worker 按新口径重新提案。
      const newRecords = [{ name: 'alpha-item-3', value: 7 }, { name: 'alpha-item-4', value: 8 }];
      fx.worker.push({
        calls: [{ tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.prepare', args: { '--collection': 'alpha', '--window': 'W1', records: newRecords } } }],
        text: '已按新口径重新提案。',
      });
      fx.main.push({ calls: [{ tool: TASK_RESUME_TOOL, args: { answer: '别加那 12 条了，只加 alpha-item-3=7、alpha-item-4=8' } }], text: '按新口径重新出提案了。' });
      await sendTurn(fx, '别加那 12 条了，只加 alpha-item-3=7、alpha-item-4=8');

      const resumeDelegation = fx.worker.prompts[fx.worker.prompts.length - 1]!;
      // 改口径回合的委派**不带**旧提案的调用原文（旧提案作废，值不得复用）。
      expect(resumeDelegation).toContain('别加那 12 条了');
      expect(proposalFactOf(resumeDelegation)).toBeUndefined();
      expect(resumeDelegation).not.toContain('"operation":"dummy.prepare"');

      // 旧提案作废：底账提案换新（新句柄 + 新载荷）；旧句柄未被消耗。
      const newProposal = fx.taskRegistry.get(taskId, SCOPE).pendingQuestion?.confirmation!;
      expect(newProposal.handle).not.toBe(oldHandle);
      expect(newProposal.args).toEqual({ '--collection': 'alpha', '--window': 'W1', records: newRecords });
      expect(confirmationsOf(fx.stateDir)[oldHandle]!.usedAt ?? null).toBeNull();

      // 回合 3：用户确认新提案 → 按新载荷提交、落地的是新内容。
      fx.worker.push({
        calls: [{ tool: EXECUTE_OPERATION_TOOL, args: ({ delegation }) => resumedCommitCall(delegation) }],
        text: '已提交。',
      });
      fx.main.push({ calls: [{ tool: TASK_CONFIRM_TOOL, args: {} }], text: '已提交。' });
      await sendTurn(fx, '确认');

      const confirmDelegation = fx.worker.prompts[fx.worker.prompts.length - 1]!;
      expect(proposalFactOf(confirmDelegation)!.args).toEqual(newProposal.args);
      const after = await queryWindow(fx.stateDir, 'alpha', 'W1');
      expect(after.count).toBe(4);
      expect(after.items.slice(2).map((item) => ({ name: item.name, value: item.value }))).toEqual(newRecords);
      expect(confirmationsOf(fx.stateDir)[newProposal.handle]!.usedAt).toBeTruthy();
      expect(confirmationsOf(fx.stateDir)[oldHandle]!.usedAt ?? null).toBeNull();
      expect(fx.taskRegistry.get(taskId, SCOPE).status).toBe('completed');
    } finally {
      fx.close();
    }
  });

  it('④ 句柄过期 → 重新提案：过期提案的载荷不得被复用（委派无它的调用原文），新提案确认后落地', async () => {
    // 执行层 TTL 测试面：先给 -1 秒（提案一出生就过期），重新提案前改回 15 分钟（新提案可用）。
    const fx = await createHostFixture({
      dir: tempDir('host-wc-resume-expired-'),
      confirmationConfig: { ttlSeconds: -1 },
    });
    try {
      fx.worker.push({
        calls: [{ tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.prepare', args: PREPARE_12_ARGS } }],
        text: '已生成待确认提案。',
      });
      fx.main.push({ calls: [{ tool: TASK_RUN_TOOL, args: { task: '在 alpha 集合 W1 窗口新增 12 条记录' } }], text: '等你确认。' });
      await sendTurn(fx, '在 alpha 集合 W1 窗口新增 12 条记录');
      const taskId = fx.session.tasks()[0]!.taskId;
      const expiredProposal = fx.taskRegistry.get(taskId, SCOPE).pendingQuestion?.confirmation!;
      const expiredHandle = expiredProposal.handle;
      expect(new Date(confirmationsOf(fx.stateDir)[expiredHandle]!.expiresAt).getTime()).toBeLessThanOrEqual(Date.now());

      // 过期之后的新提案要走「可用」路径（测试面把 TTL 改回正常）。
      writeFileSync(path.join(fx.stateDir, 'confirmation-config.json'), JSON.stringify({ ttlSeconds: 15 * 60 }));

      // 回合 2：用户确认 → 句柄已过期 → 接续回合让 Worker 重新生成同一提案（不带旧句柄/旧载荷）。
      fx.worker.push({
        calls: [{ tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.prepare', args: PREPARE_12_ARGS } }],
        text: '上一份提案过期，已重新生成同一提案。',
      });
      fx.main.push({ calls: [{ tool: TASK_CONFIRM_TOOL, args: {} }], text: '上一份过期了，我重新出提案。' });
      await sendTurn(fx, '确认');

      const expiredRoundDelegation = fx.worker.prompts[fx.worker.prompts.length - 1]!;
      // 过期回合只有机械指令：**没有**上一份提案的调用原文（旧载荷不得被复用）。
      expect(expiredRoundDelegation).toContain('上一份提案已过期');
      expect(proposalFactOf(expiredRoundDelegation)).toBeUndefined();
      expect(expiredRoundDelegation).not.toContain('"operation":"dummy.prepare"');
      // 旧句柄没有被消耗；新提案（新句柄）落底账。
      expect(confirmationsOf(fx.stateDir)[expiredHandle]!.usedAt ?? null).toBeNull();
      const freshProposal = fx.taskRegistry.get(taskId, SCOPE).pendingQuestion?.confirmation!;
      expect(freshProposal.handle).not.toBe(expiredHandle);
      expect(freshProposal.args).toEqual(PREPARE_12_ARGS);

      // 回合 3：用户再确认（新句柄）→ 提交落地。
      fx.worker.push({
        calls: [{ tool: EXECUTE_OPERATION_TOOL, args: ({ delegation }) => resumedCommitCall(delegation) }],
        text: '已提交。',
      });
      fx.main.push({ calls: [{ tool: TASK_CONFIRM_TOOL, args: {} }], text: '已提交。' });
      await sendTurn(fx, '确认');

      expect(proposalFactOf(fx.worker.prompts[fx.worker.prompts.length - 1]!)!.args).toEqual(PREPARE_12_ARGS);
      expect(confirmationsOf(fx.stateDir)[freshProposal.handle]!.usedAt).toBeTruthy();
      expect(confirmationsOf(fx.stateDir)[expiredHandle]!.usedAt ?? null).toBeNull();
      expect((await queryWindow(fx.stateDir, 'alpha', 'W1')).count).toBe(14);
      expect(fx.taskRegistry.get(taskId, SCOPE).status).toBe('completed');
    } finally {
      fx.close();
    }
  });
});

describe('写确认续跑·委派机械事实（纯函数面）', () => {
  it('有载荷：本次任务 = 已确认提案载荷原文（摘要 + 正向提交指令 + 参数原文 JSON，无 operation 名）；无载荷（旧记录）同样给提交指令', () => {
    const withArgs = renderConfirmationResumeFact({
      summary: '将向集合「alpha」新增 2 条',
      operation: 'dummy.prepare',
      args: { '--collection': 'alpha', records: [{ name: 'a', value: 1 }] },
    });
    // 2026-11-20（S3）：这段文本直接作为委派「本次任务」正文——正向指令、不给 prepare 线索。
    expect(withArgs).toContain('提交上一轮已确认的提案（摘要：将向集合「alpha」新增 2 条）。');
    expect(withArgs).toContain('按这些参数直接提交，不要省略或改写任何参数');
    // 正向指令：不再出现「不是重新准备 / 不要重新生成提案」这类否定话术（否定词本身是 prepare 线索）。
    expect(withArgs).not.toContain('不是重新准备');
    expect(withArgs).not.toContain('重新生成提案');
    expect(withArgs).not.toContain('dummy.prepare');
    expect(withArgs).toContain('{"args":{"--collection":"alpha","records":[{"name":"a","value":1}]}}');
    // 旧记录（无载荷）：同样给提交指令，不编造载荷。
    const noArgs = renderConfirmationResumeFact({ summary: '旧提案' });
    expect(noArgs).toBe('提交上一轮已确认的提案（摘要：旧提案）。\n按已确认的提案直接提交。');
    expect(noArgs).not.toContain('dummy.prepare');
  });
});
