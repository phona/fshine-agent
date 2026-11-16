/**
 * SimCase 薄机制 · 轨迹分叉：同一用例、三个不同 persona/behavior 的模拟用户 → 三条轨迹两两不同。
 *
 * 这是「模拟用户按目标自主决策，而不是照脚本走」的证据：
 *   · 三个 trial 的目标 / 已知信息 / 终态描述 / Oracle / 被测系统假件完全相同，
 *     只有 persona 与 behaviorRules 不同；
 *   · 三份首轮 prompt 去掉人设与行为规则后**逐字相同**——说明 Harness 没有额外注入路径；
 *   · 轨迹（say / wait / finish 序列、系统收到的话、收尾时机）却两两不同——决定来自模拟用户这一侧。
 *
 * 若本用例失败（轨迹相同），说明 prompt 或 Harness 把路径写成了脚本，必须改，而不是放宽断言。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runSimTrial, type SimTrialResult } from './run';
import type { SimCase } from './case';
import { resolveOracle } from './oracle';
import { ReactivePersonaSimulator, ScriptedSystem, type FakeSystemTurn } from './fakes';
import { SIM_CASE_ORACLES, SIM_CASES } from './cases';

const TMP_DIRS: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sim-divergence-'));
  TMP_DIRS.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BASE_CASE = SIM_CASES.find((caseDef) => caseDef.id === 'SIM-01');
if (BASE_CASE === undefined) throw new Error('SIM-01 用例缺失');
const BASE: SimCase = BASE_CASE;

/** 同一用例只换 persona/behaviorRules（目标、已知、终态、夹具、Oracle 全不变）。 */
function personaVariant(input: {
  id: string;
  persona: string;
  behaviorRules: readonly string[];
}): SimCase {
  return { ...BASE, id: input.id, persona: input.persona, behaviorRules: input.behaviorRules };
}

/**
 * 同一份假系统脚本：第一轮交付结果并问「需要我再发一次吗」；再被问就给同一份结果。
 * （只回答，不决定用户要不要再要一次——那由 persona 决定。）
 */
function systemTurns(): readonly FakeSystemTurn[] {
  return [
    {
      visibleReply: 'alpha 共 2 条，合计 2000。需要我再发一次吗？',
      toolCalls: 1,
      executions: [{ operation: 'dummy.query', status: 'completed' }],
    },
    {
      visibleReply: '刚才那份结果：alpha 共 2 条，合计 2000。',
      toolCalls: 0,
      executions: [],
    },
  ];
}

/** 去掉人设与行为规则后的 prompt 骨架（其余必须逐字相同，否则不是「只差 persona」）。 */
function skeleton(user: string, caseDef: SimCase): string {
  const drop = new Set<string>([caseDef.persona, ...caseDef.behaviorRules.map((rule) => `- ${rule}`)]);
  return user.split('\n').filter((line) => !drop.has(line.trim())).join('\n');
}

async function runWith(caseDef: SimCase, style: 'thorough' | 'impatient' | 'patient'): Promise<{
  result: SimTrialResult;
  simulator: ReactivePersonaSimulator;
  system: ScriptedSystem;
}> {
  const simulator = new ReactivePersonaSimulator(style);
  const system = new ScriptedSystem(systemTurns());
  const result = await runSimTrial(caseDef, 1, {
    outRoot: tmpRoot(),
    createSystem: () => system,
    simulator,
    oracle: resolveOracle(caseDef.oracleId, SIM_CASE_ORACLES),
  });
  return { result, simulator, system };
}

const THOROUGH = personaVariant({
  id: 'SIM-01-thorough',
  persona: '严谨的项目助理，拿到结果会再要一次确认前后一致，说话简短。',
  behaviorRules: ['拿到结果后再要一次同一份结果，确认两次一致才收尾', '不自己报数字'],
});
const IMPATIENT = personaVariant({
  id: 'SIM-01-impatient',
  persona: '急躁的项目助理，看到结果就走，不额外确认，说话简短。',
  behaviorRules: ['一次拿到结果就收尾，不再追问、不再确认', '不自己报数字'],
});
const PATIENT = personaVariant({
  id: 'SIM-01-patient',
  persona: '耐心的项目助理，结果出来之前愿意先等一会儿，不被催着走。',
  behaviorRules: ['结果出来之前先等一会儿，再决定要不要再要一次', '不自己报数字'],
});

describe('轨迹分叉：persona/behavior 不同 → 三条轨迹两两不同', () => {
  it('同一用例 + 同一假系统：严谨版复核、急躁版立即收尾、耐心版先等再复核', async () => {
    const thorough = await runWith(THOROUGH, 'thorough');
    const impatient = await runWith(IMPATIENT, 'impatient');
    const patient = await runWith(PATIENT, 'patient');
    const runs = [thorough, impatient, patient];

    // 环境相同、Oracle 相同：差别只可能来自模拟用户。
    // 严谨 / 耐心走到第二步 → Oracle 判真；急躁版一次就收尾（**没走到第二步**）→
    // terminal 仍是 satisfied（用户自己满意），但 Oracle 必须判 false。用户满意 ≠ 通过。
    for (const run of [thorough, patient]) {
      expect(run.result.terminal).toBe('satisfied');
      expect(run.result.oracle?.verdict.pass).toBe(true);
      expect(run.result.pass).toBe(true);
    }
    expect(impatient.result.terminal).toBe('satisfied');
    expect(impatient.result.oracle?.verdict.pass).toBe(false);
    expect(impatient.result.pass).toBe(false);
    expect(impatient.result.messages.filter((message) => message.action === 'say')).toHaveLength(1);

    // 三条轨迹的 say/wait/finish 序列与系统收话都不同。
    expect(thorough.result.messages.map((m) => m.action)).toEqual(['say', 'say', 'finish']);
    expect(impatient.result.messages.map((m) => m.action)).toEqual(['say', 'finish']);
    expect(patient.result.messages.map((m) => m.action)).toEqual(['say', 'wait', 'say', 'finish']);
    expect(thorough.system.sends).toHaveLength(2);
    expect(impatient.system.sends).toHaveLength(1);
    expect(patient.system.sends).toHaveLength(2);
    expect(patient.system.sends[1]).toBe('要，把刚才那份结果再发一次。');
    expect(impatient.system.sends).toEqual([BASE.initialMessage]);
    expect(runs.map((run) => run.simulator.prompts.length)).toEqual([2, 1, 3]);

    const signatures = runs.map((run) => JSON.stringify({
      actions: run.result.messages.map((m) => m.action),
      sends: run.system.sends,
    }));
    expect(new Set(signatures).size).toBe(3);

    // 三份首轮 prompt 只差人设/行为规则：Harness 没有把路径写进 prompt。
    const prompts = runs.map((run) => run.simulator.prompts[0]);
    for (const prompt of prompts) expect(prompt).toBeDefined();
    expect(new Set(prompts.map((prompt) => prompt!.user)).size).toBe(3);
    const base = skeleton(prompts[0]!.user, THOROUGH);
    expect(skeleton(prompts[1]!.user, IMPATIENT)).toBe(base);
    expect(skeleton(prompts[2]!.user, PATIENT)).toBe(base);
  });

  it('反证：同一 persona 跑两遍必须一致（上面的分叉不能归因于随机性）', async () => {
    const first = await runWith(THOROUGH, 'thorough');
    const second = await runWith(THOROUGH, 'thorough');
    expect(second.result.messages.map((m) => m.action)).toEqual(first.result.messages.map((m) => m.action));
    expect(second.system.sends).toEqual(first.system.sends);
  });
});
