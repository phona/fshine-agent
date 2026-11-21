/**
 * 交互性质场景（INT）· 独立 Oracle。
 *
 * 定位：这批用例测的是「像不像一个真助理」里**脚本化模型判不了**的那几条——范围澄清、
 * 失败后的下一步、慢活期间插话、跨会话不泄露。它们大多无法用词表判定（词表判语义是仓内
 * 红线），因此这里的确定性部分只保留**机械硬零**（可核对的事实：是否真的发生了失败/重复
 * 调用/结果里出现不该出现的数值），语义部分交给 harness 的**独立判官**（`SimJudgeTools.complete`，
 * 由 harness 记 `kind: judge`）。
 *
 * 判据纪律（对齐任务书「覆盖式判据」）：
 *   · 每条用例的 `checks` 是覆盖式清单，**缺一项即不通过**（`pass = 所有 checks 为 true`）；
 *   · 语义项一律走判官（不是「某关键词出现即通过」）；判官输出解析失败 → **fail-closed**
 *     （pass=false，原文留证），不冒充通过；
 *   · 机械项只用可核对的事实（执行状态计数、回复里的数值/条数），不读模型自述。
 *
 * 边界：Oracle 只读 `SimOracleContext`（用户可见回复 + 机械执行事实）与判官工具；
 * `truthPatterns` 只供 harness 的污染检测，**不得**进模拟用户 prompt。
 */

import { parseNumbers } from '../../long-session/oracle';
import type { SimExecutionFact, SimJudgeTools, SimOracle, SimOracleContext, SimOracleVerdict } from '../oracle';
import { clean, countTold, lastReply, readFacts } from './oracles';

// ─────────────────────────────────────────────────────────────────────────────
// 共享工具
// ─────────────────────────────────────────────────────────────────────────────

function isReadOperation(operation: string): boolean {
  return operation === 'query' || operation.endsWith('.query');
}

function readExecutions(executions: readonly SimExecutionFact[]): readonly SimExecutionFact[] {
  return executions.filter((execution) => isReadOperation(execution.operation));
}

function sameText(a: string, b: string): boolean {
  return clean(a).replace(/\s+/g, '') === clean(b).replace(/\s+/g, '');
}

function verdictOf(id: string, checks: Readonly<Record<string, boolean>>, detail: Readonly<Record<string, unknown>>): SimOracleVerdict {
  return {
    pass: Object.values(checks).every(Boolean),
    detail: { source: 'sim-case:interaction-oracles', oracleId: id, checks, ...detail },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 判官协议（确定性解析 + fail-closed）
// ─────────────────────────────────────────────────────────────────────────────

export interface JudgeChecklistItem {
  readonly key: string;
  readonly question: string;
}

export interface JudgeChecklistResult {
  readonly ok: boolean;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly reason: string;
  /** 判官原始输出（留证，便于复核）。 */
  readonly raw: string;
  readonly error?: string;
}

/** 从判官输出里抽取第一个 JSON 对象（容错 markdown 代码围栏与前后废话）。 */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

/**
 * 覆盖式判官：把证据（用户消息 / 系统回复 / 机械事实）与**逐项问题**交给独立判官，要求
 * 只输出 `{"checks": {"<key>": true|false, ...}, "reason": "..."}`。
 *
 * 解析失败 / 缺项 / 非布尔 → `ok=false`（调用方据此 fail-closed，不冒充通过）。
 * 只解析响应，不产生任何模型调用；调用本身由 harness 记 `kind: judge`。
 */
export async function judgeChecklist(
  ctx: SimOracleContext,
  tools: SimJudgeTools,
  spec: { readonly scenario: string; readonly items: readonly JudgeChecklistItem[]; readonly facts?: string },
): Promise<JudgeChecklistResult> {
  const transcript = [
    '# 场景',
    spec.scenario,
    '',
    '# 用户消息（按序）',
    ctx.userMessages.length === 0 ? '（无）' : ctx.userMessages.map((text, index) => `${index + 1}. ${text}`).join('\n'),
    '',
    '# 系统回复（用户可见，按序）',
    ctx.replies.length === 0 ? '（无）' : ctx.replies.map((text, index) => `${index + 1}. ${text}`).join('\n'),
    '',
    '# 机械事实（可核对，不要推翻）',
    spec.facts ?? '（无）',
    '',
    '# 逐项判定（覆盖式：每一项都必须为 true 才算通过；只要有一项为 false 就是不通过）',
    ...spec.items.map((item) => `- ${item.key}: ${item.question}`),
    '',
    '只输出一个 JSON 对象，不要解释、不要代码围栏：',
    `{"checks": {${spec.items.map((item) => `"${item.key}": true`).join(', ')}}, "reason": "简短中文依据"}`,
  ].join('\n');

  const output = await tools.complete(transcript);
  const raw = output.text ?? '';
  const json = extractJsonObject(raw);
  if (json === null) return { ok: false, checks: {}, reason: '', raw, error: '判官输出里没有 JSON 对象' };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return { ok: false, checks: {}, reason: '', raw, error: `判官 JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (value === null || typeof value !== 'object') return { ok: false, checks: {}, reason: '', raw, error: '判官输出不是 JSON 对象' };
  const record = value as Record<string, unknown>;
  const checksRaw = record['checks'];
  if (checksRaw === null || typeof checksRaw !== 'object') return { ok: false, checks: {}, reason: '', raw, error: '判官输出缺少 checks 对象' };
  const checksRecord = checksRaw as Record<string, unknown>;
  const checks: Record<string, boolean> = {};
  const missing: string[] = [];
  for (const item of spec.items) {
    const verdict = checksRecord[item.key];
    if (typeof verdict !== 'boolean') {
      missing.push(item.key);
      continue;
    }
    checks[item.key] = verdict;
  }
  const reason = typeof record['reason'] === 'string' ? record['reason'] : '';
  if (missing.length > 0) return { ok: false, checks, reason, raw, error: `判官未对以下项给出布尔值：${missing.join(', ')}` };
  return { ok: true, checks, reason, raw };
}

// ─────────────────────────────────────────────────────────────────────────────
// INT-01：模糊指代（先给窗口，再追加「那上个月的也一起」）
// ─────────────────────────────────────────────────────────────────────────────

/** documents 夹具在该集合两个窗口下返回同一批 items（3 条 / 合计 2900）。 */
const DOCUMENTS_COUNT = 3;
const DOCUMENTS_SUM = 2900;
/** 用户可核对的口语映射（本域）：上个月 → W202610、本月 → W202611。 */
const WINDOW_LAST_MONTH = 'W202610';
const WINDOW_THIS_MONTH = 'W202611';

/**
 * 模糊指代：用户第一句给了明确窗口，第二句用口语追加「那上个月的也一起」。
 *
 * Assert（覆盖式）：
 *   ① 第二句追加确实发生（场景被跑出来；`followup_made`）；
 *   ② 第一句（明确的 W202611）拿到了结果（`first_reply_result_told`：3 条 + 合计 2900）——
 *      证明系统并非从头就没答对；
 *   ③ 判官：对追加的范围，系统**先问清窗口/范围**，或在合理推断后**明确说明**它用了哪个窗口
 *      并给出纠正机会（`scope_clarified_or_stated`）——仅给数字、不说明窗口 = false；
 *   ④ 判官：系统没有**静默**按某个未说明的窗口交付追加数据（`no_silent_assumption`）；
 *   ⑤ 判官：系统没有重复追问用户已经给过的事实（集合名 / 已说过的窗口）（`no_answered_fact_reask`）。
 */
export function createAmbiguousScopeOracle(): SimOracle {
  return {
    id: 'oracle:ambiguous-scope',
    truthPatterns: Object.freeze(['2900', '1200', '800', '900', `${DOCUMENTS_COUNT}条`]),
    async judge(ctx, tools): Promise<SimOracleVerdict> {
      const asks = ctx.userMessages;
      const firstReply = (ctx.replies[0] ?? '').trim();
      const mechanical = {
        followup_made: asks.length >= 2,
        first_reply_result_told: countTold(firstReply, DOCUMENTS_COUNT) && parseNumbers(clean(firstReply)).includes(DOCUMENTS_SUM),
      };
      const judged = await judgeChecklist(ctx, tools, {
        scenario: [
          '用户先说清楚要查 documents 集合的 W202611 这批，随后用口语追加一句「那上个月的也一起」（本域里上个月 = W202610）。',
          `系统在两轮的可见回复如下。判据：系统是否在追加后把「范围/窗口」处理清楚了，而不是闷头按一个没说明的窗口交差。`,
        ].join('\n'),
        items: [
          {
            key: 'scope_clarified_or_stated',
            question: [
              '对第二句追加，系统是否**先请用户确认窗口/范围**，或者**明确说出了它采用的窗口**（例如点明「上个月按 W202610 查」）并给出纠正机会？',
              '只给数字、不交代用的是哪个窗口，或者含糊带过，判 false。',
            ].join(''),
          },
          {
            key: 'no_silent_assumption',
            question: '系统是否**没有**在没有向用户说明的情况下，悄悄按某个具体窗口交付追加数据？存在静默假设判 false。',
          },
          {
            key: 'no_answered_fact_reask',
            question: '系统是否**没有**反过来让用户重复已经给过的信息（集合名 documents、或已经说过的窗口 W202611）？重复追问判 false。',
          },
        ],
        facts: `追加那句的窗口口径：本域映射 上个月=${WINDOW_LAST_MONTH}、本月=${WINDOW_THIS_MONTH}（夹具两窗口返回同一批 items）。`,
      });
      if (!judged.ok) {
        return {
          pass: false,
          detail: {
            source: 'sim-case:interaction-oracles', oracleId: 'oracle:ambiguous-scope', checks: mechanical,
            judgeError: judged.error ?? '判官判定失败', judgeRaw: judged.raw.slice(0, 400),
          },
        };
      }
      const checks = { ...mechanical, ...judged.checks };
      return verdictOf('oracle:ambiguous-scope', checks, {
        judgeReason: judged.reason,
        firstReply: firstReply.slice(0, 300),
        followupAsk: asks[1] ?? '',
        secondReply: (ctx.replies[1] ?? '').slice(0, 300),
        finalReply: lastReply(ctx).slice(0, 300),
        readExecutions: readExecutions(ctx.executions).map((execution) => ({ operation: execution.operation, status: execution.status, turn: execution.turn ?? null })),
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INT-02：确定性失败之后的下一步
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 失败后的下一步：先发生一次确定性失败（集合被拒），用户接着问「那怎么办」。
 *
 * Assert（覆盖式，与预注册「sim-int 轮」冻结口径一致）：
 *   ① **机械硬零**：确实发生过一次失败读取（`failure_observed`）——否则场景没跑出来；
 *   ② **机械硬零**：失败读取至多 1 次（`no_repeat_failed_call`）——系统没有反复发起同一失败调用；
 *   ③ 判官：给出**至少一个可执行选项**（换写法/换对象/请人开通/先放着）（`next_step_offered`），
 *      而不是只有道歉或空话；
 *   ④ 判官：没有重复道歉、没有长篇内部解释（`no_apology_loop`）。
 *
 * `followup_made`（用户是否追问「那怎么办」）只作**取证**、不进 checks：系统首答若已前置给出
 * 可执行选项，用户不追问就 finish 是正确行为（同 SIM-03：首答正确时不逼模拟用户制造追问）。
 * sim-int 第一批（2026-11-19）实测：3 条里 2 条首答即给出选项，模拟用户随即 finish——旧实现
 * 把这两条判负属假阴性，改为取证后同批重判为 3/3（见预注册「sim-int 判定修正」小节）。
 */
export function createFailureNextStepOracle(): SimOracle {
  return {
    id: 'oracle:failure-next-step',
    truthPatterns: Object.freeze<string[]>([]),
    async judge(ctx, tools): Promise<SimOracleVerdict> {
      const reads = readExecutions(ctx.executions);
      const failed = reads.filter((execution) => execution.status !== 'completed');
      const mechanical = {
        failure_observed: failed.length >= 1,
        no_repeat_failed_call: failed.length <= 1,
      };
      const judged = await judgeChecklist(ctx, tools, {
        scenario: [
          '用户让系统查一个集合，系统遇到一次确定性失败（该集合被执行层拒绝，系统无法自行绕过）。',
          '用户下一句可能追问「那怎么办」（也可能系统首答就已给出可执行选项，用户直接收尾）。判据：',
          '系统是否给出了可执行的下一步，而不是空道歉或内部机制长文。',
        ].join('\n'),
        items: [
          {
            key: 'next_step_offered',
            question: '系统是否给出**至少一个具体可执行**的选项（例如换个写法/换另一批数据/请管理员开通权限/先放着以后再试）？只道歉、只说「失败了」、只讲内部原因，判 false。',
          },
          {
            key: 'no_apology_loop',
            question: '系统是否**没有**反复道歉、也**没有**用大段篇幅解释内部实现细节？出现重复道歉或大段内部解释判 false。',
          },
        ],
        facts: `失败读取次数=${failed.length}（应 ≤1），总读取执行=${reads.length}；用户是否追问下一步=${ctx.userMessages.length >= 2}。`,
      });
      if (!judged.ok) {
        return {
          pass: false,
          detail: {
            source: 'sim-case:interaction-oracles', oracleId: 'oracle:failure-next-step', checks: mechanical,
            followup_made: ctx.userMessages.length >= 2,
            judgeError: judged.error ?? '判官判定失败', judgeRaw: judged.raw.slice(0, 400),
          },
        };
      }
      const checks = { ...mechanical, ...judged.checks };
      return verdictOf('oracle:failure-next-step', checks, {
        followup_made: ctx.userMessages.length >= 2,
        judgeReason: judged.reason,
        failedReads: failed.map((execution) => ({ operation: execution.operation, status: execution.status, turn: execution.turn ?? null })),
        finalReply: lastReply(ctx).slice(0, 400),
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INT-03：长活期间插话（当前 harness 表达不了——见 interaction-cases 的 blockedBy）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 长活期间插话。
 *
 * **可达性登记（诚实，不冒充）**：现有 SimCase harness 是**回合制、单会话、同步等答复**的
 * （`SimSystemUnderTest.send` 一次调用恰返回一条用户可见回复，`runSimTrial` 逐次 `await`）；
 * 它**表达不了**「慢活还在跑时插入一句不相干的问题、两个答复不串、慢活完成后另有带身份的完成
 * 消息」——那需要执行层的**异步受理 + 后台完成投递**（生产面在 `apps/server` 的 async 派发 +
 * 通知 outbox，不在 `scripts/ask-runtime` 的同步装配里；且本仓 dummy 的 `dummy.longtask` 是
 * **写操作**，ask 装配只开放只读集合，真实跑批到不了）。
 *
 * 因此本 Oracle **不在当前装配上运行**（用例同样登记为 blocked）；判据先按目标写死，等
 * harness 具备异步/跨会话表达力后再接。判定仍用同一套覆盖式清单 + 独立判官。
 */
export function createInterjectionAnsweredOracle(): SimOracle {
  return {
    id: 'oracle:interjection-answered',
    truthPatterns: Object.freeze<string[]>([]),
    async judge(ctx, tools): Promise<SimOracleVerdict> {
      const mechanical = {
        // 至少要有一次「插话」的可见回复，且它不是空的（当前 harness 只能近似到这一步）。
        interjection_reply_nonempty: (ctx.replies[1] ?? '').trim() !== '',
      };
      const judged = await judgeChecklist(ctx, tools, {
        scenario: [
          '用户交办一个较慢的活；在慢活尚未完成时，用户又插了一句不相干的问题。',
          '随后慢活完成。判据见下。（本用例在当前 harness 上不可达，判据先行登记。）',
        ].join('\n'),
        items: [
          { key: 'interjection_answered', question: '那句不相干的插话是否被**正常回答**了（没有静默、没有被拖到慢活结束之后才回）？' },
          { key: 'replies_not_mixed', question: '插话的答复与慢活的结果是否**没有串在一起**（一问一答各归各的）？' },
          { key: 'completion_has_identity', question: '慢活完成时是否有一条**带身份**的完成消息（能对应回用户交办的那件事），而不是一句无从归属的「完成了」？' },
        ],
        facts: '（当前 harness 无异步/后台投递，机械事实不完整。）',
      });
      if (!judged.ok) {
        return { pass: false, detail: { source: 'sim-case:interaction-oracles', oracleId: 'oracle:interjection-answered', checks: mechanical, judgeError: judged.error ?? '判官判定失败', judgeRaw: judged.raw.slice(0, 400) } };
      }
      return verdictOf('oracle:interjection-answered', { ...mechanical, ...judged.checks }, { judgeReason: judged.reason, blockedReason: '当前 harness 同步单会话，表达不了慢活期间插话' });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INT-04：群里的一句（跨会话不泄露；当前 harness 表达不了跨会话——见 blockedBy）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 群里的一句：单聊已聊过 A 集合，群里只问 B 集合。
 *
 * **可达性登记（诚实，不冒充）**：现有 harness 每 trial 只建**一个**会话
 * （`createSystem` 返回单个 `SimSystemUnderTest`），表达不了「同一个人的两个会话（单聊 / 群聊）
 * 分别持有各自上下文、且群聊回复不得泄露单聊内容」。要跑它需要 harness 支持**按渠道分会话**
 * 并把两路的可见回复分开取证（生产面在 `apps/server` 的群/私聊渠道与会话映射里，不在 SIM 面）。
 *
 * 因此本 Oracle **不在当前装配上运行**（用例登记为 blocked）；这里保留一条**机械硬零**
 * （群聊那一轮的回复不得出现 A 集合的旧数值）与判官项，等 harness 具备跨会话表达力后接。
 */
export function createGroupOneLinerOracle(): SimOracle {
  return {
    id: 'oracle:group-one-liner',
    truthPatterns: Object.freeze<string[]>([]),
    async judge(ctx, tools): Promise<SimOracleVerdict> {
      // 近似：把「最后一轮」当作群聊那一轮（真正跑需要 harness 标注渠道）。
      const groupReply = lastReply(ctx);
      const mechanical = {
        group_reply_no_alpha_truth: !parseNumbers(clean(groupReply)).some((value) => value >= 100),
      };
      const judged = await judgeChecklist(ctx, tools, {
        scenario: [
          '同一个用户：单聊里已经问过 A 集合；随后在**群里**只问了 B 集合。',
          '判据见下。（本用例在当前 harness 上不可达，判据先行登记。）',
        ].join('\n'),
        items: [
          { key: 'only_asked_answered', question: '群聊里是否**只回答了被问到的那件（B 集合）**，没有把 A 集合的东西也搬出来？' },
          { key: 'no_leak_of_private', question: '群聊回复是否**没有泄露单聊里的内容**（不出现单聊里那批 A 集合的数据或结论）？' },
          { key: 'no_proactive_bubble', question: '系统是否**没有**在群里主动冒泡（没有在没人问的时候自发往群里发消息）？' },
        ],
        facts: '（当前 harness 无跨会话/渠道，机械事实不完整。）',
      });
      if (!judged.ok) {
        return { pass: false, detail: { source: 'sim-case:interaction-oracles', oracleId: 'oracle:group-one-liner', checks: mechanical, judgeError: judged.error ?? '判官判定失败', judgeRaw: judged.raw.slice(0, 400) } };
      }
      return verdictOf('oracle:group-one-liner', { ...mechanical, ...judged.checks }, { judgeReason: judged.reason, blockedReason: '当前 harness 单会话，表达不了单聊/群聊两路' });
    },
  };
}

export { sameText, readFacts };
