/**
 * A/B 两臂接线自测（确定性假件；零真实模型、零联网）。
 *
 * 覆盖三件事：
 *   1) 两臂配置**只差技能**：物化出的两份配置去掉 mainSkillRoots/mainSkillMode 后逐字相等；
 *   2) 配置差异**真的生效**：生产同源装配探针里，A 无 catalog / 无 read_skill，
 *      B 有 catalog（record-digest、value-note）/ 有 read_skill，且系统提示除技能块外一致；
 *   3) 两臂各 1 条假样本：终态 satisfied、Oracle 判过 → pass=true，两臂走同一条判定路径，
 *      结果带 `arm` 标签，逐 trial 目录独立。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '@fshine/core';
import type { SimCase } from './case';
import { createReplyOracle } from './oracle';
import { ScriptedSimulator, ScriptedSystem, finishCompletion } from './fakes';
import {
  assertArmPairDiffersOnlyBySkills, materializeArmConfig, probeArmPair, runSimArmSuite,
  SIM_ARMS, type SimArm, type SimArmProbe, type SimArmSuiteResult,
} from './arms';

const TMP_DIRS: string[] = [];

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

/** 去掉技能键后的配置（两臂必须逐字相等）。 */
function withoutSkillKeys(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, inner) =>
    (key === 'mainSkillRoots' || key === 'mainSkillMode' ? undefined : inner)));
}

describe('A/B 两臂：配置只差技能', () => {
  it('物化配置去掉 mainSkillRoots/mainSkillMode 后逐字相等；A 无技能、B 为 catalog', () => {
    const root = tmpRoot();
    const a = materializeArmConfig('A', path.join(root, 'arm-A.yaml'));
    const b = materializeArmConfig('B', path.join(root, 'arm-B.yaml'));
    const configA = loadConfig({ yamlPath: a.configPath, env: {} });
    const configB = loadConfig({ yamlPath: b.configPath, env: {} });

    expect(withoutSkillKeys(configB)).toEqual(withoutSkillKeys(configA));

    const profileA = a.profile;
    const profileB = b.profile;
    expect(profileA.mainSkillRoots).toBeUndefined();
    expect(profileA.mainSkillMode).toBeUndefined();
    expect(profileB.mainSkillRoots).toEqual(['.agents/skills-main']);
    expect(profileB.mainSkillMode).toBe('catalog');
    expect(SIM_ARMS.A.mainSkillRoots).toEqual([]);
    expect(SIM_ARMS.B.mainSkillMode).toBe('catalog');
  });
});

describe('A/B 两臂：装配层差异真的生效', () => {
  it('A 无 catalog/read_skill；B 有 catalog/read_skill；系统提示除技能块外一致', async () => {
    const root = tmpRoot();
    const pair = await probeArmPair(path.join(root, 'probe'), probeEnv());
    // 探针函数内部已断言；这里再显式固定关键事实，防止未来静默放宽。
    assertArmPairDiffersOnlyBySkills(pair.a, pair.b);

    expect(pair.a.delivery.promptBlockBytes).toBe(0);
    expect(pair.a.delivery.catalogSkillNames).toEqual([]);
    expect(pair.a.delivery.registryRegistered).toBe(false);
    expect(pair.a.readSkillToolRegistered).toBe(false);
    expect(pair.a.tools).not.toContain('read_skill');
    expect(pair.a.systemPrompt).not.toContain('【可用技能');

    expect(pair.b.delivery.catalogSkillNames).toContain('record-digest');
    expect(pair.b.delivery.catalogSkillNames).toContain('value-note');
    expect(pair.b.delivery.registryRegistered).toBe(true);
    expect(pair.b.readSkillToolRegistered).toBe(true);
    expect(pair.b.tools).toContain('read_skill');
    expect(pair.b.systemPrompt).toContain('【可用技能');
    expect(pair.b.systemPrompt).toContain('record-digest');
    expect(pair.b.systemPrompt).toContain('value-note');

    // 「只差技能」：B 去掉技能块后与 A 逐字一致，工具面只多 read_skill。
    expect(pair.b.systemPrompt.replace(pair.b.delivery.promptBlock, '')).toBe(pair.a.systemPrompt);
    expect([...pair.b.tools].filter((tool) => tool !== 'read_skill').sort())
      .toEqual([...pair.a.tools].sort());
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
      expect(JSON.parse(readFileSync(armFile, 'utf8')).arm).toBe(arm);
      // 装配探针随臂结果一起返回：A 无 catalog、B 有 catalog + read_skill。
      expect(run.probe.readSkillToolRegistered).toBe(arm === 'B');
      expect(run.probe.delivery.catalogSkillNames.length > 0).toBe(arm === 'B');
    }

    // 两臂唯一的外部差异是臂标签与目录；判定读数一致。
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
