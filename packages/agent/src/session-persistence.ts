/**
 * 会话文件定位 —— Pi 原生会话的 `(principalId, sessionId)` 唯一文件解析 + 落盘校验。
 *
 * 架构前提（硬，来自 owner）：
 *   · **Pi Session 是唯一转录所有者**。本层不持有 `AgentMessage[]`、不缓存转录、不搬运
 *     message：对话写入、压缩摘要、重启恢复全部由 Pi 的 `AgentSession` + `SessionManager`
 *     完成（生产接线见 `apps/server/server.ts` 的 `sessionFor`，落在 Pi 驱动的
 *     `sessionDir` / `sessionId` / `resumeSessionFile`）。
 *   · 本层只做 Pi 单用 `SessionManager` 做不到的**确定性**事：
 *       ① 把 `principalId` 映射成**独立存储子树**（物理隔离，同名 sessionId 互不串读）；
 *       ② 把 `(principalId, sessionId)` 映射成**唯一**一份会话文件（重复/非法 id 显式报错）；
 *       ③ 打开前**校验落盘文件**（坏 header / 坏 JSON 行显式抛错，崩溃半行尾丢弃）；
 *       ④ 压缩后把 `firstKeptEntryId` 之前的死历史归档出活跃文件（issue #67，
 *          见 `archiveCompactedSessionFile`；不改写 Pi 的写入路径，只做文件级维护）。
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
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

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
 * 会话归档结果（压缩后把**已死**的历史段移出活跃文件）。
 *
 * 触发口径（issue #67 / owner 2026-11-18）：Pi 的压缩只压模型上下文，`SessionManager`
 * 仍以 `appendFileSync` 往同一文件追加；历史段在压缩后不可能再被回放，故把
 * `firstKeptEntryId` **之前**的条目原样移入 `<sessionDir>/archive/<文件名>.<序号>.jsonl.gz`。
 */
export type SessionArchiveOutcome =
  | {
    readonly archived: true;
    readonly archivePath: string;
    readonly archivedEntries: number;
    readonly archivedBytes: number;
    readonly activeBytesBefore: number;
    readonly activeBytesAfter: number;
  }
  | { readonly archived: false; readonly reason: 'no_compaction' | 'nothing_to_archive' };

const LF = 0x0a;

/** 按 `\n` 切原始行（保留行尾换行；最后一行可以没有换行）。切点只在 ASCII 换行上，UTF-8 安全。 */
function splitRawLines(raw: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === LF) {
      lines.push(raw.subarray(start, index + 1));
      start = index + 1;
    }
  }
  if (start < raw.length) lines.push(raw.subarray(start));
  return lines;
}

/** 解析一行 entry（只用于定位切分点；原始字节不因解析而改变）。空行返回 undefined。 */
function parseSessionLine(line: Buffer, filePath: string, lineNumber: number): Record<string, unknown> | undefined {
  const text = line.toString('utf8').trim();
  if (text.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Cannot archive ${filePath}: line ${lineNumber} is not valid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Cannot archive ${filePath}: line ${lineNumber} is not a session entry`);
  }
  return parsed;
}

/**
 * 压缩后归档：把活跃会话文件中 `firstKeptEntryId` 之前的条目逐字节移入 gzip 归档，
 * 并原子重写活跃文件（header + 保留段 + 压缩摘要）。
 *
 * 边界（确定性）：
 *   · 只信 Pi 的 `compaction.firstKeptEntryId`；找不到该 id 显式抛错，**不按行号猜**；
 *   · 归档内容是原文件行（含换行）的逐字节拼接，不重排、不改写；
 *   · 先成功写出归档，再临时文件 + rename 替换活跃文件；任何一步失败都保持原文件不变；
 *   · 活跃文件保留 session header（Pi 的 `_loadEntries` 没有 header 会新建会话并换文件名/ id，
 *     那会直接打断重启恢复）；保留段与压缩条目顺序维持 Pi 的原始追加顺序——压缩条目必须是
 *     叶子（在保留段之后），否则它不在 leaf 路径上，回放拿不到摘要。
 *   · 压缩条目 `parentId` 若指向被归档条目（无保留段的极端情形），置 null：Pi 的路径遍历从
 *     叶子沿 parentId 上溯，遇到缺失父条目即停止，空 parentId 没有副作用；置 null 是为了让
 *     重写后的文件在语义上不引用已不在文件里的条目。
 *
 * 同步实现：调用点（`compaction_end`）与 Pi 的追加处在同一事件循环 tick，同步文件操作
 * 保证改写期间不会插入新的 append。
 */
export function archiveCompactedSessionFile(filePath: string): SessionArchiveOutcome {
  const raw = readFileSync(filePath);
  const lines = splitRawLines(raw);
  if (lines.length === 0) throw new Error(`Cannot archive ${filePath}: file is empty`);
  const parsed = lines.map((line, index) => parseSessionLine(line, filePath, index + 1));
  const header = parsed[0];
  if (header === undefined || header['type'] !== 'session') {
    throw new Error(`Cannot archive ${filePath}: first line is not a session header`);
  }

  // 最靠后的压缩条目决定当前上下文；更早的压缩条目本身也属于可归档的死历史。
  let compactionIndex = -1;
  let compactionEntry: Record<string, unknown> | undefined;
  for (let index = parsed.length - 1; index >= 1; index -= 1) {
    const entry = parsed[index];
    if (entry !== undefined && entry['type'] === 'compaction') {
      compactionIndex = index;
      compactionEntry = entry;
      break;
    }
  }
  if (compactionEntry === undefined) return { archived: false, reason: 'no_compaction' };

  // 切分点 = firstKeptEntryId 那一行。Pi 在 firstKeptEntryId 为空时会写成压缩条目自己的 id，
  // 此时没有保留段，压缩条目之前的全部条目都可归档。
  const firstKeptEntryId = compactionEntry['firstKeptEntryId'];
  let cutIndex = -1;
  if (typeof firstKeptEntryId === 'string' && firstKeptEntryId.length > 0) {
    for (let index = 1; index < compactionIndex; index += 1) {
      if (parsed[index]?.['id'] === firstKeptEntryId) {
        cutIndex = index;
        break;
      }
    }
    if (cutIndex < 0 && firstKeptEntryId === compactionEntry['id']) cutIndex = compactionIndex;
  }
  if (cutIndex < 0) {
    throw new Error(
      `Cannot archive ${filePath}: compaction.firstKeptEntryId ${String(firstKeptEntryId)} is not in the file; refusing to guess`,
    );
  }

  const archivedLines = lines.slice(1, cutIndex);
  if (archivedLines.length === 0) return { archived: false, reason: 'nothing_to_archive' };
  for (const line of archivedLines) {
    // 活跃文件中间的行必须带换行；缺少换行说明文件已损坏，宁可失败也不拼出错位归档。
    if (line[line.length - 1] !== LF) {
      throw new Error(`Cannot archive ${filePath}: archived entry is missing its trailing newline`);
    }
  }
  const archivedBytes = Buffer.concat(archivedLines);

  const sessionDir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const archiveDir = path.join(sessionDir, 'archive');
  mkdirSync(archiveDir, { recursive: true });
  let sequence = 1;
  let archivePath = path.join(archiveDir, `${baseName}.${sequence}.jsonl.gz`);
  while (existsSync(archivePath)) {
    sequence += 1;
    archivePath = path.join(archiveDir, `${baseName}.${sequence}.jsonl.gz`);
  }
  const tmpArchive = path.join(archiveDir, `.${baseName}.${sequence}.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmpArchive, gzipSync(archivedBytes), { flag: 'wx' });
    renameSync(tmpArchive, archivePath);
  } catch (error) {
    try {
      unlinkSync(tmpArchive);
    } catch {
      // 临时文件清理失败不掩盖真实错误。
    }
    throw error;
  }

  const archivedIds = new Set<string>();
  for (let index = 1; index < cutIndex; index += 1) {
    const id = parsed[index]?.['id'];
    if (typeof id === 'string') archivedIds.add(id);
  }
  const keptLines = lines.slice(cutIndex);
  const compactionKeptIndex = compactionIndex - cutIndex;
  if (keptLines[compactionKeptIndex] === undefined) {
    throw new Error(`Cannot archive ${filePath}: compaction entry disappeared from the kept segment`);
  }
  const parentId = compactionEntry['parentId'];
  if (typeof parentId === 'string' && archivedIds.has(parentId)) {
    keptLines[compactionKeptIndex] = Buffer.from(
      `${JSON.stringify({ ...compactionEntry, parentId: null })}\n`,
      'utf8',
    );
  }
  const nextActive = Buffer.concat([lines[0] as Buffer, ...keptLines]);

  const mode = statSync(filePath).mode & 0o777;
  const tmpActive = path.join(sessionDir, `.${baseName}.tmp-${process.pid}-${Date.now()}`);
  let activeFd: number | undefined;
  try {
    activeFd = openSync(tmpActive, 'wx', mode);
    let written = 0;
    while (written < nextActive.length) {
      const step = writeSync(activeFd, nextActive, written, nextActive.length - written);
      if (step === 0) throw new Error(`Cannot archive ${filePath}: short write`);
      written += step;
    }
    fsyncSync(activeFd);
    closeSync(activeFd);
    activeFd = undefined;
    renameSync(tmpActive, filePath);
  } catch (error) {
    if (activeFd !== undefined) {
      try {
        closeSync(activeFd);
      } catch {
        // 已尽力关闭；不影响原文件。
      }
    }
    try {
      unlinkSync(tmpActive);
    } catch {
      // 临时文件清理失败不掩盖真实错误。
    }
    throw error;
  }

  return {
    archived: true,
    archivePath,
    archivedEntries: archivedLines.length,
    archivedBytes: archivedBytes.length,
    activeBytesBefore: raw.length,
    activeBytesAfter: nextActive.length,
  };
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
