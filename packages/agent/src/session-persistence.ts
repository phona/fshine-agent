/**
 * B1 会话持久化 —— 独立存储层（**本 run 不接生产装配**）。
 *
 * 目标：让 `(principalId, sessionId)` 的对话转录在进程重启后不丢，且**不引第二套任务
 * 事实源**、**不另建第二份可变 AgentMessage 转录状态**。
 *
 * 架构前提（硬，来自 owner）：
 *   · **Pi Session 是唯一转录所有者**。本层不持有 `AgentMessage[]`，不缓存完整转录；
 *     每次读都从 Pi Session 的 entry-log 现读（见 PersistedSessionImpl.readTranscript）。
 *   · **优先复用 Pi 正式公开的持久化能力**：直接复用 `JsonlSessionRepo` +
 *     `StorageBackedSession`（`@earendil-works/pi-agent-core/harness/session` 的公开导出），
 *     连文件系统能力都用 Pi 公开的 `NodeExecutionEnv`（`.../node`），不自造存储/编解码。
 *   · 本层只做一件事：把 `principalId` 映射成**独立存储子树**（隔离），把
 *     `(principalId, sessionId)` 映射成 Pi Session 的 `(cwd, id)`，并把「追加一条 Pi
 *     原生 message / 顺序读回转录」暴露成最小 API。没有规划、没有重放、没有任务状态。
 *
 * 为什么不是「第二份转录」：本层不拥有转录。写 = `Branch.appendMessage`（Pi 内部
 * 追加单条 entry + tip 写），读 = `Branch.findEntries`（Pi entry-log 回放）。本层只在
 * 两处之间传 Pi 原生 `AgentMessage`，不落任何自有 message 副本。这与被否证的
 * `docs/product/r5-session-persistence-design.md`「每回合追加完整转录快照」完全不同
 * ——后者在 Pi 之外维护一份随回合数逐次重写的 `messages` 数组落盘（O(n²) 无界增长），
 * 本层复用 Pi 的**单条 entry 追加日志**（线性增长，见文档 §增长特性）。
 *
 * 生产接线（`execution-runtime` 内存 `mainMessages` → 本层）**待与 Pi 迁移对齐后再做**，
 * 本模块不被任何生产入口 import。
 */
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import type { Context } from '@earendil-works/pi-agent-core/harness/context';
import { JsonlSessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import type {
  Entry,
  JsonlSessionMetadata,
  MessageEntry,
  Session,
} from '@earendil-works/pi-agent-core/harness/session';

/** Pi Session 内承载主转录的 branch 名（本层与 Pi 约定，非 Pi 内建默认）。 */
export const TRANSCRIPT_BRANCH = 'main';

/** 会话持久化层构造参数。 */
export interface SessionPersistenceOptions {
  /** 存储根目录（绝对路径或相对进程 cwd）。每个 principal 在其下获得独立子树。 */
  rootDir: string;
  /** 写入 Pi Session metadata 的工作目录（跨重启须稳定，否则目录/身份对不上）。 */
  cwd: string;
  /** 时间源注入（测试确定性）；缺省 `Date.now`。 */
  now?: () => number;
}

/** 单个已打开会话的最小句柄。只读写 Pi 原生 message，不暴露任何执行/任务入口。 */
export interface PersistedSession {
  readonly principalId: string;
  readonly sessionId: string;
  /** 该会话落盘文件的绝对路径（供隔离/崩溃核验；不被本层内部当作状态）。 */
  readonly filePath: string;
  /** 向 Pi Session 主 branch 追加**一条** Pi 原生 message（无本地转录副本）。 */
  append(message: AgentMessage): Promise<void>;
  /** 顺序读回主 branch 的全部 message（每次现读 Pi entry-log）。 */
  readTranscript(): Promise<AgentMessage[]>;
  /** 关闭该会话（释放 Pi Session 的 mutation barrier）。 */
  close(): Promise<void>;
}

const CONTEXT: Context = BACKGROUND_CONTEXT;

/** principal 名称映射为固定长度、无路径注入风险的子树名。 */
function principalSegment(principalId: string): string {
  return createHash('sha256').update(principalId, 'utf8').digest('hex');
}

class PersistedSessionImpl implements PersistedSession {
  /** 唯一持有的状态：Pi Session 句柄。**没有** messages 数组。 */
  private readonly session: Session<JsonlSessionMetadata>;
  private readonly onClose: () => void;
  private closed = false;

  constructor(
    readonly principalId: string,
    readonly sessionId: string,
    readonly filePath: string,
    session: Session<JsonlSessionMetadata>,
    onClose: () => void,
  ) {
    this.session = session;
    this.onClose = onClose;
  }

  async append(message: AgentMessage): Promise<void> {
    const branch = await this.session.branch(TRANSCRIPT_BRANCH, CONTEXT);
    if (branch === undefined) {
      throw new Error(`Session ${this.sessionId} has no ${TRANSCRIPT_BRANCH} branch`);
    }
    await branch.appendMessage(message, CONTEXT);
  }

  async readTranscript(): Promise<AgentMessage[]> {
    const branch = await this.session.branch(TRANSCRIPT_BRANCH, CONTEXT);
    if (branch === undefined) return [];
    const entries: Entry[] = await branch.findEntries({ order: 'oldestFirst' }, CONTEXT);
    return entries
      .filter((entry): entry is MessageEntry => entry.type === 'message')
      .map((entry) => entry.message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.session.close(CONTEXT);
    this.onClose();
  }
}

/**
 * 按 `(principalId, sessionId)` 持久化 Pi 原生对话转录。
 *
 * 隔离模型：每个 principal 拥有 `<rootDir>/principals/<sha256(principalId)>` 这个
 * **独立 Pi Session 仓库根**。不同 principal 的 session 在文件系统上物理分离，
 * 跨 principal 不可能读到彼此条目（同名 sessionId 也各归各的子树）。
 */
export class SessionPersistence {
  private readonly rootDir: string;
  private readonly cwd: string;
  private readonly now: () => number;
  private readonly env: NodeExecutionEnv;
  private readonly repos = new Map<string, JsonlSessionRepo>();
  private readonly sessions = new Map<string, PersistedSessionImpl>();
  private closed = false;

  constructor(options: SessionPersistenceOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.cwd = options.cwd;
    this.now = options.now ?? Date.now;
    this.env = new NodeExecutionEnv({ cwd: this.rootDir });
  }

  private repoFor(principalId: string): JsonlSessionRepo {
    let repo = this.repos.get(principalId);
    if (repo === undefined) {
      const sessionsRoot = path.join(
        this.rootDir,
        'principals',
        principalSegment(principalId),
      );
      repo = new JsonlSessionRepo({ fileSystem: this.env, sessionsRoot, now: this.now });
      this.repos.set(principalId, repo);
    }
    return repo;
  }

  /** 打开已存在会话，或在**本 principal 子树**内新建一个（首次调用创建 branch）。 */
  async openOrCreate(principalId: string, sessionId: string): Promise<PersistedSession> {
    this.assertOpen();
    const key = sessionKey(principalId, sessionId);
    const existing = this.sessions.get(key);
    if (existing !== undefined) return existing;

    const repo = this.repoFor(principalId);
    const found = (await repo.list(undefined, CONTEXT)).find((meta) => meta.id === sessionId);

    // 损坏显式报错：Pi 的 list() 会静默跳过 header 不可解析的文件。若盘上已有该
    // sessionId 的文件却未被 list 列出，说明其 header 已损坏——**不能**静默当成不存在
    // 去重新建仓（那会掩盖损坏、并可能与旧文件冲突）。这里显式走 repo.open 触发 Pi 的
    // 解析错误（invalid/missing header），让调用方看到真实失败。
    let orphanSession: Session<JsonlSessionMetadata> | undefined;
    let orphanPath: string | undefined;
    if (found === undefined) {
      orphanPath = this.findSessionFile(principalId, sessionId);
      if (orphanPath !== undefined) {
        orphanSession = await repo.open(
          {
            id: sessionId,
            createdAt: 0,
            storageVersion: 1,
            cwd: this.cwd,
            path: orphanPath,
            modifiedAt: 0,
          },
          CONTEXT,
        );
      }
    }

    let session: Session<JsonlSessionMetadata>;
    let filePath: string;
    if (found !== undefined) {
      session = await repo.open(found, CONTEXT);
      filePath = found.path;
    } else if (orphanSession !== undefined && orphanPath !== undefined) {
      session = orphanSession;
      filePath = orphanPath;
    } else {
      session = await repo.create({ id: sessionId, cwd: this.cwd }, CONTEXT);
      filePath = session.metadata.path;
    }

    // 崩溃可能停在「已建文件、未建 branch」之间：幂等补齐，避免 reopen 后半态。
    if ((await session.branch(TRANSCRIPT_BRANCH, CONTEXT)) === undefined) {
      await session.createBranch(TRANSCRIPT_BRANCH, null, CONTEXT);
    }

    const persisted = new PersistedSessionImpl(
      principalId,
      sessionId,
      filePath,
      session,
      () => {
        if (this.sessions.get(key) === persisted) this.sessions.delete(key);
      },
    );
    this.sessions.set(key, persisted);
    return persisted;
  }

  /** 列出**本 principal 子树**内的会话 metadata（不跨 principal）。 */
  async list(principalId: string): Promise<JsonlSessionMetadata[]> {
    this.assertOpen();
    return this.repoFor(principalId).list(undefined, CONTEXT);
  }

  /** 删除会话文件（若已打开则先关闭）。 */
  async delete(principalId: string, sessionId: string): Promise<void> {
    this.assertOpen();
    const repo = this.repoFor(principalId);
    const found = (await repo.list(undefined, CONTEXT)).find((meta) => meta.id === sessionId);
    if (found === undefined) return;
    await this.sessions.get(sessionKey(principalId, sessionId))?.close();
    await repo.delete(found, CONTEXT);
  }

  /** 关闭全部会话与仓库。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const session of [...this.sessions.values()]) {
      await session.close();
    }
    this.sessions.clear();
    for (const repo of this.repos.values()) {
      await repo.close(CONTEXT);
    }
    this.repos.clear();
    await this.env.cleanup(CONTEXT);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SessionPersistence is closed');
  }

  /** 在本 principal 子树内按文件名后缀定位某 sessionId 的落盘文件（不依赖 Pi 私有目录命名）。 */
  private findSessionFile(principalId: string, sessionId: string): string | undefined {
    const repoRoot = path.join(this.rootDir, 'principals', principalSegment(principalId));
    const suffix = `_${encodeURIComponent(sessionId)}.jsonl`;
    const stack: string[] = [repoRoot];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (dir === undefined) break;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // 目录不存在（尚无任何会话）→ 无孤儿文件。
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.endsWith(suffix)) return full;
      }
    }
    return undefined;
  }
}

function sessionKey(principalId: string, sessionId: string): string {
  return `${principalId}\u0000${sessionId}`;
}
