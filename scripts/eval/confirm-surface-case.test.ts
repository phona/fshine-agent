/**
 * S2 用例：确认面必须业务可评估（issue #50 用例2）——**生产路径的红/绿就在这里判**。
 *
 * 构造与判据装配在 confirm-surface-case.ts；判据本体在 confirm-surface-criteria.ts。
 * 本文件只做「跑一次构造 → 逐条报判据」：
 *   · 构造检查（绿）：计划确实落在 confirm 档，用户确实拿到了一条确认文本；
 *   · 六条判据逐条独立断言：不含执行层词汇 / 必含业务范围 / 必含业务后果 / 必含可选项 /
 *     范围段不随措辞改变 / 业务措辞只来自平台清单第 5 列。
 *
 * 红就是红：断言不许放宽、不许改判据凑绿。这条用例的用途就是让「确认面业务可评估」从
 * 文档约定变成一条会红的判据；下一轮把生产渲染器改成判据要求的样子，它自然转绿。
 * 每条的失败消息里带判据原文与确认文本原文，读完知道缺什么、去哪补。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { S2_NARRATIVES, runConfirmSurfaceCase, type ConfirmSurfaceCaseRun } from './confirm-surface-case';
import { formatConfirmSurfaceVerdict, judgeConfirmSurface } from './confirm-surface-criteria';
import { referenceConfirmSurfaceScenario } from './confirm-surface-reference';

/** 判据原文（失败消息逐字带上；改判据必须先改这段，改不动就是改不动）。 */
const ACCEPTANCE = [
  '构造：任意需要用户确认的计划。',
  '断言：确认文本不含执行层词汇；必含业务范围、业务后果、可选项。',
  '机械判据：executionLanguageFingerprints 五类指纹（脚本路径/错误码/JSON 片段/operation 名/内部控制词）零命中 + 三个必填字段在场。',
  '已裁定的设计要点：范围块由宿主渲染（计划是结构化事实），模型只能写后果叙述，不能改范围块。',
].join('\n      ');

let run: ConfirmSurfaceCaseRun;

beforeAll(async () => {
  run = await runConfirmSurfaceCase();
}, 60_000);

function failure(criterion: keyof ConfirmSurfaceCaseRun['verdict']['criteria']): string {
  return [
    'S2 确认面判据不过（issue #50 用例2）：',
    `      判据原文：${ACCEPTANCE}`,
    `      确认文本（用户会看到的那一条）：${JSON.stringify(run.userText)}`,
    `      ${run.evidence[5] ?? ''}`,
    `      这一条：${run.verdict.criteria[criterion].detail}`,
  ].join('\n    ');
}

describe('S2 确认面必须业务可评估：构造', () => {
  it('计划落在 confirm 档（需要用户确认），且用户拿到一条确认文本', () => {
    expect(run.evaluation.decision).toBe('confirm');
    expect(run.noticeText).toBe(run.userText);
    expect(run.userText.trim().length).toBeGreaterThan(0);
  });

  it('范围判据的输入事实来自平台清单（第 5 列名在场，不是空表）', () => {
    expect(run.facts.labels.length).toBeGreaterThan(0);
  });
});

describe('S2 确认面必须业务可评估：六条判据', () => {
  it('① 不含执行层词汇（五类指纹零命中）', () => {
    expect(run.verdict.criteria.executionLanguage.ok, failure('executionLanguage')).toBe(true);
  });

  it('② 必含业务范围（宿主渲染的范围段）', () => {
    expect(run.verdict.criteria.businessScope.ok, failure('businessScope')).toBe(true);
  });

  it('③ 必含业务后果（模型叙述进后果段）', () => {
    expect(run.verdict.criteria.businessConsequence.ok, failure('businessConsequence')).toBe(true);
  });

  it('④ 必含可选项（继续与取消两条答复都在）', () => {
    expect(run.verdict.criteria.options.ok, failure('options')).toBe(true);
  });

  it('⑤ 范围段不随模型措辞改变', () => {
    expect(run.verdict.criteria.scopeInvariance.checked, failure('scopeInvariance')).toBe(true);
    expect(run.verdict.criteria.scopeInvariance.ok, failure('scopeInvariance')).toBe(true);
  });

  it('⑥ 业务措辞只来自平台清单第 5 列', () => {
    expect(run.verdict.criteria.businessWordingSource.ok, failure('businessWordingSource')).toBe(true);
  });

  it('整条用例：六条判据全过（下一轮修好之后这一条应当转绿）', () => {
    expect(run.verdict.ok, [
      formatConfirmSurfaceVerdict(run.verdict),
      '构造与证据：',
      ...run.evidence.map((line) => `  ${line}`),
    ].join('\n')).toBe(true);
  });
});

describe('S2 对照：红的不是构造，是渲染器', () => {
  it('把同一份构造事实与叙述交给判据要求的渲染形态 → 六条全绿', () => {
    // 用的是本用例从夹具里抽出来的**同一份**事实（平台第 5 列名 + 声明值），不是另造的样本：
    // 判据可满足，红只能归因于生产渲染器还没长成要的样子。
    const verdict = judgeConfirmSurface(referenceConfirmSurfaceScenario(run.facts, S2_NARRATIVES));
    expect(verdict.ok, formatConfirmSurfaceVerdict(verdict)).toBe(true);
  });
});
