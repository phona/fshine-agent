import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRequestRecord, AuditStore, ConversationEventRecord, ConversationSessionRecord, PlatformTaskRecord, PrincipalScopeRecord, SessionArtifactRecord, TaskRunRecord, ToolCallRecord } from '@fshine/contracts';
import { TaskRunActiveConflictError } from '@fshine/contracts';
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
    enabled: true,
    capabilities: ['read'],
    ...overrides,
  };
}

function makePlatformTask(overrides: Partial<PlatformTaskRecord> = {}): PlatformTaskRecord {
  return {
    taskId: newId('task'),
    parentSessionId: 'wecom:user_a:conv_1',
    principalId: 'wecom:user_a',
    workerMessages: [{ role: 'user', content: '查账' }],
    createdAt: '2026-09-15T08:00:00.000Z',
    updatedAt: '2026-09-15T08:05:00.000Z',
    ...overrides,
  };
}

function makeTaskRun(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
  const runId = newId('run');
  return {
    runId,
    taskId: `task_${runId}`,
    dispatchKey: `dispatch_${runId}`,
    principalId: 'wecom:user_a',
    sessionId: 'wecom:user_a:conv_1',
    originRequestId: 'req_origin',
    originUserEventId: 'evt_origin',
    request: '查账',
    originMessage: '帮我查账',
    createdAt: '2026-10-23T01:00:00.000Z',
    updatedAt: '2026-10-23T01:00:00.000Z',
    state: 'queued',
    revision: 0,
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
        enabled: true,
      });
      await store.principalScopes.upsert(record);

      const loaded = await store.principalScopes.get('user_a');
      expect(loaded).not.toBeNull();
      expect(loaded?.wecomUserId).toBe('user_a');
      expect(loaded?.accountSetIds).toEqual(['as_001', 'as_002']);
      expect(loaded?.enabled).toBe(true);
      expect(loaded?.capabilities).toEqual(['read']);
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
      expect(loaded?.capabilities).toEqual(['read']);
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

  describe('sessionArtifacts', () => {
    it('stores the originating run alongside task provenance', async () => {
      const artifact: SessionArtifactRecord = {
        ref: '7', sessionId: 'sess_a', filename: 'result.xlsx', sha256: 'abc123', size: 2048,
        sourceTaskId: 'task_1', sourceRunId: 'run_2', requestId: 'req_1',
        createdAt: '2026-10-23T02:00:00.000Z', status: 'available', path: '/tmp/artifact.xlsx',
      };
      await store.sessionArtifacts!.insert(artifact);
      expect(await store.sessionArtifacts!.get(artifact.sessionId, artifact.ref)).toEqual(artifact);
      expect(await store.sessionArtifacts!.listBySession(artifact.sessionId)).toEqual([artifact]);
    });

    // ── D-123（2026-10-25 登债）：insert 是静默覆盖 upsert，并发 ingest 分到重叠 ref 时
    // 后写覆盖前写（字节留孤儿、ref 指向新文件），正确性只靠"handler 会话队列内串行"的
    // 注释纪律。fail-loud 优于数据丢失：冲突必须抛可识别错误且首行数据不变。
    it('同会话同 ref 二次 insert fail-loud 抛可识别错误，首行数据不变（D-123）', async () => {
      const first: SessionArtifactRecord = {
        ref: '3', sessionId: 'sess_dup', filename: 'first.xlsx', sha256: 'sha_first', size: 10,
        createdAt: '2026-10-25T00:00:00.000Z', status: 'available', path: '/tmp/first.xlsx',
      };
      await store.sessionArtifacts!.insert(first);

      const error = await store.sessionArtifacts!.insert({
        ...first, filename: 'second.xlsx', sha256: 'sha_second', size: 20, path: '/tmp/second.xlsx',
      }).then(() => null, (caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('SessionArtifactRefConflictError');
      expect((error as Error).message).toContain('sess_dup');
      expect((error as Error).message).toContain("'3'");
      // 首行未被覆盖：ref 仍指向原文件（覆盖 upsert 会让 get 读回 second 的形状）。
      expect(await store.sessionArtifacts!.get('sess_dup', '3')).toEqual(first);
      expect((await store.sessionArtifacts!.listBySession('sess_dup'))).toHaveLength(1);
    });

    // ── D-123：ref 是 TEXT 列，同毫秒批内跨 10 位数（'10' < '2'）时 TEXT 序不稳定，
    // 影响清单顺序与最旧优先淘汰的确定性。ref 由 nextArtifactRef 生成（数字字符串），
    // CAST 后数值序稳定。
    it('同毫秒批内 ref 跨 10 位数仍按数值序排列（D-123：改前 TEXT 序是 1,10,2）', async () => {
      const createdAt = '2026-10-25T00:00:00.000Z';
      for (const ref of ['1', '2', '10']) {
        await store.sessionArtifacts!.insert({
          ref, sessionId: 'sess_order', filename: `f${ref}.xlsx`, sha256: 'sha', size: 1,
          createdAt, status: 'available', path: `/tmp/${ref}.xlsx`,
        });
      }
      expect((await store.sessionArtifacts!.listBySession('sess_order')).map((row) => row.ref))
        .toEqual(['1', '2', '10']);
    });
  });

  describe('platformTasks', () => {
    it('只持久化可恢复 Pi transcript 的最小字段', async () => {
      const record = makePlatformTask();
      await store.platformTasks!.upsert(record);

      expect(await store.platformTasks!.get(record.taskId)).toEqual(record);
    });

    it('同 taskId upsert 更新 transcript 与时间', async () => {
      const taskId = newId('task');
      await store.platformTasks!.upsert(makePlatformTask({ taskId }));
      const updated = makePlatformTask({
        taskId,
        workerMessages: [{ role: 'assistant', content: '已完成' }],
        updatedAt: '2026-09-15T08:06:00.000Z',
      });
      await store.platformTasks!.upsert(updated);

      expect(await store.platformTasks!.get(taskId)).toEqual(updated);
    });

    // ── P2 结构化执行事实（D-065）──────────────────────────────────────────
    it('结构化事实原样往返：accountSet/period/calls/label/outcome/resultText', async () => {
      const record = makePlatformTask({
        accountSet: '幻州市幻晟财务代理有限公司',
        period: '202609',
        calls: [{ operation: 'voucher.query-saved', args: ['幻州市幻晟财务代理有限公司', '202609'] }],
        label: '查凭证列表',
        outcome: 'done',
        resultText: '共 12 张凭证。',
      });
      await store.platformTasks!.upsert(record);

      expect(await store.platformTasks!.get(record.taskId)).toEqual(record);
    });

    it('结构化字段缺失时不猜不补：记录里没有的字段读回时也不出现', async () => {
      const record = makePlatformTask();
      await store.platformTasks!.upsert(record);

      const loaded = (await store.platformTasks!.get(record.taskId))!;
      expect(loaded).toEqual(record);
      expect('accountSet' in loaded).toBe(false);
      expect('period' in loaded).toBe(false);
      expect('calls' in loaded).toBe(false);
      expect('outcome' in loaded).toBe(false);
      expect('resultText' in loaded).toBe(false);
    });

    it('同 taskId upsert 替换结构化事实（不含"保留旧值"的隐式合并）', async () => {
      const taskId = newId('task');
      await store.platformTasks!.upsert(makePlatformTask({
        taskId, accountSet: '甲', period: '202601', outcome: 'done', resultText: '第一次',
      }));
      await store.platformTasks!.upsert(makePlatformTask({
        taskId, accountSet: '乙', period: '202602', outcome: 'needs',
      }));

      const loaded = (await store.platformTasks!.get(taskId))!;
      expect(loaded).toMatchObject({ accountSet: '乙', period: '202602', outcome: 'needs' });
      // resultText 由调用方（context.ts 的 withExecutionFacts）决定累不累加，存储不替它保留
      expect('resultText' in loaded).toBe(false);
    });

    it('listBySession 按会话列举、时间正序，且不串其他 principal/会话', async () => {
      const older = makePlatformTask({ taskId: 'task_old', createdAt: '2026-09-15T08:00:00.000Z', resultText: '较早' });
      const newer = makePlatformTask({ taskId: 'task_new', createdAt: '2026-09-15T08:05:00.000Z', resultText: '较晚' });
      await store.platformTasks!.upsert(newer);
      await store.platformTasks!.upsert(older);
      // 别的会话/principal 的同名任务不许混进来
      await store.platformTasks!.upsert(makePlatformTask({
        taskId: 'task_other_session', parentSessionId: 'wecom:user_a:conv_2', resultText: '旁路',
      }));
      await store.platformTasks!.upsert(makePlatformTask({
        taskId: 'task_other_user', principalId: 'wecom:user_b', resultText: '旁路',
      }));

      const rows = await store.platformTasks!.listBySession('wecom:user_a', 'wecom:user_a:conv_1');
      expect(rows.map((row) => row.taskId)).toEqual(['task_old', 'task_new']);
    });
  });

  describe('changeIntents', () => {
    const base = {
      intentId: newId('intent'),
      principalId: 'wecom:u1',
      sessionId: 'wecom:u1:c1',
      confirmCodeHash: 'hash-d3f2k9',
      status: 'pending' as const,
      createdAt: '2026-09-19T08:00:00.000Z',
      expiresAt: '2026-09-19T08:10:00.000Z',
    };

    it('create/get 往返完整（零业务字段：kind/accountSet/period/payload/summary 一律不入库）', async () => {
      await store.changeIntents!.create(base);
      expect(await store.changeIntents!.get(base.intentId)).toEqual(base);
    });

    it('proposalId/taskId 新列往返，缺省时不出现', async () => {
      const withRef = { ...base, intentId: newId('intent'), proposalId: 'prop_abc', taskId: 'task_1' };
      await store.changeIntents!.create(withRef);
      const loaded = await store.changeIntents!.get(withRef.intentId);
      expect(loaded).toEqual(withRef);

      await store.changeIntents!.create(base);
      const bare = await store.changeIntents!.get(base.intentId);
      expect('proposalId' in bare!).toBe(false);
      expect('taskId' in bare!).toBe(false);
    });

    it('确认码命中未过期意图', async () => {
      await store.changeIntents!.create(base);
      const hit = await store.changeIntents!.findPendingByConfirm(
        base.principalId, base.sessionId, base.confirmCodeHash, new Date('2026-09-19T08:05:00.000Z'));
      expect(hit?.intentId).toBe(base.intentId);
    });

    it('过期意图就地置 expired 并返回 null', async () => {
      await store.changeIntents!.create(base);
      const hit = await store.changeIntents!.findPendingByConfirm(
        base.principalId, base.sessionId, base.confirmCodeHash, new Date('2026-09-19T08:11:00.000Z'));
      expect(hit).toBeNull();
      expect((await store.changeIntents!.get(base.intentId))?.status).toBe('expired');
    });

    it('确认码绑定 principal 与 session，他人不可用', async () => {
      await store.changeIntents!.create(base);
      expect(await store.changeIntents!.findPendingByConfirm(
        'wecom:other', base.sessionId, base.confirmCodeHash, new Date('2026-09-19T08:05:00.000Z'))).toBeNull();
      expect(await store.changeIntents!.findPendingByConfirm(
        base.principalId, 'wecom:u1:other', base.confirmCodeHash, new Date('2026-09-19T08:05:00.000Z'))).toBeNull();
    });

    it('findPendingBySession 命中 pending；committed 后不再命中', async () => {
      await store.changeIntents!.create(base);
      expect((await store.changeIntents!.findPendingBySession(base.principalId, base.sessionId))?.intentId)
        .toBe(base.intentId);
      await store.changeIntents!.updateStatus(base.intentId, 'committed', { saved: 1 });
      expect(await store.changeIntents!.findPendingBySession(base.principalId, base.sessionId)).toBeNull();
      const done = await store.changeIntents!.get(base.intentId);
      expect(done?.status).toBe('committed');
      expect(done?.result).toEqual({ saved: 1 });
      expect(done?.decidedAt).toBeTruthy();
    });

    it('后台提案可按任务查找，不会把另一独立任务的待确认提案取代', async () => {
      const first = { ...base, intentId: newId('intent'), taskId: 'task_a', confirmCodeHash: 'code_a' };
      const second = { ...base, intentId: newId('intent'), taskId: 'task_b', confirmCodeHash: 'code_b', createdAt: '2026-09-19T08:01:00.000Z' };
      await store.changeIntents!.create(first);
      await store.changeIntents!.create(second);
      expect((await store.changeIntents!.findPendingBySession(base.principalId, base.sessionId))?.intentId).toBe(second.intentId);
      expect((await store.changeIntents!.findPendingBySession(base.principalId, base.sessionId, 'task_a'))?.intentId).toBe(first.intentId);
      expect(await store.changeIntents!.findPendingBySession(base.principalId, base.sessionId, 'task_c')).toBeNull();
    });
  });

  describe('conversationLog', () => {
    it('追加事件幂等，按 principal/session 隔离并按时间顺序检索', async () => {
      const event = {
        eventId: 'evt_1', principalId: 'wecom:user_a', sessionId: 'sess_a',
        kind: 'user_message' as const, content: '查 2026 年 3 月的凭证', createdAt: '2026-09-15T08:00:00.000Z', requestId: 'req_1',
      };
      await store.conversationLog.append(event);
      await store.conversationLog.append(event);
      await store.conversationLog.append({ ...event, eventId: 'evt_2', kind: 'assistant_message', content: '正在查询。', createdAt: '2026-09-15T08:00:01.000Z' });
      await store.conversationLog.append({ ...event, eventId: 'evt_3', principalId: 'wecom:user_b', sessionId: 'sess_b', content: '其他用户私密内容' });

      expect(await store.conversationLog.list({ principalId: 'wecom:user_a', sessionId: 'sess_a', limit: 10 })).toEqual([
        event,
        { ...event, eventId: 'evt_2', kind: 'assistant_message', content: '正在查询。', createdAt: '2026-09-15T08:00:01.000Z' },
      ]);
      expect(await store.conversationLog.search({ principalId: 'wecom:user_a', sessionId: 'sess_a', query: '凭证', limit: 10 })).toHaveLength(1);
      expect(await store.conversationLog.search({ principalId: 'wecom:user_a', query: '私密', limit: 10 })).toEqual([]);
      expect((await store.conversationLog.list({ principalId: 'wecom:user_a', sessionId: 'sess_a', afterEventId: 'evt_1', limit: 10 })).map((item) => item.eventId)).toEqual(['evt_2']);
    });

    it('同一 eventId 不允许被不同内容覆盖', async () => {
      const event = {
        eventId: 'evt_collision', principalId: 'wecom:user_a', sessionId: 'sess_a',
        kind: 'user_message' as const, content: '原文', createdAt: '2026-09-15T08:00:00.000Z', requestId: 'req_1',
      };
      await store.conversationLog.append(event);
      await expect(store.conversationLog.append({ ...event, content: '被篡改' })).rejects.toThrow(/eventId/);
      expect(await store.conversationLog.list({ principalId: 'wecom:user_a', sessionId: 'sess_a', limit: 10 })).toEqual([event]);
    });

    it('引用 metadata 独立往返、可搜索，且相同 eventId 的不同引用触发冲突', async () => {
      const event: ConversationEventRecord = {
        eventId: 'evt_quoted', principalId: 'wecom:user_a', sessionId: 'sess_a',
        kind: 'user_message', content: '解释一下这个',
        messageReference: { kind: 'text', text: '上月的汇总表', truncated: false, sourceMessageId: 'quoted_msg_1' },
        createdAt: '2026-10-23T01:00:00.000Z', requestId: 'req_quoted',
      };
      const unsafeEvent = {
        ...event,
        messageReference: { ...event.messageReference!, tempUrl: 'https://temporary.invalid/x', aeskey: 'secret' } as NonNullable<ConversationEventRecord['messageReference']>,
      };
      await store.conversationLog.append(unsafeEvent);

      expect(await store.conversationLog.list({ principalId: event.principalId, sessionId: event.sessionId, limit: 10 }))
        .toEqual([event]);
      expect(await store.conversationLog.search({ principalId: event.principalId, sessionId: event.sessionId, query: '汇总表', limit: 10 }))
        .toEqual([event]);
      expect(await store.conversationLog.search({ principalId: event.principalId, sessionId: event.sessionId, query: '解释一下', limit: 10 }))
        .toEqual([event]);

      await expect(store.conversationLog.append({
        ...unsafeEvent,
        messageReference: { ...event.messageReference!, text: '另一段引用' },
      })).rejects.toThrow(/eventId/);
    });

    it('task_event 的 taskId/runId 持久化并可检索', async () => {
      const event: ConversationEventRecord = {
        eventId: 'evt_task_run', principalId: 'wecom:user_a', sessionId: 'sess_a',
        kind: 'task_event', content: '{"state":"completed"}', taskId: 'task_1', runId: 'run_1',
        createdAt: '2026-10-23T01:01:00.000Z', requestId: 'req_1',
      };
      await store.conversationLog.append(event);
      expect(await store.conversationLog.list({ principalId: event.principalId, sessionId: event.sessionId, limit: 10 }))
        .toEqual([event]);
      expect(await store.conversationLog.search({ principalId: event.principalId, query: 'completed', limit: 10 }))
        .toEqual([event]);
    });
  });

  describe('taskRuns', () => {
    it('按唯一 dispatchKey 原子创建或返回同一 run，并无损读回事件与交付 metadata', async () => {
      const first = makeTaskRun({
        dispatchKey: 'dispatch_origin_tool_call',
        planId: 'plan_1', stepIndex: 2, totalSteps: 3,
        inputContext: { messageReference: { kind: 'text', text: '本轮引用' } },
        deliveryRoute: { channel: 'wecom', conversationId: 'conv_1' },
        result: { outcome: 'ok', count: 4 }, resultEventId: 'evt_result_1',
        deliveryState: 'pending', delivery: [{ itemId: 'text:0', status: 'pending' }],
        metadata: { inputFiles: [{ path: '/tmp/input.xlsx', size: 9, sha256: 'abc' }] },
      });
      const duplicate = { ...first, runId: 'run_duplicate', taskId: 'task_duplicate', createdAt: '2026-10-24T00:00:00.000Z' };

      const [created, repeated] = await Promise.all([
        store.taskRuns!.createOrGetByDispatchKey(first),
        store.taskRuns!.createOrGetByDispatchKey(duplicate),
      ]);

      expect(created).toEqual(first);
      expect(repeated).toEqual(first);
      expect(await store.taskRuns!.get(first.runId)).toEqual(first);
      expect(await store.taskRuns!.getByDispatchKey(first.dispatchKey)).toEqual(first);
      expect(await store.taskRuns!.get(duplicate.runId)).toBeNull();
      expect(await store.taskRuns!.listBySession(first.principalId, first.sessionId)).toEqual([first]);
    });

    it('同毫秒和旧运行交付更新不改变 run 注册顺序', async () => {
      const first = makeTaskRun({ runId: 'run_z_first', dispatchKey: 'first', state: 'completed' });
      const second = makeTaskRun({ runId: 'run_a_second', dispatchKey: 'second', state: 'running' });
      await store.taskRuns!.createOrGetByDispatchKey(first);
      await store.taskRuns!.createOrGetByDispatchKey(second);
      await store.taskRuns!.transition(first.runId, ['completed'], { updatedAt: '2099-01-01T00:00:00.000Z', deliveryState: 'sent' });
      const rows = await store.taskRuns!.listBySession(first.principalId, first.sessionId);
      expect(rows.map((row) => row.runId)).toEqual([first.runId, second.runId]);
    });

    it('expected-state transition 是原子的，并拒绝改写身份与派单键', async () => {
      const run = makeTaskRun();
      await store.taskRuns!.createOrGetByDispatchKey(run);

      expect(await store.taskRuns!.transition(run.runId, ['running'], { state: 'completed' })).toBe(false);
      expect(await store.taskRuns!.transition(run.runId, ['queued'], {
        state: 'running', startedAt: '2026-10-23T01:01:00.000Z', updatedAt: '2026-10-23T01:01:00.000Z',
      })).toBe(true);
      expect(await store.taskRuns!.transition(run.runId, ['queued'], { state: 'failed' })).toBe(false);
      expect(await store.taskRuns!.transition(run.runId, ['running'], {
        state: 'completed', resultEventId: 'evt_done', endedAt: '2026-10-23T01:02:00.000Z',
      })).toBe(true);
      await expect(store.taskRuns!.transition(run.runId, ['completed'], { taskId: 'other_task' }))
        .rejects.toThrow(/immutable|identity|dispatch/i);
      await expect(store.taskRuns!.transition(run.runId, ['completed'], { principalId: 'wecom:other' }))
        .rejects.toThrow(/immutable|identity|dispatch/i);
      await expect(store.taskRuns!.transition(run.runId, ['completed'], {
        deliveryRoute: { channel: 'wecom', conversationId: 'other-conversation' },
      })).rejects.toThrow(/immutable|identity|dispatch/i);
      expect((await store.taskRuns!.get(run.runId))?.state).toBe('completed');
    });

    it('revision CAS 会拒绝同状态的过期 delivery/metadata 写入', async () => {
      const run = makeTaskRun();
      await store.taskRuns!.createOrGetByDispatchKey(run);
      const initial = await store.taskRuns!.get(run.runId);
      expect(initial?.revision).toBe(0);
      expect(await store.taskRuns!.transition(run.runId, ['queued'], { state: 'running' }, initial?.revision)).toBe(true);

      const current = await store.taskRuns!.get(run.runId);
      expect(current?.revision).toBe(1);
      expect(await store.taskRuns!.transition(
        run.runId,
        ['running'],
        { lastProgress: 'stale snapshot' },
        initial?.revision,
      )).toBe(false);
      expect(await store.taskRuns!.transition(
        run.runId,
        ['running'],
        { lastProgress: 'current snapshot' },
        current?.revision,
      )).toBe(true);
      expect(await store.taskRuns!.get(run.runId)).toMatchObject({ revision: 2, lastProgress: 'current snapshot' });
    });

    it('启动恢复只中断 queued/running/cancelling，不自动恢复或重放', async () => {
      const queued = makeTaskRun({ runId: 'run_queued', dispatchKey: 'd_queued', state: 'queued' });
      const running = makeTaskRun({ runId: 'run_running', dispatchKey: 'd_running', state: 'running', startedAt: '2026-10-23T01:00:30.000Z' });
      const cancelling = makeTaskRun({ runId: 'run_cancelling', dispatchKey: 'd_cancelling', state: 'cancelling' });
      const waiting = makeTaskRun({ runId: 'run_waiting', dispatchKey: 'd_waiting', state: 'waiting_confirmation' });
      const completed = makeTaskRun({ runId: 'run_completed', dispatchKey: 'd_completed', state: 'completed' });
      for (const run of [queued, running, cancelling, waiting, completed]) await store.taskRuns!.createOrGetByDispatchKey(run);

      expect(await store.taskRuns!.interruptActive('2026-10-23T02:00:00.000Z')).toBe(3);
      expect(await store.taskRuns!.interruptActive('2026-10-23T02:01:00.000Z')).toBe(0);
      expect(await store.taskRuns!.get(queued.runId)).toMatchObject({ state: 'interrupted', updatedAt: '2026-10-23T02:00:00.000Z', endedAt: '2026-10-23T02:00:00.000Z' });
      expect(await store.taskRuns!.get(running.runId)).toMatchObject({ state: 'interrupted', startedAt: running.startedAt });
      expect(await store.taskRuns!.get(cancelling.runId)).toMatchObject({ state: 'interrupted' });
      expect(await store.taskRuns!.get(waiting.runId)).toMatchObject({ state: 'waiting_confirmation' });
      expect(await store.taskRuns!.get(completed.runId)).toMatchObject({ state: 'completed' });
    });

    it('同一 taskId 不允许存在两个活动 run，结束/等待后才允许显式新 run', async () => {
      const first = makeTaskRun({ taskId: 'task_single_active', dispatchKey: 'dispatch_active_1' });
      await store.taskRuns!.createOrGetByDispatchKey(first);
      // D-125：跨进程/重启竞态下调用方拿到的是未分类 SqliteError——转可识别错误，
      // 调用方才能回复"已有 Worker 在跑"而不是接住底层约束异常。
      const conflict = await store.taskRuns!.createOrGetByDispatchKey(makeTaskRun({
        taskId: first.taskId, dispatchKey: 'dispatch_active_2',
      })).then(() => null, (caught: unknown) => caught);
      expect(conflict).toBeInstanceOf(TaskRunActiveConflictError);
      expect((conflict as Error).message).toContain('task_single_active');
      // dispatchKey 幂等（DO NOTHING 回读）不受分类改造影响：同 key 二次提交仍返回原 run。
      await expect(store.taskRuns!.createOrGetByDispatchKey(makeTaskRun({
        taskId: 'task_other', dispatchKey: 'dispatch_active_1', runId: 'run_idempotent_1',
      }))).resolves.toMatchObject({ runId: first.runId, taskId: first.taskId });

      expect(await store.taskRuns!.transition(first.runId, ['queued'], { state: 'waiting_input' })).toBe(true);
      const resumed = makeTaskRun({ taskId: first.taskId, dispatchKey: 'dispatch_active_3' });
      await expect(store.taskRuns!.createOrGetByDispatchKey(resumed)).resolves.toEqual(resumed);
    });

    it('枚举全局未完成任务与待处理结果的 GC 引用，不钉已交付终态（result_handling_state 列驱动）', async () => {
      const pinned = [
        makeTaskRun({ runId: 'run_pin_queued', taskId: 'task_pin_queued', dispatchKey: 'pin_queued', state: 'queued' }),
        makeTaskRun({ runId: 'run_pin_running', taskId: 'task_pin_running', dispatchKey: 'pin_running', state: 'running' }),
        makeTaskRun({ runId: 'run_pin_cancelling', taskId: 'task_pin_cancelling', dispatchKey: 'pin_cancelling', state: 'cancelling' }),
        makeTaskRun({ runId: 'run_pin_input', taskId: 'task_pin_input', dispatchKey: 'pin_input', state: 'waiting_input' }),
        makeTaskRun({ runId: 'run_pin_confirmation', taskId: 'task_pin_confirmation', dispatchKey: 'pin_confirmation', state: 'waiting_confirmation' }),
        makeTaskRun({ runId: 'run_pin_delivery_pending', taskId: 'task_pin_delivery_pending', dispatchKey: 'pin_delivery_pending', state: 'completed', deliveryState: 'pending' }),
        makeTaskRun({ runId: 'run_pin_delivery_failed', taskId: 'task_pin_delivery_failed', dispatchKey: 'pin_delivery_failed', state: 'failed', deliveryState: 'failed' }),
        makeTaskRun({ runId: 'run_pin_delivery_unknown', taskId: 'task_pin_delivery_unknown', dispatchKey: 'pin_delivery_unknown', state: 'interrupted', deliveryState: 'unknown' }),
        makeTaskRun({ runId: 'run_pin_unhandled', taskId: 'task_pin_unhandled', dispatchKey: 'pin_unhandled', state: 'completed', resultHandlingState: 'failed' }),
        makeTaskRun({ runId: 'run_pin_processing', taskId: 'task_pin_processing', dispatchKey: 'pin_processing', state: 'completed', deliveryState: 'sent', resultHandlingState: 'processing' }),
        makeTaskRun({ runId: 'run_pin_missing_handling', taskId: 'task_pin_missing_handling', dispatchKey: 'pin_missing_handling', state: 'completed', deliveryState: 'sent' }),
      ];
      const delivered = makeTaskRun({
        runId: 'run_delivered', taskId: 'task_delivered', dispatchKey: 'delivered',
        state: 'completed', deliveryState: 'sent', resultHandlingState: 'handled',
      });
      const noDeliveryState = makeTaskRun({
        runId: 'run_terminal', taskId: 'task_terminal', dispatchKey: 'terminal', state: 'failed',
      });
      const oldWaiting = makeTaskRun({
        runId: 'run_old_waiting', taskId: 'task_resumed', dispatchKey: 'old_waiting', state: 'waiting_confirmation',
      });
      const intermediate = makeTaskRun({
        runId: 'run_intermediate', taskId: 'task_intermediate', dispatchKey: 'intermediate',
        state: 'completed', deliveryState: 'not_required', resultHandlingState: 'handled',
      });
      const finalAfterIntermediate = makeTaskRun({
        runId: 'run_final_after_intermediate', taskId: 'task_intermediate', dispatchKey: 'final_after_intermediate',
        state: 'completed', deliveryState: 'sent', resultHandlingState: 'handled',
      });
      const newDelivered = makeTaskRun({
        runId: 'run_new_delivered', taskId: 'task_resumed', dispatchKey: 'new_delivered',
        state: 'completed', deliveryState: 'sent', resultHandlingState: 'handled',
      });
      for (const run of [...pinned, delivered, noDeliveryState, oldWaiting, newDelivered, intermediate, finalAfterIntermediate]) {
        await store.taskRuns!.createOrGetByDispatchKey(run);
      }

      expect(await store.taskRuns!.listPinnedTaskIds()).toEqual([...pinned, noDeliveryState].map((run) => run.taskId).sort());
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

// ── P2 结构化事实的前向迁移（D-065）：旧库打开即补列，旧行读回时没有新字段 ──────────
describe('platform_tasks 结构化事实列的前向迁移', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('旧库（无结构化列）打开后自动补列，旧行读回不带新字段、新写入照常往返', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fshine-core-migrate-'));
    dirs.push(dir);
    const dbPath = join(dir, 'legacy.db');
    // 按迁移前的形状建库并写入一行（只到 updated_at 为止，没有结构化列）
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE IF NOT EXISTS platform_tasks (
        task_id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        parent_session_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        status TEXT NOT NULL,
        worker_messages TEXT NOT NULL,
        current_step TEXT,
        pending_questions TEXT,
        last_result TEXT,
        evidence TEXT,
        skill_version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO platform_tasks (task_id, plugin_id, parent_session_id, principal_id, status, worker_messages, created_at, updated_at)
      VALUES ('task_legacy', '', 'wecom:user_a:conv_1', 'wecom:user_a', 'active', '[]', '2026-09-15T08:00:00.000Z', '2026-09-15T08:05:00.000Z');
    `);
    legacy.close();

    // 用新代码打开同一文件：迁移补列 + 既有数据可读
    const store = createSqliteStore(dbPath);
    try {
      const legacyRow = (await store.platformTasks!.get('task_legacy'))!;
      expect(legacyRow.taskId).toBe('task_legacy');
      // 旧行没有结构化字段：读回时一个都不出现（消费方据此降级，不猜不补）
      expect('accountSet' in legacyRow).toBe(false);
      expect('resultText' in legacyRow).toBe(false);
      expect(await store.platformTasks!.listBySession('wecom:user_a', 'wecom:user_a:conv_1')).toHaveLength(1);

      // 新写入照常往返（补列后的同一张表）
      await store.platformTasks!.upsert(makePlatformTask({
        taskId: 'task_new', accountSet: '甲', period: '202601', outcome: 'done', resultText: '新行',
      }));
      const fresh = (await store.platformTasks!.get('task_new'))!;
      expect(fresh).toMatchObject({ accountSet: '甲', period: '202601', outcome: 'done', resultText: '新行' });
    } finally {
      closeStore(store);
    }
  });
});

// ── change_intents 的前向迁移（方案 1 · B 波 W5）──────────────────────────────
// 旧库有 kind/account_set 历史列、没有 proposal_id 时：
//   ① 开库即补列（缺列即补，与 capabilities / platform_tasks 同一写法）；
//   ② 旧行读回**不带 proposalId**（上层据此判过期，不 commit）；
//   ③ 新写入只碰新列，历史列不再被写。
describe('change_intents 前向迁移（旧库历史行）', () => {
  const base = {
    intentId: newId('intent'),
    principalId: 'wecom:u1',
    sessionId: 'wecom:u1:c1',
    confirmCodeHash: 'hash-d3f2k9',
    status: 'pending' as const,
    createdAt: '2026-09-19T08:00:00.000Z',
    expiresAt: '2026-09-19T08:10:00.000Z',
  };

  /** 造一个"迁移前"的库：旧五列齐全、没有 proposal_id/task_id，并塞一行旧数据。 */
  function seedLegacyDatabase(file: string): void {
    const legacy = new Database(file);
    try {
      legacy.exec(
        'CREATE TABLE change_intents ('
        + 'intent_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, session_id TEXT NOT NULL, '
        + 'kind TEXT NOT NULL, account_set TEXT NOT NULL, period TEXT NOT NULL, payload TEXT NOT NULL, '
        + 'summary TEXT NOT NULL, confirm_code_hash TEXT NOT NULL, status TEXT NOT NULL, '
        + 'created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT, result TEXT)',
      );
      legacy.prepare(
        'INSERT INTO change_intents (intent_id, principal_id, session_id, kind, account_set, period, payload, summary, '
        + 'confirm_code_hash, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        'intent_legacy', 'wecom:u1', 'wecom:u1:c1', 'voucher.batch', '幻州市幻晟财务代理有限公司', '202608',
        '{"type":"change_proposal"}', '{"count":1,"debit":100,"credit":100}', 'hash-legacy', 'pending',
        '2026-09-19T08:00:00.000Z', '2026-09-19T08:10:00.000Z',
      );
    } finally {
      legacy.close();
    }
  }

  it('缺列即补：开库后 proposal_id/task_id 存在，旧行读回不带 proposalId', async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'fshine-core-store-legacy-'));
    const legacyPath = join(legacyDir, 'audit.db');
    try {
      seedLegacyDatabase(legacyPath);
      const legacyStore = createSqliteStore(legacyPath);
      try {
        const columns = (new Database(legacyPath).prepare('PRAGMA table_info(change_intents)').all() as Array<{ name: string }>)
          .map((column) => column.name);
        expect(columns).toContain('proposal_id');
        expect(columns).toContain('task_id');

        // 旧行：只映射新字段——业务字段一个都不读回来（W5：上层据此判过期）
        const legacy = await legacyStore.changeIntents!.get('intent_legacy');
        expect(legacy).toMatchObject({ intentId: 'intent_legacy', status: 'pending', confirmCodeHash: 'hash-legacy' });
        expect('proposalId' in legacy!).toBe(false);
        for (const field of ['kind', 'accountSet', 'period', 'payload', 'summary']) {
          expect(field in legacy!).toBe(false);
        }

        // 开库后可继续写入（旧库的历史列 NOT NULL 无缺省，由空串兼容值顶着）
        await legacyStore.changeIntents!.create({ ...base, intentId: newId('intent'), proposalId: 'prop_new' });
        expect((await legacyStore.changeIntents!.get('intent_legacy'))?.status).toBe('pending');
      } finally {
        closeStore(legacyStore);
      }
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it('历史列不被新写入污染：create 之后 kind/account_set/period/payload/summary 仍是空串', async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'fshine-core-store-legacy-'));
    const legacyPath = join(legacyDir, 'audit.db');
    try {
      seedLegacyDatabase(legacyPath);
      const legacyStore = createSqliteStore(legacyPath);
      try {
        const intentId = newId('intent');
        await legacyStore.changeIntents!.create({ ...base, intentId, proposalId: 'prop_new' });
        const row = new Database(legacyPath)
          .prepare('SELECT kind, account_set, period, payload, summary FROM change_intents WHERE intent_id = ?')
          .get(intentId) as Record<string, string>;
        expect(row).toEqual({ kind: '', account_set: '', period: '', payload: '', summary: '' });
      } finally {
        closeStore(legacyStore);
      }
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

describe('conversation_events 前向迁移（引用与后台关联）', () => {
  it('为已有事件表补可空列；旧事件读作无引用，后续 quote 与 task_event 可正常写入', async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'fshine-core-events-legacy-'));
    const legacyPath = join(legacyDir, 'audit.db');
    const timestamp = '2026-10-22T10:00:00.000Z';
    let legacyStore: AuditStore | undefined;
    try {
      const legacy = new Database(legacyPath);
      try {
        legacy.exec(
          'CREATE TABLE conversation_events ('
          + 'event_seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, principal_id TEXT NOT NULL, '
          + 'session_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT, artifact_ref TEXT, created_at TEXT NOT NULL, request_id TEXT)',
        );
        legacy.prepare(
          'INSERT INTO conversation_events (event_id, principal_id, session_id, kind, content, created_at, request_id) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run('evt_old', 'wecom:user_a', 'sess_a', 'user_message', '旧正文', timestamp, 'req_old');
      } finally {
        legacy.close();
      }

      legacyStore = createSqliteStore(legacyPath);
      const columns = new Set((new Database(legacyPath).prepare('PRAGMA table_info(conversation_events)').all() as Array<{ name: string }>).map(({ name }) => name));
      expect(columns.has('message_reference')).toBe(true);
      expect(columns.has('task_id')).toBe(true);
      expect(columns.has('run_id')).toBe(true);
      expect(await legacyStore.conversationLog.list({ principalId: 'wecom:user_a', sessionId: 'sess_a', limit: 10 }))
        .toEqual([{ eventId: 'evt_old', principalId: 'wecom:user_a', sessionId: 'sess_a', kind: 'user_message', content: '旧正文', createdAt: timestamp, requestId: 'req_old' }]);

      await legacyStore.conversationLog.append({
        eventId: 'evt_new', principalId: 'wecom:user_a', sessionId: 'sess_a', kind: 'task_event',
        content: 'run completed', messageReference: { kind: 'text', text: '引用正文' },
        taskId: 'task_new', runId: 'run_new', createdAt: timestamp, requestId: 'req_new',
      });
      expect(await legacyStore.conversationLog.search({ principalId: 'wecom:user_a', sessionId: 'sess_a', query: '引用正文', limit: 10 }))
        .toMatchObject([{ eventId: 'evt_new', content: 'run completed', messageReference: { text: '引用正文' }, taskId: 'task_new', runId: 'run_new' }]);
    } finally {
      if (legacyStore) closeStore(legacyStore);
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

describe('session_artifacts 前向迁移（run provenance）', () => {
  it('为旧产物库补 source_run_id 且旧行保持无 run 关联', async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'fshine-core-artifacts-legacy-'));
    const legacyPath = join(legacyDir, 'audit.db');
    let legacyStore: AuditStore | undefined;
    try {
      const legacy = new Database(legacyPath);
      try {
        legacy.exec(
          'CREATE TABLE session_artifacts ('
          + 'ref TEXT NOT NULL, session_id TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, '
          + 'source_task_id TEXT, request_id TEXT, created_at TEXT NOT NULL, status TEXT NOT NULL, path TEXT NOT NULL, '
          + 'PRIMARY KEY (session_id, ref))',
        );
        legacy.prepare(
          'INSERT INTO session_artifacts (ref, session_id, filename, sha256, size, source_task_id, request_id, created_at, status, path) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run('1', 'sess_a', 'old.xlsx', 'oldhash', 10, 'task_old', 'req_old', '2026-10-22T10:00:00.000Z', 'available', '/tmp/old.xlsx');
      } finally {
        legacy.close();
      }

      legacyStore = createSqliteStore(legacyPath);
      const columns = new Set((new Database(legacyPath).prepare('PRAGMA table_info(session_artifacts)').all() as Array<{ name: string }>).map(({ name }) => name));
      expect(columns.has('source_run_id')).toBe(true);
      const old = await legacyStore.sessionArtifacts!.get('sess_a', '1');
      expect(old).toMatchObject({ ref: '1', sourceTaskId: 'task_old', filename: 'old.xlsx' });
      expect('sourceRunId' in old!).toBe(false);

      const current: SessionArtifactRecord = {
        ref: '2', sessionId: 'sess_a', filename: 'new.xlsx', sha256: 'newhash', size: 20,
        sourceTaskId: 'task_new', sourceRunId: 'run_new', requestId: 'req_new',
        createdAt: '2026-10-23T10:00:00.000Z', status: 'available', path: '/tmp/new.xlsx',
      };
      await legacyStore.sessionArtifacts!.insert(current);
      expect(await legacyStore.sessionArtifacts!.get('sess_a', '2')).toEqual(current);
    } finally {
      if (legacyStore) closeStore(legacyStore);
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

describe('task_runs 前向迁移（revision CAS）', () => {
  it('为已有后台运行表补 revision 默认值并支持 CAS 更新', async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'fshine-core-runs-legacy-'));
    const legacyPath = join(legacyDir, 'audit.db');
    let legacyStore: AuditStore | undefined;
    try {
      const legacy = new Database(legacyPath);
      try {
        legacy.exec(
          'CREATE TABLE task_runs ('
          + 'run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, dispatch_key TEXT NOT NULL UNIQUE, principal_id TEXT NOT NULL, session_id TEXT NOT NULL, '
          + 'origin_request_id TEXT NOT NULL, origin_user_event_id TEXT NOT NULL, request TEXT NOT NULL, origin_message TEXT NOT NULL, '
          + 'created_at TEXT NOT NULL, updated_at TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT, ended_at TEXT, deadline TEXT, '
          + 'plan_id TEXT, step_index INTEGER, total_steps INTEGER, last_progress TEXT, result_text TEXT, result_json TEXT, error TEXT, '
          + 'result_event_id TEXT, input_context_json TEXT, delivery_route_json TEXT, metadata_json TEXT, delivery_state TEXT, delivery_json TEXT)',
        );
        legacy.prepare(
          'INSERT INTO task_runs (run_id, task_id, dispatch_key, principal_id, session_id, origin_request_id, origin_user_event_id, request, origin_message, '
          + 'created_at, updated_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run('run_legacy', 'task_legacy', 'dispatch_legacy', 'wecom:user_a', 'sess_a', 'req_a', 'evt_a', '查账', '帮我查账',
          '2026-10-22T10:00:00.000Z', '2026-10-22T10:00:00.000Z', 'queued');
      } finally {
        legacy.close();
      }

      legacyStore = createSqliteStore(legacyPath);
      const revisionColumn = (new Database(legacyPath).prepare('PRAGMA table_info(task_runs)').all() as Array<{ name: string; dflt_value: string | null }>)
        .find((column) => column.name === 'revision');
      expect(revisionColumn).toMatchObject({ name: 'revision', dflt_value: '0' });
      const loaded = await legacyStore.taskRuns!.get('run_legacy');
      expect(loaded).toMatchObject({ runId: 'run_legacy', revision: 0, state: 'queued' });
      expect(await legacyStore.taskRuns!.transition('run_legacy', ['queued'], { state: 'running' }, 0)).toBe(true);
      expect(await legacyStore.taskRuns!.get('run_legacy')).toMatchObject({ revision: 1, state: 'running' });
    } finally {
      if (legacyStore) closeStore(legacyStore);
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

// ── task_runs 的 result_handling_state 前向迁移（P1：pin 判据去 JSON 嗅探）────────
// 迁移前的形状：resultHandling 状态机只活在 metadata_json 里，listPinnedTaskIds 用
// json_extract 嗅探。写入方改名时 typecheck 与测试都不红，生产静默退化成"所有终态
// run 永久 pin"。迁移后该状态是显式列，旧库从 metadata 一次性回填（json_valid 才回填，
// NULL 容忍），二次重开不重复回填出错。
describe('task_runs 前向迁移（result_handling_state 列）', () => {
  /** 迁移前的库：task_runs 已有 revision（上一波形状），没有 result_handling_state。 */
  function seedLegacyTaskRuns(file: string): void {
    const legacy = new Database(file);
    try {
      legacy.exec(
        'CREATE TABLE task_runs ('
        + 'run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, dispatch_key TEXT NOT NULL UNIQUE, principal_id TEXT NOT NULL, session_id TEXT NOT NULL, '
        + 'origin_request_id TEXT NOT NULL, origin_user_event_id TEXT NOT NULL, request TEXT NOT NULL, origin_message TEXT NOT NULL, '
        + 'created_at TEXT NOT NULL, updated_at TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT, ended_at TEXT, deadline TEXT, '
        + 'plan_id TEXT, step_index INTEGER, total_steps INTEGER, last_progress TEXT, result_text TEXT, result_json TEXT, error TEXT, '
        + 'result_event_id TEXT, input_context_json TEXT, delivery_route_json TEXT, metadata_json TEXT, delivery_state TEXT, delivery_json TEXT, '
        + 'revision INTEGER NOT NULL DEFAULT 0)',
      );
      legacy.prepare(
        'INSERT INTO task_runs (run_id, task_id, dispatch_key, principal_id, session_id, origin_request_id, origin_user_event_id, request, origin_message, '
        + 'created_at, updated_at, state, delivery_state, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        'run_legacy_handled', 'task_legacy_handled', 'dispatch_handled', 'wecom:user_a', 'sess_a', 'req_a', 'evt_a', '查账', '帮我查账',
        '2026-10-22T10:00:00.000Z', '2026-10-22T10:05:00.000Z', 'completed', 'sent',
        '{"resultHandling":{"eventId":"evt_handled","requestId":"req_handled","state":"handled"}}',
      );
      legacy.prepare(
        'INSERT INTO task_runs (run_id, task_id, dispatch_key, principal_id, session_id, origin_request_id, origin_user_event_id, request, origin_message, '
        + 'created_at, updated_at, state, delivery_state, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        'run_legacy_processing', 'task_legacy_processing', 'dispatch_processing', 'wecom:user_a', 'sess_a', 'req_a', 'evt_a', '查账', '帮我查账',
        '2026-10-22T10:00:00.000Z', '2026-10-22T10:05:00.000Z', 'completed', 'sent',
        '{"resultHandling":{"eventId":"evt_processing","requestId":"req_processing","state":"processing"}}',
      );
      // 没有 resultHandling 的行：回填保持 NULL（不是空串、不猜）。
      legacy.prepare(
        'INSERT INTO task_runs (run_id, task_id, dispatch_key, principal_id, session_id, origin_request_id, origin_user_event_id, request, origin_message, '
        + 'created_at, updated_at, state, delivery_state, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        'run_legacy_plain', 'task_legacy_plain', 'dispatch_plain', 'wecom:user_a', 'sess_a', 'req_a', 'evt_a', '查账', '帮我查账',
        '2026-10-22T10:00:00.000Z', '2026-10-22T10:05:00.000Z', 'completed', 'sent', '{"inputFiles":[]}',
      );
      // 坏 JSON 的 metadata：json_valid 守卫跳过，重开不炸、列保持 NULL。
      legacy.prepare(
        'INSERT INTO task_runs (run_id, task_id, dispatch_key, principal_id, session_id, origin_request_id, origin_user_event_id, request, origin_message, '
        + 'created_at, updated_at, state, delivery_state, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        'run_legacy_badjson', 'task_legacy_badjson', 'dispatch_badjson', 'wecom:user_a', 'sess_a', 'req_a', 'evt_a', '查账', '帮我查账',
        '2026-10-22T10:00:00.000Z', '2026-10-22T10:05:00.000Z', 'completed', 'sent', 'not-json{',
      );
    } finally {
      legacy.close();
    }
  }

  it('缺列即补 + 从 metadata_json 回填一次（json_valid 才回填），新写入走列，二次重开幂等', async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'fshine-core-rhs-legacy-'));
    const legacyPath = join(legacyDir, 'audit.db');
    let reopened: AuditStore | undefined;
    try {
      seedLegacyTaskRuns(legacyPath);

      reopened = createSqliteStore(legacyPath);
      // ① 列存在
      const columns = new Set((new Database(legacyPath).prepare('PRAGMA table_info(task_runs)').all() as Array<{ name: string }>).map(({ name }) => name));
      expect(columns.has('result_handling_state')).toBe(true);
      // ② 回填正确：handled/processing 回填；无 resultHandling 与坏 JSON 保持 NULL。
      // 坏 JSON 行经 raw SQL 断言——repo.get 会对该行 metadata_json 的 JSON.parse 抛错
      // （既有行为，与本次迁移无关），而"重开不炸"指的是开库这一步本身。
      expect(await reopened.taskRuns!.get('run_legacy_handled')).toMatchObject({ resultHandlingState: 'handled' });
      expect(await reopened.taskRuns!.get('run_legacy_processing')).toMatchObject({ resultHandlingState: 'processing' });
      expect('resultHandlingState' in (await reopened.taskRuns!.get('run_legacy_plain'))!).toBe(false);
      const badJsonColumn = (new Database(legacyPath)
        .prepare('SELECT result_handling_state AS state FROM task_runs WHERE run_id = ?')
        .get('run_legacy_badjson')) as { state: string | null };
      expect(badJsonColumn.state).toBeNull();
      // ③ pin 判据走列：handled+sent 不钉；processing/无状态钉
      expect(await reopened.taskRuns!.listPinnedTaskIds()).toEqual(['task_legacy_badjson', 'task_legacy_plain', 'task_legacy_processing']);
      // ④ 新写入走列（不经 metadata）
      const fresh = makeTaskRun({
        runId: 'run_fresh', taskId: 'task_fresh', dispatchKey: 'dispatch_fresh',
        state: 'completed', deliveryState: 'sent', resultHandlingState: 'handled',
      });
      await reopened.taskRuns!.createOrGetByDispatchKey(fresh);
      expect(await reopened.taskRuns!.get('run_fresh')).toMatchObject({ resultHandlingState: 'handled' });
      // ⑤ transition 可 patch 该列（状态机每次转移同步写列）
      expect(await reopened.taskRuns!.transition('run_fresh', ['completed'], { resultHandlingState: 'failed' })).toBe(true);
      expect(await reopened.taskRuns!.get('run_fresh')).toMatchObject({ resultHandlingState: 'failed' });
      expect(await reopened.taskRuns!.listPinnedTaskIds()).toContain('task_fresh');
    } finally {
      if (reopened) closeStore(reopened);
    }

    // ⑥ 二次重开：回填幂等（已回填的不动，NULL 的不误填），数据仍可读
    let second: AuditStore | undefined;
    try {
      second = createSqliteStore(legacyPath);
      expect(await second.taskRuns!.get('run_legacy_handled')).toMatchObject({ resultHandlingState: 'handled' });
      expect(await second.taskRuns!.get('run_legacy_processing')).toMatchObject({ resultHandlingState: 'processing' });
      expect('resultHandlingState' in (await second.taskRuns!.get('run_legacy_plain'))!).toBe(false);
      const badJsonSecond = (new Database(legacyPath)
        .prepare('SELECT result_handling_state AS state FROM task_runs WHERE run_id = ?')
        .get('run_legacy_badjson')) as { state: string | null };
      expect(badJsonSecond.state).toBeNull();
      expect(await second.taskRuns!.get('run_fresh')).toMatchObject({ resultHandlingState: 'failed' });
    } finally {
      if (second) closeStore(second);
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
