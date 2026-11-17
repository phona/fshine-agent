/**
 * 纯附件机械事实（目标 A）：按 (principalId, sessionId) 进程内排队，下一回合由
 * execution-runtime 以既有 `injections`（Pi 原生 custom message、display=false）注入。
 *
 * 硬边界：事实只包含 **文件名 / fileId / 字节数 / 时间**——不含路径、不含行数据、
 * 不含 sha256。`fileId` 只进模型上下文，不进用户话术（渠道回执/追问文案由宿主另渲染）。
 *
 * 生命周期：登记成功即入队；注入（take）即出队；同 fileId 在未注入前重复登记只保留
 * 一行。进程重启不补发（in-process 事实，可接受，已登记）。
 */

/** 一条附件的机械事实输入（全部来自登记返回值 / 渠道消息，不含路径内容）。 */
export interface AttachmentFactInput {
  fileId: string;
  /** 用户可见文件名（适配器已 basename 化；这里再做一次显示净化，防御 handler 直调）。 */
  name: string;
  bytes: number;
  /** ISO 8601（渠道/宿主收到该批附件的时间）。 */
  receivedAt: string;
}

export interface AttachmentFactQueue {
  enqueue(input: { principalId: string; sessionId: string; files: readonly AttachmentFactInput[] }): void;
  /** 取走并出队本 (principal, session) 的全部待注入事实；无 pending 返回 undefined。 */
  take(principalId: string, sessionId: string): string | undefined;
  clear(): void;
}

/** 会话键：与宿主其它按 (principal, session) 收口的状态同一形状（NUL 分隔，不碰撞）。 */
function scopeKeyOf(principalId: string, sessionId: string): string {
  return `${principalId}\u0000${sessionId}`;
}

/** 显示名净化：剥控制字符、路径分隔符与 `..` 序列（只影响显示，不改 file_refs 原值）。 */
export function displayFileName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replaceAll(/(\.\.[/\\]?|[/\\])/g, '_')
    .trim();
}

/** 千分位字节（机械事实显示；与 locale 无关的确定性格式）。 */
function formatBytes(bytes: number): string {
  return String(Math.max(0, Math.trunc(bytes))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `YYYY-MM-DD HH:mm`（本地时区；接受 ISO，非法时间回落到注入时钟）。 */
export function formatAttachmentTime(receivedAt: string, now: () => number = Date.now): string {
  const parsed = Date.parse(receivedAt);
  const date = new Date(Number.isFinite(parsed) ? parsed : now());
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 单条事实文本：`[收到附件] 名册.xlsx · fileId=file_… · 6,861 字节 · 2026-11-17 20:41`。 */
export function renderAttachmentFact(file: AttachmentFactInput, now: () => number = Date.now): string {
  return `[收到附件] ${displayFileName(file.name)} · fileId=${file.fileId} · ${formatBytes(file.bytes)} 字节 · ${formatAttachmentTime(file.receivedAt, now)}`;
}

/**
 * 附件事实队列。同 fileId 在未注入前重复登记只保留一行（“同一 fileId 只注入一次”）；
 * 出队即视为已注入（与 `taskFactProvider` 的 take 语义一致）。
 */
export function createAttachmentFactQueue(options: { now?: () => number } = {}): AttachmentFactQueue {
  const now = options.now ?? Date.now;
  /** scopeKey → (fileId → fact)，Map 保持登记序。 */
  const pending = new Map<string, Map<string, AttachmentFactInput>>();

  return {
    enqueue({ principalId, sessionId, files }) {
      if (files.length === 0) return;
      const key = scopeKeyOf(principalId, sessionId);
      let mine = pending.get(key);
      if (mine === undefined) {
        mine = new Map();
        pending.set(key, mine);
      }
      for (const file of files) {
        if (!mine.has(file.fileId)) mine.set(file.fileId, file);
      }
    },
    take(principalId, sessionId) {
      const key = scopeKeyOf(principalId, sessionId);
      const mine = pending.get(key);
      if (mine === undefined || mine.size === 0) return undefined;
      pending.delete(key);
      return [...mine.values()].map((file) => renderAttachmentFact(file, now)).join('\n');
    },
    clear() {
      pending.clear();
    },
  };
}

/**
 * 按 (principal, session) 排队的系统注记（模型可见 / 用户不可见 / 不触发回合）。
 * 同一会话只保留**最新**一条：新的主动追问选项会取代旧的（用户看到的最后一份才是
 * 他可能回复的编号来源；旧注记留着只会让模型按过期编号理解）。
 */
export interface ScopedNoteQueue {
  enqueue(principalId: string, sessionId: string, text: string): void;
  take(principalId: string, sessionId: string): string | undefined;
  clear(): void;
}

export function createScopedNoteQueue(): ScopedNoteQueue {
  const pending = new Map<string, string>();
  return {
    enqueue(principalId, sessionId, text) {
      if (text.trim() === '') return;
      pending.set(scopeKeyOf(principalId, sessionId), text);
    },
    take(principalId, sessionId) {
      const key = scopeKeyOf(principalId, sessionId);
      const note = pending.get(key);
      if (note === undefined) return undefined;
      pending.delete(key);
      return note;
    },
    clear() {
      pending.clear();
    },
  };
}
