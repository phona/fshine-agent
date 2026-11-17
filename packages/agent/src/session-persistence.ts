/**
 * B1 会话持久化 —— 独立存储层。
 *
 * 目标：让 `(principalId, sessionId)` 的对话转录在进程重启后不丢，且**不引第二套任务
 * 事实源**、**不另建第二份可变 AgentMessage 转录状态**。
 *
 * 架构前提（硬，来自 owner）：
 *   · **Pi Session 是唯一转录所有者**。本层不持有 `AgentMessage[]`，不缓存完整转录；
 *     每次读都从 Pi 的 entry-log 现读（见 PersistedSessionImpl.readTranscript）。
 *   · **只复用 Pi 正式公开的持久化能力**：`@earendil-works/pi-coding-agent` root 导出的
 *     `SessionManager`（`create` / `open`）。不自造存储/编解码，不 deep-import 未导出路径。
 *   · 本层只做三件 Pi 单用 `SessionManager` 做不到的事（阶段 C 已证）：
 *       ① 把 `principalId` 映射成**独立存储子树**（物理隔离，同名 sessionId 互不串读）；
 *       ② 把 `(principalId, sessionId)` 映射成**唯一**一份会话文件（重复/非法 id 显式报错）；
 *       ③ 打开前**校验落盘文件**（坏 header / 坏 JSON 行显式抛错，崩溃半行尾丢弃），
 *          并暴露「追加一条 Pi 原生 message / 顺序读回转录」的最小 API。
 *     没有规划、没有重放、没有任务状态。
 *
 * 为什么不是「第二份转录」：本层不拥有转录。写 = `SessionManager.appendMessage`（Pi 内部
 * 追加单条 entry），读 = `SessionManager.getBranch`（Pi entry-log 回放）。本层只在两处之间
 * 传 Pi 原生 `AgentMessage`，不落任何自有 message 副本。这与被否证的
 * `docs/product/r5-session-persistence-design.md`「每回合追加完整转录快照」完全不同
 * ——后者在 Pi 之外维护一份随回合数逐次重写的 `messages` 数组落盘（O(n²) 无界增长），
 * 本层复用 Pi 的**单条 entry 追加日志**（线性增长）。
 *
 * 生产接线（`execution-runtime` 内存转录 → 本层）见 `apps/server/server.ts` 的装配。
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
} from 'node:fs';
import path from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent';

/** 会话持久化层构造参数。 */
export interface SessionPersistenceOptions {
  /** 存储根目录（绝对路径或相对进程 cwd）。每个 principal 在其下获得独立子树。 */
  rootDir: string;
  /** 写入 Pi Session header 的工作目录（跨重启须稳定，否则目录/身份对不上）。 */
  cwd: string;
}

/** 单个已打开会话的最小句柄。只读写 Pi 原生 message，不暴露任何执行/任务入口。 */
export interface PersistedSession {
  readonly principalId: string;
  readonly sessionId: string;
  /** 该会话落盘文件的绝对路径（供隔离/崩溃核验；不被本层内部当作状态）。 */
  readonly filePath: string;
  /** 向 Pi Session 主路径追加**一条** Pi 原生 message（无本地转录副本）。 */
  append(message: AgentMessage): Promise<void>;
  /** 顺序读回当前 leaf 路径上的全部 message（每次现读 Pi entry-log）。 */
  readTranscript(): Promise<AgentMessage[]>;
  /** 关闭该会话（本层无外部资源；释放缓存句柄）。 */
  close(): Promise<void>;
}

/** 会话发现结果（`list` 用；不从 Pi 私有 metadata 类型透传）。 */
export interface SessionMetadata {
  readonly id: string;
  readonly path: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
}

interface SessionFileHeader {
  readonly id: string;
  readonly cwd: string | undefined;
  readonly timestamp: string | undefined;
}

/** 读 header 时最多扫描的字节数（Pi 的 session header 本身很小）。 */
const HEADER_SCAN_BYTES = 64 * 1024;

/**
 * Pi 1.5.2 的会话 id 只接受 `[A-Za-z0-9._-]`；业务 `sessionId`（如 `wecom:conv-1`）
 * 不能直接落成 Pi id。B1 用可逆 hex 映射把外部 id 编码成 Pi id（`b1` + UTF-8 hex）：
 * 无碰撞、可解码回外部 id（`list` 用），且不同 sessionId 不可能映射到同一 Pi id。
 */
const PI_SESSION_ID_PREFIX = 'b1';
/** 外部 sessionId 上限：hex 编码后仍能放进 Pi 的 `<timestamp>_<id>.jsonl` 文件名。 */
const MAX_EXTERNAL_SESSION_ID_BYTES = 100;

function piSessionId(sessionId: string): string {
  return `${PI_SESSION_ID_PREFIX}${Buffer.from(sessionId, 'utf8').toString('hex')}`;
}

function externalSessionId(piId: string): string | undefined {
  if (!piId.startsWith(PI_SESSION_ID_PREFIX)) return undefined;
  const hex = piId.slice(PI_SESSION_ID_PREFIX.length);
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return undefined;
  return Buffer.from(hex, 'hex').toString('utf8');
}

/** 外部 id 的确定性约束（不合法就显式报错，不改名重试）。 */
function assertExternalSessionId(sessionId: string): void {
  if (sessionId.length === 0) throw new Error('Session id must be non-empty');
  if (sessionId.includes('\u0000')) throw new Error('Session id must not contain NUL');
  if (Buffer.byteLength(sessionId, 'utf8') > MAX_EXTERNAL_SESSION_ID_BYTES) {
    throw new Error(
      `Session id must be at most ${MAX_EXTERNAL_SESSION_ID_BYTES} UTF-8 bytes (got ${Buffer.byteLength(sessionId, 'utf8')})`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `SessionManager.appendMessage` 接受的 message 形状（Pi 的 message entry）。 */
type SessionMessage = Parameters<SessionManager['appendMessage']>[0];

/**
 * Pi 的 appendMessage 拒绝以 message entry 写入压缩/分支摘要（它们必须走专用 entry）。
 * B1 只持久化驱动投影出的普通 message；摘要类消息显式拒绝，不静默改写。
 */
function isAppendableMessage(message: AgentMessage): message is SessionMessage {
  switch (message.role) {
    case 'system':
    case 'user':
    case 'assistant':
    case 'toolResult':
    case 'custom':
    case 'bashExecution':
      return true;
    default:
      return false;
  }
}

/** principal 名称映射为固定长度、无路径注入风险的子树名。 */
function principalSegment(principalId: string): string {
  return createHash('sha256').update(principalId, 'utf8').digest('hex');
}

/** 只读首行解析 session header；文件不可读/首行不是合法 header 时返回 undefined。 */
function readSessionHeader(filePath: string): SessionFileHeader | undefined {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.allocUnsafe(HEADER_SCAN_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const newline = text.indexOf('\n');
    const line = newline === -1 ? text : text.slice(0, newline);
    if (line.trim().length === 0) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!isRecord(parsed) || parsed['type'] !== 'session' || typeof parsed['id'] !== 'string') {
      return undefined;
    }
    return {
      id: parsed['id'],
      cwd: typeof parsed['cwd'] === 'string' ? parsed['cwd'] : undefined,
      timestamp: typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : undefined,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * 打开前校验落盘文件（B1 的确定性责任：Pi 的加载器会静默跳过坏行/坏 header）。
 *
 * 规则：
 *   · 空文件 / 非法 header → 抛错（不静默重建）；
 *   · **换行收尾**的非法 JSON 行 / 非法 entry → 抛错并指明行号（真实损坏）；
 *   · **无换行收尾**的非法尾行 → 崩溃留下的半行，截断丢弃（恢复到最后一个完整提交）。
 */
function validateSessionFile(filePath: string): void {
  const content = readFileSync(filePath, 'utf8');
  if (content.trim().length === 0) {
    throw new Error(`Session file has missing header: ${filePath}`);
  }
  const lines = content.split('\n');
  let offset = 0;
  let headerSeen = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineStart = offset;
    const terminated = index < lines.length - 1;
    const byteLength = Buffer.byteLength(line, 'utf8');
    if (line.trim().length === 0) {
      offset = lineStart + byteLength + (terminated ? 1 : 0);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (!terminated) {
        truncateSync(filePath, lineStart);
        if (!headerSeen) throw new Error(`Session file has missing header: ${filePath}`);
        return;
      }
      throw new Error(`Invalid JSONL storage ${filePath}: line ${index + 1} is not valid JSON`);
    }
    if (!isRecord(parsed)) {
      if (!terminated) {
        truncateSync(filePath, lineStart);
        if (!headerSeen) throw new Error(`Session file has missing header: ${filePath}`);
        return;
      }
      throw new Error(`Invalid JSONL storage ${filePath}: line ${index + 1} is not a session entry`);
    }
    if (!headerSeen) {
      if (parsed['type'] !== 'session' || typeof parsed['id'] !== 'string') {
        throw new Error(`Session file has invalid header: ${filePath}`);
      }
      headerSeen = true;
    } else if (typeof parsed['type'] !== 'string' || typeof parsed['id'] !== 'string') {
      throw new Error(`Invalid JSONL storage ${filePath}: line ${index + 1} is not a session entry`);
    }
    offset = lineStart + byteLength + (terminated ? 1 : 0);
  }
  if (!headerSeen) throw new Error(`Session file has missing header: ${filePath}`);
}

class PersistedSessionImpl implements PersistedSession {
  private closed = false;

  constructor(
    readonly principalId: string,
    readonly sessionId: string,
    readonly filePath: string,
    private readonly manager: SessionManager,
    private readonly onClose: () => void,
  ) {}

  async append(message: AgentMessage): Promise<void> {
    if (this.closed) throw new Error(`Session ${this.sessionId} is closed`);
    if (!isAppendableMessage(message)) {
      throw new Error(
        `Session ${this.sessionId} cannot append a ${message.role} as a message entry; `
          + 'Pi stores it as a dedicated entry, which B1 does not persist.',
      );
    }
    this.manager.appendMessage(message);
  }

  async readTranscript(): Promise<AgentMessage[]> {
    return this.manager
      .getBranch()
      .filter((entry): entry is SessionMessageEntry => entry.type === 'message')
      .map((entry) => entry.message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
}

/**
 * 按 `(principalId, sessionId)` 持久化 Pi 原生对话转录。
 *
 * 隔离模型：每个 principal 拥有 `<rootDir>/principals/<sha256(principalId)>` 这个
 * **独立 Pi session 目录**。不同 principal 的 session 在文件系统上物理分离，跨 principal
 * 不可能读到彼此条目（同名 sessionId 也各归各的子树）。
 *
 * 唯一映射：每个 principal 子树内，同一个 `sessionId` 至多对应一个 `.jsonl` 文件；
 * 出现多个即显式报错（不静默挑一个）。业务 `sessionId` 先经可逆 hex 映射成 Pi 1.5.2
 * 允许的会话 id（`[A-Za-z0-9._-]`），`list()` 再解码回业务 id。
 */
export class SessionPersistence {
  private readonly rootDir: string;
  private readonly cwd: string;
  private readonly sessions = new Map<string, Promise<PersistedSessionImpl>>();
  private closed = false;

  constructor(options: SessionPersistenceOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.cwd = options.cwd;
  }

  /** 打开已存在会话，或在**本 principal 子树**内新建一个。同一对键返回同一句柄。 */
  async openOrCreate(principalId: string, sessionId: string): Promise<PersistedSession> {
    this.assertOpen();
    const key = sessionKey(principalId, sessionId);
    const existing = this.sessions.get(key);
    if (existing !== undefined) return existing;

    // 先登记在途 Promise：并发 openOrCreate 同一对键只落一个会话文件。
    let pending: Promise<PersistedSessionImpl>;
    pending = this.openOrCreateInner(principalId, sessionId, () => {
      if (this.sessions.get(key) === pending) this.sessions.delete(key);
    });
    this.sessions.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.sessions.get(key) === pending) this.sessions.delete(key);
      throw error;
    }
  }

  /** 列出**本 principal 子树**内的会话 metadata（不跨 principal）。 */
  async list(principalId: string): Promise<SessionMetadata[]> {
    this.assertOpen();
    const sessionDir = this.principalDir(principalId);
    let names: string[];
    try {
      names = readdirSync(sessionDir);
    } catch {
      return [];
    }
    const found: SessionMetadata[] = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(sessionDir, name);
      const header = readSessionHeader(filePath);
      // 发现面：损坏/非本层文件不返回；打开该会话时由 validateSessionFile 显式抛错。
      if (header === undefined) continue;
      const id = externalSessionId(header.id);
      if (id === undefined) continue;
      const stats = statSync(filePath);
      const createdAt = header.timestamp === undefined ? Number.NaN : Date.parse(header.timestamp);
      found.push({
        id,
        path: filePath,
        cwd: header.cwd ?? '',
        createdAt: Number.isNaN(createdAt) ? stats.mtimeMs : createdAt,
        modifiedAt: stats.mtimeMs,
      });
    }
    return found;
  }

  /** 删除会话文件（若已打开则先关闭）。 */
  async delete(principalId: string, sessionId: string): Promise<void> {
    this.assertOpen();
    const key = sessionKey(principalId, sessionId);
    const opened = this.sessions.get(key);
    if (opened !== undefined) await (await opened).close();
    for (const filePath of this.sessionFiles(principalId, piSessionId(sessionId))) {
      rmSync(filePath, { force: true });
    }
  }

  /** 关闭全部已打开会话。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const opened = [...this.sessions.values()];
    this.sessions.clear();
    for (const pending of opened) {
      try {
        await (await pending).close();
      } catch {
        // 打开失败的条目没有句柄可关；打开失败已在上报给调用方。
      }
    }
  }

  private async openOrCreateInner(
    principalId: string,
    sessionId: string,
    onClose: () => void,
  ): Promise<PersistedSessionImpl> {
    assertExternalSessionId(sessionId);
    const sessionDir = this.principalDir(principalId);
    mkdirSync(sessionDir, { recursive: true });

    const targetId = piSessionId(sessionId);
    const files = this.sessionFiles(principalId, targetId);
    if (files.length > 1) {
      throw new Error(
        `Conflicting session files for (${principalId}, ${sessionId}): ${files.join(', ')}`,
      );
    }

    const existing = files[0];
    if (existing !== undefined) {
      validateSessionFile(existing);
      const manager = SessionManager.open(existing, sessionDir, this.cwd);
      if (manager.getSessionId() !== targetId) {
        throw new Error(
          `Session file ${existing} declares id ${manager.getSessionId()}, expected ${targetId}`,
        );
      }
      return new PersistedSessionImpl(principalId, sessionId, existing, manager, onClose);
    }

    const manager = SessionManager.create(this.cwd, sessionDir, { id: targetId });
    const filePath = manager.getSessionFile();
    if (filePath === undefined) {
      throw new Error(`SessionManager did not allocate a session file for ${sessionId}`);
    }
    return new PersistedSessionImpl(principalId, sessionId, filePath, manager, onClose);
  }

  /** 在本 principal 子树内定位某 Pi 会话 id 的落盘文件（最多一个；冲突由调用方报错）。 */
  private sessionFiles(principalId: string, targetId: string): string[] {
    const sessionDir = this.principalDir(principalId);
    let names: string[];
    try {
      names = readdirSync(sessionDir);
    } catch {
      return [];
    }
    const suffix = `_${targetId}.jsonl`;
    const files: string[] = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(sessionDir, name);
      const header = readSessionHeader(filePath);
      if (header !== undefined) {
        if (header.id === targetId) files.push(filePath);
        continue;
      }
      // header 不可解析（损坏/空文件）：按 Pi 的文件名约定归属到目标 id，
      // 交给 validateSessionFile 抛错——不静默当成「不存在」再重建。
      if (name.endsWith(suffix)) files.push(filePath);
    }
    return files;
  }

  private principalDir(principalId: string): string {
    return path.join(this.rootDir, 'principals', principalSegment(principalId));
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SessionPersistence is closed');
  }
}

function sessionKey(principalId: string, sessionId: string): string {
  return `${principalId}\u0000${sessionId}`;
}
