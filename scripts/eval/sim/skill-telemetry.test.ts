/**
 * 技能链路遥测自测（确定性假件；零真实模型、零联网）。
 *
 * 覆盖任务书三项：
 *   1) 发现：catalog name 列表 / 字节数 / 排序稳定性；
 *   2) 读取：read=true/false、读了哪份、轮次、字节 / token / sha256、失败；
 *   3) 隔离：绝对路径 / 路径穿越 / 符号链接逃逸必须被记录（成功越界记违规）。
 *
 * 遥测只解释、不改判定：本文件的假系统都走既有 `runSimTrial`，`pass` 仍由 Oracle 决定。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SimCase } from './case';
import { createReplyOracle } from './oracle';
import { sayCompletion, ScriptedSimulator, finishCompletion } from './fakes';
import { runSimTrial, writeSimTrialEvidence, type SimSystemTurn, type SimSystemUnderTest } from './run';
import {
  buildSkillTelemetry, classifySkillName, discoverSkillCatalog, skillReadsFromTranscript,
  type SimSkillDiscovery, type SimSkillRead,
} from './skill-telemetry';
import { sha256Hex } from '../convergence-r1/hash';
import { createSkillRegistry } from '../../../packages/agent/src/skills';

const TMP_DIRS: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sim-skill-'));
  TMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 空技能目录（A 臂的装配参数）。 */
function emptySkillsDir(): string {
  const dir = path.join(tmpRoot(), 'empty-skills');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 在 root 下写一份 SKILL.md（目录名与 frontmatter name 一致）。 */
function writeSkill(root: string, relativeRoot: string, name: string, description: string, body = `# ${name}\n正文`): string {
  const dir = path.join(root, relativeRoot, name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`, 'utf8');
  return file;
}

function makeCase(overrides: Partial<SimCase> = {}): SimCase {
  return {
    id: 'SKILL-CASE',
    goal: '核对 alpha 集合的合计',
    persona: '谨慎的业务员',
    knowledge: ['alpha 集合我有权限'],
    initialMessage: '帮我看一下 alpha 的合计',
    behaviorRules: ['一次只问一件事'],
    forbiddenKnowledge: ['内部工单号 INC-7788'],
    allowedActions: ['say', 'wait', 'finish'],
    terminal: { satisfied: '拿到合计金额', gaveUp: '系统反复答非所问' },
    fixtureId: 'dummy-fixture-alpha',
    oracleId: 'reply:skill',
    limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 60_000, trials: 1 },
    ...overrides,
  };
}

const ORACLE = createReplyOracle({ id: 'reply:skill', required: ['合计'], truthPatterns: ['2000'] });

// ─────────────────────────────────────────────────────────────────────────────
// 发现
// ─────────────────────────────────────────────────────────────────────────────

describe('发现：catalog 清单 / 字节数 / 排序稳定性', () => {
  it('按装配参数 mainSkillsDir 发现 name 列表，catalog 有序且可重复，字节数如实', async () => {
    const root = tmpRoot();
    writeSkill(root, '.agents/skills-main', 'alpha', '甲口径');
    writeSkill(root, '.agents/skills-main', 'beta', '乙口径');
    const mainSkillsDir = path.join(root, '.agents/skills-main');
    const discovered = await discoverSkillCatalog({ mainSkillsDir });

    expect(discovered.discovery.available).toBe(true);
    expect(discovered.discovery.mainSkillsDir).toBe(mainSkillsDir);
    expect(discovered.discovery.names).toEqual(['alpha', 'beta']);
    expect(discovered.discovery.readSkillRegistered).toBe(true);
    expect(discovered.discovery.sortedOrder).toEqual(['alpha', 'beta']);
    expect(discovered.discovery.sortedStable).toBe(true);
    expect(discovered.discovery.repeatStable).toBe(true);
    expect(discovered.discovery.catalogBytes).toBeGreaterThan(0);
    // catalog 模式的提示块 = "\n\n" + catalog 正文。
    expect(discovered.discovery.promptBlockBytes).toBe(discovered.discovery.catalogBytes + 2);
    expect([...discovered.filesByName.keys()].sort()).toEqual(['alpha', 'beta']);
  });

  it('空目录 → available=true 但清单为空（A 臂的诚实读数；不改装配）', async () => {
    const discovered = await discoverSkillCatalog({ mainSkillsDir: emptySkillsDir() });
    expect(discovered.discovery.available).toBe(true);
    expect(discovered.discovery.names).toEqual([]);
    expect(discovered.discovery.catalogBytes).toBe(0);
    expect(discovered.discovery.promptBlockBytes).toBe(0);
    expect(discovered.discovery.readSkillRegistered).toBe(false);
    expect(discovered.discovery.sortedStable).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 读取：转录扫描（轮次 / 字节 / token / sha256 / 失败）
// ─────────────────────────────────────────────────────────────────────────────

const SKILL_BODY = '---\nname: alpha\ndescription: 甲口径\n---\n合计口径：逐条列出，末行写合计。\n';

function toolCall(id: string, name: string): unknown {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'read_skill', arguments: { name } }],
    timestamp: 0,
  };
}

function toolResult(id: string, text: string, isError = false): unknown {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read_skill',
    content: [{ type: 'text', text }],
    isError,
    timestamp: 0,
  };
}

function user(text: string): unknown {
  return { role: 'user', content: text, timestamp: 0 };
}

describe('读取：从 Pi 原生转录提取 read_skill', () => {
  it('轮次按用户消息序号机械标注：第 1 轮与第 2 轮分清', async () => {
    const transcript = [
      user('第一问'),
      toolCall('c1', 'alpha'),
      toolResult('c1', JSON.stringify({ name: 'alpha', content: SKILL_BODY })),
      user('第二问'),
      toolCall('c2', 'beta'),
      toolResult('c2', '未找到技能:beta', true),
    ];
    const reads = await skillReadsFromTranscript({ messages: transcript });
    expect(reads).toHaveLength(2);
    expect(reads[0]!.turn).toBe(1);
    expect(reads[0]!.ok).toBe(true);
    expect(reads[1]!.turn).toBe(2);
    expect(reads[1]!.ok).toBe(false);
    expect(reads[1]!.rejection?.kind).toBe('not_found');
  });

  it('正文字节 / token / sha256 与实际正文一致', async () => {
    const root = tmpRoot();
    const file = writeSkill(root, '.agents/skills-main', 'alpha', '甲口径');
    const discovered = await discoverSkillCatalog({ mainSkillsDir: path.join(root, '.agents/skills-main') });
    const content = readFileSync(file, 'utf8');
    const reads = await skillReadsFromTranscript({
      messages: [user('问'), toolCall('c1', 'alpha'), toolResult('c1', JSON.stringify({ name: 'alpha', content }))],
      filesByName: discovered.filesByName,
      absoluteRoots: discovered.absoluteRoots,
    });
    expect(reads).toHaveLength(1);
    expect(reads[0]!.ok).toBe(true);
    expect(reads[0]!.bytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(reads[0]!.sha256).toBe(sha256Hex(content));
    expect(reads[0]!.tokens).toBe(Math.ceil(content.length / 4));
    expect(reads[0]!.verifiedInRoots).toBe(true);
    expect(reads[0]!.isolationViolation).toBe(false);
  });

  it('调用没有结果 → 失败留证（不冒充成功）', async () => {
    const reads = await skillReadsFromTranscript({ messages: [user('问'), toolCall('c1', 'alpha')] });
    expect(reads[0]!.ok).toBe(false);
    expect(reads[0]!.failure).toBe('no_result');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 隔离：越界必须被拒并记录
// ─────────────────────────────────────────────────────────────────────────────

describe('隔离：绝对路径 / 穿越 / 符号链接逃逸', () => {
  it('名称分类：绝对路径与路径穿越先于任何文件访问被拒', () => {
    expect(classifySkillName('/etc/passwd')?.kind).toBe('absolute_path');
    expect(classifySkillName('C:\\Windows\\win.ini')?.kind).toBe('absolute_path');
    expect(classifySkillName('../secrets')?.kind).toBe('path_traversal');
    expect(classifySkillName('nested/skill')?.kind).toBe('path_traversal');
    expect(classifySkillName('..')?.kind).toBe('path_traversal');
    expect(classifySkillName('')?.kind).toBe('invalid_name');
    expect(classifySkillName('alpha')).toBeUndefined();
  });

  it('绝对路径读取被生产注册表拒绝，遥测记录 absolute_path 且不计违规', async () => {
    const reads = await skillReadsFromTranscript({
      messages: [
        user('问'),
        toolCall('c1', '/etc/passwd'),
        toolResult('c1', '技能名称无效。', true),
      ],
    });
    expect(reads[0]!.ok).toBe(false);
    expect(reads[0]!.rejection?.kind).toBe('absolute_path');
    expect(reads[0]!.isolationViolation).toBe(false);
    expect(buildSkillTelemetry(undefined, reads).isolation.violations).toBe(0);
  });

  it('生产注册表真的拒绝绝对路径与路径穿越（遥测分类与执行层拒绝一致）', async () => {
    const root = tmpRoot();
    writeSkill(root, '.agents/skills-main', 'alpha', '甲口径');
    const registry = createSkillRegistry({ rootDir: path.join(root, '.agents/skills-main') });
    await expect(registry.read('/etc/passwd')).rejects.toThrow('技能名称无效');
    await expect(registry.read('../alpha')).rejects.toThrow('技能名称无效');
  });

  it('符号链接逃逸：成功返回但落盘真实路径在技能根外 → 记隔离违规', async () => {
    const root = tmpRoot();
    const outside = path.join(tmpRoot(), 'outside', 'evil');
    mkdirSync(outside, { recursive: true });
    const outsideFile = path.join(outside, 'SKILL.md');
    writeFileSync(outsideFile, SKILL_BODY, 'utf8');
    const link = path.join(root, '.agents', 'skills-main', 'evil');
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(outside, link, 'dir');

    const reads = await skillReadsFromTranscript({
      messages: [
        user('问'),
        toolCall('c1', 'evil'),
        toolResult('c1', JSON.stringify({ name: 'evil', content: SKILL_BODY })),
      ],
      filesByName: new Map([['evil', path.join(link, 'SKILL.md')]]),
      absoluteRoots: [path.join(root, '.agents', 'skills-main')],
    });
    expect(reads[0]!.ok).toBe(true);
    expect(reads[0]!.verifiedInRoots).toBe(false);
    expect(reads[0]!.rejection?.kind).toBe('symlink_escape');
    expect(reads[0]!.isolationViolation).toBe(true);
    expect(buildSkillTelemetry(undefined, reads).isolation.violations).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// trial 接线：读 / 不读两条 trial，字段与轮次进证据
// ─────────────────────────────────────────────────────────────────────────────

/** 假系统：按回合吐出预设 skill 读数；同时暴露 catalog 发现。 */
class SkillFakeSystem implements SimSystemUnderTest {
  private turn = 0;
  constructor(
    private readonly discovery: SimSkillDiscovery,
    private readonly readsByTurn: Readonly<Record<number, readonly SimSkillRead[]>>,
    private readonly reply: (turn: number) => string,
  ) {}

  async send(): Promise<SimSystemTurn> {
    this.turn += 1;
    const skillReads = this.readsByTurn[this.turn];
    return {
      visibleReply: this.reply(this.turn),
      toolCalls: skillReads?.length ?? 0,
      ...(skillReads === undefined ? {} : { skillReads }),
    };
  }

  skillDiscovery(): SimSkillDiscovery {
    return this.discovery;
  }
}

function readRecord(overrides: Partial<SimSkillRead> = {}): SimSkillRead {
  const content = '合计口径正文';
  return {
    toolCallId: 'call-1',
    turn: 2,
    name: 'record-digest',
    ok: true,
    bytes: Buffer.byteLength(content, 'utf8'),
    tokens: Math.ceil(content.length / 4),
    sha256: sha256Hex(content),
    verifiedInRoots: true,
    isolationViolation: false,
    ...overrides,
  };
}

describe('trial 接线：read=true/false 与轮次进结构化证据', () => {
  it('会读技能的 trial：read=true、读了哪份、第 2 轮', async () => {
    const discovery = (await discoverSkillCatalog({ mainSkillsDir: emptySkillsDir() })).discovery;
    const system = new SkillFakeSystem(
      discovery,
      { 2: [readRecord({ turn: 2 })] },
      (turn) => (turn === 1 ? '正在核对合计。' : '合计 2000，共 2 条。'),
    );
    const simulator = new ScriptedSimulator([sayCompletion('继续'), finishCompletion('satisfied', '拿到合计了')]);
    const result = await runSimTrial(makeCase(), 1, {
      outRoot: tmpRoot(), createSystem: () => system, simulator, oracle: ORACLE,
    });

    expect(result.terminal).toBe('satisfied');
    expect(result.pass).toBe(true);
    expect(result.skills.read).toBe(true);
    expect(result.skills.reads).toHaveLength(1);
    expect(result.skills.reads[0]!.name).toBe('record-digest');
    expect(result.skills.reads[0]!.turn).toBe(2);
    expect(result.skills.successfulReads).toBe(1);
    expect(result.skills.verifiedReads).toBe(1);
    expect(result.skills.isolation.violations).toBe(0);
    expect(result.skills.discovery.available).toBe(true);
  });

  it('不读技能的 trial：read=false 且 reads 为空（不伪造读取）', async () => {
    const discovery = (await discoverSkillCatalog({ mainSkillsDir: emptySkillsDir() })).discovery;
    const system = new SkillFakeSystem(discovery, {}, () => '合计 2000，共 2 条。');
    const simulator = new ScriptedSimulator([finishCompletion('satisfied', '拿到合计了')]);
    const result = await runSimTrial(makeCase(), 1, {
      outRoot: tmpRoot(), createSystem: () => system, simulator, oracle: ORACLE,
    });

    expect(result.pass).toBe(true);
    expect(result.skills.read).toBe(false);
    expect(result.skills.reads).toEqual([]);
    expect(result.skills.successfulReads).toBe(0);
  });

  it('证据落盘：skills.json 与 manifest 哈希', async () => {
    const discovery = (await discoverSkillCatalog({ mainSkillsDir: emptySkillsDir() })).discovery;
    const system = new SkillFakeSystem(discovery, { 2: [readRecord()] }, (turn) =>
      (turn === 1 ? '正在核对合计。' : '合计 2000，共 2 条。'));
    const simulator = new ScriptedSimulator([sayCompletion('继续'), finishCompletion('satisfied', '拿到合计了')]);
    const result = await runSimTrial(makeCase(), 1, {
      outRoot: tmpRoot(), createSystem: () => system, simulator, oracle: ORACLE,
    });

    const dir = writeSimTrialEvidence(result);
    const skills = JSON.parse(readFileSync(path.join(dir, 'skills.json'), 'utf8')) as {
      read: boolean;
      reads: Array<{ turn: number; name: string }>;
    };
    expect(skills.read).toBe(true);
    expect(skills.reads[0]!.turn).toBe(2);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
      files: Array<{ name: string }>;
    };
    expect(manifest.files.map((file) => file.name)).toContain('skills.json');
  });
});
