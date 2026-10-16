import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { collectWriteChainFacts, hasWriteChainSignal, renderWriteChainLine, CONFIRM_CODE_RE } from './write-chain';

/**
 * 写链三指标的机械提取锁（L7 / D-060）：取数口径钉在宿主契约表的两张最小 DDL 上
 * （tool_calls / change_intents 的相关列），断言与 D-097 关账判据同构——
 * 「承诺了录入」必须伴随 `serve_gate:proposal_create` 行与 committed 意图。
 */

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      tool_name TEXT NOT NULL
    );
    CREATE TABLE change_intents (
      intent_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      result TEXT
    );
  `);
  return db;
}

const BASE = {
  id: '5.1',
  conversationId: 'acc-write-51',
  sessionKey: 'wecom:user-x:acc-write-51',
  requestId: 'req-1' as string | null,
  reply: '',
};

describe('collectWriteChainFacts', () => {
  it('提案尝试按 serve_gate:proposal_create 计数，跨去重后的 request 求和', () => {
    const db = makeDb();
    const insert = db.prepare('INSERT INTO tool_calls (request_id, tool_name) VALUES (?, ?)');
    insert.run('req-1', 'serve_gate:proposal_create');
    insert.run('req-2', 'serve_gate:proposal_create');
    insert.run('req-2', 'serve_gate:proposal_create');
    insert.run('req-2', 'serve_gate:plan_submit'); // 计划门裁决不算提案尝试
    insert.run('req-2', 'bash');
    const facts = collectWriteChainFacts(db, [
      { ...BASE, requestId: 'req-1' },
      { ...BASE, id: '5.2', requestId: 'req-2' },
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.proposalAttempts).toBe(3);
    expect(facts[0]!.cases).toEqual(['5.1', '5.2']);
  });

  it('D-097 反例形状：零尝试/零意图/无确认码 → 三信号全空（报警责任在 acceptance 侧的写意图会话必报）', () => {
    const db = makeDb();
    const facts = collectWriteChainFacts(db, [
      { ...BASE, requestId: 'req-1', reply: '确认后由系统执行录入' },
    ]);
    expect(facts[0]!.proposalAttempts).toBe(0);
    expect(facts[0]!.intents).toEqual([]);
    expect(facts[0]!.confirmCodeOffered).toBe(false);
    expect(hasWriteChainSignal(facts[0]!)).toBe(false);
  });

  it('意图按创建序列出，committed + result 非空即落账+读回', () => {
    const db = makeDb();
    const insert = db.prepare(
      'INSERT INTO change_intents (intent_id, session_id, status, created_at, result) VALUES (?, ?, ?, ?, ?)',
    );
    insert.run('i1', BASE.sessionKey, 'superseded', '2026-10-16T10:00:00Z', null);
    insert.run('i2', BASE.sessionKey, 'committed', '2026-10-16T10:01:00Z', '{"verified":true}');
    insert.run('i3', 'wecom:user-x:other-conv', 'pending', '2026-10-16T10:02:00Z', null); // 别的会话不串
    const facts = collectWriteChainFacts(db, [
      { ...BASE, requestId: null, reply: '提案已创建（prop_x），请回复「确认 4R2V98」以执行录入' },
    ]);
    expect(facts[0]!.intents).toEqual([
      { status: 'superseded', hasResult: false },
      { status: 'committed', hasResult: true },
    ]);
    expect(facts[0]!.confirmCodeOffered).toBe(true);
  });

  it('确认码正则：只认「确认 XXXXXX」的提供形态', () => {
    expect(CONFIRM_CODE_RE.test('请回复「确认 4R2V98」以执行录入')).toBe(true);
    expect(CONFIRM_CODE_RE.test('如需取消，请回复「取消」加确认码')).toBe(false);
    expect(CONFIRM_CODE_RE.test('凭证数 +1，读回通过')).toBe(false);
  });

  it('无信号会话不产报告行；按 sessionKey 分组不互串', () => {
    const db = makeDb();
    const facts = collectWriteChainFacts(db, [
      { ...BASE, id: '3.1', conversationId: 'acc-pro-31', sessionKey: 'wecom:user-x:acc-pro-31', requestId: 'req-9', reply: '本期无凭证' },
      { ...BASE, requestId: null, reply: '' },
    ]);
    expect(facts).toHaveLength(2);
    expect(hasWriteChainSignal(facts[0]!)).toBe(false);
    expect(hasWriteChainSignal(facts[1]!)).toBe(false);
    expect(renderWriteChainLine(facts[0]!)).toContain('提案尝试 0 次');
    expect(renderWriteChainLine(facts[0]!)).toContain('意图 无');
  });

  it('requestId 为 null 的记录（被拒回合）不进尝试计数，也不炸', () => {
    const db = makeDb();
    const facts = collectWriteChainFacts(db, [{ ...BASE, requestId: null }]);
    expect(facts[0]!.proposalAttempts).toBe(0);
  });
});
