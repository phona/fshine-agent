/**
 * 部署配置装配接线（issue #20 切片 C+D）：config/agent.yaml 是源，非空 env 覆盖。
 *
 * 稳定性写法沿用 model-seam-wiring.test.ts：真工厂 + 最小真装配（临时 SQLite + 只含
 * principals 的最小 yaml；不配 contextProfiles → 无 platformRoot → 不触平台 lint 与
 * CLI，全程离线），只在 @fshine/agent 的工厂外包一层透传 spy 观察装配产物。
 * business skill 同样是透传 spy（记录装配下传的 env），行为仍走真实现。
 *
 * 红线（恒等 + 覆盖判据）：
 *   · 缺键时装配产物与切片前逐字段一致：Main 驱动 options 键恰为 [env]；worker 不传
 *     agentDir（驱动保持自己的 process.env 回落链）；平台闸 options 恰为 {maxQueue}。
 *   · yaml 值经 effectiveEnv 下传（驱动 / 渠道 / handler / business skill / 平台闸）。
 *   · 非空 env 覆盖 yaml；空串 env（node --env-file 的 `KEY=` 形态）不覆盖 yaml。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPiCodingTurnDriver,
  createPiTurnDriver,
  createPlatformExecutionGate,
  type TurnDriver,
} from '@fshine/agent';
import { loadBusinessSkill } from './business-skill';

vi.mock('@fshine/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fshine/agent')>();
  return {
    ...actual,
    // 透传 spy：只记录入参，实现仍是真工厂（构造只注册模型不发请求）。
    createPiTurnDriver: vi.fn(actual.createPiTurnDriver),
    createPiCodingTurnDriver: vi.fn(actual.createPiCodingTurnDriver),
    createPlatformExecutionGate: vi.fn(actual.createPlatformExecutionGate),
  };
});

vi.mock('./business-skill', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./business-skill')>();
  // 透传 spy：真实文件加载被替换成固定成功值，只用于核对装配下传的 env。
  return { ...actual, loadBusinessSkill: vi.fn(async () => ({ path: 'stubbed-business-skill.md' })) };
});

import { createServerAssembly, type ServerAssembly } from './assembly';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

const MINIMAL_PRINCIPALS = [
  'principals:',
  '  wecom:cfg_user:',
  '    accountSetScope: all',
  '    enabled: true',
];

/** 最小装配夹具：yaml 只含 principals + 本用例追加段（无 profile → 离线构造）。 */
function configFile(extraYaml: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'deployment-config-wiring-'));
  roots.push(root);
  const file = path.join(root, 'agent.yaml');
  writeFileSync(file, [...MINIMAL_PRINCIPALS, extraYaml].join('\n'));
  return file;
}

async function boot(configPath: string, env: Record<string, string> = {}): Promise<ServerAssembly> {
  const dbPath = path.join(path.dirname(configPath), `agent-${Math.random().toString(36).slice(2)}.db`);
  return createServerAssembly({ env: { AGENT_CONFIG_PATH: configPath, ...env }, dbPath });
}

function mainCall(): { env: Record<string, string | undefined>; modelId?: string; thinkingLevel?: string } {
  const call = vi.mocked(createPiTurnDriver).mock.calls.at(-1);
  if (!call) throw new Error('createPiTurnDriver 未被装配调用');
  return call[0]! as { env: Record<string, string | undefined>; modelId?: string; thinkingLevel?: string };
}

function workerCall(): { env: Record<string, string | undefined>; agentDir?: string } {
  const call = vi.mocked(createPiCodingTurnDriver).mock.calls.at(-1);
  if (!call) throw new Error('createPiCodingTurnDriver 未被装配调用');
  return call[0]! as { env: Record<string, string | undefined>; agentDir?: string };
}

function gateCall(): { maxQueue: number } {
  const call = vi.mocked(createPlatformExecutionGate).mock.calls.at(-1);
  if (!call) throw new Error('createPlatformExecutionGate 未被装配调用');
  return call[0]! as { maxQueue: number };
}

/** 行为级核对：pi 驱动闭包捕获的 modelId 写进合成消息。 */
function capturedModelId(driver: TurnDriver): string {
  const message = driver.synthesizeAssistant?.('cfg-probe') as { model?: string } | undefined;
  if (!message) throw new Error('pi 驱动未实现 synthesizeAssistant');
  return message.model ?? '';
}

function mainDriver(): TurnDriver {
  const result = vi.mocked(createPiTurnDriver).mock.results.at(-1);
  if (!result || result.type !== 'return') throw new Error('createPiTurnDriver 未被装配成功调用');
  return result.value;
}

const BASE_ENV = {
  LLM_API_BASE_URL: 'http://127.0.0.1:9',
  LLM_API_KEY: 'cfg-test-key',
  LLM_MODEL: 'env-worker-model',
};

describe('部署配置装配（config/agent.yaml → effectiveEnv → 既有 env 消费面）', () => {
  it('恒等：缺键时装配产物与切片前一致（driver options / 平台闸 options 不新增字段）', async () => {
    const configPath = configFile('');
    const assembly = await boot(configPath, BASE_ENV);
    await assembly.close();

    // Main 驱动：不新增任何参数，env 内容 = 注入 env。宿主不声明法域。
    const mainOptions = mainCall();
    expect(Object.keys(mainOptions)).toEqual(['env']);
    expect(mainOptions.env).toEqual({ AGENT_CONFIG_PATH: configPath, ...BASE_ENV });
    expect(mainOptions.env['EXECUTION_SERVE']).toBeUndefined();
    // yaml 未配置的 FSHINE_* 键没有被伪造出来。
    expect(mainOptions.env['FSHINE_PLATFORM_QUEUE_CAPACITY']).toBeUndefined();
    expect(mainOptions.env['FSHINE_PI_AGENT_DIR']).toBeUndefined();

    // worker：不传 agentDir（保持驱动的 process.env → <cwd>/data/pi-agent 回落链），
    // options 键集与切片前一致（只有装配原有四项，不因部署配置扩展长出新字段）。
    const workerOptions = workerCall();
    expect(workerOptions).not.toHaveProperty('agentDir');
    expect(Object.keys(workerOptions)).toEqual(['env', 'planActivationSecret', 'onExecutorBypassed', 'serveGateAudit']);
    expect(workerOptions.env['LLM_MODEL']).toBe('env-worker-model');

    // 平台闸：未配置时 options 恰为 {maxQueue}（与旧装配逐字段一致）。
    expect(gateCall()).toEqual({ maxQueue: 100 });
  });

  it('yaml 值经 effectiveEnv 下传：driver / 渠道 / handler / business skill / 平台闸', async () => {
    const assembly = await boot(configFile([
      'llm:',
      '  apiBaseUrl: http://127.0.0.1:9',
      '  apiKey: yaml-key',
      '  model: yaml-worker-model',
      '  mainModel: yaml-main-model',
      '  thinkingLevel: high',
      '  mainThinkingLevel: low',
      'wecom:',
      '  botId: yaml-bot-id',
      '  botSecret: yaml-bot-secret',
      'host:',
      '  platformQueueCapacity: 7',
      '  shutdownDrainMs: 1234',
      '  workerDispatchMode: inline',
      '  workerStepCap: 12',
      '  inboundDebounceMs: 0',
      '  piAgentDir: /tmp/cfg-pi-agent',
      'execution:',
      '  planActivationSecret: yaml-plan-secret',
      'businessSkillPath: docs/business-skill.md',
      '',
    ].join('\n')));
    await assembly.close();

    // Main 驱动：yaml 的模型 / 思考深度生效（行为级 + options 级）。
    const mainOptions = mainCall();
    expect(mainOptions.env['LLM_MODEL']).toBe('yaml-worker-model');
    expect(mainOptions.env['LLM_API_KEY']).toBe('yaml-key');
    expect(mainOptions.modelId).toBe('yaml-main-model');
    expect(mainOptions.thinkingLevel).toBe('low');
    expect(capturedModelId(mainDriver())).toBe('yaml-main-model');

    // worker：仍走 LLM_MODEL；Pi 会话目录以显式 option 下传（驱动不自读 yaml）。
    const workerOptions = workerCall();
    expect(workerOptions.env['LLM_MODEL']).toBe('yaml-worker-model');
    expect(workerOptions.agentDir).toBe('/tmp/cfg-pi-agent');
    expect(workerOptions.env['FSHINE_WORKER_STEP_CAP']).toBe('12');
    expect(workerOptions.env['FSHINE_PLATFORM_QUEUE_CAPACITY']).toBe('7');
    expect(workerOptions.env['FSHINE_INBOUND_DEBOUNCE_MS']).toBe('0');

    // 平台闸 options 显式带上 yaml 派生值（门的读取点默认是 process.env）。
    expect(gateCall()).toEqual({ maxQueue: 7 });

    // 渠道：adapter 的读取面是 env，装配必须把 effectiveEnv 传下去。
    const channelEnv = (assembly.channel as unknown as { env: NodeJS.ProcessEnv }).env;
    expect(channelEnv['WECOM_BOT_ID']).toBe('yaml-bot-id');
    expect(channelEnv['WECOM_BOT_SECRET']).toBe('yaml-bot-secret');

    // business skill：加载器收到同一份 effectiveEnv（BUSINESS_SKILL_PATH 已派生）。
    const skillCall = vi.mocked(loadBusinessSkill).mock.calls.at(-1);
    expect(skillCall?.[0]?.['BUSINESS_SKILL_PATH']).toBe('docs/business-skill.md');

    // 装配对外状态：委派模式、计划密钥、停机排干都来自 yaml。
    expect(assembly.workerDispatchMode).toBe('inline');
    expect(assembly.planActivationSecret).toBe('yaml-plan-secret');
    expect(assembly.effectiveEnv['FSHINE_SHUTDOWN_DRAIN_MS']).toBe('1234');
  });

  it('非空 env 覆盖 yaml；空串 env 不覆盖 yaml（node --env-file 的 KEY= 形态）', async () => {
    const yaml = [
      'llm:',
      '  apiBaseUrl: http://127.0.0.1:9',
      '  apiKey: yaml-key',
      '  model: yaml-worker-model',
      'host:',
      '  platformQueueCapacity: 7',
      '',
    ].join('\n');

    const overridden = await boot(configFile(yaml), { ...BASE_ENV, LLM_MODEL: 'env-wins-model', FSHINE_PLATFORM_QUEUE_CAPACITY: '9' });
    await overridden.close();
    expect(workerCall().env['LLM_MODEL']).toBe('env-wins-model');
    expect(workerCall().env['FSHINE_PLATFORM_QUEUE_CAPACITY']).toBe('9');
    expect(gateCall()).toEqual({ maxQueue: 9 });

    vi.clearAllMocks();
    const blank = await boot(configFile(yaml), { ...BASE_ENV, LLM_MODEL: '', LLM_API_KEY: '', FSHINE_PLATFORM_QUEUE_CAPACITY: '' });
    await blank.close();
    // 空串按未配置：yaml 值生效（apiKey 回落到 yaml；model 回落到 yaml）。
    expect(workerCall().env['LLM_MODEL']).toBe('yaml-worker-model');
    expect(workerCall().env['LLM_API_KEY']).toBe('yaml-key');
    expect(workerCall().env['FSHINE_PLATFORM_QUEUE_CAPACITY']).toBe('7');
    expect(gateCall()).toEqual({ maxQueue: 7 });
  });

  it('store.dbPath 是宿主库路径源；非空 DB_PATH 覆盖；overrides.dbPath 仍最高优先', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'deployment-config-db-'));
    roots.push(root);
    const fromYamlDb = path.join(root, 'yaml-agent.db');
    const fromEnvDb = path.join(root, 'env-agent.db');
    const fromOverrideDb = path.join(root, 'override-agent.db');
    const configPath = path.join(root, 'agent.yaml');
    writeFileSync(configPath, [
      ...MINIMAL_PRINCIPALS,
      'store:',
      `  dbPath: ${fromYamlDb}`,
      '',
    ].join('\n'));

    // yaml 源：未设 DB_PATH 时装配用 store.dbPath。
    const fromYaml = await createServerAssembly({ env: { AGENT_CONFIG_PATH: configPath, ...BASE_ENV } });
    expect(fromYaml.dbPath).toBe(fromYamlDb);
    await fromYaml.close();

    // 非空 env 覆盖 yaml。
    const fromEnv = await createServerAssembly({
      env: { AGENT_CONFIG_PATH: configPath, ...BASE_ENV, DB_PATH: fromEnvDb },
    });
    expect(fromEnv.dbPath).toBe(fromEnvDb);
    await fromEnv.close();

    // 测试 / e2e harness 的显式注入（overrides.dbPath）仍高于配置链。
    const fromOverride = await createServerAssembly({
      env: { AGENT_CONFIG_PATH: configPath, ...BASE_ENV, DB_PATH: fromEnvDb },
      dbPath: fromOverrideDb,
    });
    expect(fromOverride.dbPath).toBe(fromOverrideDb);
    await fromOverride.close();
  });
});
