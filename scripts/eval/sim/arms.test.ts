/**
 * A/B 两臂接线自测（确定性假件；零真实模型、零联网）。
 *
 * 覆盖四件事：
 *   1) 两臂配置**逐字相同**：S0 已删除 mainSkillRoots/mainSkillMode，配置里不存在任何
 *      技能键；差异只能在装配参数 `mainSkillsDir`；
 *   2) 装配参数差异**真的生效**：A（空目录）无 catalog / 无 read_skill / 技能块 0 字节；
 *      B（仓库 .agents/skills）catalog 含 finance-business-basics / 有 read_skill / 技能块
 *      非空且含 name，且系统提示除技能块外与 A 逐字一致；
 *   3) **反向绊线**：把 B 臂也指向空目录 → `assertArmSurface` / 两臂核对必须抛错
 *      （证明断言不是恒真）；再指回仓库目录 → 同一断言通过（红→绿）；
 *   4) 默认目录发现：不传 `mainSkillsDir` 时即 `<repo>/.agents/skills`；传了以传的为准；
 *      两臂各 1 条假样本走同一条终态/Oracle 路径，结果带 arm 标签、目录独立。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@fshine/core';
import { defaultMainSkillsDir } from '../../../packages/agent/src/worker-skills';
import type { SimCase } from './case';
import { createReplyOracle } from './oracle';
import { ScriptedSimulator, ScriptedSystem, finishCompletion } from './fakes';
import {
  armDelivery, armMainSkillsDir, assertArmPairDiffersOnlyBySkills, assertArmSurface,
  materializeArmConfig, probeArmAssembly, probeArmPair, runSimArmSuite,
  REQUIRED_B_SKILL, SIM_ARMS, type SimArm, type SimArmProbe, type SimArmSuiteResult,
} from './arms';

const TMP_DIRS: string[] = [];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function tmpRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sim-arms-'));
  TMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 探针子进程白名单 env（dummy 网关是本地 sh → node，需要 PATH）。 */
function probeEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
  };
}

function simCase(overrides: Partial<SimCase> = {}): SimCase {
  return {
    id: 'ARM-SELF',
    goal: '核对 alpha 集合的合计',
    persona: '谨慎的业务员',
    knowledge: ['alpha 集合我有权限'],
    initialMessage: '帮我看一下 alpha 的合计',
    behaviorRules: ['一次只问一件事'],
    forbiddenKnowledge: ['内部工单号 INC-7788'],
    allowedActions: ['say', 'wait', 'finish'],
    terminal: { satisfied: '拿到合计金额', gaveUp: '系统反复答非所问' },
    fixtureId: 'dummy-fixture-alpha',
    oracleId: 'reply:arm-selftest',
    limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 60_000, trials: 1 },
    ...overrides,
  };
}

describe('A/B 两臂：配置逐字相同（技能差异只在装配参数）', () => {
  it('物化配置两臂相等；配置里不存在 mainSkillRoots/mainSkillMode（S0 已删除）', () => {
    const root = tmpRoot();
    const a = materializeArmConfig('A', path.join(root, 'arm-A.yaml'));
    const b = materializeArmConfig('B', path.join(root, 'arm-B.yaml'));
    const configA = loadConfig({ yamlPath: a.configPath, env: {} });
    const configB = loadConfig({ yamlPath: b.configPath, env: {} });

    expect(configB).toEqual(configA);
    expect(a.profile).not.toHaveProperty('mainSkillRoots');
    expect(a.profile).not.toHaveProperty('mainSkillMode');
    expect(b.profile).not.toHaveProperty('mainSkillRoots');
    expect(b.profile).not.toHaveProperty('mainSkillMode');
    // 两臂声明本身也不含配置键。
    expect(SIM_ARMS.A).not.toHaveProperty('mainSkillRoots');
    expect(SIM_ARMS.B).not.toHaveProperty('mainSkillMode');
    expect(SIM_ARMS.A.mainSkillsDirKind).toBe('empty');
    expect(SIM_ARMS.B.mainSkillsDirKind).toBe('repo');
  });
});

describe('A/B 两臂：装配参数差异真的生效', () => {
  it('A 空 catalog/无 read_skill；B 有 finance-business-basics/有 read_skill；系统提示除技能块外一致', async () => {
    const root = tmpRoot();
    const pair = await probeArmPair(path.join(root, 'probe'), probeEnv());
    assertArmPairDiffersOnlyBySkills(pair.a, pair.b);

    // A：空目录 → 全零面。
    expect(pair.a.delivery.catalogBytes).toBe(0);
    expect(pair.a.delivery.promptBlockBytes).toBe(0);
    expect(pair.a.delivery.catalogSkillNames).toEqual([]);
    expect(pair.a.delivery.registryRegistered).toBe(false);
    expect(pair.a.readSkillToolRegistered).toBe(false);
    expect(pair.a.tools).not.toContain('read_skill');
    expect(pair.a.systemPrompt).not.toContain('【可用技能');
    expect(path.basename(pair.a.delivery.mainSkillsDir)).toBe('empty-main-skills');

    // B：仓库 .agents/skills → catalog 含 finance-business-basics。
    expect(pair.b.delivery.mainSkillsDir).toBe(defaultMainSkillsDir());
    expect(pair.b.delivery.mainSkillsDir).toBe(path.join(REPO_ROOT, '.agents', 'skills'));
    expect(pair.b.delivery.catalogSkillNames).toContain(REQUIRED_B_SKILL);
    expect(pair.b.delivery.catalogBytes).toBeGreaterThan(0);
    expect(pair.b.delivery.promptBlockBytes).toBeGreaterThan(0);
    expect(pair.b.delivery.promptBlock).toContain(REQUIRED_B_SKILL);
    expect(pair.b.delivery.registryRegistered).toBe(true);
    expect(pair.b.readSkillToolRegistered).toBe(true);
    expect(pair.b.tools).toContain('read_skill');
    expect(pair.b.systemPrompt).toContain('【可用技能');
    expect(pair.b.systemPrompt).toContain(REQUIRED_B_SKILL);

    // 「只差技能」：B 去掉技能块后与 A 逐字一致，工具面只多 read_skill。
    expect(pair.b.systemPrompt.replace(pair.b.delivery.promptBlock, '')).toBe(pair.a.systemPrompt);
    expect([...pair.b.tools].filter((tool) => tool !== 'read_skill').sort())
      .toEqual([...pair.a.tools].sort());
  });
});

describe('反向绊线：B 指向空目录时断言必须红；指回仓库目录恢复绿', () => {
  it('B 空目录 → assertArmSurface/两臂核对抛错；指回 .agents/skills → 通过', async () => {
    const root = tmpRoot();
    const env = probeEnv();
    const emptyDir = path.join(root, 'empty-for-B');
    mkdirSync(emptyDir, { recursive: true });

    // 红：B 的技能目录被换成空目录（等价于 S0 之前的「两臂完全相同」假配置）。
    const bEmpty = await probeArmAssembly('B', path.join(root, 'probe-empty'), env, { mainSkillsDir: emptyDir });
    expect(bEmpty.delivery.catalogSkillNames).toEqual([]);
    expect(bEmpty.readSkillToolRegistered).toBe(false);
    expect(() => assertArmSurface(bEmpty, { requiredNames: [REQUIRED_B_SKILL] })).toThrow(
      /B 臂 catalog 缺技能 finance-business-basics/,
    );
    const a = await probeArmAssembly('A', path.join(root, 'probe-a'), env);
    expect(() => assertArmPairDiffersOnlyBySkills(a, bEmpty)).toThrow(/A\/B 两臂装配核对失败/);

    // 绿：同一断言指向仓库 .agents/skills 时通过。
    const bRepo = await probeArmAssembly('B', path.join(root, 'probe-repo'), env, {
      mainSkillsDir: path.join(REPO_ROOT, '.agents', 'skills'),
    });
    expect(() => assertArmSurface(bRepo, { requiredNames: [REQUIRED_B_SKILL] })).not.toThrow();
    expect(() => assertArmPairDiffersOnlyBySkills(a, bRepo)).not.toThrow();
  });
});

describe('S0 默认目录发现与显式覆盖', () => {
  it('不传 = <repo>/.agents/skills（含 finance-business-basics）；传空目录则以传的为准', async () => {
    const repoSkills = defaultMainSkillsDir();
    expect(repoSkills).toBe(path.join(REPO_ROOT, '.agents', 'skills'));
    const fromDefault = await armDelivery(repoSkills);
    expect(fromDefault.catalogSkillNames).toContain(REQUIRED_B_SKILL);
    expect(fromDefault.registryRegistered).toBe(true);

    const emptyDir = path.join(tmpRoot(), 'empty');
    mkdirSync(emptyDir, { recursive: true });
    const overridden = await armDelivery(emptyDir);
    expect(overridden.mainSkillsDir).toBe(emptyDir);
    expect(overridden.catalogSkillNames).toEqual([]);
    expect(overridden.catalogBytes).toBe(0);
    expect(overridden.promptBlockBytes).toBe(0);
    expect(overridden.registryRegistered).toBe(false);

    // 臂工厂：A 在运行目录下建空目录；B 用生产默认发现。
    const work = tmpRoot();
    expect(armMainSkillsDir('A', work)).toBe(path.join(work, 'empty-main-skills'));
    expect(existsSync(armMainSkillsDir('A', work))).toBe(true);
    expect(armMainSkillsDir('B', work)).toBe(repoSkills);
  });
});

describe('A/B 两臂：各 1 条假样本走同一条终态/Oracle 路径', () => {
  it('两臂都 terminal=satisfied 且 Oracle 判过 → pass=true；结果带 arm，目录独立', async () => {
    const root = tmpRoot();
    const env = probeEnv();
    const pair = await probeArmPair(path.join(root, 'probe'), env);
    const oracle = createReplyOracle({
      id: 'reply:arm-selftest',
      required: ['合计', '2000'],
      truthPatterns: ['2000'],
    });
    const caseDef = simCase();
    const reply = 'alpha 共 2 条，合计 2000。';

    const runs: Record<SimArm, SimArmSuiteResult> = {} as Record<SimArm, SimArmSuiteResult>;
    for (const arm of ['A', 'B'] as const) {
      const probe: SimArmProbe = arm === 'A' ? pair.a : pair.b;
      runs[arm] = await runSimArmSuite({
        arm,
        outRoot: path.join(root, `arm-${arm}`),
        cases: [caseDef],
        concurrency: 5,
        oracles: [oracle],
        simulator: new ScriptedSimulator([finishCompletion('satisfied', '拿到合计')]),
        createSystem: () => new ScriptedSystem([{ visibleReply: reply }]),
        probe,
        env,
      });
    }

    for (const arm of ['A', 'B'] as const) {
      const run = runs[arm];
      expect(run.arm).toBe(arm);
      expect(run.summary.n).toBe(1);
      expect(run.summary.isolation.concurrency).toBe(5);
      expect(run.trials).toHaveLength(1);
      const trial = run.trials[0]!;
      expect(trial.arm).toBe(arm);
      expect(trial.terminal).toBe('satisfied');
      expect(trial.oracle?.id).toBe('reply:arm-selftest');
      expect(trial.oracle?.verdict.pass).toBe(true);
      expect(trial.pass).toBe(true);
      // 同一判定路径：pass == (terminal satisfied && Oracle pass)。
      expect(trial.pass).toBe(trial.terminal === 'satisfied' && trial.oracle?.verdict.pass === true);
      // 臂标签落盘（trial 根目录，不破坏 evidence/manifest 哈希）。
      const armFile = path.join(trial.paths.root, 'arm.json');
      expect(existsSync(armFile)).toBe(true);
      const armRecord = JSON.parse(readFileSync(armFile, 'utf8')) as { arm: string; mainSkillsDir: string };
      expect(armRecord.arm).toBe(arm);
      expect(armRecord.mainSkillsDir).toBe(run.probe.delivery.mainSkillsDir);
      // 装配探针随臂结果一起返回：A 无 catalog、B 有 catalog + read_skill。
      expect(run.probe.readSkillToolRegistered).toBe(arm === 'B');
      expect(run.probe.delivery.catalogSkillNames.length > 0).toBe(arm === 'B');
      // 探针副本落盘：可直接复核 catalog/技能块字节。
      const probeFile = JSON.parse(readFileSync(path.join(run.outRoot, 'arm-probe.json'), 'utf8')) as {
        delivery: { catalogSkillNames: string[]; catalogBytes: number; promptBlockBytes: number };
      };
      expect(probeFile.delivery.catalogBytes).toBe(run.probe.delivery.catalogBytes);
      expect(probeFile.delivery.promptBlockBytes).toBe(run.probe.delivery.promptBlockBytes);
      expect(probeFile.delivery.catalogSkillNames).toEqual(run.probe.delivery.catalogSkillNames);
    }

    // 两臂唯一的外部差异是臂标签/技能面/目录；判定读数一致。
    const a = runs.A.trials[0]!;
    const b = runs.B.trials[0]!;
    expect(b.terminal).toBe(a.terminal);
    expect(b.pass).toBe(a.pass);
    expect(b.oracle?.id).toBe(a.oracle?.id);
    expect(b.oracle?.verdict).toEqual(a.oracle?.verdict);
    expect(b.replies).toEqual(a.replies);
    expect(a.paths.root).not.toBe(b.paths.root);
    expect(a.paths.evidenceDir).not.toBe(b.paths.evidenceDir);
  });
});
