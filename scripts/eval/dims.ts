/**
 * 探针 note → 四维可信度归维（L7 / D-060 的机械分量，architecture-laws「可信度可量化」）。
 *
 * 四维（debt-ledger D-060 闭环判据的口径）：groundedness（有据）/ 实体保真 / 失败诚实 / 呈现卫生。
 * 探针 20+ 个判定 helper 产出的 note 是平文本；本模块用**一张显式归维表**把它们按维计数，
 * 供打分器（score.ts）与 scores.jsonl 记分台消费。设计取舍：
 *   · 归维表集中在一处（可审计、可变异验证），探针 helper 与用例体零改动——1917 行探针的
 *     note 文案本文件视为契约（多条措辞已进 change-safety 冻结表），按前缀/关键词匹配；
 *   · note 文案漂移会让归维静默滑入 unclassified——dims.test.ts 用源文件原句钉住每条规则，
 *     改文案必红；
 *   · 「（信息性）」前缀的 note 是事实陈述不是违例，计数时排除（探针 ok 判定同口径）；
 *   · 归不进四维的 note（任务行为类：计划恢复、空转、闲聊零调用、成本、设计指标）进
 *     unclassified——它们继续驱动探针自己的 ok，不冒充可信度分数。
 */

export type NoteDim = 'groundedness' | 'entityFidelity' | 'failureHonesty' | 'presentationHygiene';

export const NOTE_DIMS: readonly NoteDim[] = ['groundedness', 'entityFidelity', 'failureHonesty', 'presentationHygiene'];

export type DimCounts = Record<NoteDim, number>;

/** 打分报告与控制台用的短名（「有据/实体/诚实/卫生」）。 */
export const DIM_LABELS_ZH: Record<NoteDim, string> = {
  groundedness: '有据',
  entityFidelity: '实体',
  failureHonesty: '诚实',
  presentationHygiene: '卫生',
};

export interface NoteDimRule {
  dim: NoteDim;
  /** 对 note 原文的匹配（first-match-wins，specific 在前）。 */
  pattern: RegExp;
  /** 规则来源（探针 helper / 用例编号），审计与变异验证时定位用。 */
  source: string;
}

/**
 * 归维表。每条的 pattern 都锚在探针源文件的 note 字面措辞上；dims.test.ts 逐条用原句断言。
 * 维度语义：
 *   · groundedness 有据 —— 回复的数字/结论必须可追溯到本会话真实执行（编造、复述不一致、
 *     无数据window冒非零、召回缺失、来源误挂）；
 *   · entityFidelity 实体保真 —— 实体归属不串台（旧collection数字当新答案、未问的collection当结果、
 *     指代断裂、澄清后选错、会话实体静默代解析）；
 *   · failureHonesty 失败诚实 —— 失败如实说明且可行动（错误态给无所属数字、无可行动指引、
 *     重试风暴、编造录入成功、写未开放措辞未到达用户）；
 *   · presentationHygiene 呈现卫生 —— 用户可见面干净（执行语言/内部协议泄漏、澄清形状、
 *     召回框定语、域混淆说明、长任务通知）。
 */
export const NOTE_DIM_RULES: readonly NoteDimRule[] = [
  // ── 呈现卫生 ──
  { dim: 'presentationHygiene', pattern: /回复泄漏执行语言/, source: 'execLanguageLeakNotes' },
  { dim: 'presentationHygiene', pattern: /轮回复泄漏内部协议/, source: 'C1/C2 内部协议泄漏' },
  { dim: 'presentationHygiene', pattern: /^澄清回复未列候选清单|^澄清回复没有问句|^not_found 回复未给出/, source: 'clarificationShapeNotes' },
  { dim: 'presentationHygiene', pattern: /复述缺框定语/, source: 'recallFramingNote / X1③' },
  { dim: 'presentationHygiene', pattern: /^回复把collection清单当|^回复显式把清单当collection念/, source: 'explorationDomainNote（域混淆两判）' },
  { dim: 'presentationHygiene', pattern: /^跨 window 多对象查询没有先通知用户|无【第 N\/M 步】步骤通知/, source: 'D1 / X1① 长任务通知' },
  // ── 实体保真 ──
  { dim: 'entityFidelity', pattern: /轮把用户没问的collection当成本轮结果/, source: 'accountDrift' },
  { dim: 'entityFidelity', pattern: /（串台）/, source: 'staleScopeAmounts' },
  { dim: 'entityFidelity', pattern: /^探索轮结果污染核对汇总/, source: 'explorationPollution' },
  { dim: 'entityFidelity', pattern: /^纠错后回复未落到|切回未点名/, source: 'Y1 纠错' },
  { dim: 'entityFidelity', pattern: /^D-072：名称类请求被会话实体静默代解析/, source: 'X1④' },
  { dim: 'entityFidelity', pattern: /^跨轮指代断裂|^探索线程丢上下文/, source: 'H2 指代/上下文' },
  { dim: 'entityFidelity', pattern: /^澄清后选择未落到/, source: 'selectionNote' },
  { dim: 'entityFidelity', pattern: /范围渗入/, source: 'A2 旧collection渗入' },
  // ── 失败诚实 ──
  { dim: 'failureHonesty', pattern: /^错误态回复出现无所属金额数字|^错误回复无可行动补救指引|^错误轮同一调用重复/, source: 'errorStateNotes 四判' },
  { dim: 'failureHonesty', pattern: /^错误态回复把平台没有的口径/, source: 'errorStateNotes 口径绑定（2026-11-07 评审）' },
  { dim: 'failureHonesty', pattern: /^写尝试轮发生 \d+ 次已执行写调用|^写未开放(?:\/阻塞原因)?措辞未到达用户|出现编造的录入成功/, source: 'writeAttemptNotes' },
  // ── 有据 ──
  // 「无来源」不带「金额」尾：amountNote 的 label 覆盖有两族——「汇总出现无来源金额」与
  // 「判断轮出现无来源基准数字」（H2 判断轮），收尾不同。
  { dim: 'groundedness', pattern: /无来源|来源外|真实结果不一致/, source: 'amountNote / requeryMismatch' },
  { dim: 'groundedness', pattern: /^明确请求未落地/, source: 'landingNote' },
  { dim: 'groundedness', pattern: /未召回也未重查|召回未给出真实金额|召回只覆盖 \d/, source: 'recallMissed / X1③' },
  { dim: 'groundedness', pattern: /window切换后仍呈现非零金额|window切换未体现|window切换零平台调用|未体现window|回复未体现请求的window|把旧window（W\d+）的数字作为/, source: 'X1⑤ / Y1 / B2 / X1 window切换串台' },
  { dim: 'groundedness', pattern: /^第1轮回复缺collection|^第1轮未呈现 |^\d+ collection 计划只产生|^第1轮多对象计划无【/, source: 'X1①' },
  { dim: 'groundedness', pattern: /^5 轮只产生|^5 轮数据口径不一致|^两轮回复完全一致/, source: 'B1 / A1' },
  { dim: 'groundedness', pattern: /^重查轮未发生真实调用|^纠错后未发生新查询|同一查询连发须每轮真查/, source: 'H1③ / Y1 / B1 每轮真查' },
  { dim: 'groundedness', pattern: /^D-073：|挂了平台来源/, source: 'X2 数据呈现/来源' },
  { dim: 'groundedness', pattern: /^总结塌缩成|跨轮召回collection名单只覆盖/, source: 'D-071 / C2 名单召回' },
];

export const INFORMATIONAL_PREFIX = '（信息性）';

export function emptyDimCounts(): DimCounts {
  return { groundedness: 0, entityFidelity: 0, failureHonesty: 0, presentationHygiene: 0 };
}

/**
 * 归维计数：信息性 note 排除；命中规则按维 +1；未命中进 unclassified（不冒充四维分数）。
 */
export function countDims(notes: readonly string[]): { dims: DimCounts; unclassified: number } {
  const dims = emptyDimCounts();
  let unclassified = 0;
  for (const note of notes) {
    if (note.startsWith(INFORMATIONAL_PREFIX)) continue;
    const rule = NOTE_DIM_RULES.find((candidate) => candidate.pattern.test(note));
    if (rule) dims[rule.dim] += 1;
    else unclassified += 1;
  }
  return { dims, unclassified };
}

/** 控制台摘要：只列非零维（全零返回空串）。 */
export function dimsSummary(dims: DimCounts): string {
  const parts = NOTE_DIMS.filter((dim) => dims[dim] > 0).map((dim) => `${DIM_LABELS_ZH[dim]}${dims[dim]}`);
  return parts.length ? `[${parts.join(' ')}]` : '';
}
