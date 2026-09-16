/**
 * ChatModel 端口:runtime 对 LLM 的唯一依赖,便于替换与测试双胞胎。
 */

export interface ChatModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatCompleteRequest {
  system: string;
  messages: ChatModelMessage[];
}

export interface ChatModel {
  complete(req: ChatCompleteRequest): Promise<string>;
}

// ---- ScriptedChatModel:确定性测试双胞胎 ----

export type ScriptedStep = string | ((req: ChatCompleteRequest) => string);

/** 按序回放脚本;步骤耗尽后重复最后一步(便于模拟"一直 call"),空脚本构造即抛错。 */
export function ScriptedChatModel(script: ScriptedStep[]): ChatModel {
  if (script.length === 0) {
    throw new Error('ScriptedChatModel:脚本不能为空');
  }
  let cursor = 0;
  return {
    async complete(req: ChatCompleteRequest): Promise<string> {
      const index = Math.min(cursor, script.length - 1);
      cursor += 1;
      const step = script[index]!;
      return typeof step === 'function' ? step(req) : step;
    },
  };
}

// ---- OpenAICompatibleChatModel:OpenAI /chat/completions 兼容实现 ----

export interface OpenAICompatibleEnv {
  LLM_API_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
}

export interface OpenAICompatibleChatModelOptions {
  /** 通常直接传 process.env */
  env: OpenAICompatibleEnv;
  /** 显式基址优先于 env.LLM_API_BASE_URL(测试注入用) */
  apiBaseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_LLM_TIMEOUT_MS = 45_000;

export function OpenAICompatibleChatModel(options: OpenAICompatibleChatModelOptions): ChatModel {
  const baseUrl = (options.apiBaseUrl ?? options.env.LLM_API_BASE_URL ?? '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('缺少环境变量 LLM_API_BASE_URL,无法初始化 LLM 客户端');
  }
  const apiKey = options.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('缺少环境变量 LLM_API_KEY,无法初始化 LLM 客户端');
  }
  const model = options.env.LLM_MODEL;
  if (!model) {
    throw new Error('缺少环境变量 LLM_MODEL,无法初始化 LLM 客户端');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

  return {
    async complete(req: ChatCompleteRequest): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            stream: false,
            messages: [
              { role: 'system', content: req.system },
              ...req.messages.map((message) => ({ role: message.role, content: message.content })),
            ],
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`LLM 调用超时(${timeoutMs}ms)`);
        }
        throw new Error('LLM 调用失败,无法连接 LLM 服务');
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        // 只带状态码,不透出响应体与凭据
        throw new Error(`LLM 调用失败(HTTP ${response.status}),请稍后再试`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error('LLM 返回格式异常,无法解析响应');
      }
      const content = extractMessageContent(payload);
      if (content === null) {
        throw new Error('LLM 返回格式异常,缺少回复内容');
      }
      return content;
    },
  };
}

function extractMessageContent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== 'object') return null;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : null;
}
