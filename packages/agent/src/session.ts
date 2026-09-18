/**
 * 会话持久化(转录即状态)。
 * conversation_sessions.state 存完整消息转录(AgentMessage[],JSON 序列化);
 * TTL 过期时**不做静默清零**:原样返回旧转录 + expired 标记,由 runtime 决定软着陆
 * (经 driver.compact 压成「摘要+最近尾巴」种子续会话)。除压缩外没有任何裁剪、
 * 投影或静默丢弃——模型上下文的上限治理由 driver.compact(pi 原生 compact)负责。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ConversationSessionRepo } from '@fshine/contracts';

export interface LoadedTranscript {
  messages: AgentMessage[];
  /** 距上次更新超过 TTL:messages 为过期前的旧转录,调用方应软着陆而非当全新会话 */
  expired: boolean;
}

/** 载入转录。损坏/缺失一律按空转录处理(空转录 = 全新会话),不阻塞回合。 */
export async function loadTranscript(
  sessions: Pick<ConversationSessionRepo, 'get'>,
  sessionId: string,
  ttlMs: number,
): Promise<LoadedTranscript> {
  let record: { updatedAt?: string; state?: unknown } | undefined;
  try {
    const fetched = await sessions.get(sessionId);
    record = fetched ? { updatedAt: fetched.updatedAt, state: fetched.state } : undefined;
  } catch (error) {
    console.error(JSON.stringify({ event: 'transcript_load_failed', sessionId, error: error instanceof Error ? error.message : String(error) }));
    return { messages: [], expired: false };
  }
  if (!record) return { messages: [], expired: false };

  const updatedAt = Date.parse(record.updatedAt ?? '');
  const expired = Number.isFinite(updatedAt) && ttlMs > 0 && Date.now() - updatedAt > ttlMs;
  if (expired) {
    return { messages: Array.isArray(record.state) ? (record.state as AgentMessage[]) : [], expired: true };
  }

  if (Array.isArray(record.state)) return { messages: record.state as AgentMessage[], expired: false };
  return { messages: [], expired: false };
}

/** 保存转录。失败不阻塞回合(转录属瞬态优化),但必须留痕。 */
export async function saveTranscript(
  sessions: Pick<ConversationSessionRepo, 'upsert'>,
  args: { sessionId: string; principalId: string; messages: AgentMessage[] },
): Promise<void> {
  try {
    await sessions.upsert({
      sessionId: args.sessionId,
      principalId: args.principalId,
      channelConversationId: args.sessionId,
      updatedAt: new Date().toISOString(),
      state: args.messages,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'transcript_save_failed', sessionId: args.sessionId, error: error instanceof Error ? error.message : String(error) }));
  }
}
