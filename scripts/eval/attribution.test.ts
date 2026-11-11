/**
 * T9 归因不串判据的单测（架构调整相位 1）。
 *
 * 判据本体在 attribution.ts：回复里的实体/期间 vs 审计里真实调用记录，逐条对。
 * 本文件把**今天实测的失败形态**钉成表征锁：
 *   · T3r 串轮——把两次不同对象/期间的查询混成「刚才两次查询」；
 *   · 答错对象——问「刚才查的是哪个」答成更早那次；
 *   · 无据归因——点了本会话没有真实调用的对象（编造/旧记忆）；
 *   · 证据不足——审计里真实调用 <2 条时不得靠单条或零条判过。
 * 反例必须判红、正例必须判绿：任何一侧漂移这文件就红。
 */
import { describe, expect, it } from 'vitest';
import { attributionViolations, realQueryCalls, type AttributionAuditRow, type AttributionTurn } from './attribution';
import { MOCK_ACCOUNTS } from './dummy-fixture';

/** 一次真实完成的查询审计行（dummy 夹具形状：script=dummy.query + args 带 collection/window）。 */
function queryRow(collection: string, window: string): AttributionAuditRow {
  return {
    mode: 'query',
    script: 'dummy.query',
    exitCode: 0,
    args: ['--collection', collection, '--window', window],
    result: { status: 'completed', collection },
  };
}

/** 被拒行：调到了门但没执行——不得当真实调用（issue #10 口径）。 */
function refusedRow(collection: string, window: string): AttributionAuditRow {
  return { mode: 'query', script: '--collection', args: ['--collection', collection, '--window', window], refused: 'unregistered' };
}

/** 三回合夹具：alpha W1 → contoso-trade W2 → 归因问句；末轮回复按用例给。 */
function turnsWith(reply: string): AttributionTurn[] {
  return [
    { reply: 'alpha collection W1 查到 rec-001 1200 / rec-002 800。', execution: [refusedRow('alpha', 'W1'), queryRow('alpha', 'W1')] },
    { reply: 'contoso-trade collection W2 查到 rec-401 600。', execution: [queryRow('contoso-trade', 'W2')] },
    { reply, execution: [] },
  ];
}

const KNOWN = MOCK_ACCOUNTS;

describe('T9 归因不串判据', () => {
  it('真实调用取数：只有已执行（无 refused）的行计入，被拒行不算', () => {
    const calls = realQueryCalls(turnsWith(''));
    expect(calls).toEqual([
      { entity: 'alpha', period: 'W1' },
      { entity: 'contoso-trade', period: 'W2' },
    ]);
  });

  it('答对最近一次（含对照说明）→ 零违例', () => {
    const violations = attributionViolations({
      turns: turnsWith('刚才查的是 contoso-trade collection 的 W2（更早一次是 alpha 的 W1）。'),
      knownEntities: KNOWN,
    });
    expect(violations).toEqual([]);
  });

  it('只答对象不答期间 → 判红（问题问的是哪一次，期间是回答的一半）', () => {
    const violations = attributionViolations({
      turns: turnsWith('刚才查的是 contoso-trade collection。'),
      knownEntities: KNOWN,
    });
    expect(violations.join('\n')).toMatch(/W2/u);
  });

  it('T3r 串轮：把两次调用并列成「刚才两次查询」且先点名更早的对象 → 判红', () => {
    const violations = attributionViolations({
      turns: turnsWith('刚才两次查询：alpha collection 的 W1（1200/800）和 contoso-trade collection 的 W2（600）。'),
      knownEntities: KNOWN,
    });
    expect(violations.join('\n')).toMatch(/串/u);
    expect(violations.join('\n')).toMatch(/alpha/u);
  });

  it('答成更早那次（alpha W1）→ 判红', () => {
    const violations = attributionViolations({
      turns: turnsWith('刚才查的是 alpha collection 的 W1，共 2 条记录。'),
      knownEntities: KNOWN,
    });
    expect(violations.join('\n')).toMatch(/contoso-trade/u);
  });

  it('无据归因：点名本会话没查过的对象 → 判红', () => {
    const violations = attributionViolations({
      turns: turnsWith('刚才查的是 fabrikam-retail collection 的 W2，值是 880。'),
      knownEntities: KNOWN,
    });
    expect(violations.join('\n')).toMatch(/fabrikam-retail/u);
  });

  it('真实调用不足 2 条 → 判红（不拿单条/零条冒充判定依据）', () => {
    const violations = attributionViolations({
      turns: [
        { reply: '查到了。', execution: [queryRow('alpha', 'W1')] },
        { reply: '刚才查的是 alpha 的 W1。', execution: [] },
      ],
      knownEntities: KNOWN,
    });
    expect(violations.join('\n')).toMatch(/证据不足|真实调用/u);
  });
});
