import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRequestRecord, AuditStore, ConversationSessionRecord, PrincipalScopeRecord, ToolCallRecord } from '@fshine/contracts';
import { closeStore, createSqliteStore, newId } from './src/index';

const DB_MODES = [':memory:', 'file'] as const;
type DbMode = (typeof DB_MODES)[number];

let msgSeq = 0;

function makeRequest(overrides: Partial<AgentRequestRecord> = {}): AgentRequestRecord {
  msgSeq += 1;
  return {
    requestId: newId('req'),
    wecomMessageId: `msg_${msgSeq}`,
    principalId: 'wecom:user_a',
    input: '查一下幻晟本期的凭证。',
    createdAt: '2026-09-15T08:00:00.000Z',
    outcome: 'replied',
    ...overrides,
  };
}

function makeToolCall(requestId: string, overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    requestId,
    toolName: 'search_account_sets',
    safeArguments: { keyword: '幻晟' },
    startedAt: '2026-09-15T08:00:01.000Z',
    status: 'running',
    ...overrides,
  };
}

function makeSession(overrides: Partial<ConversationSessionRecord> = {}): ConversationSessionRecord {
  return {
    sessionId: newId('sess'),
    principalId: 'wecom:user_a',
    channelConversationId: 'user_a|conv_1',
    updatedAt: '2026-09-15T08:05:00.000Z',
    ...overrides,
  };
}

function makePrincipal(wecomUserId: string, overrides: Partial<PrincipalScopeRecord> = {}): PrincipalScopeRecord {
  return {
    wecomUserId,
    accountSetIds: [`as_${wecomUserId}`],
    mcpProfile: 'read-default',
    enabled: true,
    ...overrides,
  };
}

describe.each(DB_MODES)('createSqliteStore(dbPath=%s)', (mode) => {
  let dir: string | undefined;
  let dbPath: string;
  let store: AuditStore;

  beforeEach(() => {
    if (mode === ':memory:') {
      dbPath = ':memory:';
    } else {
      dir = mkdtempSync(join(tmpdir(), 'fshine-core-store-'));
      dbPath = join(dir, 'audit.db');
    }
    store = createSqliteStore(dbPath);
  });

  afterEach(() => {
    closeStore(store);
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  describe('principalScopes', () => {
    it('upsert → get 字段逐个往返无损', async () => {
      const record = makePrincipal('user_a', {
        accountSetIds: ['as_001', 'as_002'],
        mcpProfile: 'read-default',
        enabled: true,
      });
      await store.principalScopes.upsert(record);

      const loaded = await store.principalScopes.get('user_a');
      expect(loaded).not.toBeNull();
      expect(loaded?.wecomUserId).toBe('user_a');
      expect(loaded?.accountSetIds).toEqual(['as_001', 'as_002']);
      expect(loaded?.mcpProfile).toBe('read-default');
      expect(loaded?.enabled).toBe(true);
    });

    it('upsert 覆盖旧记录', async () => {
      await store.principalScopes.upsert(makePrincipal('user_a', { enabled: true }));
      await store.principalScopes.upsert(makePrincipal('user_a', {
        accountSetIds: ['as_009'],
        enabled: false,
      }));

      const loaded = await store.principalScopes.get('user_a');
      expect(loaded?.accountSetIds).toEqual(['as_009']);
      expect(loaded?.enabled).toBe(false);
      expect(await store.principalScopes.list()).toHaveLength(1);
    });

    it('get 未命中返回 null;list 保持插入顺序', async () => {
      expect(await store.principalScopes.get('nobody')).toBeNull();

      const first = makePrincipal('user_1');
      const second = makePrincipal('user_2');
      const third = makePrincipal('user_3');
      await store.principalScopes.upsert(first);
      await store.principalScopes.upsert(second);
      await store.principalScopes.upsert(third);

      expect(await store.principalScopes.list()).toEqual([first, second, third]);
    });
  });

  describe('requests', () => {
    it('insert → get 字段逐个往返无损', async () => {
      const record = makeRequest();
      await store.requests.insert(record);

      const loaded = await store.requests.get(record.requestId);
      expect(loaded).not.toBeNull();
      expect(loaded?.requestId).toBe(record.requestId);
      expect(loaded?.wecomMessageId).toBe(record.wecomMessageId);
      expect(loaded?.principalId).toBe(record.principalId);
      expect(loaded?.input).toBe('查一下幻晟本期的凭证。');
      expect(loaded?.createdAt).toBe('2026-09-15T08:00:00.000Z');
      expect(loaded?.outcome).toBe('replied');
    });

    it('get 未命中返回 null', async () => {
      expect(await store.requests.get('req_missing')).toBeNull();
    });

    it('setOutcome 更新 outcome 且不影响其他字段', async () => {
      const record = makeRequest({ outcome: 'replied' });
      await store.requests.insert(record);
      await store.requests.setOutcome(record.requestId, 'denied');

      const loaded = await store.requests.get(record.requestId);
      expect(loaded?.outcome).toBe('denied');
      expect(loaded?.input).toBe(record.input);
      expect(loaded?.createdAt).toBe(record.createdAt);
    });

    it('findByWecomMessageId 命中最新一条;未命中返回 null', async () => {
      const record = makeRequest({ wecomMessageId: 'msg_hit' });
      await store.requests.insert(record);

      const loaded = await store.requests.findByWecomMessageId('msg_hit');
      expect(loaded?.requestId).toBe(record.requestId);
      expect(await store.requests.findByWecomMessageId('msg_missing')).toBeNull();
    });
  });

  describe('toolCalls', () => {
    it('insert/finish → listByRequest 条数、插入顺序与字段往返无损', async () => {
      const request = makeRequest();
      await store.requests.insert(request);

      await store.toolCalls.insert(makeToolCall(request.requestId, {
        traceId: 'trace_1',
        toolName: 'search_account_sets',
        safeArguments: { keyword: '幻晟' },
        source: 'wecom',
      }));
      await store.toolCalls.insert(makeToolCall(request.requestId, {
        toolName: 'list_vouchers',
        safeArguments: { accountSetId: 'as_001', period: '2026-08' },
        startedAt: '2026-09-15T08:00:02.000Z',
        status: 'running',
      }));
      await store.toolCalls.finish(request.requestId, {
        traceId: 'trace_2',
        finishedAt: '2026-09-15T08:00:03.000Z',
        status: 'error',
        errorCode: 'TIMEOUT',
        artifactId: 'art_1',
      });

      const calls = await store.toolCalls.listByRequest(request.requestId);
      expect(calls).toHaveLength(2);

      expect(calls[0]?.traceId).toBe('trace_1');
      expect(calls[0]?.toolName).toBe('search_account_sets');
      expect(calls[0]?.safeArguments).toEqual({ keyword: '幻晟' });
      expect(calls[0]?.source).toBe('wecom');
      expect(calls[0]?.status).toBe('running');
      expect(calls[0]?.errorCode).toBeUndefined();

      expect(calls[1]?.traceId).toBe('trace_2');
      expect(calls[1]?.toolName).toBe('list_vouchers');
      expect(calls[1]?.safeArguments).toEqual({ accountSetId: 'as_001', period: '2026-08' });
      expect(calls[1]?.finishedAt).toBe('2026-09-15T08:00:03.000Z');
      expect(calls[1]?.status).toBe('error');
      expect(calls[1]?.errorCode).toBe('TIMEOUT');
      expect(calls[1]?.artifactId).toBe('art_1');
    });

    it('finish 只改该请求最近一条 running 调用', async () => {
      const request = makeRequest();
      await store.requests.insert(request);
      await store.toolCalls.insert(makeToolCall(request.requestId, { status: 'ok', traceId: 'trace_ok' }));
      await store.toolCalls.insert(makeToolCall(request.requestId));
      await store.toolCalls.finish(request.requestId, { status: 'error', errorCode: 'PROFILE_BUSY' });

      const calls = await store.toolCalls.listByRequest(request.requestId);
      expect(calls[0]?.status).toBe('ok');
      expect(calls[0]?.errorCode).toBeUndefined();
      expect(calls[1]?.status).toBe('error');
      expect(calls[1]?.errorCode).toBe('PROFILE_BUSY');
    });

    it('listByRequest 按请求隔离', async () => {
      const requestA = makeRequest();
      const requestB = makeRequest();
      await store.requests.insert(requestA);
      await store.requests.insert(requestB);
      await store.toolCalls.insert(makeToolCall(requestA.requestId));
      await store.toolCalls.insert(makeToolCall(requestA.requestId));
      await store.toolCalls.insert(makeToolCall(requestB.requestId));

      expect(await store.toolCalls.listByRequest(requestA.requestId)).toHaveLength(2);
      expect(await store.toolCalls.listByRequest(requestB.requestId)).toHaveLength(1);
    });
  });

  describe('sessions', () => {
    it('upsert → get,state 对象序列化往返无损', async () => {
      const state = { candidates: [{ id: 'as_001', name: '幻晟' }] };
      const record = makeSession({ state });
      await store.sessions.upsert(record);

      const loaded = await store.sessions.get(record.sessionId);
      expect(loaded?.sessionId).toBe(record.sessionId);
      expect(loaded?.principalId).toBe(record.principalId);
      expect(loaded?.channelConversationId).toBe(record.channelConversationId);
      expect(loaded?.updatedAt).toBe(record.updatedAt);
      expect(loaded?.state).toEqual(state);
    });

    it('同 sessionId upsert 覆盖', async () => {
      const sessionId = newId('sess');
      await store.sessions.upsert(makeSession({ sessionId, state: { candidates: [{ id: 'as_001', name: '幻晟' }] } }));
      await store.sessions.upsert(makeSession({
        sessionId,
        updatedAt: '2026-09-15T08:06:00.000Z',
        state: { candidates: [{ id: 'as_002', name: '幻晟有限' }] },
      }));

      const loaded = await store.sessions.get(sessionId);
      expect(loaded?.updatedAt).toBe('2026-09-15T08:06:00.000Z');
      expect(loaded?.state).toEqual({ candidates: [{ id: 'as_002', name: '幻晟有限' }] });
    });

    it('state 缺省与 get 未命中', async () => {
      const record = makeSession();
      await store.sessions.upsert(record);

      const loaded = await store.sessions.get(record.sessionId);
      expect(loaded?.state).toBeUndefined();
      expect(await store.sessions.get('sess_missing')).toBeNull();
    });
  });
});

describe('createSqliteStore 文件库持久化', () => {
  it('关闭后重新打开,数据仍在(WAL 文件库)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fshine-core-store-'));
    const dbPath = join(dir, 'audit.db');
    let store: AuditStore | undefined;
    try {
      store = createSqliteStore(dbPath);
      const request = makeRequest();
      const principal = makePrincipal('user_a');
      const session = makeSession({ state: { candidates: [{ id: 'as_001', name: '幻晟' }] } });
      await store.requests.insert(request);
      await store.principalScopes.upsert(principal);
      await store.sessions.upsert(session);
      closeStore(store);

      const reopened = createSqliteStore(dbPath);
      try {
        expect(await reopened.requests.get(request.requestId)).toEqual(request);
        expect(await reopened.principalScopes.get('user_a')).toEqual(principal);
        expect(await reopened.sessions.get(session.sessionId)).toEqual(session);
      } finally {
        closeStore(reopened);
      }
    } finally {
      if (store) closeStore(store);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('newId', () => {
  it('带前缀且全局唯一', () => {
    const a = newId('req');
    const b = newId('req');
    expect(a).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
    expect(newId('sess').startsWith('sess_')).toBe(true);
  });
});
