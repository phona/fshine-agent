/**
 * Wave1 runner 入口冒烟（2026-11-18）：防"胶水腐烂"。
 *
 * 背景：`wave1-runner.ts` 是 R6 长会话读数的唯一手工入口，没有任何 npm script / CI / 测试
 * 调用它——纯逻辑（参数解析、推进决策、结构泄漏聚合）在 `wave1-support.ts` 有单测，但 558 行
 * 入口胶水一旦漂移（改了 CLI、改了 main 的异常出口），全量门仍然全绿，直到下次要取读数时才炸。
 *
 * 本用例只跑**参数失败路径**：不建会话、不调模型、不写 .runtime 下的运行产物。
 * 断言三条：①坏参数必须非零退出；②必须打印可识别的失败前缀与具体原因；③不得产出运行摘要
 * （stdout 里出现 "sessions" 就说明它真的跑起来了 —— 那才是这条冒烟要拦的回归）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const RUNNER = path.join(REPO_ROOT, 'scripts/eval/long-session/wave1-runner.ts');

function runWith(args: readonly string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', RUNNER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    // 故意给不可路由的模型端点与空密钥：即便入口漂移到"先跑再校验"，也只会快速失败，不会真的打模型。
    env: {
      ...process.env,
      TMPDIR: '/home/tao/.tmp',
      LLM_API_KEY: '',
      LLM_API_BASE_URL: 'http://127.0.0.1:9/v1',
      LLM_MODEL: 'smoke-no-model',
    },
  });
}

describe('Wave1 runner 入口冒烟（不调模型）', () => {
  it('非法 --track：非零退出 + 打印失败原因，且没有产出运行摘要', () => {
    const result = runWith(['--track=XX']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('r6 wave1 runner 失败');
    expect(result.stderr).toContain('--track 无效');
    expect(result.stdout).not.toContain('"sessions"');
  });

  it('非法 --concurrency：非零退出 + 打印失败原因，且没有产出运行摘要', () => {
    const result = runWith(['--concurrency=0']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('r6 wave1 runner 失败');
    expect(result.stderr).toContain('--concurrency 需要正整数');
    expect(result.stdout).not.toContain('"sessions"');
  });
});
