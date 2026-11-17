/**
 * P7a 交互式 ask（`npm run ask -- --interactive`）——测试先行（P7-T01）。
 *
 * 依据：R4 验收设计 §3 与 P7-T01「连续交互会话：同一 Session 连续回合；逐回合输出
 * （回复+机械证据）；exit 0」。owner 裁定 P7a 只做前置能力；真实模型 3 回合黑盒属
 * P7-E01（冒烟证据，不在此处冒充）。
 *
 * 本文件钉住的契约（实现前红）：
 *   · 单进程一个 Session：stdin 逐行 send，同一会话跨回合（会话 id 不变、任务同 scope）；
 *   · 逐回合输出「===== 回合 N =====」+ 回复 + 机械证据（委派/结构化执行/审计行）；
 *   · 空行跳过；EOF 结束；空回复视为回合失败（exit 1，如实记录不重试掩盖）；
 *   · `--interactive` 仍走 ask 同一装配门（缺密钥 → 五门金样 + exit 2）；
 *   · `--interactive` 不接受消息参数（fail-closed）。
 *
 * 交互循环的确定性验证：进程内用共享装配（assembleSessionCore）+ 假 driver 构造 Session，
 * 不经真实模型；动态 import 变量路径，实现前红（模块不存在）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import { assembleSessionCore } from './ask-runtime';
import { materializeEvalConfig } from './resolve-config-path';
import type { TurnDriver } from '../packages/agent/src/driver-contract';
import { assessEvalIsolation, assertEvalIsolation } from './eval/safety-gate';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');

const dirs: string[] = [];
function tempDir(prefix = 'p7a-interactive-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HOST_LEAK_KEYS = [
  'LLM_API_KEY', 'LLM_API_BASE_URL', 'LLM_MODEL', 'LLM_MAIN_MODEL',
  'LLM_THINKING_LEVEL', 'LLM_MAIN_THINKING_LEVEL', 'LLM_CONTEXT_WINDOW',
  'AGENT_CONFIG_PATH', 'DB_PATH', 'INIT_CWD',
];

/** 干净 env：缺省不带 LLM 密钥（交互确定性测试用假 driver，不需要真实模型）。 */
function sealedEnv(key?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of HOST_LEAK_KEYS) delete env[entry];
  env['TMPDIR'] ??= os.tmpdir();
  if (key !== undefined) env['LLM_API_KEY'] = key;
  return env;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runAsk(args: readonly string[], env: NodeJS.ProcessEnv = sealedEnv(), input = ''): CliResult {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/ask.ts', ...args],
    { cwd: REPO_ROOT, env, encoding: 'utf8', input },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

interface MainPlan {
  reply: string;
  delegate?: readonly { request: string }[];
}

/** 假 Main driver：按「最后一条用户消息」查计划；可委派（调用 runtime 注入的工具面）。 */
function fakeMainDriver(plans: ReadonlyMap<string, MainPlan>): TurnDriver {
  return {
    async run(input) {
      const last = input.messages[input.messages.length - 1] as { content?: unknown } | undefined;
      const text = typeof last?.content === 'string' ? last.content : '';
      const plan = plans.get(text) ?? { reply: `（未配置计划的回合：${text}）` };
      for (const step of plan.delegate ?? []) {
        const tool = input.tools[0];
        if (tool === undefined) throw new Error('Main 无工具面');
        await input.exec(tool.name, { task: step.request });
      }
      const messages = [...input.messages, { role: 'assistant', content: plan.reply } as never];
      return { text: plan.reply, messages };
    },
  };
}

/** 假 Worker driver：对 dummy.query 发起一次结构化调用后汇报固定摘要。 */
function fakeWorkerDriver(summary: string): TurnDriver {
  return {
    async run(input) {
      const tool = input.tools[0];
      if (tool === undefined) throw new Error('Worker 无工具面');
      await input.exec(tool.name, { operation: 'dummy.query', args: { collection: 'beta', window: 'W1' } });
      const messages = [...input.messages, { role: 'assistant', content: summary } as never];
      return { text: summary, messages };
    },
  };
}

/** 共享装配 + 假 driver：与生产 ask 同一装配核心，只是模型面确定性注入。 */
async function assembleForTest(input: {
  runtimeDir: string;
  sessionId: string;
  plans: ReadonlyMap<string, MainPlan>;
  workerSummary?: string;
}): Promise<Awaited<ReturnType<typeof assembleSessionCore>>> {
  const env = sealedEnv('test-key');
  const configCopy = path.join(input.runtimeDir, 'agent-config.yaml');
  mkdirSync(path.join(input.runtimeDir, 'db'), { recursive: true });
  materializeEvalConfig(FIXTURE_CONFIG, configCopy);
  const config = loadConfig({ yamlPath: configCopy, env });
  const env2 = effectiveDeploymentEnv(config, env);
  const profileIds = Object.keys(config.contextProfiles);
  const profile = config.contextProfiles[profileIds[0]!]!;
  return await assembleSessionCore({
    env: env2,
    profile,
    principalId: 'wecom:fixture-user',
    sessionId: input.sessionId,
    dbPath: path.join(input.runtimeDir, 'db', 'state.db'),
    stateDir: path.join(input.runtimeDir, 'state'),
    setAuditPath: true,
    assertIsolation: () => assertEvalIsolation(assessEvalIsolation({
      env: env2,
      platformRoot: profile.root,
      gateway: profile.gateway!,
    }), 'p7a interactive 测试'),
    emptyOperationsMessage: '（测试）执行层没有声明任何只读 operation',
    createDrivers: () => ({
      mainDriver: fakeMainDriver(input.plans),
      workerDriver: fakeWorkerDriver(input.workerSummary ?? 'beta 集合在窗口 W1 有 3 条记录。'),
    }),
  });
}

interface InteractiveModule {
  runInteractiveLoop: (input: Record<string, unknown>) => Promise<number>;
}

async function loadInteractiveModule(): Promise<InteractiveModule> {
  const modulePath: string = './ask-interactive';
  return await import(modulePath) as InteractiveModule;
}

describe('P7a 交互式 ask：进程内多轮循环（共享装配 + 假 driver）', () => {
  it('同一 Session 连续回合：逐回合输出回复与机械证据；exit 0', async () => {
    const dir = tempDir();
    const plans = new Map<string, MainPlan>([
      ['帮我查 beta 集合、窗口 W1 的数据', {
        reply: '已交办并完成：beta 集合在窗口 W1 有 3 条记录。',
        delegate: [{ request: '查询 beta 集合、窗口 W1 的数据' }],
      }],
      ['再确认一下', { reply: '刚才的任务已完成。' }],
    ]);
    const assembled = await assembleForTest({ runtimeDir: dir, sessionId: 's-interactive', plans });
    try {
      const { runInteractiveLoop } = await loadInteractiveModule();
      const output: string[] = [];
      const code = await runInteractiveLoop({
        session: assembled.session,
        lines: ['帮我查 beta 集合、窗口 W1 的数据', '', '再确认一下'],
        write: (line: string) => output.push(line),
        principalId: 'wecom:fixture-user',
        sessionId: 's-interactive',
        auditPath: assembled.auditPath,
      });

      const text = output.join('\n');
      expect(code, text).toBe(0);
      expect(text).toContain('===== 回合 1 =====');
      expect(text).toContain('===== 回合 2 =====');
      expect(text).not.toContain('===== 回合 3 =====');
      expect(text).toContain('已交办并完成：beta 集合在窗口 W1 有 3 条记录。');
      expect(text).toContain('刚才的任务已完成。');
      expect(text).toContain('===== 机械证据 =====');
      expect(text).toContain('委派=是');
      expect(text).toContain('委派=否');
      // 同一会话、同一底账 scope：唯一任务来自回合 1，回合 2 不产生新任务。
      expect(assembled.session.tasks()).toHaveLength(1);
      expect(assembled.session.tasks()[0]!.status).toBe('completed');
    } finally {
      assembled.close();
    }
  });

  it('空输入（EOF 立即结束）：exit 0，且无回合输出', async () => {
    const dir = tempDir();
    const assembled = await assembleForTest({ runtimeDir: dir, sessionId: 's-empty', plans: new Map() });
    try {
      const { runInteractiveLoop } = await loadInteractiveModule();
      const output: string[] = [];
      const code = await runInteractiveLoop({
        session: assembled.session,
        lines: [],
        write: (line: string) => output.push(line),
        principalId: 'wecom:fixture-user',
        sessionId: 's-empty',
      });
      expect(code).toBe(0);
      expect(output.join('\n')).not.toContain('===== 回合 1 =====');
    } finally {
      assembled.close();
    }
  });

  it('空回复视为回合失败：exit 1（如实记录，不重试掩盖）', async () => {
    const dir = tempDir();
    const plans = new Map<string, MainPlan>([['没有回复的一轮', { reply: '' }]]);
    const assembled = await assembleForTest({ runtimeDir: dir, sessionId: 's-empty-reply', plans });
    try {
      const { runInteractiveLoop } = await loadInteractiveModule();
      const output: string[] = [];
      const code = await runInteractiveLoop({
        session: assembled.session,
        lines: ['没有回复的一轮'],
        write: (line: string) => output.push(line),
        principalId: 'wecom:fixture-user',
        sessionId: 's-empty-reply',
      });
      expect(code).toBe(1);
      expect(output.join('\n')).toContain('回复为空');
    } finally {
      assembled.close();
    }
  });
});

describe('P7a 交互式 ask：CLI 面（同装配门；参数 fail-closed）', () => {
  it('缺 LLM_API_KEY：与单轮同一门话术逐字节，exit 2', () => {
    const result = runAsk(['--interactive']);
    expect(result.status, `stdout=${result.stdout}`).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('未检测到 LLM_API_KEY——ask 需要真实模型（密钥只在 .env，或配置 llm.apiKey）。\n');
  });

  it('--interactive 不接受消息参数：exit 2', () => {
    const result = runAsk(['你好', '--interactive']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--interactive 不接受消息参数');
  });
});
