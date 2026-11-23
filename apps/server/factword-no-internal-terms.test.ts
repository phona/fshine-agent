/**
 * P1 事实文本去内部词（PM/QA 真模型验收）：源头修复的回归锁。
 *
 * 判据（每条含反向绊线，实测读数见文件末）：
 *   ① 回合结束事实 taskRoundFactsText 不含「执行层/执行端」，且喂账本事实 + worker 汇报原文
 *      （不喂回合级结局词：没有 `[任务完成]`/`[任务失败]`/「办完了」投影）；
 *   ③ 模型协议提示（工具描述/协议/Worker 提示/默认称谓）不含内部词——这些字符串进模型上下文，
 *      模型会照着说（真模型实跑证据里出现过「执行层给出的确认摘要」「执行端写入后已读回核对」）；
 *   ④ 超时回执事实（dummy-cli 适配器）不含内部词，且保留超时数值、没有回执、无法确认语义；
 *   ⑤ Main 系统提示正文（agent.md 经 applyExecutorLabel 渲染后的最终文本）无内部词；
 *   ⑥ Worker 系统提示的渲染形状（renderWorkerSystemPrompt 带工作目录块）无内部词；
 *   ⑦ 回合结束事实链（宿主喂账本事实 → taskRoundFactsText）无内部词。
 * 内部词含「执行层 / 执行端 / 确认凭据 / 宿主 / 委派 / 能力快照 / 执行面 / 凭据」——都是不该
 * 出现在给模型/用户文本里的宿主内部形态（2026-11-20 扩面：复核发现 run_js 描述/续跑注记/
 * 后台文件提示/技能正文里仍有漏网）。内部词是确定性事实，不是模型行为评估。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { taskRoundFactsText } from './task-completion-delivery';
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
  it('① 回合结束事实：喂 executions + replyText（不做成败结论），无内部词', () => {
    const fact = taskRoundFactsText({
      name: '汇总那件事',
      report: '共 7 条。',
      ledger: ['1. dummy.query — completed'],
    });
    expect(fact).not.toMatch(INTERNAL);
    // 事实面：worker 汇报原文逐字 + 逐笔执行行都在（Main 自己判做没做成）。
    expect(fact).toContain('共 7 条。');
    expect(fact).toContain('dummy.query — completed');
    // 不喂回合级结局词（'[任务完成]'/'[任务失败]'/'办完了' 都是投影，已退役）。
    expect(fact.startsWith('[任务完成]')).toBe(false);
    expect(fact.startsWith('[任务失败]')).toBe(false);
    expect(fact).not.toContain('办完了');
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
 * ⑦ 回合结束事实链：宿主把账本事实喂给 Main（taskRoundFactsText 的「账本事实」段）→ 模型可见。
 *    S1 事实模型：底账没有结论字段，宿主不合成成败结论——回合事实 = 业务名 + 机械标记 +
 *    逐笔账本事实行 + worker 汇报原文（成与败同一形状，由 Main 自己判）。
 */
const EMPTY_REPORT_REASON = '没产出有效的办理结果汇报，本次任务未完成。';

describe('回合结束事实文本：无内部词，保留账本事实与下一步', () => {
  it('⑦a taskRoundFactsText（带账本事实行、无汇报）：无内部词，保留「账本事实」与下一步', () => {
    const fact = taskRoundFactsText({ name: '汇总那件事', ledger: [EMPTY_REPORT_REASON] });
    expect(fact).not.toMatch(INTERNAL);
    expect(fact).toContain('账本事实');            // 账本段仍在
    expect(fact).toContain('下一步');              // 可行动出口仍在
  });

  /**
   * ⑦b 机械原因（reason）进模型可见事实前与用户可见回复同一把尺：执行层原文里常带前置
   * 技术码 token、服务器路径与「执行层/委派」这类机构自称。清洗只做机械剥离，**不按词表
   * 替换业务原文**——prepared/got 这类可诊断信息必须原样留下（模型要据此改参数）。
   * 反向绊线：reason 不清洗（回退成 `input.reason.replace(...)`）时本用例转红。
   */
  it('⑦b taskRoundFactsText（reason 带技术码/服务器路径/机构自称）：清干净且业务原文逐字保留', () => {
    const rawReason = 'CONFIRMATION_BINDING_MISMATCH 执行层返回：prepared collection=客户 got collection=客户台账'
      + '（日志在 /home/deploy/fshine-agent/tmp/task_d42fffce-1111-4222-8333-444455556666/run.log，供排查）';
    const fact = taskRoundFactsText({ name: '汇总那件事', reason: rawReason });
    expect(fact).not.toMatch(INTERNAL);
    expect(fact).not.toContain('/home/');
    expect(fact).not.toContain('tmp/task_');
    expect(fact).not.toContain('CONFIRMATION_BINDING_MISMATCH'); // 前置技术码 token 剥掉
    expect(fact).toContain('prepared collection=客户 got collection=客户台账'); // 可诊断原文不动
    expect(fact).toContain('机械原因');
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
});

/**
 * 反向绊线（2026-11-20 亲跑验证）：
 *   · ⑧：longTaskResumeNote 改回「宿主曾重启」→ 对应守卫红（`not to match …宿主`）；
 *   · ⑧b：BACKGROUND_FILE_MANIFEST_HINT 改回「能力快照…宿主会替换」→ 同红；
 *   · ⑨：RUN_JS_TOOL_DESCRIPTION 改回「宿主物化」→ 红（`not to match …宿主`）；
 *   · ③：MAIN_PROTOCOL_NOTE 改回「本轮执行面只开放查询」→ 红（`not to match …执行面`）；
 *   · ⑪：SKILL.md 改回「行为以执行层返回为准」→ 红（`not to match …执行层`）；
 *   · ⑤：agent.md 改回「组织成委派」→ 红（`not to match …委派`）；
 *   · ⑩：capabilities.json payload.schema.description 改回英文「the host lints…execution layer…
 *     confirmation handle」→ 红（真实 dummy 清单，非合成 manifest——真网关 operation list 取数）。
 * 注：底账失败投影（旧 failureViewOfTask/statusView）用例已随 S1 事实模型删除（底账不再有结论投影）。
 */
