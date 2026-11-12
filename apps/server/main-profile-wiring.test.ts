/**
 * Track D：Main 角色指令换源（唯一事实源 = agent.md）与 A/B 对照注入缝的装配验收。
 *
 * 四条断言：
 *   ① 不给 override：装配传给 runtime 的角色指令**就是** agent.md 正文（唯一事实源），
 *      且旧 businessSkill 注入项从 deps 里消失（没有第二个可改变 Main 行为的入口）；
 *   ② roleInstructionsOverride / skillsMode 是 A/B 对照的程序化注入缝（非配置项、非
 *      环境变量）：给了就生效，且只作为 assembly 的入参出现，绝不透传进 runtime deps；
 *   ③ skillsMode 缺省 = on（生产口径）：注册 read_skill；off（控制臂）：不曝光、不注册；
 *   ④ skill 发现失败：装配期显式 catch + 响亮日志，启动照常（基础任务不受技能面影响）。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnDriver } from '@fshine/agent';

vi.mock('@fshine/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fshine/agent')>();
  return {
    ...actual,
    // 透传 spy：记录装配传给 runtime 的 deps；listSkills 可被单测注入失败形态。
    createTaxAgentRuntime: vi.fn(actual.createTaxAgentRuntime),
    listSkills: vi.fn(actual.listSkills),
  };
});

import { createTaxAgentRuntime, listSkills, loadAgentProfile } from '@fshine/agent';
import { createServerAssembly, type ServerAssembly, type ServerAssemblyOverrides } from './assembly';

const roots: string[] = [];
const assemblies: ServerAssembly[] = [];
afterEach(async () => {
  for (const assembly of assemblies.splice(0)) await assembly.close().catch(() => {});
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
});

/** 最小装配夹具：除授权名单外什么都不配（无 platformRoot → 不触平台 lint/CLI，离线构造）。 */
function minimalEnv(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'main-profile-wiring-'));
  roots.push(root);
  writeFileSync(path.join(root, 'agent.yaml'), [
    'principals:',
    '  wecom:profile_user:',
    '    accountSetScope: all',
    '    enabled: true',
    '',
  ].join('\n'));
  return {
    AGENT_CONFIG_PATH: path.join(root, 'agent.yaml'),
    LLM_API_BASE_URL: 'http://127.0.0.1:9',
    LLM_API_KEY: 'main-profile-wiring-key',
    LLM_MODEL: 'step-3.7-flash',
  };
}

function idleDriver(): TurnDriver {
  return { run: async (input) => ({ text: '', messages: input.messages }) };
}

async function boot(env: NodeJS.ProcessEnv, overrides: Partial<ServerAssemblyOverrides> = {}): Promise<ServerAssembly> {
  const dbPath = path.join(path.dirname(env['AGENT_CONFIG_PATH']!), 'agent.db');
  const assembly = await createServerAssembly({ env, dbPath, driver: idleDriver(), ...overrides });
  assemblies.push(assembly);
  return assembly;
}

function lastRuntimeDeps(): Record<string, unknown> {
  const call = vi.mocked(createTaxAgentRuntime).mock.calls.at(-1);
  expect(call, 'createTaxAgentRuntime 未被装配调用').toBeDefined();
  return call![0] as unknown as Record<string, unknown>;
}

describe('Track D 装配：角色指令唯一事实源 + A/B 注入缝', () => {
  it('① 不给 override：角色指令只能来自 agent.md；旧 businessSkill 入口不在 deps 里', async () => {
    await boot(minimalEnv());
    const deps = lastRuntimeDeps();
    const profile = await loadAgentProfile();
    expect(deps.roleInstructions).toBe(profile.instructions);
    expect(deps.roleInstructions).toContain('fshine 的主 Agent');
    const keys = Object.keys(deps);
    expect(keys, '装配仍在接 businessSkill 旧注入链').not.toContain('businessSkill');
    expect(keys).not.toContain('businessSkillPath');
    // 注入缝字段绝不下传 runtime（它们只在 assembly 入参出现）
    expect(keys).not.toContain('roleInstructionsOverride');
    expect(keys).not.toContain('skillsMode');
  });

  it('② roleInstructionsOverride：程序化注入生效（仅 A/B 对照用）', async () => {
    await boot(minimalEnv(), { roleInstructionsOverride: '【A/B 对照替身角色文本】' });
    const deps = lastRuntimeDeps();
    expect(deps.roleInstructions).toBe('【A/B 对照替身角色文本】');
    // 不给 override 的生产口径仍然是 agent.md（上一条已证），这里反向确认替身确实替换了来源
    const profile = await loadAgentProfile().catch(() => undefined);
    if (profile) expect(deps.roleInstructions).not.toBe(profile.instructions);
  });

  it('③ skillsMode：缺省 on 注册 read_skill 并做发现；off 既不曝光也不注册', async () => {
    await boot(minimalEnv());
    const on = lastRuntimeDeps();
    expect((on.readSkillTool as { name?: string } | undefined)?.name).toBe('read_skill');
    expect(vi.mocked(listSkills)).toHaveBeenCalledTimes(1);

    await boot(minimalEnv(), { skillsMode: 'off' });
    const off = lastRuntimeDeps();
    expect(off.readSkillTool).toBeUndefined();
    expect(off.skillCatalog).toBeUndefined();
    // off 臂不读技能目录（控制臂与实验臂只此一处切换）
    expect(vi.mocked(listSkills)).toHaveBeenCalledTimes(1);
  });

  it('④ skill 发现失败：响亮日志、启动照常、基础任务可用', async () => {
    vi.mocked(listSkills).mockRejectedValueOnce(new Error('技能名称重复:alpha（a 与 b）'));
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    try {
      await boot(minimalEnv());
    } finally {
      spy.mockRestore();
    }
    expect(errors.join('\n')).toContain('main_skills_discovery_failed');
    const deps = lastRuntimeDeps();
    expect(deps.roleInstructions).toBeDefined();
    expect((deps.readSkillTool as { name?: string } | undefined)?.name).toBe('read_skill');
  });
});
