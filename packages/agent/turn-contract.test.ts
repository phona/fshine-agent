import { describe, expect, it } from 'vitest';
import { parseTurnDeclaration, validatePlanEntities, validateTurnDeclarationEvidence, type TurnDeclaration } from './src/turn-contract';

describe('semantic task intent router', () => {
  it('treats a repeated live-data request as fresh and asks for a missing account', () => {
    const current = '帮我查一下猫一杯的应收账款还有多少';
    const oldMessages = [
      { role: 'assistant', content: '旧回答：请确认继续查询幻东和幻辰九个月的凭证。', timestamp: 1 },
      { role: 'user', content: current, timestamp: 2 },
    ] as never[];
    const intent = parseTurnDeclaration(JSON.stringify({ kind: 'platform_query', taskType: 'balance', accountResolution: 'missing', accountQueries: [], question: '要查哪个账套？' }));
    expect(intent).not.toBeNull();
    expect(validateTurnDeclarationEvidence(intent!, current, oldMessages)).toEqual({ kind: 'clarify', question: '要查哪个账套？' });
  });

  it('accepts a uniquely identified account from a clear current reference', () => {
    const current = '用刚才那个账套，查猫一杯的应收';
    const intent = parseTurnDeclaration(JSON.stringify({ kind: 'platform_query', taskType: 'balance', accountResolution: 'referenced', accountQueries: ['幻辰财税'], referenceQuote: '刚才那个账套' }));
    expect(intent).not.toBeNull();
    expect(validateTurnDeclarationEvidence(intent!, current, [
      { role: 'user', content: '查一下幻辰财税的应收', timestamp: 1 },
      { role: 'assistant', content: '刚才查的是幻辰财税账套。', timestamp: 2 },
      { role: 'user', content: current, timestamp: 3 },
    ] as never[]))
      .toMatchObject({ kind: 'platform_query', taskType: 'balance', accountResolution: 'referenced', accountQueries: ['幻辰财税'] });
  });

  it('指代校验只看上一轮，不把当前消息算进去', () => {
    const current = '这个账套的凭证有多少张？';
    const history = [
      { role: 'user', content: '查一下幻辰财税的应收', timestamp: 1 },
      { role: 'assistant', content: '幻辰财税 202609 应收余额 86,000 元。', timestamp: 2 },
      { role: 'user', content: current, timestamp: 3 },
    ] as never[];
    // 上一轮只有幻辰财税；申报一个只在更早上下文出现过的账套 → 拒绝
    expect(validateTurnDeclarationEvidence(
      { kind: 'platform_query', taskType: 'voucher', accountResolution: 'referenced', accountQueries: ['新兴五金'], referenceQuote: '这个账套' },
      current, history,
    )).toMatchObject({ kind: 'clarify' });
    expect(validateTurnDeclarationEvidence(
      { kind: 'platform_query', taskType: 'voucher', accountResolution: 'referenced', accountQueries: ['幻辰财税'], referenceQuote: '这个账套' },
      current, history,
    )).toMatchObject({ kind: 'platform_query' });
  });

  it('指代只绑定紧邻的那一轮，不拿上下文里顺带提过的账套顶替', () => {
    const current = '这个账套 202609 的凭证有多少张？';
    const history = [
      { role: 'user', content: '刚才查的是哪个账套？', timestamp: 1 },
      { role: 'assistant', content: '刚才上下文里提到的是「新兴建材」这个账套。', timestamp: 2 },
      { role: 'user', content: '帮我查一下幻辰财税的应收账款', timestamp: 3 },
      { role: 'assistant', content: '幻辰财税 202609 应收余额为 86,000 元。', timestamp: 4 },
    ] as never[];
    // 上一轮是幻辰财税：解析成它 → 放行
    expect(validateTurnDeclarationEvidence(
      { kind: 'platform_query', taskType: 'voucher', accountResolution: 'referenced', accountQueries: ['幻辰财税'], referenceQuote: '这个账套' },
      current, history,
    )).toMatchObject({ kind: 'platform_query' });
    // 解析成更早提过的新兴建材 → 拒绝（这正是实测中的漂移）
    expect(validateTurnDeclarationEvidence(
      { kind: 'platform_query', taskType: 'voucher', accountResolution: 'referenced', accountQueries: ['新兴建材'], referenceQuote: '这个账套' },
      current, history,
    )).toMatchObject({ kind: 'clarify' });
  });

  it('rejects a referenced account that cannot be evidenced in context', () => {
    const current = '用刚才那个账套，查猫一杯的应收';
    const intent = parseTurnDeclaration(JSON.stringify({ kind: 'platform_query', taskType: 'balance', accountResolution: 'referenced', accountQueries: ['幻东公司'], referenceQuote: '刚才那个账套' }));
    expect(intent).not.toBeNull();
    expect(validateTurnDeclarationEvidence(intent!, current, [{ role: 'assistant', content: '刚才提到幻辰财税。', timestamp: 1 }, { role: 'user', content: current, timestamp: 2 }] as never[]))
      .toMatchObject({ kind: 'clarify' });
  });

  it('requires the account-search keyword to come from the current request', () => {
    const intent = parseTurnDeclaration(JSON.stringify({ kind: 'platform_query', taskType: 'account_search', searchQuery: '胜利' } satisfies TurnDeclaration));
    expect(intent).not.toBeNull();
    expect(validateTurnDeclarationEvidence(intent!, '只查有没有这个账套', [{ role: 'user', content: '只查有没有这个账套', timestamp: 1 }] as never[]))
      .toMatchObject({ kind: 'clarify' });
  });

  it('fails closed when the Main Agent does not return the intent contract', () => {
    expect(parseTurnDeclaration('我觉得上次的结果可以沿用。')).toBeNull();
  });

  it('计划实体来源校验：实体逐字来自当前消息即放行', () => {
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
    // referenced 申报把上一轮的名称解析出来，计划按它查——证据是三个合法来源之一。
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

  it('taskType 不再影响计划校验：操作与任务类型的匹配归执行层 SKILL 与平台门禁', () => {
    // Phase 3 起宿主不再做领域判别：同样的 calls 与来源，四种 taskType 判定一致。
    const calls = [
      { operation: 'voucher.query-saved', args: ['幻辰财税', '202608'] },
      { operation: 'finance.search-account-sets', args: ['--query', '幻辰财税'] },
    ];
    for (const taskType of ['account_search', 'balance', 'voucher', 'other'] as const) {
      expect(validatePlanEntities(calls, { currentMessage: '查一下幻辰财税 202608' })).toBeNull();
    }
    // account_search 也不再被强制"只能一次 search 调用"
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
