import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai/compat';
import { createPiCodingWorkerSession } from './src/pi-coding-driver';
import type { PlanCliRunner } from './src/plan-runtime';
import type { ServeGateVerdict } from './src/serve-gate';
import type { PlanEntitySources } from './src/turn-contract';

/**
 * 实体门标定修复的驱动级用例（D-085 / D-086）。
 *
 * 与 `pi-coding-driver.test.ts` 里那几条的分工：那个文件钉"实体门接上了线"（拒绝、放行、
 * 自产物豁免、收敛上限各一条）；本文件钉**两个方向上的标定错误**，两条都是真模型实测出的
 * 事故形状，且都与"门该不该存在"无关——门必须留着，错的是它的出处范围：
 *
 *   · D-086（漏拦）：门自己的拒绝理由逐字带 offending token，经 SDK 变成 tool_result 回灌
 *     haystack，于是"先故意提一个越权实体、拿到拒绝理由、再原样提一次"就能过。
 *   · D-085（误拦）：长任务里早期平台响应里确立的实体滑出 20 条窗口，被拒 → 重试 →
 *     DECLINED_PLAN_LIMIT → worker 放弃。
 *
 * 判据按**身份**（toolCallId）而不是 `isError` 或文案前缀：SDK bash 工具退出码非零时 throw，
 * 平台 CLI exit 3 的真错误信封同样是 `isError:true`——按它过滤会把真证据一起删掉，制造新
 * 假拒；按文案前缀过滤则是嗅探，且要维护一份跟着每个新裁决增长的名单。
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fakeModelRuntime(): Promise<{ runtime: ModelRuntime; model: Model<any> }> {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('test', {
    name: 'Test',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'test-key',
    models: [{
      id: 'worker-test',
      name: 'worker-test',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_000,
      maxTokens: 1_000,
    }],
  });
  const model = runtime.getModel('test', 'worker-test');
  if (!model) throw new Error('test model was not registered');
  return { runtime, model };
}

/** 计划 CLI 替身：current 无活跃计划；evaluate 一律激活（放行后的下一步由测试断言）。 */
function planRunner(evaluated: string[][]): PlanCliRunner {
  return async ({ args }) => {
    evaluated.push(args);
    if (args[1] === 'current') {
      return { code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: null, version: null, status: 'none' }), stderr: '' };
    }
    return { code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: 'plan_new', version: 1, status: 'active' }), stderr: '' };
  };
}

const OUT_OF_SCOPE = '未在当前请求、检索证据、平台响应或本会话已确立实体中出现的参数';

async function makeWorker(options: {
  entitySources: PlanEntitySources;
  planCliRunner: PlanCliRunner;
  onPlanSubmitted?: (calls: readonly { operation: string; args: readonly unknown[] }[]) => void;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-entity-scope-'));
  roots.push(root);
  const modelConfig = await fakeModelRuntime();
  return createPiCodingWorkerSession({
    gateway: 'bin/17dz',
    cwd: root,
    skillRoots: [],
    systemPrompt: 'entity scope test',
    sessionId: 'task_scope',
    agentDir: path.join(root, '.fshine-agent'),
    modelConfig,
    ...options,
  });
}

/** 直接调宿主侧 beforeToolCall（驱动在 session.agent 上装的那一个），与生产同一入口。 */
async function submit(
  worker: Awaited<ReturnType<typeof makeWorker>>,
  command: string,
  toolCallId: string,
): Promise<ServeGateVerdict | undefined> {
  return worker.session.agent.beforeToolCall?.({
    assistantMessage: {} as never,
    toolCall: { id: toolCallId, type: 'toolCall', name: 'bash', arguments: { command } } as never,
    args: { command },
    context: {} as never,
  });
}

/** 按 SDK 的真实形状造一条 tool_result（createToolResultMessage 的字段全集）。 */
function toolResult(toolCallId: string, text: string, isError: boolean): unknown {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'bash',
    content: [{ type: 'text', text }],
    details: {},
    isError,
    timestamp: 1,
  };
}

function appendToolResult(worker: Awaited<ReturnType<typeof makeWorker>>, message: unknown): void {
  worker.session.agent.state.messages = [...worker.session.agent.state.messages, message] as never;
}

const OVERSCOPE_PLAN = 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","胜利五金有限责任公司","--customer","猫一杯"]}]}';
/** 越权的那一个 token：当前消息里没有它，只能由"平台真的返回过"或"宿主的拒绝理由"提供。 */
const OVERSCOPE_TOKEN = '猫一杯';
/** 当前消息只给账套名，越权实体一个字都不给。 */
const CURRENT_MESSAGE = '查一下胜利五金有限责任公司账套的应收';
/** 一条真的带着越权实体的平台信封（末行形态，与 SDK 保尾弃头后的真实转录一致）。 */
const ENVELOPE_FOR_TOKEN = 'RESULT {"v":1,"op":"finance.search-references","status":"completed","data":{"candidates":[{"id":"c_1","name":"猫一杯"}]}}';

describe('实体门：宿主自己的拒绝理由不回灌 haystack（D-086）', () => {
  it('越权 token 被拒后原样重提：仍然被拒（"先拒后抄"绕过路径关闭）', async () => {
    const evaluated: string[][] = [];
    const worker = await makeWorker({
      entitySources: { currentMessage: CURRENT_MESSAGE },
      planCliRunner: planRunner(evaluated),
    });

    const first = await submit(worker, OVERSCOPE_PLAN, 'call_scope_1');
    expect(first?.block).toBe(true);
    expect(first?.reason).toContain(OUT_OF_SCOPE);
    // SDK 把 {block:true,reason} 变成一条 isError tool_result 原样落进转录（agent-loop.js
    // 的 createErrorToolResult + createToolResultMessage）。reason 里逐字带着越权 token。
    appendToolResult(worker, toolResult('call_scope_1', first?.reason ?? '', true));

    // 换一个 toolCallId 重提同一条计划：token 已经在"平台响应"里了，若判据不认身份就会放行。
    const second = await submit(worker, OVERSCOPE_PLAN, 'call_scope_2');

    expect(second?.block).toBe(true);
    expect(second?.reason).toContain(OUT_OF_SCOPE);
    // 没有任何一次走到 evaluate：两次都在实体校验处被挡下
    expect(evaluated.some((args) => args[1] === 'evaluate')).toBe(false);
    worker.session.dispose();
  });

  it('同样形状的平台成功响应照旧放行（排除不伤真证据）', async () => {
    const evaluated: string[][] = [];
    const worker = await makeWorker({
      entitySources: { currentMessage: CURRENT_MESSAGE },
      planCliRunner: planRunner(evaluated),
    });
    const first = await submit(worker, OVERSCOPE_PLAN, 'call_scope_1');
    expect(first?.block).toBe(true);
    appendToolResult(worker, toolResult('call_scope_1', first?.reason ?? '', true));

    // 真正执行过的一次平台响应（换 id、不带 isError）把越权实体带了回来
    appendToolResult(worker, toolResult(
      'call_search_2',
      'RESULT {"v":1,"op":"finance.search-references","status":"completed","data":{"candidates":[{"id":"c_1","name":"猫一杯"}]}}',
      false,
    ));

    const verdict = await submit(
      worker,
      'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","胜利五金有限责任公司","--customer","猫一杯"]}]}',
      'call_scope_2',
    );

    expect(verdict?.reason).not.toContain(OUT_OF_SCOPE);
    expect(evaluated.some((args) => args[1] === 'evaluate')).toBe(true);
    worker.session.dispose();
  });

  it('正文里含 "PLAN DECLINED：" 字样的平台响应照旧放行（排除不嗅探文案）', async () => {
    const evaluated: string[][] = [];
    const worker = await makeWorker({
      entitySources: { currentMessage: CURRENT_MESSAGE },
      planCliRunner: planRunner(evaluated),
    });
    // 平台自己回了一段引用了宿主协议前缀的文本：按文案过滤会把这条真证据删掉
    appendToolResult(worker, toolResult(
      'call_echo',
      'RESULT {"v":1,"op":"finance.search-references","status":"completed","data":{"note":"worker 上次收到 PLAN DECLINED：ENTITY_OUT_OF_SCOPE","candidates":[{"id":"c_1","name":"猫一杯"}]}}',
      false,
    ));

    const verdict = await submit(
      worker,
      'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","胜利五金有限责任公司","--customer","猫一杯"]}]}',
      'call_scope_1',
    );

    expect(verdict?.reason).not.toContain(OUT_OF_SCOPE);
    expect(evaluated.some((args) => args[1] === 'evaluate')).toBe(true);
    worker.session.dispose();
  });

  it('平台错误信封（isError:true、CLI exit 3 形状）仍然是实体来源', async () => {
    const evaluated: string[][] = [];
    const worker = await makeWorker({
      entitySources: { currentMessage: CURRENT_MESSAGE },
      planCliRunner: planRunner(evaluated),
    });
    // bash 工具退出码非零时 throw → SDK 同样转成 isError tool_result。平台的真失败与宿主的
    // 拦截在这一列上完全同形，所以判据不能认 isError。
    appendToolResult(worker, toolResult(
      'call_failed',
      'Command exited with code 3\nRESULT {"v":1,"op":"finance.query-receivables","status":"failed","error":{"code":"REFERENCE_NOT_FOUND","message":"猫一杯 未登记"}}',
      true,
    ));

    const verdict = await submit(
      worker,
      'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","胜利五金有限责任公司","--customer","猫一杯"]}]}',
      'call_scope_1',
    );

    expect(verdict?.reason).not.toContain(OUT_OF_SCOPE);
    expect(evaluated.some((args) => args[1] === 'evaluate')).toBe(true);
    worker.session.dispose();
  });

  it('排除按 toolCallId 身份、不按 toolName（同一工具名下只有被拦的那条不算证据）', async () => {
    const evaluated: string[][] = [];
    const worker = await makeWorker({
      entitySources: { currentMessage: CURRENT_MESSAGE },
      planCliRunner: planRunner(evaluated),
    });
    const blocked = await submit(worker, OVERSCOPE_PLAN, 'call_scope_1');
    expect(blocked?.block).toBe(true);
    appendToolResult(worker, toolResult('call_scope_1', blocked?.reason ?? '', true));
    // 另一次 bash（未被拦）返回了实体名：toolName 与上面那条完全相同
    appendToolResult(worker, toolResult(
      'call_scope_1b',
      'RESULT {"v":1,"op":"finance.search-references","status":"completed","data":{"candidates":[{"id":"c_1","name":"猫一杯"}]}}',
      false,
    ));

    const verdict = await submit(
      worker,
      'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","胜利五金有限责任公司","--customer","猫一杯"]}]}',
      'call_scope_2',
    );

    expect(verdict?.reason).not.toContain(OUT_OF_SCOPE);
    worker.session.dispose();
  });

  it('宿主拦截路径抛异常的那一跳同样被排除（异常消息里的 token 不留作证据）', async () => {
    const evaluated: string[][] = [];
    // 只让第一跳抛：第二跳要能走到实体校验，才能看出异常消息有没有被当成证据
    let thrown = false;
    const worker = await makeWorker({
      entitySources: { currentMessage: CURRENT_MESSAGE },
      planCliRunner: planRunner(evaluated),
      onPlanSubmitted: (calls) => {
        if (thrown) return;
        thrown = true;
        throw new Error(`宿主结构化事实出口故障：${JSON.stringify(calls)}`);
      },
    });

    const failure = await submit(worker, OVERSCOPE_PLAN, 'call_throw').catch((error: Error) => error);
    expect((failure as Error).message).toContain('宿主结构化事实出口故障');
    // SDK 把 beforeToolCall 抛出的异常也转成 isError tool_result（正文 = 异常消息原样）。
    // 异常消息里带着 calls，于是越权 token 也在里面——不按身份排除它就留在了 haystack 里。
    appendToolResult(worker, toolResult('call_throw', (failure as Error).message, true));

    const verdict = await submit(worker, OVERSCOPE_PLAN, 'call_scope_2');

    expect(verdict?.reason).toContain(OUT_OF_SCOPE);
    worker.session.dispose();
  });
});

describe('实体门：本任务全部平台响应都是来源（D-085）', () => {
  /** 21 条响应：实体确立在最早那一条里。20 条窗口会把它静默掉出判定材料。 */
  function manyResponses(entityToolCallId: string, entity: string): unknown[] {
    return Array.from({ length: 21 }, (_unused, index) => toolResult(
      `call_${index}`,
      `RESULT {"v":1,"op":"x","status":"completed","data":{"n":${index}}}`,
      false,
    )).map((message, index) => (index === 0
      ? toolResult(entityToolCallId, `RESULT {"v":1,"op":"x","status":"completed","data":{"candidates":[{"name":"${entity}"}]}}`, false)
      : message));
  }

  it('第 21 条响应里确立的实体照样放行（条数窗口已删）', async () => {
    const evaluated: string[][] = [];
    const worker = await makeWorker({
      entitySources: { currentMessage: CURRENT_MESSAGE },
      planCliRunner: planRunner(evaluated),
    });
    worker.session.agent.state.messages = manyResponses('call_0', OVERSCOPE_TOKEN) as never;

    const verdict = await submit(worker, OVERSCOPE_PLAN, 'call_scope_1');

    expect(verdict?.reason).not.toContain(OUT_OF_SCOPE);
    expect(evaluated.some((args) => args[1] === 'evaluate')).toBe(true);
    worker.session.dispose();
  });

  it('名字不在任何响应里照样被拒（防幻觉功能不变）', async () => {
    const evaluated: string[][] = [];
    const worker = await makeWorker({
      entitySources: { currentMessage: CURRENT_MESSAGE },
      planCliRunner: planRunner(evaluated),
    });
    worker.session.agent.state.messages = manyResponses('call_0', '完全无关的另一个名字') as never;

    const verdict = await submit(worker, OVERSCOPE_PLAN, 'call_scope_1');

    expect(verdict?.reason).toContain(OUT_OF_SCOPE);
    expect(evaluated.some((args) => args[1] === 'evaluate')).toBe(false);
    worker.session.dispose();
  });

  it('单条响应按保尾截断：末行的信封不被切掉', async () => {
    const evaluated: string[][] = [];
    const worker = await makeWorker({
      entitySources: { currentMessage: CURRENT_MESSAGE },
      planCliRunner: planRunner(evaluated),
    });
    // SDK bash 工具保尾弃头（2000 行 / 50KB）：真实转录里信封在末行。读头会得到一段
    // "既不是开头、也没有信封"的噪声。
    const noise = `${'噪声行\n'.repeat(20_000)}`;
    worker.session.agent.state.messages = [toolResult('call_0', `${noise}${ENVELOPE_FOR_TOKEN}`, false)] as never;

    const verdict = await submit(worker, OVERSCOPE_PLAN, 'call_scope_1');

    expect(verdict?.reason).not.toContain(OUT_OF_SCOPE);
    worker.session.dispose();
  });

  it('自动压缩把早期响应摘出转录后，账本通道仍认得早期实体', async () => {
    const evaluated: string[][] = [];
    const worker = await makeWorker({
      entitySources: { currentMessage: CURRENT_MESSAGE },
      planCliRunner: planRunner(evaluated),
    });
    // 宿主账本：早前真正执行过的那一跳把实体带了回来（afterToolCall 记的）
    // 必须 await：宿主账本的记账点在 hook 内部（原 hook 之后再记），不等待就会在计划提交之后
    // 才落账——生产里 SDK 自己 await 它，测试里也得一样。
    await worker.session.agent.afterToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_early', type: 'toolCall', name: 'bash', arguments: { command: 'x' } } as never,
      args: { command: 'x' },
      result: { content: [{ type: 'text', text: ENVELOPE_FOR_TOKEN }], details: {} } as never,
      isError: false,
      context: {} as never,
    });
    // 压缩之后的忠实形状：[压缩摘要] + [保留尾段]，早期 toolResult 整条消失
    worker.session.agent.state.messages = [
      { role: 'compactionSummary', summary: '（早前对话摘要）', tokensBefore: 120_000, timestamp: 1 },
      toolResult('call_recent', 'RESULT {"v":1,"op":"x","status":"completed","data":{"n":1}}', false),
    ] as never;

    const verdict = await submit(worker, OVERSCOPE_PLAN, 'call_scope_1');

    expect(verdict?.reason).not.toContain(OUT_OF_SCOPE);
    expect(evaluated.some((args) => args[1] === 'evaluate')).toBe(true);
    worker.session.dispose();
  });

  it('宿主注入的 platformResponses 与转录通道合并（注入路径不变）', async () => {
    const evaluated: string[][] = [];
    const worker = await makeWorker({
      entitySources: {
        currentMessage: CURRENT_MESSAGE,
        platformResponses: ['【宿主主动回溯】tool_result：幻东 202609 余额 51 元'],
      },
      planCliRunner: planRunner(evaluated),
    });
    worker.session.agent.state.messages = [toolResult('call_0', ENVELOPE_FOR_TOKEN, false)] as never;

    const verdict = await submit(worker, OVERSCOPE_PLAN, 'call_scope_1');

    expect(verdict?.reason).not.toContain(OUT_OF_SCOPE);
    worker.session.dispose();
  });
});
