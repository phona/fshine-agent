/**
 * 消息处理主链路:授权 → 审计 → Agent(runtime + LLM)→ Context Worker → 回复。
 * 被 apps/server/main.ts 与 tests/e2e 共用,保证测的就是跑的。
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type {
  AgentReply,
  AgentRequestRepo,
  AgentRuntime,
  AuditStore,
  ChannelReply,
  IncomingAttachment,
  IncomingChannelMessage,
  NoticeFn,
  OutgoingFileReply,
  ProgressFn,
  ReplyHandler,
} from '@fshine/contracts';
import { newId } from '@fshine/core';
import { isScratchDirName } from '@fshine/agent';

export interface HandlerDeps {
  /** 环境变量源（读 FSHINE_INBOUND_DEBOUNCE_MS）；缺省 process.env。 */
  env?: Record<string, string | undefined>;
  /** 平台工作区根：用于收集本轮回传给用户的产物文件（只认 tmp/ 下的）。 */
  platformRoot?: string;
  /**
   * 入站防抖窗口（毫秒）：带正文的消息在进入会话队列前先等这么久，让同一burst里
   * 稍晚到达的附件先落地。缺省取 env `FSHINE_INBOUND_DEBOUNCE_MS`，再缺省 2000。
   *
   * 为什么需要：企微的模型里"3 个文件 + 1 条指令"是 4 条独立消息（`MixedMsgItem` 只支持
   * text/image，文件无法与文字同条），而会话队列是串行的——指令那条一启动，晚到的文件
   * 只能排到它后面，于是这一轮用不上（2026-10-08 实测：4 条消息同一秒内到达，顺序是
   * 文件→指令→文件，指令那轮只带了 2 个）。
   * 参照 OpenClaw `messages.inbound.debounceMs`：文本参与防抖，媒体/附件立即 flush。
   * 附件-only 消息因此**不等待**（用户发完文件立刻看到"已收到"）。
   */
  inboundDebounceMs?: number;
  store: AuditStore;
  runtime: AgentRuntime;
  planConfirmation?: {
    handle(message: { origin: 'wecom_user'; messageId: string; principalId: string; sessionId: string; text: string; receivedAt: string }): Promise<{ status: string; planId?: string; version?: number; taskId?: string }>;
    savePending?: (pending: { planId: string; version: number; taskId: string; principalId: string; sessionId: string; requestId: string; userText: string }) => Promise<void>;
  };
}


/**
 * 取本会话迄今可用的附件：内存优先，DB 兜底（重启恢复）。
 *
 * 三条纪律：① 去重按 path（同一文件不因"内存有、DB 也有"而重复进请求）；② 只保留最新
 * N 个（与暂存上限同一个数，避免无限增长把每个回合的输入撑爆）；③ 只保留**仍在盘上**的
 * ——tmp/ 会被 24h 清理回收，路径失效就该安静退出，而不是让 worker 拿一个打不开的路径。
 */
async function restoreAttachments(
  sessionKey: string,
  message: IncomingChannelMessage,
  store: HandlerDeps['store'],
  sessionAttachments: Map<string, IncomingAttachment[]>,
): Promise<IncomingAttachment[]> {
  const fromMemory = sessionAttachments.get(sessionKey) ?? [];
  const fromDb = await loadRecentAttachments(store, message.wecomUserId, sessionKey);
  const merged = new Map<string, IncomingAttachment>();
  // DB 在前、内存在后：同 path 时内存覆盖 DB（内存是更新的那份）
  for (const file of [...fromDb, ...fromMemory, ...(message.attachments ?? [])]) merged.set(file.path, file);
  const existing = [...merged.values()]
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(-MAX_PENDING_ATTACHMENTS)
    .filter((file) => existsSync(file.path));
  if (existing.length > 0) sessionAttachments.set(sessionKey, existing);
  return existing;
}

/**
 * 从审计存储读本 principal 最近的附件接收行，解析附件信封。
 *
 * 只认 outcome='attachment_received' 的行——那是"只发附件、没有指令"的登记；带附件的
 * 普通回合其附件已在自身 input 里，不需要在这里重复取。
 * 任何失败（旧库没有这个方法 / 查询抛错）都返回空数组：恢复是增强，不是前提。
 */
async function loadRecentAttachments(store: HandlerDeps['store'], wecomUserId: string, sessionKey: string): Promise<IncomingAttachment[]> {
  const repo = store.requests as Partial<AgentRequestRepo>;
  if (typeof repo.listRecentAttachments !== 'function') return [];
  try {
    const rows = await repo.listRecentAttachments(
      `wecom:${wecomUserId}`,
      new Date(Date.now() - ATTACHMENT_RESTORE_WINDOW_MS).toISOString(),
    );
    const seen = new Map<string, IncomingAttachment>();
    for (const row of rows) for (const file of parseAttachmentEnvelope(row.input, sessionKey)) seen.set(file.path, file);
    return [...seen.values()];
  } catch {
    return [];
  }
}

/** 入站防抖默认窗口：2 秒。参照 OpenClaw 默认 1500–2000ms；群聊可调更短。 */
const DEFAULT_INBOUND_DEBOUNCE_MS = 2000;

/** 单会话附件暂存上限（模块级：restoreAttachments 在闭包外也要用）。 */
const MAX_PENDING_ATTACHMENTS = 8;

/** 恢复窗口：只认最近 24h 内登记的附件。更早的要么已用完，要么已被 tmp 清理回收。 */
const ATTACHMENT_RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;


/**
 * 收集本轮产生的、用户能直接消费的终态产物。
 *
 * 判据（"可交付结果 = 本轮产生的、用户能直接消费的终态产物"）：
 *   ① 在平台 `tmp/` 之下——受信边界内，不让人借机器人外发别处的文件；
 *   ② `mtime >= since`——本轮委派开始之后才落盘的，才是本轮产物；
 *   ③ 扩展名是办公文档（OFFICE_EXT）；
 *   ④ 不在 `tmp/attachments/`——那是本轮**输入**；
 *   ⑤ 不在别的 `tmp/req_<uuid>/`——那是别的会话的草稿位置；
 *   ⑥ 普通文件且 ≤ 20MB。
 *
 * **为什么不再让 worker 声明路径**：旧约定是"worker 在回复末行写 `[发送文件] <绝对路径>`，
 * 宿主解析这句话"。它必然失败——产物落在哪不由 worker 决定。实证：平台薪酬域的
 * transform.py 输出 xlsx 时，若目标文件正被 Excel 打开占用，会自动 fallback 到 `tmp/` 下
 * 一个名字带"（自动）"的路径；worker 无法预先知道这一次会走哪条分支，只能跑完后列位置。
 * 而"跑完后看落了什么"是纯 plumbing，本该由宿主代码直连，不过 AI 的手——worker 只说
 * "做完了"，文件由宿主按上面的判据自己扫出来。于是"它忘了写 / 写错路径 / 压根不知道路径"
 * 这三种静默失败形态一并消失：回传不再依赖回复文本里出现任何标记。
 *
 * 去重按**解析后的真实路径**：扫描会解引用符号链接（否则 worker 用链接指向的产物会漏收），
 * 而解引用一来会让同一文件有两个名字（去重必须按真实路径算），二来会让一个指向受信边界外
 * 的链接借机器人外发文件——旧实现靠"路径文本以 tmp/ 开头"守住的边界，解引用后必须用真实
 * 路径再守一次，所以解析后仍要求在 `tmp/` 内。
 */
const OFFICE_EXT = new Set(['.xlsx', '.xls', '.csv', '.pdf', '.docx']);
const MAX_OUT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_OUT_FILES = 3;
/** 入站附件的暂存位置名（`tmp/attachments/`）：那是输入，永远不是要回传的产物。 */
const ATTACHMENTS_DIR_NAME = 'attachments';

export function collectProducedFiles(platformRoot: string, since: string, requestId: string): OutgoingFileReply[] {
  const sinceMs = Date.parse(since);
  let tmpRoot: string;
  try {
    tmpRoot = realpathSync(path.join(platformRoot, 'tmp'));
  } catch {
    return [];                                                     // tmp/ 不在 = 没有产物
  }
  // 真实路径 → mtime。用 Map 而非数组：同一文件被链接指过来时天然只记一份。
  const found = new Map<string, number>();
  const visit = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;                                                      // 读不了的位置当作没有产物
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 顶层就绕开两类非本产物位置：附件输入区、以及**别的**会话的草稿位置。省得白走，
        // 也避免把别人的中间产物读进来。真正的判据仍在下面按真实路径复核一遍——符号链接
        // 可能从别处指回这两类位置，只在这一层拦不住。
        if (depth === 0 && (entry.name === ATTACHMENTS_DIR_NAME || (isScratchDirName(entry.name) && entry.name !== requestId))) continue;
        visit(full, depth + 1);
        continue;
      }
      // 普通文件与符号链接都当候选；别的类型（socket/fifo）不可能是什么产物。
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        continue;                                                  // 悬空链接：当作没发生过
      }
      const rel = path.relative(tmpRoot, real);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;   // 逃出受信边界
      const top = rel.split(path.sep)[0]!;
      if (top === ATTACHMENTS_DIR_NAME) continue;                  // 输入，不是产物
      if (isScratchDirName(top) && top !== requestId) continue;    // 别人会话的草稿
      if (!OFFICE_EXT.has(path.extname(real).toLowerCase())) continue;
      try {
        const stat = statSync(real);
        if (!stat.isFile() || stat.size > MAX_OUT_FILE_BYTES) continue;
        if (stat.mtimeMs < sinceMs) continue;                      // 不是本轮产生的
        if (!found.has(real)) found.set(real, stat.mtimeMs);
      } catch {
        continue;                                                  // 扫描过程中被清掉
      }
    }
  };
  visit(tmpRoot, 0);
  // 最新的在前：本轮最后落盘的那份最可能是终态产物（fallback 分支会另起一个名字，时间上
  // 晚于主产物）。同毫秒按路径排序，保证同一份盘上状态下结果确定。
  const ordered = [...found.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([filePath]) => filePath);
  const out: OutgoingFileReply[] = [];
  for (const filePath of ordered) {
    try {
      out.push({ data: readFileSync(filePath), filename: path.basename(filePath) });
    } catch {
      continue;                                                    // 刚要发就被删了：安静跳过
    }
    if (out.length >= MAX_OUT_FILES) break;
  }
  return out;
}

function withFileReplies(text: string, platformRoot: string | undefined, since: string, requestId: string): ChannelReply {
  if (!platformRoot) return text;
  const [file] = collectProducedFiles(platformRoot, since, requestId);
  return file ? { text, file } : text;
}

export function createMessageHandler(deps: HandlerDeps): ReplyHandler {
  const { store, runtime } = deps;
  // 同一会话的消息串行处理(pi 的 steering/followUp 队列哲学):
  // 并发回合会竞态会话状态(候选/游标/历史互相覆盖),必须排队
  const sessionQueues = new Map<string, Promise<unknown>>();
  /**
   * 会话级附件集：用户"先发文件、再发指令"时，文件消息只登记不启回合。
   *
   * 否则 N 个文件 = N 次 LLM 调用，且串行堵住队列——真正带指令的那条排在后面出不来。
   * 2026-10-07 实测：3 个文件 + 1 条指令 → 4 个 ack、0 个最终回复，第一条文件回合在
   * LLM 上卡住（10 分钟预算内不返回），用户的指令被它挡死。
   *
   * 上限 8 个，FIFO 逐出最旧的（逐出要告知：用户不知道自己最早发的那个已不算数）。
   * 不设上限会把后续每个回合的输入撑爆，而那正是它要避免的问题。
   *
   * **累积而不消费**：用户心智是"我在这个对话里上传过文件"，不是"文件只对下一句指令有效"。
   * 最初实现成"文字回合取走即清空"，结果用户重复指令时集子已空，机器人回"没收到数据"而
   * 用户完全无法理解（2026-10-07 实测）。现在文字回合拿到本会话迄今的全部附件。
   */
  const sessionAttachments = new Map<string, IncomingAttachment[]>();
  /**
   * 会话是否已经跑过带正文的回合。
   *
   * 用来识别"文件迟到了"：附件缓冲只在文字回合被消费，所以指令之后才到的文件进的是新缓冲，
   * 而上一轮指令已经跑完、看不到它。若不告知，用户会以为机器人收了文件就该办事，实际它在
   * 等一句永远不会来的指令——2026-10-07 实测正是这个形态（第三个文件迟到，干等到超时）。
   * 所以迟到的文件要明确说"指令请再发一次"。
   */
  const seenTextTurn = new Set<string>();

  // 空串必须归一成 NaN 而不是 0：Number('') === 0，会被当成「显式配置了 0」，
  // 于是默认值永远不生效（2026-10-08 测试抓到的静默失效）。
  const rawDebounce = deps.env?.['FSHINE_INBOUND_DEBOUNCE_MS']?.trim();
  const fromEnv = rawDebounce ? Number(rawDebounce) : Number.NaN;
  const debounceMs = deps.inboundDebounceMs ?? (Number.isFinite(fromEnv) ? fromEnv : DEFAULT_INBOUND_DEBOUNCE_MS);

  return async (message: IncomingChannelMessage, progress?: ProgressFn, notice?: NoticeFn): Promise<ChannelReply> => {
    const queueKey = `${message.wecomUserId}:${message.conversationId}`;
    // 防抖只在"带正文"的消息上生效，且在入队**之前**等——这样窗口内到达的附件消息
    // 会先拿到队列（它们的活只是落盘+暂存，很快），文字回合随后就能带上它们。
    // 附件-only 消息不等：用户发完文件要立刻看到确认。
    if (!message.attachmentOnly && debounceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, debounceMs));
    }
    const prev = sessionQueues.get(queueKey) ?? Promise.resolve();
    const task = prev.then(() => processMessage(message, progress, notice));
    // Keep a rejection-safe promise in the map so the next turn can always
    // start, while retaining the exact identity for cleanup below.
    // 错误必须留痕：`task.catch(() => undefined)` 的语义是"别让一个失败回合毒化队列"，
    // 但它同时会把失败吞得无声无息——2026-10-07 实测有一个附件回合在队列里消失，
    // 没有任何痕迹，而会话队列又串行，后续请求全被它挡住。当时日志已被重启覆盖，
    // 于是连"它是失败了还是根本没跑"都无法判断。所以这里至少打一条。
    const queued = task.catch((error: unknown) => {
      console.error(JSON.stringify({
        event: 'wecom_turn_failed',
        messageId: message.messageId,
        principalId: `wecom:${message.wecomUserId}`,
        error: error instanceof Error ? error.message : String(error),
      }));
      return undefined;
    });
    sessionQueues.set(queueKey, queued);
    void queued.finally(() => {
      if (sessionQueues.get(queueKey) === queued) sessionQueues.delete(queueKey);
    });
    return task;
  };

  async function processMessage(
    message: IncomingChannelMessage,
    progress?: ProgressFn,
    notice?: NoticeFn,
  ): Promise<ChannelReply> {
    const principalId = `wecom:${message.wecomUserId}`;
    const sessionKey = `${message.wecomUserId}:${message.conversationId}`;
    const requestId = newId('req');
    const createdAt = new Date().toISOString();

    // ── 附件-only 消息：只暂存，不启回合 ──────────────────────────────────────
    // 仍要落一条审计（"这一轮用户给了什么"是排查时最缺的证据），但 outcome 区别于 replied，
    // 且不调 LLM。返回的文本会以 finish=true 收尾——否则客户端 spinner 永远转
    // （适配器只在 rich.text 非空时才发收尾帧）。
    if (message.attachmentOnly && message.attachments && message.attachments.length > 0) {
      // 统一按"保留最新 N 个"：既覆盖会话日积月累挤掉最旧，也覆盖一次就发超过 N 个。
      // 最初分两条路写（先看出能不能装下本轮），结果一批超限时保留了**最先**的 N 个、
      // 丢掉最后发的——与"逐出最旧"自相矛盾，且丢的是最新那份。
      const before = sessionAttachments.get(sessionKey) ?? [];
      const combined = [...before, ...message.attachments];
      const kept = combined.slice(-MAX_PENDING_ATTACHMENTS);
      const dropped = combined.slice(0, combined.length - kept.length);
      if (kept.length > 0) sessionAttachments.set(sessionKey, kept);
      const accepted = kept.slice(before.length); // 本轮真正新进来的
      await store.requests.insert({
        requestId, wecomMessageId: message.messageId, principalId,
        input: withAttachmentPaths(message.text, accepted, sessionKey), createdAt, outcome: 'attachment_received',
      });
      // 文案纪律：短、只说事实。曾有"请告诉我需要做什么。"——那是噪音：用户当然知道
      // 要说话，而且一发 N 个文件就刷 N 条同样的话。超限时才多说一句（那是用户不知道的）。
      const names = accepted.map((file) => file.filename).join('、');
      const notes: string[] = [];
      if (dropped.length > 0) notes.push(`另有 ${dropped.length} 个超出暂存上限（${MAX_PENDING_ATTACHMENTS} 个）未收：${dropped.map((f) => f.filename).join('、')}`);
      if (seenTextTurn.has(sessionKey)) notes.push('上一条指令已经处理完了，请把指令再发一次，这些文件会一起用上');
      return `已收到 ${names}${notes.length > 0 ? `；${notes.join('；')}` : ''}`;
    }

    seenTextTurn.add(sessionKey);
    // 本会话迄今的全部附件；**不清空**（累积语义，见 sessionAttachments 注释）。
    // 另外并入 DB 里 Recent 的附件接收行——内存关联会随服务重启失记（2026-10-07 实测：
    // 连重启三次后，用户早先上传的文件还在盘上，但请求里一个路径都没有，worker 只能回
    // "没有数据"）。落库数据因此不只是审计，也是重启后的恢复源。
    const attachments = await restoreAttachments(sessionKey, message, store, sessionAttachments);

    const input = withAttachmentPaths(message.text, attachments);
    const base = { requestId, wecomMessageId: message.messageId, principalId, input, createdAt };

    const scope = await store.principalScopes.get(message.wecomUserId);
    if (!scope || !scope.enabled) {
      await store.requests.insert({ ...base, outcome: 'denied' });
      return `该账号(${principalId})未开通查询权限,请联系管理员开通。`;
    }
    await store.requests.insert({ ...base, outcome: 'replied' });

    try {
      // 本轮委派开始时刻：产物回传按它划界（collectProducedFiles 的 since）。
      //
      // 为什么不用 createdAt：那一刻还在队列里等防抖、等上一回合跑完，本轮 worker 一个文件
      // 都还没写；拿它当界会把**上一轮**落在 tmp/ 里的产物也算成本轮的，于是同一份文件被
      // 反复回传。而反过来，委派前一刻记的界又能覆盖整个 worker 执行期（含平台执行器在占用
      // 时改走 fallback 分支、晚一步才落盘的那份）——worker 无法预知分支，宿主也不必预知。
      const delegatedAt = new Date().toISOString();
      let noticeSequence = 0;
      const onNotice: NoticeFn | undefined = notice ? async (text) => {
        await notice(text);
        try {
          await store.conversationLog?.append({
            eventId: `${requestId}:plan_notice:${++noticeSequence}`,
            principalId,
            sessionId: `wecom:${sessionKey}`,
            kind: 'plan_event',
            content: redactNotice(text),
            createdAt: new Date().toISOString(),
            requestId,
          });
        } catch (error) {
          console.warn(JSON.stringify({ event: 'plan_notice_log_failed', requestId, error: error instanceof Error ? error.message : String(error) }));
        }
      } : undefined;
      const trusted = {
        requestId,
        principalId,
        allowedAccountSetIds: scope.accountSetIds,
        capabilities: scope.capabilities,
        sessionId: `wecom:${sessionKey}`,
        onStep: progress,
        ...(onNotice ? { onNotice } : {}),
        ...(deps.planConfirmation?.savePending ? { onPlanPending: deps.planConfirmation.savePending } : {}),
      };
      if (deps.planConfirmation) {
        const confirmation = await deps.planConfirmation.handle({
          origin: 'wecom_user', messageId: message.messageId, principalId, sessionId: `wecom:${sessionKey}`,
          text: message.text, receivedAt: message.receivedAt,
        });
        if (confirmation.status === 'activated') {
          if (!confirmation.taskId) throw new Error('已确认的计划缺少原任务标识。');
          const resumed = await runtime.handleTurn({ ...trusted, resumeTaskId: confirmation.taskId }, input);
          return withFileReplies(resumed.text, deps.platformRoot, delegatedAt, requestId);
        }
        if (confirmation.status === 'superseded') return '这项扩大查询已经被更新的计划取代，之前的确认不再有效。请重新发起查询，我会按新的范围再问你一次。';
        if (confirmation.status === 'cancelled') return '已取消本次扩大查询。';
        if (confirmation.status === 'ambiguous') return '当前有多个待确认查询，请先说明要继续哪一个。';
        if (confirmation.status === 'expired') return '这项查询确认已过期，请重新发起查询。';
      }
      const reply = await runtime.handleTurn(
        trusted,
        input,
      );
      return withFileReplies(reply.text, deps.platformRoot, delegatedAt, requestId);
    } catch (error) {
      await store.requests.setOutcome(requestId, 'failed');
      console.error(JSON.stringify({
        event: 'turn_failed',
        requestId,
        error: error instanceof Error ? error.message : String(error),
      }));
      return '处理失败,请稍后再试。';
    }
  }
}

function redactNotice(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

/**
 * 把附件路径拼进请求文本——**这是附件链路的最后一环**。
 *
 * 渠道层只把附件落盘并给出路径；路径若不出现在请求文本里，worker 就看不见它，
 * 于是"用户发了 3 个 Excel"和"用户什么都没发"对下游完全等价。 * 2026-10-07 之前正是如此：契约里没有附件概念，`[File: xxx.xlsx]` 只是渠道渲染的
 * 占位符，没有任何组件去下载它。
 *
 * 为什么放在宿主而不是渠道：渠道层只负责"拿到文件"，"worker 该看到什么形状的请求"
 * 是宿主策略（换任何渠道、任何执行层都该由宿主统一决定），不放适配器里。
 *
 * 审计含义：`input` 因此带上绝对路径——请求审计里能查到"这一轮到底用了哪个文件"，
 * 这正是当初排查"工资表为什么没出来"时最缺的那条证据。
 */
/** 把可写位置声明拼进请求文本（纯函数，便于单测；调用处见 processMessage）。 */
export function withScratchDir(text: string, scratchDir: string): string {
  return `${text}\n\n[本轮的可写位置：${scratchDir} —— 中间产物（契约、mapping、临时脚本）只写这里，别的路径不可写]`;
}

/**
 * 附件信封标记：一行 JSON，供宿主人群重建"这个会话有哪些附件"。
 *
 * 为什么需要：附件关联原本只在进程内存里，服务一重启就失记——2026-10-07 实测连重启三次
 * 之后，用户早先上传的文件仍在盘上，但 worker 拿到的请求里一个路径都没有，于是它如实回
 * "没有数据"，而用户完全无法理解（他明明传过）。附件接收行本来就落库（outcome=
 * attachment_received），只是 input 是自由文本、不好可靠解析；加一行信封即可机械取回。
 *
 * 放在这一行而不是别处：人类可读（就是路径清单）、模型无歧义（单行 JSON）、解析零启发式。
 */
const ATTACHMENT_ENVELOPE = '<!--attachments:';

/**
 * 从请求文本取回附件信封（重启恢复用）。
 *
 * **会话隔离在这里，不是可选项**：信封必须带 `sessionKey` 且与当前会话一致才恢复。
 * 2026-10-07 第一版只按用户维度恢复（`agent_requests` 也没有 session 列），于是同一个人
 * 在单聊里传的工资表，会出现在他后续在群里发的请求里——代账会计服务多家客户时，那就是把
 * 甲客户的文件递给处理乙请求的 worker。没有 sessionKey 的旧信封一律不恢复：宁可少恢复，
 * 也不能跨会话递文件。
 */
export function parseAttachmentEnvelope(text: string, sessionKey?: string): IncomingAttachment[] {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(ATTACHMENT_ENVELOPE) || !trimmed.endsWith('-->')) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(ATTACHMENT_ENVELOPE.length, -3)) as { sessionKey?: unknown; files?: unknown };
      if (!sessionKey || typeof parsed.sessionKey !== 'string' || parsed.sessionKey !== sessionKey) return [];
      const files = parsed.files;
      if (!files || typeof files !== 'object') return [];
      return Object.entries(files as Record<string, unknown>)
        .filter(([, filePath]) => typeof filePath === 'string' && filePath.startsWith('/'))
        .map(([filename, filePath]) => ({ filename, path: filePath as string, bytes: 0 }));
    } catch {
      return [];
    }
  }
  return [];
}

export function withAttachmentPaths(text: string, attachments?: readonly IncomingAttachment[], sessionKey?: string): string {
  if (!attachments || attachments.length === 0) return text;
  const lines = attachments.map((file) => `- ${file.filename}：${file.path}`);
  const envelope = `${ATTACHMENT_ENVELOPE}${JSON.stringify({
    sessionKey: sessionKey ?? null,
    files: Object.fromEntries(attachments.map((f) => [f.filename, f.path])),
  })}-->`;
  return `${text}\n\n[本次消息附带的文件路径，可按路径直接使用]\n${lines.join('\n')}\n${envelope}`;
}

/**
 * 本轮可写位置（每请求一个，随机源用 requestId）。
 *
 * 为什么必须是每请求一个而不是共享 tmp/：多个会话同时写 `tmp/contract.json` 会互相覆盖，
 * 而覆盖后的产物看不出被谁污染。宿主已有随机源（requestId），派生子位置即可——worker 自己
 * 没有随机手段，也不该由它编名字（编了还是会撞）。
 *
 * 这不是"告诉它一个约定"，是配套 serve-gate 的机械边界：门只放行 `tmp/<requestId>/`，
 * 所以这句话同时是**唯一可写的位置声明**。缺了它，worker 只能猜，猜错就被门拒。
 */
