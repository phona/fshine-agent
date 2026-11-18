/**
 * 粗粒度 RBAC（角色三档 viewer/operator/admin）· 宿主求交切片（2026-11-19）。
 *
 * 判据（用户级 / 机械读数为证）：
 *   ① viewer 调写 operation → 宿主**发起前**拒绝（零执行请求、零执行事实、任务 unexecuted），
 *      话术不含内部 operation 名；
 *   ② operator 调写 → 放行（dummy 真夹具走通 prepare，执行层返回 needs_confirmation）；
 *   ③ admin 同 operator（本切片无额外能力，但不得被挡）；
 *   ④ 未写 role 的 principal → viewer（写被拒）；
 *   ⑤ 未定义角色名 → 启动失败（config 解析用例）；
 *   ⑥ 部署总闸 runtime.allowWriteOperations=false 时，operator 也写不了；
 *   ⑦ 群主体 role: viewer → 群里写被拒（跨群/跨人隔离不回归；server 级身份派生）。
 *
 * 反向绊线（故意破坏必须红）：把 `scripts/ask-runtime.ts` 的 `narrowFaceByPermissions`
 * 改成直接返回执行层全集 → ①④⑦ 红（viewer 的写会真的发起执行）。
 *
 * 全部真装配（assembleSessionCore / createServer）+ 仓内 dummy 执行层；模型面用脚本化
 * TurnDriver（零网络、零真实凭据）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig, PrincipalConfig } from '@fshine/contracts';
import type {
  ExecutionClient,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { effectiveRoleOf, permissionsOfRole } from '@fshine/core';
import type {
  DriverMessage,
  TurnDriver,
  TurnDriverInput,
  TurnDriverResult,
} from '../packages/agent/src/driver-contract';
import {
  EXECUTE_OPERATION_TOOL,
  OPERATION_NOT_PERMITTED_MESSAGE,
  TASK_RUN_TOOL,
  type Session,
} from '../packages/agent/src/execution-runtime';
import { createTaskRegistry } from '../packages/agent/src/task-registry';
import { assembleSessionCore, resolveExecutionFace } from './ask-runtime';
import { createServer } from '../apps/server/server';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

/** 夹具声明的写 operation（access=write；dummy 执行层自述，含契约 v4 的长任务）。 */
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

function profile() {
  return { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] };
}

/** 角色表/principal 的最小 AppConfig（roles 缺省 = 内置三档）。 */
function configOf(roles: Record<string, string>): AppConfig {
  const principals: Record<string, PrincipalConfig> = {};
  for (const [principalId, role] of Object.entries(roles)) {
    principals[principalId] = role === '' ? { enabled: true } : { enabled: true, role };
  }
  return {
    principals,
    contextProfiles: { dummy: profile() },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
  };
}

// ── 脚本化驱动（零网络；步骤按 send 顺序消费） ────────────────────────────────

type ToolArgs = Record<string, unknown>;
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

  push(step: DriverStep): void {
    this.steps.push(step);
  }

  async run(input: TurnDriverInput): Promise<TurnDriverResult> {
    this.toolNames.push(input.tools.map((tool) => tool.name));
    const step = this.steps.shift();
    if (step === undefined) throw new Error('（测试）没有更多驱动步骤');
    const results: unknown[] = [];
    let toolError: string | undefined;
    for (const call of step.calls ?? []) {
      try {
        results.push(await input.exec(call.tool, call.args));
        this.toolResults.push(results[results.length - 1]);
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

// ── 装配夹具（真 assembleSessionCore + 真 dummy 执行层 + 请求录像） ─────────────

interface RbacFixture {
  stateDir: string;
  session: Session;
  main: ScriptedDriver;
  worker: ScriptedDriver;
  requests: ExecutionRequest[];
  close(): void;
}

async function createRbacFixture(input: {
  dir: string;
  principalId: string;
  permissions: readonly ('read' | 'write')[];
  allowWrite: boolean;
}): Promise<RbacFixture> {
  const stateDir = path.join(input.dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const requests: ExecutionRequest[] = [];
  const main = new ScriptedDriver();
  const worker = new ScriptedDriver();
  // 基面（读 + 总闸允许时的写）由真 dummy 执行层派生；再套一层录像客户端。
  const base = await resolveExecutionFace({
    profile: profile(),
    env: baseEnv(),
    stateDir,
    emptyOperationsMessage: '（测试）空允许集合',
    allowWriteOperations: input.allowWrite,
    allowedPermissions: ['read', 'write'],
  });
  const client: ExecutionClient = {
    capabilities: () => base.client.capabilities(),
    execute: async (request, callOptions) => {
      requests.push(request);
      return await base.client.execute(request, callOptions);
    },
  };
  const assembled = await assembleSessionCore({
    env: baseEnv(),
    profile: profile(),
    principalId: input.principalId,
    sessionId: 'sess_rbac',
    dbPath: path.join(input.dir, 'state.db'),
    stateDir,
    setAuditPath: true,
    ...(input.allowWrite ? { runtime: { allowWriteOperations: true } } : {}),
    allowedPermissions: input.permissions,
    emptyOperationsMessage: '执行层没有声明任何只读 operation——测试拒绝。',
    taskRegistry: createTaskRegistry(),
    mainSystemPrompt: '你是测试主 Agent。',
    workerSkills: [],
    createDrivers: async () => ({ mainDriver: main, workerDriver: worker }),
    createExecutionFace: async () => ({
      client,
      allowedOperations: base.allowedOperations,
      readOnlyOperations: base.readOnlyOperations,
    }),
  });
  return {
    stateDir,
    session: assembled.session,
    main,
    worker,
    requests,
    close: () => assembled.close(),
  };
}

function auditLines(stateDir: string): string[] {
  const file = path.join(stateDir, 'audit.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '') : [];
}

/** 一次「用户要求写入」的回合：Main 交办 + Worker 发一次执行调用。 */
async function runWriteTurn(fx: RbacFixture): Promise<Awaited<ReturnType<Session['send']>>> {
  fx.worker.push({
    calls: [{ tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.prepare', args: PREPARE_ARGS } }],
    text: (results, toolError) => {
      if (toolError !== undefined) return `写入未执行：${toolError}`;
      const outcome = results[0] as { status?: string };
      return `执行层返回：${outcome.status ?? 'unknown'}`;
    },
  });
  fx.main.push({
    calls: [{ tool: TASK_RUN_TOOL, args: { task: '在 alpha 集合新增两条记录' } }],
    text: (_results, toolError) => `任务结束：${toolError ?? '已交办'}`,
  });
  return await fx.session.send('帮我在 alpha 集合里新增两条记录');
}

const GATE_OPEN = true;
const GATE_CLOSED = false;

describe('RBAC·宿主求交（viewer/operator/admin）', () => {
  it('① viewer 调写：宿主发起前拒绝、零执行请求、零执行事实、话术不含 operation 名', async () => {
    const fixture = await createRbacFixture({
      dir: tempDir('rbac-viewer-'),
      principalId: 'wecom:viewer',
      permissions: ['read'],
      allowWrite: GATE_OPEN,
    });
    try {
      const turn = await runWriteTurn(fixture);
      // 零执行请求：dummy 执行层一次都没被调。
      expect(fixture.requests).toHaveLength(0);
      // 零执行事实：任务停在 unexecuted，没有任何 execution 行。
      expect(fixture.session.tasks()[0]!.status).toBe('unexecuted');
      expect(fixture.session.tasks()[0]!.executions).toHaveLength(0);
      // 话术：确定性拒绝，不暴露内部 operation 名。
      expect(fixture.worker.toolErrors).toHaveLength(1);
      expect(fixture.worker.toolErrors[0]).toContain(OPERATION_NOT_PERMITTED_MESSAGE);
      expect(fixture.worker.toolErrors[0]).not.toContain('dummy.prepare');
      expect(turn.reply).not.toContain('dummy.prepare');
      // 审计里没有任何写 operation 行（零执行）。
      expect(auditLines(fixture.stateDir).filter((line) => line.includes('dummy.prepare'))).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });

  it('② operator 调写：放行（dummy 走通 prepare，执行层返回 needs_confirmation）', async () => {
    const fixture = await createRbacFixture({
      dir: tempDir('rbac-operator-'),
      principalId: 'wecom:operator',
      permissions: ['read', 'write'],
      allowWrite: GATE_OPEN,
    });
    try {
      const turn = await runWriteTurn(fixture);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]!.operation).toBe('dummy.prepare');
      expect(turn.executions.map((execution) => execution.status)).toEqual(['needs_confirmation']);
      expect(fixture.worker.toolErrors).toHaveLength(0);
      // 预演不写数据：审计里不应有 commit 成功行。
      expect(auditLines(fixture.stateDir).filter((line) => line.includes('"dummy.commit"'))).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });

  it('③ admin 同 operator：写不被挡（本切片无额外能力）', async () => {
    const fixture = await createRbacFixture({
      dir: tempDir('rbac-admin-'),
      principalId: 'wecom:admin',
      permissions: ['read', 'write'],
      allowWrite: GATE_OPEN,
    });
    try {
      const turn = await runWriteTurn(fixture);
      expect(fixture.requests).toHaveLength(1);
      expect(turn.executions.map((execution) => execution.status)).toEqual(['needs_confirmation']);
    } finally {
      fixture.close();
    }
  });

  it('④ 未写 role 的 principal → viewer：写被拒（最小权限，不静默给写）', async () => {
    const config = configOf({ 'wecom:no-role': '' });
    expect(effectiveRoleOf(config, 'wecom:no-role')).toBe('viewer');
    const permissions = permissionsOfRole(config, effectiveRoleOf(config, 'wecom:no-role'));
    expect(permissions).toEqual(['read']);

    const fixture = await createRbacFixture({
      dir: tempDir('rbac-default-viewer-'),
      principalId: 'wecom:no-role',
      permissions,
      allowWrite: GATE_OPEN,
    });
    try {
      await runWriteTurn(fixture);
      expect(fixture.requests).toHaveLength(0);
      expect(fixture.worker.toolErrors[0]).toContain(OPERATION_NOT_PERMITTED_MESSAGE);
    } finally {
      fixture.close();
    }
  });

  it('⑥ 部署总闸关闭：operator 也写不了（角色含 write 也不放宽总闸）', async () => {
    const fixture = await createRbacFixture({
      dir: tempDir('rbac-gate-closed-'),
      principalId: 'wecom:operator',
      permissions: ['read', 'write'],
      allowWrite: GATE_CLOSED,
    });
    try {
      await runWriteTurn(fixture);
      expect(fixture.requests).toHaveLength(0);
      expect(fixture.session.tasks()[0]!.status).toBe('unexecuted');
      expect(fixture.worker.toolErrors[0]).toContain(OPERATION_NOT_PERMITTED_MESSAGE);
    } finally {
      fixture.close();
    }
  });
});

describe('RBAC·执行面求交（确定性派生）', () => {
  it('viewer / operator / admin / 总闸关闭 的允许集合', async () => {
    const stateDir = tempDir('rbac-face-');
    const face = (permissions: ('read' | 'write')[], allowWrite: boolean) => resolveExecutionFace({
      profile: profile(),
      env: baseEnv(),
      stateDir,
      emptyOperationsMessage: '空允许集合',
      allowWriteOperations: allowWrite,
      allowedPermissions: permissions,
    });

    const viewer = await face(['read'], GATE_OPEN);
    expect(viewer.allowedOperations).toEqual(viewer.readOnlyOperations);
    for (const operation of WRITE_OPERATIONS) expect(viewer.allowedOperations).not.toContain(operation);

    const operator = await face(['read', 'write'], GATE_OPEN);
    expect(operator.allowedOperations).toEqual([...operator.readOnlyOperations, ...WRITE_OPERATIONS]);

    const admin = await face(['read', 'write'], GATE_OPEN);
    expect(admin.allowedOperations).toEqual(operator.allowedOperations);

    const gateClosed = await face(['read', 'write'], GATE_CLOSED);
    expect(gateClosed.allowedOperations).toEqual(gateClosed.readOnlyOperations);
    for (const operation of WRITE_OPERATIONS) expect(gateClosed.allowedOperations).not.toContain(operation);

    // 未提供 permissions（缺省）= 只读，即便总闸打开。
    const defaulted = await resolveExecutionFace({
      profile: profile(),
      env: baseEnv(),
      stateDir,
      emptyOperationsMessage: '空允许集合',
      allowWriteOperations: GATE_OPEN,
    });
    expect(defaulted.allowedOperations).toEqual(defaulted.readOnlyOperations);
  });
});

describe('RBAC·群主体隔离（server 身份派生 + 角色）', () => {
  type ChatType = 'single' | 'group';

  function incoming(userId: string, conversationId: string, messageId: string, chatType: ChatType) {
    return {
      wecomUserId: userId,
      channel: 'wecom',
      conversationId,
      messageId,
      chatType,
      text: '给 alpha 集合 W1 追加 2 条记录',
      receivedAt: new Date().toISOString(),
    } as const;
  }

  it('⑦ 群主体 role: viewer → 群里写被拒；同一人员工人 operator 可写（跨群/跨人不串）', async () => {
    const config: AppConfig = {
      principals: {
        'wecom:user-a': { enabled: true, role: 'operator' },
        'wecom:group:group-1': { enabled: true, role: 'viewer' },
      },
      contextProfiles: { dummy: profile() },
      channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
      sessionTtlMs: 86_400_000,
      runtime: { allowWriteOperations: true },
    };
    const dir = tempDir('rbac-group-');
    const stateDir = path.join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    const main = new ScriptedDriver();
    const worker = new ScriptedDriver();
    const server = await createServer({
      env: baseEnv(),
      config,
      dbPath: path.join(dir, 'state.db'),
      stateDir,
      logger: () => {},
      createDrivers: async () => ({ mainDriver: main, workerDriver: worker }),
    });
    try {
      // 群消息：principal = wecom:group:group-1（viewer）→ 写被宿主发起前拒绝。
      worker.push({
        calls: [{ tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.prepare', args: PREPARE_ARGS } }],
        text: (_results, toolError) => `写入未执行：${toolError ?? ''}`,
      });
      main.push({
        calls: [{ tool: TASK_RUN_TOOL, args: { task: '在 alpha 集合新增两条记录' } }],
        text: (_results, toolError) => `任务结束：${toolError ?? '已交办'}`,
      });
      const groupReply = await server.handler(incoming('user-a', 'group-1', 'm-group-1', 'group'));
      expect(worker.toolErrors).toHaveLength(1);
      expect(worker.toolErrors[0]).toContain(OPERATION_NOT_PERMITTED_MESSAGE);
      expect(groupReply).not.toContain('dummy.prepare');
      // 群主体的会话里任务停在 unexecuted；没有写操作落审计。
      expect(auditLines(path.join(dir, 'state')).filter((line) => line.includes('dummy.prepare'))).toHaveLength(0);

      // 同一个人 1:1（operator）→ 写放行：同一执行层、不同主体，互不影响。
      worker.push({
        calls: [{ tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.prepare', args: PREPARE_ARGS } }],
        text: (results, toolError) => {
          if (toolError !== undefined) return `写入未执行：${toolError}`;
          const outcome = results[0] as { status?: string };
          return `执行层返回：${outcome.status ?? 'unknown'}`;
        },
      });
      main.push({
        calls: [{ tool: TASK_RUN_TOOL, args: { task: '在 alpha 集合新增两条记录' } }],
        text: (_results, toolError) => `任务结束：${toolError ?? '已交办'}`,
      });
      await server.handler(incoming('user-a', 'single-1', 'm-single-1', 'single'));
      expect(worker.toolErrors).toHaveLength(1); // 仍只有群那条拒绝
      const audit = auditLines(path.join(dir, 'state'));
      expect(audit.filter((line) => line.includes('dummy.prepare')).length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});
