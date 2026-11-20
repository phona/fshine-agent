/**
 * S3 确认回合·「本次任务 = 已确认提案载荷原文」三条守卫（2026-11-20）。
 *
 * 根因（live 真机实测）：写确认续跑回合，模型拿的是**最早那份交办原文**里的旧值
 * （用户原话 b=2，已确认写进提案的是 b=9），13/14 个续跑回合先重跑 prepare 而不是 commit。
 * 修法：确认续跑的任务内容切成已确认提案的载荷原文（宿主逐字持有），原交办 prose 不进
 * 这次委派；Worker 直接对已确认提案提交。
 *
 * 三条守卫：
 *   ① 构造 pendingConfirmation(args 含 b=9) + 原始交办 prose(含 b=2) → 委派文本出现已确认值
 *      b=9（逐字）、不出现旧值 b=2（逐字），且无「重新生成提案 / 先 prepare」指令；
 *   ② 确认回合的 Worker 工具调用面允许直接 commit（fake driver 断言调用序列里第一个写操作
 *      是 commit、不是 prepare，且载荷 b=9 原样到达执行层）；
 *   ③ 反向：把任务内容换回原交办 prose → ① 的断言必红（本文件末尾用 renderWorkerDelegation
 *      直接演示原 prose 仍带 b=2）。
 *
 * 判据走真装配的委派渲染 / 执行器路径（createTaskExecutor + fake driver + 内存 registry），
 * 零网络、零外部平台。注：守卫断言的是「委派文本」与「工具调用序列」——正是本次修法改变的
 * 面；执行器终态由 U3 claim 账决定，与这两条守卫无关，不在本文件断言。
 */
import { describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver, TurnDriverInput, TurnDriverResult } from './src/driver-contract';
import {
  createTaskExecutor,
  EXECUTE_OPERATION_TOOL,
  renderConfirmationResumeFact,
  renderWorkerDelegation,
} from './src/execution-runtime';
import { createTaskRegistry } from './src/task-registry';
import type { TaskExecutionInput } from './src/task-runner';

// ── 夹具 ──────────────────────────────────────────────────────────────────────

const SCOPE = { principalId: 'wecom:s3-guard', sessionId: 'conv-s3-guard' };

const MANIFEST: CapabilityManifest = {
  contractVersion: 2,
  operations: [
    { name: 'dummy.prepare', label: 'prepare', args: [{ name: '--collection', required: true }, { name: 'a', required: true }, { name: 'b', required: true }, { name: 'c', required: true }] },
    { name: 'dummy.commit', label: 'commit', args: [{ name: '--collection', required: true }, { name: 'a', required: true }, { name: 'b', required: true }, { name: 'c', required: true }] },
  ],
};

/** 已确认提案的载荷（b=9），与原始交办 prose 的旧值（b=2）对照。 */
const CONFIRMED_ARGS: Record<string, unknown> = {
  '--collection': 'empty-one',
  a: 1,
  b: 9,
  c: 3,
};
const ORIGINAL_PROSE = '往 empty-one 的 W1 加 3 条，a=1/b=2/c=3';
const CONFIRMED_SUMMARY = '将向集合「empty-one」的 W1 窗口新增 3 条记录：a=1、b=9、c=3';

/** 执行层：记录每次到达的请求；prepare 发提案、commit 完成（谁先到就答谁，用来断言调用序列）。 */
class RecordingClient implements ExecutionClient {
  readonly requests: ExecutionRequest[] = [];
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push(request);
    if (request.operation === 'dummy.prepare') {
      return {
        status: 'needs_confirmation',
        confirmation: { handle: 'cf_s3_guard', summary: CONFIRMED_SUMMARY },
      };
    }
    return { status: 'completed', data: { ok: true } };
  }
}

interface Capture {
  delegation?: string;
  /** Worker 实际发起的工具调用（按序）。 */
  calls: Array<{ tool: string; operation?: string; args: Record<string, unknown> }>;
}

/** fake Worker：捕获委派与工具调用，然后直接对已确认提案发 commit（不 prepare）。 */
function commitWorker(capture: Capture): TurnDriver {
  return {
    async run(input: TurnDriverInput): Promise<TurnDriverResult> {
      const last = input.messages[input.messages.length - 1] as unknown as { content?: unknown } | undefined;
      capture.delegation = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
      const args = JSON.parse(JSON.stringify(CONFIRMED_ARGS)) as Record<string, unknown>;
      capture.calls.push({ tool: EXECUTE_OPERATION_TOOL, operation: 'dummy.commit', args });
      await input.exec(EXECUTE_OPERATION_TOOL, { operation: 'dummy.commit', args }).catch(() => undefined);
      return { text: '已按已确认提案提交。', messages: [] as unknown as DriverMessage[] };
    },
  };
}

async function makeExecutor(worker: TurnDriver, client: ExecutionClient) {
  return createTaskExecutor({
    client,
    allowedOperations: ['dummy.prepare', 'dummy.commit'],
    readOnlyOperations: [],
    workerDriver: worker,
    registry: createTaskRegistry(),
    workerTurnMs: 30_000,
  });
}

function confirmTask(): TaskExecutionInput {
  return {
    taskId: 't_s3_guard',
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    request: ORIGINAL_PROSE,
    answer: '确认',
    pendingConfirmation: {
      handle: 'cf_s3_guard',
      summary: CONFIRMED_SUMMARY,
      operation: 'dummy.prepare',
      args: CONFIRMED_ARGS,
    },
  };
}

// ── 守卫 ──────────────────────────────────────────────────────────────────────

describe('S3 确认回合：本次任务 = 已确认提案载荷原文（原交办 prose 让位）', () => {
  it('① 委派文本出现已确认值 b=9、不出现旧值 b=2，且无「重新生成提案 / 先 prepare」指令', async () => {
    const capture: Capture = { calls: [] };
    const executor = await makeExecutor(commitWorker(capture), new RecordingClient());
    await executor.execute(confirmTask(), { signal: new AbortController().signal });
    const delegation = capture.delegation!;
    // 已确认值（b=9）逐字出现：载荷原文进了「本次任务」。
    expect(delegation).toContain('"b":9');
    expect(delegation).toContain('b=9');
    // 旧值（b=2）不出现：原交办 prose 没进这次委派（逐字断言）。
    expect(delegation).not.toContain('"b":2');
    expect(delegation).not.toContain('a=1/b=2/c=3');
    // 没有让 Worker 重新生成提案 / 先 prepare 的指令（正向提交，不含否定补丁话术）。
    expect(delegation).not.toContain('重新生成提案');
    expect(delegation).not.toContain('重新准备');
    expect(delegation).not.toContain('先 prepare');
    // 「本次任务」段正文即已确认提案载荷（不是补充说明）。
    const taskBody = delegation.split('## 本次任务\n')[1]!.split('\n\n## 可调用的操作')[0]!;
    expect(taskBody).toContain(renderConfirmationResumeFact(confirmTask().pendingConfirmation!));
  });

  it('② 确认回合的 Worker 工具调用面允许直接 commit：第一个写操作是 commit（不是 prepare）', async () => {
    const capture: Capture = { calls: [] };
    const client = new RecordingClient();
    const executor = await makeExecutor(commitWorker(capture), client);
    await executor.execute(confirmTask(), { signal: new AbortController().signal });
    // fake Worker 直接发 commit——执行器没有拦，调用序列里第一个（也是唯一）写操作就是 commit。
    expect(capture.calls[0]!.operation).toBe('dummy.commit');
    expect(capture.calls.some((c) => c.operation === 'dummy.prepare')).toBe(false);
    // 执行层收到的第一个写操作也是 commit（原样到达，不经 prepare 重写提案）。
    expect(client.requests[0]!.operation).toBe('dummy.commit');
    expect(client.requests.some((r) => r.operation === 'dummy.prepare')).toBe(false);
    // 载荷原样到达执行层：b=9，不会被旧 prose 的 b=2 覆盖。
    expect(client.requests[0]!.args['b']).toBe(9);
  });

  it('③ 反向演示：把任务内容换回原交办 prose → ① 的断言必红', () => {
    // 模拟「修法前」的委派：本次任务用原始交办 prose（这正是真模型拿到 b=2 的面）。
    const beforeFixDelegation = renderWorkerDelegation({ task: ORIGINAL_PROSE, manifest: MANIFEST });
    // 旧值 b=2 仍在（来自原交办 prose）——① 的 not.toContain('a=1/b=2/c=3') 必红。
    expect(beforeFixDelegation).toContain('a=1/b=2/c=3');
    expect(beforeFixDelegation).not.toContain('"b":9');
    // 对照：修法后的委派把任务切成已确认载荷，b=2 消失、b=9 出现。
    const afterFixDelegation = renderWorkerDelegation({
      task: renderConfirmationResumeFact(confirmTask().pendingConfirmation!),
      manifest: MANIFEST,
    });
    expect(afterFixDelegation).toContain('"b":9');
    expect(afterFixDelegation).not.toContain('a=1/b=2/c=3');
  });
});
