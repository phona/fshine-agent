/**
 * 分层模型接缝的装配接线测试（LLM_MAIN_MODEL / LLM_MAIN_THINKING_LEVEL）。
 *
 * 旋钮语义：Main Agent 可单独配更快的模型，执行层 worker 保持强模型（LLM_MODEL）；
 * 只做接缝、默认行为零变化——真要换哪个模型是选型决策，不属于这里。
 *
 * 写法沿用 plan-confirmation-wiring.test.ts：真工厂 + 最小真装配（临时 SQLite + 只含
 * principals 的最小 yaml；不配 contextProfiles → 无 platformRoot → 不触平台 lint 与
 * CLI，全程离线），只在 @fshine/agent 的两个驱动工厂外包一层透传 spy 观察装配产物。
 * 工厂行为零改动：spy 只记录入参，实现原样转发真工厂——模型 id 还能用驱动自己的
 * synthesizeAssistant 做行为级核对（pi-driver 把闭包捕获的 modelId 写进合成消息）。
 *
 * 恒等红线（变异锁）：不设 LLM_MAIN_MODEL 时，createPiTurnDriver 收到的 options 键必须
 * 恰为 ['env']——装配产物与接缝落地前逐字段一致。把回落逻辑改反（LLM_MAIN_MODEL 有值
 * 时让 worker 拿到它）会让"worker 仍收 LLM_MODEL"断言当场变红。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPiCodingTurnDriver, createPiTurnDriver, type TurnDriver } from '@fshine/agent';

vi.mock('@fshine/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fshine/agent')>();
  return {
    ...actual,
    // 透传 spy：记录装配传入的 options，实现仍是真工厂（构造只注册模型不发请求，
    // worker 的模型解析惰性到首次回合——离线构造安全）。
    createPiTurnDriver: vi.fn(actual.createPiTurnDriver),
    createPiCodingTurnDriver: vi.fn(actual.createPiCodingTurnDriver),
  };
});

import { createServerAssembly } from './assembly';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

/** 最小装配夹具：除授权名单外什么都不配（无 platformRoot → 不触平台 lint/CLI，离线构造）。 */
function seamEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'model-seam-wiring-'));
  roots.push(root);
  writeFileSync(path.join(root, 'agent.yaml'), [
    '# 最小配置：只要 principals 能过 loadConfig；LLM 变量在测试传的 env 里',
    'principals:',
    '  wecom:seam_user:',
    '    accountSetScope: all',
    '    enabled: true',
    '',
  ].join('\n'));
  return {
    AGENT_CONFIG_PATH: path.join(root, 'agent.yaml'),
    // 离线桩值：与 e2e harness 同款（127.0.0.1:9 不可达也无妨——本测试不跑回合）
    LLM_API_BASE_URL: 'http://127.0.0.1:9',
    LLM_API_KEY: 'seam-test-key',
    LLM_MODEL: 'worker-strong-model',
    ...extra,
  };
}

async function bootSeam(env: NodeJS.ProcessEnv): Promise<void> {
  const dbPath = path.join(path.dirname(env['AGENT_CONFIG_PATH']!), 'agent.db');
  const assembly = await createServerAssembly({ env, dbPath });
  await assembly.close();
}

/** 装配实际构造出的 Main 驱动（spy 记录的真工厂返回值）。 */
function mainDriver(): TurnDriver {
  const result = vi.mocked(createPiTurnDriver).mock.results.at(-1);
  if (!result || result.type !== 'return') throw new Error('createPiTurnDriver 未被装配成功调用');
  return result.value;
}

/** 行为级核对：pi 驱动的 synthesizeAssistant 闭包捕获 modelId，写进合成消息的 model 字段。 */
function capturedModelId(driver: TurnDriver): string {
  const message = driver.synthesizeAssistant?.('seam-probe') as { model?: string } | undefined;
  if (!message) throw new Error('pi 驱动未实现 synthesizeAssistant，无法核对模型 id');
  return message.model ?? '';
}

function mainCall(): { env: Record<string, string | undefined>; modelId?: string; thinkingLevel?: string } {
  const call = vi.mocked(createPiTurnDriver).mock.calls.at(-1);
  if (!call) throw new Error('createPiTurnDriver 未被装配调用');
  return call[0]! as { env: Record<string, string | undefined>; modelId?: string; thinkingLevel?: string };
}

function workerCall(): { env: Record<string, string | undefined> } {
  const call = vi.mocked(createPiCodingTurnDriver).mock.calls.at(-1);
  if (!call) throw new Error('createPiCodingTurnDriver 未被装配调用');
  return call[0]! as { env: Record<string, string | undefined> };
}

describe('分层模型接缝装配（LLM_MAIN_MODEL → Main 驱动；worker 恒走 LLM_MODEL）', () => {
  it('缺省：Main 驱动 options 键恰为 [env]（与接缝前逐字段一致），Main 与 worker 同源于 LLM_MODEL', async () => {
    await bootSeam(seamEnv());

    const mainOptions = mainCall();
    // 恒等断言：不设新变量时不新增任何驱动参数——装配产物与改动前逐字段一致
    expect(Object.keys(mainOptions)).toEqual(['env']);
    expect(mainOptions.env).toMatchObject({ LLM_MODEL: 'worker-strong-model' });
    // 行为级：真工厂闭包捕获的模型就是 LLM_MODEL
    expect(capturedModelId(mainDriver())).toBe('worker-strong-model');

    // worker 不受接缝影响：env 原样透传，仍读 LLM_MODEL；worker options 不该长出模型参数
    const workerOptions = workerCall();
    expect(workerOptions.env['LLM_MODEL']).toBe('worker-strong-model');
    expect(workerOptions).not.toHaveProperty('modelId');
    // 部署配置切片（issue #20 C+D）的恒等面：yaml 缺 host.piAgentDir 时不新增 agentDir——
    // 驱动保持自己的 process.env → <cwd>/data/pi-agent 回落链，与切片前逐字段一致。
    expect(workerOptions).not.toHaveProperty('agentDir');

    // Context 抽取缺省跟随 Main：全程只构造一次 Main 驱动（contextModelDriver ?? driver
    // 复用同一实例，而不是按 env 另建第二个）
    expect(vi.mocked(createPiTurnDriver)).toHaveBeenCalledTimes(1);
  });

  it('LLM_MAIN_MODEL 有值：Main 驱动收到它（行为级核对），worker 驱动仍收 LLM_MODEL', async () => {
    await bootSeam(seamEnv({
      LLM_MAIN_MODEL: 'main-fast-model',
      LLM_THINKING_LEVEL: 'high',
      LLM_MAIN_THINKING_LEVEL: 'low',
    }));

    const mainOptions = mainCall();
    expect(mainOptions.modelId).toBe('main-fast-model');
    expect(mainOptions.thinkingLevel).toBe('low');
    expect(capturedModelId(mainDriver())).toBe('main-fast-model');

    // worker 不受 Main 覆盖影响：同一份 env 原样透传，worker 侧模型仍是 LLM_MODEL
    const workerOptions = workerCall();
    expect(workerOptions.env['LLM_MODEL']).toBe('worker-strong-model');
    // LLM_MAIN_MODEL 在 env 里在场（env 是共享对象），但 worker 不读它——它只认 LLM_MODEL
    expect(workerOptions.env['LLM_MAIN_MODEL']).toBe('main-fast-model');
  });

  it('LLM_MAIN_MODEL 有值而 LLM_MAIN_THINKING_LEVEL 缺省：思考深度不显式传，由驱动按 LLM_THINKING_LEVEL 回落', async () => {
    await bootSeam(seamEnv({ LLM_MAIN_MODEL: 'main-fast-model', LLM_THINKING_LEVEL: 'high' }));

    const mainOptions = mainCall();
    // 装配只解析显式覆盖；缺省回落语义留在 pi-driver（env 路径），不在装配里复制第二份
    expect(Object.keys(mainOptions)).toEqual(['env', 'modelId']);
    expect(mainOptions.thinkingLevel).toBeUndefined();
    expect(mainOptions.env['LLM_THINKING_LEVEL']).toBe('high');
  });

  it('LLM_MAIN_MODEL 置空白：视为未配置，恒等不破（注释掉值留空不该改变行为）', async () => {
    await bootSeam(seamEnv({ LLM_MAIN_MODEL: '   ' }));

    expect(Object.keys(mainCall())).toEqual(['env']);
  });

  it('LLM_MAIN_THINKING_LEVEL 非法：装配 fail-fast，报错点名该变量（与 LLM_THINKING_LEVEL 同口径）', async () => {
    const env = seamEnv({ LLM_MAIN_THINKING_LEVEL: 'yolo' });
    const dbPath = path.join(path.dirname(env['AGENT_CONFIG_PATH']!), 'agent.db');
    await expect(createServerAssembly({ env, dbPath })).rejects.toThrow(/LLM_MAIN_THINKING_LEVEL/);
  });
});
