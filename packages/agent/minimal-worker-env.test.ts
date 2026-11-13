/**
 * B 类凭据隔离回归锁（M1 最小形状）：执行层子进程 env 只保留 worker 白名单键。
 * 白名单本体复用 child-env.ts 的 WORKER_ENV_ALLOWED_KEYS，本文件只验重建行为。
 */
import { describe, expect, it } from 'vitest';
import { WORKER_ENV_ALLOWED_KEYS } from './src/child-env';
import { workerSubprocessEnv } from './src/minimal/worker-env';

describe('worker 子进程 env 白名单（B 类：凭据隔离）', () => {
  it('宿主敏感凭据族与内部指针不进子进程；白名单键保留', () => {
    const rebuilt = workerSubprocessEnv({
      PATH: '/usr/bin',
      HOME: 'sentinel-home',
      TMPDIR: 'sentinel-tmp',
      FSHINE_EVAL_FIXTURE_STATE_DIR: '/state/sentinel',
      LLM_API_KEY: 'sentinel-key',
      LLM_MODEL: 'sentinel-model',
      LLM_API_BASE_URL: 'https://sentinel.invalid',
      WECOM_CORP_SECRET: 'sentinel-wecom',
      AGENT_CONFIG_PATH: 'sentinel-config.yaml',
      DB_PATH: 'sentinel.db',
      NODE_OPTIONS: '--sentinel',
      EXECUTION_REQUIRE_PLAN: '1',
      EXECUTION_PLAN_ID: 'plan_sentinel',
    });
    expect(rebuilt['PATH']).toBe('/usr/bin');
    expect(rebuilt['HOME']).toBe('sentinel-home');
    expect(rebuilt['TMPDIR']).toBe('sentinel-tmp');
    expect(rebuilt['FSHINE_EVAL_FIXTURE_STATE_DIR']).toBe('/state/sentinel');
    for (const key of ['LLM_API_KEY', 'LLM_MODEL', 'LLM_API_BASE_URL', 'WECOM_CORP_SECRET', 'AGENT_CONFIG_PATH', 'DB_PATH', 'NODE_OPTIONS', 'EXECUTION_REQUIRE_PLAN', 'EXECUTION_PLAN_ID']) {
      expect(rebuilt[key], `${key} 不应进执行层子进程`).toBeUndefined();
    }
    expect(Object.keys(rebuilt).sort()).toEqual([...WORKER_ENV_ALLOWED_KEYS].sort());
  });
});
