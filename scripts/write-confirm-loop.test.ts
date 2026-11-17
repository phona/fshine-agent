/**
 * 写确认回环——业务级盲区用例（2026-11-17）。
 *
 * 业务场景：用户要求写入（新增记录）→ 执行层 prepare（dry-run，不带 --apply）→
 * 系统向用户交代「打算写什么」→ 用户确认 → commit → 读回验证写进去了 → 如实回报。
 *
 * 本文件做两件事：
 *   ① **已可断言的部分**（场景 4）：默认只读 principal 与写链路专用 principal 的写请求
 *      都在宿主发起执行前被确定性拒绝——零执行、零审计写行、数据原样。拒绝来自宿主
 *      允许集合（`本轮只开放只读操作`），不是模型自觉。
 *   ② **缺口登记**（场景 1–3）：当前装配没有「向用户要确认再继续同一任务」的通路，
 *      因此这三条只能先以 todo 形式登记（见文件末尾的 it.todo 与注释），不硬凑假确认。
 *
 * 现状证据（读代码 + 本用例实跑）：
 *   · 契约只声明 capabilities/execute，确认接口是**后续写切片**的注释方向
 *     （packages/contracts/src/execution-contract.ts:22-29、112-116）；
 *   · 最小切片明确「本切片不做：写 / 确认 / 产物回收」
 *     （packages/agent/src/execution-runtime.ts:49）；
 *   · Session 只有 send/tasks/getTask，没有确认/接续确认事件的方法
 *     （packages/agent/src/execution-runtime.ts:540-550）；
 *   · 装配的允许集合 = 执行层自述 access=read 的 operation
 *     （scripts/ask-runtime.ts:316-320）；principal 的 capabilities 是遗留数据位，
 *     运行时不消费（packages/contracts/src/config.ts:6-13）；
 *   · 仓内 dummy 夹具的状态化写面（prepare/commit/proposal/proposal-commit）在
 *     structured `call` 路由下也不可达：写 operation 一律按 prepare 模式裁决，
 *     dummy.commit 的 serve.prepare=false 被门拒；dummy.proposal 的位置参数在
 *     object→flat 转换时被拼成 `["payload", <path>]`，payload 被当成字面量 "payload"；
 *     proposal-commit 又需要宿主侧 gate secret/token，而适配器 spawn 只带
 *     PATH/HOME/TMPDIR 白名单（packages/agent/src/dummy-cli-client.ts:100-104、
 *     scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:681-745）。
 *
 * 边界：本文件只驱动仓内 dummy 夹具与假模型，不触真实 SaaS / 企微；写确认回环的
 * 操作授权、绑定、有效期与防重放仍必须归执行层（AGENTS.md「写确认回环 ≠ 宿主计划门」）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { loadConfig } from '@fshine/core';
import { createDummyCliClient } from '../packages/agent/src/dummy-cli-client';
import { createPiTurnDriver } from '../packages/agent/src/pi-driver';
import { createTaskRegistry } from '../packages/agent/src/task-registry';
import { createScriptedModelRuntime } from '../packages/agent/testing/scripted-model-runtime';
import { assembleSessionCore, resolveExecutionFace } from './ask-runtime';
import { materializeEvalConfig } from './resolve-config-path';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

/** 宿主允许集合的确定性拒绝话术（execution-runtime.ts:1185；不依赖模型自觉）。 */
const WRITE_NOT_ALLOWED_MESSAGE = '本轮只开放只读操作';
/** 夹具声明的写 operation（当前最小切片一个都不放进允许集合）。 */
const WRITE_OPERATIONS = ['dummy.prepare', 'dummy.commit', 'dummy.proposal', 'dummy.proposal-commit'] as const;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'write-confirm-loop-'): string {
  const dir = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function materializedConfig(dir: string) {
  const configPath = materializeEvalConfig(FIXTURE_CONFIG, path.join(dir, 'agent-config.yaml'));
  return loadConfig({ yamlPath: configPath, env: {} });
}

function toolCallAssistant(name: string, args: Record<string, unknown>, id: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
    api: 'openai-completions',
    provider: 'llm',
    model: 'test-model',
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function textAssistant(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'llm',
    model: 'test-model',
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

async function driverFor(script: (index: number) => AgentMessage | undefined) {
  const scripted = await createScriptedModelRuntime({ contextWindow: 40_000, script });
  return {
    scripted,
    driver: createPiTurnDriver({ env: { LLM_MODEL: 'test-model' }, modelRuntime: scripted.runtime }),
  };
}

interface WriteAttemptResult {
  taskStatus: string;
  /** 本回合的结构化执行事实条数（写请求必须为 0）。 */
  executionCount: number;
  /** Worker 看到的宿主拒绝原文（证明拒绝在发起执行前，且不靠模型遵守提示词）。 */
  workerSawRefusal: boolean;
  /** 审计行里出现写 operation 的行数（必须为 0）。 */
  auditWriteLines: number;
  /** 读回数据（宿主只读面；用于证明数据原样）。 */
  readback: { status: string; count?: number; itemNames?: string[] };
}

/**
 * 用真实装配（`assembleSessionCore` = ask/server 的共享核心）跑一次写请求：
 *   · 真 dummy 执行层（`bin/dummy`，per-case state-dir）；
 *   · 假 Main/Worker 模型（脚本化，零网络）；
 *   · Worker 明确尝试 `dummy.prepare`（带 collection/count；不带 --apply）。
 */
async function runWriteAttempt(principalId: string, dir: string): Promise<WriteAttemptResult> {
  const config = materializedConfig(dir);
  const profile = config.contextProfiles['dummy'];
  if (profile === undefined) throw new Error('fixture 配置缺少 dummy contextProfile');
  const stateDir = path.join(dir, 'state');

  const worker = await driverFor((index) => [
    toolCallAssistant(
      'execute_operation',
      { operation: 'dummy.prepare', args: { '--collection': 'alpha', '--count': 2 } },
      'call_worker_1',
    ),
    textAssistant('写入没有执行。'),
  ][index]);
  const main = await driverFor((index) => [
    toolCallAssistant('task_run', { task: '在 alpha 集合新增两条记录' }, 'call_main_1'),
    textAssistant('这次没有写入：当前只开放查询，没有发起任何写操作。'),
  ][index]);

  const assembled = await assembleSessionCore({
    env: { ...process.env },
    profile,
    principalId,
    sessionId: `s-${principalId.replace(/[^a-z0-9]+/gi, '-')}`,
    dbPath: path.join(dir, 'state.db'),
    stateDir,
    setAuditPath: true,
    emptyOperationsMessage: '执行层没有声明任何只读 operation——测试拒绝以空允许集合运行。',
    taskRegistry: createTaskRegistry(),
    mainSystemPrompt: '你是测试主 Agent。',
    workerSkills: [],
    createDrivers: async () => ({ mainDriver: main.driver, workerDriver: worker.driver }),
  });
  try {
    const turn = await assembled.session.send('帮我在 alpha 集合里新增两条记录');
    const task = assembled.session.tasks()[0];
    if (task === undefined) throw new Error('写请求没有产生任务行');
    const auditLines = existsSync(assembled.auditPath)
      ? readFileSync(assembled.auditPath, 'utf8').split('\n').filter((line) => line.trim() !== '')
      : [];
    const workerRequests = worker.scripted.requests();
    const lastWorkerRequest = JSON.stringify(workerRequests[workerRequests.length - 1] ?? {});

    // 独立读回：只走宿主只读 operation，验证数据没有被写。
    const readbackClient = createDummyCliClient({
      root: FIXTURE_ROOT,
      gateway: 'bin/dummy',
      stateDir,
      env: process.env,
    });
    const readbackOutcome = await readbackClient.execute({
      requestId: 'req_readback',
      dispatchKey: 'dispatch_readback',
      operation: 'dummy.query',
      args: { '--collection': 'alpha', '--window': 'W1' },
    });
    const readbackData = readbackOutcome.status === 'completed'
      ? readbackOutcome.data as { count?: number; items?: Array<{ name?: string }> }
      : {};

    return {
      taskStatus: task.status,
      executionCount: turn.executions.length,
      workerSawRefusal: lastWorkerRequest.includes(WRITE_NOT_ALLOWED_MESSAGE),
      auditWriteLines: auditLines.filter((line) => WRITE_OPERATIONS.some((operation) => line.includes(`"${operation}"`))).length,
      readback: {
        status: readbackOutcome.status,
        ...(readbackData.count === undefined ? {} : { count: readbackData.count }),
        ...(readbackData.items === undefined ? {} : { itemNames: readbackData.items.map((item) => String(item.name)) }),
      },
    };
  } finally {
    assembled.close();
  }
}

describe('场景 4：没有写权限的 principal → 确定性拒绝、零写入', () => {
  it('默认只读 principal（wecom:fixture-user）：写请求不发起执行，数据原样', async () => {
    const result = await runWriteAttempt('wecom:fixture-user', tempDir());

    // 业务事实：用户要写，系统一条写调用都没发。
    expect(result.executionCount).toBe(0);
    expect(result.taskStatus).toBe('unexecuted');
    // 拒绝是宿主允许集合给的，不是模型自觉。
    expect(result.workerSawRefusal).toBe(true);
    // 审计里没有任何写 operation 行。
    expect(result.auditWriteLines).toBe(0);
    // 读回数据原样（alpha/W1 种子 2 条；名称不变）。
    expect(result.readback).toEqual({
      status: 'completed',
      count: 2,
      itemNames: ['alpha-item-1', 'alpha-item-2'],
    });
  });

  it('写链路专用 principal（wecom:fixture-writer）：capabilities 有 write 也仍被只读允许集拒绝（缺口钉住）', async () => {
    const dir = tempDir();
    const config = materializedConfig(dir);

    // 配置事实：默认身份仍是只读；writer 身份声明了 write。
    expect(config.principals['wecom:fixture-user']?.capabilities).toEqual(['read']);
    expect(config.principals['wecom:fixture-writer']?.capabilities).toEqual(['read', 'write']);
    // 默认 principal 选择不变（第一个 enabled）。
    expect(Object.entries(config.principals).find(([, principal]) => principal.enabled)?.[0]).toBe('wecom:fixture-user');

    const result = await runWriteAttempt('wecom:fixture-writer', dir);
    // 缺口钉住：写确认切片未落地前，writer 身份的写请求同样在发起执行前被拒。
    // 这不是期望的产品行为——写确认环落地后，本用例必须由场景 1–3 的真实业务用例取代。
    expect(result.executionCount).toBe(0);
    expect(result.taskStatus).toBe('unexecuted');
    expect(result.workerSawRefusal).toBe(true);
    expect(result.auditWriteLines).toBe(0);
    expect(result.readback.count).toBe(2);
  });
});

describe('执行面派生（装配事实）：允许集合只含 access=read，写 operation 一个都不在', () => {
  it('resolveExecutionFace：allowedOperations === readOnlyOperations，且不含四个写 operation', async () => {
    const dir = tempDir();
    const config = materializedConfig(dir);
    const profile = config.contextProfiles['dummy'];
    if (profile === undefined) throw new Error('fixture 配置缺少 dummy contextProfile');

    const face = await resolveExecutionFace({
      profile,
      env: { ...process.env },
      stateDir: path.join(dir, 'state'),
      emptyOperationsMessage: '执行层没有声明任何只读 operation。',
    });
    expect(face.allowedOperations).toEqual(face.readOnlyOperations);
    for (const operation of WRITE_OPERATIONS) {
      expect(face.allowedOperations, `${operation} 在允许集合里 = 写面被接线`).not.toContain(operation);
    }
  });
});

/**
 * 场景 1–3 的真实业务用例当前**无法写**（红，不是跳过）：装配里没有「向用户要确认再继续
 * 同一任务」的通路。等写确认切片落地后，把下面的 todo 换成实际用例：
 *
 *   · 需要的契约面（契约头注释已给方向）：独立 confirm(requestId, confirmationId, decision)：
 *     执行层冻结待确认操作并验可信身份 / 操作绑定 / 有效期 / 防重放；宿主只采集并传递
 *     用户决策，不是携 token 重发 execute（execution-contract.ts:22-29）。
 *   · 需要宿主状态：任务在 prepare 后进入「待确认」（可复用 waiting_user/pendingQuestion，
 *     但须有机械的 kind 区分），确认事件到达后**宿主**发起 commit，而不是模型看到「确认」
 *     两个字就自己决定调 commit。
 *   · 需要执行层通路：仓内夹具的 prepare/commit/proposal 需在 structured call 下可达
 *     （写 operation 的 mode 裁决、proposal 位置参数、commit 绑定令牌），且 commit 后
 *     读回能看见新记录（dummy.commit 现在只加 records 计数、不追加 query items；
 *     proposal-commit 才追加 items 并返回 readBack{before,after,delta,required}）。
 */
describe('场景 1–3：写确认回环（当前装配无通路 → todo 登记）', () => {
  it.todo('场景 1：写请求 → prepare 被调用且不带 --apply（dry-run）；回复里能看出「准备写什么」');
  it.todo('场景 2：用户确认 → commit 恰好一次、读回查询能看到新记录、如实回报');
  it.todo('场景 3：用户不确认/改主意 → commit 零调用、数据不变');
});
