/**
 * P1 事实文本去内部词（PM/QA 真模型验收）：源头修复的回归锁。
 *
 * 判据（每条含反向绊线，实测读数见文件末）：
 *   ① 完成事实 taskCompletionFactText 不含「执行层/执行端」，且保留「办完了」+ 结果正文逐字；
 *   ② 失败归类原因（task-registry 合成）不含内部词，且保留末条状态与对方说法；
 *   ③ 模型协议提示（工具描述/协议/Worker 提示/默认称谓）不含内部词——这些字符串进模型上下文，
 *      模型会照着说（真模型实跑证据里出现过「执行层给出的确认摘要」「执行端写入后已读回核对」）；
 *   ④ 超时回执事实（dummy-cli 适配器）不含内部词，且保留超时数值、没有回执、无法确认语义；
 *   ⑤ Main 系统提示正文（agent.md 经 applyExecutorLabel 渲染后的最终文本）无内部词；
 *   ⑥ Worker 系统提示的渲染形状（renderWorkerSystemPrompt 带工作目录块）无内部词；
 *   ⑦ 失败原因链（execution-runtime 空汇报 reason → taskFailureFactText 机械原因段）无内部词。
 * 内部词含「执行层 / 执行端 / 确认凭据」——都是不该出现在给模型/用户文本里的宿主内部形态。
 * 内部词是确定性事实（不该出现在给模型/用户的文本里），不是模型行为评估。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { taskCompletionFactText, taskFailureFactText } from './task-completion-delivery';
import { judgeReportedTask, createTaskRegistry } from '../../packages/agent/src/task-registry';
import { createDummyCliClient } from '../../packages/agent/src/dummy-cli-client';
import {
  TASK_RUN_TOOL_DESCRIPTION,
  TASK_RUN_TOOL_SCHEMA,
  MAIN_PROTOCOL_NOTE,
  MAIN_PROTOCOL_NOTE_WITH_WRITES,
  WORKER_SYSTEM_PROMPT,
  TASK_CANCEL_TOOL_DESCRIPTION,
  renderWorkerSystemPrompt,
  renderWorkerDelegation,
  workerDelegationManifest,
  createSession,
} from '../../packages/agent/src/execution-runtime';
import { DEFAULT_EXECUTOR_LABEL, loadAgentProfile, applyExecutorLabel } from '../../packages/agent/src/agent-profile';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome, ExecutionRequest } from '@fshine/contracts/execution-contract';
import type { TurnDriver } from '../../packages/agent/src/driver-contract';

const INTERNAL = /执行层|执行端|确认凭据/;

describe('完成/失败事实文本：不含内部词，保留关键事实', () => {
  it('① 完成事实：无「执行层/执行端」，保留「办完了」与结果正文逐字', () => {
    const fact = taskCompletionFactText({ name: '汇总那件事', resultText: '共 7 条。' });
    expect(fact).not.toMatch(INTERNAL);
    expect(fact).toContain('办完了');
    expect(fact).toContain('结果正文（逐字）：共 7 条。');
  });

  it('② 失败归类原因：无内部词，保留末条状态与对方说法', () => {
    const zero = judgeReportedTask([]).failureReason ?? '';
    expect(zero).not.toMatch(INTERNAL);
    expect(zero).toContain('没有实际办理');
    const failed = judgeReportedTask([
      { operation: 'dummy.query', status: 'failed', error: { code: 'FAULT', message: '读取失败' } },
    ]).failureReason ?? '';
    expect(failed).not.toMatch(INTERNAL);
    expect(failed).toContain('没办成');
    expect(failed).toContain('读取失败');
  });
});

describe('模型上下文文本：工具描述/协议提示/Worker 提示不含内部词', () => {
  const taskPropertyDescription = (TASK_RUN_TOOL_SCHEMA.properties as Record<string, { description?: string }>).task?.description ?? '';
  const texts: Array<[string, string]> = [
    ['TASK_RUN_TOOL_DESCRIPTION', TASK_RUN_TOOL_DESCRIPTION],
    ['task 参数描述', taskPropertyDescription],
    ['MAIN_PROTOCOL_NOTE', MAIN_PROTOCOL_NOTE],
    ['MAIN_PROTOCOL_NOTE_WITH_WRITES', MAIN_PROTOCOL_NOTE_WITH_WRITES],
    ['WORKER_SYSTEM_PROMPT', WORKER_SYSTEM_PROMPT],
    ['TASK_CANCEL_TOOL_DESCRIPTION', TASK_CANCEL_TOOL_DESCRIPTION],
    ['DEFAULT_EXECUTOR_LABEL', DEFAULT_EXECUTOR_LABEL],
  ];
  for (const [name, text] of texts) {
    it(`${name} 不含「执行层/执行端/确认凭据」`, () => {
      expect(text).not.toMatch(INTERNAL);
    });
  }

  // ⑤ Main 的系统提示正文：agent.md 经 applyExecutorLabel 渲染后的**最终**提示无内部词。
  //    这是模型照着说的最大来源——只测静态常量不够，必须测装到模型上的最终文本。
  it('⑤ agent.md 渲染后的最终系统提示：无内部词，且分工/确认纪律语义仍在', async () => {
    const profile = await loadAgentProfile();
    const rendered = applyExecutorLabel(profile.instructions);
    expect(rendered).not.toMatch(INTERNAL);
    // 语义保留：对象裁决交给助手、显式确认动作、不替用户验证、按需拆开交办。
    expect(rendered).toContain('交给办事助手裁决');
    expect(rendered).toContain('确认是一个显式动作');
    expect(rendered).toContain('由办事助手判定');
    expect(rendered).toContain('拆开交办');
    // 字数上限（与 agent-profile.test.ts 同口径，避免渲染后体量回潮）。
    expect(rendered.length).toBeLessThanOrEqual(1088);
  });

  // ⑥ Worker 系统提示的**渲染形状**（带可信工作目录）：静态常量之外还有工作目录块。
  //    生产恒带 workerWorkspaceRoot → 该块进 Worker 系统提示，必须一并覆盖。
  it('⑥ renderWorkerSystemPrompt（带 workerWorkspaceRoot）：无内部词，且工作目录约束语义仍在', () => {
    const rendered = renderWorkerSystemPrompt('/trusted/root');
    expect(rendered).not.toMatch(INTERNAL);
    // 关键语义：工作目录 + 只在该目录处理文件（措辞业务化，约束没丢）。
    expect(rendered).toContain('你的工作目录是：/trusted/root');
    expect(rendered).toContain('处理文件只在这个目录里进行');
  });
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 最小挂住网关：call 永不返回，等宿主截断（只认 operation list）。 */
function writeHangingGateway(root: string): void {
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'operation' && args[1] === 'list') {
  process.stdout.write(JSON.stringify({ operations: [{ name: 'stub.hang', access: 'write', args: [] }] }));
  process.exit(0);
}
if (args[0] === 'call') {
  setInterval(() => {}, 1000);  // 永不返回，等宿主截断
} else {
  process.exit(7);
}
`;
  writeFileSync(path.join(root, 'bin', 'stub'), script, { mode: 0o755 });
}

async function timeoutMessage(): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'factword-timeout-'));
  tempDirs.push(dir);
  const root = path.join(dir, 'stub');
  writeHangingGateway(root);
  const client = createDummyCliClient({
    root,
    gateway: 'bin/stub',
    stateDir: path.join(dir, 'state'),
    env: process.env,
    timeoutMs: 120,
  });
  const outcome = await client.execute({
    requestId: 'req_factword',
    dispatchKey: 'dk_factword',
    operation: 'stub.hang',
    args: {},
  });
  const error = (outcome as { error?: { message?: string } }).error;
  return error?.message ?? '';
}

describe('超时回执事实：无内部词，保留关键事实', () => {
  it('④ execute 超时回执：无内部词，保留超时数值、没有回执、无法确认语义', async () => {
    const message = await timeoutMessage();
    expect(message).not.toMatch(INTERNAL);
    expect(message).toMatch(/120\s*ms/);       // 超时数值保留
    expect(message).toContain('没有收到回执');      // "没有回执" 事实保留
    expect(message).toContain('无法确认');          // 不确定性语义保留（不能变成「没办成」）
    expect(message).toContain('是否');
  });
});

/**
 * ⑦ 失败原因链：execution-runtime:2859 空汇报抛错 → registry.fail(reason) → ask-runtime 的
 *    onTaskFailed → taskFailureFactText 的「机械原因」段 → 模型可见。两端各钉一次：
 *   · 直接喂那条 reason 给 taskFailureFactText（钉合成出口本身）；
 *   · 端到端跑一次真实 createSession + 空汇报 Worker，取 registry 落定的 failureReason，
 *     确认这条 reason 已无内部词（钉 :2859 源头，不被静态常量漏掉）。
 */
const EMPTY_REPORT_REASON = '没产出有效的办理结果汇报，本次任务未完成。';

describe('失败原因事实：无内部词，保留「没办成」语义', () => {
  it('⑦a taskFailureFactText（带空汇报 reason 的输入）：无内部词，保留机械原因与下一步', () => {
    const fact = taskFailureFactText({ name: '汇总那件事', kind: 'executor_failed', reason: EMPTY_REPORT_REASON });
    expect(fact).not.toMatch(INTERNAL);
    expect(fact).toContain('这次没办成');          // "没办成"事实没被弱化
    expect(fact).toContain('机械原因');            // 原因段仍在
    expect(fact).toContain('下一步');              // 可行动出口仍在
  });

  it('⑦b 端到端：空汇报 Worker → 落定 failureReason 无内部词（钉 :2859 源头）', async () => {
    const manifest: CapabilityManifest = {
      contractVersion: 1,
      operations: [{ name: 'dummy.query', label: 'query', args: [] }],
    };
    class FakeClient implements ExecutionClient {
      async capabilities(): Promise<CapabilityManifest> { return manifest; }
      async execute(): Promise<ExecutionOutcome> { return { status: 'completed', data: { ok: true } }; }
    }
    // Main 委派一次；Worker 不汇报 → 命中 :2859 的空汇报抛错。
    const mainDriver: TurnDriver = {
      async run(input) {
        await input.exec('task_run', { task: '查一下' });
        return { text: '（测试）已交办', messages: [...input.messages] } as never;
      },
    };
    const workerDriver: TurnDriver = {
      async run() {
        return { text: '', messages: [] } as never;   // 空汇报
      },
    };
    const session = await createSession({
      principalId: 'wecom:factword-user',
      sessionId: 'factword-conv',
      client: new FakeClient(),
      allowedOperations: ['dummy.query'],
      mainDriver,
      workerDriver,
      mainSystemPrompt: '（测试主提示）',
    });
    // 空汇报抛错会经 task_run 工具冒泡到 send()（catch 住即可，registry.fail 已在 throw 前落定）。
    await session.send('查一下').catch(() => {});
    const failed = session.tasks().find((task) => task.status === 'failed');
    expect(failed, '空汇报应落定一条 failed 任务').toBeDefined();
    const reason = failed!.failureReason ?? '';
    expect(reason).not.toBe('');                    // 确认读到的就是 :2859 的 reason
    expect(reason).not.toMatch(INTERNAL);           // 源头无内部词
    expect(reason).toContain('没产出有效的办理结果汇报'); // 关键语义仍在（没办成/没汇报）
  });
});

/**
 * 模型可见面收口（2026-11-20）——三条结构性守卫：删掉实现细节不应影响模型选操作/填参数/
 * 读结果。每条配反向绊线（改回就红，读数见文末记录）。
 */
describe('模型可见面收口：清单投影 / Worker 提示 / 底账投影', () => {
  // ① 能力清单投影：只留 operation 名、参数名、required、payload.schema、一句说明。
  const RICH_MANIFEST = {
    contractVersion: 4,
    operations: [
      {
        name: 'dummy.query',
        label: '查记录',
        weight: 2,
        estimatedSeconds: 30,
        effects: ['read'],
        long_running: false,
        args: [{ name: '--collection', required: true, type: 'name', style: 'name' }],
      },
      {
        name: 'dummy.commit',
        label: '提交',
        weight: 20,
        estimatedSeconds: 1800,
        long_running: true,
        args: [{ name: '--records', required: true, payload: { schema: { type: 'array' } } }],
      },
    ],
  };

  it('①a workerDelegationManifest：不含 weight/estimatedSeconds/effects/style/long_running 字样与内部角色词', () => {
    const projected = JSON.stringify(workerDelegationManifest(RICH_MANIFEST as never));
    for (const term of ['weight', 'estimatedSeconds', 'effects', 'style', 'long_running', '宿主', '委派', '能力快照', '纵深防御', '子进程', '执行面']) {
      expect(projected, `清单投影漏进了「${term}」`).not.toContain(term);
    }
    // 选操作/填参数所需仍在：operation 名、业务参数名（去 `--`）、required、payload.schema、说明。
    expect(projected).toContain('dummy.query');
    expect(projected).toContain('"collection"');
    expect(projected).not.toContain('"--collection"');
    expect(projected).toContain('"required":true');
    expect(projected).toContain('"schema"');
    expect(projected).toContain('查记录');
  });

  it('①b renderWorkerDelegation：整段委派文本也不含上述内部词', () => {
    const text = renderWorkerDelegation({ task: '查记录', manifest: RICH_MANIFEST as never });
    for (const term of ['weight', 'estimatedSeconds', 'effects', 'style', 'long_running', '宿主', '委派', '能力快照', '纵深防御', '子进程', '执行面']) {
      expect(text, `委派文本漏进了「${term}」`).not.toContain(term);
    }
  });

  // ② Worker 提示渲染后：只说「一件活 / 按输入去做 / 用工具报事实」，无内部角色/机制词。
  it('② renderWorkerSystemPrompt：渲染后不含宿主/委派/能力快照/纵深防御/子进程/执行面', () => {
    const rendered = renderWorkerSystemPrompt('/trusted/root');
    for (const term of ['宿主', '委派', '能力快照', '纵深防御', '子进程', '执行面']) {
      expect(rendered, `Worker 提示漏进了「${term}」`).not.toContain(term);
    }
    // 行为句语义仍在：你收到一件活、按输入做、用工具报事实（工具按 operation 一一定制，无通用执行工具名）。
    expect(rendered).toContain('你接到一件要办的事');
    expect(rendered).toContain('用给你的工具把每一步交出去办');
    expect(rendered).not.toContain('execute_operation');
  });

  // ③ 底账投影：失败只给 status + 封闭 failureKind，不给 failureReason / error.message 自由文本。
  const SCOPE = { principalId: 'wecom:proj-user', sessionId: 'proj-conv' };
  function seededFailedRegistry(): ReturnType<typeof createTaskRegistry> {
    const registry = createTaskRegistry();
    registry.begin({ taskId: 't_proj', ...SCOPE, request: '查 alpha' });
    registry.noteExecution('t_proj', {
      requestId: 'req_proj',
      operation: 'dummy.query',
      status: 'failed',
      // 底账里 failureReason/旧文案含内部词：投影必须结构性不给这些拼装文本，不靠词表过滤。
      error: { code: 'COLLECTION_FAULT', message: '执行层没法读这份集合，确认凭据 handle 失效' },
    });
    registry.fail('t_proj', '执行层调用超时，确认凭据 handle 失效');
    return registry;
  }

  /** 经真实 createSession 调一次指定工具，拿到生产 statusView / taskResult 投影。 */
  async function projectionOf(tool: 'task_status' | 'task_result'): Promise<Record<string, unknown>> {
    const registry = seededFailedRegistry();
    let captured: Record<string, unknown> = {};
    const client: ExecutionClient = {
      async capabilities() { return { contractVersion: 4, operations: [{ name: 'dummy.query', args: [] }] }; },
      async execute() { return { status: 'completed', data: {} }; },
    };
    const session = await createSession({
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      client,
      allowedOperations: ['dummy.query'],
      mainDriver: {
        async run(input) {
          captured = await input.exec(tool, { ref: 't_proj' }) as Record<string, unknown>;
          return { text: '', messages: [] } as never;
        },
      },
      workerDriver: { async run() { return { text: '', messages: [] } as never; } },
      mainSystemPrompt: '（测试）',
      taskRegistry: registry,
    });
    await session.send('查一下');
    return captured;
  }

  it('③ task_status 投影：无 failureReason 自由文本，失败只出现封闭 failureKind', async () => {
    const view = await projectionOf('task_status');
    const text = JSON.stringify(view);
    expect(text).not.toContain('failureReason');
    expect(text).not.toContain('执行层');
    expect(text).not.toContain('确认凭据');
    expect(text).not.toContain('handle');
    expect(text).not.toContain('"message"');
    // 封闭种类来自 classifyFailure：COLLECTION_FAULT → executor_failed。
    expect(view['failureKind']).toBe('executor_failed');
  });

  it('③b task_result 投影：失败给 failureKind + 清洗摘要，不给 failureReason/技术码/error 对象', async () => {
    const result = await projectionOf('task_result');
    const text = JSON.stringify(result);
    expect(text).not.toContain('failureReason');
    expect(text).not.toContain('执行层');
    expect(text).not.toContain('确认凭据');
    expect(text).not.toContain('handle');
    expect(text).not.toContain('"message"');
    expect(text).not.toContain('"code"');
    // 封闭种类来自 classifyFailure：COLLECTION_FAULT → executor_failed。
    expect(result['failureKind']).toBe('executor_failed');
    // 必要的业务摘要仍在（清洗过：内部词替换成「确认信息」「对方」），模型能读懂结果。
    expect(result['summary']).toContain('对方没法读这份集合');
    expect(result['summary']).toContain('确认信息失效');
    const executions = result['executions'] as Array<Record<string, unknown>>;
    expect(executions[0]!['failureKind']).toBe('executor_failed');
    expect(executions[0]!['error']).toBeUndefined();
  });
});

/**
 * 反向绊线（亲跑验证，恢复后全绿：19 passed）：
 *   · 把 taskCompletionFactText 的「办完了」改回「已由执行端确认完成」→ ① 红（内部词命中 + 丢「办完了」）；
 *   · 把 dummy-cli-client.ts 的 execute 超时 message 改回「执行层调用超时…」→ ④ 红（内部词命中）；
 *   · 把 MAIN_PROTOCOL_NOTE_WITH_WRITES 任一条改回带「执行层」→ ③ 对应用例红；
 *   · 把 agent.md 任一「办事助手/助手」改回「执行层」→ ⑤ 红；
 *   · 把 renderWorkerSystemPrompt 工作目录块的「办事的执行面」改回「执行层」→ ⑥ 红（旧锚，现文案已改）；
 *   · 把 execution-runtime.ts:2859 的「没产出有效的办理结果汇报」改回「执行层 Worker 未产出有效汇报」→ ⑦b 红（端到端读到的就是该 reason）。
 *   · ①a/①b：把 weight / long_running 放回 workerDelegationManifest 的白名单 → 2 failed｜17 passed，
 *     `清单投影漏进了「weight」`、①b renderWorkerDelegation 同红；
 *   · ②：把 WORKER_SYSTEM_PROMPT 首句改回「宿主把一项平台任务委派给你（能力快照/纵深防御/子进程/执行面）」
 *     → 1 failed｜18 passed，`Worker 提示漏进了「宿主」`；
 *   · ③b：把 taskResult 的 failureReason / error 自由文本投影放回 → 1 failed｜18 passed，
 *     `expected … not to contain 'failureReason'`，回执里 `failureReason:"执行层调用超时，确认凭据 handle 失效"`
 *     与 error.message `执行层没法读这份集合，确认凭据 handle 失效` 原样外泄（清洗摘要 summary 那道
 *     拦不住拼装字段——证明是结构性拦截，不是词表过滤）。
 * 用例断言一字未改即可复现；恢复后 19/19 全绿。
 */
