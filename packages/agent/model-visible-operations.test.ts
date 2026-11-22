/**
 * 模型可见面收口（2026-11-19，owner live 实测：模型走历史提案协议把写任务判死）。
 *
 * 背景（live 15:13）：写操作本该 prepare（返回提案）→ 用户确认 → commit；但模型仍能看到
 * 历史协议 `dummy.proposal` / `dummy.proposal-commit`（要模型自己造载荷文件），于是它去用
 * 那条路：proposal → completed、proposal-commit → failed PROPOSAL_TOKEN_UNTRUSTED ×2，
 * 把整个有提案的回合判成 failed——用户既没拿到提案、也没法确认。
 *
 * 本切片两件（都要）：
 *   A. 能力面过滤（结构性根治）：执行层声明 `model_visible:false` 的 operation 不进模型
 *      可见面——workerManifest 过滤掉，**允许集合也剔除**（模型凭记忆硬调 → 发起前确定性
 *      拒绝，走 OPERATION_NOT_PERMITTED_MESSAGE、零执行事实、不提 operation 名）。
 *   B. 判据兜底（就算漏进来看错也不判死）：同回合存在提案时，「同回合没法自己确认」
 *      （CONFIRMATION_REQUIRED）与「历史协议用法错」（PROPOSAL_* / CALL_REFUSE）都不算真
 *      失败——有提案、且所有失败都是这两类 → 判 needs_confirmation（真句柄 + 摘要）。
 *
 * 反向绊线：去掉 A 的过滤 → ① 红；去掉 B 的码集合 → ④ 红（详见各用例注释）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from './src/driver-contract';
import {
  createTaskExecutor,
  OPERATION_NOT_PERMITTED_MESSAGE,
  EXECUTE_OPERATION_TOOL,
} from './src/execution-runtime';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import type { TaskRegistry } from './src/task-registry';
import { createTaskRunner, type TaskExecutor } from './src/task-runner';
import { createResourcePolicy } from './src/resource-policy';

const SCOPE = { principalId: 'wecom:mvis', sessionId: 'conv-mvis' };
const SUMMARY = 'alpha 集合 2 条记录将被覆盖，不可撤销';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeRegistry(): TaskRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'mvis-'));
  tempDirs.push(dir);
  return createSqliteTaskRegistry(join(dir, 'state.db'));
}

interface Capture {
  delegation?: string;
  results: unknown[];
  errors: string[];
}

function textOf(message: DriverMessage): string {
  return String((message as { content?: unknown }).content ?? '');
}

/** Worker：记录委派原文（manifest 投影面），按脚本逐条调 execute_operation（错误也留住）。 */
function callingWorker(calls: ReadonlyArray<Record<string, unknown>>, capture: Capture): TurnDriver {
  return {
    async run(input) {
      const first = input.messages.find((message) => message.role === 'user');
      if (first !== undefined) capture.delegation = textOf(first);
      for (const args of calls) {
        try {
          capture.results.push(await input.exec(EXECUTE_OPERATION_TOOL, args));
        } catch (error) {
          capture.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return { text: '已按执行层回执汇报。', messages: [] as unknown as DriverMessage[] };
    },
  };
}

// ── A. 能力面过滤 ───────────────────────────────────────────────────────────
const A_MANIFEST: CapabilityManifest = {
  contractVersion: 4,
  operations: [
    { name: 'dummy.query', label: 'query', args: [] },
    { name: 'dummy.prepare', label: 'prepare', args: [] },
    { name: 'dummy.commit', label: 'commit', args: [] },
    { name: 'dummy.proposal', label: 'proposal', args: [], model_visible: false },
    { name: 'dummy.proposal-commit', label: 'proposal-commit', args: [], model_visible: false },
  ],
};

class RecordingClient implements ExecutionClient {
  readonly requests: string[] = [];
  async capabilities(): Promise<CapabilityManifest> {
    return A_MANIFEST;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push(request.operation);
    if (request.operation === 'dummy.prepare') {
      return { status: 'needs_confirmation', confirmation: { handle: 'cf_mvis', summary: SUMMARY }, data: {} };
    }
    return { status: 'completed', data: {} };
  }
}

const PROPOSAL_ARGS = { operation: 'dummy.proposal', args: {} };

async function aExecutor(client: ExecutionClient, registry: TaskRegistry, worker: TurnDriver): Promise<TaskExecutor> {
  return createTaskExecutor({
    client,
    // 允许集合故意带上 proposal 类：宿主必须自己再收一次（只过滤 manifest 不够）。
    allowedOperations: ['dummy.query', 'dummy.prepare', 'dummy.commit', 'dummy.proposal', 'dummy.proposal-commit'],
    readOnlyOperations: ['dummy.query'],
    workerDriver: worker,
    registry,
    workerTurnMs: 30_000,
  });
}

async function runExecutor(executor: TaskExecutor, registry: TaskRegistry, taskId: string, request: string) {
  registry.begin({ taskId, principalId: SCOPE.principalId, sessionId: SCOPE.sessionId, request });
  return executor.execute(
    { taskId, request, principalId: SCOPE.principalId, sessionId: SCOPE.sessionId },
    { signal: new AbortController().signal },
  );
}

describe('A. 模型可见面过滤：model_visible:false 的 operation 不进能力面、也不在允许集合', () => {
  it('① worker 委派清单里没有 proposal 类 operation（反向绊线：去掉过滤 → 本用例红）', async () => {
    const registry = makeRegistry();
    const capture: Capture = { results: [], errors: [] };
    const executor = await aExecutor(new RecordingClient(), registry, callingWorker([], capture));
    await runExecutor(executor, registry, 't_mvis_1', '把 alpha 集合追加两条记录');

    // 委派清单（renderWorkerDelegation 的实际产物）里没有任何 proposal 类 operation。
    // 注意 'dummy.proposal-commit' 含子串 'dummy.proposal'——一句断言同时盖住两者。
    expect(capture.delegation).toBeDefined();
    expect(capture.delegation).not.toContain('dummy.proposal');
  });

  it('② 模型硬调 dummy.proposal：发起前被确定性拒绝、零执行事实、话术不含内部名', async () => {
    const client = new RecordingClient();
    const registry = makeRegistry();
    const capture: Capture = { results: [], errors: [] };
    const executor = await aExecutor(client, registry, callingWorker([PROPOSAL_ARGS], capture));

    const outcome = await runExecutor(executor, registry, 't_mvis_2', '把 alpha 集合追加两条记录');

    // 宿主确定性拒绝：话术是统一常量、绝不出现内部 operation 名。
    expect(capture.errors).toHaveLength(1);
    expect(capture.errors[0]).toBe(OPERATION_NOT_PERMITTED_MESSAGE);
    expect(capture.errors[0]).not.toContain('dummy.proposal');
    // 零执行事实：执行层一次都没被调用。
    expect(client.requests).toEqual([]);
    // 回合结局指向权限，不是「模型没干活」。
    expect(outcome).toMatchObject({ kind: 'ended', zeroExecReason: 'not_permitted' });
  });

  it('③ 其它写操作（prepare/commit）仍在委派清单里（只藏历史协议，不误伤正常写面）', async () => {
    const registry = makeRegistry();
    const capture: Capture = { results: [], errors: [] };
    const executor = await aExecutor(new RecordingClient(), registry, callingWorker([], capture));
    await runExecutor(executor, registry, 't_mvis_3', '把 alpha 集合追加两条记录');

    expect(capture.delegation).toContain('dummy.prepare');
    expect(capture.delegation).toContain('dummy.commit');
    expect(capture.delegation).toContain('dummy.query');
  });
});

// ── B. 判据兜底 ─────────────────────────────────────────────────────────────
const B_MANIFEST: CapabilityManifest = {
  contractVersion: 4,
  operations: [
    { name: 'dummy.query', label: 'query', args: [] },
    { name: 'dummy.prepare', label: 'prepare', args: [] },
    { name: 'dummy.proposal', label: 'proposal', args: [] },
    { name: 'dummy.proposal-commit', label: 'proposal-commit', args: [] },
    { name: 'dummy.denied', label: 'denied', args: [] },
  ],
};

/** 执行层镜像 live 序列：prepare 出提案；proposal 完成；proposal-commit 历史协议用法错。 */
class LiveSequenceClient implements ExecutionClient {
  readonly requests: string[] = [];
  async capabilities(): Promise<CapabilityManifest> {
    return B_MANIFEST;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push(request.operation);
    switch (request.operation) {
      case 'dummy.prepare':
        return { status: 'needs_confirmation', confirmation: { handle: 'cf_live', summary: SUMMARY }, data: { collection: 'alpha' } };
      case 'dummy.proposal':
        return { status: 'completed', data: { proposalId: 'prop_live' } };
      case 'dummy.proposal-commit':
        return { status: 'failed', error: { code: 'PROPOSAL_TOKEN_UNTRUSTED', message: 'Token does not match or has expired' } };
      case 'dummy.denied':
        return { status: 'refused', error: { code: 'GATE_REFUSE', message: 'denied' } };
      default:
        return { status: 'completed', data: {} };
    }
  }
}

const PREPARE_ARGS = { operation: 'dummy.prepare', args: { '--collection': 'alpha' } };
const B_PROPOSAL_ARGS = { operation: 'dummy.proposal', args: {} };
const PROPOSAL_COMMIT_ARGS = { operation: 'dummy.proposal-commit', args: { '--proposal-id': 'prop_live' } };
const DENIED_ARGS = { operation: 'dummy.denied', args: {} };

function bExecutor(client: ExecutionClient, registry: TaskRegistry, worker: TurnDriver): Promise<TaskExecutor> {
  return createTaskExecutor({
    client,
    allowedOperations: ['dummy.query', 'dummy.prepare', 'dummy.proposal', 'dummy.proposal-commit', 'dummy.denied'],
    readOnlyOperations: ['dummy.query'],
    workerDriver: worker,
    registry,
    workerTurnMs: 30_000,
  });
}

/** 后台跑完一轮（受理 + pump + 收口），返回底账任务行。 */
async function runBackground(
  registry: TaskRegistry,
  executor: TaskExecutor,
  taskId: string,
  request: string,
): Promise<ReturnType<TaskRegistry['get']>> {
  const runner = createTaskRunner({ registry, policy: createResourcePolicy(), executor, leaseMs: 60_000 });
  runner.submit({ taskId, principalId: SCOPE.principalId, sessionId: SCOPE.sessionId, request });
  runner.pump();
  await runner.whenIdle();
  return registry.get(taskId, SCOPE);
}

describe('B. 判据兜底：有提案、且所有失败都是「同回合没法确认/历史协议用法错」→ 不判死', () => {
  it('④ 同回合 prepare → proposal → proposal-commit 失败 ×2 → 任务 waiting_user 且有提案（去掉 B → 本用例红）', async () => {
    const registry = makeRegistry();
    const capture: Capture = { results: [], errors: [] };
    const client = new LiveSequenceClient();
    const executor = await bExecutor(
      client,
      registry,
      // 复刻 live：proposal 完成、proposal-commit 失败两次（模型误用历史协议）。
      callingWorker([PREPARE_ARGS, B_PROPOSAL_ARGS, PROPOSAL_COMMIT_ARGS, PROPOSAL_COMMIT_ARGS], capture),
    );

    const task = await runBackground(registry, executor, 't_live_seq', '给 alpha 集合 W1 追加 2 条记录');

    // 有提案、且所有失败都是「历史协议用法错」→ 底账落等待事实（pendingQuestion），不判死。
    expect(task.pendingQuestion).toBeDefined();
    expect(task.pendingQuestion?.confirmation?.summary).toBe(SUMMARY);
    expect(task.pendingQuestion?.confirmation?.handle).toBe('cf_live');
    // 四次都真的打到执行层（宿主不预先拦，只是结局归类改了）。
    expect(client.requests).toEqual(['dummy.prepare', 'dummy.proposal', 'dummy.proposal-commit', 'dummy.proposal-commit']);
  });

  it('⑤ 同回合 prepare → GATE_REFUSE → 仍 failed（真失败不许被掩盖）', async () => {
    const registry = makeRegistry();
    const capture: Capture = { results: [], errors: [] };
    const executor = await bExecutor(new LiveSequenceClient(), registry, callingWorker([PREPARE_ARGS, DENIED_ARGS], capture));

    const task = await runBackground(registry, executor, 't_real_fail', '给 alpha 集合 W1 追加 2 条记录');

    // 真失败不落等待事实：执行账留有执行层拒绝行（底账无 status，读执行行）。
    expect(task.executions.map((execution) => execution.status)).toContain('refused');
    expect(task.pendingQuestion).toBeUndefined();
  });
});
