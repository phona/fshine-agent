/**
 * 平台契约适配层（platform-contract.ts）的码级判定测试（2026-09 第二波，任务3）。
 *
 * 这里是 fshine 仓库中唯一允许出现平台实现细节的模块，平台不可用族的判定也因此收口在
 * 这里：**码是数据，消息文案不是**——平台改文案不影响分类，新增平台侧不可用失败
 * 模式 = 往码集合里加一行（登录失效与页面响应超时同族：同一类失败事实；退避策略归
 * 执行层自己的限流/熔断，宿主只上交事实）。
 */
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_AUTH_ERROR_CODES,
  SELECTION_CLARIFICATION_CODES,
  TERMINAL_FAST_PATH_CODES,
  isPlatformAuthError,
  parseEnvelope,
  platformAuthFailureOf,
  platformErrorCodeOf,
  selectionClarificationFromResponses,
  selectionClarificationOf,
  terminalFastPathOf,
} from './src/platform-contract';

describe('平台不可用族错误码集合（唯一适配层）', () => {
  it('覆盖 example-gateway 侧 AUTH_* 四档 + 脚本层归一码 NEEDS_LOGIN + D-076 登录流程两码 + 平台页面响应超时 PLATFORM_TIMEOUT', () => {
    expect([...PLATFORM_AUTH_ERROR_CODES].sort()).toEqual([
      'AUTH_EXPIRED',
      'AUTH_REDIRECTED_TO_LOGIN',
      'AUTH_REJECTED',
      'AUTH_UNKNOWN',
      'AUTH_WORKBENCH_NOT_READY',
      'LOGIN_PAGE_CHANGED',
      'NEEDS_LOGIN',
      'PLATFORM_TIMEOUT',
    ]);
  });

  it('PLATFORM_TIMEOUT 与登录失效同族：都是平台侧不可用事实（退避归执行层）', () => {
    // 超时不是登录问题，但对宿主是同一件事：平台这趟没给出可用答数且调用方改不好。
    // 故进同一集合、同一类失败事实；宿主只上交该事实，不在编排层做冷却/重试判断。
    expect(isPlatformAuthError(Object.assign(new Error('x'), { code: 'PLATFORM_TIMEOUT' }))).toBe(true);
    expect(isPlatformAuthError(new Error('PLATFORM_TIMEOUT: 期望 平台页面在 N 秒内渲染出结果/空态；实际 …'))).toBe(true);
    expect(platformAuthFailureOf(parseEnvelope('RESULT {"v":1,"op":"finance.search-account-sets","status":"failed","data":null,"error":{"code":"PLATFORM_TIMEOUT","message":"…"}}')))
      .toEqual({ code: 'PLATFORM_TIMEOUT' });
    // 边界：输入类 / 数据三态 / 兜底码不进本族（重试有意义或平台答得确定，不属于平台不可用事实）
    expect(isPlatformAuthError(Object.assign(new Error('x'), { code: 'INTERNAL' }))).toBe(false);
    expect(isPlatformAuthError(Object.assign(new Error('x'), { code: 'ACCOUNT_SET_NOT_FOUND' }))).toBe(false);
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
      // 声明派生的渲染绑定（宿主默认适配表：ACCOUNT_SET_AMBIGUOUS → 候选清单句）。
      render: 'candidates',
    });
  });

  it('未找到信封 → 同一形状，候选为空数组（不是 undefined）', () => {
    expect(selectionClarificationOf(parseEnvelope(NOT_FOUND_ENVELOPE))).toEqual({
      code: 'ACCOUNT_SET_NOT_FOUND',
      query: '胜利',
      candidates: [],
      render: 'confirm-name-with-hint',
    });
  });

  it('平台 correctForm 随信封提取（L2：宿主渲染数据，不镜像措辞）', () => {
    const withForm = 'RESULT {"v":1,"op":"finance.search-account-sets","status":"not_found","data":{"query":"胜利","candidates":[]},"error":{"code":"ACCOUNT_SET_NOT_FOUND","message":"…","correctForm":"先用 search-account-sets 搜出平台规范名再查，不猜简称"}}';
    expect(selectionClarificationOf(parseEnvelope(withForm))).toEqual({
      code: 'ACCOUNT_SET_NOT_FOUND',
      query: '胜利',
      candidates: [],
      render: 'confirm-name-with-hint',
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
    ])).toEqual({ code: 'ACCOUNT_SET_AMBIGUOUS', query: '幻辰', candidates: ['幻辰财税', '幻辰实业有限公司'], render: 'candidates' });
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

// ── 终局快路径信封判据（错误态快路径 v2，2026-10-16 重做）────────────────────
//
// 平台确定性终局码（PERIOD_NO_DATA / 客户辅助核算两态）以"整份答案"收尾时的机械提取。
// 判据只认契约数据（码 + status + data 字段），完整性门缺一不挂——话术缺了"下一步改查哪"
// 就不是可行动的诚实答案，宁可回到既有重规划循环（行为零变化）。

/** 便捷构造：RESULT 信封行 → parseEnvelope。 */
function terminalEnvelope(status: string, data: unknown, code: string): ReturnType<typeof parseEnvelope> {
  return parseEnvelope(`RESULT {"v":1,"op":"finance.query-receivables","status":"${status}","data":${JSON.stringify(data)},"error":{"code":"${code}","message":"…","correctForm":"…"}}`);
}

describe('终局快路径信封判据（terminalFastPathOf）', () => {
  it('码集合：只转三个终局码——SUBJECT_NOT_FOUND 等 worker 有自愈路径的码明确不转', () => {
    expect([...TERMINAL_FAST_PATH_CODES].sort()).toEqual([
      'ASSISTANT_AMBIGUOUS',
      'ASSISTANT_NOT_FOUND',
      'PERIOD_NO_DATA',
    ]);
    // 第一版结论仍有效：worker 能自愈的输入类码不是终局，快转只会截断它的自愈路径
    expect(terminalFastPathOf(terminalEnvelope('not_found', { query: 'x' }, 'SUBJECT_NOT_FOUND'))).toBeUndefined();
    expect(terminalFastPathOf(terminalEnvelope('not_found', { query: 'x' }, 'ACCOUNT_SET_NOT_FOUND'))).toBeUndefined();
  });

  it('PERIOD_NO_DATA：查询词/期间/可改查清单机械提取（与 example-gateway mock 信封逐字段对齐）', () => {
    expect(terminalFastPathOf(terminalEnvelope('not_found', {
      query: '幻辰财税',
      accountSet: '幻辰财税',
      subject: { code: '1122', name: '应收账款' },
      period: '202609',
      availablePeriods: ['202606', '平台当前期间'],
    }, 'PERIOD_NO_DATA'))).toEqual({
      code: 'PERIOD_NO_DATA',
      query: '幻辰财税',
      period: '202609',
      availablePeriods: ['202606', '平台当前期间'],
      render: 'scope-no-data',
    });
  });

  it('客户两态：customer 取 data.customer（不是 data.query）', () => {
    // NOT_FOUND（mock/真脚本信封都带 customer）：回显的是"找不到的客户名"，
    // 回显 data.query（账套搜索词）会让用户去确认一个没问过的对象
    expect(terminalFastPathOf(terminalEnvelope('not_found', { query: '幻辰财税', customer: '猫一杯' }, 'ASSISTANT_NOT_FOUND')))
      .toEqual({ code: 'ASSISTANT_NOT_FOUND', query: '猫一杯', render: 'confirm-name' });
    // AMBIGUOUS（真脚本信封带 customer）：同一条提取规则
    expect(terminalFastPathOf(terminalEnvelope('needs_input', { query: '幻辰财税', customer: '机电', candidates: [{ name: '幻电设备有限公司' }, { name: '机电贸易有限公司' }] }, 'ASSISTANT_AMBIGUOUS')))
      .toEqual({ code: 'ASSISTANT_AMBIGUOUS', query: '机电', render: 'confirm-name' });
  });

  it('完整性门：查询词/期间/非空清单/客户名缺一不挂（fail-loud 留痕由调用方负责）', () => {
    // PERIOD_NO_DATA：缺期间 / 缺查询词 / 清单缺失
    expect(terminalFastPathOf(terminalEnvelope('not_found', { query: '幻辰财税', availablePeriods: ['202606'] }, 'PERIOD_NO_DATA'))).toBeUndefined();
    expect(terminalFastPathOf(terminalEnvelope('not_found', { period: '202609', availablePeriods: ['202606'] }, 'PERIOD_NO_DATA'))).toBeUndefined();
    expect(terminalFastPathOf(terminalEnvelope('not_found', { query: '幻辰财税', period: '202609' }, 'PERIOD_NO_DATA'))).toBeUndefined();
    // 清单为空同样不挂：可改查清单是这句话的行动部分，空清单 = 契约不完整
    expect(terminalFastPathOf(terminalEnvelope('not_found', { query: '幻辰财税', period: '202609', availablePeriods: [] }, 'PERIOD_NO_DATA'))).toBeUndefined();
    // 客户两态：缺 customer 不挂（mock 的 AMBIGUOUS 信封只带 candidates——
    // 契约不完整就不快转，绝不拿账套搜索词冒充客户名）
    expect(terminalFastPathOf(terminalEnvelope('needs_input', { query: '幻辰财税', candidates: [{ name: '幻电设备有限公司' }] }, 'ASSISTANT_AMBIGUOUS'))).toBeUndefined();
    expect(terminalFastPathOf(terminalEnvelope('not_found', { query: '幻辰财税' }, 'ASSISTANT_NOT_FOUND'))).toBeUndefined();
  });

  it('status=completed 的同码信封不挂（码与 status 打架 = 契约违约，不快转数据答案）', () => {
    expect(terminalFastPathOf(terminalEnvelope('completed', { query: '幻辰财税', period: '202609', availablePeriods: ['202606'] }, 'PERIOD_NO_DATA'))).toBeUndefined();
  });

  it('没有信封 / 非终局码 → undefined（收尾判据与其余提取器同一把尺）', () => {
    expect(terminalFastPathOf(null)).toBeUndefined();
    expect(terminalFastPathOf(parseEnvelope('RESULT {"v":1,"op":"finance.query-receivables","status":"completed","data":{"query":"幻辰财税"},"error":null}'))).toBeUndefined();
  });
});
