/**
 * profile.gateway 装配接线的测试（2026-11-08 评审：assembly→driver 这一跳无任何测试断言）。
 *
 * 背景：C7b 网关穿线补课落在三处——`createPiCodingWorkerSession` 的计划两跳
 * （pi-coding-driver-gateway-threading.test.ts 用假网关锁住了 driver 侧）、plan-runtime
 * 默认 runner、以及装配层 apps/server/assembly.ts 的 `createPiCodingTurnDriver` 注入点。
 * 前两处有回归锁，唯独装配这一跳此前只靠读码确认：删掉 `...(activeProfile?.gateway ? …)`
 * 那一行，全库依旧全绿——worker 拿不到 gateway，label/规格/语义/协议四张派生表全部降级
 * 空表（零进度帧、零参数摘要、写关闭前置判定失效），生产静默劣化。
 *
 * 写法沿用 model-seam-wiring.test.ts：真工厂 + 最小真装配（临时 SQLite + 临时 profile 根，
 * 假网关壳脚本，不触网），只在 @fshine/agent 的 worker 驱动工厂外包一层透传 spy，断言
 * 装配传入的 options。工厂行为零改动，spy 只记录入参。
 *
 * 为什么没有「未声明 gateway 时装配不传」的身份断言：profile 一旦声明 root，
 * 装配的 planCommandForm 走 planDraftExample(activeProfile?.gateway)，C7b 起未声明即
 * fail-closed 抛错（第二条用例钉住它）——「root 无 gateway」的装配根本起不来，自然没有
 * 可观察的 driver options。driver 侧「未声明 = 不传」的恒等已由 threading 测试覆盖。
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPiCodingTurnDriver, type TurnDriver } from '@fshine/agent';

vi.mock('@fshine/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fshine/agent')>();
  return {
    ...actual,
    // 透传 spy：记录装配传入的 options，实现仍是真工厂（构造只派生四张表 + 能力清单，
    // 模型解析惰性到首次回合——离线构造安全，见 model-seam-wiring.test.ts 同款）。
    createPiCodingTurnDriver: vi.fn(actual.createPiCodingTurnDriver),
  };
});

vi.mock('./proposal-commit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proposal-commit')>();
  return { ...actual, createProposalCommitRunner: vi.fn(actual.createProposalCommitRunner) };
});

import { createServerAssembly } from './assembly';
import { createProposalCommitRunner } from './proposal-commit';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * 假平台根：`scripts/lint-operations.js`（装配的接口完整性检查，退出 0 即健康）+
 * `bin/gw-under-test` 壳脚本（loader 的 `operation list` 派生拿到空输出 → 按既定语义
 * 降级空表，不拦截）。skillRoots 目录一并建出， profile 校验与 worker spawn 的惰性
 * 读取都指向真实存在的目录。
 */
function fakePlatformRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'profile-gateway-wiring-'));
  roots.push(root);
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'lint-operations.js'), 'process.exit(0);\n');
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  writeFileSync(path.join(root, 'bin', 'gw-under-test'), '#!/bin/sh\nexit 0\n');
  chmodSync(path.join(root, 'bin', 'gw-under-test'), 0o755);
  mkdirSync(path.join(root, '.agents', 'skills'), { recursive: true });
  return root;
}

function seamEnv(platformRoot: string, profileLines: string[]): NodeJS.ProcessEnv {
  const configDir = mkdtempSync(path.join(tmpdir(), 'profile-gateway-config-'));
  roots.push(configDir);
  writeFileSync(path.join(configDir, 'agent.yaml'), [
    '# 最小配置：principals + 单一 contextProfile',
    'principals:',
    '  wecom:seam_user:',
    '    accountSetScope: all',
    '    enabled: true',
    'contextProfiles:',
    '  dummy:',
    `    root: ${platformRoot}`,
    '    skillRoots: [".agents/skills"]',
    ...profileLines,
    '',
  ].join('\n'));
  return {
    AGENT_CONFIG_PATH: path.join(configDir, 'agent.yaml'),
    // 离线桩值：与 model-seam-wiring.test.ts 同款（不跑回合）
    LLM_API_BASE_URL: 'http://127.0.0.1:9',
    LLM_API_KEY: 'seam-test-key',
    LLM_MODEL: 'worker-strong-model',
  };
}

async function bootSeam(env: NodeJS.ProcessEnv): Promise<void> {
  const dbPath = path.join(path.dirname(env['AGENT_CONFIG_PATH']!), 'agent.db');
  const assembly = await createServerAssembly({ env, dbPath });
  await assembly.close();
}

/** 装配实际构造出的 worker 驱动 options（spy 记录的真工厂入参）。 */
function workerCall(): { env: Record<string, string | undefined>; platformRoot?: string; gateway?: string } {
  const call = vi.mocked(createPiCodingTurnDriver).mock.calls.at(-1);
  if (!call) throw new Error('createPiCodingTurnDriver 未被装配调用');
  return call[0] as { env: Record<string, string | undefined>; platformRoot?: string; gateway?: string };
}

describe('profile.gateway 装配接线（assembly → worker 驱动）', () => {
  it('profile 声明 gateway：worker 驱动收到同值 gateway 与 platformRoot；Main 驱动不受影响', async () => {
    const platformRoot = fakePlatformRoot();
    await bootSeam(seamEnv(platformRoot, ['    gateway: bin/gw-under-test']));

    const options = workerCall();
    // 装配 → driver 这一跳（assembly.ts 的 activeProfile?.gateway 注入）：漏传 = 四张
    // 派生表全部降级空表，生产静默零进度帧——本断言即那行的回归锁。
    expect(options.gateway).toBe('bin/gw-under-test');
    expect(options.platformRoot).toBe(platformRoot);
    expect(options.env['LLM_MODEL']).toBe('worker-strong-model');

    // Main 驱动不受 profile.gateway 影响：无 LLM_MAIN_MODEL 时 options 键恰为 ['env']
    // （恒等口径与 model-seam-wiring.test.ts 一致）。
    const mainDriver = vi.mocked(createPiCodingTurnDriver).mock.calls.length;
    expect(mainDriver).toBe(1);
  });

  it('profile 声明 root 但未声明 gateway：装配 fail-closed 拒绝启动（planCommandForm 无缺省网关名可渲染）', async () => {
    const platformRoot = fakePlatformRoot();
    await expect(bootSeam(seamEnv(platformRoot, []))).rejects.toThrow(/未声明有效的 profile\.gateway/);
  });

  // 2026-11-08 修（PR #21 过程中定位的生产 bug）：落账后端是装配层唯一漏传 gateway 的一处。
  // C7b 起 loadOperationProtocols(root, gateway) 对未声明的 gateway 一律降级**空表**
  // （operation-labels.ts，绝不回退遗留网关名）⇒ operationForProtocol 找不到 proposal.commit
  // 角色 ⇒ refuseCommit ⇒ 每条写链都死在 commit（acceptance 5.2 实测
  // change_intent_commit_failed、意图 failed、基线 write-chain-51 从 committed:true 掉 false）。
  // 同文件的 schema loader(:312)/plan 确认(:330)/operation 规格(:368) 都传了，只漏这一处——
  // 删掉 assembly.ts 里那一行 `...(activeProfile?.gateway ? …)`，本断言即回归锁。
  it('profile 声明 gateway：落账后端也收到同值 gateway 与 platformRoot', async () => {
    const platformRoot = fakePlatformRoot();
    await bootSeam(seamEnv(platformRoot, ['    gateway: bin/gw-under-test']));

    const calls = vi.mocked(createProposalCommitRunner).mock.calls;
    expect(calls.length, 'createProposalCommitRunner 应被装配调用').toBeGreaterThan(0);
    const options = calls.at(-1)![0] as { platformRoot: string; gateway?: string };
    expect(options.platformRoot).toBe(platformRoot);
    expect(options.gateway).toBe('bin/gw-under-test');
  });
});
