/**
 * 确定性测试双胞胎:内存 FakeToolClient / FakeSessionRepo / 录制型 ChatModel 包装。
 * 不碰网络、不依赖 @fshine/core 与 mcp-host。
 */
import {
  READ_TOOLS,
  type ConversationSessionRecord,
  type DiscoveredTool,
  type EnvelopeMeta,
  type ErrorCode,
  type HostToolClient,
  type ReadToolName,
  type ToolOutcome,
} from '@fshine/contracts';
import type { ChatCompleteRequest, ChatModel } from './src/model';

export type FakeHandler = (args: Record<string, unknown>) => ToolOutcome | Promise<ToolOutcome>;

export class FakeToolClient implements HostToolClient {
  readonly calls: Array<{ tool: ReadToolName; args: Record<string, unknown> }> = [];
  private readonly handlers = new Map<ReadToolName, FakeHandler>();

  constructor(handlers: Partial<Record<ReadToolName, FakeHandler>> = {}) {
    for (const [name, handler] of Object.entries(handlers)) {
      this.handlers.set(name as ReadToolName, handler as FakeHandler);
    }
  }

  tools(): readonly DiscoveredTool[] {
    return READ_TOOLS.map((name) => ({
      name,
      description: `${name} 的测试描述`,
      inputSchema: { type: 'object', properties: {} },
    }));
  }

  async call(tool: ReadToolName, args: Record<string, unknown>): Promise<ToolOutcome> {
    this.calls.push({ tool, args });
    const handler = this.handlers.get(tool);
    if (handler) return handler(args);
    return fakeOk({ note: `${tool} 默认成功` });
  }

  callsOf(tool: ReadToolName): Array<Record<string, unknown>> {
    return this.calls.filter((call) => call.tool === tool).map((call) => call.args);
  }
}

export class FakeSessionRepo {
  private readonly records = new Map<string, ConversationSessionRecord>();

  async get(sessionId: string): Promise<ConversationSessionRecord | null> {
    return this.records.get(sessionId) ?? null;
  }

  async upsert(record: ConversationSessionRecord): Promise<void> {
    this.records.set(record.sessionId, { ...record });
  }

  peek(sessionId: string): ConversationSessionRecord | null {
    return this.records.get(sessionId) ?? null;
  }
}

export function fakeMeta(overrides: Partial<EnvelopeMeta> = {}): EnvelopeMeta {
  return { retrievedAt: '2026-09-15T10:00:00+08:00', source: 'api_live', ...overrides };
}

export function fakeOk(data: unknown, meta: EnvelopeMeta = fakeMeta()): ToolOutcome {
  return { ok: true, data, meta };
}

export function fakeErr(code: ErrorCode, message: string): ToolOutcome {
  return { ok: false, error: { code, message, retryable: false } };
}

export interface RecordedChat {
  model: ChatModel;
  requests: ChatCompleteRequest[];
}

/** 包装任意 ChatModel,录制每次 complete 的入参供断言。 */
export function recordRequests(model: ChatModel): RecordedChat {
  const requests: ChatCompleteRequest[] = [];
  return {
    requests,
    model: {
      async complete(req: ChatCompleteRequest): Promise<string> {
        // 快照:runtime 复用同一个 messages 数组逐轮追加,必须复制才能断言当轮结构
        requests.push({ system: req.system, messages: [...req.messages] });
        return model.complete(req);
      },
    },
  };
}
