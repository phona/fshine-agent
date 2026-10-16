import { describe, expect, it } from 'vitest';
import { judgeEnvReady, judgeModel, judgePromptVersion, judgeTranscript, parseJudgeOutput, stripFences } from './judge';

/** 评委组件锁：版本派生、输出解析（含围栏容错）、形状校验、注入 fetch 的端到端一次调用。 */

describe('judgePromptVersion / judgeModel', () => {
  it('版本 = 内容 sha256 前 8 位（改一字即换版）', () => {
    const version = judgePromptVersion();
    expect(version).toMatch(/^[0-9a-f]{8}$/);
  });

  it('评委模型：LLM_JUDGE_MODEL 优先，缺省回落 LLM_MODEL', () => {
    expect(judgeModel({ LLM_JUDGE_MODEL: 'judge-x', LLM_MODEL: 'main-x' })).toBe('judge-x');
    expect(judgeModel({ LLM_MODEL: 'main-x' })).toBe('main-x');
    expect(judgeModel({})).toBe('');
    expect(judgeEnvReady({ LLM_API_BASE_URL: 'http://x', LLM_API_KEY: 'k', LLM_MODEL: 'm' })).toBe(true);
    expect(judgeEnvReady({ LLM_API_BASE_URL: 'http://x', LLM_API_KEY: 'k' })).toBe(false);
  });
});

describe('parseJudgeOutput / stripFences', () => {
  const good = JSON.stringify({
    scores: { groundedness: 2, entityFidelity: 1, failureHonesty: 2, presentationHygiene: 0 },
    evidence: [{ dim: 'groundedness', quote: '余额 86,000', why: '通知里出现过' }],
  });

  it('裸 JSON 与 ```json 围栏都能解析', () => {
    expect(parseJudgeOutput(good).scores.groundedness).toBe(2);
    expect(parseJudgeOutput(`\`\`\`json\n${good}\n\`\`\``).scores.entityFidelity).toBe(1);
    expect(parseJudgeOutput(`前置废话\n${good}\n后缀`).evidence).toHaveLength(1);
  });

  it('分数越界/缺键/非法 dim 都拒收（评委输出不做信任假设）', () => {
    const bad = JSON.stringify({
      scores: { groundedness: 3, entityFidelity: 1, failureHonesty: 2, presentationHygiene: 2 },
      evidence: [],
    });
    expect(() => parseJudgeOutput(bad)).toThrow(/scores\.groundedness 非法/);
    const missing = JSON.stringify({
      scores: { groundedness: 1, entityFidelity: 1, failureHonesty: 2 },
      evidence: [],
    });
    expect(() => parseJudgeOutput(missing)).toThrow(/scores\.presentationHygiene 非法/);
    expect(stripFences('没有 JSON 的文本')).toBe('没有 JSON 的文本');
  });

  it('evidence 里的非法条目被过滤而不是整体拒收', () => {
    const mixed = JSON.stringify({
      scores: { groundedness: 1, entityFidelity: 1, failureHonesty: 1, presentationHygiene: 1 },
      evidence: [
        { dim: 'groundedness', quote: 'q', why: 'w' },
        { dim: 'unknown-dim', quote: 'q2', why: 'w2' },
        { dim: 'entityFidelity', quote: 42, why: 'w3' },
      ],
    });
    const parsed = parseJudgeOutput(mixed);
    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.evidence[0]!.dim).toBe('groundedness');
  });
});

describe('judgeTranscript（注入 fetch，不接真网）', () => {
  const env = { LLM_API_BASE_URL: 'http://judge.test/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm-1' };
  const replyBody = JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      scores: { groundedness: 2, entityFidelity: 2, failureHonesty: 1, presentationHygiene: 2 },
      evidence: [{ dim: 'failureHonesty', quote: '稍后再试', why: '补救不可行动' }],
    }) } }],
  });

  it('端到端一次调用：system 用提示词文件，user 是转录 JSON，temperature 0', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(replyBody, { status: 200 });
    }) as typeof fetch;
    const result = await judgeTranscript(
      { intent: '重问必重查', expect: '口径一致', turns: [{ user: '查一下', reply: '余额 500', notices: [] }] },
      { env, fetchImpl },
    );
    expect(result.model).toBe('m-1');
    expect(result.scores.failureHonesty).toBe(1);
    expect(captured!.url).toBe('http://judge.test/v1/chat/completions');
    const body = JSON.parse(String(captured!.init.body)) as { temperature: number; messages: Array<{ role: string }> };
    expect(body.temperature).toBe(0);
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[1]!.role).toBe('user');
  });

  it('HTTP 非 2xx 与空内容都报错（不静默吞）', async () => {
    const failing = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await expect(judgeTranscript({ intent: 'x', expect: 'y', turns: [] }, { env, fetchImpl: failing }))
      .rejects.toThrow(/HTTP 500/);
    const empty = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 })) as typeof fetch;
    await expect(judgeTranscript({ intent: 'x', expect: 'y', turns: [] }, { env, fetchImpl: empty }))
      .rejects.toThrow(/空内容/);
  });

  it('缺环境变量给可行动的错误', async () => {
    await expect(judgeTranscript({ intent: 'x', expect: 'y', turns: [] }, { env: {}, fetchImpl: (async () => new Response('{}')) as typeof fetch }))
      .rejects.toThrow(/LLM_API_BASE_URL/);
  });
});
