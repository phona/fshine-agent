/**
 * 评测退出码语义（用户裁定 2026-11-12）的唯一出处。
 *
 *   0 = 评测正常完成且判据通过
 *   2 = 评测正常完成但业务/安全判据未通过
 *   3 = 工具/环境/证据采集/评测执行异常，无法得出有效判定（inconclusive 属这类）
 *
 * 纪律：调用方（generic-mock / measure-summary 等评测入口）只做「把自己已有的判定折成 pass / fail /
 * inconclusive」，然后调 exitCodeFor——不在各脚本里另写一份映射。映射本身不改变任何
 * 业务判据的阈值或语义；inconclusive 绝不许折成 0（假绿）。
 */
export type EvalVerdict = 'pass' | 'fail' | 'inconclusive';

export const EXIT_PASS = 0;
export const EXIT_FAIL = 2;
export const EXIT_INCONCLUSIVE = 3;

/**
 * 判定 → 进程退出码。fail-closed：未知判定（调用方映射漏项、运行时防呆）按
 * inconclusive 处理 → 3，既不冒充通过（0）也不冒充判据红（2）。
 */
export function exitCodeFor(verdict: EvalVerdict): number {
  switch (verdict) {
    case 'pass':
      return EXIT_PASS;
    case 'fail':
      return EXIT_FAIL;
    case 'inconclusive':
      return EXIT_INCONCLUSIVE;
    default:
      return EXIT_INCONCLUSIVE;
  }
}
