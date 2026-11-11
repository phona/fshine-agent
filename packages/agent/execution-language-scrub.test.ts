/**
 * 执行语言删除的对抗用例（T8，2026-11-11）。
 *
 * 判据：用户可见文本（回复面 + 确认面/通知面）过 `executionLanguageFingerprints`
 * 必须零命中——五类全算（脚本路径 / 错误码 / JSON 片段 / operation 名 / 内部控制词）。
 * 今天败状：修好臂 A2 回复泄漏错误码；确认面（计划通知）此前根本不走删除集。
 *
 * 对抗三维（每类至少一维）：
 *   · 同义改写 —— 小写/混合大小写的码形（not_found / Period_No_Data），旧删除集只认全大写；
 *   · 拆分跨行 —— 码/路径/控制词中间插换行（PERIOD_NO_\nDATA、src/x/\nquery.js）；
 *   · 编码变形 —— 全角（ＮＦＫＣ）、零宽字符、HTML 实体（&lt;tool_call&gt;）。
 *
 * 机械判据只有两条，都可机判：① 删完零指纹；② 中文可读内容逐字保留（不整段吞）。
 */
import { describe, expect, it } from 'vitest';
import { executionLanguageFingerprints, scrubExecutionLanguageText } from './src/execution-language';
import { sanitizeUserVisibleReply } from './src/reply-exit';

const READABLE = '本期没有找到对应的记录，请确认对象名称后重试。';

function scrub(text: string) {
  return scrubExecutionLanguageText(text);
}

function reply(text: string) {
  return sanitizeUserVisibleReply({ text, executed: true, needsRounds: 0, evidence: () => '' });
}

describe('执行语言删除 · 对抗形态（同义改写 / 拆分跨行 / 编码变形）', () => {
  it('全大写错误码：原形、跨行拆分、全角与零宽变形都删干净', () => {
    for (const variant of [
      'PERIOD_NO_DATA',
      'PERIOD_NO_\nDATA',
      'PERIOD\nNO\nDATA',
      'ＰＥＲＩＯＤ＿ＮＯ＿ＤＡＴＡ',
      'PERIOD\u200b_NO\u200b_DATA',
    ]) {
      const result = scrub(`平台返回 ${variant}；${READABLE}`);
      expect(executionLanguageFingerprints(result.text), variant).toEqual([]);
      expect(result.text, variant).toContain('本期没有找到对应的记录');
      expect(result.removed, variant).toBeGreaterThan(0);
    }
  });

  it('小写/混合大小写错误码：按失败语义词根收（同义改写），普通 snake 标识符不误删', () => {
    for (const variant of ['not_found', 'collection_not_found', 'Invalid_Shape', 'parse_error', 'no_data', 'needs_input']) {
      const result = scrub(`平台返回 ${variant}；${READABLE}`);
      expect(executionLanguageFingerprints(result.text), variant).toEqual([]);
      expect(result.text, variant).toContain('本期没有找到对应的记录');
    }
    // 对象名同义写法（Y2 假红校准口径）不是错误码：保留原样。
    const kept = scrub('对象名写作 gamma_collection，也写作 gamma-collection。');
    expect(kept.text).toContain('gamma_collection');
    expect(kept.removed).toBe(0);
  });

  it('脚本路径：原形、跨行拆分、全角斜杠都删掉', () => {
    for (const variant of ['src/dummy/scripts/query.js', 'src/dummy/scripts/\nquery.js', 'src／dummy／scripts／query.js']) {
      const result = scrub(`见 ${variant} 的实现；${READABLE}`);
      expect(executionLanguageFingerprints(result.text), variant).toEqual([]);
      expect(result.text, variant).toContain('本期没有找到对应的记录');
    }
  });

  it('operation 名：注册名、带横杠点分名、跨行拆分都删掉', () => {
    for (const variant of ['finance.query-receivables', 'voucher.query-saved', 'voucher.query-\nsaved']) {
      const result = scrub(`依据 ${variant} 的返回；${READABLE}`);
      expect(executionLanguageFingerprints(result.text), variant).toEqual([]);
      expect(result.text, variant).toContain('本期没有找到对应的记录');
    }
  });

  it('JSON 片段与工具调用协议标记：候选标签、实体编码的协议标签都删掉', () => {
    const result = scrub(`candidates: a, b &lt;tool_call&gt;delegate&lt;/tool_call&gt; ${READABLE}`);
    expect(executionLanguageFingerprints(result.text)).toEqual([]);
    expect(result.text).toContain('本期没有找到对应的记录');
    // 花括号形态**不在删除集内**（与既有 D-144 防误伤断言同一条线）：正文里引用一小段
    // JSON 是用户能读懂的语境，删它比留它更糟——这一类仍由指纹表守（探针可见）。
    const cited = scrub('接口偶发返回 {"kind":"delegate"} 之类的内部标记，已忽略。');
    expect(cited.text).toContain('{"kind":"delegate"}');
    expect(cited.removed).toBe(0);
  });

  it('内部控制词：原形、跨行拆分、零宽变形都删掉', () => {
    for (const variant of ['计划门', '计划\n门', '计划\u200b门', '配额', '熔断']) {
      const result = scrub(`（原因：${variant}）${READABLE}`);
      expect(executionLanguageFingerprints(result.text), variant).toEqual([]);
      expect(result.text, variant).toContain('本期没有找到对应的记录');
    }
  });

  it('宿主自己的码表词保留（出现在确定性话术里，码上屏是既有产品行为）', () => {
    const result = scrub('未能完成本轮操作（TASK_FORBIDDEN）。');
    expect(result.text).toContain('TASK_FORBIDDEN');
  });

  it('整段都是执行语言时不给用户空气泡（可读内容 < 4 判无内容，由出口替换兜底）', () => {
    const result = scrub('PERIOD_NO_DATA src/dummy/scripts/query.js');
    expect([...result.text].filter((ch) => ch.codePointAt(0)! > 0x7f).length).toBeLessThan(4);
    expect(result.removed).toBeGreaterThan(0);
  });
});

describe('执行语言删除 · 回复面（reply-exit 出口）', () => {
  it('对抗形态的回复：终稿过五类指纹零命中，中文结论逐字保留', () => {
    const variants: Array<{ text: string; keep: string }> = [
      { text: '该期间查不到数据（PERIOD_NO_DATA），建议确认期间后重查。', keep: '建议确认期间后重查' },
      { text: '该期间查不到数据（PERIOD_NO_\nDATA），建议确认期间后重查。', keep: '建议确认期间后重查' },
      { text: '平台返回 collection_not_found；本期没有找到对应的记录，请确认对象名称后重试。', keep: '本期没有找到对应的记录' },
      { text: '见 src/dummy/scripts/query.js 的实现；本期没有找到对应的记录，请确认对象名称后重试。', keep: '本期没有找到对应的记录' },
      { text: '依据 voucher.query-\nsaved 的返回；本期没有找到对应的记录，请确认对象名称后重试。', keep: '本期没有找到对应的记录' },
      { text: '（原因：计划\n门）本期没有找到对应的记录，请确认对象名称后重试。', keep: '本期没有找到对应的记录' },
    ];
    for (const { text, keep } of variants) {
      const out = reply(text);
      expect(executionLanguageFingerprints(out.text), text).toEqual([]);
      expect(out.text, text).toContain(keep);
    }
  });

  it('删干净后正文里的中文结论不被整段替换（有可读内容就不给兜底话术）', () => {
    const out = reply('平台返回 PERIOD_NO_DATA：本期没有找到对应的记录，请确认对象名称后重试。');
    expect(out.text).toContain('本期没有找到对应的记录');
    expect(out.events[0]).toMatchObject({ event: 'execution_language_scrubbed', detail: { labels: ['错误码'] } });
  });
});
