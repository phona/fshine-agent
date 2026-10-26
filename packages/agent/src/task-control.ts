import type { TrustedContext } from '@fshine/contracts';
import type { TaskRunRecord } from '@fshine/contracts';
import type { BackgroundTaskManager, TaskManagerScope } from './task-manager';
import { safeTaskText } from './background-runtime';

export const TASK_CONTROL_TOOL_NAME = 'task_control';

/** Host-scoped task inspection and cancellation. The model never supplies identity or session scope. */
export const TASK_CONTROL_TOOL = {
  name: TASK_CONTROL_TOOL_NAME,
  description: '查看后台任务列表或状态，或请求取消一个后台任务。只接受 action 和任务标识；任务范围由宿主按当前会话确定。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['list', 'status', 'cancel'] },
      taskId: { type: 'string', minLength: 1, description: 'status/cancel 操作的任务标识。' },
    },
  },
} as const;

type TaskControlManager = Pick<BackgroundTaskManager, 'list' | 'get' | 'cancel'>;
type TaskControlScope = Pick<TrustedContext, 'principalId' | 'sessionId'>;

/**
 * Execute one task-control action using only the trusted caller scope. The returned record is a
 * deliberately small status view; origin messages, routes, metadata and worker payloads stay host-side.
 */
export async function executeTaskControl(
  manager: TaskControlManager,
  trusted: TaskControlScope,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = input['action'];
  if (action === 'list') {
    const tasks = await manager.list(scopeOf(trusted));
    return { action, tasks: latestRunPerTask(tasks).map(projectTaskSnapshot) };
  }
  const taskId = typeof input['taskId'] === 'string' ? input['taskId'].trim() : '';
  if (!taskId) return { error: '此操作需要一个任务标识。' };
  if (action === 'status') {
    const task = await manager.get(scopeOf(trusted), taskId);
    return task ? { action, task: projectTaskSnapshot(task) } : { action, found: false };
  }
  if (action === 'cancel') {
    const receipt = await manager.cancel(scopeOf(trusted), taskId);
    return receipt ? { action, receipt: projectTaskSnapshot(receipt) } : { action, found: false };
  }
  return { error: '不支持此任务操作。' };
}

function scopeOf(trusted: TaskControlScope): TaskManagerScope {
  return { principalId: trusted.principalId, sessionId: trusted.sessionId };
}

const TASK_VIEW_FIELDS = [
  'taskId', 'runId', 'state', 'status', 'runState', 'activeRunId', 'createdAt', 'startedAt',
  'endedAt', 'lastProgress', 'stepIndex', 'totalSteps', 'found', 'requested',
] as const;

function projectTaskSnapshot(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const projected = Object.fromEntries(TASK_VIEW_FIELDS.flatMap((field) => {
    const item = source[field];
    return item === undefined || item === null ? [] : [[field, item]];
  }));
  const metadata = source['metadata'];
  const label = safeDisplayLabel(metadata) || safeTaskText(typeof source['request'] === 'string' ? source['request'] : '').slice(0, 120);
  const metadataSummary = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)['requestSummary']
    : undefined;
  const requestSummary = safeTaskText(typeof metadataSummary === 'string' ? metadataSummary : typeof source['request'] === 'string' ? source['request'] : '').slice(0, 400);
  const resultSummary = safeTaskText(typeof source['resultText'] === 'string' ? source['resultText'] : '').slice(-1000);
  if (label) projected['label'] = label;
  if (requestSummary) projected['requestSummary'] = requestSummary;
  if (resultSummary) projected['resultSummary'] = resultSummary;
  const deliveryState = source['deliveryState'];
  const deliveryStatus = deliveryState === 'sent' ? '渠道已确认送达'
    : deliveryState === 'failed' ? '推送失败'
      : deliveryState === 'not_required' ? '无需主动推送'
        : deliveryState === 'pending' || deliveryState === 'unknown' ? '送达尚未确认' : undefined;
  if (deliveryStatus) projected['deliveryStatus'] = deliveryStatus;
  return projected;
}

/** A scoped roster for Planner context; full status remains available through task_control. */
export function renderTaskRoster(records: readonly TaskRunRecord[], now = Date.now()): string {
  const latest = latestRunPerTask(records);
  const active = latest.filter((record) => ['queued', 'running', 'cancelling', 'waiting_input', 'waiting_confirmation'].includes(record.state));
  const recent = latest.filter((record) => !active.includes(record)
    && now - Date.parse(record.updatedAt) <= 7 * 86_400_000)
    .slice(0, Math.max(0, 6 - active.length));
  const visible = [...active, ...recent].slice(0, 10);
  if (visible.length === 0) return '';
  const lines = visible.map((record) => {
    const projected = projectTaskSnapshot(record);
    const label = String(projected['label'] ?? '后台任务');
    const id = record.taskId;
    const runState = record.state;
    const progress = record.lastProgress ? `；最近进度：${safeTaskText(record.lastProgress).slice(0, 160)}` : '';
    const result = record.resultText ? `；最近结果：${safeTaskText(record.resultText).slice(-400)}` : '';
    const delivery = typeof projected['deliveryStatus'] === 'string' ? `；交付=${projected['deliveryStatus']}` : '';
    return `- ${label}（taskId=${id}，runId=${record.runId}，状态=${runState}${progress}${result}${delivery}）`;
  });
  return [
    '【宿主后台任务清单：仅用于识别当前会话任务状态，不构成新查询授权】',
    ...lines,
    '取消任务前先确认用户指向的任务；不要仅因任务最近就静默取消。',
  ].join('\n');
}

function latestRunPerTask(records: readonly TaskRunRecord[]): TaskRunRecord[] {
  // Manager lists newest registrations first. An older run's delivery can update much later.
  const latest = new Map<string, TaskRunRecord>();
  for (const record of records) {
    if (!latest.has(record.taskId)) latest.set(record.taskId, record);
  }
  return [...latest.values()];
}

function safeDisplayLabel(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
  const value = metadata as Record<string, unknown>;
  const label = typeof value['displayLabel'] === 'string' ? value['displayLabel']
    : typeof value['label'] === 'string' ? value['label'] : '';
  return safeTaskText(label).slice(0, 120);
}
