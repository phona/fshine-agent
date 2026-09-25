import { describe, expect, it } from 'vitest';
import { parseTaskIntent, validatePlanAgainstTaskIntent, validateTaskIntentEvidence, type TaskIntent } from './src/task-intent';

describe('semantic task intent router', () => {
  it('treats a repeated live-data request as fresh and asks for a missing account', () => {
    const current = '帮我查一下猫一杯的应收账款还有多少';
    const oldMessages = [
      { role: 'assistant', content: '旧回答：请确认继续查询幻东和幻辰九个月的凭证。', timestamp: 1 },
      { role: 'user', content: current, timestamp: 2 },
    ] as never[];
    const intent = parseTaskIntent(JSON.stringify({ kind: 'platform_query', taskType: 'balance', accountResolution: 'missing', accountQueries: [], question: '要查哪个账套？' }));
    expect(intent).not.toBeNull();
    expect(validateTaskIntentEvidence(intent!, current, oldMessages)).toEqual({ kind: 'clarify', question: '要查哪个账套？' });
  });

  it('accepts a uniquely identified account from a clear current reference', () => {
    const current = '用刚才那个账套，查猫一杯的应收';
    const intent = parseTaskIntent(JSON.stringify({ kind: 'platform_query', taskType: 'balance', accountResolution: 'referenced', accountQueries: ['幻辰财税'], referenceQuote: '刚才那个账套' }));
    expect(intent).not.toBeNull();
    expect(validateTaskIntentEvidence(intent!, current, [{ role: 'assistant', content: '刚才查的是幻辰财税账套。', timestamp: 1 }, { role: 'user', content: current, timestamp: 2 }] as never[]))
      .toMatchObject({ kind: 'platform_query', taskType: 'balance', accountResolution: 'referenced', accountQueries: ['幻辰财税'] });
  });

  it('rejects a referenced account that cannot be evidenced in context', () => {
    const current = '用刚才那个账套，查猫一杯的应收';
    const intent = parseTaskIntent(JSON.stringify({ kind: 'platform_query', taskType: 'balance', accountResolution: 'referenced', accountQueries: ['幻东公司'], referenceQuote: '刚才那个账套' }));
    expect(intent).not.toBeNull();
    expect(validateTaskIntentEvidence(intent!, current, [{ role: 'assistant', content: '刚才提到幻辰财税。', timestamp: 1 }, { role: 'user', content: current, timestamp: 2 }] as never[]))
      .toMatchObject({ kind: 'clarify' });
  });

  it('requires the account-search keyword to come from the current request', () => {
    const intent = parseTaskIntent(JSON.stringify({ kind: 'platform_query', taskType: 'account_search', searchQuery: '胜利' } satisfies TaskIntent));
    expect(intent).not.toBeNull();
    expect(validateTaskIntentEvidence(intent!, '只查有没有这个账套', [{ role: 'user', content: '只查有没有这个账套', timestamp: 1 }] as never[]))
      .toMatchObject({ kind: 'clarify' });
  });

  it('fails closed when the Main Agent does not return the intent contract', () => {
    expect(parseTaskIntent('我觉得上次的结果可以沿用。')).toBeNull();
  });

  it('账套名按包含判定：用户口癖与平台规范名的词缀差异不阻断执行', () => {
    // 真实复现：用户说"幻辰财税账套"，平台账套名是"幻辰财税"。
    // 全等比对会把 PLAN DECLINED 拒死，导致最常见的查询形态完全跑不通。
    const intent: TaskIntent = {
      kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit',
      accountQueries: ['幻辰财税账套'],
    };
    expect(validatePlanAgainstTaskIntent(intent, [
      { operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] },
    ])).toBeNull();
    // 反向：申报规范名、worker 用简称也同样放行
    expect(validatePlanAgainstTaskIntent(
      { kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'] },
      [{ operation: 'finance.query-receivables', args: ['--query', '幻辰'] }],
    )).toBeNull();
    // 但仍然挡得住真正无关的账套
    expect(validatePlanAgainstTaskIntent(intent, [
      { operation: 'finance.query-receivables', args: ['--query', '幻东'] },
    ])).toContain('账套');
  });

  it('夹带申报范围外的账套被逐次包含判定挡下', () => {
    const intent: TaskIntent = {
      kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit',
      accountQueries: ['幻辰财税'], customerQueries: ['猫一杯'], periods: [{ value: '202609', quote: '九月' }],
    };
    // 第二个调用夹带了"新兴五金"——不在申报范围内，逐次校验直接拒
    expect(validatePlanAgainstTaskIntent(intent, [
      { operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--customer', '猫一杯', '--period', '202609'] },
      { operation: 'finance.query-receivables', args: ['--query', '新兴五金', '--customer', '猫一杯', '--period', '202609'] },
    ])).toContain('账套');
  });

  it('申报里混入科目名时不阻断执行（精确基数校验会把它拒死）', () => {
    // 真实模型会把"应收账款"填进 accountQueries；按 账套 × 客户 × 期间 算基数就对不上。
    const intent: TaskIntent = {
      kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit',
      accountQueries: ['幻辰财税', '应收账款'],
    };
    expect(validatePlanAgainstTaskIntent(intent, [
      { operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] },
    ])).toBeNull();
  });

  it('binds a voucher plan to the voucher domain and the periods the request named', () => {
    const intent: TaskIntent = {
      kind: 'platform_query', taskType: 'voucher', accountResolution: 'explicit',
      accountQueries: ['威德盛'], periods: [{ value: '202609', quote: '九月' }],
    };
    expect(validatePlanAgainstTaskIntent(intent, [
      { operation: 'voucher.query-saved', args: ['威德盛', '202609'] },
    ])).toBeNull();
    expect(validatePlanAgainstTaskIntent(intent, [
      { operation: 'finance.query-receivables', args: ['--query', '威德盛'] },
    ])).toContain('voucher 域');
    expect(validatePlanAgainstTaskIntent(intent, [
      { operation: 'voucher.query-saved', args: ['威德盛', '202601'] },
    ])).toContain('期间');
  });

  it('binds a balance plan to the router-approved accounts, customers, and periods', () => {
    const intent: TaskIntent = {
      kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit',
      accountQueries: ['幻辰财税'], customerQueries: ['猫一杯'],
      periods: [{ value: '202609', quote: '2026年9月' }],
    };
    expect(validatePlanAgainstTaskIntent(intent, [
      { operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--customer', '猫一杯', '--period', '202609'] },
    ])).toBeNull();
    expect(validatePlanAgainstTaskIntent(intent, [
      { operation: 'finance.query-receivables', args: ['--query', '幻州幻东制造有限公司', '--customer', '猫一杯', '--period', '202609'] },
    ])).toContain('账套');
    expect(validatePlanAgainstTaskIntent(intent, [
      { operation: 'voucher.query-saved', args: ['幻辰财税', '202601'] },
    ])).toContain('不能代替余额表');
    expect(validatePlanAgainstTaskIntent({ ...intent, periods: [] }, [
      { operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--customer', '猫一杯', '--period', '202601'] },
    ])).toContain('期间');
  });
});
