/**
 * Main 技能面（唯一机制）——固定目录 + catalog + read_skill，无模式开关。
 *
 * 机制：Main 技能固定从 `<repo>/.agents/skills` 发现（仓库根用标记法定位，不用 cwd）；
 * 系统提示只接 name+description 的 catalog；正文经 `read_skill` 按需读取；catalog 为空
 * 时不注册 `read_skill`。无 inline 投递、无 `mainSkillMode`、无配置键——测试只能经装配
 * 参数 `mainSkillsDir` 换目录（代码/测试用）。
 *
 * 判据（全部假件/临时目录，零网络/零模型）：
 *   · 仓库根定位：源码（tsx）运行、构建产物布局、不同 cwd 三态结果一致；找不到 fail-closed；
 *   · catalog：name 升序稳定排序、重名 fail-closed、字节数可读、空目录 → 空索引；
 *   · read_skill：仅 catalog 非空才注册；读取只允许目录内；`../`/绝对路径/符号链接逃逸被拒；
 *   · 删除面：旧配置键被忽略且不再出现在 profile 上；工具面缺省仍为 [run_task]。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DiscoveredTool } from '@fshine/contracts';
import { loadConfig } from '@fshine/core';
import { assembleSessionCore } from '../../scripts/ask-runtime';
import type { TurnDriver } from './src/driver-contract';
import { createSession, type Session } from './src/execution-runtime';
import { createTaskRegistry } from './src/task-registry';
import { READ_SKILL_TOOL } from './src/skills';
import { defaultMainSkillsDir, loadMainSkillDelivery, MAIN_SKILLS_RELATIVE_DIR } from './src/worker-skills';
import { resolveRepoRoot } from './src/repo-root';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX_LOADER = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const TSC_BIN = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix = 'main-skill-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 写一份业务技能：<skillsDir>/<name>/SKILL.md（frontmatter name/description）。 */
function writeSkill(skillsDir: string, name: string, description: string, body = `# ${name} 正文`): void {
  const dir = path.join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), ['---', `name: ${name}`, `description: ${description}`, '---', '', body].join('\n'), 'utf8');
}

function skillsDirWith(names: ReadonlyArray<[name: string, description: string]>): string {
  const dir = path.join(tempDir(), 'skills');
  mkdirSync(dir, { recursive: true });
  for (const [name, description] of names) writeSkill(dir, name, description);
  return dir;
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

interface Recorded { systemPrompt: string; tools: readonly DiscoveredTool[]; results: Array<{ ok: true; value: unknown } | { ok: false; error: unknown }> }
/** 假 Main 驱动：按脚本调工具并记录 input.systemPrompt/input.tools 与 exec 返回/抛错。 */
function toolingMain(calls: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>, sink: Recorded[]): TurnDriver {
  return {
    async run(input) {
      const results: Recorded['results'] = [];
      for (const call of calls) {
        try { results.push({ ok: true, value: await input.exec(call.tool, call.args) }); }
        catch (error) { results.push({ ok: false, error }); }
      }
      sink.push({ systemPrompt: input.systemPrompt, tools: input.tools, results });
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

/** 用 tsx / 纯 node 跑一段 ESM 代码并返回 stdout（trim 后）。 */
function runNode(code: string, options: { cwd: string; tsx: boolean }): string {
  const args = options.tsx
    ? ['--import', TSX_LOADER, '--input-type=module', '-e', code]
    : ['--input-type=module', '-e', code];
  return execFileSync(process.execPath, args, { cwd: options.cwd, encoding: 'utf8', timeout: 60_000 }).trim();
}

describe('仓库根定位（标记法：package.json + .agents/，不依赖 cwd）', () => {
  it('源码（tsx）运行：自模块位置向上命中仓库根', () => {
    const out = runNode(
      `import { resolveRepoRoot } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'packages', 'agent', 'src', 'repo-root.ts')).href)};`
      + 'process.stdout.write(resolveRepoRoot());',
      { cwd: REPO_ROOT, tsx: true },
    );
    expect(out).toBe(REPO_ROOT);
  });

  it('构建产物布局：tsc 输出到临时 dist 后，仍自产物位置向上定位', () => {
    const builtRoot = tempDir('main-skill-dist-');
    writeFileSync(path.join(builtRoot, 'package.json'), '{"type":"module"}\n', 'utf8');
    mkdirSync(path.join(builtRoot, '.agents', 'skills'), { recursive: true });
    execFileSync(process.execPath, [
      TSC_BIN,
      '--outDir', path.join(builtRoot, 'dist'),
      '--rootDir', REPO_ROOT,
      '--target', 'ES2022',
      '--module', 'ESNext',
      '--moduleResolution', 'Bundler',
      '--skipLibCheck',
      '--strict',
      path.join(REPO_ROOT, 'packages', 'agent', 'src', 'repo-root.ts'),
    ], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });

    const emitted = path.join(builtRoot, 'dist', 'packages', 'agent', 'src', 'repo-root.js');
    const out = runNode(
      `import { resolveRepoRoot } from ${JSON.stringify(pathToFileURL(emitted).href)};`
      + 'process.stdout.write(resolveRepoRoot());',
      { cwd: os.tmpdir(), tsx: false },
    );
    expect(out).toBe(builtRoot);
  });

  it('不同 cwd 启动结果不变（cwd 不在仓库内也定位到仓库根）', () => {
    const elsewhere = tempDir('main-skill-cwd-');
    const out = runNode(
      `import { resolveRepoRoot } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'packages', 'agent', 'src', 'repo-root.ts')).href)};`
      + 'process.stdout.write(resolveRepoRoot());',
      { cwd: elsewhere, tsx: true },
    );
    expect(out).toBe(REPO_ROOT);
    // 进程内结果同源：默认目录 = <repo>/.agents/skills。
    expect(resolveRepoRoot()).toBe(REPO_ROOT);
    expect(defaultMainSkillsDir()).toBe(path.join(REPO_ROOT, MAIN_SKILLS_RELATIVE_DIR));
  });

  it('找不到标记即 fail-closed：错误点名起始目录、层数与判据（不回落 cwd）', () => {
    const bare = tempDir('main-skill-bare-');
    expect(() => resolveRepoRoot({ from: bare, maxDepth: 0 })).toThrow(/仓库根定位失败/);
    expect(() => resolveRepoRoot({ from: bare, maxDepth: 0 })).toThrow(/package\.json/);
    expect(() => resolveRepoRoot({ from: bare, maxDepth: 0 })).toThrow(/\.agents/);
  });
});

describe('catalog（name+description 清单）', () => {
  it('默认目录：<repo>/.agents/skills（固定位置，无配置键）', () => {
    expect(MAIN_SKILLS_RELATIVE_DIR).toBe(path.join('.agents', 'skills'));
    expect(defaultMainSkillsDir()).toBe(path.join(resolveRepoRoot(), '.agents', 'skills'));
  });

  it('拒绝相对目录（不按进程 cwd 解析，fail-closed）', async () => {
    await expect(loadMainSkillDelivery('.agents/skills')).rejects.toThrow(/必须是绝对路径/);
  });

  it('按 name 升序稳定排序；catalog 字节数与清单同源可读', async () => {
    const skillsDir = skillsDirWith([
      ['zeta-skill', 'Z 口径'],
      ['alpha-skill', 'A 口径'],
      ['mike-skill', 'M 口径'],
    ]);
    const delivery = await loadMainSkillDelivery(skillsDir);
    const order = ['alpha-skill', 'mike-skill', 'zeta-skill'];
    const indexes = order.map((name) => delivery.catalog.indexOf(`- ${name}：`));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    expect(delivery.catalogBytes).toBe(Buffer.byteLength(delivery.catalog, 'utf8'));
    expect(delivery.catalogBytes).toBeGreaterThan(0);
    expect(delivery.promptBlock).toBe(`\n\n${delivery.catalog}`);
    expect(delivery.promptBlock.includes(skillsDir), '清单不得泄露绝对路径').toBe(false);
  });

  it('重名 fail-closed（不静默让排序决定谁胜出）', async () => {
    const skillsDir = path.join(tempDir(), 'skills');
    writeSkill(skillsDir, 'dup-skill', '第一份');
    writeSkill(path.join(skillsDir, 'nested'), 'dup-skill', '第二份');
    await expect(loadMainSkillDelivery(skillsDir)).rejects.toThrow(/技能名称重复:dup-skill/);
  });

  it('空目录/缺失目录 → 空索引（promptBlock 空串、字节 0、无登记表）', async () => {
    const empty = path.join(tempDir(), 'skills');
    mkdirSync(empty, { recursive: true });
    for (const dir of [empty, path.join(empty, 'does-not-exist')]) {
      const delivery = await loadMainSkillDelivery(dir);
      expect(delivery).toEqual({ promptBlock: '', catalog: '', catalogBytes: 0 });
    }
  });
});

describe('read_skill（仅 catalog 非空才注册；读取只允许目录内）', () => {
  it('catalog 非空 → 登记表可读正文；空索引 → 不给出登记表', async () => {
    const skillsDir = skillsDirWith([['meeting-notes', '例会纪要口径']]);
    const delivery = await loadMainSkillDelivery(skillsDir);
    expect(delivery.registry).toBeDefined();
    await expect(delivery.registry!.read('meeting-notes')).resolves.toMatchObject({
      name: 'meeting-notes',
      content: expect.stringContaining('meeting-notes 正文'),
    });
    expect((await loadMainSkillDelivery(path.join(tempDir(), 'empty'))).registry).toBeUndefined();
  });

  it('路径安全：拒绝 "../"（不拼路径、不泄露目录外正文）', async () => {
    const outside = path.join(tempDir(), 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: secret\ndescription: 目录外\n---\n机密正文\n', 'utf8');
    const skillsDir = skillsDirWith([['meeting-notes', '例会纪要口径']]);
    const delivery = await loadMainSkillDelivery(skillsDir);
    await expect(delivery.registry!.read('../outside')).rejects.toThrow(/技能名称无效/);
    await expect(delivery.registry!.read('../outside/secret')).rejects.toThrow(/技能名称无效/);
  });

  it('路径安全：拒绝绝对路径', async () => {
    const skillsDir = skillsDirWith([['meeting-notes', '例会纪要口径']]);
    const delivery = await loadMainSkillDelivery(skillsDir);
    await expect(delivery.registry!.read('/etc/passwd')).rejects.toThrow(/技能名称无效/);
    await expect(delivery.registry!.read(path.join(skillsDir, 'meeting-notes'))).rejects.toThrow(/技能名称无效/);
  });

  it('路径安全：符号链接逃逸被拒（目录链接与文件链接都不进发现集）', async () => {
    const outside = path.join(tempDir(), 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: escaped\ndescription: 目录外\n---\n逃逸正文\n', 'utf8');
    const skillsDir = path.join(tempDir(), 'skills');
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(outside, path.join(skillsDir, 'escaped-dir'), 'dir');
    mkdirSync(path.join(skillsDir, 'escaped-file'), { recursive: true });
    symlinkSync(path.join(outside, 'SKILL.md'), path.join(skillsDir, 'escaped-file', 'SKILL.md'), 'file');

    const delivery = await loadMainSkillDelivery(skillsDir);
    expect(delivery.catalog).toBe('');
    expect(delivery.registry).toBeUndefined();
  });
});

describe('装配接线（mainSkillsDir 只作为装配参数；无配置键）', () => {
  it('装配参数 mainSkillsDir：catalog 进系统提示，read_skill 注册且可读正文', async () => {
    const root = tempDir();
    const skillsDir = path.join(root, 'skills');
    writeSkill(skillsDir, 'meeting-notes', '例会纪要口径', '# 例会纪要正文');
    const recorded: Recorded[] = [];
    const assembled = await assembleSessionCore({
      env: {},
      profile: { root, skillRoots: [], gateway: 'bin/dummy' },
      principalId: 'wecom:user-a',
      sessionId: 'conv-assembly',
      dbPath: path.join(root, 'unused.db'),
      stateDir: root,
      emptyOperationsMessage: '空允许集合',
      workerSkills: [],
      taskRegistry: createTaskRegistry(),
      mainSkillsDir: skillsDir,
      createDrivers: () => ({
        mainDriver: toolingMain([{ tool: READ_SKILL_TOOL, args: { name: 'meeting-notes' } }], recorded),
        workerDriver: unreachableDriver(),
      }),
      createExecutionFace: async () => ({
        client: new FaceClient(),
        allowedOperations: ['dummy.query'],
        readOnlyOperations: ['dummy.query'],
      }),
    });
    try {
      await assembled.session.send('用例会纪要口径');
    } finally {
      assembled.close();
    }
    const turn = recorded[0]!;
    expect(turn.systemPrompt).toContain('meeting-notes');
    expect(turn.systemPrompt).toContain('例会纪要口径');
    expect(turn.tools.map((tool) => tool.name)).toContain(READ_SKILL_TOOL);
    const result = turn.results[0]!;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ content: expect.stringContaining('例会纪要正文') });
  });

  it('旧配置键（mainSkillRoots/mainSkillMode）被忽略，不再出现在 profile 上、也不再校验', () => {
    const dir = tempDir();
    const yaml = [
      'principals: {}',
      'contextProfiles:',
      '  gw:',
      '    root: /opt/x',
      '    skillRoots: [".agents/skills-serve"]',
      '    # 旧实验键：Main 技能面已固定目录，加载层原样忽略（含非法值也不再报错）。',
      '    mainSkillRoots: []',
      '    mainSkillMode: sideways',
      '',
    ].join('\n');
    const file = path.join(dir, 'agent.yaml');
    writeFileSync(file, yaml, 'utf8');
    const config = loadConfig({ yamlPath: file, env: {} });
    const profile = config.contextProfiles['gw']!;
    expect('mainSkillRoots' in profile).toBe(false);
    expect('mainSkillMode' in profile).toBe(false);
  });

  it('read_skill 工具面同源门控：未注入登记表 → 无该工具且调用被拒', async () => {
    const { session, recorded } = await buildSession({ calls: [{ tool: READ_SKILL_TOOL, args: { name: 'meeting-notes' } }] });
    await session.send('试试');
    expect(recorded[0]!.tools.map((tool) => tool.name)).not.toContain(READ_SKILL_TOOL);
    const rejected = recorded[0]!.results[0]!;
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(String((rejected.error as Error).message)).toContain('Main 工具面之外的调用');
  });

  it('缺省工具面：无登记表的 createSession = [run_task]（逐字节不变）', async () => {
    const { session, recorded } = await buildSession({});
    await session.send('随便说一句');
    expect(recorded[0]!.tools.map((tool) => tool.name)).toEqual(['run_task']);
  });

  it('未知技能名 → 报错（不静默、不拼路径）', async () => {
    const skillsDir = skillsDirWith([['meeting-notes', '例会纪要口径']]);
    const delivery = await loadMainSkillDelivery(skillsDir);
    await expect(delivery.registry!.read('missing')).rejects.toThrow('未找到技能');
  });
});
