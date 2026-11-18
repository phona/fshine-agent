/**
 * 会话文件定位 —— Pi 原生会话的 `(principalId, sessionId)` 唯一文件解析 + 落盘校验。
 *
 * 架构前提（硬，来自 owner）：
 *   · **Pi Session 是唯一转录所有者**。本层不持有 `AgentMessage[]`、不缓存转录、不搬运
 *     message：对话写入、压缩摘要、重启恢复全部由 Pi 的 `AgentSession` + `SessionManager`
 *     完成（生产接线见 `apps/server/server.ts` 的 `sessionFor`，落在 Pi 驱动的
 *     `sessionDir` / `sessionId` / `resumeSessionFile`）。
 *   · 本层只做 Pi 单用 `SessionManager` 做不到的三件**确定性**事：
 *       ① 把 `principalId` 映射成**独立存储子树**（物理隔离，同名 sessionId 互不串读）；
 *       ② 把 `(principalId, sessionId)` 映射成**唯一**一份会话文件（重复/非法 id 显式报错）；
 *       ③ 打开前**校验落盘文件**（坏 header / 坏 JSON 行显式抛错，崩溃半行尾丢弃）。
 *   · 交付物是一个位置 `MainSessionLocation`：文件存在 → 交给驱动 `resumeSessionFile`
 *     （Pi 原生 resume，历史与压缩摘要都在）；不存在 → 驱动在同一目录以同一 Pi id 新建。
 *     本层不 open/create `SessionManager`，也不 import 任何 message 类型。
 *
 * 为什么不是「第二份转录」：本层没有任何 message 流转。旧设计（被否证的
 * r5-session-persistence-design，2026-11-18 已删）在 Pi 之外维护一份随回合数重写的
 * `messages` 数组；B1 曾经改进为「Pi 单条 entry 追加」，但仍然由宿主逐条搬运 message
 * ——那是第二套驱动式的写入路径。现在写入归 Pi 自己，本层只解析位置。
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  truncateSync,
} from 'node:fs';
import path from 'node:path';

/** 会话持久化层构造参数。 */
export interface SessionPersistenceOptions {
  /** 存储根目录（绝对路径或相对进程 cwd）。每个 principal 在其下获得独立子树。 */
  rootDir: string;
}

/**
 * 一份 `(principalId, sessionId)` 的 Pi 会话位置（装配层据此构造 Pi 驱动）。
 *
 *   · `sessionDir`：本 principal 的独立会话目录（Pi 的 sessionDir）；
 *   · `piSessionId`：新建会话时交给 Pi 的会话 id（文件名与 header 同源，重启按它找回）；
 *   · `resumeSessionFile`：已落盘会话文件的绝对路径（存在才有）；给出即 Pi 原生 resume。
 */
export interface MainSessionLocation {
  readonly sessionDir: string;
  readonly piSessionId: string;
  readonly resumeSessionFile?: string;
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
 * 不能直接落成 Pi id。这里用可逆 hex 映射把外部 id 编码成 Pi id（`b1` + UTF-8 hex）：
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
 * 打开前校验落盘文件（本层的确定性责任：Pi 的加载器会静默跳过坏行/坏 header）。
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

/**
 * 按 `(principalId, sessionId)` 解析 Pi 原生会话的唯一文件位置（并校验既有文件）。
 *
 * 隔离模型：每个 principal 拥有 `<rootDir>/principals/<sha256(principalId)>` 这个
 * **独立 Pi session 目录**。不同 principal 的会话在文件系统上物理分离，跨 principal
 * 不可能读到彼此条目（同名 sessionId 也各归各的子树）。
 *
 * 唯一映射：每个 principal 子树内，同一个 `sessionId` 至多对应一个 `.jsonl` 文件；
 * 出现多个即显式报错（不静默挑一个）。业务 `sessionId` 先经可逆 hex 映射成 Pi 1.5.2
 * 允许的会话 id（`[A-Za-z0-9._-]`），`list()` 再解码回业务 id。
 */
export class SessionPersistence {
  private readonly rootDir: string;

  constructor(options: SessionPersistenceOptions) {
    this.rootDir = path.resolve(options.rootDir);
  }

  /**
   * 解析会话位置：已有落盘文件即返回它（并先校验），否则只给目录 + 目标 Pi id
   * （由 Pi 驱动在同一位置新建，文件名/header 用同一个 id，重启可再解析回来）。
   */
  resolve(principalId: string, sessionId: string): MainSessionLocation {
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
    if (existing === undefined) return { sessionDir, piSessionId: targetId };
    validateSessionFile(existing);
    const header = readSessionHeader(existing);
    if (header?.id !== targetId) {
      throw new Error(
        `Session file ${existing} declares id ${String(header?.id)}, expected ${targetId}`,
      );
    }
    return { sessionDir, piSessionId: targetId, resumeSessionFile: existing };
  }

  /** 列出**本 principal 子树**内的会话 metadata（不跨 principal）。 */
  list(principalId: string): SessionMetadata[] {
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
      // 发现面：损坏/非本层文件不返回；解析该会话时由 validateSessionFile 显式抛错。
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
}
