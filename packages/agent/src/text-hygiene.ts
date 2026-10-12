/**
 * 文本卫生（两层共用的最小原语）：宿主与模型/平台边界上的文本清洗。
 *
 * 独立成模块的理由是依赖方向：这些原语被 runtime.ts（终稿组装、出口校验）与
 * turn-relay.ts（交还材料渲染）同时使用，而后者不能 import runtime（那会成环）。
 * 判据本体住在这里，两个使用方认同一份；组合型判据（worker 干净说明的准入）仍住
 * runtime.ts——它还要读执行语言指纹表与宿主兜底文案常量，那些是 runtime 私有的。
 */

/** 去掉子 Agent 文本尾部的〔本轮执行面：…〕系统元数据。 */
export function stripFootprint(text: string): string {
  return text.replace(/\n*〔本轮执行面：[^〕]*〕\s*$/u, '').trim();
}
