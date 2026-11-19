/**
 * P1 事实文本去内部词（PM/QA 真模型验收）：源头修复的回归锁。
 *
 * 判据（每条含反向绊线，实测读数见文件末）：
 *   ① 完成事实 taskCompletionFactText 不含「执行层/执行端」，且保留「办完了」+ 结果正文逐字；
 *   ② 失败归类原因（task-registry 合成）不含内部词，且保留末条状态与对方说法；
 *   ③ 模型协议提示（工具描述/协议/Worker 提示/默认称谓）不含内部词——这些字符串进模型上下文，
 *      模型会照着说（真模型实跑证据里出现过「执行层给出的确认摘要」「执行端写入后已读回核对」）；
 *   ④ 超时回执事实（dummy-cli 适配器）不含内部词，且保留超时数值、没有回执、无法确认语义。
 *
 * 不判措辞质量、不接线黑名单（owner 明确否掉字符匹配拦截）——只钉「已知字符串存在性/不存在性」：
 * 内部词是确定性事实（不该出现在给模型/用户的文本里），不是模型行为评估。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { taskCompletionFactText } from './task-completion-delivery';
import { judgeReportedTask } from '../../packages/agent/src/task-registry';
import { createDummyCliClient } from '../../packages/agent/src/dummy-cli-client';
import {
  TASK_RUN_TOOL_DESCRIPTION,
  TASK_RUN_TOOL_SCHEMA,
  MAIN_PROTOCOL_NOTE,
  MAIN_PROTOCOL_NOTE_WITH_WRITES,
  WORKER_SYSTEM_PROMPT,
  TASK_CANCEL_TOOL_DESCRIPTION,
} from '../../packages/agent/src/execution-runtime';
import { DEFAULT_EXECUTOR_LABEL } from '../../packages/agent/src/agent-profile';

const INTERNAL = /执行层|执行端/;

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
    it(`${name} 不含「执行层/执行端」`, () => {
      expect(text).not.toMatch(INTERNAL);
    });
  }
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
  it('④ execute 超时回执：无「执行层/执行端」，保留超时数值、没有回执、无法确认语义', async () => {
    const message = await timeoutMessage();
    expect(message).not.toMatch(INTERNAL);
    expect(message).toMatch(/120\s*ms/);       // 超时数值保留
    expect(message).toContain('没有收到回执');      // "没有回执" 事实保留
    expect(message).toContain('无法确认');          // 不确定性语义保留（不能变成「没办成」）
    expect(message).toContain('是否');
  });
});

/**
 * 反向绊线（亲跑验证，实测见下）：
 *   · 把 taskCompletionFactText 的「办完了」改回「已由执行端确认完成」→ ① 红（内部词命中 + 丢「办完了」）；
 *   · 把 dummy-cli-client.ts 的 execute 超时 message 改回「执行层调用超时…」→ ④ 红（内部词命中）；
 *   · 把 MAIN_PROTOCOL_NOTE_WITH_WRITES 任一条改回带「执行层」→ ③ 对应用例红。
 * 用例断言一字未改即可复现；恢复后全绿。
 */
