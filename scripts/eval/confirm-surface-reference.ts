/**
 * S2 判据的**对照渲染器**（标定脚手架，不是生产渲染器）。
 *
 * 它按已裁定的设计渲染一条确认面，用来回答一个判据自己回答不了的问题：
 * 「confirm-surface-case 判红，是因为判据不可满足，还是因为生产渲染器还没长成要的样子？」
 * 同一把尺判它必须绿（confirm-surface-criteria.test.ts 的标定组 + confirm-surface-case.test.ts
 * 的对照条），所以判红是渲染器的事。
 *
 * 形态（裁定原文的直译）：
 *   范围段 ← 宿主从结构化事实渲染（平台清单第 5 列名 + 声明值），模型碰不到；
 *   后果段 ← 模型叙述原样带上，宿主不改写；
 *   可选项 ← 继续与取消两条路径都给，答复词取自宿主接受的答复词表。
 *
 * 突变开关只服务于标定测试「每类判据各自有牙」：一次只动一处，看对应判据是否单独翻红。
 * 生产代码不许 import 本模块；本模块也不 import 生产模块。
 */
import {
  HOST_ACCEPTED_REPLIES,
  type ConfirmSurfaceFacts,
  type ConfirmSurfaceScenario,
} from './confirm-surface-criteria';

export interface ReferenceRenderOptions {
  /** 突变：脚本路径混进范围段（执行语言上屏）。 */
  scriptPathInScope?: boolean;
  /** 突变：宿主自己改写后果叙述（模型原话被吞掉）。 */
  rewriteConsequence?: boolean;
  /** 突变：把模型叙述当范围段用（措辞即范围，范围事实不在段里）。 */
  narrativeAsScope?: boolean;
  /** 突变：模型叙述被追加进范围段（范围段里混进措辞）。 */
  narrativeAppendedToScope?: boolean;
  /** 突变：范围段不含平台事实（模型在叙述里提过，但宿主没渲染范围）。 */
  scopeWithoutFacts?: boolean;
  /** 突变：整个确认面没有后果段。 */
  omitConsequence?: boolean;
  /** 突变：省略取消路径（用户只有一条路可走）。 */
  omitCancel?: boolean;
  /** 突变：模板自带业务词（"记录"是词表里的领域概念伪装形）。 */
  templateBusinessWord?: boolean;
  /** 突变：范围段渲染同一份清单里别的 operation 的平台名。 */
  useNeighbourLabel?: boolean;
}

/** 渲染一条确认面（含字段标记；可选项两条路径都给）。 */
export function renderReferenceConfirmSurface(
  facts: ConfirmSurfaceFacts,
  narrative: string,
  options: ReferenceRenderOptions = {},
): string {
  const label = options.useNeighbourLabel ? facts.otherLabels[0] ?? '' : facts.labels.join('、');
  const factsText = options.scopeWithoutFacts
    ? '本次操作'
    : `${label}${facts.values.length > 0 ? `（${facts.values.join('、')}）` : ''}`;
  const scope = options.narrativeAsScope
    ? `范围：${narrative}`
    : `范围：${factsText}${options.narrativeAppendedToScope ? `（${narrative}）` : ''}${options.scriptPathInScope ? ' 依据 src/stock/scripts/query.js' : ''}`;
  const consequence = options.omitConsequence
    ? ''
    : options.rewriteConsequence
      ? `后果：将执行本次核对${options.templateBusinessWord ? '，涉及相关记录' : ''}。`
      : `后果：${narrative}${options.templateBusinessWord ? '（涉及相关记录）' : ''}`;
  const optionsLine = options.omitCancel
    ? `可选项：回复“${HOST_ACCEPTED_REPLIES.confirm[0]}”执行。`
    : `可选项：回复“${HOST_ACCEPTED_REPLIES.confirm[0]}”执行；回复“${HOST_ACCEPTED_REPLIES.cancel[0]}”放弃。`;
  return [`计划通知：${scope}`, consequence, optionsLine].filter((line) => line !== '').join('\n');
}

/** 对照场景：同一份事实、多条不同叙述各渲染一次。 */
export function referenceConfirmSurfaceScenario(
  facts: ConfirmSurfaceFacts,
  narratives: readonly string[],
  options: ReferenceRenderOptions = {},
): ConfirmSurfaceScenario {
  return {
    facts,
    renderings: narratives.map((narrative) => ({
      narrative,
      text: renderReferenceConfirmSurface(facts, narrative, options),
    })),
  };
}
