/**
 * R5：渠道无关落盘 sink（生产可用缺省；真实企微 sink 仍 blocked，不接真实平台）。
 *
 * 通知按 JSON Lines 追加写到部署侧日志文件（缺省与任务库同目录 notifications.jsonl）；
 * 写失败返回未送达（outbox 有界重试兜底），不抛出（投递与任务事实解耦）。
 */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Notification, NotificationSink } from '../../packages/agent/src/notifications';

export function createFileNotificationSink(logPath: string): NotificationSink {
  let dirReady: Promise<void> | undefined;
  const ensureDir = async (): Promise<void> => {
    dirReady ??= mkdir(path.dirname(logPath), { recursive: true }).then(() => undefined);
    await dirReady;
  };
  return {
    async send(notification: Notification) {
      try {
        await ensureDir();
        await appendFile(
          logPath,
          `${JSON.stringify({
            at: new Date().toISOString(),
            id: notification.id,
            taskId: notification.taskId,
            kind: notification.kind,
            payload: notification.payload,
          })}\n`,
          'utf8',
        );
        return { delivered: true };
      } catch (error) {
        return { delivered: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
