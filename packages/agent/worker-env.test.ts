/**
 * B 类凭据隔离回归锁（最小形状）：执行层子进程 env 只保留**按真实消费收敛**的
 * 最小白名单（PATH / HOME / TMPDIR）——逐键登记，不做前缀放行。
 */
import { describe, expect, it, vi } from 'vitest';
import { EXECUTION_ENV_KEYS, workerSubprocessEnv } from './src/worker-env';

/**
 * 测试桥键名：宿主夹具使用的 env 键；适配器用显式 --state-dir argv，不靠 env 改道，
 * 因此该键不进白名单。
 */
const WORKER_FIXTURE_STATE_DIR_KEY = 'FSHINE_EVAL_FIXTURE_STATE_DIR';

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
    expect(Object.keys(rebuilt).sort()).toEqual([...EXECUTION_ENV_KEYS].sort());
    expect(EXECUTION_ENV_KEYS).toEqual(['PATH', 'HOME', 'TMPDIR']);
  });

  it('白名单是精确键（未登记键即使无害也不进）', () => {
    expect(workerSubprocessEnv({ LANG: 'en_US.UTF-8', PATH: '/bin' })).toEqual({ PATH: '/bin' });
    expect(workerSubprocessEnv({ PATH: undefined, HOME: '/sentinel-home-x' })).toEqual({ HOME: '/sentinel-home-x' });
  });

  /**
   * P0-T06 扩展：前缀族与内部指针的**负例**断言（白名单外注入必须被剔除）。
   * 覆盖宿主全部敏感族（LLM_* / WECOM_* / EXECUTION_* / FSHINE_*）、内部指针
   * （AGENT_CONFIG_PATH / DB_PATH / INIT_CWD / EXECUTION_AUDIT_PATH）与测试桥键；
   * 结果与白名单逐键精确相等（不是"包含关系"——多一个键即红）。
   */
  it('负例：白名单外键（含前缀族/内部指针/测试桥键）注入后一律不出现在子进程 env', () => {
    const sentinel: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/sentinel-home',
      TMPDIR: '/tmp/sentinel',
      LLM_API_KEY: 'k',
      LLM_API_BASE_URL: 'u',
      LLM_MODEL: 'm',
      LLM_MAIN_MODEL: 'mm',
      LLM_THINKING_LEVEL: 't',
      LLM_MAIN_THINKING_LEVEL: 'mt',
      LLM_CONTEXT_WINDOW: '1',
      WECOM_BOT_ID: 'b',
      WECOM_BOT_SECRET: 's',
      WECOM_CORP_ID: 'i',
      WECOM_CORP_SECRET: 'c',
      AGENT_CONFIG_PATH: 'agent.yaml',
      DB_PATH: 'state.db',
      INIT_CWD: '/somewhere',
      EXECUTION_AUDIT_PATH: 'audit.jsonl',
      EXECUTION_EXECUTOR: 'real',
      EXECUTION_REQUIRE_PLAN: '1',
      EXECUTION_PLAN_ID: 'plan_sentinel',
      FSHINE_WORKER_DISPATCH_MODE: 'inline',
      FSHINE_PLATFORM_QUEUE_CAPACITY: '1',
      [WORKER_FIXTURE_STATE_DIR_KEY]: '/state/sentinel',
      NODE_OPTIONS: '--sentinels',
    };
    const rebuilt = workerSubprocessEnv(sentinel);
    expect(rebuilt).toEqual({ PATH: '/usr/bin', HOME: '/sentinel-home', TMPDIR: '/tmp/sentinel' });
    for (const key of Object.keys(sentinel)) {
      if (key === 'PATH' || key === 'HOME' || key === 'TMPDIR') continue;
      expect(rebuilt[key], `${key} 不应进执行层子进程`).toBeUndefined();
    }
  });
});
