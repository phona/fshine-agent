/**
 * 缺口 2 · Main 业务 Skill 投递（两实验臂，缺省不投递）。
 *
 * 缺口本体：Main 的 agent.md 保持最小（Skills First），但 Main 侧没有任何业务 Skill 装载链路——
 * loadWorkerSkills 只喂 Worker 委派提示，skills.ts 的 read_skill/renderSkillCatalog 在 Main 面零消费。
 * 本切片给两个可切换的实验臂，**缺省（无 mainSkillRoots 配置）行为逐字节不变**：
 *   臂 A（inline）：复用 loadWorkerSkills，把 SKILL.md 正文拼进 mainSystemPrompt；
 *   臂 B（catalog）：复用 skills.ts 的 listSkills/renderSkillCatalog（系统提示只拼摘要清单）
 *                    + READ_SKILL_TOOL（Main 工具面按需读正文）。
 *
 * 判据（TDD：实现前红 → 接线后绿；全部假件/临时目录，零网络/零模型）：
 *   · 配置：mainSkillRoots/mainSkillMode 类型+校验，缺省 undefined；
 *   · 臂 A：提示含 【技能：name】+ 正文；技能根为空 → promptBlock 空串（缺省金样锚点）；
 *   · 臂 B：摘要清单只含 name/description、无正文/无绝对路径；registry.read 返回正文；
 *   · 臂 B 工具面：注入 registry 才有 read_skill；未注入 → 无该工具且调用抛「Main 工具面之外的调用」；
 *   · 缺省：无 mainSkillRegistry 的 createSession 工具面 = [run_task]（逐字节不变）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DiscoveredTool } from '@fshine/contracts';
import { loadConfig } from '@fshine/core';
import type { TurnDriver } from './src/driver-contract';
import { createSession, type Session } from './src/execution-runtime';
import { createTaskRegistry } from './src/task-registry';
import { loadMainSkillDelivery } from './src/worker-skills';
import { READ_SKILL_TOOL } from './src/skills';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix = 'main-skill-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 写一份业务技能根：<root>/<relative>/<name>/SKILL.md（frontmatter name/description）。 */
function writeSkill(root: string, relative: string, name: string, description: string, body = `# ${name} 正文`): void {
  const dir = path.join(root, relative, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), ['---', `name: ${name}`, `description: ${description}`, '---', '', body].join('\n'), 'utf8');
}

const MANIFEST: CapabilityManifest = { contractVersion: 1, operations: [{ name: 'dummy.query', label: 'query', args: [] }] };
class FaceClient implements ExecutionClient {
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(): Promise<ExecutionOutcome> {
    return { status: 'completed', data: {} };
  }
}
function unreachableDriver(): TurnDriver {
  return { async run() { throw new Error('（测试）该 driver 不应被调用'); } };
}

interface Recorded { tools: readonly DiscoveredTool[]; results: Array<{ ok: true; value: unknown } | { ok: false; error: unknown }> }
/** 假 Main 驱动：按脚本调工具并记录 input.tools 与 exec 返回/抛错。 */
function toolingMain(calls: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>, sink: Recorded[]): TurnDriver {
  return {
    async run(input) {
      const results: Recorded['results'] = [];
      for (const call of calls) {
        try { results.push({ ok: true, value: await input.exec(call.tool, call.args) }); }
        catch (error) { results.push({ ok: false, error }); }
      }
      sink.push({ tools: input.tools, results });
      return { text: '（测试回合回复）', messages: [...input.messages] };
    },
  };
}

async function buildSession(options: {
  mainSkillRegistry?: Parameters<typeof createSession>[0]['mainSkillRegistry'];
  calls?: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;
}): Promise<{ session: Session; recorded: Recorded[] }> {
  const recorded: Recorded[] = [];
  const session = await createSession({
    principalId: 'wecom:user-a',
    sessionId: 'conv-a',
    client: new FaceClient(),
    allowedOperations: ['dummy.query'],
    mainDriver: toolingMain(options.calls ?? [], recorded),
    workerDriver: unreachableDriver(),
    mainSystemPrompt: '（测试）Main 系统提示',
    taskRegistry: createTaskRegistry(),
    ...(options.mainSkillRegistry === undefined ? {} : { mainSkillRegistry: options.mainSkillRegistry }),
  });
  return { session, recorded };
}

describe('缺口 2 · Main 技能投递（两实验臂，缺省不投递）', () => {
  it('配置：mainSkillRoots/mainSkillMode 解析；缺省 undefined；非法值 fail-fast 点名键', () => {
    const dir = tempDir();
    const base = 'principals: {}\ncontextProfiles:\n  gw:\n    root: /opt/x\n    skillRoots: [".agents/skills-serve"]\n';
    const on = loadConfig({ yamlPath: writeConfig(dir, `${base}    mainSkillRoots: ["skills"]\n    mainSkillMode: catalog\n`), env: {} });
    expect(on.contextProfiles['gw']).toMatchObject({ mainSkillRoots: ['skills'], mainSkillMode: 'catalog' });

    const off = loadConfig({ yamlPath: writeConfig(dir, base), env: {} });
    expect('mainSkillRoots' in (off.contextProfiles['gw'] ?? {})).toBe(false);
    expect('mainSkillMode' in (off.contextProfiles['gw'] ?? {})).toBe(false);

    expect(() => loadConfig({ yamlPath: writeConfig(dir, `${base}    mainSkillMode: sideways\n`), env: {} }))
      .toThrowError(/mainSkillMode/);
    expect(() => loadConfig({ yamlPath: writeConfig(dir, `${base}    mainSkillRoots: []\n`), env: {} }))
      .toThrowError(/mainSkillRoots/);
  });

  it('臂 A（inline）：正文拼进提示块；技能根为空 → promptBlock 空串（缺省金样锚点）', async () => {
    const root = tempDir();
    writeSkill(root, 'skills', 'meeting-notes', '例会纪要口径', '# 例会纪要\n按周次归档。');

    expect(await loadMainSkillDelivery(root, [], 'inline')).toEqual({ promptBlock: '' });

    const delivery = await loadMainSkillDelivery(root, ['skills'], 'inline');
    expect(delivery.registry, '臂 A 不暴露 read_skill').toBeUndefined();
    expect(delivery.promptBlock).toContain('【技能：meeting-notes】');
    expect(delivery.promptBlock).toContain('按周次归档。');
    expect(delivery.promptBlock.startsWith('\n\n')).toBe(true);
  });

  it('臂 B（catalog）：摘要清单只含 name/description，无正文/无绝对路径；registry 可读正文', async () => {
    const root = tempDir();
    writeSkill(root, 'skills', 'meeting-notes', '例会纪要口径', '# 机密正文不应出现在清单里');

    const delivery = await loadMainSkillDelivery(root, ['skills'], 'catalog');
    expect(delivery.promptBlock).toContain('【可用技能');
    expect(delivery.promptBlock).toContain('- meeting-notes：例会纪要口径');
    expect(delivery.promptBlock.includes('机密正文'), '清单不得含技能正文').toBe(false);
    expect(delivery.promptBlock.includes(root), '清单不得泄露绝对路径').toBe(false);

    expect(delivery.registry).toBeDefined();
    await expect(delivery.registry!.read('meeting-notes')).resolves.toMatchObject({ name: 'meeting-notes', content: expect.stringContaining('机密正文') });
  });

  it('臂 B 工具面：注入 registry → 有 read_skill 且 exec 返回正文；未注入 → 无该工具且调用被拒', async () => {
    const root = tempDir();
    writeSkill(root, 'skills', 'meeting-notes', '例会纪要口径', '# 例会纪要正文');
    const delivery = await loadMainSkillDelivery(root, ['skills'], 'catalog');

    const wired = await buildSession({ mainSkillRegistry: delivery.registry, calls: [{ tool: READ_SKILL_TOOL, args: { name: 'meeting-notes' } }] });
    await wired.session.send('用例会纪要口径');
    expect(wired.recorded[0]!.tools.map((tool) => tool.name)).toContain(READ_SKILL_TOOL);
    const result = wired.recorded[0]!.results[0]!;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ name: 'meeting-notes', content: expect.stringContaining('例会纪要正文') });

    const bare = await buildSession({ calls: [{ tool: READ_SKILL_TOOL, args: { name: 'meeting-notes' } }] });
    await bare.session.send('试试');
    expect(bare.recorded[0]!.tools.map((tool) => tool.name)).not.toContain(READ_SKILL_TOOL);
    const rejected = bare.recorded[0]!.results[0]!;
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(String((rejected.error as Error).message)).toContain('Main 工具面之外的调用');
  });

  it('缺省：无 mainSkillRegistry 的 createSession 工具面 = [run_task]（逐字节不变）', async () => {
    const { session, recorded } = await buildSession({});
    await session.send('随便说一句');
    expect(recorded[0]!.tools.map((tool) => tool.name)).toEqual(['run_task']);
  });

  it('臂 B：未知技能名 → registry 报错（不静默、不拼路径）', async () => {
    const root = tempDir();
    writeSkill(root, 'skills', 'meeting-notes', '例会纪要口径');
    const delivery = await loadMainSkillDelivery(root, ['skills'], 'catalog');
    await expect(delivery.registry!.read('../../etc/passwd')).rejects.toThrow('未找到技能');
    await expect(delivery.registry!.read('missing')).rejects.toThrow('未找到技能');
  });
});

function writeConfig(dir: string, content: string): string {
  const file = path.join(dir, `agent-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(file, content, 'utf8');
  return file;
}
