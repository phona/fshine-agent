import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { NoteDim } from './dims';

/**
 * LLM 评委（L7 / D-060 的评委分量）：给一段探针转录按四维打 0/1/2 分。
 *
 * 边界（有意收窄，台账登记）：评委只看转录文本（用户消息/回复/计划通知），
 * 不读审计库、不看机械分量——它的职责是"这轮回复对用户是否可信"的独立人评代理，
 * 与机械分量互不污染（评委看到机械判定会锚定，两个分量就不再是独立证据）。
 * groundedness 的硬判定由机械分量承担；评委的 groundedness 只评转录内自洽。
 *
 * 可复现口径：temperature 0；评委提示词版本 = 本文件（judge-prompt.md）内容的
 * sha256 前 8 位；模型 id 随每条分数落 scores.jsonl——模型升级 = 换基线，不是静默。
 */

export interface JudgeTurn {
  user: string;
  reply: string;
  notices: string[];
}

export interface JudgeInput {
  /** 用例意图（探针 case.intent / 语料 expect），评委据此知道该考什么。 */
  intent: string;
  expect: string;
  /** 用例的业务目标（cases.yaml 的 businessGoal）：评委的用例语境。 */
  businessGoal: string;
  /**
   * 用例作者对本轮问题的封闭答案分类（cases.yaml 消息级 answerTypes，turn = 0-based
   * 消息下标）。judge 拿它给回复定型：fail 类 ⇒ groundedness 记 0；pass 类 ⇒ 该轴不扣分；
   * 没有分类表的轮次按四维通用定义判。机械层不消费这份表。
   */
  answerTypes: Array<{
    turn: number;
    types: Array<{ id: string; verdict: string; shape: string }>;
  }>;
  turns: JudgeTurn[];
}

export interface JudgeEvidence {
  dim: NoteDim;
  quote: string;
  why: string;
}

export interface JudgeResult {
  scores: Record<NoteDim, number>;
  evidence: JudgeEvidence[];
  /** 实际使用的评委模型 id（落分数字段，模型升级须显式重定基线）。 */
  model: string;
}

const DEFAULT_PROMPT_PATH = new URL('./judge-prompt.md', import.meta.url);

/** 评委提示词版本：内容 sha256 前 8 位（改一字即换版，基线随之重定）。 */
export function judgePromptVersion(promptPath: string = DEFAULT_PROMPT_PATH.pathname): string {
  return createHash('sha256').update(readFileSync(promptPath, 'utf8')).digest('hex').slice(0, 8);
}

/** 评委模型：LLM_JUDGE_MODEL 优先（独立评委），缺省与被评模型同源（LLM_MODEL）。 */
export function judgeModel(env: NodeJS.ProcessEnv = process.env): string {
  return env['LLM_JUDGE_MODEL'] || env['LLM_MODEL'] || '';
}

export function judgeEnvReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['LLM_API_BASE_URL'] && env['LLM_API_KEY'] && judgeModel(env));
}

/** 剥 ```json 围栏（评委有时无视"只输出 JSON"的指令包围栏——剥掉而不是拒绝，减少重跑）。 */
export function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

export function parseJudgeOutput(raw: string): { scores: Record<NoteDim, number>; evidence: JudgeEvidence[] } {
  const parsed = JSON.parse(stripFences(raw)) as {
    scores?: Record<string, unknown>;
    evidence?: Array<{ dim?: unknown; quote?: unknown; why?: unknown }>;
  };
  const dims: NoteDim[] = ['groundedness', 'entityFidelity', 'failureHonesty', 'presentationHygiene'];
  const scores = {} as Record<NoteDim, number>;
  for (const dim of dims) {
    const value = parsed.scores?.[dim];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2) {
      throw new Error(`评委输出 scores.${dim} 非法：${JSON.stringify(value)}`);
    }
    scores[dim] = value;
  }
  const evidence = (parsed.evidence ?? []).filter((item): item is JudgeEvidence =>
    typeof item.quote === 'string' && typeof item.why === 'string' && dims.includes(item.dim as NoteDim),
  );
  return { scores, evidence };
}

/**
 * 调评委模型打分。env/fetchImpl 可注入（单测不接真网）。
 * 单次尝试不重试：temperature 0 下重试解决不了格式性失败，格式失败就该报出来给人看。
 */
export async function judgeTranscript(
  input: JudgeInput,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; promptPath?: string } = {},
): Promise<JudgeResult> {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;
  const baseUrl = (env['LLM_API_BASE_URL'] ?? '').replace(/\/+$/, '');
  const apiKey = env['LLM_API_KEY'] ?? '';
  const model = judgeModel(env);
  if (!baseUrl || !apiKey || !model) {
    throw new Error('评委缺环境变量：LLM_API_BASE_URL / LLM_API_KEY / LLM_MODEL（或 LLM_JUDGE_MODEL）');
  }
  const promptPath = opts.promptPath ?? DEFAULT_PROMPT_PATH.pathname;
  const system = readFileSync(promptPath, 'utf8');
  const response = await doFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(input) },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`评委调用失败 HTTP ${response.status}：${(await response.text()).slice(0, 300)}`);
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const raw = payload.choices?.[0]?.message?.content ?? '';
  if (!raw.trim()) throw new Error('评委返回空内容');
  const { scores, evidence } = parseJudgeOutput(raw);
  return { scores, evidence, model };
}
