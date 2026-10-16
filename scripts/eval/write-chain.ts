import type Database from 'better-sqlite3';

/**
 * 写链三指标的机械提取（L7 / D-060；change-safety §「下一处该投的是 L7」点名的账）：
 * 「手工提取 prop_*／确认码／落账三个指标」从 acceptance 报告里的人眼动作，变成
 * 从宿主自己的契约表（tool_calls / change_intents）里的一条查询。
 *
 * 取数口径（都是宿主持有的结构化事实，不做业务解释）：
 *   · 提案尝试 = `tool_calls` 里 `tool_name = 'serve_gate:proposal_create'` 的行数。
 *     拦截与放行都算"尝试"（pi-coding-driver 的提案拦截审计对每个出口都落一行，
 *     allowed 恒 false——记的是判定结果不是放行）；D-097 的反例正是"承诺了录入却
 *     一行都没有"。
 *   · 意图 = `change_intents` 按创建序的行：宿主接下的提案。`status = 'committed'`
 *     即落账；`result` 非空即读回校验输出摘要在（commit 成功路径写入）。
 *   · 确认码 = 该会话任一回复命中 6 位确认码形态（与 acceptance confirmOf 的提取
 *     同一正则——同一把尺，两处使用）。
 *
 * 本模块只做提取，不做判定——"这算不算通过"由打分器对 baseline 比对时回答。
 */

/** 确认码形态（acceptance.ts confirmOf 处理同款：6 位大写字母数字）。 */
export const CONFIRM_CODE_RE = /确认\s*([A-Z0-9]{6})/;

/** 提案拦截审计在 tool_calls 里的 tool 名（assembly 的 serveGateAudit 加 `serve_gate:` 前缀）。 */
export const PROPOSAL_ATTEMPT_TOOL = 'serve_gate:proposal_create';

export interface WriteChainInputRecord {
  /** 用例 id（报告定位用）。 */
  id: string;
  /** 会话 id（acceptance spec.conv，如 acc-write-51）。 */
  conversationId: string;
  /** 主会话键（wecom:<user>:<conv>，change_intents.session_id 的准确形态）。 */
  sessionKey: string;
  requestId: string | null;
  reply: string;
}

export interface IntentFact {
  status: string;
  /** commit 读回校验输出摘要是否在（change_intents.result 非空）。 */
  hasResult: boolean;
}

export interface ConversationWriteChainFacts {
  conversationId: string;
  sessionKey: string;
  cases: string[];
  proposalAttempts: number;
  intents: IntentFact[];
  confirmCodeOffered: boolean;
}

export function collectWriteChainFacts(
  db: Database.Database,
  records: readonly WriteChainInputRecord[],
): ConversationWriteChainFacts[] {
  const bySession = new Map<string, { conversationId: string; cases: string[]; requestIds: string[]; replies: string[] }>();
  for (const record of records) {
    const group = bySession.get(record.sessionKey) ?? {
      conversationId: record.conversationId,
      cases: [],
      requestIds: [],
      replies: [],
    };
    group.cases.push(record.id);
    if (record.requestId) group.requestIds.push(record.requestId);
    group.replies.push(record.reply);
    bySession.set(record.sessionKey, group);
  }

  const attemptCount = db.prepare(
    `SELECT COUNT(*) AS n FROM tool_calls WHERE tool_name = '${PROPOSAL_ATTEMPT_TOOL}' AND request_id = ?`,
  );
  const intentsOf = db.prepare(
    'SELECT status, result FROM change_intents WHERE session_id = ? ORDER BY created_at, rowid',
  );

  const facts: ConversationWriteChainFacts[] = [];
  for (const [sessionKey, group] of bySession) {
    let proposalAttempts = 0;
    for (const requestId of new Set(group.requestIds)) {
      proposalAttempts += (attemptCount.get(requestId) as { n: number }).n;
    }
    const intents = (intentsOf.all(sessionKey) as Array<{ status: string; result: unknown }>).map((row) => ({
      status: row.status,
      hasResult: row.result !== null && row.result !== undefined && row.result !== '',
    }));
    facts.push({
      conversationId: group.conversationId,
      sessionKey,
      cases: group.cases,
      proposalAttempts,
      intents,
      confirmCodeOffered: group.replies.some((reply) => CONFIRM_CODE_RE.test(reply)),
    });
  }
  return facts;
}

/**
 * 有信号的会话才值得一行报告（纯查询会话三指标全空，铺开只是噪音）。
 * 注意反例形状（D-097：零尝试/零意图/无确认码）三信号全空——"写意图会话必报"由
 * acceptance 侧补：它知道哪些会话有 confirmOf 用例（写意图由构造保证），对那些会话
 * 无条件出一行，让「提案尝试 0 次;意图 无;确认码 未给出」成为看得见的警报。
 */
export function hasWriteChainSignal(facts: ConversationWriteChainFacts): boolean {
  return facts.proposalAttempts > 0 || facts.intents.length > 0 || facts.confirmCodeOffered;
}

export function renderWriteChainLine(facts: ConversationWriteChainFacts): string {
  const intents = facts.intents.map((intent) => `${intent.status}${intent.hasResult ? '+读回' : ''}`).join(' , ') || '无';
  return `- 写链指标:提案尝试 ${facts.proposalAttempts} 次;意图 ${intents};确认码 ${facts.confirmCodeOffered ? '已给出' : '未给出'}`;
}
