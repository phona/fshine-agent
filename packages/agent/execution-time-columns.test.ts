/**
 * 执行行起止时刻（issue #69）：**后台执行器**（createTaskExecutor）路径。
 *
 * 为什么单独立文件：真实执行有三处写点（inline 委派 / Worker run_js / 后台回合），
 * 前两处各有夹具（runtime.test.ts ⑧、runtime-worker-run-js.test.ts）；后台这一处走
 * task-runner + createTaskExecutor 装配，与它们不同源——漏一处，「跑了多久」在后台
 * 任务上就永远空白，而脚本模型太听话，绿只证明剧本内正确。
 *
 * 判据：一次真实执行 → 执行行 started_at 取发起前一刻、finished_at 取回执到达一刻
 * （假时钟：执行期间系统时间前进 1200ms，两个时刻必须夹住它且互不相等）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
} from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from './src/driver-contract';
import { createTaskExecutor, EXECUTE_OPERATION_TOOL } from './src/execution-runtime';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import { createResourcePolicy } from './src/resource-policy';
import { createTaskRunner } from './src/task-runner';

const SCOPE = { principalId: 'wecom:exectime', sessionId: 'conv-exectime' };

const MANIFEST: CapabilityManifest = {
  contractVersion: 2,
  operations: [{ name: 'dummy.query', label: 'query', args: [{ name: '--collection', required: true }] }],
};

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeRegistry(): ReturnType<typeof createSqliteTaskRegistry> {
  const dir = mkdtempSync(join(tmpdir(), 'exec-time-columns-'));
  tempDirs.push(dir);
  return createSqliteTaskRegistry(join(dir, 'state.db'));
}

/** 执行期前进系统时间的执行层（只假 Date）：回执到达即 +1200ms。 */
class ClockAdvancingClient implements ExecutionClient {
  readonly requests: unknown[] = [];
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(request: unknown): Promise<ExecutionOutcome> {
    this.requests.push(request);
    vi.setSystemTime(Date.now() + 1200);
    return { status: 'completed', data: { rows: 3 } };
  }
}

/** 单轮 Worker：发起一次只读查询后收尾。 */
function singleQueryWorker(): TurnDriver {
  return {
    async run(input) {
      await input.exec(EXECUTE_OPERATION_TOOL, {
        operation: 'dummy.query',
        args: { '--collection': 'alpha' },
      });
      return { text: '已按执行层回执汇报。', messages: [] as unknown as DriverMessage[] };
    },
  };
}

describe('后台执行器：执行行起止时刻（issue #69）', () => {
  it('一次真实执行 → started_at 发起前一刻 / finished_at 回执到达一刻（假时钟夹住执行期）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T14:00:00.000Z'));
    try {
      const registry = makeRegistry();
      // createTaskExecutor 是 async（能力快照在工厂内取一次）——必须 await 出真执行器。
      const executor = await createTaskExecutor({
        client: new ClockAdvancingClient(),
        allowedOperations: ['dummy.query'],
        readOnlyOperations: ['dummy.query'],
        workerDriver: singleQueryWorker(),
        registry,
        workerTurnMs: 30_000,
      });
      const runner = createTaskRunner({ registry, policy: createResourcePolicy(), executor, leaseMs: 60_000 });
      runner.submit({
        taskId: 'task_bg_times',
        principalId: SCOPE.principalId,
        sessionId: SCOPE.sessionId,
        request: '查一下 alpha 集合',
      });
      runner.pump();
      await runner.whenIdle();

      const task = registry.get('task_bg_times', SCOPE);
      expect(task.executions).toHaveLength(1);
      expect(task.executions[0]).toMatchObject({
        operation: 'dummy.query',
        status: 'completed',
        startedAt: '2026-11-24T14:00:00.000Z',
        finishedAt: '2026-11-24T14:00:01.200Z',
      });
      expect(task.executions[0]!.startedAt).not.toBe(task.executions[0]!.finishedAt);
      registry.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
