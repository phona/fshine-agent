/**
 * CAP-01 R5 资源占用验收（全脚本化；真模型只属 R2，本脚本 0 次 LLM 调用）。
 *
 * 口径（R5 验收指令）：连跑 100 次 run_js（小脚本、每次产 1KB 文件），每 20 次记 du -sb；
 * 只**记录**当前资源行为——**不判红**（R5 全部为记录项，无 FAIL 面）；必须给出
 * 「按当前行为连续用 N 天占多少盘」的推算，并写清缺的是哪一环。
 *
 * 五个记录面：
 *   m1  磁盘增长曲线：每 20 次对部署状态根（dbPath 目录）整体 du -sb，并拆
 *       state.db（+wal/shm）/ workspace/runs / workspace/files / sessions（Pi 转录）。
 *   m2  runs/ 只增不减？每次 checkpoint 数 runs/ 条目数（应单调不减、100 次后 = 100）；
 *       并对单个 run 目录解剖（run.cjs/in/out/scratch/home/tmp 各占多少）。
 *       代码面补注：run 目录与过期 file_refs 字节的清扫只在显式 ops 入口
 *       （`npm run cleanup:runs`）或 server 启动开关 `fileRetentionSweepOnStart` 下发生，
 *       无定时器；执行器分别在 packages/agent/src/run-dir-cleanup.ts 与
 *       packages/agent/src/file-ref-cleanup.ts（TTL 来自
 *       `runtime.fileRefTtlDays`，只删字节、保留行）。本脚本末尾实测一次该 sweeper
 *       （fileRefCleanupProbe），m1/m2 曲线仍按「清扫未开启」的当前产品行为计量。
 *   m3  file_refs 行数与 SQLite 大小：每 20 次只读连接查 COUNT；SQLite 大小 = 主文件 +
 *       -wal + -shm。
 *   m4  同 sha256 重复登记行为：100 次产物字节**全同**（同内容 1KB）→ 统计 Main 交付箱
 *       面（run_js 产物，taskId 未绑定）是否复用 fileId / files/ 是否重复落盘；另用
 *       fileStore 直驱对照任务产物池面（registerTaskFile ×3 / registerTaskFileFromPath ×2 /
 *       registerOutputsFromOut(taskId) ×2 / 无 taskId ×2 / 同内容异名）——S2 的任务池
 *       sha256 去重是否生效、作用域是否只限任务内。
 *   m5  宿主进程 RSS：每次 run_js 后采 process.memoryUsage()，每 20 次采 /proc/self/status
 *       的 VmRSS/VmHWM（峰值至今）；对 checkpoint 序列做线性拟合（斜率/相关系数仅记录）。
 *       run_js 子进程是每次 spawn 后退出的短命进程，不进本曲线；循环结束后按 run.cjs
 *       路径扫 ps 全表验证无残留子进程（记录项）。
 *
 * 推算：per-run 磁盘净增 =（终点 du - 起点 du）/ 成功 run 数；按 100/500/1000 次/天
 * × 30/90/365 天列表；缺环（无任何保留期/清扫机制）随报告写出。
 *
 * 运行（零模型、零网络、零密钥）：
 *   node --import tsx scripts/eval/cap01/r5-resources.ts [--runs 100] [--out-dir <dir>]
 * 缺省 out-dir = .runtime/eval-cap01-r5-resources/<时间戳>（.runtime 不进 git）。
 * 退出码：0 = 计量完成（不论观察结果如何——R5 不判红）；1 = 计量未完成（run_js 调用
 * 出错或夹具异常，此时报告里标 harnessOk=false）。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openTaskStore } from '@fshine/core';
import type { AppConfig, ChannelReply, IncomingChannelMessage } from '@fshine/contracts';
import {
  createFileStore,
  fileStoragePathOf,
  sessionDirOf,
  type FileScope,
  type FileStore,
} from '../../../packages/agent/src/file-store';
import { cleanupExpiredFileRefBytes } from '../../../packages/agent/src/file-ref-cleanup';
import { fileRefTtlMsOf, resolveRuntimeConfig } from '../../../packages/agent/src/resource-policy';
import { createServer, workspaceRootOf } from '../../../apps/server/server';
import type { DriverMessage, TurnDriver } from '../../../packages/agent/src/driver-contract';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');
const execFileAsync = promisify(execFile);

// ── CLI ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
const TOTAL_RUNS = Math.max(1, Number(argValue('--runs') ?? '100'));
const CHECKPOINT_EVERY = 20; // 每 20 次记 du -sb（验收指令口径）
const outDir =
  argValue('--out-dir') ?? path.join(REPO_ROOT, '.runtime', `eval-cap01-r5-resources-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outDir, { recursive: true });

const CHANNEL = 'wecom';
const USER_A = 'user-a';
const SCOPE: FileScope = { principalId: `wecom:${USER_A}`, sessionId: `wecom:conv-r5-resources` };

/** 每次产出的文件内容：1KB、100 次全同——同 sha256 重复登记的探针（m4 的 Main 面）。 */
const OUTPUT_CONTENT = 'R'.repeat(1024);
/** run_js 脚本原文：写 out/result.txt（CommonJS；100 次同一份 code，run.cjs 也全同）。 */
const RUN_CODE = `require('node:fs').writeFileSync('out/result.txt', ${JSON.stringify(OUTPUT_CONTENT)});\n`;

// ── 计量底座 ────────────────────────────────────────────────────────────────

async function duBytes(target: string): Promise<number | null> {
  if (!existsSync(target)) return null;
  try {
    const { stdout } = await execFileAsync('du', ['-sb', target]);
    const parsed = Number(stdout.trim().split('\t')[0]);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface DiskSample {
  runNo: number;
  at: string;
  rootBytes: number | null; // 部署状态根整体（dbPath 目录）
  dbBytes: number | null; // state.db 主文件
  dbWalBytes: number | null; // state.db-wal（有则记）
  dbShmBytes: number | null; // state.db-shm（有则记）
  workspaceBytes: number | null;
  runsBytes: number | null;
  filesBytes: number | null;
  sessionsBytes: number | null;
  runsDirCount: number | null; // runs/ 条目数
  filesDirCount: number | null; // files/ 字节数条目数
  fileRefCount: number | null; // file_refs 行数（只读连接；取不到记 null + 错误）
}

function procStatusFields(): { vmRss: number | null; vmHwm: number | null } {
  // /proc/self/status 的 VmRSS（当前驻留）/ VmHWM（峰值至今），kB → 字节。
  try {
    const text = readFileSync('/proc/self/status', 'utf8');
    const pick = (key: string): number | null => {
      const match = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
      return match === null ? null : Number(match[1]) * 1024;
    };
    return { vmRss: pick('VmRSS'), vmHwm: pick('VmHWM') };
  } catch {
    return { vmRss: null, vmHwm: null };
  }
}

interface MemorySample {
  runNo: number;
  at: string;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  vmRssBytes: number | null;
  vmHwmBytes: number | null;
}

async function diskSample(
  runNo: number,
  paths: { root: string; dbPath: string; sessionDir: string },
  scopeForCount: FileScope,
): Promise<DiskSample> {
  const dbWal = `${paths.dbPath}-wal`;
  const dbShm = `${paths.dbPath}-shm`;
  const runsDir = path.join(paths.sessionDir, 'runs');
  const filesDir = path.join(paths.sessionDir, 'files');
  let fileRefCount: number | null = null;
  let fileRefError: string | undefined;
  try {
    const store = openTaskStore(paths.dbPath, { readOnly: true });
    fileRefCount = store.listFileRefs(scopeForCount).length;
    store.close();
  } catch (error) {
    fileRefError = error instanceof Error ? error.message : String(error);
  }
  const sample: DiskSample = {
    runNo,
    at: new Date().toISOString(),
    rootBytes: await duBytes(paths.root),
    dbBytes: existsSync(paths.dbPath) ? statSync(paths.dbPath).size : null,
    dbWalBytes: existsSync(dbWal) ? statSync(dbWal).size : null,
    dbShmBytes: existsSync(dbShm) ? statSync(dbShm).size : null,
    workspaceBytes: await duBytes(workspaceRootOf(paths.dbPath)),
    runsBytes: await duBytes(runsDir),
    filesBytes: await duBytes(filesDir),
    sessionsBytes: await duBytes(path.join(paths.root, 'sessions')),
    runsDirCount: existsSync(runsDir) ? readdirSync(runsDir).length : null,
    filesDirCount: existsSync(filesDir) ? readdirSync(filesDir).length : null,
    fileRefCount,
  };
  if (fileRefError !== undefined) notes.push(`checkpoint run=${runNo}：file_refs 只读计数失败：${fileRefError}`);
  return sample;
}

/** 一元线性拟合（最小二乘）：返回斜率（字节/次）、截距、相关系数 r。仅记录，不判红。 */
function linearFit(points: ReadonlyArray<{ x: number; y: number }>): { slope: number | null; intercept: number | null; r: number | null } {
  if (points.length < 2) return { slope: null, intercept: null, r: null };
  const n = points.length;
  const sumX = points.reduce((acc, p) => acc + p.x, 0);
  const sumY = points.reduce((acc, p) => acc + p.y, 0);
  const sumXY = points.reduce((acc, p) => acc + p.x * p.y, 0);
  const sumXX = points.reduce((acc, p) => acc + p.x * p.x, 0);
  const sumYY = points.reduce((acc, p) => acc + p.y * p.y, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return { slope: null, intercept: null, r: null };
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  const corrDenomSq = (n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY);
  const r = corrDenomSq === 0 ? null : (n * sumXY - sumX * sumY) / Math.sqrt(corrDenomSq);
  return { slope, intercept, r };
}

const notes: string[] = [];

// ── 夹具（r3-core 同款 server 级生产装配；scripted driver 直驱 run_js） ──────

interface ServerHarness {
  dir: string;
  dbPath: string;
  workspaceRoot: string;
  sessionDir: string;
  server: Awaited<ReturnType<typeof createServer>>;
}

interface RunJsCallRecord {
  runNo: number;
  isError: boolean;
  exitCode?: number;
  fileId?: string;
  fileBytes?: number;
  elapsedMs: number;
  rssBefore: number;
  rssAfter: number;
  heapUsedAfter: number;
}

async function makeServerHarness(): Promise<ServerHarness> {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cap01-r5-resources-`));
  const dbPath = path.join(dir, 'state.db');
  const config: AppConfig = {
    principals: { [`${CHANNEL}:${USER_A}`]: { enabled: true } },
    contextProfiles: {
      dummy: { root: path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform'), gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 0, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
  };
  const server = await createServer({
    env: { LLM_MODEL: 'scripted-r5-resources' },
    config,
    dbPath,
    createDrivers: () => ({ mainDriver: scriptedMainDriver(), workerDriver: workerNeverCalled }),
    createExecutionFace: async () => ({
      client: {
        async capabilities() {
          return { contractVersion: 1, operations: [{ name: 'dummy.query', label: 'query', args: [] }] };
        },
        async execute() {
          return { status: 'completed', data: {} };
        },
      },
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    fileDelivery: {
      deliveryMode: 'live',
      async sendToConversation(route, files) {
        return { route, parts: files.map((_, index) => ({ kind: 'file' as const, index, status: 'sent' as const })) };
      },
    },
    logger: () => {}, // R5 不做日志断言；静默以免 100 回合刷屏
  });
  return {
    dir,
    dbPath,
    workspaceRoot: workspaceRootOf(dbPath),
    sessionDir: sessionDirOf(workspaceRootOf(dbPath), SCOPE),
    server,
  };
}

interface RunRecord {
  turnNo: number;
  runResult: { outputs: Array<{ fileId: string; name: string; bytes: number }>; exitCode: number; stdout: string; stderr: string } | undefined;
  error: string | undefined;
}

function scriptedMainDriver(): TurnDriver {
  let turnNo = 0;
  return {
    async run(input) {
      turnNo += 1;
      const myTurn = turnNo;
      const record: RunRecord = { turnNo: myTurn, runResult: undefined, error: undefined };
      const result = await input.exec('run_js', { code: RUN_CODE });
      record.runResult = result as RunRecord['runResult'];
      records.push(record);
      const outputs = record.runResult?.outputs ?? [];
      return {
        text: `第 ${myTurn} 次 run 完成：产出 ${outputs.length} 个文件。`,
        messages: [...input.messages, { role: 'assistant', content: record.runResult === undefined ? 'error' : 'ok' } as unknown as DriverMessage],
      };
    },
  };
}

const workerNeverCalled: TurnDriver = {
  async run() {
    throw new Error('（r5-resources）Worker 不应被调用：本脚本无委派场景');
  },
};

const records: RunRecord[] = [];

function incomingMessage(messageId: string): IncomingChannelMessage {
  return {
    wecomUserId: USER_A,
    channel: CHANNEL,
    conversationId: 'conv-r5-resources',
    messageId,
    chatType: 'single',
    text: '跑一下小脚本',
    receivedAt: new Date().toISOString(),
  };
}

function textOf(reply: ChannelReply): string {
  return typeof reply === 'string' ? reply : reply.text ?? '';
}

// ── m4 对照探针：fileStore 直驱（server close 后重开同 dbPath） ─────────────

interface DedupProbeResult {
  probe: string;
  detail: string;
  fileIds: string[];
  diskFilesWithProbeSha: number | null;
  rowsForTask: number | null;
}

const PROBE_BYTES = Buffer.from(OUTPUT_CONTENT, 'utf8');
const PROBE_SHA = createHash('sha256').update(PROBE_BYTES).digest('hex');

function diskCountOfSha(workspaceRoot: string, scope: FileScope, sha: string): number | null {
  const filesDir = path.join(sessionDirOf(workspaceRoot, scope), 'files');
  if (!existsSync(filesDir)) return null;
  let count = 0;
  for (const entry of readdirSync(filesDir)) {
    const abs = path.join(filesDir, entry);
    if (!statSync(abs).isFile()) continue;
    try {
      if (createHash('sha256').update(readFileSync(abs)).digest('hex') === sha) count += 1;
    } catch {
      // 读不掉的条目跳过（不影响计数口径的整体形状）
    }
  }
  return count;
}

function rowsOfTask(store: ReturnType<typeof openTaskStore>, scope: FileScope, taskId: string): number {
  return store.listFileRefs(scope).filter((row) => row.taskId === taskId).length;
}

function runDedupProbes(dbPath: string, workspaceRoot: string): DedupProbeResult[] {
  const results: DedupProbeResult[] = [];
  const store = openTaskStore(dbPath);
  const fileStore: FileStore = createFileStore({ store, workspaceRoot });
  const taskId = 'task_r5_probe';

  // d-task-inline：registerTaskFile ×3 同 (scope, taskId, sha256) —— 任务池内联面。
  const inlineFileIds: string[] = [];
  for (let i = 1; i <= 3; i += 1) {
    const registered = fileStore.registerTaskFile({ scope: SCOPE, taskId, name: 'probe.txt', bytes: PROBE_BYTES, maxFileBytes: 32 * 1024 * 1024 });
    inlineFileIds.push(registered.fileId);
  }
  results.push({
    probe: 'd-task-inline(registerTaskFile×3 同任务同字节)',
    detail: `fileId 复用=${new Set(inlineFileIds).size === 1}（distinct=${new Set(inlineFileIds).size}）；task 行数=${rowsOfTask(store, SCOPE, taskId)}；files/ 同 sha 落盘数=${diskCountOfSha(workspaceRoot, SCOPE, PROBE_SHA)}`,
    fileIds: inlineFileIds,
    diskFilesWithProbeSha: diskCountOfSha(workspaceRoot, SCOPE, PROBE_SHA),
    rowsForTask: rowsOfTask(store, SCOPE, taskId),
  });

  // d-task-name：同任务同字节、只换 name —— 去重是否仍命中、name 取哪边。
  const renamed = fileStore.registerTaskFile({ scope: SCOPE, taskId, name: 'renamed.txt', bytes: PROBE_BYTES, maxFileBytes: 32 * 1024 * 1024 });
  results.push({
    probe: 'd-task-name(同任务同字节异名)',
    detail: `复用旧 fileId=${renamed.fileId === inlineFileIds[0]}；返回 name=${renamed.name}（旧行 name vs 新名）`,
    fileIds: [renamed.fileId],
    diskFilesWithProbeSha: diskCountOfSha(workspaceRoot, SCOPE, PROBE_SHA),
    rowsForTask: rowsOfTask(store, SCOPE, taskId),
  });

  // d-task-path：registerTaskFileFromPath ×2 同内容（allowedRoot 内两个临时源文件）。
  const probeRoot = mkdtempSync(path.join(os.tmpdir(), 'cap01-r5-probe-src-'));
  const srcA = path.join(probeRoot, 'a.txt');
  const srcB = path.join(probeRoot, 'b.txt');
  writeFileSync(srcA, PROBE_BYTES);
  writeFileSync(srcB, PROBE_BYTES);
  const pathFileIds: string[] = [];
  for (const sourcePath of [srcA, srcB]) {
    const registered = fileStore.registerTaskFileFromPath({ scope: SCOPE, taskId, sourcePath, allowedRoot: probeRoot, name: 'probe.txt', maxFileBytes: 32 * 1024 * 1024 });
    pathFileIds.push(registered.fileId);
  }
  results.push({
    probe: 'd-task-path(registerTaskFileFromPath×2 同任务同字节)',
    detail: `fileId 复用=${new Set(pathFileIds).size === 1}（distinct=${new Set(pathFileIds).size}）；task 行数=${rowsOfTask(store, SCOPE, taskId)}`,
    fileIds: pathFileIds,
    diskFilesWithProbeSha: diskCountOfSha(workspaceRoot, SCOPE, PROBE_SHA),
    rowsForTask: rowsOfTask(store, SCOPE, taskId),
  });

  // d-task-out：registerOutputsFromOut(taskId) ×2 同一 out 目录 —— 任务 out/ 兜底扫描去重。
  const fakeRunDir = mkdtempSync(path.join(os.tmpdir(), 'cap01-r5-probe-out-'));
  const fakeOut = path.join(fakeRunDir, 'out');
  mkdirSync(fakeOut, { recursive: true });
  writeFileSync(path.join(fakeOut, 'result.txt'), PROBE_BYTES);
  const outFileIds: string[] = [];
  for (let i = 1; i <= 2; i += 1) {
    const { outputs } = fileStore.registerOutputsFromOut({ runDir: fakeRunDir, scope: SCOPE, limits: { maxFileBytes: 32 * 1024 * 1024, maxCount: 32 }, taskId });
    outFileIds.push(...outputs.map((file) => file.fileId));
  }
  results.push({
    probe: 'd-task-out(registerOutputsFromOut taskId×2)',
    detail: `fileId 复用=${new Set(outFileIds).size === 1}（distinct=${new Set(outFileIds).size}）；task 行数=${rowsOfTask(store, SCOPE, taskId)}`,
    fileIds: outFileIds,
    diskFilesWithProbeSha: diskCountOfSha(workspaceRoot, SCOPE, PROBE_SHA),
    rowsForTask: rowsOfTask(store, SCOPE, taskId),
  });

  // d-main-out：无 taskId（Main 交付箱）×2 —— S1 语义：每次登记新 file_id。
  const mainOutIds: string[] = [];
  for (let i = 1; i <= 2; i += 1) {
    const { outputs } = fileStore.registerOutputsFromOut({ runDir: fakeRunDir, scope: SCOPE, limits: { maxFileBytes: 32 * 1024 * 1024, maxCount: 32 } });
    mainOutIds.push(...outputs.map((file) => file.fileId));
  }
  results.push({
    probe: 'd-main-out(registerOutputsFromOut 无 taskId×2)',
    detail: `fileId 复用=${new Set(mainOutIds).size === 1}（distinct=${new Set(mainOutIds).size}）`,
    fileIds: mainOutIds,
    diskFilesWithProbeSha: diskCountOfSha(workspaceRoot, SCOPE, PROBE_SHA),
    rowsForTask: null,
  });

  rmSync(probeRoot, { recursive: true, force: true });
  rmSync(fakeRunDir, { recursive: true, force: true });
  store.close();
  return results;
}

interface FileRefCleanupProbe {
  ttlDays: number;
  ttlMs: number;
  rowsBefore: number;
  keptAtNow: number;
  deletedAtNow: number;
  wouldDeleteAtExpiry: number;
  deletedAtExpiry: number;
  failedAtExpiry: number;
  rowsAfter: number;
  bytesRemainingForDeleted: number;
  ok: boolean;
  detail: string;
}

/**
 * 过期 file_refs 字节回收实测（不是代码阅读注记）：
 *   ① 现在时点跑一次：新鲜行不应被删；
 *   ② 把时钟推到 TTL 之后 dryRun：统计应删数；
 *   ③ 同一过期时点实跑：删除数与 dryRun 一致、行数不变、被删行字节不再存在。
 * 任一不成立 → ok=false；调用方把它计入 harnessOk，避免「sweeper 存在且只删字节」退化成
 * 永远通过的文字。
 */
function runFileRefCleanupProbe(dbPath: string, workspaceRoot: string): FileRefCleanupProbe {
  const store = openTaskStore(dbPath, { readOnly: true });
  try {
    const config = resolveRuntimeConfig({});
    const ttlMs = fileRefTtlMsOf(config);
    const rowsBefore = store.listAllFileRefs().length;
    const now = Date.now();
    const atNow = cleanupExpiredFileRefBytes({ store, workspaceRoot, config, nowMs: now });
    const future = now + ttlMs + 60_000;
    const dry = cleanupExpiredFileRefBytes({ store, workspaceRoot, config, nowMs: future, dryRun: true });
    const actual = cleanupExpiredFileRefBytes({ store, workspaceRoot, config, nowMs: future });
    const allRows = store.listAllFileRefs();
    const rowsById = new Map(allRows.map((row) => [row.fileId, row]));
    const deletedRows = actual.events
      .filter((event) => event.action === 'deleted_bytes')
      .flatMap((event) => {
        const row = rowsById.get(event.fileId);
        return row === undefined ? [] : [row];
      });
    const bytesRemaining = deletedRows.filter((row) =>
      existsSync(fileStoragePathOf(
        workspaceRoot,
        { principalId: row.principalId, sessionId: row.sessionId },
        row.fileId,
        row.name,
      )),
    ).length;
    // 真空保护：若回收/过期判定整体退化成 no-op，wouldDelete 与 deleted 会同时为 0 而
    // 「一致」——必须要求「确实有过期行该删」，否则这一项等于没测。
    const ok = atNow.summary.deleted === 0
      && dry.summary.wouldDelete > 0
      && dry.summary.wouldDelete === actual.summary.deleted
      && actual.summary.failed === 0
      && allRows.length === rowsBefore
      && bytesRemaining === 0;
    return {
      ttlDays: config.fileRefTtlDays,
      ttlMs,
      rowsBefore,
      keptAtNow: atNow.summary.kept,
      deletedAtNow: atNow.summary.deleted,
      wouldDeleteAtExpiry: dry.summary.wouldDelete,
      deletedAtExpiry: actual.summary.deleted,
      failedAtExpiry: actual.summary.failed,
      rowsAfter: allRows.length,
      bytesRemainingForDeleted: bytesRemaining,
      ok,
      detail: `TTL 来自 runtime.fileRefTtlDays=${config.fileRefTtlDays}（${ttlMs}ms）：现在时点 deleted=${atNow.summary.deleted}、kept=${atNow.summary.kept}；`
        + `时钟推过 TTL 后 dryRun wouldDelete=${dry.summary.wouldDelete}，实跑 deleted=${actual.summary.deleted}（failed=${actual.summary.failed}）；`
        + `file_refs 行数 ${rowsBefore}→${allRows.length}；deleted 行残留字节=${bytesRemaining}`,
    };
  } finally {
    store.close();
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`r5-resources 开始：${startedAt}（out-dir=${outDir}；runs=${TOTAL_RUNS}；每 ${CHECKPOINT_EVERY} 次计量）`);
  console.log(`node=${process.version}；repo=${REPO_ROOT}`);

  const harness = await makeServerHarness();
  const { dbPath, workspaceRoot, sessionDir } = harness;
  const paths = { root: path.dirname(dbPath), dbPath, sessionDir };
  const disk: DiskSample[] = [];
  const memory: MemorySample[] = [];

  try {
    // 起点基线（run=0）。
    disk.push(await diskSample(0, paths, SCOPE));
    const mem0 = process.memoryUsage();
    const proc0 = procStatusFields();
    memory.push({ runNo: 0, at: new Date().toISOString(), rssBytes: mem0.rss, heapUsedBytes: mem0.heapUsed, externalBytes: mem0.external, arrayBuffersBytes: mem0.arrayBuffers, vmRssBytes: proc0.vmRss, vmHwmBytes: proc0.vmHwm });

    const perRun: Array<RunJsCallRecord> = [];
    let harnessOk = true;
    let failedRuns = 0;

    for (let i = 1; i <= TOTAL_RUNS; i += 1) {
      const rssBefore = process.memoryUsage().rss;
      const started = Date.now();
      let replyText = '';
      let callError: string | undefined;
      const recordCountBefore = records.length;
      try {
        const reply = await harness.server.handler(incomingMessage(`r5-${startedAt}-${i}`));
        replyText = textOf(reply);
      } catch (error) {
        callError = error instanceof Error ? error.message : String(error);
      }
      const elapsedMs = Date.now() - started;
      const rssAfter = process.memoryUsage().rss;
      const heapUsedAfter = process.memoryUsage().heapUsed;

      // 只认本回合新产出的 driver 记录（handler 在 driver 之前失败时不能拿上一回合顶数）。
      const record = records.length > recordCountBefore && records[records.length - 1]!.turnNo === i ? records[records.length - 1] : undefined;
      const output = record?.runResult?.outputs?.[0];
      const runEntry: RunJsCallRecord = {
        runNo: i,
        isError: callError !== undefined || record === undefined,
        exitCode: record?.runResult?.exitCode,
        fileId: output?.fileId,
        fileBytes: output?.bytes,
        elapsedMs,
        rssBefore,
        rssAfter,
        heapUsedAfter,
      };
      perRun.push(runEntry);
      if (runEntry.isError) {
        failedRuns += 1;
        harnessOk = false;
        notes.push(`run ${i} 调用异常：${callError ?? 'driver 未产出 run_js 结果'}（样本保留，继续计量）`);
      }

      if (i % 10 === 0 || i === 1) {
        console.log(`run ${String(i).padStart(3)}: exit=${record?.runResult?.exitCode} fileId=${output?.fileId ?? '—'} ${elapsedMs}ms rss=${(rssAfter / 1024 / 1024).toFixed(1)}MiB`);
      }
      if (i % CHECKPOINT_EVERY === 0 || i === TOTAL_RUNS) {
        const memNow = process.memoryUsage();
        const procNow = procStatusFields();
        disk.push(await diskSample(i, paths, SCOPE));
        memory.push({ runNo: i, at: new Date().toISOString(), rssBytes: memNow.rss, heapUsedBytes: memNow.heapUsed, externalBytes: memNow.external, arrayBuffersBytes: memNow.arrayBuffers, vmRssBytes: procNow.vmRss, vmHwmBytes: procNow.vmHwm });
        const s = disk[disk.length - 1]!;
        console.log(
          `  □ checkpoint run=${i}: root=${s.rootBytes} db=${s.dbBytes}(+wal ${s.dbWalBytes}) runs=${s.runsBytes}(${s.runsDirCount}) files=${s.filesBytes}(${s.filesDirCount}) sessions=${s.sessionsBytes} file_refs=${s.fileRefCount} vmRSS=${procNow.vmRss} vmHWM=${procNow.vmHwm}`,
        );
      }
      void replyText;
    }

    // m4 的 Main 面统计：100 次同字节产物的 fileId 复用与落盘。
    const mainFileIds = perRun.map((entry) => entry.fileId).filter((id): id is string => typeof id === 'string');
    const distinctMainFileIds = new Set(mainFileIds);
    const filesDir = path.join(sessionDir, 'files');
    const filesDirEntries = existsSync(filesDir) ? readdirSync(filesDir) : [];
    const mainProbe = {
      runs: TOTAL_RUNS,
      runJsFileIds: mainFileIds.length,
      distinctFileIds: distinctMainFileIds.size,
      reusedFileIds: mainFileIds.length - distinctMainFileIds.size,
      filesDirEntries: filesDirEntries.length,
      filesDirProbeShaCopies: diskCountOfSha(workspaceRoot, SCOPE, PROBE_SHA),
      note: 'Main 交付箱（run_js 产物未绑 taskId）的登记去重行为——对照代码注释 file-store.ts:790-793「S1 语义不变：每次登记新 file_id」。',
    };

    // m5 收尾：残留子进程扫描（run.cjs 路径 → workspaceRoot 下的受限子进程）。
    let leftoverChildren: string[] = [];
    try {
      const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,args=']);
      leftoverChildren = stdout.split('\n').filter((line) => line.includes(workspaceRoot) && line.includes('run.cjs') && !line.includes('grep'));
    } catch (error) {
      notes.push(`ps 扫描失败：${error instanceof Error ? error.message : String(error)}`);
    }

    // m2 解剖：取第一个 run 目录，量每个条目（说明单次 run 的落盘构成）。
    const runsDir = path.join(sessionDir, 'runs');
    let runAnatomy: Record<string, number> | null = null;
    if (existsSync(runsDir)) {
      const firstRun = readdirSync(runsDir).sort()[0];
      if (firstRun !== undefined) {
        const anatomy: Record<string, number> = {};
        for (const entry of readdirSync(path.join(runsDir, firstRun))) {
          anatomy[entry] = (await duBytes(path.join(runsDir, firstRun, entry))) ?? 0;
        }
        runAnatomy = anatomy;
      }
    }

    // m4 对照探针：任务产物池（server close 后重开同 dbPath）。
    await harness.server.close();
    // 收口样本：close 会把 WAL checkpoint 回主库——「SQLite 大小」的持久形态以收口后为准
    // （独立字段，不进运行中曲线；此时 dedup 探针尚未写行，file_refs 仍是 100）。
    const postCloseSample = await diskSample(-1, paths, SCOPE);
    const dedupProbes = runDedupProbes(dbPath, workspaceRoot);

    // RSS / 磁盘曲线拟合（仅记录）。
    const rssFit = linearFit(memory.filter((s) => s.vmRssBytes !== null).map((s) => ({ x: s.runNo, y: s.vmRssBytes as number })));
    const hwmFit = linearFit(memory.filter((s) => s.vmHwmBytes !== null).map((s) => ({ x: s.runNo, y: s.vmHwmBytes as number })));
    const rootFit = linearFit(disk.filter((s) => s.rootBytes !== null).map((s) => ({ x: s.runNo, y: s.rootBytes as number })));

    // 收口基线：同形状 harness 建好即关（0 次 run）——得到「纯 schema 的收口形态」。
    // 运行起点（run=0）的 root 含未收口的 schema WAL，直接相减会把 schema 一次性字节摊进
    // per-run；用这个零次基线相减才是纯 per-run 持久增量。
    const schemaBaselineHarness = await makeServerHarness();
    await schemaBaselineHarness.server.close();
    const schemaRootBytes = await duBytes(path.dirname(schemaBaselineHarness.dbPath));
    const schemaDbBytes = existsSync(schemaBaselineHarness.dbPath) ? statSync(schemaBaselineHarness.dbPath).size : null;
    rmSync(schemaBaselineHarness.dir, { recursive: true, force: true });

    // 推算：per-run 净增。两个口径都要：in-flight（WAL 未收口的运行中形态，起点 → 终点）
    // 与收口后（close 把 WAL checkpoint 回主库后的持久形态）——「N 天占多少盘」以收口后为准。
    const baseline = disk[0]!;
    const final = disk[disk.length - 1]!;
    const runsDone = mainFileIds.length;
    const perRunBytes = baseline.rootBytes !== null && final.rootBytes !== null && runsDone > 0 ? Math.round((final.rootBytes - baseline.rootBytes) / runsDone) : null;
    const perRunBytesClosed =
      postCloseSample.rootBytes !== null && schemaRootBytes !== null && runsDone > 0
        ? Math.round((postCloseSample.rootBytes - schemaRootBytes) / runsDone)
        : null;
    // 起点不存在的目录（runs//files/ 首跑才建）按 0 计——「缺失」在增长数学里就是 0。
    const perRunRunsBytes = baseline.runsBytes === null && final.runsBytes === null || runsDone === 0 ? null : Math.round(((final.runsBytes ?? 0) - (baseline.runsBytes ?? 0)) / runsDone);
    const perRunFilesBytes = baseline.filesBytes === null && final.filesBytes === null || runsDone === 0 ? null : Math.round(((final.filesBytes ?? 0) - (baseline.filesBytes ?? 0)) / runsDone);
    const perRunDbBytesClosed = postCloseSample.dbBytes !== null && schemaDbBytes !== null && runsDone > 0 ? Math.round((postCloseSample.dbBytes - schemaDbBytes) / runsDone) : null;
    const perRunSessionsBytes = runsDone > 0 ? Math.round(((final.sessionsBytes ?? 0) - (baseline.sessionsBytes ?? 0)) / runsDone) : null;
    const extrapolation = {
      assumption: '按 R5 实测 per-run 净增字节外推；业务频率是假设，不是实测——结论只对「当前行为」负责。收口后 = close 把 WAL checkpoint 回主库后的持久形态（「N 天占多少盘」用这个）。另注意：sessions（Pi 转录）分量按 scripted driver 的最小回合计（~323B/回合）；真实模型回合的转录字节数远大于此，真实部署的总 per-run 应大于本表。',
      perRunBytesInFlight: perRunBytes,
      perRunBytesClosed,
      perRunBreakdownClosed: { runs: perRunRunsBytes, files: perRunFilesBytes, db: perRunDbBytesClosed, sessions: perRunSessionsBytes },
      table: [100, 500, 1000].flatMap((runsPerDay) =>
        [30, 90, 365].map((days) => ({
          runsPerDay,
          days,
          totalRuns: runsPerDay * days,
          bytesInFlight: perRunBytes === null ? null : perRunBytes * runsPerDay * days,
          bytesClosed: perRunBytesClosed === null ? null : perRunBytesClosed * runsPerDay * days,
        })),
      ),
      runsUntil1GB: perRunBytesClosed === null || perRunBytesClosed === 0 ? null : Math.floor(1_000_000_000 / perRunBytesClosed),
    };

    // 过期 file_refs 字节回收实测（sweeper 是否真的存在、是否只删字节留行）。
    const fileRefCleanupProbe = runFileRefCleanupProbe(dbPath, workspaceRoot);
    if (!fileRefCleanupProbe.ok) {
      harnessOk = false;
      notes.push(`file_refs 字节回收实测与断言不一致：${fileRefCleanupProbe.detail}`);
    }

    // 缺环（代码阅读注记 + 实测对照；不判红，只写清「缺的是哪一环」）。
    const missingLink = [
      'runs/ 与 files/ 的回收只在显式 ops 入口（npm run cleanup:runs）或 server 启动时的一次性清扫下发生，无定时器：run 目录见 packages/agent/src/run-dir-cleanup.ts，过期 file_refs 字节见 packages/agent/src/file-ref-cleanup.ts。',
      `文件引用可读期 TTL 来自 runtime.fileRefTtlDays（实测 ttlDays=${fileRefCleanupProbe.ttlDays}，${fileRefCleanupProbe.ttlMs}ms）：过期后行不可解析；把时钟推过 TTL 后 sweeper 实跑 deleted=${fileRefCleanupProbe.deletedAtExpiry}（dryRun wouldDelete=${fileRefCleanupProbe.wouldDeleteAtExpiry}，failed=${fileRefCleanupProbe.failedAtExpiry}），file_refs 行数 ${fileRefCleanupProbe.rowsBefore}→${fileRefCleanupProbe.rowsAfter}，deleted 行残留字节=${fileRefCleanupProbe.bytesRemainingForDeleted}。`,
      'server-paths.ts:15 提到的 sweepScratchDirs 只在注释/历史文档里，现产品面无实现。',
      'SessionPersistence 只解析 Pi 会话文件位置 + 校验（session-persistence.ts），没有 delete/清理入口；Pi 转录文件不删 workspace 的 runs//files/。',
      'sessionTtlMs 过期后 workspace 会话目录是否被回收：未见任何调用面（本脚本未实测长周期过期，标 UNDEFINED）。',
    ];

    const evidence = {
      startedAt,
      finishedAt: new Date().toISOString(),
      nodeVersion: process.version,
      repoRoot: REPO_ROOT,
      totalRuns: TOTAL_RUNS,
      checkpointEvery: CHECKPOINT_EVERY,
      harnessOk,
      failedRuns,
      scope: SCOPE,
      outputContentSha256: PROBE_SHA,
      perRun,
      diskCurve: disk,
      memoryCurve: memory,
      fits: { rootBytesPerRun: rootFit, vmRssPerRun: rssFit, vmHwmPerRun: hwmFit },
      mainDedupProbe: mainProbe,
      postCloseSample,
      taskPoolProbes: dedupProbes,
      fileRefCleanupProbe,
      leftoverChildProcesses: leftoverChildren,
      runAnatomy,
      extrapolation,
      missingLink,
      notes,
    };
    const evidencePath = path.join(outDir, 'evidence.json');
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

    console.log('\n══ R5 记录总结（不判红）═══');
    console.log(`runs 完成：${runsDone}/${TOTAL_RUNS}（失败 ${failedRuns}）；harnessOk=${harnessOk}`);
    console.log(`磁盘：root ${baseline.rootBytes} → ${final.rootBytes}（in-flight per-run ≈ ${perRunBytes}B；收口后 per-run ≈ ${perRunBytesClosed}B = runs ${perRunRunsBytes} + files ${perRunFilesBytes} + db ${perRunDbBytesClosed} + sessions ${perRunSessionsBytes}）`);
    console.log(`runs/ 条目：${baseline.runsDirCount} → ${final.runsDirCount}；files/ 条目：${baseline.filesDirCount} → ${final.filesDirCount}`);
    console.log(`file_refs 行：${baseline.fileRefCount} → ${final.fileRefCount}；Main 面同 sha 复用 fileId 数=${mainProbe.reusedFileIds}；files/ 同 sha 副本=${mainProbe.filesDirProbeShaCopies}`);
    for (const probe of dedupProbes) console.log(`m4 ${probe.probe} — ${probe.detail}`);
    console.log(`file_refs 字节回收实测（ok=${fileRefCleanupProbe.ok}）：${fileRefCleanupProbe.detail}`);
    console.log(`RSS 拟合：vmRSS 斜率=${rssFit.slope}B/run r=${rssFit.r}；vmHWM 斜率=${hwmFit.slope}B/run；残留子进程=${leftoverChildren.length}`);
    console.log(`SQLite 收口：db=${postCloseSample.dbBytes}(+wal ${postCloseSample.dbWalBytes})；file_refs=${postCloseSample.fileRefCount}`)
    console.log(`推算（假设 100 次/天，收口后 ${extrapolation.perRunBytesClosed}B/run）：30 天=${extrapolation.table[0]!.bytesClosed === null ? '—' : ((extrapolation.table[0]!.bytesClosed as number) / 1024 / 1024).toFixed(1)}MiB；365 天=${extrapolation.table[2]!.bytesClosed === null ? '—' : ((extrapolation.table[2]!.bytesClosed as number) / 1024 / 1024).toFixed(1)}MiB；至 1GiB 需 ${extrapolation.runsUntil1GB} 次`);
    console.log(`缺环：${missingLink.length} 条（详见 evidence.json）`);
    console.log(`证据：${evidencePath}`);
    process.exitCode = harnessOk ? 0 : 1;
  } catch (error) {
    notes.push(`harness 异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    writeFileSync(path.join(outDir, 'evidence.json'), JSON.stringify({ startedAt, harnessOk: false, notes, diskCurve: disk, memoryCurve: memory }, null, 2));
    console.log(`harness 异常（证据已落盘）：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    if (existsSync(harness.dir)) rmSync(harness.dir, { recursive: true, force: true });
  }
}

void main();
