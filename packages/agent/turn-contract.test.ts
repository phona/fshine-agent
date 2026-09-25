import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROUTE_CURRENT_TURN_TOOL,
  isSelfContradictoryDeclaration,
  parseTurnDeclaration,
  reviewRouteDeclaration,
  validatePlanEntities,
} from './src/turn-contract';

/** 申报契约（架构 §4）：三个字段，零业务知识。 */
describe('申报契约：route_current_turn 三字段', () => {
  it('解析 conversation 申报', () => {
    expect(parseTurnDeclaration(JSON.stringify({ kind: 'conversation' }))).toEqual({ kind: 'conversation' });
  });

  it('解析 delegate 申报：request 必填，continueTaskId 可选', () => {
    expect(parseTurnDeclaration(JSON.stringify({ kind: 'delegate', request: '查询新兴五金账套 202608 的应收余额' })))
      .toEqual({ kind: 'delegate', request: '查询新兴五金账套 202608 的应收余额' });
    expect(parseTurnDeclaration(JSON.stringify({ kind: 'delegate', request: '继续上一个任务', continueTaskId: 'task_1' })))
      .toEqual({ kind: 'delegate', request: '继续上一个任务', continueTaskId: 'task_1' });
    // continueTaskId 首尾空白去掉；空串视为没填
    expect(parseTurnDeclaration(JSON.stringify({ kind: 'delegate', request: '继续', continueTaskId: ' task_1 ' })))
      .toEqual({ kind: 'delegate', request: '继续', continueTaskId: 'task_1' });
    expect(parseTurnDeclaration(JSON.stringify({ kind: 'delegate', request: '继续', continueTaskId: '   ' }))).toBeNull();
  });

  it('delegate 缺 request、request 为空或非字符串时解析失败', () => {
    expect(parseTurnDeclaration(JSON.stringify({ kind: 'delegate' }))).toBeNull();
    expect(parseTurnDeclaration(JSON.stringify({ kind: 'delegate', request: '' }))).toBeNull();
    expect(parseTurnDeclaration(JSON.stringify({ kind: 'delegate', request: '   ' }))).toBeNull();
    expect(parseTurnDeclaration(JSON.stringify({ kind: 'delegate', request: 42 }))).toBeNull();
  });

  it('kind 缺失或不在枚举内时解析失败（clarify 种类已取消）', () => {
    expect(parseTurnDeclaration(JSON.stringify({}))).toBeNull();
    expect(parseTurnDeclaration(JSON.stringify({ kind: 'typo', request: '查询' }))).toBeNull();
    // 取消的 kind：需要澄清/说明能力边界时申报 conversation，模型文本即回复
    expect(parseTurnDeclaration(JSON.stringify({ kind: 'clarify', question: '要查哪个账套？' }))).toBeNull();
    expect(parseTurnDeclaration(JSON.stringify({ kind: 'conversation', question: '要查哪个账套？' }))).toBeNull();
  });

  it('conversation 申报多一个字段就拒收：这一枝只有 kind', () => {
    // 旧契约的业务字段与任何未知键都意味着"另一份契约"（schema additionalProperties:false 同语义）
    for (const extra of ['question', 'periods', 'taskId', 'accountSet'] as const) {
      expect(parseTurnDeclaration(JSON.stringify({ kind: 'conversation', [extra]: 'x' }))).toBeNull();
    }
  });

  it('delegate 申报只认三个字段，未知字段被归一掉', () => {
    // 宿主只据 kind/request/continueTaskId 行动：未知键没有语义，归一后丢弃，
    // 不会变成委派参数或范围依据（范围守卫在计划层 validatePlanEntities）。
    expect(parseTurnDeclaration(JSON.stringify({
      kind: 'delegate', request: '查询新兴五金账套的应收余额', question: '要查哪个账套？', periods: [{ value: '202608', quote: '202608' }],
    }))).toEqual({ kind: 'delegate', request: '查询新兴五金账套的应收余额' });
    expect(reviewRouteDeclaration({ kind: 'delegate', request: '查询新兴五金账套的应收余额', taskId: 'task_1' }))
      .toEqual({ intent: { kind: 'delegate', request: '查询新兴五金账套的应收余额' } });
  });

  it('非 JSON、非对象、数组都解析失败', () => {
    expect(parseTurnDeclaration('我觉得可以直接回答。')).toBeNull();
    expect(parseTurnDeclaration('```json\n{"kind":"conversation"}\n```')).toEqual({ kind: 'conversation' });
    expect(parseTurnDeclaration('[{"kind":"conversation"}]')).toBeNull();
    expect(parseTurnDeclaration('null')).toBeNull();
    expect(parseTurnDeclaration('"conversation"')).toBeNull();
  });

  it('自相矛盾申报只有一种：delegate 的 request 为空', () => {
    // 契约瘦身后唯一的结构性矛盾：声称委派却不给加工后的请求
    expect(isSelfContradictoryDeclaration({ kind: 'delegate', request: '' })).toContain('request');
    expect(isSelfContradictoryDeclaration({ kind: 'delegate', request: '   ' })).toContain('request');
    expect(isSelfContradictoryDeclaration({ kind: 'delegate', request: '查询新兴五金账套的应收余额' })).toBeNull();
    // conversation 申报没有可矛盾的字段
    expect(isSelfContradictoryDeclaration({ kind: 'conversation' })).toBeNull();
  });

  it('reviewRouteDeclaration：合法申报直接放行，结构错误原样退回', () => {
    expect(reviewRouteDeclaration({ kind: 'conversation' })).toEqual({ intent: { kind: 'conversation' } });
    expect(reviewRouteDeclaration({ kind: 'delegate', request: '查询新兴五金账套 202608 的应收余额' }))
      .toEqual({ intent: { kind: 'delegate', request: '查询新兴五金账套 202608 的应收余额' } });

    // 单参数入口：宿主只做结构校验，不再拿申报字段与当前消息做证据比对
    for (const bad of [
      { kind: 'delegate' },
      { kind: 'delegate', request: '  ' },
      {},
      { kind: 'delegate', request: '查询', continueTaskId: '' },
    ]) {
      const reviewed = reviewRouteDeclaration(bad);
      expect('error' in reviewed).toBe(true);
      if ('error' in reviewed) expect(reviewed.error.length).toBeGreaterThan(0);
    }
  });

  it('工具 schema 恰好三个属性：kind / request / continueTaskId', () => {
    const schema = ROUTE_CURRENT_TURN_TOOL.inputSchema;
    const properties = schema.properties as Record<string, { enum?: string[] }>;
    expect(Object.keys(properties).sort()).toEqual(['continueTaskId', 'kind', 'request']);
    expect(Object.keys(properties)).toHaveLength(3);
    expect(properties['kind']?.enum).toEqual(['conversation', 'delegate']);
    // 入口就挡掉多余字段；parse 那一侧的归一只是兜底
    expect(schema.additionalProperties).toBe(false);
    expect(ROUTE_CURRENT_TURN_TOOL.name).toBe('route_current_turn');
  });

  it('工具描述含计划模式协议，且多步拆解不加 schema 字段（仍 3 个）', () => {
    // roadmap Phase 6：长任务拆解靠 request 里的「第N/M步：」前缀，契约一动不动
    const description = ROUTE_CURRENT_TURN_TOOL.description;
    expect(description).toContain('第N/M步：');
    expect(description).toContain('计划模式');
    // 无前缀 = 单步行为不变；有前缀 = 交还模型继续下一步；汇总用 conversation
    expect(description).toContain('无前缀的 delegate 就是单步');
    expect(description).toContain('交还给你');
    expect(description).toContain('申报 conversation 输出汇总');
    // 步骤 2..M 用 continueTaskId 在同一子任务内续跑；任一步失败不阻塞
    expect(description).toContain('continueTaskId');
    expect(description).toContain('不阻塞');
    expect(description).toContain('如实报告');
    // 字段数没变：多步协议全部写在 request 与描述里
    const properties = ROUTE_CURRENT_TURN_TOOL.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toHaveLength(3);
    expect(Object.keys(properties).sort()).toEqual(['continueTaskId', 'kind', 'request']);
  });

  it('工具描述与契约源码全文无业务词（编排层零业务知识）', () => {
    const business = /应收|凭证|科目|账套|期间/u;
    expect(ROUTE_CURRENT_TURN_TOOL.description).not.toMatch(business);
    const source = readFileSync(path.resolve(__dirname, 'src', 'turn-contract.ts'), 'utf8');
    expect(source).not.toMatch(business);
  });

  it('request 的加工在模型侧：宿主持有的确定性部分只是"必须非空"', () => {
    // 加工（指代消解成实体、续跑补任务 id、保留时间范围与筛选）全是模型侧的事，
    // 契约核心没有对应的可测纯函数；宿主能确定性保证的只有"delegate 必须给出 request"，
    // 以及"request 原样透传给子 Agent"（后者见 runtime.test.ts 的委派参数断言）。
    expect(parseTurnDeclaration(JSON.stringify({ kind: 'delegate' }))).toBeNull();
    expect(isSelfContradictoryDeclaration({ kind: 'delegate', request: '' })).toContain('request');
  });
});

/**
 * 计划实体来源校验（架构 §2 第 9 条，领域无关）：Phase 3 落地，与申报契约瘦身无关，
 * 契约字段消失后它靠宿主持有的三个来源独立存活。原申报层证据校验（C1/C2）已整体取消，
 * 实体范围守卫完全由这一层承担。
 */
describe('计划实体来源校验：三来源逐字包含', () => {
  it('实体逐字来自当前消息即放行', () => {
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202608'] }],
      { currentMessage: '查一下幻辰财税账套 202608 的应收' },
    )).toBeNull();
  });

  it('以 - 开头的是 flag 不是实体，跳过；非字符串参数不参与判定', () => {
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--customer'] }],
      { currentMessage: '查一下幻辰财税账套' },
    )).toBeNull();
    expect(validatePlanEntities(
      [{ operation: 'any.operation', args: [10, true, null, { nested: 'object' }] }],
      { currentMessage: '查一下' },
    )).toBeNull();
  });

  it('检索证据里的实体放行（指代消解的产物就是合法实体）', () => {
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻东'] }],
      {
        currentMessage: '这个账套 202608 呢？',
        referenceEvidence: '【宿主主动回溯】tool_result：幻东 202609 余额 51 元',
      },
    )).toBeNull();
  });

  it('search→query：候选名逐字来自本轮平台响应时放行', () => {
    // roadmap 点名场景：执行层先目录查询拿到唯一候选、再用候选名查。候选名不在用户
    // 消息里，但逐字来自本轮平台响应——宿主不懂业务也必须放行。
    const searchCall = { operation: 'finance.search-account-sets', args: ['--query', '胜利'] };
    expect(validatePlanEntities([searchCall], { currentMessage: '只查有没有胜利这个帐套' })).toBeNull();
    const candidateResponse = 'RESULT {"op":"finance.search-account-sets","status":"completed","data":{"accountSets":[{"id":"as_1","name":"胜利五金有限责任公司"}]}}';
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '胜利五金有限责任公司'] }],
      { currentMessage: '只查有没有胜利这个帐套', platformResponses: [candidateResponse] },
    )).toBeNull();
    // 换一个响应里没有的写法照样拒——只有逐字来自响应才放行
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '胜利五金集团'] }],
      { currentMessage: '只查有没有胜利这个帐套', platformResponses: [candidateResponse] },
    )).toContain('未在当前请求、检索证据或平台响应中出现的参数');
  });

  it('越权实体（三个来源里都没有）被拒，错误消息领域无关', () => {
    const error = validatePlanEntities(
      [
        { operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--customer', '猫一杯'] },
        { operation: 'finance.query-receivables', args: ['--query', '新兴五金'] },
      ],
      { currentMessage: '查一下幻辰财税账套的应收' },
    );
    expect(error).toContain('猫一杯');
    expect(error).toContain('未在当前请求、检索证据或平台响应中出现的参数');
    // 报第一个越权值即可：worker 修正后重新提交完整 calls，逐次暴露
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] },
        { operation: 'finance.query-receivables', args: ['--query', '新兴五金'] }],
      { currentMessage: '查一下幻辰财税账套的应收' },
    )).toContain('新兴五金');
  });

  it('来源并集为空时 fail-closed：任何实体都不放行', () => {
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }],
      { currentMessage: '' },
    )).toContain('未在当前请求、检索证据或平台响应中出现的参数');
  });

  it('计划校验只看实体来源，与申报契约的字段无关', () => {
    // 契约瘦身后宿主不再从申报字段推导任何范围：同样的 calls 与来源，判定只由三个来源决定。
    const calls = [
      { operation: 'voucher.query-saved', args: ['幻辰财税', '202608'] },
      { operation: 'finance.search-account-sets', args: ['--query', '幻辰财税'] },
    ];
    expect(validatePlanEntities(calls, { currentMessage: '查一下幻辰财税 202608' })).toBeNull();
    // 目录查询与后续查询混排也不再被强制"只能一次 search 调用"
    expect(validatePlanEntities(
      [
        { operation: 'finance.search-account-sets', args: ['--query', '幻辰财税'] },
        { operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] },
      ],
      { currentMessage: '查一下幻辰财税账套' },
    )).toBeNull();
  });

  it('多个平台响应全部纳入来源，最近的响应也能放行新候选', () => {
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻东'] }],
      {
        currentMessage: '这个呢？',
        platformResponses: ['更早的响应：提到了新兴五金', '更近的响应：幻东 202609 余额 51 元'],
      },
    )).toBeNull();
  });
});
