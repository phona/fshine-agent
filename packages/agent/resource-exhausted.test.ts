/**
 * 资源耗尽（RESOURCE_EXHAUSTED）终稿合成的直测（"失败必达"路径 1，R3：不起 driver
 * harness，只 import 被测模块 + 纯数据 + 内存假 repo）。
 *
 * 判据钉三件事：
 *   ① 底账挑选：优先显式 taskId，否则最近一条 failed；存储缺席/抛错降级为 null；
 *   ② 终稿三要素固定在场（已完成部分 / 未完成部分 / 续跑入口），事实在场时逐行落、
 *      全部缺席时如实说"没有可确认的已完成产出"（不编造）；
 *   ③ 措辞卫生：零 id 形状、零错误码形状、分类词（RESOURCE_EXHAUSTED）只进审计不进
 *      用户文本。
 */
import { describe, expect, it, vi } from 'vitest';
import type { PlatformTaskRecord } from '@fshine/contracts';
import {
  loadTimedOutRecord,
  pickTimedOutRecord,
  renderResourceExhaustedReply,
  RESOURCE_EXHAUSTED_CLASS,
} from './src/resource-exhausted';
import { messageTextFor } from './src/error-codes';

function record(overrides: Partial<PlatformTaskRecord> = {}): PlatformTaskRecord {
  return {
    taskId: 'task_a',
    parentSessionId: 'sess',
    principalId: 'user',
    workerMessages: [],
    createdAt: '2026-10-18T07:00:00.000Z',
    updatedAt: '2026-10-18T07:15:00.000Z',
    outcome: 'failed',
    ...overrides,
  };
}

describe('pickTimedOutRecord', () => {
  it('显式 taskId 优先：continueTaskId/resumeTaskId 指认的条目即使不是最近失败也选中', () => {
    const records = [
      record({ taskId: 'task_old', outcome: 'failed' }),
      record({ taskId: 'task_mid', outcome: 'done' }),
      record({ taskId: 'task_new', outcome: 'failed' }),
    ];
    expect(pickTimedOutRecord(records, 'task_old')?.taskId).toBe('task_old');
  });

  it('无显式 taskId：取最近一条 failed（context.ts 先落账再抛话术，最近失败即刚超时）', () => {
    const records = [
      record({ taskId: 'task_old', outcome: 'failed' }),
      record({ taskId: 'task_mid', outcome: 'done' }),
      record({ taskId: 'task_new', outcome: 'failed' }),
    ];
    expect(pickTimedOutRecord(records)?.taskId).toBe('task_new');
  });

  it('显式 taskId 查不到时回落时间序最近失败（不空手而归）', () => {
    const records = [record({ taskId: 'task_old', outcome: 'failed' })];
    expect(pickTimedOutRecord(records, 'task_missing')?.taskId).toBe('task_old');
  });

  it('全部结局都不是 failed：返回 null（不猜）', () => {
    const records = [record({ taskId: 'task_a', outcome: 'done' })];
    expect(pickTimedOutRecord(records)).toBeNull();
  });
});

describe('loadTimedOutRecord', () => {
  it('存储未注入（undefined）：null，不抛', async () => {
    await expect(loadTimedOutRecord(undefined, 'user', 'sess')).resolves.toBeNull();
  });

  it('存储抛错：null + 降级日志，不失败回合', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const repo = { listBySession: async () => { throw new Error('db locked'); } };
      await expect(loadTimedOutRecord(repo, 'user', 'sess', 'task_a', 'req_1')).resolves.toBeNull();
      const logged = errSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(logged).toContain('resource_exhausted_record_lookup_failed');
      expect(logged).toContain('db locked');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('正常路径：把 listBySession 的结果交给挑选判据（显式 taskId 优先）', async () => {
    const records = [record({ taskId: 'task_a', outcome: 'failed' }), record({ taskId: 'task_b', outcome: 'failed' })];
    const repo = { listBySession: async () => records };
    await expect(loadTimedOutRecord(repo, 'user', 'sess', 'task_a')).resolves.toMatchObject({ taskId: 'task_a' });
    await expect(loadTimedOutRecord(repo, 'user', 'sess')).resolves.toMatchObject({ taskId: 'task_b' });
  });
});

describe('renderResourceExhaustedReply', () => {
  it('底账带结构化事实：已完成部分逐行落（已执行操作含 label 与执行层声明的范围取值）', () => {
    const text = renderResourceExhaustedReply({
      record: record({
        label: '工资表计算',
        scopeValues: ['幻辰财税', '202609'],
        calls: [{ operation: 'payroll.compute', args: [] }],
      }),
      doneSteps: [],
    });
    expect(text).toContain('[资源超时]');
    expect(text).toContain('已完成部分');
    expect(text).toContain('已执行操作：工资表计算（幻辰财税 202609）');
    expect(text).toContain('未完成部分');
    expect(text).toContain('回复“继续”可从断点续跑');
  });

  it('范围取值缺席（旧任务 / 执行层没声明）：只落 label，不补空格不猜——拿不到就降级', () => {
    const text = renderResourceExhaustedReply({
      record: record({ label: '工资表计算', calls: [{ operation: 'payroll.compute', args: [] }] }),
      doneSteps: [],
    });
    expect(text.split('\n')).toContain('· 已执行操作：工资表计算');
  });

  it('本回合已完成计划步骤逐行列出', () => {
    const text = renderResourceExhaustedReply({
      record: null,
      doneSteps: ['第1/3步：查合同', '第2/3步：算工资'],
    });
    expect(text).toContain('· 已完成步骤：第1/3步：查合同');
    expect(text).toContain('· 已完成步骤：第2/3步：算工资');
  });

  it('续跑任务的此前结果原文带上（截断到单行预算）', () => {
    const long = 'x'.repeat(400);
    const text = renderResourceExhaustedReply({
      record: record({ resultText: long }),
      doneSteps: [],
    });
    expect(text).toMatch(/此前已取得的结果：x{160}…/);
  });

  it('零事实（替身 worker 没提交过计划、底账无结构化字段）：如实说没有可确认产出，不编造', () => {
    const text = renderResourceExhaustedReply({ record: record(), doneSteps: [] });
    expect(text).toContain('本轮暂无可确认的已完成产出');
    expect(text).toContain('已发生的工作痕迹已保留');
    expect(text).not.toContain('已执行操作');
  });

  it('底账完全缺席（null）：仍产出三要素齐全的终稿，绝不回落"请稍后重试"', () => {
    const text = renderResourceExhaustedReply({ record: null, doneSteps: [] });
    expect(text).toContain('已完成部分');
    expect(text).toContain('未完成部分');
    expect(text).toContain('继续');
    expect(text).not.toBe(messageTextFor('DELEGATION_TIMEOUT_FAILURE'));
    expect(text).not.toContain('请稍后重试');
  });

  it('措辞卫生：无 id 形状（task_/plan_）、无错误码形状、协议分类词不进用户文本', () => {
    const text = renderResourceExhaustedReply({
      record: record({ taskId: 'task_abc-123', label: '工资表计算' }),
      doneSteps: [],
    });
    expect(text).not.toMatch(/\btask_[\w-]+\b/);
    expect(text).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
    expect(text).not.toContain(RESOURCE_EXHAUSTED_CLASS);
    expect(text).not.toMatch(/candidates\s*:|[{}]/);
  });
});
