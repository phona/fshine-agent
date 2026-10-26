/**
 * 会话级产物库（W2，2026-10-20）。
 *
 * 问题：交付曾经是"回合末把字节流进渠道消息"的一次性副作用——不停留、不复制、不登记。
 * 用户说"把那个表再发一次"时，Main Agent 只能凭对话散文里提到的路径复述，而复述会
 * 损坏（真机实证：委派文本里出现编造的 `/tmp/task_<uuid>` 路径，worker 拿着它 ls
 * 失败后把 tmp/ 下逐个任务工作区翻了一遍，交还文本"委派中给出的原文件路径已不存在……"
 * 原样上了用户的屏）。
 *
 * 本模块给那个指针一个家：
 *   - **ingest**：回合末把本轮收集到的交付物复制进 `data/sessions/<session>/artifacts/`，
 *     分配会话内单调 ref，落 `session_artifacts` 一行。scratch 之后被 GC 也不丢。
 *   - **manifest**：每回合注入给模型的产物清单（ref / 文件名 / 生成时间 / 来源任务 /
 *     状态）——与输入侧交付集（附件池 + 窗口规则）完全对称。清单里有的，重发是宿主
 *     确定动作；没有的，确定回答"本会话没有交付过这个产物"，模型不需要编。
 *   - **rewrite**：把文本里残留的 scratch 来源路径改写成 ref。入库后任何 agent 可见
 *     的引用都不再是路径（D4 引用迁移的 W2 部分；委派文本去路径在 W4）。
 *
 * 库只存"ref ↔ 交付回合 ↔ 产生任务"的映射；溯源细节（读了哪些输入、worker 摘要）
 * 从 platform_tasks.worker_messages 投影，不建平行登记表。
 *
 * 失败纪律：入库失败不挡交付（用户拿不到文件比库里少一行更糟），由调用方留痕；
 * `sessionArtifacts` repo 缺失（旧替身/旧部署）时 ingest 静默退化为 no-op。
 */
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AuditStore, ChannelReply, OutgoingFileReply, PlatformTaskRecord, SessionArtifactRecord, TaskRunRecord } from '@fshine/contracts';
import { isScratchDirName } from '@fshine/agent';

/** collectProducedFiles 收上来的一份候选（字节已在内存里，来源路径可选）。 */
export interface IngestCandidate {
  data: Buffer;
  filename: string;
  sourcePath?: string;
}

export interface IngestOutcome {
  /** 本轮入库的产物（按 ref 升序）。 */
  records: SessionArtifactRecord[];
  /** scratch 来源路径 → 产物：ref 改写与溯源查询用。 */
  bySourcePath: Map<string, SessionArtifactRecord>;
}

/** 会话产物位置：`data/sessions/<encodeURIComponent(sessionId)>/artifacts`。 */
export function artifactSessionDir(dataRoot: string, sessionId: string): string {
  // sessionId 形如 `wecom:<chatid>`，含 `:` 等字符；encodeURIComponent 保证可逆且不撞车
  // （`wecom:a:b` 与 `wecom:a_b` 编码后不同）。
  return path.join(dataRoot, 'sessions', encodeURIComponent(sessionId), 'artifacts');
}

/** 库内文件名：`<ref>__<filename>`。文件名里的路径分隔符一律拍平（防穿越与歧义）。 */
export function artifactStoredName(ref: string, filename: string): string {
  return `${ref}__${filename.replace(/[\\/]/g, '_')}`;
}

/**
 * 下一个 ref：会话内单调整数（max + 1），空会话从 '1' 开始。
 *
 * 单调可读 ref 是清单与"第 N 个产物"这类用户语言之间的桥；内容哈希不做 ref——
 * 同一文件两轮交付应该是两条（生成时间不同），哈希会把它们误并成一条。
 */
export function nextArtifactRef(existing: readonly SessionArtifactRecord[]): string {
  let max = 0;
  for (const record of existing) {
    const n = Number.parseInt(record.ref, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

/**
 * 入库：复制字节 + 分配 ref + 落库。调用方负责 try/catch（失败不挡交付）。
 *
 * ref 在同一批次内也递增：一次 ingest 的多个文件互不抢号。已有产物只读一次
 * （listBySession），批内累加，不逐文件查库。
 */
export async function ingestArtifacts(args: {
  candidates: readonly IngestCandidate[];
  sessionId: string;
  dataRoot: string;
  store: Pick<AuditStore, 'sessionArtifacts' | 'taskRuns'>;
  requestId?: string;
  sourceTaskId?: string;
  sourceRunId?: string;
  /** 注入时钟（测试用）；缺省当前时刻。 */
  now?: string;
}): Promise<IngestOutcome> {
  const repo = args.store.sessionArtifacts;
  const outcome: IngestOutcome = { records: [], bySourcePath: new Map() };
  if (!repo || args.candidates.length === 0) return outcome;

  const existing = await repo.listBySession(args.sessionId);
  let next = Number.parseInt(nextArtifactRef(existing), 10);
  const dir = artifactSessionDir(args.dataRoot, args.sessionId);
  const createdAt = args.now ?? new Date().toISOString();

  for (const candidate of args.candidates) {
    const ref = String(next++);
    const storedName = artifactStoredName(ref, candidate.filename);
    mkdirSync(dir, { recursive: true });
    const storedPath = path.join(dir, storedName);
    writeFileSync(storedPath, candidate.data);
    const record: SessionArtifactRecord = {
      ref,
      sessionId: args.sessionId,
      filename: candidate.filename,
      sha256: createHash('sha256').update(candidate.data).digest('hex'),
      size: candidate.data.length,
      ...(args.sourceTaskId === undefined ? {} : { sourceTaskId: args.sourceTaskId }),
      ...(args.sourceRunId === undefined ? {} : { sourceRunId: args.sourceRunId }),
      ...(args.requestId === undefined ? {} : { requestId: args.requestId }),
      createdAt,
      status: 'available',
      path: storedPath,
    };
    await repo.insert(record);
    outcome.records.push(record);
    if (candidate.sourcePath) outcome.bySourcePath.set(candidate.sourcePath, record);
  }
  // W5 淘汰：入库后把会话压回容量上限内（最旧优先显式淘汰）。放在入库之后、
  // 返回之前——不变量是"ingest 返回时会话在上限内"。
  await evictOverCapArtifacts({
    store: args.store,
    sessionId: args.sessionId,
    ...(args.requestId === undefined ? {} : { requestId: args.requestId }),
    freshRefs: outcome.records.map((record) => record.ref),
  });
  return outcome;
}

/**
 * 单会话产物库的容量上限：数量与总字节双闸，闸的是**可重发**集合。
 *
 * 为什么需要：会话不死（只 compact），库不限量会跟着会话无限长。已淘汰条目留在
 * 库里（行 + 清单展示）——它们承载"交付过但已过期"这个事实，删行会让重发的回答
 * 从"已淘汰"退化成"没有交付过"，那是假陈述。
 */
const MAX_SESSION_ARTIFACTS = 50;
const MAX_SESSION_ARTIFACT_BYTES = 512 * 1024 * 1024;

/**
 * 淘汰（W5）：可重发集合超容量时按最旧优先显式淘汰——status=evicted + 删字节 + 留痕。
 *
 * 显式不是可选项：清单每回合注入模型上下文，被淘汰条目仍在列（标注已淘汰）。
 * "删了必须让 planner/worker 感知到"是设计底线——静默消失，它们下次照旧指代
 * 就要编。本批新入库的永不淘汰：它们刚随回复交付/重发过，淘汰会让用户手里的
 * 回复指向一个已蒸发的文件。
 */
export async function evictOverCapArtifacts(args: {
  store: Pick<AuditStore, 'sessionArtifacts' | 'taskRuns'>;
  sessionId: string;
  requestId?: string;
  /** 本批新入库的 ref：永不进淘汰候选。 */
  freshRefs?: readonly string[];
}): Promise<string[]> {
  const repo = args.store.sessionArtifacts;
  if (!repo) return [];
  const all = await repo.listBySession(args.sessionId);   // 按 created_at 正序（最旧在前）
  const fresh = new Set(args.freshRefs ?? []);
  let pinnedTaskIds = new Set<string>();
  try {
    const listPinnedTaskIds = args.store.taskRuns?.listPinnedTaskIds;
    pinnedTaskIds = new Set(typeof listPinnedTaskIds === 'function' ? await listPinnedTaskIds.call(args.store.taskRuns) : []);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'artifact_pin_lookup_failed',
      sessionId: args.sessionId,
      error: error instanceof Error ? error.message : String(error),
    }));
    // Unknown pin state must not allow eviction of a live or undelivered task's outputs.
    for (const record of all) if (record.sourceTaskId) pinnedTaskIds.add(record.sourceTaskId);
  }
  let availableCount = all.filter((record) => record.status === 'available').length;
  let availableBytes = all.reduce((sum, record) => (record.status === 'available' ? sum + record.size : sum), 0);
  const evicted: string[] = [];
  for (const record of all) {
    if (availableCount <= MAX_SESSION_ARTIFACTS && availableBytes <= MAX_SESSION_ARTIFACT_BYTES) break;
    if (record.status !== 'available' || fresh.has(record.ref) || (record.sourceTaskId && pinnedTaskIds.has(record.sourceTaskId))) continue;
    try {
      rmSync(record.path, { force: true });
    } catch {
      // 字节不在也罢：状态照标——重发的确定回答（"已淘汰，需要重新计算"）不依赖字节在否
    }
    await repo.setStatus(args.sessionId, record.ref, 'evicted');
    evicted.push(record.ref);
    availableCount -= 1;
    availableBytes -= record.size;
    console.info(JSON.stringify({
      event: 'artifact_evicted',
      ...(args.requestId === undefined ? {} : { requestId: args.requestId }),
      sessionId: args.sessionId,
      ref: record.ref,
      filename: record.filename,
    }));
  }
  return evicted;
}

/**
 * 产物清单文本（注入模型输入的宿主事实块）。
 *
 * 措辞停在**登记语义**（D-127）：产物 staged 即入清单，清单本身不知道投递成败——
 * 交付失败或崩溃后条目仍在，标题若写"已交付"，模型就能据此向用户声称"已发过"。
 * 标题只说"已保存"，并说明可经重发获取；条目级投递状态对账是更大的工程，不在本函数。
 *
 * 时间一律显式 UTC+8：库里存 UTC，而 2026-10-20 真机事故正是模型把注入证据里的
 * UTC 时间戳（07:08Z）当成本地时间复述给用户（实际 15:08）。宁可以硬编码偏移
 * （企微部署在中国）也不给模型一个裸 UTC 让它复述。evicted 的条目也列出但标注
 * 已淘汰——"删了必须让 planner/worker 感知到"，静默消失它们就会编。
 *
 * 行首用 `#` 不用 `- `：附件交付集的既有解析/测试助手按 `- ` 行前缀取文件名，
 * 清单不能污染那个通道。
 */
export function artifactManifestText(records: readonly SessionArtifactRecord[]): string {
  if (records.length === 0) return '';
  const lines = records.map((record) => {
    const state = record.status === 'evicted' ? '，已淘汰（重发需答"已过期"，指重算）' : '';
    const task = record.sourceTaskId ? `，来源任务 ${record.sourceTaskId}` : '';
    return `#${record.ref} ${record.filename}（${formatArtifactTime(record.createdAt)}${task}${state}）`;
  });
  return `【本会话已保存的产物】（可随时要求重发）\n${lines.join('\n')}`;
}

/** UTC ISO → `YYYY-MM-DD HH:mm UTC+8`（纯函数；解析失败原样返回）。 */
export function formatArtifactTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const shifted = new Date(t + 8 * 60 * 60 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} `
    + `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())} UTC+8`;
}

/**
 * ref 改写：把文本里的 scratch 来源路径替换为 `会话产物 #N（文件名）`。
 *
 * 只换绝对来源路径（collectProducedFiles 给出的真实路径）。worker 输出里的相对
 * 路径（`tmp/task_x/…`）不在映射里——那类形态由出口的 stripServerPaths 收。
 * 改写是幂等的纯文本操作；映射为空时原样返回。
 */
export function rewriteArtifactRefs(
  text: string,
  bySourcePath: ReadonlyMap<string, SessionArtifactRecord>,
): string {
  if (bySourcePath.size === 0 || text === '') return text;
  let out = text;
  for (const [sourcePath, record] of bySourcePath) {
    if (sourcePath === '') continue;
    out = out.split(sourcePath).join(`会话产物 #${record.ref}（${record.filename}）`);
  }
  return out;
}

// ── 产物收集与回合收口（2026-10-20 W2 自 handler.ts 抽取）──────────────────────
// handler.ts 的行数棘轮（handler-shape.test.ts）逼着"产物机器"外移：收集判据、工作区
// 白名单、回合收口、清单注入原本都堆在 handler 里。搬来之后 handler 只留调用点，
// 产物侧的完整机器（收集 → 入库 → ref 改写 → 回挂 → 清单）都在本模块。

/** 办公文档扩展名：用户能直接消费的终态产物形态。 */
const OFFICE_EXT = new Set(['.xlsx', '.xls', '.csv', '.pdf', '.docx']);
const MAX_OUT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_OUT_FILES = 3;
/** 入站附件的暂存位置名（`tmp/attachments/`）：那是输入，永远不是要回传的产物。 */
const ATTACHMENTS_DIR_NAME = 'attachments';

/** 归一化工作区白名单：只认 `tmp/task_<uuid>` 形态，别的名字（含 `../` 穿越）一律忽略。 */
function normalizeWorkspaceDirs(workspaceDirs: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of workspaceDirs ?? []) {
    const rel = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    const segments = rel.split('/');
    if (segments.length !== 2 || segments[0] !== 'tmp') continue;
    if (!isScratchDirName(segments[1]!)) continue;
    out.add(`tmp/${segments[1]}`);
  }
  return out;
}

/**
 * 收集本轮产生的、用户能直接消费的终态产物。
 *
 * 判据（"可交付结果 = 本轮产生的、用户能直接消费的终态产物"）：
 *   ① 在平台 `tmp/` 之下——受信边界内，不让人借机器人外发别处的文件；
 *   ② `mtime >= since`——本轮委派开始之后才落盘的，才是本轮产物；
 *   ③ 扩展名是办公文档（OFFICE_EXT）；
 *   ④ 不在 `tmp/attachments/`——那是本轮**输入**；
 *   ⑤ `tmp/task_<taskId>/` 任务工作区**按白名单收**：只收 `workspaceDirs` 列明的那几个
 *      （调用方按 principal/会话从 platform_tasks 取，见 listSessionTasks）。工作区是
 *      worker 的**唯一可写位置**（serve-gate 的 write 门），域执行器的输出位置又由 worker
 *      传参决定——2026-10-19 实测：薪酬域把两个 xlsx 写进 `tmp/task_d42fffce-…/`，按旧规则
 *      （工作区一律跳过）整轮回传只有文字，用户在企微里什么都拿不到。不收**未登记的**工作区：
 *      并发会话各有各的任务工作区，认全会话的会把 A 的文件发给 B（数据泄漏，比漏传更严重）；
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
 *
 * @param workspaceDirs 本会话的任务工作区（相对 platformRoot，形如 `tmp/task_<uuid>`）——
 *   只有列在这里的工作区才纳入扫描；未登记的 `tmp/task_*` 一律跳过（防并发会话串味）。
 */
export function collectProducedFiles(
  platformRoot: string,
  since: string,
  workspaceDirs?: readonly string[],
): OutgoingFileReply[] {
  const sinceMs = Date.parse(since);
  const allowedWorkspaces = normalizeWorkspaceDirs(workspaceDirs);
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
        // 顶层就绕开两类非产物位置：附件输入区、以及**未登记的**任务工作区（白名单外的）。
        // 省得白走，也避免把别处工作区的中间产物读进来。真正的判据仍在下面按真实路径复核
        // 一遍——符号链接可能从别处指回这两类位置，只在这一层拦不住。
        if (depth === 0) {
          if (entry.name === ATTACHMENTS_DIR_NAME) continue;
          if (isScratchDirName(entry.name) && !allowedWorkspaces.has(`tmp/${entry.name}`)) continue;
        }
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
      // 任务工作区按白名单放行：解引用后落在别处工作区（含链接指回别人工作区）的一律拒。
      if (isScratchDirName(top) && !allowedWorkspaces.has(`tmp/${top}`)) continue;
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
      out.push({ data: readFileSync(filePath), filename: path.basename(filePath), sourcePath: filePath });
    } catch {
      continue;                                                    // 刚要发就被删了：安静跳过
    }
    if (out.length >= MAX_OUT_FILES) break;
  }
  return out;
}

/**
 * Read only the output manifest captured for one background run.
 *
 * The inline path still uses its request-time mtime boundary. Background tasks can sit in a
 * session queue after the Worker exits, so scanning a session's workspaces at delivery time can
 * attach another task's file (or a previous run's file). The task manager records exact output
 * paths by comparing the run's before/after workspace snapshots; this function treats that
 * host-owned manifest as the allowlist and revalidates every path, size, and digest before read.
 */
export function collectTaskRunOutputFiles(platformRoot: string, run: TaskRunRecord): OutgoingFileReply[] {
  const metadata = run.metadata;
  const workspaceDir = metadata?.['workspaceDir'];
  const rawOutputs = metadata?.['outputFiles'];
  if (typeof workspaceDir !== 'string' || !Array.isArray(rawOutputs)) return [];

  const workspaceRel = workspaceDir.replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = workspaceRel.split('/');
  if (segments.length !== 2 || segments[0] !== 'tmp' || segments[1] !== run.taskId || !isScratchDirName(run.taskId)) return [];

  let tmpRoot: string;
  let workspaceRoot: string;
  try {
    tmpRoot = realpathSync(path.join(platformRoot, 'tmp'));
    workspaceRoot = realpathSync(path.join(platformRoot, ...segments));
  } catch {
    return [];
  }
  const workspaceFromTmp = path.relative(tmpRoot, workspaceRoot);
  if (workspaceFromTmp !== run.taskId || workspaceFromTmp.startsWith('..') || path.isAbsolute(workspaceFromTmp)) return [];

  const out: OutgoingFileReply[] = [];
  for (const raw of rawOutputs) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as { path?: unknown; relativePath?: unknown; size?: unknown; sha256?: unknown };
    if (typeof item.path !== 'string' || typeof item.relativePath !== 'string' || typeof item.size !== 'number' || typeof item.sha256 !== 'string') continue;
    const relativePath = item.relativePath.replace(/\\/g, '/');
    const relativeSegments = relativePath.split('/');
    if (!relativePath || relativeSegments.some((part) => part === '' || part === '.' || part === '..')
      || relativeSegments[0] === '.inputs' || path.isAbsolute(relativePath)) continue;
    const declaredPath = path.resolve(item.path);
    const expectedPath = path.resolve(workspaceRoot, ...relativeSegments);
    if (declaredPath !== expectedPath) continue;

    let real: string;
    try {
      real = realpathSync(declaredPath);
    } catch {
      continue;
    }
    const rel = path.relative(workspaceRoot, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (!OFFICE_EXT.has(path.extname(real).toLowerCase())) continue;

    try {
      const stat = statSync(real);
      if (!stat.isFile() || stat.size > MAX_OUT_FILE_BYTES || stat.size !== item.size) continue;
      const data = readFileSync(real);
      if (createHash('sha256').update(data).digest('hex') !== item.sha256) continue;
      out.push({ data, filename: path.basename(real), sourcePath: real });
    } catch {
      continue;
    }
    if (out.length >= MAX_OUT_FILES) break;
  }
  return out;
}

/** Stable, available artifacts produced by all runs of one logical task. */
export async function loadTaskArtifactFiles(
  store: AuditStore,
  sessionId: string,
  taskId: string,
  sourceRunIds?: ReadonlySet<string>,
): Promise<Array<{ record: SessionArtifactRecord; file: OutgoingFileReply }>> {
  const repo = store.sessionArtifacts;
  if (!repo) return [];
  try {
    const records = (await repo.listBySession(sessionId))
      .filter((record) => record.sourceTaskId === taskId
        && record.status === 'available'
        && (sourceRunIds === undefined || (record.sourceRunId !== undefined && sourceRunIds.has(record.sourceRunId))))
      .sort((a, b) => Number(a.ref) - Number(b.ref));
    const out: Array<{ record: SessionArtifactRecord; file: OutgoingFileReply }> = [];
    for (const record of records) {
      try {
        const data = readFileSync(record.path);
        if (createHash('sha256').update(data).digest('hex') !== record.sha256) continue;
        out.push({ record, file: { data, filename: record.filename, sourcePath: record.path } });
      } catch {
        // A missing/corrupt store file is not delivered as if its bytes were present.
      }
    }
    return out;
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'task_artifacts_list_failed',
      sessionId,
      taskId,
      error: error instanceof Error ? error.message : String(error),
    }));
    return [];
  }
}

/**
 * 本会话在册的平台任务（principal × session）。产物回传的收集范围（各任务的
 * `tmp/task_<uuid>` 工作区）与产物溯源的 sourceTaskId 都从这里取。
 *
 * 为什么按会话取：worker 的 write 门把可写位置钉在本轮工作区（serve-gate 的 scratchDir），
 * 域执行器的输出位置又由 worker 传参决定，交付物因此落在 `tmp/task_<taskId>/` 里——那是
 * 它唯一能写的地方。只认本会话（principal × session）在册的任务：并发会话各有各的任务
 * 工作区，认全会话的等于把 A 的文件回传给 B。任务由委派时落库（context.ts 的 upsert），
 * 回合结束来查时本轮任务必已在册。
 *
 * 失败语义：platformTasks 缺库（旧替身/精简部署）或查询抛错 → 空数组 = 退化为只扫 tmp/
 * 顶层，回传收集失败不能让整个回合失败。
 */
async function listSessionTasks(
  store: AuditStore,
  principalId: string,
  sessionId: string,
): Promise<PlatformTaskRecord[]> {
  const repo = store.platformTasks;
  if (!repo) return [];
  try {
    return await repo.listBySession(principalId, sessionId);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'platform_tasks_list_failed',
      principalId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    }));
    return [];
  }
}

/**
 * 重发解析（W4）：把申报的 ref 列表解析成可附发的文件与确定性文本。
 *
 * 三种失败各有确定回答——没有这个产物 / 已淘汰 / 字节不在——都不委派、不编。
 * 重发的文件**不重新入库**：它们已经在会话产物库里（重入库会产生重复 ref）。
 */
export async function resolveResendRefs(
  store: AuditStore,
  sessionId: string,
  refs: readonly string[],
): Promise<{ files: OutgoingFileReply[]; notes: string[]; failures: string[] }> {
  const files: OutgoingFileReply[] = [];
  const notes: string[] = [];
  const failures: string[] = [];
  const repo = store.sessionArtifacts;
  for (const ref of refs) {
    const record = repo ? await repo.get(sessionId, ref) : null;
    if (!record) {
      failures.push(`本会话没有交付过产物 #${ref}`);
      continue;
    }
    if (record.status === 'evicted') {
      failures.push(`产物 #${ref} 已淘汰，需要重新计算`);
      continue;
    }
    try {
      const data = readFileSync(record.path);
      // 与 loadTaskArtifactFiles 同一把尺：登记的 sha256/size 是契约，损坏的库文件不当作
      // 字节还在的样子发出。缺失（readFileSync 抛错）与损坏分别措辞，不误报。
      const mismatch = createHash('sha256').update(data).digest('hex') !== record.sha256
        ? 'sha256 mismatch'
        : data.length !== record.size
          ? `size mismatch (registered ${record.size}, actual ${data.length})`
          : undefined;
      if (mismatch) {
        console.warn(JSON.stringify({ event: 'artifact_resend_corrupt', sessionId, ref, error: mismatch }));
        failures.push(`产物 #${ref} 的文件已损坏，需要重新计算`);
        continue;
      }
      files.push({ data, filename: record.filename });
      notes.push(`#${ref} ${record.filename}（${formatArtifactTime(record.createdAt)} 生成）`);
    } catch {
      failures.push(`产物 #${ref} 的文件已不在，需要重新计算`);
    }
  }
  return { files, notes, failures };
}

/** 重发回合的回复文本：宿主依库内数据合成（runtime 的 resend 分支只做路由）。 */
export function composeResendText(resolution: { notes: string[]; failures: string[] }): string {
  const parts: string[] = [];
  if (resolution.notes.length > 0) parts.push(`重发：${resolution.notes.join('；')}。`);
  if (resolution.failures.length > 0) parts.push(`${resolution.failures.join('；')}。`);
  return parts.join('\n');
}

/**
 * 「本轮回传：…」收据行的**唯一权威**（D-128）：inline 回合收口（withFileReplies）与
 * 后台交付（background-delivery 的 fileReply）两地同句——同一事实（本回合点名回传了
 * 哪些文件）只允许一个措辞源，与 contracts.formatFileReceipt 立过的纪律同源。带/不带
 * `#ref` 的差异是数据参数（有没有产物登记），不是第二份措辞。
 */
export function fileReturnReceipt(entries: ReadonlyArray<{ filename: string; ref?: string }>): string {
  return `本轮回传：${entries.map((entry) => (entry.ref === undefined ? entry.filename : `#${entry.ref} ${entry.filename}`)).join('、')}`;
}

function withFileReplies(text: string, files: readonly OutgoingFileReply[]): ChannelReply {
  if (files.length === 0) return text;
  // 终稿点名回传的文件（2026-10-20）：企微里每条 file 是独立消息、可能先于终稿到达，
  // 用户看到一个不知道是什么的 xlsx。这一行是宿主补的确定性文字——与收据同族（传输
  // 事实，不过模型的手），所以不走出口校验、也不进模型上下文。挂载式客户端不需要它
  // （文件就贴在答复旁边），所以它住在宿主而不是 contracts 的措辞表里。
  //
  // W3 起契约是 files[]：收集到几个就挂几个、点名几个——单数时代"说 3 个发 1 个"的
  // 假陈述随契约一起消失（2026-10-20 真机形态：终稿列"交付物（2 份）"却只发 1 个，
  // 用户被迫二次索要）。
  const note = fileReturnReceipt(files.map((file) => ({ filename: file.filename })));
  return { text: text === '' ? note : `${text}\n${note}`, files: [...files] };
}

/**
 * 本会话产物清单（注入模型输入的宿主事实块，W2）。与输入侧交付集完全对称：
 * 清单里有的，重发是宿主确定动作；没有的，确定回答"本会话没有交付过这个产物"，
 * 模型不需要凭散文记忆猜，更不会为指代不到的东西编结果。
 *
 * 失败/缺库语义：repo 缺失或查询抛错 → 空串（不注入）。清单是增强不是前提——
 * 没有它模型只是少一份可重发索引，回合照常。
 */
export async function loadArtifactManifest(store: AuditStore, sessionId: string): Promise<string> {
  const repo = store.sessionArtifacts;
  if (!repo) return '';
  try {
    const records = await repo.listBySession(sessionId);
    return artifactManifestText(records);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'artifact_manifest_failed',
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    }));
    return '';
  }
}

export function appendArtifactManifest(text: string, manifest: string): string {
  if (manifest === '') return text;
  return text === '' ? manifest : `${text}\n${manifest}`;
}

/**
 * 回合出口收口（W2）：收集 → 入库 → ref 改写 → 回挂回复，一个函数走完。
 *
 * 为什么收在产物模块而不是 handler：finishWithFiles 的完整逻辑（列任务、定 since 界、
 * 扫产物、复制入库、改写引用、挂文件、两条日志）属于产物机器；handler 只提供回合
 * 上下文。这样 handler 的行数棘轮下，新增产物逻辑落在本模块而不是继续堆主链路。
 *
 * 顺序不可换：先入库后回挂——ingest 的 bySourcePath 是 ref 改写的输入；改写只碰
 * 终稿文本，文件挂载与日志不受影响。
 */
export async function finalizeWithArtifacts(args: {
  text: string;
  store: AuditStore;
  principalId: string;
  sessionId: string;
  requestId: string;
  platformRoot?: string;
  dataRoot?: string;
  /** 本轮委派开始时刻：产物收集的 since 界（mtime 早于它的不算本轮产物）。 */
  delegatedAt: string;
  /** Background mode waits for the persisted task event to collect a run-scoped output manifest. */
  collectProduced?: boolean;
  /** W4 重发路由：申报 resend 时 runtime 交回的产物 ref 列表（零委派回合）。 */
  artifactRefs?: readonly string[];
}): Promise<ChannelReply> {
  const { text, store, principalId, sessionId, requestId, platformRoot, dataRoot, delegatedAt } = args;
  let replyText = text;
  const sessionTasks = args.collectProduced === false ? [] : await listSessionTasks(store, principalId, sessionId);
  const workspaceDirs = sessionTasks.map((task) => `tmp/${task.taskId}`);
  // 本轮交付物的溯源键：会话内最新在册的任务（委派时落库，回合结束必已在册）。
  // 取不到（无委派/缺库）时留空——溯源字段缺失是允许的降级，猜一个任务号不是。
  const sourceTaskId = sessionTasks.length > 0
    ? sessionTasks.reduce((latest, task) => (task.createdAt >= latest.createdAt ? task : latest)).taskId
    : undefined;
  const files = args.collectProduced !== false && platformRoot
    ? collectProducedFiles(platformRoot, delegatedAt, workspaceDirs)
    : [];
  // W2 交付即入库：字节复制进会话产物库并分配 ref，scratch 之后被 GC 也不丢。
  // 入库失败不挡交付（用户拿不到文件比库里少一行更糟），留痕即可；repo 缺失
  // （旧替身/旧部署）时静默退化为纯流式交付，与 W2 之前一致。
  let bySourcePath: ReadonlyMap<string, SessionArtifactRecord> = new Map();
  if (files.length > 0 && dataRoot && store.sessionArtifacts) {
    try {
      const outcome = await ingestArtifacts({
        candidates: files,
        sessionId,
        dataRoot,
        store,
        requestId,
        ...(sourceTaskId === undefined ? {} : { sourceTaskId }),
      });
      bySourcePath = outcome.bySourcePath;
      for (const record of outcome.records) {
        console.info(JSON.stringify({
          event: 'artifact_ingested',
          requestId,
          sessionId,
          ref: record.ref,
          filename: record.filename,
          bytes: record.size,
          sha256: record.sha256,
        }));
      }
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'artifact_ingest_failed',
        requestId,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  // W4 重发：refs 从会话产物库取字节回挂（不重新入库——它们已经在库里）。文本由
  // 宿主依库内数据合成，替换 runtime 的占位句——出处（生成时间）只有库里知道。
  let resentFiles: OutgoingFileReply[] = [];
  if (args.artifactRefs && args.artifactRefs.length > 0) {
    const resolution = await resolveResendRefs(store, sessionId, args.artifactRefs);
    resentFiles = resolution.files;
    const composed = composeResendText(resolution);
    if (composed !== '') replyText = composed;
    for (const file of resolution.files) {
      console.info(JSON.stringify({
        event: 'artifact_resent',
        requestId,
        sessionId,
        filename: file.filename,
        bytes: file.data.length,
      }));
    }
    for (const failure of resolution.failures) {
      console.warn(JSON.stringify({ event: 'artifact_resend_failed', requestId, sessionId, reason: failure }));
    }
  }
  const reply = withFileReplies(rewriteArtifactRefs(replyText, bySourcePath), [...resentFiles, ...files]);
  if (typeof reply !== 'string' && reply.files) {
    for (const file of reply.files) {
      console.info(JSON.stringify({
        event: 'produced_files_collected',
        requestId,
        filename: file.filename,
        bytes: file.data.length,
      }));
    }
  }
  return reply;
}
