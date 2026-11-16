/**
 * SimCase schema 与动作协议的机制单测（确定性、零模型）。
 */
import { describe, expect, it } from 'vitest';
import {
  SIM_DEFAULT_CONCURRENCY, expandSimTrials, parseSimAction, validateSimCase,
  type SimCase,
} from './case';

function baseCase(overrides: Partial<SimCase> = {}): SimCase {
  return {
    id: 'C-01',
    goal: '核对 alpha 集合的合计',
    persona: '谨慎的业务员',
    knowledge: ['alpha 集合我有权限'],
    initialMessage: '帮我看一下 alpha 的合计',
    behaviorRules: ['一次只问一件事'],
    forbiddenKnowledge: ['zhongwen-secret'],
    allowedActions: ['say', 'wait', 'finish'],
    terminal: { satisfied: '拿到合计', gaveUp: '系统一直答非所问' },
    fixtureId: 'dummy-alpha',
    oracleId: 'fact:alpha:sum',
    limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 60_000, trials: 2 },
    ...overrides,
  };
}

describe('SimCase schema', () => {
  it('接受合法用例', () => {
    expect(validateSimCase(baseCase())).toEqual({ ok: true, errors: [] });
  });

  it('拒绝空 allowedActions / 未知动作 / 重复动作', () => {
    const empty = validateSimCase(baseCase({ allowedActions: [] }));
    expect(empty.ok).toBe(false);
    expect(empty.errors.join('\n')).toContain('allowedActions 不能为空');

    const unknown = validateSimCase(baseCase({ allowedActions: ['say', 'nope' as never] }));
    expect(unknown.ok).toBe(false);
    expect(unknown.errors.join('\n')).toContain('未知动作');

    const dup = validateSimCase(baseCase({ allowedActions: ['say', 'say'] }));
    expect(dup.ok).toBe(false);
    expect(dup.errors.join('\n')).toContain('重复');
  });

  it('拒绝非法预算与锚点', () => {
    const bad = validateSimCase(baseCase({
      limits: { maxUserTurns: 0, maxWaitTurns: -1, maxWallMs: 0, trials: 0 },
      injection: { anchor: 'systemTurn', at: 0, kind: '' },
    }));
    expect(bad.ok).toBe(false);
    const text = bad.errors.join('\n');
    expect(text).toContain('maxUserTurns');
    expect(text).toContain('maxWaitTurns');
    expect(text).toContain('maxWallMs');
    expect(text).toContain('trials');
    expect(text).toContain('injection.at');
    expect(text).toContain('injection.kind');
  });

  it('maxUserTurns=1 时必须允许 finish（否则永远无法收尾）', () => {
    const result = validateSimCase(baseCase({
      allowedActions: ['say'],
      limits: { maxUserTurns: 1, maxWaitTurns: 0, maxWallMs: 1000, trials: 1 },
    }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('必须包含 finish');
  });

  it('fixtureId / oracleId 是必填（只给 Harness）', () => {
    expect(validateSimCase(baseCase({ fixtureId: '' })).ok).toBe(false);
    expect(validateSimCase(baseCase({ oracleId: '  ' })).ok).toBe(false);
  });
});

describe('动作协议 parseSimAction', () => {
  const all = ['say', 'wait', 'finish'] as const;

  it('解析 say / wait / finish', () => {
    expect(parseSimAction('{"action":"say","text":"再查一次"}', all)).toEqual({ ok: true, action: { kind: 'say', text: '再查一次' } });
    expect(parseSimAction('{"action":"wait","reason":"等系统跑"}', all)).toEqual({ ok: true, action: { kind: 'wait', reason: '等系统跑' } });
    expect(parseSimAction('{"action":"finish","finishKind":"gave_up","reason":"反复答错"}', all)).toEqual({
      ok: true, action: { kind: 'finish', finishKind: 'gave_up', reason: '反复答错' },
    });
  });

  it('容忍 markdown 代码围栏与前后废话，畸形 JSON 记协议错误', () => {
    const raw = '好的，我这样回复：\n```json\n{"action":"say","text":"麻烦核对"}\n```\n';
    expect(parseSimAction(raw, all)).toEqual({ ok: true, action: { kind: 'say', text: '麻烦核对' } });
    expect(parseSimAction('说明\n{"action":"say","text":"麻烦核对"}\n结束', all)).toEqual({
      ok: true, action: { kind: 'say', text: '麻烦核对' },
    });
    const malformed = parseSimAction('```json\n{"action":"say","text":}\n```', all);
    expect(malformed.ok).toBe(false);
  });

  it('拒绝越权动作与非空字段缺失', () => {
    const noWait = parseSimAction('{"action":"wait","reason":"等"}', ['say', 'finish']);
    expect(noWait).toEqual({ ok: false, error: '动作 wait 不在 allowedActions 内' });
    expect(parseSimAction('{"action":"say","text":""}', all).ok).toBe(false);
    expect(parseSimAction('{"action":"finish","finishKind":"done","reason":"x"}', all).ok).toBe(false);
    expect(parseSimAction('{"action":"say"}', all).ok).toBe(false);
    expect(parseSimAction('没有 JSON', all).ok).toBe(false);
  });
});

describe('并发池展开', () => {
  it('case × trials 展开且 id 唯一', () => {
    const items = expandSimTrials([
      baseCase(),
      baseCase({ id: 'C-02', limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 1000, trials: 1 } }),
    ]);
    expect(items.map((item) => item.id)).toEqual(['C-01#1', 'C-01#2', 'C-02#1']);
  });

  it('重复 id 直接拒绝', () => {
    expect(() => expandSimTrials([baseCase(), baseCase()])).toThrow(/重复的 trial id/);
  });

  it('并发度缺省 = 5（预注册冻结值）', () => {
    expect(SIM_DEFAULT_CONCURRENCY).toBe(5);
  });
});
