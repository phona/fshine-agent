import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai/compat';
import { createPiCodingWorkerSession } from './src/pi-coding-driver';

// gateway 透传的回归锁（2026-11-08 评审 major）：createPiCodingWorkerSession 的
// loadCurrentActivePlan（会话恢复问"当前有没有激活计划"）与 evaluateAndActivatePlan
// （计划提交）两处调用点，在**未注入 planCliRunner** 时必须走默认 runner，而默认 runner
// 用配置的 gateway spawn 网关（C7b 起缺声明即 fail-closed 抛错）。此前的测试全部注入
// planCliRunner，绕开的恰是这条默认路径——漏传时生产表现为"每次计划提交都以 PLAN
// DECLINED（网关未声明）收场、平台一次都没执行"，人工探针记录挡不住复发。
// 测法 = 假网关可执行文件：记录每次调用的 argv 到日志文件，按子命令回最小合法响应。
// 两个调用点各被真实 spawn 一次，日志即证据。

const roots: string[] = [];
const logs: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(logs.splice(0).map((log) => rm(log, { force: true })));
});

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

/** 在 root 下造一个假网关：bin/<name>，把 argv 追加进 logPath，按子命令回最小合法信封。 */
async function plantFakeGateway(root: string, logPath: string): Promise<string> {
  await mkdir(path.join(root, 'bin'), { recursive: true });
  const gateway = path.join(root, 'bin', 'fake-gateway');
  await writeFile(gateway, [
    '#!/bin/sh',
    `echo "$@" >> "${logPath}"`,
    'if [ "$1" = "plan" ] && [ "$2" = "current" ]; then',
    '  printf \'{"taskId":"%s","planId":null,"version":null,"status":"none"}\\n\' "$4"',
    'elif [ "$1" = "plan" ] && [ "$2" = "evaluate" ]; then',
    '  cat > /dev/null',
    '  printf \'{"decision":"stop","reasonCode":"test_stop","estimate":{"calls":1,"seconds":1,"weight":0}}\\n\'',
    'fi',
    '',
  ].join('\n'));
  await chmod(gateway, 0o755);
  return gateway;
}

async function gatewayLogLines(logPath: string): Promise<string[]> {
  try {
    const text = await readFile(logPath, 'utf8');
    return text.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe('gateway 透传：未注入 planCliRunner 时默认 runner 用配置的 gateway spawn', () => {
  it('会话恢复的 plan current 走默认 runner + 配置 gateway（漏传则恢复路径断在第一跳）', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-gw-resume-'));
    const logPath = path.join(root, 'gateway.log');
    roots.push(root);
    logs.push(logPath);
    await plantFakeGateway(root, logPath);
    const modelConfig = await fakeModelRuntime();

    // 不传 planCliRunner——正是生产装配的形态（工厂不注入，走默认 runner）。
    const worker = await createPiCodingWorkerSession({
      gateway: 'bin/fake-gateway',
      cwd: root,
      skillRoots: [],
      systemPrompt: 'gateway threading test',
      sessionId: 'task_gw_resume',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
    });

    const lines = await gatewayLogLines(logPath);
    // 恢复问话必须在场（漏传 gateway 时默认 runner 在 spawn 前 fail-closed 抛错，本行不存在）。
    // 同批还有 5 张派生表的 operation list（label/args 规格/语义/协议/能力清单）——C7b 起
    // 它们与 serve 门共用同一份 profile.gateway，一并走默认 runner，正是这条透传的覆盖证据。
    expect(lines).toContain('plan current --task-id task_gw_resume');
    expect(lines.filter((line) => line === 'operation list').length).toBeGreaterThanOrEqual(1);
    worker.session.dispose();
  });

  it('计划提交的 plan evaluate 走默认 runner + 配置 gateway（漏传则每次提交都 PLAN DECLINED）', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-gw-submit-'));
    const logPath = path.join(root, 'gateway.log');
    roots.push(root);
    logs.push(logPath);
    await plantFakeGateway(root, logPath);
    const modelConfig = await fakeModelRuntime();

    const worker = await createPiCodingWorkerSession({
      gateway: 'bin/fake-gateway',
      cwd: root,
      skillRoots: [],
      systemPrompt: 'gateway threading test',
      sessionId: 'task_gw_submit',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
    });

    const command = 'bin/fake-gateway plan {"goal":"read one record","calls":[{"operation":"dummy.query","args":["--collection","alpha"]}]}';
    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_gw_1', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });

    const lines = await gatewayLogLines(logPath);
    // 两个调用点各留下一次真实 spawn：恢复问话 + 计划提交的 evaluate（stdin 走管道不进 argv）。
    expect(lines).toContain('plan current --task-id task_gw_submit');
    expect(lines.some((line) => /^plan evaluate --task-id task_gw_submit --stdin$/.test(line))).toBe(true);
    // 假网关回 stop 档 → 宿主拦截并给出计划类拒绝（证明 evaluate 真的跑通过一遍）。
    expect(verdict?.block).toBe(true);
    worker.session.dispose();
  });
});
