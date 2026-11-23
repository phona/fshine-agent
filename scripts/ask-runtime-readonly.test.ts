/**
 * P1 反向绊线：执行面的「只读集合」必须是显式派生的 `access=read` 集合，不能是
 * 允许集合 `allowedOperations` 的影子。
 *
 * 绊线设计（故意破坏必须红）：
 *   把 `scripts/ask-runtime.ts` 里 createSession/createTaskExecutor 的
 *   `readOnlyOperations: face.readOnlyOperations` 改回 `face.allowedOperations`，
 *   本文件的「写操作在恢复窗口内重试」用例会变成 2 次真实执行 → 红。
 * 同时钉住缺省执行面确实从 operation 的 access 声明派生只读集合（写操作不在其中）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import type {
  DriverMessage,
  RuntimeTurnEvent,
  TurnDriver,
  TurnDriverInput,
  TurnDriverResult,
} from '../packages/agent/src/driver-contract';
import { EXECUTE_OPERATION_TOOL, TASK_RUN_TOOL } from '../packages/agent/src/execution-runtime';
import { createTaskRegistry } from '../packages/agent/src/task-registry';
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskMayBeRunningOf, taskReportedOf, taskUnstartedOf, taskWaitingOf } from '../packages/agent/testing/task-facts';
import { assembleSessionCore, resolveExecutionFace } from './ask-runtime';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

const MANIFEST: CapabilityManifest = {
  contractVersion: 2,
  operations: [
    { name: 'dummy.query', label: 'query', args: [{ name: '--collection', required: true }] },
    { name: 'dummy.commit', label: 'commit', args: [{ name: '--collection', required: true }] },
  ],
};

type Action =
  | { kind: 'event'; event: RuntimeTurnEvent }
  | { kind: 'tool'; tool: string; args: Record<string, unknown> }
  | { kind: 'text'; text: string };

class ScriptedDriver implements TurnDriver {
  runs = 0;
  constructor(private readonly actions: readonly Action[]) {}

  async run(input: TurnDriverInput): Promise<TurnDriverResult> {
    this.runs += 1;
    let text = '';
    for (const action of this.actions) {
      if (action.kind === 'event') {
        input.onRuntimeEvent?.(action.event);
        continue;
      }
      if (action.kind === 'tool') {
        try {
          await input.exec(action.tool, action.args);
        } catch {
          return { text, messages: [...input.messages] as DriverMessage[] };
        }
        continue;
      }
      text = action.text;
    }
    return { text, messages: [...input.messages] as DriverMessage[] };
  }
}

class RecordingClient implements ExecutionClient {
  readonly requests: ExecutionRequest[] = [];

  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push(request);
    return { status: 'completed', data: { ok: true } };
  }
}

const END: Action = { kind: 'event', event: { kind: 'assistant_end' } };
const RETRY: Action = { kind: 'event', event: { kind: 'recovery', reason: 'compaction' } };
const commitTool: Action = {
  kind: 'tool',
  tool: EXECUTE_OPERATION_TOOL,
  args: { operation: 'dummy.commit', args: { '--collection': 'docs' } },
};

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('P1 只读集合显式派生（不是 allowedOperations 的影子）', () => {
  it('写操作进入允许集合时，恢复窗口内的写重试只回放、不二次执行', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ask-runtime-readonly-'));
    tempDirs.push(dir);
    const client = new RecordingClient();
    const registry = createTaskRegistry();
    const main = new ScriptedDriver([
      END,
      { kind: 'tool', tool: TASK_RUN_TOOL, args: { task: '提交 docs' } },
      { kind: 'text', text: '已提交。' },
    ]);
    const worker = new ScriptedDriver([
      END,
      commitTool,
      // 运行时丢弃尝试后重试：重试响应重发同一写操作。
      RETRY,
      END,
      commitTool,
      { kind: 'text', text: '已提交。' },
    ]);

    const assembled = await assembleSessionCore({
      env: {},
      profile: { root: dir, skillRoots: [], gateway: 'bin/dummy' },
      principalId: 'wecom:p1',
      sessionId: 'sess_p1_readonly',
      dbPath: path.join(dir, 'unused.db'),
      stateDir: dir,
      emptyOperationsMessage: '空允许集合',
      // 写操作进入允许集合：operator 角色（read+write）+ 部署总闸打开。
      allowedPermissions: ['read', 'write'],
      runtime: { allowWriteOperations: true },
      mainSystemPrompt: '主 Agent',
      workerSkills: [],
      taskRegistry: registry,
      createDrivers: () => ({ mainDriver: main, workerDriver: worker }),
      createExecutionFace: async () => ({
        client,
        // 写操作在允许集合里；只读集合只含 query。
        allowedOperations: ['dummy.query', 'dummy.commit'],
        readOnlyOperations: ['dummy.query'],
      }),
    });

    try {
      const result = await assembled.session.send('提交 docs');
      expect(client.requests).toHaveLength(1);
      expect(client.requests[0]!.operation).toBe('dummy.commit');
      expect(result.reply).not.toContain('待核对');
      expect(assembled.taskRegistry.list()).toHaveLength(1);
      expect(lastExecutionOf(assembled.taskRegistry.list()[0]!)?.status).toBe('completed');
    } finally {
      assembled.close();
    }
  });

  it('缺省执行面从 access=read 派生只读集合：写操作不在只读集合里', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ask-runtime-face-'));
    tempDirs.push(dir);
    const face = await resolveExecutionFace({
      profile: { root: FIXTURE_ROOT, skillRoots: [], gateway: 'bin/dummy' },
      env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] },
      stateDir: dir,
      emptyOperationsMessage: '空允许集合',
    });
    expect(face.readOnlyOperations).toContain('dummy.query');
    expect(face.readOnlyOperations).not.toContain('dummy.commit');
    expect(face.readOnlyOperations).not.toContain('dummy.prepare');
  });
});
