/**
 * 评测退出码语义单测（用户裁定 2026-11-12）。
 *
 *   0 = 评测正常完成且判据通过
 *   2 = 评测正常完成但业务/安全判据未通过
 *   3 = 工具/环境/证据采集/评测执行异常，无法得出有效判定（inconclusive 属这类）
 *
 * 映射是唯一出处（exitCodeFor）：包装器只把自己已有的判定折成 pass/fail/inconclusive，
 * 不许自己发明映射，也不许把 inconclusive 折成 0（假绿）或 2（把「没法判」混进判据红）。
 */
import { describe, expect, it } from 'vitest';
import { EXIT_FAIL, EXIT_INCONCLUSIVE, EXIT_PASS, exitCodeFor, type EvalVerdict } from './exit-codes';

describe('exitCodeFor：用户裁定的 0/2/3 语义', () => {
  it('pass → 0；fail（判据红）→ 2；inconclusive（不可判/执行异常）→ 3', () => {
    expect(exitCodeFor('pass')).toBe(0);
    expect(exitCodeFor('fail')).toBe(2);
    expect(exitCodeFor('inconclusive')).toBe(3);
  });

  it('三档常量与函数一致，且 inconclusive 绝不折成 0 或 2', () => {
    expect(EXIT_PASS).toBe(0);
    expect(EXIT_FAIL).toBe(2);
    expect(EXIT_INCONCLUSIVE).toBe(3);
    expect(exitCodeFor('inconclusive')).not.toBe(EXIT_PASS);
    expect(exitCodeFor('inconclusive')).not.toBe(EXIT_FAIL);
  });

  it('未知判定（包装器映射漏项/运行时防呆）fail-closed → 3，不冒充通过也不冒充判据红', () => {
    const verdicts: readonly string[] = ['unknown', ''];
    expect(verdicts.map((item) => exitCodeFor(item as unknown as EvalVerdict))).toEqual([3, 3]);
    expect(exitCodeFor(undefined as unknown as EvalVerdict)).toBe(3);
  });

  it('穷尽性：三档判定各自映射唯一确定，无第二档语义漂移', () => {
    const table: ReadonlyArray<[EvalVerdict, number]> = [['pass', 0], ['fail', 2], ['inconclusive', 3]];
    for (const [verdict, code] of table) expect(exitCodeFor(verdict)).toBe(code);
  });
});
