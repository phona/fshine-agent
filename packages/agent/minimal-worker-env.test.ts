/**
 * B 类凭据隔离回归锁（M1 最小形状）：执行层子进程 env 只保留**按真实消费收敛**的
 * 最小白名单（PATH / HOME / TMPDIR）——不机械继承旧 WORKER_ENV_ALLOWED_KEYS。
 */
import { describe, expect, it, vi } from 'vitest';
import { WORKER_FIXTURE_STATE_DIR_KEY } from './src/child-env';
import { MINIMAL_EXECUTION_ENV_KEYS, workerSubprocessEnv } from './src/minimal/worker-env';

describe('worker 子进程 env 白名单（B 类：凭据隔离）', () => {
  it('宿主机密族/内部指针/测试桥键/计划旋钮不进子进程；白名单键保留', () => {
    const rebuilt = workerSubprocessEnv({
      PATH: '/usr/bin',
      HOME: 'sentinel-home',
      TMPDIR: 'sentinel-tmp',
      [WORKER_FIXTURE_STATE_DIR_KEY]: '/state/sentinel',
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
    for (const key of [
      WORKER_FIXTURE_STATE_DIR_KEY, // 测试桥键：M1 用显式 --state-dir argv，不进 env
      'LLM_API_KEY', 'LLM_MODEL', 'LLM_API_BASE_URL', 'WECOM_CORP_SECRET',
      'AGENT_CONFIG_PATH', 'DB_PATH', 'NODE_OPTIONS', 'EXECUTION_REQUIRE_PLAN', 'EXECUTION_PLAN_ID',
    ]) {
      expect(rebuilt[key], `${key} 不应进执行层子进程`).toBeUndefined();
    }
    expect(Object.keys(rebuilt).sort()).toEqual([...MINIMAL_EXECUTION_ENV_KEYS].sort());
    expect(MINIMAL_EXECUTION_ENV_KEYS).toEqual(['PATH', 'HOME', 'TMPDIR']);
  });

  it('白名单是精确键（未登记键即使无害也不进）', () => {
    expect(workerSubprocessEnv({ LANG: 'en_US.UTF-8', PATH: '/bin' })).toEqual({ PATH: '/bin' });
    expect(workerSubprocessEnv({ PATH: undefined, HOME: '/home/x' })).toEqual({ HOME: '/home/x' });
  });
});
