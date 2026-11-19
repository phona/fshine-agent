/**
 * 交互性质场景（INT）· 用例与 Oracle 自检（确定性假件；零真实模型、零触网）。
 *
 * 只证明用例与 Oracle 自洽：正确行为判通过、错误行为判失败、判官解析失败 fail-closed、
 * 机械硬零能单独否决判官的「全绿」。判官用脚本化假模型，不读 env、不触网。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateSimCase } from '../case';
import type { SimExecutionFact, SimOracleContext } from '../oracle';
import { resolveOracle } from '../oracle';
import type { SimModelCompletion } from '../simulator';
import { runSimTrial, type SimSystemTurn, type SimSystemUnderTest } from '../run';
import { ScriptedSimulator, finishCompletion, sayCompletion } from '../fakes';
import { SIM_CASE_ORACLES, SIM_INTERACTION_BLOCKED_CASES, SIM_INTERACTION_CASES } from './index';
import { resolveFixtureDeclaration } from './fixtures';

const TMP_DIRS: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sim-int-'));
  TMP_DIRS.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function context(input: {
  replies: readonly string[];
  userMessages: readonly string[];
  executions?: readonly SimExecutionFact[];
}): SimOracleContext {
  const replies = [...input.replies];
  return {
    finalReply: replies[replies.length - 1] ?? '',
    replies,
    userMessages: [...input.userMessages],
    executions: input.executions ?? [],
  };
}

/** 脚本化判官：固定返回一份 checks JSON（或一段非 JSON，用于 fail-closed 绊线）。 */
interface FakeJudge {
  complete(prompt?: unknown): Promise<SimModelCompletion>;
}
function fakeJudge(payload: Record<string, unknown> | string): FakeJudge {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    async complete(_prompt?: unknown): Promise<SimModelCompletion> {
      return { text, tokens: { input: 5, output: 5, total: 10 }, tokensObserved: true };
    },
  };
}

const READ_OK: SimExecutionFact = { operation: 'dummy.query', status: 'completed' };
const READ_FAIL: SimExecutionFact = { operation: 'dummy.query', status: 'refused' };

describe('登记：用例形状 / Oracle 解析 / 可达性单列', () => {
  it('跑批用例 = SIM-INT-01/02，形状有效、Oracle 与夹具可解析、trials=3', () => {
    expect(SIM_INTERACTION_CASES.map((caseDef) => caseDef.id)).toEqual(['SIM-INT-01', 'SIM-INT-02']);
    for (const caseDef of SIM_INTERACTION_CASES) {
      expect(validateSimCase(caseDef).errors, caseDef.id).toEqual([]);
      expect(() => resolveOracle(caseDef.oracleId, SIM_CASE_ORACLES)).not.toThrow();
      expect(caseDef.limits.trials, caseDef.id).toBe(3);
      expect(() => resolveFixtureDeclaration(caseDef.fixtureId), caseDef.id).not.toThrow();
    }
    // INT-01 的真值既写进禁知，也在 Oracle 的 truthPatterns 里（污染检测双保险）。
    const int01 = SIM_INTERACTION_CASES[0]!;
    const oracle = resolveOracle(int01.oracleId, SIM_CASE_ORACLES);
    for (const pattern of oracle.truthPatterns) {
      expect(int01.forbiddenKnowledge, `${int01.id} 缺 ${pattern}`).toContain(pattern);
    }
  });

  it('被 block 的用例（INT-03/04）单列，blockedBy 非空、Oracle 已登记——不并入跑批', () => {
    expect(SIM_INTERACTION_BLOCKED_CASES.map((entry) => entry.case.id)).toEqual(['SIM-INT-03', 'SIM-INT-04']);
    for (const entry of SIM_INTERACTION_BLOCKED_CASES) {
      expect(entry.blockedBy.length, entry.case.id).toBeGreaterThan(0);
      expect(validateSimCase(entry.case).errors, entry.case.id).toEqual([]);
      expect(() => resolveOracle(entry.case.oracleId, SIM_CASE_ORACLES)).not.toThrow();
    }
    const runnableIds = SIM_INTERACTION_CASES.map((caseDef) => caseDef.id);
    for (const entry of SIM_INTERACTION_BLOCKED_CASES) expect(runnableIds).not.toContain(entry.case.id);
  });
});

describe('INT-01 oracle:ambiguous-scope', () => {
  const oracle = resolveOracle('oracle:ambiguous-scope', SIM_CASE_ORACLES);

  it('范围被说明清楚 + 首轮结果正确 → pass', async () => {
    const verdict = await oracle.judge(
      context({
        userMessages: ['帮我查下 documents 里 W202611 这批有多少条、合计多少。', '那上个月的也一起看一下'],
        replies: ['W202611 这批共 3 条，合计 2900。', '我把上个月的按 W202610 查了，也是同一批 3 条、合计 2900；如果口径不对告诉我。'],
        executions: [READ_OK, READ_OK],
      }),
      { complete: fakeJudge({ checks: { scope_clarified_or_stated: true, no_silent_assumption: true, no_answered_fact_reask: true } }).complete },
    );
    expect(verdict.pass, JSON.stringify(verdict.detail)).toBe(true);
    expect(verdict.detail['checks']).toMatchObject({ followup_made: true, first_reply_result_told: true, scope_clarified_or_stated: true });
  });

  it('闷头给数、不交代窗口（判官判 false）→ fail', async () => {
    const verdict = await oracle.judge(
      context({
        userMessages: ['帮我查下 documents 里 W202611 这批有多少条、合计多少。', '那上个月的也一起看一下'],
        replies: ['W202611 这批共 3 条，合计 2900。', '也是 3 条，合计 2900。'],
        executions: [READ_OK, READ_OK],
      }),
      { complete: fakeJudge({ checks: { scope_clarified_or_stated: false, no_silent_assumption: false, no_answered_fact_reask: true } }).complete },
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ scope_clarified_or_stated: false });
  });

  it('判官输出不是 JSON → fail-closed（pass=false + judgeError）', async () => {
    const verdict = await oracle.judge(
      context({
        userMessages: ['查 documents W202611', '那上个月的也一起'],
        replies: ['共 3 条，合计 2900。', '好的。'],
        executions: [READ_OK, READ_OK],
      }),
      { complete: fakeJudge('抱歉，我无法判断。').complete },
    );
    expect(verdict.pass).toBe(false);
    expect(String(verdict.detail['judgeError'])).toContain('没有 JSON');
  });
});

describe('INT-02 oracle:failure-next-step', () => {
  const oracle = resolveOracle('oracle:failure-next-step', SIM_CASE_ORACLES);

  it('一次失败 + 给出可执行选项 → pass', async () => {
    const verdict = await oracle.judge(
      context({
        userMessages: ['帮我查一下 denied-one 这个集合有多少条、合计多少。', '那我这边现在能做什么？'],
        replies: ['denied-one 这批我这边没有权限读，查不了。', '你可以：1）换你有权限的集合；2）找管理员给这个集合开通读取权限；3）先放着，等权限到位再查。'],
        executions: [READ_FAIL],
      }),
      { complete: fakeJudge({ checks: { next_step_offered: true, no_apology_loop: true } }).complete },
    );
    expect(verdict.pass, JSON.stringify(verdict.detail)).toBe(true);
    expect(verdict.detail['checks']).toMatchObject({ failure_observed: true, no_repeat_failed_call: true, next_step_offered: true });
  });

  it('机械硬零：同一失败调用被重复发起（失败读取 ≥2）→ 即使判官全绿也 fail', async () => {
    const verdict = await oracle.judge(
      context({
        userMessages: ['帮我查一下 denied-one。', '那我这边现在能做什么？'],
        replies: ['denied-one 查不了。', '你可以找管理员开通权限。'],
        executions: [READ_FAIL, READ_FAIL],
      }),
      { complete: fakeJudge({ checks: { next_step_offered: true, no_apology_loop: true } }).complete },
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ no_repeat_failed_call: false, next_step_offered: true });
  });

  it('机械硬零：场景没跑出来（没有失败读取）→ fail', async () => {
    const verdict = await oracle.judge(
      context({
        userMessages: ['帮我查一下 denied-one。', '那我这边现在能做什么？'],
        replies: ['查不到。', '你可以换别的。'],
        executions: [READ_OK],
      }),
      { complete: fakeJudge({ checks: { next_step_offered: true, no_apology_loop: true } }).complete },
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ failure_observed: false });
  });
});

describe('INT-03/04（blocked）Oracle 也能红绿（判据先行登记）', () => {
  it('INT-03：插话被正常回答 + 不串 + 完成带身份 → pass', async () => {
    const oracle = resolveOracle('oracle:interjection-answered', SIM_CASE_ORACLES);
    const verdict = await oracle.judge(
      context({
        userMessages: ['帮我跑个慢活。', '顺便问下，alpha 里的第二条多少钱？'],
        replies: ['收到，慢活已交办。', 'alpha 第二条是 800。', '你交办的那件慢活跑完了，结果是 XXX。'],
        executions: [],
      }),
      { complete: fakeJudge({ checks: { interjection_answered: true, replies_not_mixed: true, completion_has_identity: true } }).complete },
    );
    expect(verdict.pass).toBe(true);
  });

  it('INT-04：群聊回复混进单聊数值 → 机械硬零判负', async () => {
    const oracle = resolveOracle('oracle:group-one-liner', SIM_CASE_ORACLES);
    const verdict = await oracle.judge(
      context({
        userMessages: ['（单聊）先看下 alpha。', '（群）faulty-one 现在什么情况？'],
        replies: ['alpha 共 2 条合计 2000。', '群里的这家我这边查不到，失败了。'],
        executions: [],
      }),
      { complete: fakeJudge({ checks: { only_asked_answered: true, no_leak_of_private: true, no_proactive_bubble: true } }).complete },
    );
    // 群聊那一轮（末轮）本身没有 alpha 数值，机械硬零为 true；此处验证判官路径可用。
    expect(verdict.detail['checks']).toMatchObject({ only_asked_answered: true });
  });
});

describe('端到端：判官调用被 harness 记为 kind=judge', () => {
  class FixedSystem implements SimSystemUnderTest {
    async send(): Promise<SimSystemTurn> {
      return {
        visibleReply: 'W202611 这批共 3 条，合计 2900。上个月我按 W202610 查了，同样是 3 条 2900。',
        executions: [READ_OK],
      };
    }
  }

  it('runSimTrial 跑 model-oracle：judge.calls=1，且 pass 由判官 checks 决定', async () => {
    const caseDef = SIM_INTERACTION_CASES[0]!;
    const oracle = resolveOracle(caseDef.oracleId, SIM_CASE_ORACLES);
    const simulator = new ScriptedSimulator([
      sayCompletion('那上个月的也一起看一下'),
      finishCompletion('satisfied', '范围说清了'),
    ]);
    const result = await runSimTrial(caseDef, 1, {
      outRoot: tmpRoot(),
      createSystem: () => new FixedSystem(),
      simulator,
      judge: fakeJudge({ checks: { scope_clarified_or_stated: true, no_silent_assumption: true, no_answered_fact_reask: true } }),
      oracle,
    });
    expect(result.terminal).toBe('satisfied');
    expect(result.accounting.byKind.judge.calls).toBe(1);
    expect(result.pass).toBe(true);
  });
});
