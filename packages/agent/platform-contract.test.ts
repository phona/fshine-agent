/**
 * 平台契约适配层（platform-contract.ts）的码级判定测试（2026-09 第二波，任务3）。
 *
 * 这里是 fshine 仓库中唯一允许出现平台实现细节的模块，登录态判定也因此收口在
 * 这里：**码是数据，消息文案不是**——平台改文案不影响分类，新增登录态失败
 * 模式 = 往码集合里加一行。
 */
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_AUTH_ERROR_CODES,
  SELECTION_CLARIFICATION_CODES,
  isPlatformAuthError,
  parseEnvelope,
  platformErrorCodeOf,
  selectionClarificationFromResponses,
  selectionClarificationOf,
} from './src/platform-contract';

describe('平台登录态错误码集合（唯一适配层）', () => {
  it('覆盖 17dz 侧 AUTH_* 四档 + 脚本层归一码 NEEDS_LOGIN + D-076 登录流程两码', () => {
    expect([...PLATFORM_AUTH_ERROR_CODES].sort()).toEqual([
      'AUTH_EXPIRED',
      'AUTH_REDIRECTED_TO_LOGIN',
      'AUTH_REJECTED',
      'AUTH_UNKNOWN',
      'AUTH_WORKBENCH_NOT_READY',
      'LOGIN_PAGE_CHANGED',
      'NEEDS_LOGIN',
    ]);
  });

  it('platformErrorCodeOf：挂码优先，其次消息的 CODE: 前缀（契约渲染格式）', () => {
    expect(platformErrorCodeOf(Object.assign(new Error('x'), { code: 'AUTH_EXPIRED' }))).toBe('AUTH_EXPIRED');
    expect(platformErrorCodeOf(new Error('AUTH_REDIRECTED_TO_LOGIN: 期望 …；实际 …；正确形态 …'))).toBe('AUTH_REDIRECTED_TO_LOGIN');
    // 信封的 error.code 经宿主侧载体传递时同样认码
    expect(platformErrorCodeOf({ error: { code: 'NEEDS_LOGIN', message: '…' } })).toBeNull();
    expect(platformErrorCodeOf({ code: 'NEEDS_LOGIN' })).toBe('NEEDS_LOGIN');
    // 纯自然语言（无码）→ null：交给上层过渡正则，不猜
    expect(platformErrorCodeOf(new Error('平台登录已过期，自动登录失败'))).toBeNull();
    expect(platformErrorCodeOf(new Error('科目编码不存在'))).toBeNull();
    expect(platformErrorCodeOf(null)).toBeNull();
  });

  it('isPlatformAuthError：只认集合内的码，其余一律 false', () => {
    expect(isPlatformAuthError(Object.assign(new Error('x'), { code: 'AUTH_EXPIRED' }))).toBe(true);
    expect(isPlatformAuthError(new Error('NEEDS_LOGIN: 请登录'))).toBe(true);
    expect(isPlatformAuthError(Object.assign(new Error('x'), { code: 'SUBJECT_NOT_FOUND' }))).toBe(false);
    expect(isPlatformAuthError(new Error('GATE_REFUSE: 期望 …'))).toBe(false);
    // 输入不足类码（纠错环用）不是登录态
    expect(isPlatformAuthError(new Error('INVALID_PERIOD: 期望 …'))).toBe(false);
  });

  it('信封解析不变：RESULT 信封的 error.code 是码级判据的源头', () => {
    const envelope = parseEnvelope('RESULT {"v":1,"op":"finance.query-receivables","status":"failed","data":null,"error":{"code":"AUTH_EXPIRED","message":"…"}}');
    expect(envelope?.error?.code).toBe('AUTH_EXPIRED');
    expect(isPlatformAuthError(envelope?.error)).toBe(true);
  });
});

// ── 选择类澄清提取（2026-09-27 Stage 3 事故根治包，任务 1）────────────────────
//
// 为什么由宿主持有：模型是执行语言与用户语言之间唯一的翻译器，压力下翻译退化，脚本路径/
// 错误码/门的规则就漏进最终回复（实测：一次结构化歧义被翻译成 1201 字符技术报告）。
// 提取因此只认契约数据（码 + status + data.candidates[].name），候选名只取平台返回的。

/** 一条 tool_result 消息（原生形状的最小构造：role + content 分段）。 */
function toolResult(text: string): { role: string; content: Array<{ type: 'text'; text: string }> } {
  return { role: 'toolResult', content: [{ type: 'text', text }] };
}

const AMBIGUOUS_ENVELOPE = 'RESULT {"v":1,"op":"finance.search-account-sets","status":"needs_input","data":{"query":"幻辰","candidates":[{"name":"幻辰财税"},{"name":"幻辰实业有限公司"}],"exactMatch":false},"error":{"code":"ACCOUNT_SET_AMBIGUOUS","message":"命中多个候选：幻辰财税、幻辰实业有限公司"}}';
const NOT_FOUND_ENVELOPE = 'RESULT {"v":1,"op":"finance.search-account-sets","status":"not_found","data":{"query":"胜利","candidates":[],"exactMatch":false},"error":{"code":"ACCOUNT_SET_NOT_FOUND","message":"未命中任何账套"}}';

describe('选择类澄清提取（唯一信封适配层）', () => {
  it('歧义信封 → {code, query, candidates}，候选名只取平台返回的', () => {
    expect(selectionClarificationOf(parseEnvelope(AMBIGUOUS_ENVELOPE))).toEqual({
      code: 'ACCOUNT_SET_AMBIGUOUS',
      query: '幻辰',
      candidates: ['幻辰财税', '幻辰实业有限公司'],
    });
  });

  it('未找到信封 → 同一形状，候选为空数组（不是 undefined）', () => {
    expect(selectionClarificationOf(parseEnvelope(NOT_FOUND_ENVELOPE))).toEqual({
      code: 'ACCOUNT_SET_NOT_FOUND',
      query: '胜利',
      candidates: [],
    });
  });

  it('平台 correctForm 随信封提取（L2：宿主渲染数据，不镜像措辞）', () => {
    const withForm = 'RESULT {"v":1,"op":"finance.search-account-sets","status":"not_found","data":{"query":"胜利","candidates":[]},"error":{"code":"ACCOUNT_SET_NOT_FOUND","message":"…","correctForm":"先用 search-account-sets 搜出平台规范名再查，不猜简称"}}';
    expect(selectionClarificationOf(parseEnvelope(withForm))).toEqual({
      code: 'ACCOUNT_SET_NOT_FOUND',
      query: '胜利',
      candidates: [],
      correctForm: '先用 search-account-sets 搜出平台规范名再查，不猜简称',
    });
    // 卫生：控制字符剥掉、空白折叠、超长截断；空串/非字符串 → 不挂这个键
    const messy = 'RESULT {"v":1,"op":"x","status":"not_found","data":{"query":"q","candidates":[]},"error":{"code":"ACCOUNT_SET_NOT_FOUND","message":"…","correctForm":"  A\\u0000B\\nC  "}}';
    expect(selectionClarificationOf(parseEnvelope(messy))?.correctForm).toBe('A B C');
    expect(selectionClarificationOf(parseEnvelope('RESULT {"v":1,"op":"x","status":"not_found","data":{"query":"q","candidates":[]},"error":{"code":"ACCOUNT_SET_NOT_FOUND","message":"…","correctForm":"   "}}'))?.correctForm).toBeUndefined();
    expect(selectionClarificationOf(parseEnvelope('RESULT {"v":1,"op":"x","status":"not_found","data":{"query":"q","candidates":[]},"error":{"code":"ACCOUNT_SET_NOT_FOUND","message":"…","correctForm":42}}'))?.correctForm).toBeUndefined();
    // 从 tool_result 走同一条提取（生产路径）
    expect(selectionClarificationFromResponses([toolResult(withForm)])?.correctForm).toBe('先用 search-account-sets 搜出平台规范名再查，不猜简称');
  });

  it('从 tool_result 提取：本回合最后一条带信封的平台响应决定收尾状态', () => {
    expect(selectionClarificationFromResponses([
      toolResult('stdout noise\n' + AMBIGUOUS_ENVELOPE),
    ])).toEqual({ code: 'ACCOUNT_SET_AMBIGUOUS', query: '幻辰', candidates: ['幻辰财税', '幻辰实业有限公司'] });
    // 早先歧义之后重查成功（completed）：收尾状态是数据答案，不能被旧信封劫持成澄清问句
    expect(selectionClarificationFromResponses([
      toolResult(AMBIGUOUS_ENVELOPE),
      toolResult('RESULT {"v":1,"op":"finance.query-receivables","status":"completed","data":{"query":"幻辰财税"},"error":null}'),
    ])).toBeUndefined();
  });

  it('其他状态一律 undefined：completed 数据答案 / 其他错误码 / 没有信封 / 空转录', () => {
    // 同一选择类码但 status 不是选择类（契约矛盾）→ 不认
    expect(selectionClarificationOf(parseEnvelope('RESULT {"v":1,"op":"x","status":"failed","data":{"query":"幻辰","candidates":[{"name":"幻辰财税"}]},"error":{"code":"ACCOUNT_SET_AMBIGUOUS","message":"…"}}'))).toBeUndefined();
    // 登录态/输入不足类码不是选择类（各有既有路径）
    expect(selectionClarificationOf(parseEnvelope('RESULT {"v":1,"op":"x","status":"failed","data":null,"error":{"code":"AUTH_EXPIRED","message":"…"}}'))).toBeUndefined();
    expect(selectionClarificationOf(parseEnvelope('RESULT {"v":1,"op":"x","status":"failed","data":null,"error":{"code":"INVALID_PERIOD","message":"…"}}'))).toBeUndefined();
    expect(selectionClarificationOf(parseEnvelope('RESULT {"v":1,"op":"x","status":"needs_input","data":{"customer":"猫一杯","candidates":[{"name":"某客户"}]},"error":{"code":"ASSISTANT_AMBIGUOUS","message":"…"}}'))).toBeUndefined();
    // 数据完整性前置：信封没带 query（query-receivables 的 not_found 分支 data 为 null）时
    // 组装不出"没有找到匹配X的对象"，宁可不挂——行为零变化，不出指代不清的占位问句
    expect(selectionClarificationOf(parseEnvelope('RESULT {"v":1,"op":"finance.query-receivables","status":"not_found","data":null,"error":{"code":"ACCOUNT_SET_NOT_FOUND","message":"…"}}'))).toBeUndefined();
    // 没有信封（worker 自由文本）、没有 data、空消息列表 → 全部 undefined
    expect(selectionClarificationFromResponses([toolResult('子 Agent：平台说匹配到多个候选，请选择')])).toBeUndefined();
    expect(selectionClarificationFromResponses([])).toBeUndefined();
    expect(selectionClarificationOf(null)).toBeUndefined();
  });

  it('码集合可扩：先登记这两个，新增选择类模式往集合里加码', () => {
    expect([...SELECTION_CLARIFICATION_CODES].sort()).toEqual(['ACCOUNT_SET_AMBIGUOUS', 'ACCOUNT_SET_NOT_FOUND']);
  });
});
