/**
 * 思考档装配接线守卫（owner 决定：Main=high、Worker=medium）。
 *
 * 缺口本体（实现前）：`llm.mainThinkingLevel` / `LLM_MAIN_THINKING_LEVEL` 在产品代码里
 * 一处没读——装配两处 createPiTurnDriver 都只吃驱动内的缺省解析（LLM_THINKING_LEVEL），
 * Main 与 Worker 共用同一档；写错的 Main 档位被静默忽略、退成缺省值。
 *
 * 判据（断言的是**驱动实际交给 Pi 会话、并真的发到 provider 的档位**，不是配置对象）：
 *  ① 真装配（`assembleSessionCore` 缺省分支；createPiTurnDriver 只注入脚本化 ModelRuntime、
 *     不替换解析逻辑）构造的两条驱动，各跑一个真回合后：
 *     Main 驱动向 provider 发出的 reasoning='high'；Worker 驱动发出 'medium'；
 *  ② 回落：只设 LLM_THINKING_LEVEL 时 Main 与 Worker 同档（Main 不出现"无档位"）；
 *  ③ fail-fast：非法档位在装配期抛中文错误点名变量（Main/Worker 两侧都不静默降级）。
 *
 * 反向绊线：删掉装配点 `...mainThinkingLevelFrom(...)`（或把 Main 侧换回缺省解析）→ ①/② 必红。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import { assembleSessionCore } from './ask-runtime';
import { materializeEvalConfig } from './resolve-config-path';
import { createScriptedModelRuntime, SCRIPTED_MODEL_ID } from '../packages/agent/testing/scripted-model-runtime';
import { PI_THINKING_LEVELS } from '../packages/agent/src/pi-driver';
import type { TurnDriver } from '../packages/agent/src/driver-contract';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');

const HOST_LEAK_KEYS = [
  'LLM_API_KEY', 'LLM_API_BASE_URL', 'LLM_MODEL', 'LLM_MAIN_MODEL',
  'LLM_THINKING_LEVEL', 'LLM_MAIN_THINKING_LEVEL', 'LLM_CONTEXT_WINDOW',
  'AGENT_CONFIG_PATH', 'DB_PATH', 'INIT_CWD',
];

const dirs: string[] = [];
function tempDir(prefix = 'ask-thinking-level-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 记录装配实际构造出的驱动选项与实例（只包一层：解析/会话逻辑仍是真驱动）。 */
const rec = vi.hoisted(() => ({
  options: [] as Array<{ thinkingLevel?: string; reuseConversation?: boolean }>,
  runtimes: [] as Array<{ runtime: unknown }>,
  drivers: [] as unknown[],
}));

vi.mock('../packages/agent/src/pi-driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../packages/agent/src/pi-driver')>();
  return {
    ...actual,
    // 只替换构造入口：把脚本化 ModelRuntime 注入真驱动（零网络），解析与回合逻辑全是真的。
    createPiTurnDriver: (options: import('../packages/agent/src/pi-driver').PiTurnDriverOptions) => {
      const index = rec.options.length;
      rec.options.push(options);
      const scripted = rec.runtimes[index];
      const driver = actual.createPiTurnDriver(
        scripted === undefined
          ? options
          : { ...options, modelRuntime: scripted.runtime as import('@earendil-works/pi-coding-agent').ModelRuntime },
      );
      rec.drivers.push(driver);
      return driver;
    },
  };
});

function sealedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of HOST_LEAK_KEYS) delete env[key];
  env['TMPDIR'] ??= os.tmpdir();
  env['LLM_MODEL'] = SCRIPTED_MODEL_ID;
  env['LLM_API_KEY'] = 'thinking-level-test-key';
  env['LLM_API_BASE_URL'] = 'http://127.0.0.1:9/v1';
  return env;
}

interface AssembledDrivers {
  mainDriver: TurnDriver;
  workerDriver: TurnDriver;
}

/** 生产装配（缺省分支，不传 createDrivers）× 脚本化模型运行时的两条真驱动。 */
async function assembleProductionDrivers(thinking: {
  thinkingLevel?: string;
  mainThinkingLevel?: string;
}): Promise<AssembledDrivers> {
  rec.options = [];
  rec.runtimes = [];
  rec.drivers = [];
  const dir = tempDir();
  const env = sealedEnv();
  if (thinking.thinkingLevel !== undefined) env['LLM_THINKING_LEVEL'] = thinking.thinkingLevel;
  if (thinking.mainThinkingLevel !== undefined) env['LLM_MAIN_THINKING_LEVEL'] = thinking.mainThinkingLevel;
  const configCopy = path.join(dir, 'agent-config.yaml');
  mkdirSync(path.join(dir, 'db'), { recursive: true });
  materializeEvalConfig(FIXTURE_CONFIG, configCopy);
  const config = loadConfig({ yamlPath: configCopy, env });
  const effective = effectiveDeploymentEnv(config, env);
  const profileId = Object.keys(config.contextProfiles)[0]!;
  rec.runtimes = [
    await createScriptedModelRuntime({ reasoning: true, script: () => assistant('好的。') }),
    await createScriptedModelRuntime({ reasoning: true, script: () => assistant('好的。') }),
  ];
  const assembled = await assembleSessionCore({
    env: effective,
    profile: config.contextProfiles[profileId]!,
    principalId: 'wecom:fixture-user',
    sessionId: 's-thinking-level',
    dbPath: path.join(dir, 'db', 'state.db'),
    stateDir: path.join(dir, 'state'),
    setAuditPath: true,
    emptyOperationsMessage: '（测试）执行层没有声明任何 operation',
  });
  expect(rec.options, '缺省装配必须恰构造 Main/Worker 两条驱动').toHaveLength(2);
  assembled.close();
  return { mainDriver: rec.drivers[0] as TurnDriver, workerDriver: rec.drivers[1] as TurnDriver };
}

function assistant(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'llm',
    model: SCRIPTED_MODEL_ID,
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function turnInput(text: string) {
  return {
    systemPrompt: '你是助手。',
    tools: [],
    messages: [{ role: 'user', content: text } as unknown as AgentMessage],
    onStep: () => {},
    exec: async () => undefined,
    deadline: Date.now() + 60_000,
  };
}

describe('思考档装配接线（Main=llm.mainThinkingLevel、Worker=llm.thinkingLevel）', () => {
  it('① Main 驱动实际发出 reasoning=high、Worker 实际发出 reasoning=medium（真装配 + 真回合）', async () => {
    const env = { thinkingLevel: 'medium', mainThinkingLevel: 'high' } as const;
    const { mainDriver, workerDriver } = await assembleProductionDrivers(env);
    // 装配交给驱动的选项：Main 显式 high；Worker 不注入（缺省解析 = llm.thinkingLevel）。
    expect(rec.options[0]?.thinkingLevel, 'Main 驱动必须收到显式 high').toBe('high');
    expect(rec.options[0]?.reuseConversation, 'Main 驱动必须是实例级会话（reuseConversation）').toBe(true);
    expect(rec.options[1]?.thinkingLevel, 'Worker 驱动不注入显式档位（缺省解析 llm.thinkingLevel）').toBeUndefined();

    // 真回合：档位必须真的发到 provider（推理档位不是配置对象上的一句话）。
    await mainDriver.run(turnInput('你好'));
    await workerDriver.run(turnInput('你好'));
    const mainRt = rec.runtimes[0] as unknown as { reasoningLevels(): readonly (string | undefined)[] };
    const workerRt = rec.runtimes[1] as unknown as { reasoningLevels(): readonly (string | undefined)[] };
    expect(mainRt.reasoningLevels(), 'Main 的模型请求必须带 reasoning=high').toEqual(['high']);
    expect(workerRt.reasoningLevels(), 'Worker 的模型请求必须带 reasoning=medium').toEqual(['medium']);
  });

  it('② 回落：只设 LLM_THINKING_LEVEL 时 Main 与 Worker 同档（Main 不出现「无档位」）', async () => {
    const { mainDriver, workerDriver } = await assembleProductionDrivers({ thinkingLevel: 'medium' });
    expect(rec.options[0]?.thinkingLevel, 'Main 必须回落到 llm.thinkingLevel，不允许出现无档位').toBe('medium');
    await mainDriver.run(turnInput('你好'));
    await workerDriver.run(turnInput('你好'));
    const mainRt = rec.runtimes[0] as unknown as { reasoningLevels(): readonly (string | undefined)[] };
    const workerRt = rec.runtimes[1] as unknown as { reasoningLevels(): readonly (string | undefined)[] };
    expect(mainRt.reasoningLevels()).toEqual(['medium']);
    expect(workerRt.reasoningLevels()).toEqual(['medium']);
  });

  it('③ fail-fast：非法档位在装配期抛中文错误点名变量，不静默降级（Main/Worker 两侧）', async () => {
    // 档位词表必须容纳 owner 设定值（不在词表 = 装配期直接抛错）。
    expect(PI_THINKING_LEVELS as readonly string[]).toContain('high');
    expect(PI_THINKING_LEVELS as readonly string[]).toContain('medium');
    // Main 侧：装配构造 Main 驱动时即抛。
    await expect(assembleProductionDrivers({ thinkingLevel: 'medium', mainThinkingLevel: 'higher' }))
      .rejects.toThrow('LLM_MAIN_THINKING_LEVEL');
    // Worker 侧：驱动构造期解析 LLM_THINKING_LEVEL 即抛。
    await expect(assembleProductionDrivers({ thinkingLevel: 'hig' }))
      .rejects.toThrow('LLM_THINKING_LEVEL');
  });
});
