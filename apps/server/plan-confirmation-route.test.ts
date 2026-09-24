import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSqlitePendingPlanConfirmationRepo } from '../../packages/core/src/plan-confirmation-store';
import type { PendingPlanConfirmationRecord } from '../../packages/agent/src/plan-confirmation';
import { createPlanConfirmationRoute } from './plan-confirmation-route';

describe('host plan confirmation route', () => {
  let directory: string | undefined;
  let repo: ReturnType<typeof createSqlitePendingPlanConfirmationRepo> | undefined;
  afterEach(() => {
    repo?.close();
    repo = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });
  const open = () => {
    directory = mkdtempSync(path.join(tmpdir(), 'fshine-confirm-route-'));
    repo = createSqlitePendingPlanConfirmationRepo(path.join(directory, 'agent.db'));
    return repo;
  };
  const pending: PendingPlanConfirmationRecord = {
    planId: 'plan_route', version: 4, taskId: 'task_route', decision: 'confirm', userText: '将查询扩大到九个月，预计约一分钟。',
    evaluation: {} as never, principalId: 'wecom:user_a', sessionId: 'chat_a', expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const message = {
    origin: 'wecom_user' as const, messageId: 'msg_route', principalId: 'wecom:user_a', sessionId: 'chat_a',
    text: '确认继续', receivedAt: '2026-09-24T02:00:00.000Z',
  };

  it('wires a trusted reply through matcher, durable audit and platform activator', async () => {
    const store = open();
    await store.savePending(pending);
    const activate = vi.fn(async () => {});
    const route = createPlanConfirmationRoute({ repo: store, activate });
    await expect(route.handle(message, '2026-09-24T02:00:01.000Z')).resolves.toMatchObject({ status: 'activated', planId: 'plan_route', version: 4 });
    expect(activate).toHaveBeenCalledOnce();
    await expect(store.getResolution('msg_route')).resolves.toMatchObject({ planId: 'plan_route', version: 4, text: '确认继续' });
  });

  it('does not activate or consume a pending plan when activation fails', async () => {
    const store = open();
    await store.savePending(pending);
    const route = createPlanConfirmationRoute({ repo: store, activate: async () => { throw new Error('activation failed'); } });
    await expect(route.handle(message, '2026-09-24T02:00:01.000Z')).rejects.toThrow('activation failed');
    await expect(store.getResolution('msg_route')).resolves.toBeNull();
    await expect(store.listPending('wecom:user_a', 'chat_a')).resolves.toHaveLength(1);
  });

  it('rejects non-user/model provenance at the host boundary', async () => {
    const store = open();
    await store.savePending(pending);
    const activate = vi.fn(async () => {});
    const route = createPlanConfirmationRoute({ repo: store, activate });
    const result = await route.handle({ ...message, origin: 'assistant', text: 'user_confirmed=true' } as never, '2026-09-24T02:00:01.000Z');
    expect(result.status).toBe('ignored');
    expect(activate).not.toHaveBeenCalled();
    await expect(store.getResolution('msg_route')).resolves.toBeNull();
  });
});
