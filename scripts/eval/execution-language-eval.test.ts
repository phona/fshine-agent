/**
 * 评测侧执行语言指纹尺的回归锁（2026-11-10 评测判据校准）。
 *
 * 本轮只改「错误码」一类的小写蛇形臂：旧写法 `[a-z]+(?:_[a-z]+)+` 把所有小写 snake
 * token 都当错误码，Y2 实测回复里正常解释对象名的 `gamma_collection`（与
 * `gamma-collection` / `gamma collection` 并列的同义写法）被报成「错误码」——假红。
 * 校准后小写蛇形臂要求失败语义词根（NOT_FOUND|FAILED|ERROR|INVALID|DECLINED|
 * MISSING|DENIED|AMBIGUOUS|NO_DATA|PARSE|SHAPE，大小写不敏感）；全大写蛇形臂与
 * 已登记操作名不动（宿主侧 UPPER_SNAKE 本身就是错误码形态）。
 *
 * 注意：本文件只钉评测尺（scripts/eval/execution-language-eval.ts）。探针在
 * probe-real-agent.ts:1431 的 INTERNAL_CONTROL_TERM_EN 英文补丁是另一层，不在
 * 本轮范围、不受本尺改动影响。
 */
import { describe, expect, it } from 'vitest';
import { EVAL_EXECUTION_LANGUAGE_FINGERPRINTS, executionLanguageFingerprints } from './execution-language-eval';

describe('执行语言指纹 · 错误码小写蛇形臂（Y2 假红校准）', () => {
  it('Y2 第 1 轮原文：gamma_collection 是对象名同义写法，不再报「错误码」', () => {
    // 逐字片段来自 .runtime/probe-fshine-probe-IhdXQv.json 的 Y2 turns[0].reply。
    const reply = '用 "gamma-collection" 及其近似写法（gamma、gamma_collection、gamma collection）查询，平台均返回“没有匹配的 collection”。';
    expect(executionLanguageFingerprints(reply)).not.toContain('错误码');
    // 其它四类也不该被这段文本命中（证明本条不是靠别的标签顺带通过）。
    expect(executionLanguageFingerprints(reply)).toEqual([]);
  });

  it('失败语义词根仍命中：not_found / collection_not_found / parse_error / no_data / missing_field', () => {
    for (const code of ['not_found', 'collection_not_found', 'parse_error', 'no_data', 'missing_field', 'invalid_shape', 'ambiguous_result']) {
      expect(executionLanguageFingerprints(`platform returned ${code} for that query`), code).toContain('错误码');
    }
  });

  it('大小写不敏感：NOT_FOUND / Not_Found / Collection_Not_Found 都命中', () => {
    for (const code of ['NOT_FOUND', 'Not_Found', 'Collection_Not_Found']) {
      expect(executionLanguageFingerprints(`platform returned ${code}`), code).toContain('错误码');
    }
  });

  it('全大写蛇形臂保持原样：GAMMA_COLLECTION 仍按大写错误码形态命中', () => {
    // 全大写臂不动（宿主侧 UPPER_SNAKE = 错误码形态）；收紧的只是小写/混合蛇形臂。
    expect(executionLanguageFingerprints('platform returned GAMMA_COLLECTION')).toContain('错误码');
  });

  it('词根要求不是把普通英文单词也算错误码：裸 error / shape / ambiguous 不命中', () => {
    for (const prose of ['An error occurred while checking.', 'The shape is different.', 'The result is ambiguous.']) {
      expect(executionLanguageFingerprints(prose), prose).not.toContain('错误码');
    }
  });

  it('带连字符的对象名（gamma-collection）不是蛇形错误码', () => {
    expect(executionLanguageFingerprints('checked gamma-collection just now')).not.toContain('错误码');
  });
});

describe('执行语言指纹 · 其余四类不受本轮改动影响', () => {
  it('标签集合仍是五类、顺序不变（dims 归维按标签组句）', () => {
    expect(EVAL_EXECUTION_LANGUAGE_FINGERPRINTS.map((entry) => entry.label))
      .toEqual(['脚本路径', '错误码', 'JSON 片段', 'operation 名', '内部控制词']);
  });

  it('已登记操作名与脚本路径照旧命中', () => {
    expect(executionLanguageFingerprints('finance.search-account-sets')).toContain('operation 名');
    expect(executionLanguageFingerprints('see src/tools/query.js for details')).toContain('脚本路径');
  });
});
