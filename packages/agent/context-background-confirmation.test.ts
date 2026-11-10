import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ChangeIntentRecord, ChangeIntentRepo, PlatformTaskRepo, TrustedContext } from '@fshine/contracts';
import { createContextTaskRunner } from './src/context';
import type { TurnDriver } from './src/driver';
import { createPlatformExecutionGate } from './src/platform-execution-gate';

const CODE = 'ABC123';
const HASH = createHash('sha256').update(CODE).digest('hex');
const now = new Date();

class MemoryIntents implements ChangeIntentRepo {
  record: ChangeIntentRecord = {
    intentId: 'intent-1',
    principalId: 'wecom:user-1',
    sessionId: 'session-1',
    taskId: 'task-origin',
    proposalId: 'proposal-opaque',
    confirmCodeHash: HASH,
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  };
  async create(record: ChangeIntentRecord) { this.record = structuredClone(record); }
  async get(intentId: string) { return intentId === this.record.intentId ? structuredClone(this.record) : null; }
  async findPendingByConfirm(principalId: string, sessionId: string, codeHash: string, at: Date) {
    if (this.record.status !== 'pending' || this.record.principalId !== principalId || this.record.sessionId !== sessionId || this.record.confirmCodeHash !== codeHash) return null;
    if (Date.parse(this.record.expiresAt) <= at.getTime()) {
      this.record.status = 'expired';
      return null;
    }
    return structuredClone(this.record);
  }
  async findPendingBySession(principalId: string, sessionId: string, taskId?: string) {
    return this.record.status === 'pending'
      && this.record.principalId === principalId
      && this.record.sessionId === sessionId
      && (!taskId || this.record.taskId === taskId)
      ? structuredClone(this.record)
      : null;
  }
  async findByCodeHash(principalId: string, sessionId: string, codeHash: string) {
    return this.record.principalId === principalId && this.record.sessionId === sessionId && this.record.confirmCodeHash === codeHash
      ? structuredClone(this.record)
      : null;
  }
  async updateStatus(intentId: string, status: ChangeIntentRecord['status'], result?: unknown) {
    if (intentId !== this.record.intentId) return;
    this.record = { ...this.record, status, ...(result === undefined ? {} : { result }) };
  }
}

const tasks: PlatformTaskRepo = {
  get: async () => null,
  upsert: async () => {},
  listBySession: async () => [],
};

function context(): TrustedContext {
  return { requestId: 'request-1', principalId: 'wecom:user-1', sessionId: 'session-1' };
}

function createRunner(args: { gate?: ReturnType<typeof createPlatformExecutionGate>; commit?: () => Promise<void> } = {}) {
  const intents = new MemoryIntents();
  const gate = args.gate ?? createPlatformExecutionGate({ maxQueue: 4 });
  const commit = vi.fn(async () => {
    await args.commit?.();
    return { ok: true, verified: true, summaryText: '平台提交已完成。', output: 'mock commit output' };
  });
  const runner = createContextTaskRunner({
    profiles: { 'example-gateway': { root: '/tmp', skillRoots: [] } },
    tasks,
    workerDriver: { run: async (): Promise<{ text: string; messages: [] }> => ({ text: 'unused', messages: [] }) } as unknown as TurnDriver,
    executionGate: gate,
    changeIntents: intents,
    proposalCommitRunner: commit,
  });
  return { runner, gate, intents, commit };
}

describe('background host confirmation preparation', () => {
  it('creates an opaque prepared commit handle and executes under the manager-owned gate lease', async () => {
    const setup = createRunner();
    const prepared = await setup.runner.prepareConfirmation!(context(), `确认 ${CODE}`);
    expect(prepared).not.toBeNull();
    expect(prepared?.taskId).toBe('task-origin');
    expect(prepared?.request).not.toContain(CODE);
    expect(setup.commit).not.toHaveBeenCalled();

    const ticket = setup.gate.enqueue({ requestId: 'request-1' });
    const lease = await ticket.acquired;
    lease.start();
    try {
      const result = await prepared!.execute({ lease, startedAt: Date.now(), deadline: Date.now() + 1_000, background: true, backgroundRunId: 'run-1' });
      expect(result).toMatchObject({ taskId: 'task-origin', hostConfirmationOutcome: 'confirm_executed', text: '平台提交已完成。\n确认码已核销，落账已完成。' });
    } finally {
      lease.release();
    }
    expect(setup.commit).toHaveBeenCalledTimes(1);
    expect(setup.intents.record.status).toBe('committed');
  });

  it('rechecks pending state after queueing and never commits a superseded proposal', async () => {
    const setup = createRunner();
    const prepared = await setup.runner.prepareConfirmation!(context(), `确认 ${CODE}`);
    setup.intents.record.status = 'superseded';
    const ticket = setup.gate.enqueue({ requestId: 'request-1' });
    const lease = await ticket.acquired;
    lease.start();
    try {
      const result = await prepared!.execute({ lease, startedAt: Date.now(), deadline: Date.now() + 1_000, background: true });
      expect(result.hostConfirmationOutcome).toBe('confirm_stale');
      expect(result.text).toContain('已被更新的提案取代');
    } finally {
      lease.release();
    }
    expect(setup.commit).not.toHaveBeenCalled();
  });

  it('inline confirmation no longer waits behind a running Worker (concurrency belongs to the execution layer)', async () => {
    const gate = createPlatformExecutionGate({ maxQueue: 4 });
    const setup = createRunner({ gate });
    const workerTicket = gate.enqueue({ requestId: 'active-worker' });
    const workerLease = await workerTicket.acquired;
    workerLease.start();

    // 2026-11-10 仲裁：宿主准入闸不再串行化平台作业。确认回合立即拿到自己的槽位并落账，
    // 不需要等别的会话 worker 释放——平台并发容忍由执行层自己的限流/熔断裁决。
    const reply = await setup.runner.matchConfirmation!(context(), `确认 ${CODE}`);
    expect(reply?.outcome).toBe('confirm_executed');
    expect(setup.commit).toHaveBeenCalledTimes(1);
    expect(gate.snapshot()).toEqual({ active: 1, queued: 0 });

    workerLease.release();
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });
});
