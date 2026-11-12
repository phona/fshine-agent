/**
 * S2 量具的标定测试：判据**可满足**（对照组绿）＋**每一类都能判红**（突变逐条翻红）。
 *
 * 为什么需要这一份：`confirm-surface-case.test.ts` 跑出的是红——红本身不能证明判据有牙，
 * 也可能只是判据不可满足。这里补上另一半证据：
 *   · 一组按**已裁定设计**渲染的对照确认面（范围段由宿主从结构化事实渲染、模型只写后果
 *     叙述、继续与取消两条路径都给）→ 同一把尺判绿，证明判据不是恒红；
 *   · 每组突变只动一处（脚本路径上屏 / 叙述带错误码 / 叙述被当范围段 / 叙述被追加进范围段 /
 *     宿主改写叙述 / 少取消路径 / 模板自带业务词 / 拿别的 operation 的名字凑 / 死路指令）→
 *     对应判据翻红，并核对"该绿的仍绿"：证明每条判据各自有牙，红不是一条挂了全挂的连坐。
 *
 * 对照渲染器是本测试文件里的**标定脚手架**，不是生产渲染器：它的存在只为了让判据过一次绿，
 * 给下一轮实现一个可读的目标形态。生产路径的红绿由 confirm-surface-case.test.ts 判。
 *
 * 两份词表的漂移锁：判据里的业务词表与宿主答复词表都是**副本**（各自有意独立持有），本文件
 * 直接读权威来源逐词比对——漂移会在这一份测试里现形，不靠人记。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONFIRM_SURFACE_BUSINESS_WORDS,
  HOST_ACCEPTED_REPLIES,
  formatConfirmSurfaceVerdict,
  hostSkeleton,
  judgeConfirmSurface,
  type ConfirmSurfaceFacts,
  type ConfirmSurfaceScenario,
} from './confirm-surface-criteria';
import {
  referenceConfirmSurfaceScenario,
  renderReferenceConfirmSurface,
  type ReferenceRenderOptions,
} from './confirm-surface-reference';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 对照用事实：平台清单第 5 列名 + 一个声明值 + 两个"别的 operation 的名字"。 */
const FACTS: ConfirmSurfaceFacts = {
  labels: ['query shelf items'],
  otherLabels: ['prepare shelf items', 'commit shelf items'],
  values: ['north & south'],
};

const NARRATIVE = '执行后会读取这两个货架的现有条目，只做核对，不改动任何库存数据。';
/** 对抗叙述：自称范围更宽（裁定里"模型可以用措辞把范围说宽"的正面攻击）。 */
const WIDE_NARRATIVE = '本次顺带把所有货架一并核对，实际范围比上面写的更宽。';

/** 对照场景：两条不同叙述（含对抗叙述）各渲染一次。 */
function referenceScenario(options: ReferenceRenderOptions = {}, firstNarrative = NARRATIVE): ConfirmSurfaceScenario {
  return referenceConfirmSurfaceScenario(FACTS, [firstNarrative, WIDE_NARRATIVE], options);
}

describe('S2 判据标定：对照实现过绿（判据可满足）', () => {
  it('按已裁定设计渲染的确认面：六条判据全过且都真判过', () => {
    const verdict = judgeConfirmSurface(referenceScenario());
    expect(formatConfirmSurfaceVerdict(verdict)).toBeTruthy();
    expect(verdict.ok, formatConfirmSurfaceVerdict(verdict)).toBe(true);
    for (const [criterion, result] of Object.entries(verdict.criteria)) {
      expect(result.checked, criterion).toBe(true);
      expect(result.ok, `${criterion}: ${result.detail}`).toBe(true);
    }
  });

  it('两条叙述的范围段逐字节相同（对照实现的范围段确实不吃措辞）', () => {
    const scenario = referenceScenario();
    const scopeLine = (text: string) => text.split('\n')[0] ?? '';
    expect(scopeLine(scenario.renderings[0]!.text)).toBe(scopeLine(scenario.renderings[1]!.text));
    expect(scopeLine(scenario.renderings[0]!.text)).toContain('query shelf items');
  });
});

describe('S2 判据标定：每类判据各自有牙（突变逐条翻红）', () => {
  it('脚本路径混进范围段 → 只有「不含执行层词汇」翻红', () => {
    const verdict = judgeConfirmSurface(referenceScenario({ scriptPathInScope: true }));
    expect(verdict.ok).toBe(false);
    expect(verdict.criteria.executionLanguage.ok).toBe(false);
    expect(verdict.criteria.executionLanguage.detail).toContain('脚本路径');
    expect(verdict.criteria.businessScope.ok).toBe(true);
    expect(verdict.criteria.businessConsequence.ok).toBe(true);
    expect(verdict.criteria.options.ok).toBe(true);
    expect(verdict.criteria.businessWordingSource.ok).toBe(true);
  });

  it('模型叙述里带错误码且宿主没删 → 上屏文本含错误码，「不含执行层词汇」翻红并另注叙述自带', () => {
    const verdict = judgeConfirmSurface(referenceScenario({}, `${NARRATIVE}（SHELF_NOT_FOUND）`));
    expect(verdict.criteria.executionLanguage.ok).toBe(false);
    expect(verdict.criteria.executionLanguage.detail).toContain('文本:错误码');
    expect(verdict.criteria.executionLanguage.detail).toContain('另注：模型叙述自带 错误码');
  });

  it('把模型叙述当范围段用 → 「业务范围」与「范围段不随措辞改变」同时翻红', () => {
    const verdict = judgeConfirmSurface(referenceScenario({ narrativeAsScope: true }));
    expect(verdict.criteria.businessScope.ok).toBe(false);
    expect(verdict.criteria.businessScope.detail).toContain('范围段缺平台业务名');
    expect(verdict.criteria.scopeInvariance.ok).toBe(false);
    expect(verdict.criteria.scopeInvariance.detail).toContain('模型措辞能进范围段');
  });

  it('模型叙述被追加进范围段 → 「业务范围」抓"段里混进叙述"、「范围段不变」抓段落差异', () => {
    const verdict = judgeConfirmSurface(referenceScenario({ narrativeAppendedToScope: true }));
    expect(verdict.criteria.businessScope.ok).toBe(false);
    expect(verdict.criteria.businessScope.detail).toContain('范围段里出现模型叙述');
    expect(verdict.criteria.scopeInvariance.ok).toBe(false);
    expect(verdict.criteria.scopeInvariance.detail).toContain('模型措辞能进范围段');
    // 平台业务名还在段里（模型没把它挤掉），但"范围里混了措辞"这一条自己就把红判出来了。
    expect(verdict.criteria.businessConsequence.ok).toBe(true);
  });

  it('模型在叙述里提过范围、宿主范围段却没渲染事实 → 「业务范围」翻红（判的是宿主段）', () => {
    const verdict = judgeConfirmSurface(referenceScenario(
      { scopeWithoutFacts: true },
      '执行后会读取 query shelf items（north & south）的现有条目。',
    ));
    expect(verdict.criteria.businessScope.ok).toBe(false);
    expect(verdict.criteria.businessScope.detail).toContain('范围段缺平台业务名');
  });

  it('宿主改写模型后果叙述 → 「业务后果」翻红；叙述不在场时「范围段不变」记前提缺席', () => {
    const verdict = judgeConfirmSurface(referenceScenario({ rewriteConsequence: true }));
    expect(verdict.criteria.businessConsequence.ok).toBe(false);
    expect(verdict.criteria.businessConsequence.detail).toContain('没有带上模型叙述');
    expect(verdict.criteria.businessScope.ok).toBe(true);
    expect(verdict.criteria.scopeInvariance.checked).toBe(false);
    expect(verdict.criteria.scopeInvariance.ok).toBe(false);
  });

  it('宿主按删除集整理了叙述（删掉错误码与括号）→ 「业务后果」仍绿：整理不等于改写', () => {
    const dirty = `${NARRATIVE}（SHELF_NOT_FOUND）`;
    const scrubbed = NARRATIVE;
    const verdict = judgeConfirmSurface({
      facts: FACTS,
      renderings: [
        { narrative: dirty, text: renderReferenceConfirmSurface(FACTS, scrubbed) },
        { narrative: WIDE_NARRATIVE, text: renderReferenceConfirmSurface(FACTS, WIDE_NARRATIVE) },
      ],
    });
    expect(verdict.criteria.businessConsequence.ok, verdict.criteria.businessConsequence.detail).toBe(true);
    expect(verdict.criteria.executionLanguage.ok).toBe(true);
    expect(verdict.criteria.scopeInvariance.ok).toBe(true);
  });

  it('宿主用自己的固定一句话顶掉模型叙述 → 「业务后果」翻红（实质判据不是逐字节）', () => {
    const verdict = judgeConfirmSurface({
      facts: FACTS,
      renderings: [
        { narrative: NARRATIVE, text: renderReferenceConfirmSurface(FACTS, '将执行本次核对，详情略。') },
        { narrative: WIDE_NARRATIVE, text: renderReferenceConfirmSurface(FACTS, '将执行本次核对，详情略。') },
      ],
    });
    expect(verdict.criteria.businessConsequence.ok).toBe(false);
    expect(verdict.criteria.businessConsequence.detail).toContain('没有带上模型叙述');
  });

  it('整条确认面没有后果段 → 「业务后果」翻红', () => {
    const verdict = judgeConfirmSurface(referenceScenario({ omitConsequence: true }));
    expect(verdict.criteria.businessConsequence.ok).toBe(false);
    expect(verdict.criteria.businessConsequence.detail).toContain('没有后果段');
  });

  it('省略取消路径 → 只有「可选项」翻红', () => {
    const verdict = judgeConfirmSurface(referenceScenario({ omitCancel: true }));
    expect(verdict.criteria.options.ok).toBe(false);
    expect(verdict.criteria.options.detail).toContain('没有取消路径');
    expect(verdict.criteria.businessConsequence.ok).toBe(true);
  });

  it('模板自带业务词（"记录"）→ 只有「业务措辞只来自平台清单第 5 列」翻红', () => {
    const verdict = judgeConfirmSurface(referenceScenario({ templateBusinessWord: true }));
    expect(verdict.criteria.businessWordingSource.ok).toBe(false);
    expect(verdict.criteria.businessWordingSource.detail).toContain('记录');
    expect(verdict.criteria.businessScope.ok).toBe(true);
  });

  it('拿别的 operation 的平台名凑范围 → 「业务措辞出处」翻红，自己那一行名字缺席也翻红', () => {
    const verdict = judgeConfirmSurface(referenceScenario({ useNeighbourLabel: true }));
    expect(verdict.criteria.businessWordingSource.ok).toBe(false);
    expect(verdict.criteria.businessWordingSource.detail).toContain('prepare shelf items');
    expect(verdict.criteria.businessScope.ok).toBe(false);
  });

  it('死路指令：给用户的回复指令不在宿主答复词表内 → 「可选项」翻红', () => {
    const scenario = referenceScenario();
    const broken: ConfirmSurfaceScenario = {
      facts: scenario.facts,
      renderings: scenario.renderings.map((rendering) => ({
        ...rendering,
        text: rendering.text.replace('回复“取消”放弃', '回复“好吧”放弃'),
      })),
    };
    const verdict = judgeConfirmSurface(broken);
    expect(verdict.criteria.options.ok).toBe(false);
    expect(verdict.criteria.options.detail).toContain('“好吧”');
  });

  it('模型在叙述里自称范围更宽不算越权：范围段还在 ⇒ 「业务范围」仍绿（判的是宿主段）', () => {
    const verdict = judgeConfirmSurface(referenceScenario());
    expect(verdict.criteria.businessScope.ok).toBe(true);
    expect(verdict.criteria.scopeInvariance.ok).toBe(true);
    expect(hostSkeleton(referenceScenario().renderings[1]!).includes('query shelf items')).toBe(true);
  });

  it('前提缺席不算通过：没有范围段时「范围段不变」记 NOT-JUDGED 而不是 PASS', () => {
    const verdict = judgeConfirmSurface({
      facts: FACTS,
      renderings: [
        { narrative: NARRATIVE, text: `计划通知：后果：${NARRATIVE}\n可选项：回复“确认继续”执行；回复“取消”放弃。` },
        { narrative: WIDE_NARRATIVE, text: `计划通知：后果：${WIDE_NARRATIVE}\n可选项：回复“确认继续”执行；回复“取消”放弃。` },
      ],
    });
    expect(verdict.criteria.scopeInvariance.checked).toBe(false);
    expect(verdict.criteria.scopeInvariance.ok).toBe(false);
    expect(verdict.criteria.businessScope.ok).toBe(false);
    expect(verdict.ok).toBe(false);
  });
});

describe('S2 量具的词表漂移锁（副本不许静默过期）', () => {
  it('业务词表与宿主 BUSINESS_WORD_RE 逐词相同', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'packages/agent/platform-leak-lint.test.ts'), 'utf8');
    const match = /export const BUSINESS_WORD_RE = \/(.+)\/g;/.exec(source);
    expect(match, '宿主 BUSINESS_WORD_RE 的形态变了（漂移锁读不到）——先同步这份判据的副本再改锁').toBeTruthy();
    const hostWords = match![1]!.split('|');
    expect([...CONFIRM_SURFACE_BUSINESS_WORDS]).toEqual(hostWords);
  });

  it('答复词表与宿主 classifyAnswer 的两臂逐词相同', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'packages/agent/src/plan-confirmation.ts'), 'utf8');
    const lists = [...source.matchAll(/\[((?:'[^']+',?\s*)+)\]\.includes\(normalized\)/g)].map((m) =>
      [...m[1]!.matchAll(/'([^']+)'/g)].map((w) => w[1]!));
    expect(lists.length, 'plan-confirmation.ts 的 classifyAnswer 形态变了（漂移锁读不到两臂）——先同步副本再改锁').toBe(2);
    expect(lists[0]).toEqual([...HOST_ACCEPTED_REPLIES.confirm]);
    expect(lists[1]).toEqual([...HOST_ACCEPTED_REPLIES.cancel]);
  });
});
