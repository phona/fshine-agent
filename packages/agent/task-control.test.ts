import { describe, expect, it, vi } from 'vitest';
import type { TaskRunRecord } from '@fshine/contracts';
import { executeTaskControl, renderTaskRoster } from './src/task-control';

function run(overrides: Partial<TaskRunRecord>): TaskRunRecord {
  return {
    runId: 'run_new', taskId: 'task_one', dispatchKey: 'dispatch_new',
    principalId: 'principal', sessionId: 'session', originRequestId: 'request',
    originUserEventId: 'event', request: '整理资料', originMessage: '整理资料',
    state: 'running', createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('task control latest registered run', () => {
  const newer = run({});
  const older = run({ runId: 'run_old', dispatchKey: 'dispatch_old', state: 'completed', updatedAt: '2099-01-01T00:00:00.000Z' });

  it('old delivery updates cannot replace the active run in task lists', async () => {
    const result = await executeTaskControl({ list: async () => [newer, older], get: vi.fn(), cancel: vi.fn() },
      { principalId: 'principal', sessionId: 'session' }, { action: 'list' });
    expect(result['tasks']).toMatchObject([{ runId: 'run_new', state: 'running' }]);
  });

  it('the Planner roster uses registration order even when timestamps are identical', () => {
    const roster = renderTaskRoster([newer, { ...older, updatedAt: newer.updatedAt }]);
    expect(roster).toContain('runId=run_new');
    expect(roster).not.toContain('runId=run_old');
  });
});
