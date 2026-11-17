/**
 * P1-T03 ask 输出显示面：数字编号 + 业务名称（机械证据行）；UUID 不进业务展示位。
 *
 * ask 入口无法在单测里起真实模型；这里钉住两件事：
 *   · 证据行渲染函数金样（ask.ts 与测试消费同一函数）：有委派=「任务=#编号 名称」，
 *     无委派=「（无委派）」；UUID（task_*）只出现在逐条执行证据 JSON 里，不在本行；
 *   · import 无副作用（import.meta.main 守卫）：被 import（测试/复用）时不执行 CLI 主体。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderAskEvidenceLines } from './ask';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('ask：机械证据行（#编号 + 业务名称）', () => {
  it('金样：有委派显示 任务=#编号 名称；无委派显示（无委派）', () => {
    const lines = renderAskEvidenceLines({
      principalId: 'wecom:fixture-user',
      sessionId: 'ask-2026-11-14',
      task: { taskNo: 3, name: '帮我查一下 beta 集合、窗口 W1 的数据', request: '帮我查一下 beta 集合、窗口 W1 的数据' },
      executionCount: 1,
      completedCount: 1,
      auditLineCount: 3,
      elapsedSeconds: '1.2',
    });
    expect(lines).toEqual([
      'principal=wecom:fixture-user session=ask-2026-11-14 委派=是',
      '任务=#3 帮我查一下 beta 集合、窗口 W1 的数据 结构化执行=1 次（完成 1） dummy 审计=3 行 用时=1.2s',
    ]);
    expect(lines.join('\n')).not.toContain('taskId=');

    const none = renderAskEvidenceLines({
      principalId: 'p',
      sessionId: 's',
      executionCount: 0,
      completedCount: 0,
      auditLineCount: 0,
      elapsedSeconds: '0.4',
    });
    expect(none[1]).toBe('任务=（无委派） 结构化执行=0 次（完成 0） dummy 审计=0 行 用时=0.4s');
  });

  it('名称缺失时机械回落任务原文首段；编号缺失不崩溃（旧库只读面）', () => {
    const lines = renderAskEvidenceLines({
      principalId: 'p',
      sessionId: 's',
      task: { request: '历史任务：查 beta 的明细数据' },
      executionCount: 1,
      completedCount: 0,
      auditLineCount: 0,
      elapsedSeconds: '0.5',
    });
    expect(lines[1]).toContain('任务=（无编号） 历史任务：查 beta 的明细数据');
  });
});

describe('ask：import 无副作用（import.meta.main 守卫）', () => {
  it('import scripts/ask.ts 不执行 CLI 主体、不打任何输出', () => {
    const probe = spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', "await import('./scripts/ask.ts'); console.log('IMPORT-DONE');"],
      { cwd: REPO_ROOT, env: { ...process.env, AGENT_CONFIG_PATH: '' }, encoding: 'utf8' },
    );
    expect(probe.status).toBe(0);
    expect(probe.stdout).toBe('IMPORT-DONE\n');
    expect(probe.stderr).toBe('');
  });
});
