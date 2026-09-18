import type { ConversationSessionRecord } from '@fshine/contracts';

/** In-memory transcript repository used by Agent runtime tests. */
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
