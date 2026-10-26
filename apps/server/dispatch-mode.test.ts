import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WecomBotChannel } from '@fshine/channel-wecom';
import { createServerAssembly } from './assembly';
import * as assemblyModule from './assembly';
import { workerDispatchModeOf } from './dispatch-mode';

describe('workerDispatchModeOf', () => {
  it('defaults to inline and accepts only the host-selected modes', () => {
    expect(workerDispatchModeOf({})).toBe('inline');
    expect(workerDispatchModeOf({ FSHINE_WORKER_DISPATCH_MODE: '' })).toBe('inline');
    expect(workerDispatchModeOf({ FSHINE_WORKER_DISPATCH_MODE: 'inline' })).toBe('inline');
    expect(workerDispatchModeOf({ FSHINE_WORKER_DISPATCH_MODE: 'background' })).toBe('background');
  });

  it('rejects unknown configuration rather than silently enabling a different execution mode', () => {
    expect(() => workerDispatchModeOf({ FSHINE_WORKER_DISPATCH_MODE: 'async' })).toThrow(/FSHINE_WORKER_DISPATCH_MODE/);
  });
});

// ── background 模式的装配硬前提（D-126 / D-134）────────────────────────────────
// background 下 worker 完成只有"渠道主动发送"一条交付路（inline 侧的产物收集已关），
// 且完成事件的续跑/交付都依赖会话转录存储。缺能力时不在运行期逐次留 failed——装配期
// 即拒绝启动；inline 不受影响（交付仍走回合回执，无主动发送需求）。
const tempRoots: string[] = [];
afterEach(() => { for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** 最小离线装配环境（与 model-seam-wiring 同款：无 platformRoot → 不触平台 lint/CLI）。 */
function seamEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'dispatch-mode-assembly-'));
  tempRoots.push(root);
  writeFileSync(path.join(root, 'agent.yaml'), [
    'principals:',
    '  wecom:gate_user:',
    '    accountSetScope: all',
    '    enabled: true',
    '',
  ].join('\n'));
  return {
    AGENT_CONFIG_PATH: path.join(root, 'agent.yaml'),
    LLM_API_BASE_URL: 'http://127.0.0.1:9',
    LLM_API_KEY: 'gate-test-key',
    LLM_MODEL: 'unused',
    ...extra,
  };
}

/** 无主动发送能力的假渠道（D-126 的红形态：只有被动应答）。 */
function channelWithoutPush(): WecomBotChannel {
  return {
    start: async () => {},
    stop: async () => {},
  } as unknown as WecomBotChannel;
}

describe('background 装配硬前提（D-126 / D-134）', () => {
  it('background × 渠道缺主动发送能力：装配期即拒绝启动（inline 收集已关、后台投递必败的组合不留到运行期）', async () => {
    const env = seamEnv();
    const dbPath = path.join(path.dirname(env['AGENT_CONFIG_PATH']!), 'agent.db');
    await expect(createServerAssembly({ env, dbPath, workerDispatchMode: 'background', channel: channelWithoutPush() }))
      .rejects.toThrow(/主动发送/);
  });

  it('inline × 同一缺发送渠道：装配照常成功（门只在 background 模式下触发，不误伤既有装配）', async () => {
    const env = seamEnv();
    const dbPath = path.join(path.dirname(env['AGENT_CONFIG_PATH']!), 'agent.db');
    const assembly = await createServerAssembly({ env, dbPath, channel: channelWithoutPush() });
    await assembly.close();
  });

  it('守卫本体：background × 缺会话转录存储即拒绝，inline 全放行（D-134 与 D-126 同点收口）', () => {
    const guard = (assemblyModule as { assertBackgroundAssemblyReady?: (args: { workerDispatchMode: 'inline' | 'background'; channel: { sendToConversation?: unknown }; conversationLog?: unknown }) => void }).assertBackgroundAssemblyReady;
    expect(typeof guard, 'assembly 未导出装配硬前提守卫 assertBackgroundAssemblyReady').toBe('function');
    const capableChannel = { sendToConversation: async () => ({ parts: [] }) };
    const bareChannel = {};
    // background：缺渠道能力 → 拒；缺会话转录存储 → 拒（运行期只能静默丢事件，不如不起）。
    expect(() => guard!({ workerDispatchMode: 'background', channel: bareChannel, conversationLog: {} })).toThrow(/主动发送/);
    expect(() => guard!({ workerDispatchMode: 'background', channel: capableChannel, conversationLog: undefined })).toThrow(/会话转录/);
    // 同一形态在 inline 下全部放行。
    expect(() => guard!({ workerDispatchMode: 'inline', channel: bareChannel, conversationLog: undefined })).not.toThrow();
  });
});
