/**
 * SimCase 薄机制 · 技能链路遥测（eval 层观测；**不改生产逻辑、不参与 pass 判定**）。
 *
 * 只做三件事，全部是**只读观测**：
 *   1) 发现：本次 trial 的装配参数 `mainSkillsDir`、catalog 清单（name 列表）、catalog
 *      字节数、排序是否稳定；
 *   2) 读取：从 Pi 原生转录里提取 `read_skill` 工具调用/结果，记录读了哪份、第几轮、
 *      正文字节 / token 估算 / sha256、是否失败；
 *   3) 隔离：把每次读取落到 `mainSkillsDir` 内做机械核对（绝对路径 / 路径穿越 /
 *      符号链接逃逸），越界不是「读取失败」而是**隔离违规**，单独计数并留证。
 *
 * 口径纪律：
 *   · 复用现有 `SimSystemTurn` / trial 证据机制（`./run`），不新建 schema 家族；
 *   · 只观测真实发生的事：没有转录 / 没有装配参数 → `available:false`，不补零伪造；
 *   · 遥测**不得改变** `pass`（`pass` 仍只由 `./oracle` 决定）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSkillRegistry, isInside, renderSkillCatalog, type SkillMetadata, type SkillSummary } from '../../../packages/agent/src/skills';
import { loadMainSkillDelivery } from '../../../packages/agent/src/worker-skills';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import { sha256Hex } from '../convergence-r1/hash';

// ─────────────────────────────────────────────────────────────────────────────
// 发现：catalog 清单 / 字节数 / 排序稳定性
// ─────────────────────────────────────────────────────────────────────────────

export interface SimSkillDiscovery {
  /** true = 本次装配给出了技能目录（空目录也算 true：观测到了「没有技能」）。 */
  readonly available: boolean;
  /** 装配参数原样（绝对路径）；null = 未观测到技能面。证据按它归因，不再有配置键。 */
  readonly mainSkillsDir: string | null;
  /** catalog 的 name 列表（生产顺序 = 按 code unit 排序后）。 */
  readonly names: readonly string[];
  /** 发现读到的原始顺序（排序前；用于复核「排序是否真的发生」）。 */
  readonly discoveryOrder: readonly string[];
  /** 规范排序后的 name 列表。 */
  readonly sortedOrder: readonly string[];
  /** 生产 catalog 顺序是否等于规范排序（true = 已稳定有序）。 */
  readonly sortedStable: boolean;
  /** 独立发现两次的 name 顺序是否一致（true = 发现结果可重复）。 */
  readonly repeatStable: boolean;
  /** `renderSkillCatalog(names+descriptions)` 的 UTF-8 字节数。 */
  readonly catalogBytes: number;
  /** 生产装配实际追加到 Main 系统提示的技能块字节数。 */
  readonly promptBlockBytes: number;
  /** 生产投递是否给出 `read_skill` 登记表（catalog 非空才给）。 */
  readonly readSkillRegistered: boolean;
  /** 发现失败（如重名）时如实记录；undefined = 正常。 */
  readonly error?: string;
}

export interface SimSkillDiscoveryResult {
  readonly discovery: SimSkillDiscovery;
  /** name → 发现时的绝对文件路径（只在 eval 内部做隔离核对，不写证据）。 */
  readonly filesByName: ReadonlyMap<string, string>;
  /** `mainSkillsDir` 的绝对路径（隔离核对用）。 */
  readonly absoluteRoots: readonly string[];
}

export interface SkillDiscoveryInput {
  /** 装配参数（绝对路径）——S0 唯一机制；不接受配置键/模式开关。 */
  readonly mainSkillsDir: string;
}

/** 未观测到技能面时的诚实缺省（available=false，不伪造空 catalog 已成事实）。 */
export function unavailableSkillDiscovery(reason?: string): SimSkillDiscovery {
  return {
    available: false,
    mainSkillsDir: null,
    names: [],
    discoveryOrder: [],
    sortedOrder: [],
    sortedStable: true,
    repeatStable: true,
    catalogBytes: 0,
    promptBlockBytes: 0,
    readSkillRegistered: false,
    ...(reason === undefined ? {} : { error: reason }),
  };
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * 生产排序口径的**有意镜像**（issue #72 锁死「勿动」）：逐字复制
 * `packages/agent/src/worker-skills.ts` 的 `compareSkillNames`（按 code unit，与 locale
 * 无关）。刻意不 import 生产那份——遥测层要独立复核「生产 catalog 顺序是否等于规范排序」，
 * 共用同一个比较器会让这个自检退化成恒真。镜像事实由
 * `packages/agent/dead-code-merge.test.ts` 钉住（逐字相同 + 本注释必须在）。
 */
function compareSkillNames(a: { readonly name: string }, b: { readonly name: string }): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/** 单目录发现（与生产 `createSkillRegistry.discover` 同源；重名由生产注册表 fail-closed）。 */
async function discoverOnce(absoluteDir: string): Promise<{ skills: SkillMetadata[]; rawOrder: readonly string[] }> {
  const registry = createSkillRegistry({ rootDir: absoluteDir });
  const skills = [...await registry.discover()];
  const rawOrder = skills.map((metadata) => metadata.name);
  skills.sort(compareSkillNames);
  return { skills, rawOrder };
}

/**
 * 发现一次 trial 的技能 catalog（只读；不读模型、不触网）。
 *
 * `mainSkillsDir` 指向空目录 → available=true、clean 全零读数（A 臂就是这样：没有技能面）。
 * 发现抛错（重名 / 读目录失败）→ 记 `error`，其余读数留空，**不冒充成功**。
 */
export async function discoverSkillCatalog(input: SkillDiscoveryInput): Promise<SimSkillDiscoveryResult> {
  const absoluteRoots = [path.resolve(input.mainSkillsDir)];
  const base = { mainSkillsDir: input.mainSkillsDir };
  try {
    // 两次独立发现：用于「排序是否稳定」的可重复性读数。
    const first = await discoverOnce(absoluteRoots[0]!);
    const second = await discoverOnce(absoluteRoots[0]!);
    const names = first.skills.map((metadata) => metadata.name);
    const sortedOrder = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const summaries: readonly SkillSummary[] = first.skills.map(({ name, description }) => ({ name, description }));
    const catalogText = renderSkillCatalog(summaries);
    // 生产装配实际追加的块；同样只读，不改变任何装配结果。
    const delivery = await loadMainSkillDelivery(input.mainSkillsDir);
    return {
      discovery: {
        available: true,
        ...base,
        names,
        discoveryOrder: [...first.rawOrder],
        sortedOrder,
        sortedStable: sameOrder(names, sortedOrder),
        repeatStable: sameOrder(names, second.skills.map((metadata) => metadata.name)),
        catalogBytes: Buffer.byteLength(catalogText, 'utf8'),
        promptBlockBytes: Buffer.byteLength(delivery.promptBlock, 'utf8'),
        readSkillRegistered: delivery.registry !== undefined,
      },
      filesByName: new Map(first.skills.map((metadata) => [metadata.name, metadata.path])),
      absoluteRoots,
    };
  } catch (error) {
    return {
      discovery: {
        ...unavailableSkillDiscovery(error instanceof Error ? error.message : String(error)),
        available: true,
        ...base,
      },
      filesByName: new Map(),
      absoluteRoots,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 隔离：读取只允许落在配置的技能目录内
// ─────────────────────────────────────────────────────────────────────────────

export type SimSkillRejectionKind =
  | 'invalid_name'
  | 'absolute_path'
  | 'path_traversal'
  | 'not_found'
  | 'outside_root'
  | 'symlink_escape'
  | 'unverified_path'
  | 'oversize'
  | 'duplicate'
  | 'failed';

export interface SimSkillRejection {
  readonly kind: SimSkillRejectionKind;
  readonly detail: string;
}

/**
 * 名称层面的越界判定（生产 `isSkillName` 只收不含分隔符的裸名）。
 * 绝对路径与路径穿越在**任何**文件系统访问之前就应被拒；这里只分类，不执行读取。
 */
export function classifySkillName(raw: unknown): SimSkillRejection | undefined {
  if (typeof raw !== 'string') return { kind: 'invalid_name', detail: 'name 不是字符串' };
  const name = raw.trim();
  if (name === '') return { kind: 'invalid_name', detail: 'name 为空' };
  if (name.includes('\0')) return { kind: 'invalid_name', detail: 'name 含 NUL 字节' };
  if (path.isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name) || name.startsWith('/') || name.startsWith('\\')) {
    return { kind: 'absolute_path', detail: `绝对路径被拒：${name}` };
  }
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    return { kind: 'path_traversal', detail: `路径分隔/穿越被拒：${name}` };
  }
  return undefined;
}

/** 生产注册表失败话术 → 遥测拒绝类别（不匹配则记 failed）。 */
export function classifySkillFailure(text: string): SimSkillRejectionKind {
  if (text.includes('技能名称无效')) return 'invalid_name';
  if (text.includes('未找到技能')) return 'not_found';
  if (text.includes('路径未通过安全校验')) return 'outside_root';
  if (text.includes('超出上限')) return 'oversize';
  if (text.includes('技能名称重复')) return 'duplicate';
  return 'failed';
}

export interface SkillPathCheck {
  readonly ok: boolean;
  readonly rejection?: SimSkillRejection;
}

/**
 * 读取落盘后的机械核对：skill 文件解析真实路径后必须仍在某个配置技能根内。
 * 符号链接解析到根外 → `symlink_escape`；普通越界 → `outside_root`。
 */
export async function verifySkillFileInRoots(
  file: string | undefined,
  absoluteRoots: readonly string[],
): Promise<SkillPathCheck> {
  if (file === undefined || file === '') {
    return { ok: false, rejection: { kind: 'unverified_path', detail: '发现表里没有该技能的可核验文件路径' } };
  }
  let realFile: string;
  try {
    realFile = await fs.realpath(file);
  } catch {
    return { ok: false, rejection: { kind: 'outside_root', detail: `技能文件不可解析：${file}` } };
  }
  const symlinked = path.resolve(file) !== realFile;
  for (const root of absoluteRoots) {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root);
    } catch {
      continue;
    }
    if (isInside(realRoot, realFile)) return { ok: true };
  }
  return {
    ok: false,
    rejection: symlinked
      ? { kind: 'symlink_escape', detail: '符号链接解析到配置技能目录之外' }
      : { kind: 'outside_root', detail: '技能文件不在配置技能目录内' },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 读取：从 Pi 原生转录提取 read_skill 调用/结果
// ─────────────────────────────────────────────────────────────────────────────

export interface SimSkillRead {
  readonly toolCallId: string;
  /** 用户消息序号（1 起，含 initialMessage）；与 `SimCallRecord.turn` 同口径。 */
  readonly turn: number;
  /** 模型提交的原始 name（保留原文，便于复核越界尝试）。 */
  readonly name: string;
  /** 工具实际是否成功返回正文。 */
  readonly ok: boolean;
  /** 正文字节数（UTF-8；失败时为 0）。 */
  readonly bytes: number;
  /** 正文 token 估算（Pi `estimateTokens` 同口径；只对正文计，不含消息包装）。 */
  readonly tokens: number;
  /** 正文 sha256（失败时为 `''`）。 */
  readonly sha256: string;
  /** 工具失败话术原文（失败时）。 */
  readonly failure?: string;
  /** 拒绝/越界原因（名称越界、未找到、路径不在根内、符号链接逃逸…）。 */
  readonly rejection?: SimSkillRejection;
  /** 成功读取且真实文件解析后仍在配置根内。 */
  readonly verifiedInRoots: boolean;
  /** 实际成功但违反隔离（名称越界 / 路径越界）——安全违规，单独计数。 */
  readonly isolationViolation: boolean;
}

interface ToolCallView {
  readonly id: string;
  readonly name: unknown;
  readonly turn: number;
}

interface ToolResultView {
  readonly toolCallId: string;
  readonly isError: boolean;
  readonly text: string;
}

const SUMMARY_PREFIX = '【此前会话摘要】';

function messageRole(message: unknown): string | undefined {
  if (message === null || typeof message !== 'object') return undefined;
  return (message as { role?: unknown }).role as string | undefined;
}

function contentBlocks(content: unknown): readonly unknown[] {
  return Array.isArray(content) ? content : [];
}

function textOfBlocks(content: unknown): string {
  return contentBlocks(content)
    .map((block) => {
      if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('');
}

function readSkillCalls(messages: readonly unknown[]): ToolCallView[] {
  const calls: ToolCallView[] = [];
  let userTurns = 0;
  for (const message of messages) {
    const role = messageRole(message);
    if (role === 'user') {
      const content = (message as { content?: unknown }).content;
      const text = typeof content === 'string' ? content : textOfBlocks(content);
      if (!text.startsWith(SUMMARY_PREFIX)) userTurns += 1;
      continue;
    }
    if (role !== 'assistant') continue;
    const turn = Math.max(1, userTurns);
    for (const block of contentBlocks((message as { content?: unknown }).content)) {
      if (block === null || typeof block !== 'object') continue;
      const call = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
      if (call.type !== 'toolCall' || call.name !== 'read_skill') continue;
      const args = call.arguments;
      const name = args !== null && typeof args === 'object' ? (args as { name?: unknown }).name : undefined;
      calls.push({ id: typeof call.id === 'string' ? call.id : `anon-${calls.length + 1}`, name, turn });
    }
  }
  return calls;
}

function readSkillResults(messages: readonly unknown[]): ToolResultView[] {
  const results: ToolResultView[] = [];
  for (const message of messages) {
    if (messageRole(message) !== 'toolResult') continue;
    const record = message as { toolName?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown };
    if (record.toolName !== 'read_skill') continue;
    results.push({
      toolCallId: typeof record.toolCallId === 'string' ? record.toolCallId : '',
      isError: record.isError === true,
      text: textOfBlocks(record.content),
    });
  }
  return results;
}

interface ParsedSkillBody {
  readonly name: string;
  readonly content: string;
}

/** 成功结果正文 = `JSON.stringify({name, content})`（见 pi-driver `toAgentTool`）。 */
function parseSkillResult(text: string): ParsedSkillBody | undefined {
  try {
    const parsed = JSON.parse(text) as { name?: unknown; content?: unknown };
    if (typeof parsed.content !== 'string') return undefined;
    return { name: typeof parsed.name === 'string' ? parsed.name : '', content: parsed.content };
  } catch {
    return undefined;
  }
}

export interface SkillTranscriptScanInput {
  readonly messages: readonly unknown[];
  /** name → 发现时的绝对路径（缺省 = 无法核对落盘路径）。 */
  readonly filesByName?: ReadonlyMap<string, string>;
  /** 配置技能根的绝对路径（缺省空 = 无法核对，成功读取记 unverified_path，不冒充已验证）。 */
  readonly absoluteRoots?: readonly string[];
}

function failedRead(input: {
  call: ToolCallView;
  failure: string;
  rejection?: SimSkillRejection;
}): SimSkillRead {
  const name = typeof input.call.name === 'string' ? input.call.name : String(input.call.name ?? '');
  return {
    toolCallId: input.call.id,
    turn: input.call.turn,
    name,
    ok: false,
    bytes: 0,
    tokens: 0,
    sha256: '',
    failure: input.failure,
    ...(input.rejection === undefined ? {} : { rejection: input.rejection }),
    verifiedInRoots: false,
    isolationViolation: false,
  };
}

/**
 * 从转录扫描 `read_skill` 调用/结果，返回逐次读取遥测。
 *
 * 转录是 Pi 原生只读投影：assistant 的 `toolCall` 块 + `toolResult` 消息按 `toolCallId`
 * 配对。调用没有结果 = 失败（失败话术记 `no_result`），不冒充成功。
 */
export async function skillReadsFromTranscript(input: SkillTranscriptScanInput): Promise<SimSkillRead[]> {
  const calls = readSkillCalls(input.messages);
  const results = new Map(readSkillResults(input.messages).map((result) => [result.toolCallId, result]));
  const filesByName = input.filesByName ?? new Map<string, string>();
  const absoluteRoots = input.absoluteRoots ?? [];
  const reads: SimSkillRead[] = [];

  for (const call of calls) {
    const name = typeof call.name === 'string' ? call.name : String(call.name ?? '');
    const nameRejection = classifySkillName(call.name);
    const result = results.get(call.id);
    if (result === undefined) {
      reads.push(failedRead({
        call,
        failure: 'no_result',
        rejection: nameRejection ?? { kind: 'failed', detail: '工具调用没有返回结果' },
      }));
      continue;
    }
    if (result.isError) {
      const rejection = nameRejection ?? { kind: classifySkillFailure(result.text), detail: result.text };
      reads.push(failedRead({ call, failure: result.text, rejection }));
      continue;
    }

    const parsed = parseSkillResult(result.text);
    if (parsed === undefined) {
      reads.push(failedRead({
        call,
        failure: 'unparsable_result',
        rejection: { kind: 'failed', detail: `成功结果不是 {name, content} 形状：${result.text.slice(0, 120)}` },
      }));
      continue;
    }

    const bytes = Buffer.byteLength(parsed.content, 'utf8');
    const tokens = estimateTokens({ role: 'user', content: parsed.content, timestamp: 0 });
    // 成功返回但名称本身越界：生产不该发生；发生了就是隔离违规（记录，不改变 pass）。
    if (nameRejection !== undefined) {
      reads.push({
        toolCallId: call.id,
        turn: call.turn,
        name,
        ok: true,
        bytes,
        tokens,
        sha256: sha256Hex(parsed.content),
        rejection: nameRejection,
        verifiedInRoots: false,
        isolationViolation: true,
      });
      continue;
    }
    const verification = await verifySkillFileInRoots(filesByName.get(parsed.name !== '' ? parsed.name : name), absoluteRoots);
    reads.push({
      toolCallId: call.id,
      turn: call.turn,
      name,
      ok: true,
      bytes,
      tokens,
      sha256: sha256Hex(parsed.content),
      ...(verification.rejection === undefined ? {} : { rejection: verification.rejection }),
      verifiedInRoots: verification.ok,
      // 成功读取但落盘路径在配置根之外 = 隔离违规（不含「路径不可核验」这一诚实边界）。
      isolationViolation: verification.rejection !== undefined && verification.rejection.kind !== 'unverified_path',
    });
  }
  return reads;
}

// ─────────────────────────────────────────────────────────────────────────────
// trial 级汇总（进证据）
// ─────────────────────────────────────────────────────────────────────────────

export interface SimSkillIsolation {
  /** 装配参数 `mainSkillsDir`（null = 未观测到技能面）。 */
  readonly mainSkillsDir: string | null;
  /** 成功读取却越界的次数（必须为 0）。 */
  readonly violations: number;
  readonly violationDetails: readonly SimSkillRejection[];
}

export interface SimSkillTelemetry {
  readonly discovery: SimSkillDiscovery;
  readonly reads: readonly SimSkillRead[];
  /** 本 trial 是否调用过 `read_skill`（有调用即 true，含失败）。 */
  readonly read: boolean;
  readonly successfulReads: number;
  readonly failedReads: number;
  readonly verifiedReads: number;
  readonly isolation: SimSkillIsolation;
}

/** 汇总成 trial 证据字段；`discovery` 缺省 = 未观测（available=false）。 */
export function buildSkillTelemetry(
  discovery: SimSkillDiscovery | undefined,
  reads: readonly SimSkillRead[],
): SimSkillTelemetry {
  const observed = discovery ?? unavailableSkillDiscovery();
  return {
    discovery: observed,
    reads,
    read: reads.length > 0,
    successfulReads: reads.filter((read) => read.ok).length,
    failedReads: reads.filter((read) => !read.ok).length,
    verifiedReads: reads.filter((read) => read.ok && read.verifiedInRoots).length,
    isolation: {
      mainSkillsDir: observed.mainSkillsDir,
      violations: reads.filter((read) => read.isolationViolation).length,
      violationDetails: reads.flatMap((read) => (read.isolationViolation && read.rejection !== undefined ? [read.rejection] : [])),
    },
  };
}

/** 未观测技能面时的空遥测（用于执行抛错的全样本占位，不伪造读取）。 */
export function emptySkillTelemetry(): SimSkillTelemetry {
  return buildSkillTelemetry(undefined, []);
}
