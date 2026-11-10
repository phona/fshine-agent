/**
 * 错误码表（error-codes.ts）的纪律测试（2026-09 第二波；2026-11-05 W2 镜像层退役后
 * 头注释同步为渲染层框架——宿主只持渲染纪律与结构教学，领域措辞由执行层信封携带）。
 *
 * 钉住三件事：
 *   ① 错误类码渲染三要素（码 + 期望/实际/正确形态），actual 缺省给稳定形态；
 *   ② 消息模板类码逐字返回表内文本（收尾/兜底话术的既有文本一个字不动）；
 *   ③ 未知码与误用 fail-loud——绝不静默 fallback 到通用消息。
 * 另钉表级纪律：措辞零业务词（泄漏 lint 同款预算）；W2 起三把全表锁守「宿主教学
 * 零业务命令语法 / 零平台 operation 名」的结构-only 边界（见文末 describe）。
 */
import { describe, expect, it } from 'vitest';
import {
  HOST_ERROR_CODE_NAMES,
  UNKNOWN_ERROR_CODE,
  clarificationTextFor,
  errorFor,
  has,
  messageFor,
  messageTextFor,
  platformUnavailableTextFor,
  terminalFailureTextFor,
  toolUserErrorFor,
} from './src/error-codes';
import { ToolUserError } from './src/driver';
import { PLATFORM_OPERATIONS, SELECTION_CLARIFICATION_CODES, TERMINAL_FAST_PATH_CODES } from './src/platform-contract';
import {
  DELEGATION_AUTH_FAILURE,
  DELEGATION_CANCELLED,
  DELEGATION_EXECUTOR_FAILURE,
  DELEGATION_MODEL_TRANSIENT_FAILURE,
  DELEGATION_TIMEOUT_FAILURE,
} from './src/context';
import {
  ACTIVATED_PLAN_NOT_EXECUTED,
  FALLBACK_FAILURE,
  FALLBACK_TIMEOUT,
  NO_EXECUTION_CLARIFICATION,
  RESUMED_PLAN_NOT_EXECUTED,
  executionLanguageFingerprints,
} from './src/runtime';
describe('fshine 错误码表（错误即数据）', () => {
  it('错误类码渲染三要素：码 + 期望/实际/正确形态，动态 actual 由拒绝点填', () => {
    expect(messageFor('PLAN_SHAPE_PREFIX', '```json', undefined, 'bin/example-gateway')).toBe('PLAN_SHAPE_PREFIX: 期望 bin/example-gateway plan 之前只允许 bash/sh 与路径前缀（围栏、外层引号、客套话都算多出来的内容）；实际 ```json；正确形态 方案是单行原始命令：bin/example-gateway plan {"goal":"…","calls":[{"operation":"…","args":[…]}]}，JSON 原样放在这一行命令里——不要加外层引号、不要跟 2>&1 等后缀、不要拆成多行；或把同一份 JSON 写进本轮工作区文件后以 bin/example-gateway plan --file <本轮工作区内的计划文件路径> 提交');
    // 索引类 actual 原样进消息（第几项出错要点得出来）
    expect(messageFor('PLAN_CALL_NOT_OBJECT', 2, undefined, 'bin/example-gateway')).toContain('实际 2；');
    // 稳定实际形态的码不传 actual 也有"实际"段
    expect(messageFor('TASK_ID_INVALID')).toContain('实际 taskId 为空或不是字符串；');
  });

  it('消息模板类码逐字返回表内文本：收尾/兜底话术与既有文本一致', () => {
    expect(messageTextFor('NO_EXECUTION_CLARIFICATION')).toBe('我需要实际查询平台才能回答这个问题，但本轮没有产生任何平台查询。请告诉我要查询的对象和范围，我重新查一次。');
    expect(messageTextFor('ACTIVATED_PLAN_NOT_EXECUTED')).toBe('执行方案已获批准（通知已送达），但查询没有执行。请回复“继续”，我按已批准的计划重新执行；如想改查询范围，直接告诉我。');
    expect(messageTextFor('RESUMED_PLAN_NOT_EXECUTED')).toBe('按您刚才确认的操作没有产生任何平台执行。请回复“继续”重跑，或直接告诉我要调整的范围。');
    expect(messageTextFor('FALLBACK_TIMEOUT')).toBe('查询超时,请稍后再试');
    expect(messageTextFor('FALLBACK_FAILURE')).toBe('查询失败,请稍后再试或联系管理员');
    expect(messageTextFor('DELEGATION_AUTH_FAILURE')).toBe('平台登录态过期，需要重新登录后才能继续查询。');
    expect(messageTextFor('DELEGATION_TIMEOUT_FAILURE')).toBe('平台响应超时，请稍后重试。');
    expect(messageTextFor('DELEGATION_EXECUTOR_FAILURE')).toBe('子任务执行失败，请稍后再试。');
    expect(messageTextFor('DELEGATION_CANCELLED')).toBe('子任务已取消。');
    // 模型瞬时失败档（波次C，2026-11-01）：与 executor 故障分开，如实说已自动重试。
    expect(messageTextFor('DELEGATION_MODEL_TRANSIENT_FAILURE')).toBe('模型服务瞬时中断，已自动重试仍未成功，请稍后再试。');
    expect(messageTextFor('ROUTE_RETRY_NUDGE')).toContain('route_current_turn');
    expect(messageTextFor('PLAN_PENDING_PERSIST_MISSING')).toBe('平台计划待确认，但宿主未配置安全持久化回调，请联系管理员。');
    // 写流程未接线的宿主配置故障话术（2026-11-08 起不再有"写未开放"合成话术：那句归因
    // 正是 D-096 记的假归因，写能不能真落地已归执行层）
    expect(messageTextFor('PROPOSAL_FLOW_NOT_CONFIGURED')).toBe('写流程未启用（未配置 changeIntents 仓库）。');
    // 同一次平台拒绝的另一种真相：该调用不该进计划（措辞零平台实现形状）
    expect(messageTextFor('PLAN_NOT_PLANNABLE')).toBe('该调用不需要计划、也不要放进计划，直接调用即可。');
    // runtime/context 的导出常量就是表值（同一份来源，测试与调用方继续认常量）
    expect(NO_EXECUTION_CLARIFICATION).toBe(messageTextFor('NO_EXECUTION_CLARIFICATION'));
    expect(ACTIVATED_PLAN_NOT_EXECUTED).toBe(messageTextFor('ACTIVATED_PLAN_NOT_EXECUTED'));
    expect(RESUMED_PLAN_NOT_EXECUTED).toBe(messageTextFor('RESUMED_PLAN_NOT_EXECUTED'));
    expect(FALLBACK_TIMEOUT).toBe(messageTextFor('FALLBACK_TIMEOUT'));
    expect(FALLBACK_FAILURE).toBe(messageTextFor('FALLBACK_FAILURE'));
    expect(DELEGATION_AUTH_FAILURE).toBe(messageTextFor('DELEGATION_AUTH_FAILURE'));
    expect(DELEGATION_TIMEOUT_FAILURE).toBe(messageTextFor('DELEGATION_TIMEOUT_FAILURE'));
    expect(DELEGATION_EXECUTOR_FAILURE).toBe(messageTextFor('DELEGATION_EXECUTOR_FAILURE'));
    expect(DELEGATION_CANCELLED).toBe(messageTextFor('DELEGATION_CANCELLED'));
    expect(DELEGATION_MODEL_TRANSIENT_FAILURE).toBe(messageTextFor('DELEGATION_MODEL_TRANSIENT_FAILURE'));
  });

  it('未知码 fail-loud：抛 UNKNOWN_ERROR_CODE 并挂上未登记的码，不静默 fallback', () => {
    for (const call of [
      () => messageFor('TOTALLY_NEW_FAILURE'),
      () => messageTextFor('TOTALLY_NEW_FAILURE'),
      () => errorFor('TOTALLY_NEW_FAILURE'),
      () => toolUserErrorFor('TOTALLY_NEW_FAILURE'),
    ]) {
      expect(call).toThrow(UNKNOWN_ERROR_CODE);
      try { call(); } catch (error) {
        expect((error as { code?: string }).code).toBe(UNKNOWN_ERROR_CODE);
        expect((error as { unknownCode?: string }).unknownCode).toBe('TOTALLY_NEW_FAILURE');
      }
    }
    expect(has('PLAN_SHAPE_PREFIX')).toBe(true);
    expect(has('TOTALLY_NEW_FAILURE')).toBe(false);
  });

  it('误用 fail-loud：消息模板类码不接受 actual/correctForm（它不是错误）', () => {
    expect(() => messageFor('NO_EXECUTION_CLARIFICATION', '多余的实际值')).toThrow(UNKNOWN_ERROR_CODE);
    expect(() => messageFor('ACTIVATED_PLAN_NOT_EXECUTED', undefined, '多余的正确形态')).toThrow(UNKNOWN_ERROR_CODE);
  });

  it('throw 站点：errorFor / toolUserErrorFor 把原码挂回 error.code（调用方继续认码）', () => {
    const plain = errorFor('TASK_NOT_FOUND');
    expect(plain).toBeInstanceOf(Error);
    expect(plain.message).toContain('TASK_NOT_FOUND: 期望');
    expect((plain as { code?: string }).code).toBe('TASK_NOT_FOUND');

    const tool = toolUserErrorFor('TASK_FORBIDDEN');
    expect(tool).toBeInstanceOf(ToolUserError);
    expect(tool.message).toContain('TASK_FORBIDDEN: 期望');
    expect((tool as { code?: string }).code).toBe('TASK_FORBIDDEN');
  });

  it('表级纪律：全部条目措辞零业务词（泄漏 lint 同款预算）', () => {
    // 镜像 platform-leak-lint 的业务词集合：执行层持有领域词，编排层不替平台说话
    const business = /应收|凭证|科目|账套|期间|目录/u;
    for (const code of ['PLAN_SHAPE_PREFIX', 'PLAN_SHAPE_GATE_TEACHING', 'ENTITY_OUT_OF_SCOPE', 'DECLINED_PLAN_LIMIT', 'TASK_NOT_FOUND', 'RESUMED_PLAN_NOT_EXECUTED', 'PLAN_PENDING_PERSIST_MISSING', 'PROPOSAL_FLOW_NOT_CONFIGURED', 'PLAN_NOT_PLANNABLE']) {
      expect(messageFor(code, undefined, undefined, 'bin/example-gateway'), code).not.toMatch(business);
    }
    // 平台不可用话术模板：占位符用分钟数填充后同样零业务词
    expect(platformUnavailableTextFor(10)).not.toMatch(business);
  });
  it('ENTITY_OUT_OF_SCOPE 的 correctForm 带正路径：名称检索指引 + 会话既有实体有效（任务 1/2）', () => {
    // 标定修复（2026-09-27 实体门事故）：负指令之外必须给被拦方（worker）可执行的自愈
    // 动作——先名称检索让平台响应携带规范名再提交；本会话早前用户亲自提供/确认过的实体
    // 同样是合法来源（第四来源 sessionEntities）。
    // W2-B 翻转点（2026-11-05 镜像层退役）：correctForm 不再指名平台 operation——
    // 「用哪个操作做名称检索」的权威在平台 operation 清单（operation list），宿主只教
    // 结构（先检索、名称进平台响应后再提交）；指名即镜像（退役前这里经
    // PLATFORM_OPERATIONS 写死 finance.search-account-sets）。反向断言 = 零指名。
    const rendered = messageFor('ENTITY_OUT_OF_SCOPE', '某个越权参数');
    expect(rendered).not.toContain(PLATFORM_OPERATIONS.financeSearchAccountSets);
    expect(rendered).toContain('名称检索');
    expect(rendered).toContain('平台响应');
    expect(rendered).toContain('同样有效');
    // expected 与四来源并集一致（标定描述不能说成三个来源）
    expect(rendered).toContain('本会话已确立实体');
  });
});

// ── 选择类澄清模板（2026-09-27 Stage 3 事故根治包，任务 1 渲染层）──────────────
//
// 宿主持信封数据机械组装澄清问题，模型不当翻译器。模板零业务词（候选名是数据不是措辞），
// 领域换了域一个字都不用改——泄漏 lint 的业务词预算守这一条。

describe('选择类澄清消息模板（宿主机械组装，模型不翻译）', () => {
  it('两条模板已登记，且与平台选择类码集合一一对应（漏登记任何一侧都会红）', () => {
    expect(has('AMBIGUOUS_SELECTION')).toBe(true);
    expect(has('NOT_FOUND_SELECTION')).toBe(true);
    // 平台侧码集合 ↔ 本表模板：两边必须覆盖同一批码（测试即那条"唯一的一条线"的锁）
    for (const code of SELECTION_CLARIFICATION_CODES) {
      expect(() => clarificationTextFor(code, { query: '某关键词', candidates: ['某候选'] }), code).not.toThrow();
    }
    // 不在集合内的码 fail-loud：绝不静默 fallback 到通用问句
    expect(() => clarificationTextFor('ASSISTANT_AMBIGUOUS', { query: 'x', candidates: ['y'] })).toThrow(UNKNOWN_ERROR_CODE);
  });

  it('两条模板措辞零业务词（候选名是数据，不是措辞）', () => {
    const business = /应收|凭证|科目|账套|期间|目录/u;
    // 业务词只放进候选名：模板本体仍然干净（泄漏 lint 同款预算）
    expect(clarificationTextFor('ACCOUNT_SET_AMBIGUOUS', { query: '某关键词', candidates: ['幻辰财税'] })).not.toMatch(business);
    expect(clarificationTextFor('ACCOUNT_SET_NOT_FOUND', { query: '某关键词', candidates: [] })).not.toMatch(business);
  });

  it('歧义模板：候选 1 个 / 多个 / 超长截断，查询词与序号原样进消息', () => {
    expect(clarificationTextFor('ACCOUNT_SET_AMBIGUOUS', { query: '幻辰', candidates: ['幻辰财税'] }))
      .toBe('没有找到唯一匹配“幻辰”的对象。平台上有 1 个名字相近的：1. 幻辰财税。你要查哪个？告诉我名称或序号即可。');
    expect(clarificationTextFor('ACCOUNT_SET_AMBIGUOUS', { query: '幻辰', candidates: ['幻辰财税', '幻辰实业有限公司'] }))
      .toBe('没有找到唯一匹配“幻辰”的对象。平台上有 2 个名字相近的：1. 幻辰财税 2. 幻辰实业有限公司。你要查哪个？告诉我名称或序号即可。');
    // 超长截断：超过 8 个候选只列前 8 个并说明总数（澄清问题不是目录页）
    const many = Array.from({ length: 12 }, (_, i) => `候选${i + 1}`);
    const rendered = clarificationTextFor('ACCOUNT_SET_AMBIGUOUS', { query: '某词', candidates: many });
    expect(rendered).toContain('平台上有 12 个名字相近的');
    expect(rendered).toContain('8. 候选8');
    expect(rendered).not.toContain('9. 候选9');
    expect(rendered).toContain('…等 12 个');
    // 单个超长候选名按数据卫生截断，不撑爆消息
    const long = clarificationTextFor('ACCOUNT_SET_AMBIGUOUS', { query: '某词', candidates: ['x'.repeat(60)] });
    expect(long).toContain(`1. ${'x'.repeat(40)}…`);
  });

  it('未找到模板：只要查询词，候选为空也渲染（没有"平台上有"段）', () => {
    expect(clarificationTextFor('ACCOUNT_SET_NOT_FOUND', { query: '胜利', candidates: [] }))
      .toBe('没有找到匹配“胜利”的对象。请确认准确名称后我再查。');
  });

  it('未找到模板的措辞槽位：信封带平台 correctForm 时优先渲染它（宿主不镜像措辞）', () => {
    const withForm = clarificationTextFor('ACCOUNT_SET_NOT_FOUND', {
      query: '胜利', candidates: [], correctForm: '先用 search-account-sets 搜出平台规范名再查，不猜简称',
    });
    // 平台措辞作为**数据**进回复（L2/D-002：宿主表只存"信封没带时的兜底"）
    expect(withForm).toBe('没有找到匹配“胜利”的对象。先用 search-account-sets 搜出平台规范名再查，不猜简称我再查。');
    // 信封没带 → 宿主兜底（挂「遗留待清」），且不出现空泛占位符
    const withoutForm = clarificationTextFor('ACCOUNT_SET_NOT_FOUND', { query: '胜利', candidates: [] });
    expect(withoutForm).toBe('没有找到匹配“胜利”的对象。请确认准确名称后我再查。');
    expect(withoutForm).not.toContain('{');
    expect(withoutForm).not.toContain('undefined');
  });

  it('歧义模板不消费 correctForm：用户可见事实已全部来自信封，平台的正确形态指引是给解析方的规则', () => {
    const rendered = clarificationTextFor('ACCOUNT_SET_AMBIGUOUS', {
      query: '幻辰', candidates: ['幻辰财税'], correctForm: '把候选呈现给用户选择——绝不代选',
    });
    expect(rendered).toBe('没有找到唯一匹配“幻辰”的对象。平台上有 1 个名字相近的：1. 幻辰财税。你要查哪个？告诉我名称或序号即可。');
  });

  it('查询词缺失时用领域无关的占位（信封没给 query 也不出裸引号）', () => {
    expect(clarificationTextFor('ACCOUNT_SET_NOT_FOUND', { query: '  ', candidates: [] }))
      .toContain('没有找到匹配“您指定的对象”的对象');
  });

  it('误用 fail-loud：未登记的码（含 fshine 自己的错误类码）走不了澄清渲染', () => {
    expect(() => clarificationTextFor('TASK_NOT_FOUND', { query: 'x', candidates: [] })).toThrow(UNKNOWN_ERROR_CODE);
    expect(() => clarificationTextFor('TOTALLY_NEW_CODE', { query: 'x', candidates: [] })).toThrow(UNKNOWN_ERROR_CODE);
  });
});

// ── 平台不可用话术模板（PLATFORM_UNAVAILABLE；宿主当前不在编排层合成）────────
//
// 2026-11-10 仲裁后宿主不再做平台健康记账/冷却/前置拦截（退避归执行层），runtime 也
// 不再合成这段终稿；模板与渲染出口保留在唯一消息表内，避免调用点现场拼写。与
// DELEGATION_AUTH_FAILURE 的分工不变：那句说"这一轮失败了、要重新登录"（一次性、可
// 行动），本模板说"已暂停自动重试、约 N 分钟后恢复"（连续失败后的状态）。措辞纪律：
// 只说平台侧异常与下一步动作，零内部控制词、零业务词、零执行语言指纹，也不编造原因。

describe('平台不可用话术模板（PLATFORM_UNAVAILABLE，宿主当前不合成）', () => {
  it('模板带 {minutes} 占位符，渲染出口用宿主时钟数据填充（与澄清模板同族）', () => {
    // 表内文本是模板：占位符只经专用出口填充（动态部分是数据不是措辞）
    expect(messageTextFor('PLATFORM_UNAVAILABLE')).toContain('{minutes}');
    expect(platformUnavailableTextFor(10)).toBe('平台侧登录或环境异常，与你的查询内容无关。已暂停自动重试，约 10 分钟后自动恢复尝试；持续异常请联系管理员。');
  });

  it('分钟数向上取整且至少 1（"约 0 分钟"不是人话；宿主自己算的数不值得失败回合）', () => {
    expect(platformUnavailableTextFor(1)).toContain('约 1 分钟');
    expect(platformUnavailableTextFor(0.4)).toContain('约 1 分钟');
    expect(platformUnavailableTextFor(0)).toContain('约 1 分钟');
    expect(platformUnavailableTextFor(9.2)).toContain('约 10 分钟');
    expect(platformUnavailableTextFor(600)).toContain('约 600 分钟');
  });

  it('措辞纪律：零内部控制词、零业务词、零执行语言指纹（生产指纹尺）', () => {
    const text = platformUnavailableTextFor(10);
    // 内部控制词（宿主机制，用户不需要知道）：额度/配额/熔断/计划门/拒绝上限/重试上限
    for (const word of ['额度', '配额', '熔断', '计划门', '拒绝上限', '重试上限']) {
      expect(text, word).not.toContain(word);
    }
    expect(text).not.toMatch(/应收|凭证|科目|账套|期间|目录/u);
    expect(executionLanguageFingerprints(text)).toEqual([]);
    // 不编造原因：只说"平台侧登录或环境异常"，不指定登录页改版/凭据过期任一归因
    expect(text).toContain('与你的查询内容无关');
    expect(text).toContain('已暂停自动重试');
    expect(text).toContain('自动恢复尝试');
    expect(text).toContain('请联系管理员');
  });
});
// ── 终局快路径模板（错误态快路径 v2，2026-10-16 重做）────────────────────────
//
// 平台确定性终局码（PERIOD_NO_DATA / 客户辅助核算两态）的话术收口在本表：驱动早停
// （皮带）与宿主终局分支（背带）共用 terminalFailureTextFor 渲染，话术只有一份来源。
// 动态部分（查询词/期间/可改查清单）是信封数据不是措辞，模板零业务词（泄漏 lint 同款
// 预算——领域换了域一个字都不用改）。

describe('终局快路径话术模板（宿主机械组装）', () => {
  it('两条模板已登记，且与平台终局码集合一一对应（漏登记任何一侧都会红）', () => {
    expect(has('PERIOD_NO_DATA_TERMINAL')).toBe(true);
    expect(has('ASSISTANT_NOT_FOUND_SELECTION')).toBe(true);
    // 平台侧终局码集合 ↔ 本表模板索引：两边必须覆盖同一批码（测试即那条线的锁）
    for (const code of TERMINAL_FAST_PATH_CODES) {
      expect(() => terminalFailureTextFor(code, { query: '某词', period: '202609', availablePeriods: ['202606'] }), code).not.toThrow();
    }
    // 不在集合内的码 fail-loud：绝不静默 fallback 到通用话术
    expect(() => terminalFailureTextFor('SUBJECT_NOT_FOUND', { query: 'x' })).toThrow(UNKNOWN_ERROR_CODE);
    expect(() => terminalFailureTextFor('ACCOUNT_SET_NOT_FOUND', { query: 'x' })).toThrow(UNKNOWN_ERROR_CODE);
  });

  it('PERIOD_NO_DATA：参数化模板带可改查清单（数据进占位符，措辞零业务词）', () => {
    expect(terminalFailureTextFor('PERIOD_NO_DATA', {
      query: '幻辰财税',
      period: '202609',
      availablePeriods: ['202606', '平台当前期间'],
    })).toBe('没有查到“幻辰财税”在 202609 的数据。平台上有数据的是：202606、平台当前期间。要改查的话，告诉我查哪一项即可。');
    const business = /应收|凭证|科目|账套|期间|目录/u;
    expect(terminalFailureTextFor('PERIOD_NO_DATA', { query: '某词', period: '202609', availablePeriods: ['202606'] })).not.toMatch(business);
  });

  it('客户两态共用结构句：查询词原样回显，无候选/无平台 correctForm 措辞（D-102 语域）', () => {
    // 两态各渲染一次，同一句结构话术（第一版措辞经评委验证，沿用）
    for (const code of ['ASSISTANT_NOT_FOUND', 'ASSISTANT_AMBIGUOUS']) {
      expect(terminalFailureTextFor(code, { query: '机电' })).toBe('没有找到匹配“机电”的对象。请确认准确名称后我再查。');
    }
  });

  it('PERIOD_NO_DATA 缺 period fail-loud：直接调用方绕过信封完整性门时响亮失败', () => {
    expect(() => terminalFailureTextFor('PERIOD_NO_DATA', { query: '幻辰财税', availablePeriods: ['202606'] })).toThrow(UNKNOWN_ERROR_CODE);
    expect(() => terminalFailureTextFor('PERIOD_NO_DATA', { query: '幻辰财税', period: '  ', availablePeriods: ['202606'] })).toThrow(UNKNOWN_ERROR_CODE);
  });
});

// ── W2 表征 golden：两条目镜像层退役后的渲染文本（W2-B 翻转留痕，2026-11-05）──
//
// F1 表征先行（W2-A，commit f234457）：退役前把现行渲染文本逐字钉住（当时 correctForm
// 含业务命令示例 ["--query","某名称","--period","202609"] 与平台 operation 名
// finance.search-account-sets；退役前钉子原文可 git show f234457 取回）。W2-B 镜像层
// 退役在本 describe 内有意翻转——F1「golden 一条不改」的合法例外 = 波次内有意行为
// 变更，翻转点与理由逐条留痕（F4 归因、F5 revert 有基可退）：
//   · PLAN_CALL_ARGS_NOT_ARRAY：correctForm 去业务命令示例（--query/--period 等命令
//     语法归平台，宿主只教结构：args 为字符串数组、命令行原样参数）；
//   · ENTITY_OUT_OF_SCOPE：correctForm 去平台 operation 名（「用哪个操作检索」的权威
//     在平台 operation 清单，宿主不指名），正路径文字逐字保留。
// 两条均不含网关名，与 W1 网关参数化正交；既有「错误类码渲染三要素」golden（含网关名
// 遗留缺省，error-codes.test.ts:41）归 W1 负责，本 describe 不涉及。
describe('W2 表征 golden：两条目镜像层退役后的渲染文本（W2-B 翻转留痕）', () => {
  it('PLAN_CALL_ARGS_NOT_ARRAY 退役后渲染逐字（correctForm 只教结构，零业务命令示例）', () => {
    expect(messageFor('PLAN_CALL_ARGS_NOT_ARRAY', 0)).toBe(
      'PLAN_CALL_ARGS_NOT_ARRAY: 期望 args 是数组；实际 0；正确形态 args 为字符串数组，即命令行原样参数',
    );
  });

  it('ENTITY_OUT_OF_SCOPE 退役后渲染逐字（correctForm 零平台 operation 名，正路径逐字保留）', () => {
    expect(messageFor('ENTITY_OUT_OF_SCOPE', '某个越权参数')).toBe(
      'ENTITY_OUT_OF_SCOPE: 期望 计划的每个参数都能在当前请求、检索证据、平台响应或本会话已确立实体里逐字找到；实际 某个越权参数；正确形态 严格按本轮请求的范围执行，或向用户澄清——不把计划外实体塞进 calls；可先执行一次名称检索使名称进入平台响应后再提交查询；用户在本会话早前提供或确认过的实体同样有效',
    );
  });
});

// ── 宿主教学三把全表锁（W2 镜像层退役的结构-only 机械守卫，2026-11-05）────────
//
// 统一口径（三把锁同）：中性哑值（'占位'）按 fail-loud 报文里的占位符名单机械填充、
// 只扫宿主静态模板、不扫平台下发数据——D-102：{operations}/{hint}/correctForm 是
// 平台数据，合法含 operation 名；哑值填充后这些槽位不再是噪声源。
//   锁① 全表渲染文本零平台 operation 名（判据机械取自 PLATFORM_OPERATIONS 注册名+裸名，
//        无第二份手抄名单）；
//   锁② PLAN_CALL_ARGS_NOT_ARRAY 渲染文本零命令旗标示例（'--'；--file/--json 是协议
//        旗标不在本锁范围，本锁只盯 args 教学槽）；
//   锁③ 全表渲染文本零业务词（『目录』按 leak-lint 警职执法登记排除——与 leak-lint
//        双保险不互相替代，leak-lint 仍是 src 业务词的权威，两者红都按 F5 归因）。
describe('宿主教学三把全表锁（结构-only，哑值填充）', () => {
  const DUMMY = '占位';
  /** 中性哑网关：W1 C7b 起 resolveGatewayText 对未注入 fail-closed（不再回退遗留缺省），全表渲染必须显式注入。 */
  const DUMMY_GATEWAY = 'bin/example';
  /** 全表渲染文本：错误类走三要素缺省渲染；参数化模板按 fail-loud 报文的占位符名单哑值填充。 */
  function renderedTextOf(code: string): string {
    try {
      return messageFor(code, undefined, undefined, DUMMY_GATEWAY);
    } catch (error) {
      const names = /（占位符：([^）]+)）/.exec((error as Error).message);
      if (!names) throw error;
      return messageTextFor(code, Object.fromEntries(names[1]!.split(' / ').map((n) => [n, DUMMY])));
    }
  }

  it('锁①：全表渲染文本零平台 operation 名（注册名+裸名，判据机械取自 PLATFORM_OPERATIONS）', () => {
    const names = Object.values(PLATFORM_OPERATIONS).flatMap((n) => [n, n.slice(n.indexOf('.') + 1)]);
    for (const code of HOST_ERROR_CODE_NAMES) {
      for (const name of names) {
        expect(renderedTextOf(code), `${code} 含平台 operation 名 ${name}`).not.toContain(name);
      }
    }
  });

  it('锁②：PLAN_CALL_ARGS_NOT_ARRAY 渲染文本零命令旗标示例（业务命令语法出宿主）', () => {
    expect(messageFor('PLAN_CALL_ARGS_NOT_ARRAY', 0)).not.toContain('--');
  });

  it('锁③：全表渲染文本零业务词（『目录』按 leak-lint 警职执法登记排除，双保险不互相替代）', () => {
    const BUSINESS_WORDS = /应收|凭证|科目|账套|期间|税号|财务|借贷|余额|往来|时间范围|记录|档案|摸底/;
    for (const code of HOST_ERROR_CODE_NAMES) {
      expect(renderedTextOf(code), code).not.toMatch(BUSINESS_WORDS);
    }
  });
});
