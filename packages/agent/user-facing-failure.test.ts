/**
 * 用户可见失败话术（`user-facing-failure.ts`）的判据。
 *
 * owner 2026-11-19：「这些东西告诉给用户，他啥都干不了，跟他说，他还不愿意看，也不知道怎么办」
 * → 用户侧只允许「业务语言说清发生了什么 + 一个他能做的动作」；执行层原文与内部术语进日志。
 *
 * 本套件钉三件事：
 *   ① 归类只看码/状态（不看文案语义），我方故障码必须落 `host_fault`（不解释内部）；
 *   ② 每种失败话术都带至少一个用户可执行的动作，且**全部话术都不含内部术语**；
 *   ③ 内部术语闸能命中内部形态、且不误伤业务句子。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  failureMessageFor,
  internalTermIn,
  type UserFacingFailureKind,
} from './src/user-facing-failure';

const ALL_KINDS: readonly UserFacingFailureKind[] = [
  'needs_confirmation',
  'needs_input',
  'not_found',
  'denied',
  'invalid_input',
  'executor_failed',
  'host_fault',
  'unknown_result',
  'timed_out',
];

describe('用户可见失败话术', () => {
  it('① 归类只看码/状态：权限、不存在、口径、补充、执行端失败各归各位', () => {
    expect(classifyFailure({ code: 'GATE_REFUSE' })).toBe('denied');
    expect(classifyFailure({ code: 'COLLECTION_NOT_FOUND' })).toBe('not_found');
    expect(classifyFailure({ code: 'WHERE_INVALID' })).toBe('invalid_input');
    expect(classifyFailure({ code: 'QUERY_REQUIRED' })).toBe('invalid_input');
    expect(classifyFailure({ code: 'CONFIRMATION_REQUIRED' })).toBe('needs_confirmation');
    expect(classifyFailure({ code: 'COLLECTION_FAULT' })).toBe('executor_failed');
    expect(classifyFailure({ code: 'SOMETHING_NEW' })).toBe('executor_failed');
    expect(classifyFailure({ status: 'result_unknown' })).toBe('unknown_result');
  });

  it('② 我方故障码一律 host_fault：协议违约、句柄丢失、令牌不匹配都不向用户解释', () => {
    for (const code of ['EXECUTION_PROTOCOL_VIOLATION', 'CONFIRMATION_NOT_FOUND', 'PROPOSAL_TOKEN_UNTRUSTED', 'PROPOSAL_REFUSE']) {
      expect(classifyFailure({ code }), code).toBe('host_fault');
    }
    const message = failureMessageFor('host_fault');
    expect(message.text).toContain('没弄好');
    expect(message.text.length).toBeLessThanOrEqual(30);
    expect(message.actions.length).toBeGreaterThan(0);
  });

  it('③ 每种失败都带可执行动作，且话术里没有任何内部术语（逐条过闸）', () => {
    for (const kind of ALL_KINDS) {
      const message = failureMessageFor(kind, {
        subject: 'alpha 集合',
        missing: ['窗口编号'],
        summary: '向 alpha 集合 W1 新增 2 条记录',
      });
      expect(message.actions.length, `${kind} 没有可执行动作`).toBeGreaterThan(0);
      expect(message.actions).not.toContain('none');
      expect(message.text.length).toBeGreaterThan(0);
      // 关键不变量：话术本身绝不能命中内部术语闸。
      expect(internalTermIn(message.text), `${kind} 话术含内部术语：${message.text}`).toBeUndefined();
      // 简短（owner：「像真人回复」）：一句话说完；含摘要/缺失项的两种允许带上业务内容。
      if (kind !== 'needs_confirmation' && kind !== 'needs_input') {
        expect(message.text.length, `${kind} 话术太长：${message.text}`).toBeLessThanOrEqual(40);
      }
    }
  });

  it('④ 话术落到业务语言：给出对象/缺什么/摘要，不编内部细节', () => {
    expect(failureMessageFor('not_found', { subject: 'contract-archive 集合' }).text).toContain('contract-archive 集合');
    expect(failureMessageFor('needs_input', { missing: ['窗口编号', '客户名称'] }).text).toContain('窗口编号、客户名称');
    expect(failureMessageFor('needs_confirmation', { summary: '向 alpha 集合 W1 新增 2 条记录' }).text)
      .toContain('向 alpha 集合 W1 新增 2 条记录');
    // 缺信息但拿不到明细时不编：如实说"具体缺什么没拿到"。
    expect(failureMessageFor('needs_input').text).toContain('没拿到');
    expect(failureMessageFor('unknown_result').text).toContain('不确定做没做完');
  });

  it('⑤ 内部术语闸：命中内部形态，不误伤业务句子', () => {
    const shouldHit = [
      '执行层这次没返回句柄',
      '提交时缺少确认凭据',
      '令牌不匹配或已过期',
      '能力清单里标记为长时间运行操作',
      '这个 operation 不在允许集合',
      '任务 task_71d08976-4b7e-4041-8976-6aeac6eeecef 失败',
      '报错文件 /home/tao/projects/x/y.ts',
    ];
    for (const text of shouldHit) expect(internalTermIn(text), text).toBeDefined();

    const shouldMiss = [
      'alpha 集合 W1 共 2 条记录，合计 2000。',
      '没找到 contract-archive 集合。要我换个范围再找一次？',
      '要写入：向 alpha 集合 W1 新增 2 条记录。回「确认」我就提交。',
      '这次没办成，是我这边的问题。要我重试一次，还是先记下来让人来看？',
    ];
    for (const text of shouldMiss) expect(internalTermIn(text), text).toBeUndefined();
  });
});
