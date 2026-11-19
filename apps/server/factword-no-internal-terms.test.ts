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
import { judgeReportedTask } from '../../packages/agent/src/task-registry';
import { createDummyCliClient } from '../../packages/agent/src/dummy-cli-client';
import {
  TASK_RUN_TOOL_DESCRIPTION,
  TASK_RUN_TOOL_SCHEMA,
  MAIN_PROTOCOL_NOTE,
  MAIN_PROTOCOL_NOTE_WITH_WRITES,
  WORKER_SYSTEM_PROMPT,
  TASK_CANCEL_TOOL_DESCRIPTION,
  renderWorkerSystemPrompt,
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
    // 关键语义：可信目录 + 权限边界仍由执行面负责（措辞业务化，但责任归属没丢）。
    expect(rendered).toContain('你的可信工作目录是：/trusted/root');
    expect(rendered).toContain('执行环境的实际权限边界由办事的执行面负责');
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
 * 反向绊线（亲跑验证，实测见文件末记录）：
 *   · 把 taskCompletionFactText 的「办完了」改回「已由执行端确认完成」→ ① 红（内部词命中 + 丢「办完了」）；
 *   · 把 dummy-cli-client.ts 的 execute 超时 message 改回「执行层调用超时…」→ ④ 红（内部词命中）；
 *   · 把 MAIN_PROTOCOL_NOTE_WITH_WRITES 任一条改回带「执行层」→ ③ 对应用例红；
 *   · 把 agent.md 任一「办事助手/助手」改回「执行层」→ ⑤ 红；
 *   · 把 renderWorkerSystemPrompt 工作目录块的「办事的执行面」改回「执行层」→ ⑥ 红；
 *   · 把 execution-runtime.ts:2859 的「没产出有效的办理结果汇报」改回「执行层 Worker 未产出有效汇报」→ ⑦b 红（端到端读到的就是该 reason）。
 * 用例断言一字未改即可复现；恢复后全绿。
 */
