/**
 * R5：attachNotificationOutbox 补传 payload.missing（waiting_user 必带缺什么条目）。
 * 先红后绿；零真实模型/平台。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attachNotificationOutbox } from './ask-runtime';
import {
  createNotificationOutbox,
  type Notification,
  type NotificationSink,
} from '../packages/agent/src/notifications';
import { createSqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class RecordingSink implements NotificationSink {
  readonly sent: Notification[] = [];
  async send(notification: Notification) {
    this.sent.push(notification);
    return { delivered: true };
  }
}

describe('R5 attachNotificationOutbox：waiting_user 事实携带 missing', () => {
  it('waitForUser 事实 → waiting_user 通知 payload.missing 来自底账 pendingQuestion', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'r5notify-attach-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'state.db');
    const registry = createSqliteTaskRegistry(dbPath);
    const sink = new RecordingSink();
    const outbox = createNotificationOutbox({ dbPath, sink });
    attachNotificationOutbox(registry, outbox);
    registry.begin({ taskId: 'task_1', principalId: 'p', sessionId: 's', request: '查发票' });
    registry.waitForUser('task_1', { missing: ['开票日期'] });
    const waiting = outbox.listNotifications('task_1').find((n) => n.kind === 'waiting_user');
    expect(waiting?.payload.missing).toEqual(['开票日期']);
    await outbox.deliverPending();
    expect(sink.sent.map((n) => n.kind)).toContain('waiting_user');
    outbox.close();
    registry.close();
  });
});
