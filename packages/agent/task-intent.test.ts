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
