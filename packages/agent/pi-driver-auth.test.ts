/**
 * 认证链接线（issue #20 切片 C+D 回归 / Codex blocking）：
 * 部署配置把 LLM_API_KEY 派生进装配的 effectiveEnv，驱动只把它当 options.env；
 * pi-ai 的默认认证上下文只读 process.env（库 auth/context.js 头注：
 * "Default auth context: env vars from process.env"），不把 options.env 织入
 * 认证解析时，首次模型请求认证失败——装配校验全过、门全绿，但生产对话不可用。
 *
 * 这里走库的 Models.getAuth 解析面（只读 env / 内存凭据，不建连接、不打真 API）。
 * 修复前本文件第一条用例必红（解析结果 undefined）；修复后转绿。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createPiModelRuntime } from './src/pi-driver';

const ENV_KEY = 'key-only-in-options-env';
const BASE_ENV = {
  LLM_API_BASE_URL: 'http://127.0.0.1:9',
  LLM_API_KEY: ENV_KEY,
  LLM_MODEL: 'kimi-for-coding',
};

afterEach(() => {
  delete process.env.LLM_API_KEY;
});

describe('Pi driver 认证链接线（options.env 是部署配置的生效环境）', () => {
  it('key 只存在于 options.env、process.env 没有时，认证解析仍能拿到它', async () => {
    // 基线自证：默认认证上下文读的就是 process.env，这里没有 key。
    expect(process.env.LLM_API_KEY).toBeUndefined();

    const runtime = await createPiModelRuntime(BASE_ENV, 'kimi-for-coding');
    const auth = await runtime.getAuth('llm');

    expect(auth?.auth.apiKey).toBe(ENV_KEY);
    // 1.5.2 公开 ModelRuntime 的凭据来源标签：注册 provider 的显式 apiKey → "configured API key"
    //（旧 pi-ai Models 报 env 变量名；断言意图不变：生效环境的 key 被采用）。
    expect(auth?.source).toBe('configured API key');
  });

  it('process.env 与 options.env 都有 key 时，options.env（生效环境）优先', async () => {
    process.env.LLM_API_KEY = 'ambient-process-env-key';

    const runtime = await createPiModelRuntime(BASE_ENV, 'kimi-for-coding');
    const auth = await runtime.getAuth('llm');

    expect(auth?.auth.apiKey).toBe(ENV_KEY);
    // 1.5.2 公开 ModelRuntime 的凭据来源标签：注册 provider 的显式 apiKey → "configured API key"
    //（旧 pi-ai Models 报 env 变量名；断言意图不变：生效环境的 key 被采用）。
    expect(auth?.source).toBe('configured API key');
  });
});
