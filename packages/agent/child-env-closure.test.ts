/**
 * V0 安全收口：宿主敏感凭据族不得随子进程扩散（红先证 → 收口转绿）。
 *
 * 证据形态 = **真 spawn 真进程**（2026-11-12 收口前红先证实证：经本文件的 case 1/3 跑
 * 基线代码，断言失败输出里直接出现 `LLM_API_KEY=sentinel-…` / `WECOM_BOT_SECRET=sentinel-…`，
 * 两路都泄漏；日志见本次实施记录）。
 *
 * 三个面（2026-11-13 复核修订：逐键决策，禁整体前缀放行）：
 *   (i)  Worker 模型调用凭据——由可信驱动内部持有（driver options.env → ModelRuntime
 *        provider），不进任何子进程 env。case 5 钉模型调用未被破坏 + 子进程无键。
 *   (ii) Worker shell/工具可见 env——精确键白名单；case 1 钉剥离/保留，case 2 钉保留键
 *        足以真跑一次仓内夹具操作，case 4 逐键「缺了会坏」真子进程对照，
 *        case 6 结构上钉"精确键、无前缀放行"。
 *   (iii) 宿主直调网关 env——进程 env + 覆盖后剥敏感族与宿主内部指针；case 3 真 spawn
 *        钉子进程无键、既有激活密钥随调用到达、非敏感平台旋钮仍继承。
 *
 * 这是 B 类违约路径测试：断言的是"凭据不可达"，不是模型行为。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiCodingTurnDriver, createPiCodingWorkerSession } from './src/pi-coding-driver';
import { emptyCapabilityManifest, MemoryCapabilitySource } from './src/capability-source';
import { activatePendingPlan, createPlanScopedWorkerEnv } from './src/plan-runtime';
import { hostGatewayEnv } from './src/context';
import {
  isWorkerEnvKeyAllowed,
  stripHostSensitiveEnv,
  WORKER_ENV_ALLOWED_KEYS,
  WORKER_FIXTURE_STATE_DIR_KEY,
} from './src/child-env';
import type { PiCodingWorkerSessionOptions } from './src/pi-coding-driver';

/** 假 agent：脚本化单轮文本；记录 createAgentSession 收到的 options（模型面证据）。 */
const mockSdk = vi.hoisted(() => {
  type Turn = { text?: string };
  type SessionRecord = { options: Record<string, unknown>; turns: Turn[]; continueCalls: number; messages: unknown[] };
  const state = { sessions: [] as SessionRecord[] };
  let script: Turn[] = [];
  const setScript = (turns: Turn[]) => { script = turns; };
  const makeSession = (options: Record<string, unknown> = {}) => {
    const record: SessionRecord = { options, turns: script, continueCalls: 0, messages: [] };
    state.sessions.push(record);
    const agent = {
      state: {
        errorMessage: undefined as string | undefined,
        get messages() { return record.messages; },
        set messages(next: unknown[]) { record.messages = next; },
      },
      beforeToolCall: undefined as unknown,
      shouldStopAfterTurn: undefined as unknown,
      abort: () => {},
      steer: () => {},
      continue: async () => {
        record.continueCalls += 1;
        const turn = record.turns[Math.min(record.continueCalls - 1, record.turns.length - 1)];
        if (turn?.text) {
          record.messages.push({ role: 'assistant', content: [{ type: 'text', text: turn.text }], stopReason: 'stop', timestamp: Date.now() });
        }
      },
    };
    return { session: { agent, subscribe: () => {}, dispose: () => {}, getActiveToolNames: () => [] }, dispose: () => {} };
  };
  return { state, setScript, makeSession };
});

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return {
    ...actual,
    createAgentSession: async (options: Record<string, unknown>) => mockSdk.makeSession(options),
  };
});

vi.mock('./src/operation-labels', async () => {
  // 平台 I/O 已在发现接缝（capability-source.ts）一侧收口：会话的派生表来源由 baseOptions
  // 注入 MemoryCapabilitySource（本文件只验 env 传递面，不派生平台表、零 spawn）。
  // 真实现其余原样（load* 门面不再被驱动调用），只把 isWriteAccess 保持为旧替身。
  const actual = await vi.importActual<typeof import('./src/operation-labels')>('./src/operation-labels');
  return { ...actual, isWriteAccess: vi.fn() };
});

const FIXTURE_ROOT = resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');

const SENTINEL_LLM = 'sentinel-llm-key-DO-NOT-LEAK';
const SENTINEL_WECOM = 'sentinel-wecom-secret-DO-NOT-LEAK';
const SENTINEL_ACTIVATION = 'sentinel-plan-activation-secret';
const SENTINEL_DB_PATH = 'sentinel-host-db-path';
const SENTINEL_CONFIG_PATH = 'sentinel-host-config-path';
const SENTINEL_NODE_ENV = 'sentinel-node-env';
const SENTINEL_LANG = 'sentinel-lang-value';
/** 逐键剥离/保留的哨兵面（键名覆盖三个族：宿主凭据 / NODE_ / FSHINE_ / EXECUTION_ / LC_）。 */
const SENTINELS: Record<string, string | undefined> = {
  LLM_API_KEY: SENTINEL_LLM,
  WECOM_BOT_SECRET: SENTINEL_WECOM,
  EXECUTION_PLAN_ACTIVATION_SECRET: SENTINEL_ACTIVATION,
  DB_PATH: SENTINEL_DB_PATH,
  AGENT_CONFIG_PATH: SENTINEL_CONFIG_PATH,
  NODE_ENV: SENTINEL_NODE_ENV,
  NODE_OPTIONS: '--sentinel-node-options',
  LC_ALL: 'C',
  LANG: SENTINEL_LANG,
  EXECUTION_EXECUTOR: 'sentinel-executor-switch',
  EXECUTION_PLAN_AUTO_CALLS: '117',
  DUMMY_PLAN_CONFIRM_CALLS: '119',
  FSHINE_PLATFORM_QUEUE_CAPACITY: '113',
};

const cleanups: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
let envSaved = false;

function applySentinels(extra: Record<string, string> = {}): void {
  if (!envSaved) {
    for (const key of [...Object.keys(SENTINELS), ...Object.keys(extra)]) savedEnv[key] = process.env[key];
    envSaved = true;
  }
  Object.assign(process.env, SENTINELS, extra);
}

afterEach(() => {
  if (envSaved) {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    envSaved = false;
  }
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  mockSdk.state.sessions.length = 0;
  mockSdk.setScript([]);
});

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function baseOptions(overrides?: Partial<PiCodingWorkerSessionOptions>): PiCodingWorkerSessionOptions {
  return {
    cwd: process.cwd(),
    agentDir: join(tmpRoot('worker-env-agent-'), 'agent'),
    gateway: 'bin/dummy',
    skillRoots: [],
    systemPrompt: 'test',
    modelConfig: { runtime: {} as never, model: {} as never },
    // 发现源替身：本文件不派生平台表、零 spawn（接缝点见 capability-source.ts）。
    capabilitySource: new MemoryCapabilitySource(emptyCapabilityManifest()),
    ...overrides,
  };
}

/** 取本轮 createAgentSession 捕获的 bash 工具，真跑一条命令，返回子进程 stdout。 */
async function runBash(command: string): Promise<{ text: string; promptGuidelines: unknown }> {
  const options = mockSdk.state.sessions.at(-1)!.options;
  const tools = options.customTools as Array<Record<string, unknown>>;
  const bash = tools.find((tool) => tool.name === 'bash');
  expect(bash, '生产 worker 会话应注册 bash 工具').toBeDefined();
  const execute = bash!.execute as (
    toolCallId: string,
    params: { command: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: undefined,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
  // 真 spawn：bash 工具以生产 spawnHook 的环境跑命令。
  const result = await execute('call_env_probe', { command }, undefined, undefined, undefined);
  return { text: result.content.map((part) => part.text).join('\n'), promptGuidelines: bash!.promptGuidelines };
}

function srcOf(...segments: string[]): string {
  return readFileSync(resolve(__dirname, '..', '..', ...segments), 'utf8');
}

describe('V0 安全收口：子进程 env 不含宿主敏感凭据族', () => {
  it('case 1 · worker bash 真子进程：凭据族/未登记键不可达，白名单精确键保留', async () => {
    const cwd = tmpRoot('worker-env-closure-');
    const tmpSentinel = tmpRoot('worker-env-tmpdir-');
    const bridgeSentinel = tmpRoot('worker-env-bridge-');
    applySentinels({ TMPDIR: tmpSentinel, [WORKER_FIXTURE_STATE_DIR_KEY]: bridgeSentinel });

    await createPiCodingWorkerSession(baseOptions({ cwd }));
    const { text: out, promptGuidelines } = await runBash('printenv');

    // ① 宿主凭据族与宿主内部指针不可达（键名与值双查）。
    expect(out).not.toContain(SENTINEL_LLM);
    expect(out).not.toContain(SENTINEL_WECOM);
    expect(out).not.toContain(SENTINEL_ACTIVATION);
    expect(out).not.toContain(SENTINEL_DB_PATH);
    expect(out).not.toContain(SENTINEL_CONFIG_PATH);
    expect(out).not.toMatch(/^LLM_API_KEY=/m);
    expect(out).not.toMatch(/^WECOM_BOT_SECRET=/m);
    expect(out).not.toMatch(/^DB_PATH=/m);
    expect(out).not.toMatch(/^AGENT_CONFIG_PATH=/m);
    // ② 逐族抽查：NODE_* / 其余 FSHINE_* / 其余 EXECUTION_* / LC_* 都不进（逐键核对的结论）。
    expect(out).not.toContain(SENTINEL_NODE_ENV);
    expect(out).not.toMatch(/^NODE_OPTIONS=/m);
    expect(out).not.toContain(SENTINEL_LANG);
    expect(out).not.toMatch(/^LC_ALL=/m);
    expect(out).not.toMatch(/^EXECUTION_EXECUTOR=/m);
    expect(out).not.toMatch(/^EXECUTION_PLAN_AUTO_CALLS=/m);
    expect(out).not.toMatch(/^DUMMY_PLAN_CONFIRM_CALLS=/m);
    expect(out).not.toMatch(/^FSHINE_PLATFORM_QUEUE_CAPACITY=/m);
    // ③ PI_* 会话元数据不进；同时 SDK 不再向模型宣传它（提示词与环境一致）。
    expect(out).not.toMatch(/^PI_/m);
    expect(promptGuidelines).toBeUndefined();

    // ④ 白名单精确键保留（收口不是"清空 env"）。
    expect(out).toMatch(/^PATH=/m);
    expect(out).toMatch(/^HOME=/m);
    expect(out).toContain(`TMPDIR=${tmpSentinel}`);
    expect(out).toContain(`${WORKER_FIXTURE_STATE_DIR_KEY}=${bridgeSentinel}`);
    // ⑤ 执行面逐次注入键在位（无活跃计划时 PLAN_ID 不注入）。
    expect(out).toContain('EXECUTION_REQUIRE_PLAN=1');
  });

  it('case 2 · 保留键足以真跑一次仓内夹具操作（bridge 状态根 + 计划绑定）', () => {
    const stateRoot = tmpRoot('worker-env-fixture-state-');
    const inherited = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      [WORKER_FIXTURE_STATE_DIR_KEY]: stateRoot,
      ...SENTINELS,
    };
    const env = createPlanScopedWorkerEnv(inherited, 'plan_env_closure');
    const result = spawnSync('/bin/sh', ['-c', 'bin/dummy query src/dummy/scripts/query.js --collection alpha --window W1'], {
      cwd: FIXTURE_ROOT,
      env,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"status":"completed"');
    // 夹具的 per-case 审计真的落在 bridge 根下，且审计行里没有敏感哨兵。
    const audit = readFileSync(join(stateRoot, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"planId":"plan_env_closure"');
    expect(audit).not.toContain(SENTINEL_LLM);
  });

  it('case 3 · 宿主直调网关真子进程：剥敏感族与宿主内部指针，激活密钥照到达', async () => {
    const root = tmpRoot('host-direct-env-');
    applySentinels();
    const out = join(root, 'child-env.txt');
    mkdirSync(join(root, 'bin'), { recursive: true });
    // 假网关：先耗掉 stdin（runner 会写 input），再把子进程 env 落盘，最后回一个合法 JSON。
    const gateway = join(root, 'bin', 'fake-gw');
    writeFileSync(gateway, `#!/bin/sh\ncat > /dev/null\nprintenv > '${out}'\necho '{}'\n`, { mode: 0o755 });

    await activatePendingPlan({
      platformRoot: root,
      planId: 'plan_sentinel',
      evidence: 'user-confirmed',
      activationSecret: SENTINEL_ACTIVATION,
      env: hostGatewayEnv(),
      gateway: 'bin/fake-gw',
    });

    const text = readFileSync(out, 'utf8');
    expect(text).not.toContain(SENTINEL_LLM);
    expect(text).not.toContain(SENTINEL_WECOM);
    expect(text).not.toContain(SENTINEL_DB_PATH);
    expect(text).not.toContain(SENTINEL_CONFIG_PATH);
    expect(text).toMatch(/^PATH=/m);
    // 既有语义不变：激活密钥随这一次调用到达宿主直调子进程。
    expect(text).toContain(`EXECUTION_PLAN_ACTIVATION_SECRET=${SENTINEL_ACTIVATION}`);
    // 宿主直调不是白名单：非敏感的平台旋钮仍继承（仓内夹具按用例调参依赖这条）。
    expect(text).toContain('DUMMY_PLAN_CONFIRM_CALLS=119');
  });

  it('case 4 · 保留键逐键「缺了会坏」真子进程对照（PATH / HOME / TMPDIR）', () => {
    // PATH：命令查找。
    const withPath = spawnSync('/bin/sh', ['-c', 'node -v'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
    const withoutPath = spawnSync('/bin/sh', ['-c', 'node -v'], { env: {}, encoding: 'utf8' });
    expect(withPath.status).toBe(0);
    expect(withoutPath.status).not.toBe(0);
    expect(String(withoutPath.stderr)).toContain('node');

    // HOME：$HOME 展开（夹具 local runner 也显式转发它，dummy.cjs 的 spawn env）。
    const withHome = spawnSync('/bin/sh', ['-c', 'cd "$HOME"'], { env: { HOME: process.env.HOME ?? '' }, encoding: 'utf8' });
    const withoutHome = spawnSync('/bin/sh', ['-c', 'cd "$HOME"'], { env: {}, encoding: 'utf8' });
    expect(withHome.status).toBe(0);
    expect(withoutHome.status).not.toBe(0);

    // TMPDIR：node os.tmpdir() 消费；缺键时旁路声明的落点、回落系统默认。
    const tmpSentinel = tmpRoot('worker-env-perkey-tmp-');
    const tmpdirProbe = (env: Record<string, string>): string =>
      String(spawnSync(process.execPath, ['-e', 'process.stdout.write(require("os").tmpdir())'], { env, encoding: 'utf8' }).stdout);
    expect(tmpdirProbe({ TMPDIR: tmpSentinel })).toBe(tmpSentinel);
    const fallback = tmpdirProbe({});
    expect(fallback).not.toBe(tmpSentinel);
    expect(fallback).toContain('tmp');
  });

  it('case 5 · 面孔(i)：模型凭据由驱动内部持有——session 拿到模型，子进程拿不到键', async () => {
    mockSdk.setScript([{ text: '驱动内部持凭据，模型调用照常。' }]);
    const cwd = tmpRoot('worker-model-cred-');
    const driver = createPiCodingTurnDriver({
      env: {
        LLM_API_BASE_URL: 'http://127.0.0.1:9',
        LLM_API_KEY: SENTINEL_LLM,
        LLM_MODEL: 'sentinel-model-id',
      },
      agentDir: join(cwd, '.fshine-agent'),
      gateway: 'bin/dummy',
      operationLabels: new Map(),
      operationArgStyles: new Map(),
      operationArgSpecs: new Map(),
      operationSemantics: new Map(),
      operationProtocols: new Map(),
      capabilityManifest: { version: '1.0', operations: [] },
      planCliRunner: async ({ args }) => (args[1] === 'current'
        ? { code: 0, stdout: JSON.stringify({ taskId: 'task_env_closure', planId: null, version: null, status: 'none' }), stderr: '' }
        : { code: 1, stdout: '', stderr: 'unexpected CLI call' }),
    });

    const result = await driver.run({
      systemPrompt: 'worker system prompt',
      tools: [],
      messages: [{ role: 'user', content: '你好', timestamp: 1 } as never],
      cwd,
      skillRoots: [],
      sessionId: 'task_env_closure',
      requestId: 'req_env_closure',
      onStep: () => {},
      exec: async () => { throw new Error('worker 只能使用其工作目录内配置的原生工具'); },
      deadline: Date.now() + 10_000,
    });

    // 模型调用未被破坏：驱动从自己的 env 建出模型并交进会话。
    expect(result.text).toBe('驱动内部持凭据，模型调用照常。');
    const options = mockSdk.state.sessions.at(-1)!.options;
    expect((options.model as { id?: string } | undefined)?.id).toBe('sentinel-model-id');
    const runtime = options.modelRuntime as { getModel(provider: string, modelId: string): unknown } | undefined;
    expect(runtime?.getModel('llm', 'sentinel-model-id')).toBeTruthy();
    // 但凭据不进任何子进程 env。
    const { text: out } = await runBash('printenv');
    expect(out).not.toContain(SENTINEL_LLM);
  });

  it('case 6 · 夹具桥缺键对照：无桥时审计不落、per-case 状态根被旁路', () => {
    // 复制一份最小夹具（bin/dummy + dummy.cjs），验证 bridge 的有无决定的落点差异。
    const copy = tmpRoot('worker-env-fixture-copy-');
    mkdirSync(join(copy, 'bin'), { recursive: true });
    for (const name of ['dummy', 'dummy.cjs']) {
      writeFileSync(join(copy, 'bin', name), readFileSync(join(FIXTURE_ROOT, 'bin', name)), { mode: 0o755 });
    }
    const bridgeRoot = tmpRoot('worker-env-fixture-bridge-');
    const common = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', EXECUTION_REQUIRE_PLAN: '1', EXECUTION_PLAN_ID: 'plan_bridge' };
    const run = (env: Record<string, string>) => spawnSync('/bin/sh', ['-c', 'bin/dummy query src/dummy/scripts/query.js --collection alpha --window W1'], { cwd: copy, env, encoding: 'utf8' });

    const without = run(common);
    expect(without.status).toBe(0);
    expect(existsSync(join(bridgeRoot, 'audit.jsonl'))).toBe(false);

    const withBridge = run({ ...common, [WORKER_FIXTURE_STATE_DIR_KEY]: bridgeRoot });
    expect(withBridge.status).toBe(0);
    expect(existsSync(join(bridgeRoot, 'audit.jsonl'))).toBe(true);
  });

  it('case 7 · 结构盘点：spawn 面全部经收口函数；白名单为精确键、无前缀放行', () => {
    const planRuntime = srcOf('packages', 'agent', 'src', 'plan-runtime.ts');
    expect(planRuntime).toContain('isWorkerEnvKeyAllowed(');
    expect(planRuntime).toContain('hostDirectChildEnv(');
    const contextSrc = srcOf('packages', 'agent', 'src', 'context.ts');
    expect(contextSrc).toContain('hostDirectChildEnv(');
    expect(contextSrc).toContain('stripHostSensitiveEnv(process.env)');
    const commitSrc = srcOf('apps', 'server', 'proposal-commit.ts');
    expect(commitSrc).toContain('hostDirectChildEnv(');
    const smokeSrc = srcOf('scripts', 'mock-commit-smoke.ts');
    expect(smokeSrc).toContain('hostDirectChildEnv(');
    // 发现接缝（capability-source.ts）一处宿主直调（唯一发现 spawn）同尺；
    // operation-labels 已无 spawn（逐表 loader 收敛为接缝门面）。
    const labelsSrc = srcOf('packages', 'agent', 'src', 'operation-labels.ts');
    expect(labelsSrc.split('hostDirectChildEnv()').length - 1).toBe(0);
    const capabilitySrc = srcOf('packages', 'agent', 'src', 'capability-source.ts');
    expect(capabilitySrc.split('hostDirectChildEnv()').length - 1).toBe(1);
    // assembly 启动前的平台 lint 子进程（第 4 个宿主→执行层 spawn 面）同尺
    // （2026-11-13 复核发现：此前无 env 选项、全量继承 process.env）。
    const assemblySrc = srcOf('apps', 'server', 'assembly.ts');
    expect(assemblySrc).toContain('hostDirectChildEnv()');

    // 精确键成员判定（无前缀语义）：代表性未登记键一律 false。
    expect(isWorkerEnvKeyAllowed('PATH')).toBe(true);
    expect(isWorkerEnvKeyAllowed(WORKER_FIXTURE_STATE_DIR_KEY)).toBe(true);
    expect(isWorkerEnvKeyAllowed('NODE_ENV')).toBe(false);
    expect(isWorkerEnvKeyAllowed('NODE_OPTIONS')).toBe(false);
    expect(isWorkerEnvKeyAllowed('FSHINE_PLATFORM_QUEUE_CAPACITY')).toBe(false);
    expect(isWorkerEnvKeyAllowed('EXECUTION_EXECUTOR')).toBe(false);
    expect(isWorkerEnvKeyAllowed('LC_ALL')).toBe(false);
    expect(isWorkerEnvKeyAllowed('LLM_API_KEY')).toBe(false);
    expect(WORKER_ENV_ALLOWED_KEYS.some((key) => key.endsWith('_'))).toBe(false);

    // stripHostSensitiveEnv 纯函数语义：剥敏感族 + 宿主内部指针，不动入参。
    const input = { LLM_API_KEY: 'x', WECOM_BOT_ID: 'y', DB_PATH: 'z', AGENT_CONFIG_PATH: 'w', OTHER: 'keep' };
    const stripped = stripHostSensitiveEnv(input);
    expect(stripped).toEqual({ OTHER: 'keep' });
    expect(input.LLM_API_KEY).toBe('x');
  });
});
