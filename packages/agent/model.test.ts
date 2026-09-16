import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatibleChatModel, ScriptedChatModel, type ChatCompleteRequest } from './src/model';
import { toUserMessage } from './src/errors';

describe('ScriptedChatModel', () => {
  it('按序回放,函数步骤可读取请求;耗尽后重复最后一步', async () => {
    const seen: ChatCompleteRequest[] = [];
    const model = ScriptedChatModel([
      'first',
      (req) => {
        seen.push(req);
        return `echo:${req.messages[0]?.content ?? ''}`;
      },
    ]);

    expect(await model.complete({ system: 's', messages: [{ role: 'user', content: 'a' }] })).toBe('first');
    expect(await model.complete({ system: 's', messages: [{ role: 'user', content: 'b' }] })).toBe('echo:b');
    expect(await model.complete({ system: 's', messages: [{ role: 'user', content: 'c' }] })).toBe('echo:c');
    expect(seen[0]?.messages[0]?.content).toBe('b');
  });

  it('空脚本构造即抛错', () => {
    expect(() => ScriptedChatModel([])).toThrow(/脚本不能为空/);
  });
});

describe('OpenAICompatibleChatModel', () => {
  let server: Server;
  let baseUrl = '';
  let lastPath = '';
  let lastAuth = '';
  let lastBody = '';
  let mode: 'ok' | 'error' = 'ok';

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        lastPath = req.url ?? '';
        lastAuth = req.headers.authorization ?? '';
        lastBody = body;
        res.setHeader('Content-Type', 'application/json');
        if (mode === 'error') {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: { message: 'internal boom' } }));
          return;
        }
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '你好,我是模型回复' } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('POST {base}/chat/completions,带 Bearer key 与 system 消息,取回 content', async () => {
    const model = OpenAICompatibleChatModel({
      env: { LLM_API_KEY: 'sk-test', LLM_MODEL: 'glm-test' },
      apiBaseUrl: `${baseUrl}/`,
    });

    const out = await model.complete({ system: '你是助手', messages: [{ role: 'user', content: '你好' }] });

    expect(out).toBe('你好,我是模型回复');
    expect(lastPath).toBe('/chat/completions');
    expect(lastAuth).toBe('Bearer sk-test');
    const sent = JSON.parse(lastBody) as { model: string; messages: Array<{ role: string; content: string }> };
    expect(sent.model).toBe('glm-test');
    expect(sent.messages[0]).toEqual({ role: 'system', content: '你是助手' });
    expect(sent.messages[1]).toEqual({ role: 'user', content: '你好' });
  });

  it('未注入 apiBaseUrl 时回退 env.LLM_API_BASE_URL', async () => {
    const model = OpenAICompatibleChatModel({
      env: { LLM_API_BASE_URL: baseUrl, LLM_API_KEY: 'sk-test', LLM_MODEL: 'glm-test' },
    });

    await expect(model.complete({ system: 's', messages: [] })).resolves.toBe('你好,我是模型回复');
  });

  it('非 2xx 抛中文错误,含状态码,不含 key', async () => {
    mode = 'error';
    const model = OpenAICompatibleChatModel({
      env: { LLM_API_KEY: 'sk-secret', LLM_MODEL: 'glm-test' },
      apiBaseUrl: baseUrl,
    });

    let failure: Error | null = null;
    try {
      await model.complete({ system: 's', messages: [] });
    } catch (e) {
      failure = e as Error;
    }

    expect(failure).not.toBeNull();
    expect(failure!.message).toContain('HTTP 500');
    expect(failure!.message).toMatch(/LLM 调用失败/);
    expect(failure!.message).not.toContain('sk-secret');
    mode = 'ok';
  });

  it('缺少任一环境变量:构造即抛中文错误并点名变量', () => {
    expect(() => OpenAICompatibleChatModel({ env: {} })).toThrow(/LLM_API_BASE_URL/);
    expect(() => OpenAICompatibleChatModel({ env: { LLM_API_BASE_URL: 'http://x' } })).toThrow(/LLM_API_KEY/);
    expect(() =>
      OpenAICompatibleChatModel({ env: { LLM_API_BASE_URL: 'http://x', LLM_API_KEY: 'k' } }),
    ).toThrow(/LLM_MODEL/);
  });
});

describe('toUserMessage(架构 §6 安全话术)', () => {
  const base = { retryable: false, message: '内部细节 堆栈 /var/log secret' };

  it('按错误码映射', () => {
    expect(toUserMessage({ ...base, code: 'NEEDS_LOGIN' })).toBe('系统登录需要处理,暂时无法查询,请稍后再试');
    expect(toUserMessage({ ...base, code: 'ACCOUNT_SET_FORBIDDEN' })).toBe('没有该账套的访问权限');
    expect(toUserMessage({ ...base, code: 'PROFILE_BUSY', retryable: true, retryAfterMs: 500 })).toBe('系统繁忙,请稍后再试');
    expect(toUserMessage({ ...base, code: 'TIMEOUT', retryable: true })).toBe('系统繁忙,请稍后再试');
    expect(toUserMessage({ ...base, code: 'INTERNAL' })).toBe('查询失败,请稍后再试或联系管理员');
    expect(toUserMessage({ ...base, code: 'EXECUTION_FAILED' })).toBe('查询失败,请稍后再试或联系管理员');
  });

  it('任何码都不透出原始 message', () => {
    for (const code of ['NEEDS_LOGIN', 'ACCOUNT_SET_FORBIDDEN', 'INTERNAL', 'TIMEOUT'] as const) {
      expect(toUserMessage({ ...base, code })).not.toContain('/var/log');
      expect(toUserMessage({ ...base, code })).not.toContain('secret');
    }
  });

  it('ACCOUNT_SET_AMBIGUOUS:带候选时编号引导重选,否则通用引导', () => {
    expect(
      toUserMessage({
        ...base,
        code: 'ACCOUNT_SET_AMBIGUOUS',
        details: { candidates: [{ id: 'a', name: '幻晟' }, { id: 'b', name: '幻晟二店' }] },
      }),
    ).toContain('2. 幻晟二店');
    expect(toUserMessage({ ...base, code: 'ACCOUNT_SET_AMBIGUOUS' })).toContain('更具体的账套名称');
  });

  it('NEEDS_USER_INPUT:展示 details.needs 问题', () => {
    expect(toUserMessage({ ...base, code: 'NEEDS_USER_INPUT', details: { needs: '请确认期间' } })).toBe(
      '还需要补充信息:请确认期间',
    );
    expect(
      toUserMessage({ ...base, code: 'NEEDS_USER_INPUT', details: { needs: ['会计期间', '账套'] } }),
    ).toBe('还需要补充信息:会计期间、账套');
    expect(toUserMessage({ ...base, code: 'NEEDS_USER_INPUT' })).toContain('补充');
  });
});
