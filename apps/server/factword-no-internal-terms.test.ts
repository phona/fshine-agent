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
 * 内部词含「执行层 / 执行端 / 确认凭据 / 宿主 / 委派 / 能力快照 / 执行面 / 凭据」——都是不该
 * 出现在给模型/用户文本里的宿主内部形态（2026-11-20 扩面：复核发现 run_js 描述/续跑注记/
 * 后台文件提示/技能正文里仍有漏网）。内部词是确定性事实，不是模型行为评估。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  RUN_JS_TOOL_DESCRIPTION,
  WORKER_RUN_JS_TOOL_DESCRIPTION,
  RUN_JS_TOOL_SCHEMA,
  BACKGROUND_FILE_MANIFEST_HINT,
  longTaskResumeNote,
  renderWorkerSystemPrompt,
  renderWorkerDelegation,
  workerDelegationManifest,
  createSession,
} from '../../packages/agent/src/execution-runtime';
import { DEFAULT_EXECUTOR_LABEL, loadAgentProfile, applyExecutorLabel } from '../../packages/agent/src/agent-profile';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome, ExecutionRequest } from '@fshine/contracts/execution-contract';
import type { TurnDriver } from '../../packages/agent/src/driver-contract';

const INTERNAL = /执行层|执行端|确认凭据|宿主|委派|能力快照|执行面|凭据/;

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
    it(`${name} 不含内部词（执行层/执行端/确认凭据/宿主/委派/能力快照/执行面/凭据）`, () => {
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

/**
 * 卸载漏网扩面（2026-11-20 复核）：复核逐条点出 5 类残留——续跑注记 / 后台文件提示 /
 * run_js 工具描述+schema / 技能正文 / 真实 dummy 清单的 payload.schema 英文描述。每条都进
 * 模型上下文（模型照着说），所以按 INTERNAL 词表结构性拦住；不是行为评估。
 */
describe('卸载漏网扩面：续跑注记 / run_js 描述 / 真实清单 / 技能正文', () => {
  it('⑧ longTaskResumeNote（重启续跑）：无内部词，保留「不要重复发起」语义', () => {
    const note = longTaskResumeNote(
      { operation: 'dummy.query', operationId: 'op-1', dispatchKey: 'dk-test', restarted: true, outcome: {} },
      { status: 'completed', data: {} },
    );
    expect(note).not.toMatch(INTERNAL);
    expect(note).toContain('不要重复发起同一操作');
  });

  it('⑧b 后台文件清单提示（BACKGROUND_FILE_MANIFEST_HINT）：无内部词，保留 fileId 引用语义', () => {
    expect(BACKGROUND_FILE_MANIFEST_HINT).not.toMatch(INTERNAL);
    expect(BACKGROUND_FILE_MANIFEST_HINT).toContain('fileId');
  });

  it('⑨ run_js 工具描述与 schema：Main/Worker 两份 + 两个参数描述都无内部词', () => {
    for (const [name, text] of [
      ['RUN_JS_TOOL_DESCRIPTION', RUN_JS_TOOL_DESCRIPTION],
      ['WORKER_RUN_JS_TOOL_DESCRIPTION', WORKER_RUN_JS_TOOL_DESCRIPTION],
      ['code 参数描述', String((RUN_JS_TOOL_SCHEMA.properties as Record<string, { description?: string }>)['code']?.description ?? '')],
      ['inputs 参数描述', String((RUN_JS_TOOL_SCHEMA.properties as Record<string, { description?: string }>)['inputs']?.description ?? '')],
    ] as const) {
      expect(text, name).not.toMatch(INTERNAL);
    }
  });

  it('⑩ 真实 dummy 清单投影：model_visible 的操作投影无内部词（不是合成 manifest）', async () => {
    const root = path.resolve(__dirname, '../../scripts/eval/fixtures/dummy-platform');
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'factword-manifest-'));
    tempDirs.push(stateDir);
    const client = createDummyCliClient({
      root,
      gateway: 'bin/dummy',
      stateDir,
      env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] },
    });
    const manifest = await client.capabilities();
    // 生产路径：model_visible:false 的 operation 先剔除，再走 workerDelegationManifest 白名单。
    const worker = {
      contractVersion: manifest.contractVersion,
      operations: manifest.operations.filter((op) => op.model_visible !== false),
    };
    const projected = JSON.stringify(workerDelegationManifest(worker));
    for (const term of ['宿主', '委派', '能力快照', '执行面', '凭据', 'the host lints', 'execution layer', 'confirmation handle', 'host -> platform']) {
      expect(projected, `真实清单投影漏进了「${term}」`).not.toContain(term);
    }
    // 选操作/填参数所需仍在（投影没被削空）。
    expect(projected).toContain('dummy.query');
    expect(projected).toContain('"schema"');
  });

  it('⑪ 技能正文：dummy-routing/SKILL.md 无内部词', () => {
    const skill = readFileSync(
      path.resolve(__dirname, '../../scripts/eval/fixtures/dummy-platform/.agents/skills-serve/dummy-routing/SKILL.md'),
      'utf8',
    );
    expect(skill).not.toMatch(INTERNAL);
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

  // ③ 底账投影：封闭码（failureKind/outcomeKind）+ 机械清理的业务摘要，不给 failureReason 自由文本。
  //    三形状：完成=空；失败且有决定性失败执行=failureKind+summary；空汇报=failureKind+outcomeKind。
  const SCOPE = { principalId: 'wecom:proj-user', sessionId: 'proj-conv' };
  type SeedKind = 'failed' | 'completed' | 'no_report' | 'mechanically_cleaned';
  function seededRegistry(kind: SeedKind): ReturnType<typeof createTaskRegistry> {
    const registry = createTaskRegistry();
    registry.begin({ taskId: 't_proj', ...SCOPE, request: '查 alpha' });
    if (kind === 'failed') {
      registry.noteExecution('t_proj', {
        requestId: 'req_proj',
        operation: 'dummy.query',
        status: 'failed',
        // 底账里 failureReason 是拼装自由文本（含内部词）：投影必须结构性不给它。
        // error.message 是执行层业务原话（机械清理只剥技术码/路径/机构自称，不按词表替换）。
        error: { code: 'COLLECTION_FAULT', message: 'Collection alpha cannot be read in its current state' },
      });
      registry.fail('t_proj', '执行层调用超时，确认凭据 handle 失效（拼装自由文本，不得进投影）');
    } else if (kind === 'mechanically_cleaned') {
      // 钉「只做机械清理、不按 4 词表替换」：旧 failureSummaryOf 会把 handle→确认信息。
      // 这里断言摘要逐字保留业务原话（含 handle），恢复词表替换即红。
      registry.noteExecution('t_proj', {
        requestId: 'req_mc',
        operation: 'dummy.query',
        status: 'failed',
        error: { code: 'COLLECTION_FAULT', message: 'records at handle boundary cannot be read' },
      });
      registry.fail('t_proj', 'some assembled reason');
    } else if (kind === 'completed') {
      // P0 复现：前序 failed，末条 decisive=completed → completed 任务不得带任何失败视图。
      registry.noteExecution('t_proj', {
        requestId: 'req_fail',
        operation: 'dummy.query',
        status: 'failed',
        error: { code: 'INVALID_ARGUMENT', message: '第一次参数不对，改对了' },
      });
      registry.noteExecution('t_proj', {
        requestId: 'req_ok',
        operation: 'dummy.query',
        status: 'completed',
      });
      registry.complete('t_proj', '已查到 3 条。');
    } else {
      // 空汇报：registry.fail 但没有 failed execution（:2919 形状）→ 封闭 outcomeKind。
      registry.fail('t_proj', '没产出有效的办理结果汇报，本次任务未完成。');
    }
    return registry;
  }

  /** 经真实 createSession 调一次指定工具，拿到生产 statusView / taskResult 投影。 */
  async function projectionOf(tool: 'task_status' | 'task_result', kind: SeedKind = 'failed'): Promise<Record<string, unknown>> {
    const registry = seededRegistry(kind);
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

  /** 任何投影都不得含拼装 failureReason / 内部词 / 技术码字段（三形状共用）。 */
  function expectNoFreeText(view: Record<string, unknown>): void {
    const text = JSON.stringify(view);
    expect(text).not.toContain('failureReason');
    expect(text).not.toContain('执行层');
    expect(text).not.toContain('确认凭据');
    expect(text).not.toContain('handle');
    expect(text).not.toContain('"message"');
    expect(text).not.toContain('"code"');
  }

  it('③ task_status 投影：无拼装自由文本，失败只出现封闭 failureKind', async () => {
    const view = await projectionOf('task_status');
    expectNoFreeText(view);
    // 封闭种类来自 classifyFailure：COLLECTION_FAULT → executor_failed。
    expect(view['failureKind']).toBe('executor_failed');
    expect(view['outcomeKind']).toBeUndefined();
  });

  it('③b task_result 投影：失败给 failureKind + 机械清理摘要，不给 failureReason/技术码/error 对象', async () => {
    const result = await projectionOf('task_result');
    expectNoFreeText(result);
    expect(result['failureKind']).toBe('executor_failed');
    // 摘要是执行层业务原话、只经机械清理（剥码/路径/机构自称），不按词表替换。
    expect(result['summary']).toBe('Collection alpha cannot be read in its current state');
    expect(result['outcomeKind']).toBeUndefined();
    const executions = result['executions'] as Array<Record<string, unknown>>;
    expect(executions[0]!['failureKind']).toBe('executor_failed');
    expect(executions[0]!['error']).toBeUndefined();
    expect(executions[0]!['summary']).toBe('Collection alpha cannot be read in its current state');
  });

  it('③c P0 复现：前序 failed + 末条 decisive=completed → completed 不带 failureKind/outcomeKind/summary', async () => {
    for (const tool of ['task_status', 'task_result'] as const) {
      const view = await projectionOf(tool, 'completed');
      expectNoFreeText(view);
      expect(view['status']).toBe('completed');
      expect(view['failureKind']).toBeUndefined();
      expect(view['outcomeKind']).toBeUndefined();
      expect(view['summary']).toBeUndefined();
      if (tool === 'task_result') {
        const executions = view['executions'] as Array<Record<string, unknown>>;
        // 两行执行事实都留痕（审计可查），只是不改写终局投影。
        expect(executions.map((entry) => entry['status'])).toEqual(['failed', 'completed']);
      }
    }
  });

  it('③d 空汇报失败：无 failed execution → 封闭 outcomeKind=no_report，不恢复自由文本原因', async () => {
    for (const tool of ['task_status', 'task_result'] as const) {
      const view = await projectionOf(tool, 'no_report');
      expectNoFreeText(view);
      expect(view['status']).toBe('failed');
      expect(view['outcomeKind']).toBe('no_report');
      expect(view['summary']).toBeUndefined();
    }
  });

  it('③e 摘要只做机械清理：不复活「确认凭据/handle→确认信息」的 4 词表替换', async () => {
    const result = await projectionOf('task_result', 'mechanically_cleaned');
    // 机械清理只剥技术码/路径/机构自称；业务原话里的 handle 逐字保留（不是词表替换）。
    expect(result['summary']).toBe('records at handle boundary cannot be read');
    expect(JSON.stringify(result)).not.toContain('确认信息');
  });
});

/**
 * 反向绊线（2026-11-20 亲跑验证，恢复后全绿：27 passed；逐条改回 → 对应守卫红）：
 *   · ③c P0：failureViewOfTask 改回「倒序找第一个 failed/refused，不看末条」→ 1 failed｜26 passed，
 *     `expected undefined to be 'invalid_input'`——completed 任务同时带 failureKind（本轮真 bug 复现）；
 *   · ③d：去掉 outcomeKind='no_report'（空汇报只剩 executor_failed）→ 1 failed｜26 passed，
 *     `expected 'no_report'` 处红（原因丢失重现）；
 *   · ③e：把 4 词表替换放回 failureSummaryOf 的两处摘要 → 1 failed｜26 passed，
 *     `expected 'records at handle boundary…'` / received 'records at 确认信息 boundary…'——钉住「只做机械清理」；
 *   · ⑧：longTaskResumeNote 改回「宿主曾重启」→ 1 failed｜26 passed，`not to match …宿主`；
 *   · ⑧b：BACKGROUND_FILE_MANIFEST_HINT 改回「能力快照…宿主会替换」→ 1 failed｜26 passed，同红；
 *   · ⑨：RUN_JS_TOOL_DESCRIPTION 改回「宿主物化」→ 1 failed｜26 passed，`RUN_JS_TOOL_DESCRIPTION: not to match …宿主`；
 *   · ③：MAIN_PROTOCOL_NOTE 改回「本轮执行面只开放查询」→ 1 failed｜26 passed，`not to match …执行面`；
 *   · ⑪：SKILL.md 改回「行为以执行层返回为准」→ 1 failed｜26 passed，`not to match …执行层`；
 *   · ⑤：agent.md 改回「组织成委派」→ 1 failed｜26 passed，`not to match …委派`；
 *   · ⑩：capabilities.json payload.schema.description 改回英文「the host lints…execution layer…
 *     confirmation handle」→ 1 failed｜26 passed，`真实清单投影漏进了「the host lints」`（真实 dummy 清单，
 *     非合成 manifest——真网关 operation list 取数）。
 * 用例断言一字未改即可复现；恢复后 27/27 全绿。
 */
