/**
 * CAP-01 R7 故障注入验收（可重复执行，不靠人工点、不依赖真磁盘满）。
 *
 * 口径（验收指令 ①–④；只验用户可见结果与安全不变量；全样本保留、不筛绿；判据不发明——
 * 设计稿没写清的行为一律标 UNDEFINED 并如实记录现状与影响）：
 *
 *   F1 产物登记中途 kill 宿主 → 重启后 file_refs 是否有「半截登记」（有 = 红）。
 *      注入方式：宿主写侧（openTaskStore + createFileStore，与 server/ask 同一构造）放进
 *      独立子进程（r7-faults-child.ts register），对 prepared out/ 目录调真实
 *      registerOutputsFromOut；父脚本在 `ready` 锚点后按标定时长 T 的分数点 SIGKILL
 *      （insert-heavy 160 小文件 → 行插入窗口密集；copy-heavy 6×2MB → 拷贝中途窗口），
 *      每样本独立目录；kill 后由**另一个进程**（父）重新打开同一库（= 重启，WAL 恢复），
 *      逐行核对 file_refs：字节缺失 / 大小不符 / sha256 不符 任一即「半截登记」= 红。
 *      孤儿字节（盘上有字节、无行）不是 file_refs 半截——按 copy-before-insert 登记纪律
 *      的已知形态记录（观察项，不判红；file-store.ts copyFdWithHash 注释明言半成品留给
 *      TTL 清孤儿）。失败样本目录整体保留进 out-dir。
 *
 *   F2 模拟写盘失败 → 行为可读、不静默成功。
 *      注入方式：登记目标目录 …/files/ chmod 0o500（真实 EACCES，不造假磁盘满）。
 *      组件级：registerOutputsFromOut / putFile 必须抛错（错误可读、零行、无半截）。
 *      server 级（假渠道 + 假驱动，直调 handler）：回合必须不静默成功——handler 拒绝或
 *      回复明示失败；全程无 file_delivery sent、无投递端口调用、file_refs 零新增行。
 *
 *   F3 交付成功但事件写失败 → 是否会导致重复交付。
 *      注入方式：deps.logger（装配既有注入点）在 file_delivery 事件上抛错 = 事件写失败；
 *      交付端口照常成功（用户已收到字节）。两个真实重投驱动各验一条：
 *        f3a 只在 status=sent 时抛（只丢成功事实）。
 *          两条红的来由（修复 0d5bbd7 之前）：sendToConversation 已成功却被 catch 误报
 *            delivery_failed、用户话术「未送达（请重试…）」——①成功被误报为失败（判据
 *            保留判红）；②用户按话术重试同一产物 → file_refs 两行 = 重复交付红（原第
 *            二条判据的红依赖①的误报诱导）。
 *          修复后（0d5bbd7，server.ts:401-418）：sent 定型后事件写失败只降级为独立观测
 *            事件（file_delivery_log_write_failed），不翻转结果 → ①误报消失、判据 PASS；
 *            ②降为记录项 REC——原红依赖的误报已修，用户说「没收到，请重试」是用户主动
 *            要求，再交付一份是正确行为，本条只记录「用户主动重试会再交付一份、file_refs
 *            多一行」，不判红（保留检查项，不标 PASS/FAIL）。
 *        f3b 整个 file_delivery 事件面抛 → 回合结果是否被翻转 → 渠道重投（同 messageId；
 *            server 对失败回合「不缓存、渠道可重试」是既定语义）。
 *          红之来由（修复 0d5bbd7 之前）：事件写失败穿出 catch 翻转回合结果 → dedup 缓存
 *            清除 → 同 messageId 重投整回合重跑 → 重复交付红。
 *          修复后：事件面写失败同样不翻转回合结果（server.ts:381-418）→「交付已发生且
 *            回合失败」前置不可达 → 前置判据改条件式：首回合失败（回归形态）才照原样
 *            判 dedup 断言；当前不可达记 SKIP（不标 PASS）并引用 server.ts:381-418。
 *            渠道重投判据本身保留判红：当前态重投命中 dedup 缓存重放、零新副作用；
 *            若回归（回合失败不缓存）重投整回合重跑 → 重复交付即红。
 *      重复交付 = 端口第二次收到同一 sha256 的产物字节。设计稿对「事件写失败」的预期
 *      行为没有规定（v8 §7 只定义交付失败事实=事件+话术）→ 现状如实记录 + UNDEFINED 标注。
 *
 *   F4 两进程同时写同一 SQLite → 行为（锁/重试/报错）如实记录。
 *      注入方式：两个真实子进程对同一 dbPath 并发写（F4a：各 25 轮 insertTask/insertFileRef/
 *      mintOperation，同 scopeKey 抢 op_seq）；另测长写锁（F4b 持锁 8s > busy_timeout、
 *      F4c 持锁 2.5s < busy_timeout）下第三方写的阻塞/重试/报错。硬判据（红）：已报告成功的
 *      写不得丢失（行数对得上）、task_no / op_seq 不得重复（task-store.ts 头注声明跨进程
 *      编号唯一）；SQLITE_BUSY / 等待时长属于「锁/重试/报错」行为，如实记录不判红。
 *
 * 模型口径：本脚本全部脚本化注入，真模型 0 次调用（预算 0/24）。
 *
 * 运行：
 *   node --import tsx scripts/eval/cap01/r7-faults.ts [--only f1,f2,f3,f4] [--out-dir <dir>]
 *        [--kill-fractions 0.1,0.5,...]（绊线复验用）
 * 缺省 out-dir = .runtime/eval-cap01-r7-faults/<时间戳>（.runtime 不进 git）。
 * 退出码：0 = 全部红判据通过（REC 记录项 / SKIP 前置不可达不计红）；1 = 任一红判据 FAIL。
 */
import { spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openTaskStore, type FileRefRow, type TaskStore } from '@fshine/core';
import type {
  AppConfig,
  ChannelReply,
  ChannelRoute,
  DeliveryReceipt,
  IncomingChannelMessage,
  OutgoingFileReply,
} from '@fshine/contracts';
import type { DriverMessage, TurnDriver } from '../../../packages/agent/src/driver-contract';
import {
  createFileStore,
  fileStoragePathOf,
  principalHashOf,
  sessionHashOf,
  type FileScope,
} from '../../../packages/agent/src/file-store';
import { createServer, type FileDeliveryPort } from '../../../apps/server/server';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CHILD_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'r7-faults-child.ts');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

// ── 通用结果形状 ─────────────────────────────────────────────────────────────

type CheckKind = 'criterion' | 'observation';

interface CheckResult {
  name: string;
  kind: CheckKind;
  /** REC = 记录项（不判红）；SKIP = 前置不可达（如实登记原因，不标 PASS）。 */
  status: 'PASS' | 'FAIL' | 'REC' | 'SKIP';
  detail: string;
}

interface FaultOutcome {
  fault: string;
  status: 'PASS' | 'FAIL';
  /** true = 红判据（criterion）FAIL——用户可见结果或安全不变量被破坏。 */
  red: boolean;
  checks: CheckResult[];
  /** 现状行为记录（观察项、行为描述与 UNDEFINED 项）。 */
  notes: string[];
  evidence: Array<Record<string, unknown>>;
}

function check(name: string, kind: CheckKind, pass: boolean, detail: string): CheckResult {
  return { name, kind, status: pass ? 'PASS' : 'FAIL', detail };
}

/** 记录项（REC）：如实记录现状、不判红（r3-core.ts 同款口径：pass=null 记录项）。 */
function record(name: string, detail: string): CheckResult {
  return { name, kind: 'observation', status: 'REC', detail };
}

/** 前置不可达（SKIP）：保留检查项、如实登记不可达原因；不许直接标 PASS。 */
function skipped(name: string, detail: string): CheckResult {
  return { name, kind: 'observation', status: 'SKIP', detail };
}

function finalize(outcome: FaultOutcome): FaultOutcome {
  const anyFail = outcome.checks.some((item) => item.status === 'FAIL');
  const red = outcome.checks.some((item) => item.kind === 'criterion' && item.status === 'FAIL');
  return { ...outcome, red, status: anyFail ? 'FAIL' : 'PASS' };
}

function errCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── 子进程驱动（spawn / SIGKILL 注入） ───────────────────────────────────────

interface ChildRun {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  readyAt: number | undefined;
  doneLine: string | undefined;
  killedByParent: boolean;
}

function spawnChild(
  mode: string,
  payload: Record<string, unknown>,
  options: { killAfterReadyMs?: number; onLine?: (line: string) => void } = {},
): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CHILD_SCRIPT, mode, JSON.stringify(payload)],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let readyAt: number | undefined;
    let doneLine: string | undefined;
    let killedByParent = false;
    let killTimer: NodeJS.Timeout | undefined;
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        options.onLine?.(line);
        if (line.startsWith('ready ') && readyAt === undefined) {
          readyAt = Date.now();
          if (options.killAfterReadyMs !== undefined) {
            killTimer = setTimeout(() => {
              killedByParent = true;
              child.kill('SIGKILL');
            }, options.killAfterReadyMs);
          }
        }
        if (line.startsWith('done ') || line.startsWith('result ') || line.startsWith('probe ')
          || line.startsWith('held-done ') || line.startsWith('busy ') || line.startsWith('unknown-mode')) {
          doneLine = line;
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({ code, signal: signal ?? null, stdout, stderr, readyAt, doneLine, killedByParent });
    });
  });
}

// ── F1：产物登记中途 kill 宿主 ───────────────────────────────────────────────

interface F1Profile {
  id: string;
  fileCount: number;
  fileBytes: number;
}

const F1_PROFILES: readonly F1Profile[] = [
  { id: 'insert-heavy', fileCount: 160, fileBytes: 96 },
  { id: 'copy-heavy', fileCount: 6, fileBytes: 2 * 1024 * 1024 },
];

const F1_SCOPE: FileScope = { principalId: 'eval-cap01-f1', sessionId: 'eval-cap01-f1' };

function f1PrepareFixture(dir: string, profile: F1Profile): { dbPath: string; workspaceRoot: string; runDir: string } {
  const dbPath = path.join(dir, 'state.db');
  const workspaceRoot = path.join(dir, 'workspace');
  const runDir = path.join(
    workspaceRoot,
    principalHashOf(F1_SCOPE.principalId),
    sessionHashOf(F1_SCOPE.sessionId),
    'runs',
    'run_kill',
  );
  const outDir = path.join(runDir, 'out');
  mkdirSync(outDir, { recursive: true });
  const chunk = Buffer.from('kill-window-bytes;');
  for (let index = 0; index < profile.fileCount; index += 1) {
    const pieces = Math.max(1, Math.ceil(profile.fileBytes / chunk.length));
    const bytes = Buffer.concat(Array.from({ length: pieces }, () => chunk)).subarray(0, profile.fileBytes);
    writeFileSync(path.join(outDir, `out-${String(index).padStart(4, '0')}.txt`), bytes);
  }
  return { dbPath, workspaceRoot, runDir };
}

interface F1Verification {
  rows: number;
  orphans: number;
  violations: Array<{ fileId: string; kind: string; detail: string }>;
  manifestVisible: number;
}

/**
 * kill 后由父进程重新打开同一库（= 重启：WAL 恢复 + 迁移检查与宿主重启同路径），
 * 逐行核对 file_refs 行与盘上字节的一致性。
 */
function f1Verify(dir: string): F1Verification {
  const dbPath = path.join(dir, 'state.db');
  const workspaceRoot = path.join(dir, 'workspace');
  const store: TaskStore = openTaskStore(dbPath);
  try {
    const rows: FileRefRow[] = store.listFileRefs(F1_SCOPE);
    const violations: F1Verification['violations'] = [];
    for (const row of rows) {
      const storagePath = fileStoragePathOf(workspaceRoot, F1_SCOPE, row.fileId, row.name);
      if (!existsSync(storagePath)) {
        violations.push({
          fileId: row.fileId,
          kind: 'bytes_missing',
          detail: `file_refs 行存在（name=${row.name} bytes=${row.bytes}）但字节文件缺失：${path.basename(storagePath)}`,
        });
        continue;
      }
      const bytes = statSync(storagePath).size;
      if (bytes !== row.bytes) {
        violations.push({ fileId: row.fileId, kind: 'size_mismatch', detail: `行声称 bytes=${row.bytes}，盘上 ${bytes} 字节（半截字节）` });
        continue;
      }
      const actualSha = createHash('sha256').update(readFileSync(storagePath)).digest('hex');
      if (actualSha !== row.sha256) {
        violations.push({ fileId: row.fileId, kind: 'sha_mismatch', detail: '行 sha256 与重算不符（字节截断/改写后仍登记）' });
      }
    }
    const filesDir = path.join(
      workspaceRoot,
      principalHashOf(F1_SCOPE.principalId),
      sessionHashOf(F1_SCOPE.sessionId),
      'files',
    );
    const rowIds = new Set(rows.map((row) => row.fileId));
    let orphans = 0;
    if (existsSync(filesDir)) {
      for (const entry of readdirSync(filesDir)) {
        const fileId = entry.slice(0, entry.lastIndexOf('.'));
        if (!rowIds.has(fileId)) orphans += 1;
      }
    }
    const fileStore = createFileStore({ store, workspaceRoot });
    const manifest = fileStore.listActiveFiles({ scope: F1_SCOPE, now: Date.now() });
    return { rows: rows.length, orphans, violations, manifestVisible: manifest.length };
  } finally {
    store.close();
  }
}

async function fault1(outDir: string, fractions: readonly number[]): Promise<FaultOutcome> {
  const checks: CheckResult[] = [];
  const notes: string[] = [];
  const evidence: Array<Record<string, unknown>> = [];
  const samples: Array<Record<string, unknown>> = [];
  let violationsTotal = 0;
  let manifestHiddenTotal = 0;
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cap01-r7-f1-'));
  try {
    for (const profile of F1_PROFILES) {
      // 标定：同一夹具完整跑一遍（不 kill），量登记耗时 T 与行数。
      const calibDir = mkdtempSync(path.join(tmpRoot, 'calib-'));
      const calib = f1PrepareFixture(calibDir, profile);
      const calibRun = await spawnChild('register', {
        dbPath: calib.dbPath,
        workspaceRoot: calib.workspaceRoot,
        runDir: calib.runDir,
        scope: F1_SCOPE,
        maxFileBytes: 8 * 1024 * 1024,
        maxCount: 1000,
      });
      const calibMatch = /done t=\d+ rows=(\d+) skipped=(\d+) elapsedMs=(\d+)/.exec(calibRun.doneLine ?? '');
      if (calibMatch === null || calibRun.code !== 0) {
        checks.push(check(
          'f1.故障路径触发（标定运行）',
          'criterion',
          false,
          `标定运行失败（exit=${calibRun.code} stderr=${calibRun.stderr.slice(-300)}）——kill 注入无法进行，验收不通过。`,
        ));
        evidence.push({ step: 'calibration-failed', profile: profile.id, stdout: calibRun.stdout, stderr: calibRun.stderr.slice(-500) });
        return finalize({ fault: 'f1', status: 'FAIL', red: false, checks, notes, evidence });
      }
      const expectedRows = Number(calibMatch[1]);
      const durationMs = Math.max(30, Number(calibMatch[3]));
      notes.push(`profile=${profile.id} 标定：完整登记 ${expectedRows} 行耗时约 ${durationMs}ms`);
      evidence.push({ step: 'calibration', profile: profile.id, rows: expectedRows, durationMs });
      rmSync(calibDir, { recursive: true, force: true });

      for (const fraction of fractions) {
        const killAfterReadyMs = Math.max(1, Math.round(durationMs * fraction));
        const dir = mkdtempSync(path.join(tmpRoot, 'kill-'));
        const fixture = f1PrepareFixture(dir, profile);
        const run = await spawnChild('register', {
          dbPath: fixture.dbPath,
          workspaceRoot: fixture.workspaceRoot,
          runDir: fixture.runDir,
          scope: F1_SCOPE,
          maxFileBytes: 8 * 1024 * 1024,
          maxCount: 1000,
        }, { killAfterReadyMs });
        if (run.readyAt === undefined) {
          checks.push(check(
            'f1.故障路径触发（子进程就绪）',
            'criterion',
            false,
            `kill 样本（${profile.id}@${fraction}）子进程未就绪即退出（exit=${run.code}）：${run.stderr.slice(-300)}`,
          ));
          evidence.push({ step: 'kill-sample-aborted', profile: profile.id, fraction, stderr: run.stderr.slice(-500) });
          continue;
        }
        const verified = f1Verify(dir);
        const sample = {
          profile: profile.id,
          fraction,
          killAfterReadyMs,
          childDoneBeforeKill: run.doneLine?.startsWith('done ') === true,
          childExit: { code: run.code, signal: run.signal, killedByParent: run.killedByParent },
          ...verified,
        };
        samples.push(sample);
        violationsTotal += verified.violations.length;
        manifestHiddenTotal += verified.rows - verified.manifestVisible;
        if (verified.violations.length > 0) {
          // 失败样本连库 + workspace 字节一起保留。
          const kept = path.join(outDir, `f1-red-sample-${profile.id}-${String(fraction).replace('.', '_')}`);
          try {
            cpSync(dir, kept, { recursive: true });
          } catch (error) {
            notes.push(`红样本目录保留失败（${errMessage(error)}）：原始路径 ${dir}`);
          }
        }
        evidence.push({
          step: 'kill-sample',
          ...(sample as Record<string, unknown>),
          ...(run.stderr.length > 0 ? { stderrTail: run.stderr.slice(-400) } : {}),
        });
        rmSync(dir, { recursive: true, force: true });
      }
    }
    checks.push(check(
      'f1.重启后 file_refs 无半截登记（红判据）',
      'criterion',
      violationsTotal === 0,
      violationsTotal === 0
        ? `${samples.length} 个 kill 样本（两档夹具 × ${fractions.join('/')} 分数点），重启后逐行核对：无一行字节缺失/截断/sha 不符。`
        : `发现 ${violationsTotal} 处半截登记（violations 见 evidence；样本目录保留在 out-dir）。`,
    ));
    checks.push(check(
      'f1.重启后清单可见（登记过的产物重启后仍可查可交付）',
      'criterion',
      manifestHiddenTotal === 0,
      manifestHiddenTotal === 0
        ? '每个样本 file_refs 行数 = 重启后 listActiveFiles 可见数（宿主重启不丢已登记产物）。'
        : `${manifestHiddenTotal} 行重启后不在清单里（用户可见的文件面丢了行）。`,
    ));
    const orphanSamples = samples.filter((sample) => Number(sample['orphans']) > 0);
    notes.push(
      `孤儿字节（盘上有字节、无 file_refs 行）出现在 ${orphanSamples.length}/${samples.length} 个样本`
      + `（${orphanSamples.map((sample) => `${String(sample['profile'])}@${String(sample['fraction'])}:${String(sample['orphans'])}`).join(' ') || '无'}）——`
      + '与登记纪律（先落字节后落行；半成品留给 TTL 清孤儿，file-store.ts copyFdWithHash 注释）一致，不判红；UNDEFINED：清理时机无设计规定。',
    );
    notes.push('kill 落点说明：分数点按标定时长换算，SIGKILL 立即生效；childDoneBeforeKill=true 的样本 = kill 落在登记完成后（等效重启即用）。');
    evidence.push({ step: 'samples', samples });
    return finalize({ fault: 'f1', status: 'PASS', red: false, checks, notes, evidence });
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ── server 夹具（F2/F3 共用；假渠道 + 假驱动，零网络零真模型） ─────────────────

const RUN_JS_WRITE = "require('node:fs').writeFileSync('out/报告.txt', 'report-v1-bytes');";
const REPORT_SHA = createHash('sha256').update('report-v1-bytes').digest('hex');

const FAULT_CONFIG: AppConfig = {
  principals: { 'wecom:user-a': { enabled: true } },
  contextProfiles: { dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] } },
  channel: { port: 0, publicUrl: '', callbackPath: '/wecom/callback' },
  sessionTtlMs: 86_400_000,
};

const TURN_SCOPE: FileScope = { principalId: 'wecom:user-a', sessionId: 'wecom:conv-a' };

function incoming(messageId: string, text: string): IncomingChannelMessage {
  return {
    wecomUserId: 'user-a',
    channel: 'wecom',
    conversationId: 'conv-a',
    messageId,
    chatType: 'single',
    text,
    receivedAt: new Date().toISOString(),
  };
}

/** handler 契约返回 ChannelReply（string | Rich）；server 装配的 inline 路径只回 string——归一成文本再断言。 */
function replyText(reply: ChannelReply): string {
  if (typeof reply === 'string') return reply;
  return reply.text ?? '(rich reply 无 text)';
}

interface SequencedStep {
  execCalls?: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;
  text: string;
}

function sequencedDriver(steps: readonly SequencedStep[], runLog: string[]): TurnDriver {
  let index = 0;
  return {
    async run(input) {
      runLog.push(`run#${index}`);
      const step = steps[index];
      index += 1;
      if (step === undefined) throw new Error('（测试）没有更多驱动步骤');
      for (const call of step.execCalls ?? []) {
        await input.exec(call.tool, call.args);
      }
      return { text: step.text, messages: [] as unknown as DriverMessage[] };
    },
  };
}

interface FaultServer {
  server: Awaited<ReturnType<typeof createServer>>;
  logs: Array<Record<string, unknown>>;
  calls: Array<{ route: ChannelRoute; files: Array<{ filename: string; sha256: string; bytes: number }> }>;
  store: TaskStore;
  driverRuns: string[];
  close(): Promise<void>;
}

async function makeFaultServer(input: {
  dir: string;
  /** 缺省 = 记录全部事件到 logs；给定 = 先记录、再按规则抛错（事件写失败注入）。 */
  logger?: (line: Record<string, unknown>) => void;
  steps?: readonly SequencedStep[];
}): Promise<FaultServer> {
  const logs: Array<Record<string, unknown>> = [];
  const baseLogger = (line: Record<string, unknown>): void => {
    logs.push(line);
  };
  const logger = input.logger ?? baseLogger;
  const loggingLogger = (line: Record<string, unknown>): void => {
    baseLogger(line);
    if (input.logger !== undefined) input.logger(line);
  };
  const calls: FaultServer['calls'] = [];
  const port: FileDeliveryPort = {
    deliveryMode: 'live',
    async sendToConversation(route, files): Promise<DeliveryReceipt> {
      calls.push({
        route,
        files: files.map((file: OutgoingFileReply) => ({
          filename: file.filename,
          bytes: file.data.length,
          sha256: createHash('sha256').update(file.data).digest('hex'),
        })),
      });
      return { route, parts: files.map((_, index) => ({ kind: 'file' as const, index, status: 'sent' as const })) };
    },
  };
  const driverRuns: string[] = [];
  const steps: readonly SequencedStep[] = input.steps
    ?? [{ execCalls: [{ tool: 'run_js', args: { code: RUN_JS_WRITE } }], text: '汇总完成。' }];
  const server = await createServer({
    env: { LLM_MODEL: 'scripted-fault-driver' },
    config: FAULT_CONFIG,
    dbPath: path.join(input.dir, 'state.db'),
    stateDir: path.join(input.dir, 'state'),
    sessionStoreDir: path.join(input.dir, 'sessions'),
    createDrivers: () => ({
      mainDriver: sequencedDriver(steps, driverRuns),
      workerDriver: { async run() { throw new Error('（测试）worker 不应被调用'); } },
    }),
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
    fileDelivery: port,
    logger: loggingLogger,
  });
  const store = openTaskStore(path.join(input.dir, 'state.db'));
  return {
    server,
    logs,
    calls,
    store,
    driverRuns,
    async close() {
      store.close();
      await server.close();
    },
  };
}

// ── F2：模拟写盘失败（chmod 0o500 = 真实 EACCES） ────────────────────────────

const F2_SCOPE: FileScope = { principalId: 'eval-cap01-f2', sessionId: 'eval-cap01-f2' };

function sessionFilesDir(workspaceRoot: string, scope: FileScope): string {
  return path.join(
    workspaceRoot,
    principalHashOf(scope.principalId),
    sessionHashOf(scope.sessionId),
    'files',
  );
}

async function fault2(): Promise<FaultOutcome> {
  const checks: CheckResult[] = [];
  const notes: string[] = [];
  const evidence: Array<Record<string, unknown>> = [];
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cap01-r7-f2-'));
  try {
    // 组件级 1：registerOutputsFromOut 对只读登记目录。
    {
      const dir = path.join(tmpRoot, 'comp-register');
      const outFixture = path.join(dir, 'out');
      mkdirSync(outFixture, { recursive: true });
      writeFileSync(path.join(outFixture, '报告-a.txt'), Buffer.alloc(200 * 1024, 'a'));
      writeFileSync(path.join(outFixture, '报告-b.txt'), Buffer.from('tiny'));
      const filesDir = sessionFilesDir(path.join(dir, 'workspace'), F2_SCOPE);
      mkdirSync(filesDir, { recursive: true });
      chmodSync(filesDir, 0o500);
      const store = openTaskStore(path.join(dir, 'state.db'));
      let registerError: unknown;
      try {
        const fileStore = createFileStore({ store, workspaceRoot: path.join(dir, 'workspace') });
        fileStore.registerOutputsFromOut({
          runDir: dir,
          scope: F2_SCOPE,
          limits: { maxFileBytes: 8 * 1024 * 1024, maxCount: 100 },
        });
      } catch (error) {
        registerError = error;
      }
      const rows = store.listFileRefs(F2_SCOPE);
      const filesAfter = existsSync(filesDir) ? readdirSync(filesDir) : [];
      chmodSync(filesDir, 0o700);
      checks.push(check(
        'f2.组件级：登记写失败必须抛错（不吞）',
        'criterion',
        registerError !== undefined,
        registerError !== undefined
          ? `抛出 ${errCode(registerError) ?? '(无 errno code)'}：「${errMessage(registerError).slice(0, 160)}」`
          : 'registerOutputsFromOut 静默返回——写盘失败被吞（红）。',
      ));
      checks.push(check(
        'f2.组件级：写失败零登记（无半截行/无半截字节）',
        'criterion',
        registerError !== undefined && rows.length === 0 && filesAfter.length === 0,
        `file_refs 新增 ${rows.length} 行、files/ 目录 ${filesAfter.length} 个文件（期望均 0）。`,
      ));
      evidence.push({
        step: 'component-register',
        errorCode: errCode(registerError),
        message: registerError === undefined ? undefined : errMessage(registerError),
        rows: rows.length,
        filesLeft: filesAfter,
      });
      store.close();
    }
    // 组件级 2：putFile 对只读登记目录。
    {
      const dir = path.join(tmpRoot, 'comp-put');
      const filesDir = sessionFilesDir(path.join(dir, 'workspace'), F2_SCOPE);
      mkdirSync(filesDir, { recursive: true });
      chmodSync(filesDir, 0o500);
      const store = openTaskStore(path.join(dir, 'state.db'));
      let putError: unknown;
      try {
        const fileStore = createFileStore({ store, workspaceRoot: path.join(dir, 'workspace') });
        fileStore.putFile({ scope: F2_SCOPE, name: '直写.txt', bytes: Buffer.from('x') });
      } catch (error) {
        putError = error;
      }
      const rows = store.listFileRefs(F2_SCOPE);
      chmodSync(filesDir, 0o700);
      checks.push(check(
        'f2.组件级：putFile 写失败必须抛错且零行',
        'criterion',
        putError !== undefined && rows.length === 0,
        putError !== undefined
          ? `抛出 ${errCode(putError) ?? '(无 errno code)'}，file_refs ${rows.length} 行`
          : 'putFile 静默成功（红）。',
      ));
      evidence.push({ step: 'component-put', errorCode: errCode(putError), rows: rows.length });
      store.close();
    }
    // server 级：回合中登记写失败 → 不静默成功。
    {
      const dir = path.join(tmpRoot, 'server');
      mkdirSync(dir, { recursive: true });
      const fixture = await makeFaultServer({ dir });
      const filesDir = sessionFilesDir(path.join(dir, 'workspace'), TURN_SCOPE);
      mkdirSync(filesDir, { recursive: true });
      chmodSync(filesDir, 0o500);
      let handlerError: unknown;
      let reply: string | undefined;
      try {
        reply = replyText(await fixture.server.handler(incoming('m-f2', '帮我汇总')));
      } catch (error) {
        handlerError = error;
      }
      const rows = fixture.store.listFileRefs(TURN_SCOPE);
      const sentLogged = fixture.logs.some((line) => line['event'] === 'file_delivery' && line['status'] === 'sent');
      const doneLogged = fixture.logs.some((line) => line['event'] === 'message_done');
      const filesAfter = existsSync(filesDir) ? readdirSync(filesDir) : [];
      const failureWorded = reply !== undefined && /未送达|失败|错误|无法/.test(reply);
      const silentSuccess = reply !== undefined && !failureWorded;
      chmodSync(filesDir, 0o700);
      checks.push(check(
        'f2.server 级：不静默成功（红判据）',
        'criterion',
        !silentSuccess,
        handlerError !== undefined
          ? `回合失败可见：handler 抛出 ${errCode(handlerError) ?? ''}「${errMessage(handlerError).slice(0, 200)}」`
          : silentSuccess
            ? `回合照常成功回执「${String(reply).slice(0, 80)}」而登记零行——静默成功（红）。`
            : `回合返回失败话术「${String(reply).slice(0, 80)}」。`,
      ));
      checks.push(check(
        'f2.server 级：无虚假交付事实（红判据）',
        'criterion',
        !sentLogged && fixture.calls.length === 0 && rows.length === 0,
        `file_delivery sent 事件 ${sentLogged ? '出现（红）' : '无'}；投递端口调用 ${fixture.calls.length} 次；`
          + `file_refs ${rows.length} 行；files/ 目录 ${filesAfter.length} 个文件。`,
      ));
      checks.push(check(
        'f2.server 级：失败回合不落 message_done',
        'observation',
        !doneLogged,
        doneLogged ? 'message_done 出现（回合被记成功，需关注）。' : 'message_done 未落（回合按失败处理）。',
      ));
      notes.push(`错误可读性（观察）：handler 边界错误 = ${handlerError === undefined ? '(回合未抛)' : `${errCode(handlerError) ?? ''} ${errMessage(handlerError)}`}`);
      notes.push('UNDEFINED：登记中途失败后 out/ 已写出的原始文件、以及同一次扫描中更早登记成功的行如何处置，设计稿未规定（现状：已成功行保留、回合失败、不交付）。');
      evidence.push({
        step: 'server',
        rejected: handlerError !== undefined,
        message: handlerError === undefined ? undefined : errMessage(handlerError),
        rows: rows.length,
        sentLogged,
        portCalls: fixture.calls.length,
        filesLeft: filesAfter,
        logs: fixture.logs,
      });
      await fixture.close();
    }
    return finalize({ fault: 'f2', status: 'PASS', red: false, checks, notes, evidence });
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ── F3：交付成功但事件写失败 → 是否重复交付 ──────────────────────────────────

async function fault3(): Promise<FaultOutcome> {
  const checks: CheckResult[] = [];
  const notes: string[] = [];
  const evidence: Array<Record<string, unknown>> = [];
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cap01-r7-f3-'));
  try {
    // f3a：事件写失败只吞成功事实（sent 抛错，delivery_failed 正常写）。
    {
      const dir = path.join(tmpRoot, 'a');
      mkdirSync(dir, { recursive: true });
      let injected = 0;
      const fixture = await makeFaultServer({
        dir,
        steps: [
          { execCalls: [{ tool: 'run_js', args: { code: RUN_JS_WRITE } }], text: '汇总完成。' },
          { execCalls: [{ tool: 'run_js', args: { code: RUN_JS_WRITE } }], text: '汇总完成。' },
        ],
        logger: (line) => {
          if (line['event'] === 'file_delivery' && line['status'] === 'sent') {
            injected += 1;
            throw new Error('（故障注入）日志管道写失败：sent 事件无法落盘');
          }
        },
      });
      const firstReply = replyText(await fixture.server.handler(incoming('m-f3a-1', '帮我汇总')));
      const deliveredFirst = fixture.calls.length === 1
        && fixture.calls[0]!.files.length === 1
        && fixture.calls[0]!.files[0]!.sha256 === REPORT_SHA;
      const misreported = /未送达/.test(firstReply);
      checks.push(check(
        'f3a.交付成功但事件写失败 → 用户被误报「未送达」（红判据）',
        'criterion',
        !(deliveredFirst && misreported),
        deliveredFirst && misreported
          ? '字节已送达端口（sha256 与产物一致）但回复含「未送达（投递失败，请重试或联系管理员）」——成功被误报为失败。'
          : `现状：端口 ${fixture.calls.length} 次调用、reply=「${firstReply.slice(0, 120)}」（修复 0d5bbd7 后 sent 定型，事件写失败不再改写话术）。`,
      ));
      // 用户主动重试（新消息 m-f3a-2）→ 新回合重新执行 → 再交付一份。
      const secondReply = replyText(await fixture.server.handler(incoming('m-f3a-2', '未收到，请重试')));
      const rows = fixture.store.listFileRefs(TURN_SCOPE);
      const duplicateDelivered = fixture.calls.length >= 2
        && fixture.calls[1]!.files[0]!.sha256 === REPORT_SHA;
      // 原红判据（来由见文件头 F3）：修复前首回合误报「未送达（请重试…）」，用户按话术
      // 重试是被诱导的重试，重复交付 = 红。该误报已修（本文件 f3a 第一条判据 PASS 断言、
      // server.ts:401-418）——现在用户说「没收到，请重试」是用户主动要求，再交付一份是
      // 正确行为。故降为记录项（REC）：保留检查项，如实记录「用户主动重试会再交付一份、
      // file_refs 多一行」；不判红、不标 PASS/FAIL。
      checks.push(record(
        'f3a.用户按话术重试 → 同一内容重复交付（记录项）',
        `用户主动重试（新消息）后端口共 ${fixture.calls.length} 次调用`
        + (duplicateDelivered
          ? `，第 2 份同 sha256（${REPORT_SHA.slice(0, 16)}…）产物——记录：用户主动重试会再交付一份；file_refs ${rows.length} 行（每回合各登记一行，多一行）。`
          : `（未再交付）；file_refs ${rows.length} 行。`)
        + ` 原红依赖的「首回合误报未送达」已修（f3a 第一条判据 PASS）——本条不再判红，只记录重试行为。`,
      ));
      notes.push(
        `f3a 现状链路（修复 0d5bbd7 后）：sent 事件写失败 → server.ts:401-418 降级为独立观测事件`
        + `（file_delivery_log_write_failed，status 仍 sent），结果保持 sent、话术不出现「未送达」`
        + `→ 用户主动重试（新消息）= 新回合重新执行 → 再交付一份、file_refs 多一行（记录项，见上）。`,
      );
      notes.push('UNDEFINED（设计面）：v8 §7 对「交付事件本身写失败」的预期行为仍无明文（只定义交付失败事实=事件+话术，无重发消费者）；现行实现取「sent 定型后写失败降级为观测事件、不翻转不重投」（0d5bbd7，server.ts:401-418），在此如实记录。');
      evidence.push({
        step: 'f3a',
        injectedThrown: injected,
        portCalls: fixture.calls,
        firstReply,
        secondReply,
        fileRefRows: rows.length,
        logs: fixture.logs,
      });
      await fixture.close();
    }
    // f3b：整个 file_delivery 事件面写失败 → 回合结果是否被翻转 → 渠道重投（同 messageId）。
    // 前置「交付已发生且回合失败」修复后不可达（见下方条件式判据与文件头 F3）。
    {
      const dir = path.join(tmpRoot, 'b');
      mkdirSync(dir, { recursive: true });
      let injected = 0;
      const fixture = await makeFaultServer({
        dir,
        steps: [
          { execCalls: [{ tool: 'run_js', args: { code: RUN_JS_WRITE } }], text: '汇总完成。' },
          { execCalls: [{ tool: 'run_js', args: { code: RUN_JS_WRITE } }], text: '汇总完成。' },
        ],
        logger: (line) => {
          if (line['event'] === 'file_delivery') {
            injected += 1;
            throw new Error('（故障注入）日志管道写失败：file_delivery 事件面不可用');
          }
        },
      });
      let firstError: unknown;
      try {
        await fixture.server.handler(incoming('m-f3b', '帮我汇总'));
      } catch (error) {
        firstError = error;
      }
      const deliveredBeforeFailure = fixture.calls.length === 1;
      // 前置判据（条件式；原红判据之二，来由见文件头 F3）：「交付已发生且回合失败」。
      // 修复前该前置可达：事件写失败穿出 catch 翻转回合结果。修复（0d5bbd7）后 sent 路径
      // 不再有任何改写/翻转（server.ts:381-418：投递成功即定型 sent，日志写失败只降级为
      // 独立观测事件），该前置在当前实现下不可达——不许直接标 PASS，改为条件式：
      // 首回合失败（回归形态）才照原样判；当前不可达记 SKIP 并写明原因。
      if (firstError !== undefined) {
        if (deliveredBeforeFailure) {
          // 回归形态可达：前置成立 = 故障路径触发；dedup 断言（下一条判据）随之生效。
          checks.push(check(
            'f3b.前置：交付已发生（端口收到正确字节）且回合失败',
            'criterion',
            true,
            `首回合失败可见（${errMessage(firstError).slice(0, 140)}）且端口已收到正确字节——前置可达（回归形态），dedup 断言按下一条判据生效。`,
          ));
        } else {
          // 注入形态破损：回合失败但交付未发生——dedup 场景未被执行，既不能 SKIP 也不能 PASS。
          checks.push(check(
            'f3b.前置：交付已发生（端口收到正确字节）且回合失败',
            'criterion',
            false,
            `首回合抛「${errMessage(firstError).slice(0, 140)}」但端口 ${fixture.calls.length} 次调用（交付未发生）——dedup 场景未触发，注入路径破损（红）。`,
          ));
        }
      } else {
        checks.push(skipped(
          'f3b.前置：交付已发生（端口收到正确字节）且回合失败',
          `SKIP：当前不可达——修复（0d5bbd7）后「事件写失败不再翻转回合结果」（server.ts:381-418：投递成功即定型 sent，日志写失败只降级为独立观测事件），首回合未抛、端口 ${fixture.calls.length} 次调用已收到正确字节。若首回合失败（回归形态）则断言 dedup 生效（下一条判据）。`,
        ));
      }
      let redeliveryError: unknown;
      try {
        await fixture.server.handler(incoming('m-f3b', '帮我汇总')); // 同 messageId = 渠道重投
      } catch (error) {
        redeliveryError = error;
      }
      const rows = fixture.store.listFileRefs(TURN_SCOPE);
      const duplicateDelivered = fixture.calls.length >= 2
        && fixture.calls[0]!.files[0]!.sha256 === REPORT_SHA
        && fixture.calls[1]!.files[0]!.sha256 === REPORT_SHA;
      const replayed = fixture.logs.some((line) => line['event'] === 'message_duplicate_replayed');
      checks.push(check(
        'f3b.渠道重投（同 messageId）→ 同一内容重复交付（红判据）',
        'criterion',
        !duplicateDelivered,
        duplicateDelivered
          ? `重投触发整回合重跑并第 2 次交付同一 sha256 产物——用户收到两份；file_refs ${rows.length} 行重复登记。`
          : `重投后端口共 ${fixture.calls.length} 次调用${replayed ? '、命中 dedup 缓存重放既有回执（message_duplicate_replayed，零新副作用）' : ''}；file_refs ${rows.length} 行。`,
      ));
      const doneLogged = fixture.logs.some((line) => line['event'] === 'message_done');
      notes.push(
        `f3b 现状链路（修复 0d5bbd7 后）：事件面写失败同样不翻转回合结果（server.ts:381-418）→ 回合按成功收口`
        + `→ 同 messageId 重投命中 dedup 缓存重放（驱动 run 序列 ${JSON.stringify(fixture.driverRuns)}，零新副作用）`
        + `；若修复回归（file_delivery 事件写失败重新从 deliverTurnFiles 内部穿出 → 源回合 promise 拒绝 →`
        + ` server.ts:549「处理失败不缓存」清缓存）→ 重投整回合重跑 → 重复交付 = 前置可达时的红判据面。`,
      );
      notes.push(
        '已修复（dec-logflip）：回合收口段（server.ts:566-599 message_done 落在 .then 成功分支）的日志写失败'
        + '不再翻转回合结果——写失败只降级为一条独立观测事件 message_done_log_write_failed，回复照常返回'
        + '（守卫见 apps/server/server.test.ts「message_done 事件写失败」用例）。修复前实测注入该点抛错会翻转回合结果'
        + '（首回合抛错、message_done 行已记录），且缓存不清（「处理失败不缓存」只挂源 promise 拒绝分支，不接成功分支抛错）'
        + '→ 重投重放既有（已拒绝的）回执 promise；修复后成功回合的 promise 不再拒绝，重投按既有 dedup 语义重放成功回执。',
      );
      notes.push(doneLogged
        ? 'message_done 落了（回合按成功收口——与修复后链路一致；修复前此处会缺失并触发重投重跑）。'
        : 'message_done 未落（回合按失败处理——若非注入预期，需人工核对）。');
      evidence.push({
        step: 'f3b',
        injectedThrown: injected,
        portCalls: fixture.calls,
        firstError: firstError === undefined ? undefined : errMessage(firstError),
        redeliveryError: redeliveryError === undefined ? undefined : errMessage(redeliveryError),
        fileRefRows: rows.length,
        logs: fixture.logs,
      });
      await fixture.close();
    }
    return finalize({ fault: 'f3', status: 'PASS', red: false, checks, notes, evidence });
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ── F4：两进程同时写同一 SQLite ──────────────────────────────────────────────

const F4_SCOPE: FileScope = { principalId: 'eval-cap01-f4', sessionId: 'eval-cap01-f4' };

interface BurstResult {
  childId: string;
  taskOk: number;
  refOk: number;
  mintOk: number;
  errors: Array<{ op: string; key: string; code?: string; message: string }>;
}

interface ProbeResult {
  fileId: string;
  elapsedMs: number;
  error?: { code?: string; message: string };
}

function parseChildJson<T>(run: ChildRun, marker: string): T | undefined {
  const line = run.stdout.split('\n').find((candidate) => candidate.startsWith(`${marker} `));
  return line === undefined ? undefined : (JSON.parse(line.slice(marker.length + 1)) as T);
}

/** probe 子进程的锁卡点：'opened' 行在 error 前出现 = 打开期就绪、锁卡在 INSERT；缺行 = 打开期就报错。 */
function probeBusyAt(run: ChildRun): 'open' | 'insert' | 'n/a' {
  const opened = run.stdout.split('\n').some((candidate) => candidate.startsWith('opened '));
  if (!opened) return 'open';
  return run.stdout.split('\n').some((candidate) => candidate.startsWith('probe ') && /"error":\{/.test(candidate))
    ? 'insert'
    : 'n/a';
}

function rangeOrNone(values: readonly number[]): string {
  if (values.length === 0) return '(空)';
  return `${Math.min(...values)}..${Math.max(...values)}`;
}

async function fault4(): Promise<FaultOutcome> {
  const checks: CheckResult[] = [];
  const notes: string[] = [];
  const evidence: Array<Record<string, unknown>> = [];
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cap01-r7-f4-'));
  try {
    // F4a：双进程并发写（同 scopeKey 抢 op_seq / 同计数器抢 task_no）。
    const burstDir = path.join(tmpRoot, 'burst');
    mkdirSync(burstDir, { recursive: true });
    const burstDb = path.join(burstDir, 'state.db');
    const burstPayload = (childId: string): Record<string, unknown> => ({
      dbPath: burstDb,
      childId,
      iterations: 25,
      scope: F4_SCOPE,
      scopeKey: 'task:burst-shared',
    });
    const busyReportPromise = (async () => {
      for (let waited = 0; waited < 15_000 && !existsSync(burstDb); waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return spawnChild('busy-report', { dbPath: burstDb });
    })();
    const [burstARun, burstBRun, busyReportRun] = await Promise.all([
      spawnChild('burst', burstPayload('a')),
      spawnChild('burst', burstPayload('b')),
      busyReportPromise,
    ]);
    const resultA = parseChildJson<BurstResult>(burstARun, 'result');
    const resultB = parseChildJson<BurstResult>(burstBRun, 'result');
    const store = openTaskStore(burstDb);
    const tasks = store.listTasks({ principalId: F4_SCOPE.principalId, sessionId: F4_SCOPE.sessionId });
    const taskNoValues = tasks.map((stored) => stored.task.taskNo).filter((value): value is number => value !== undefined);
    const refs = store.listFileRefs(F4_SCOPE);
    const ops = store.listOperationCandidates({ scopeKey: 'task:burst-shared', operation: 'burst.op', attempt: 1 });
    const taskNos = taskNoValues;
    const duplicateTaskNos = [...new Set(taskNos.filter((value, index) => taskNos.indexOf(value) !== index))];
    const opSeqs = ops.map((op) => op.opSeq);
    const duplicateOpSeqs = [...new Set(opSeqs.filter((value, index) => opSeqs.indexOf(value) !== index))];
    const childrenOk = resultA !== undefined && resultB !== undefined;
    const reportedRefOk = (resultA?.refOk ?? 0) + (resultB?.refOk ?? 0);
    const reportedTaskOk = (resultA?.taskOk ?? 0) + (resultB?.taskOk ?? 0);
    const reportedMintOk = (resultA?.mintOk ?? 0) + (resultB?.mintOk ?? 0);
    const lostWrites = refs.length !== reportedRefOk || tasks.length !== reportedTaskOk || ops.length !== reportedMintOk;
    checks.push(check(
      'f4a.并发写零丢失（已报告成功的写必须落库）（红判据）',
      'criterion',
      childrenOk && !lostWrites,
      !childrenOk
        ? `burst 子进程异常：A exit=${burstARun.code}（${burstARun.stderr.slice(-200)}），B exit=${burstBRun.code}（${burstBRun.stderr.slice(-200)}）`
        : `两进程报告成功 task=${reportedTaskOk}/ref=${reportedRefOk}/op=${reportedMintOk}，库内实有 task=${tasks.length}/ref=${refs.length}/op=${ops.length}。`,
    ));
    checks.push(check(
      'f4a.跨进程编号不重复（task_no / op_seq）（红判据）',
      'criterion',
      childrenOk && duplicateTaskNos.length === 0 && duplicateOpSeqs.length === 0,
      `task_no 重复：[${duplicateTaskNos.join(', ') || '无'}]（范围 ${rangeOrNone(taskNos)}）；`
        + `op_seq 重复：[${duplicateOpSeqs.join(', ') || '无'}]（范围 ${rangeOrNone(opSeqs)}）。`,
    ));
    const burstErrors = [...(resultA?.errors ?? []), ...(resultB?.errors ?? [])];
    const lockErrors = burstErrors.filter((error) => error.code === 'SQLITE_BUSY' || /locked|busy/i.test(error.message));
    notes.push(burstErrors.length === 0
      ? `F4a 行为记录：两进程各 75 笔写（50 task/ref + 25 mint）全部成功、零报错——WAL + busy_timeout 下写请求串行化（排队等待，无锁错误）。`
      : `F4a 行为记录：共 ${burstErrors.length} 笔报错（锁相关 ${lockErrors.length}）：${burstErrors.slice(0, 8).map((error) => `${error.op}[${error.key}] ${error.code ?? ''} ${error.message.slice(0, 80)}`).join(' ; ')}${burstErrors.length > 8 ? ' …' : ''}——报错即该笔回滚不落库（记录为「报错」行为）。`);
    const busyInfo = parseChildJson<{ busyTimeoutMs: number; journalMode: string }>(busyReportRun, 'busy');
    if (busyInfo !== undefined) {
      notes.push(`库行为参数（better-sqlite3 缺省，实测只读连接）：busy_timeout=${busyInfo.busyTimeoutMs}ms、journal_mode=${busyInfo.journalMode}——两进程写锁冲突时先排队等 ≤${busyInfo.busyTimeoutMs}ms，超时报 SQLITE_BUSY。`);
      evidence.push({ step: 'busy-report', ...busyInfo });
    }
    evidence.push({
      step: 'f4a',
      childA: resultA,
      childB: resultB,
      dbRows: { tasks: tasks.length, refs: refs.length, ops: ops.length },
      duplicateTaskNos,
      duplicateOpSeqs,
      stderr: { a: burstARun.stderr.slice(-300), b: burstBRun.stderr.slice(-300) },
    });
    store.close();

    // F4b：长写锁（8s > busy_timeout 5s）→ 被阻塞方约 5s 后报错（锁/报错行为）。
    // 时序锚点：hold-lock 子进程在 BEGIN IMMEDIATE 拿到后打印 `locked`，父脚本看到才发起
    // 被阻塞方（消除 tsx 启动抖动导致的「锁已释放才写」假象）。
    const runLockScenario = async (dirName: string, holderFileId: string, probeFileId: string, holdMs: number): Promise<{ holder: ChildRun; probe: ChildRun; lockedAt: number | undefined }> => {
      const dir = path.join(tmpRoot, dirName);
      mkdirSync(dir, { recursive: true });
      const db = path.join(dir, 'state.db');
      let lockedAt: number | undefined;
      let resolveLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        resolveLocked = resolve;
      });
      const holderPromise = spawnChild('hold-lock', { dbPath: db, fileId: holderFileId, holdMs, scope: F4_SCOPE }, {
        onLine: (line) => {
          if (line.startsWith('locked ') && lockedAt === undefined) {
            lockedAt = Date.now();
            resolveLocked();
          }
        },
      });
      await locked;
      const probe = await spawnChild('probe-write', { dbPath: db, fileId: probeFileId, scope: F4_SCOPE });
      const holder = await holderPromise;
      return { holder, probe, lockedAt };
    };
    {
      const scenario = await runLockScenario('lock-busy', 'lock_holder_row', 'lock_probe_row', 8000);
      const probeResult = parseChildJson<ProbeResult>(scenario.probe, 'probe');
      const holderLine = scenario.holder.stdout.split('\n').find((candidate) => candidate.startsWith('held-done '));
      const verifyStore = openTaskStore(path.join(tmpRoot, 'lock-busy', 'state.db'));
      const rows = verifyStore.listFileRefs(F4_SCOPE);
      const lockRows = {
        holder: rows.some((row) => row.fileId === 'lock_holder_row'),
        probe: rows.some((row) => row.fileId === 'lock_probe_row'),
        total: rows.length,
      };
      verifyStore.close();
      checks.push(check(
        'f4b.持锁方提交的数据不因并发阻塞而丢失（红判据）',
        'criterion',
        holderLine !== undefined && lockRows.holder,
        holderLine === undefined
          ? `持锁子进程异常退出：${scenario.holder.stderr.slice(-200)}`
          : `持锁方 ${holderLine.slice('held-done '.length)}；锁内插入行在双方结束后仍在库=${lockRows.holder}。`,
      ));
      checks.push(check(
        'f4b.行状态与各方报告一致（无幽灵行/无丢失）',
        'criterion',
        lockRows.holder
          && (probeResult === undefined ? !lockRows.probe && scenario.probe.code !== 0 : probeResult.error !== undefined ? !lockRows.probe : lockRows.probe)
          && lockRows.total === (probeResult !== undefined && probeResult.error === undefined ? 2 : 1),
        `锁内行在库=${lockRows.holder}；被阻塞方 ${probeResult === undefined ? `无结果行（exit=${scenario.probe.code}）` : probeResult.error === undefined ? '报告成功' : `报错 ${probeResult.error.code ?? ''}`}，其行在库=${lockRows.probe}；总行数=${lockRows.total}。`,
      ));
      notes.push(probeResult === undefined
        ? `F4b 行为记录（锁超时报错）：持锁 8s（> busy_timeout 5s），被阻塞方 ${scenario.probe.code === 0 ? '成功' : `异常退出（exit=${scenario.probe.code}，stderr=${scenario.probe.stderr.slice(-160)}）`}。`
        : `F4b 行为记录（锁超时报错）：持锁 8s（> busy_timeout），被阻塞方总耗时 ${probeResult.elapsedMs}ms、锁卡点=${probeBusyAt(scenario.probe)}（open=打开底账期 / insert=写入期）、${probeResult.error === undefined ? '成功' : `报错 ${probeResult.error.code ?? ''}: ${probeResult.error.message}`}——busy_timeout 内排队、超时报 SQLITE_BUSY，报错方的写不落库（可重试）。`);
      notes.push('UNDEFINED：busy_timeout 数值与报错后的重试策略是 better-sqlite3 缺省（产品未显式设置/封装），设计稿无跨进程锁口径规定。');
      evidence.push({ step: 'f4b', probe: probeResult, probeBusyAt: probeBusyAt(scenario.probe), holderLine, lockRows, lockedAt: scenario.lockedAt, probeStderr: scenario.probe.stderr.slice(-300) });
    }
    // F4c：写锁 2.5s（< busy_timeout 5s）→ 被阻塞方排队等待后成功（重试面）。
    {
      const scenario = await runLockScenario('lock-wait', 'wait_holder_row', 'wait_probe_row', 2500);
      const probeResult2 = parseChildJson<ProbeResult>(scenario.probe, 'probe');
      const verifyStore2 = openTaskStore(path.join(tmpRoot, 'lock-wait', 'state.db'));
      const rows2 = verifyStore2.listFileRefs(F4_SCOPE);
      verifyStore2.close();
      checks.push(check(
        'f4c.busy_timeout 内的锁：等待后成功且行落库（重试行为）',
        'observation',
        probeResult2 !== undefined && probeResult2.error === undefined && rows2.some((row) => row.fileId === 'wait_probe_row'),
        probeResult2 === undefined
          ? `probe 子进程无结果行（exit=${scenario.probe.code}）`
          : `被阻塞方总耗时 ${probeResult2.elapsedMs}ms、${probeResult2.error === undefined ? '成功' : `报错 ${probeResult2.error.code ?? ''}`}，行已落库（共 ${rows2.length} 行）。`,
      ));
      notes.push(`F4c 行为记录（锁内排队重试）：持锁 2.5s（< busy_timeout），被阻塞方总耗时 ${probeResult2?.elapsedMs ?? '?'}ms、${probeResult2?.error === undefined ? '成功' : `报错 ${probeResult2.error.code ?? ''}`}——写请求在锁释放后自动继续，无需上层重试。`);
      evidence.push({ step: 'f4c', probe: probeResult2, lockedAt: scenario.lockedAt, rows: rows2.map((row) => row.fileId) });
    }
    return finalize({ fault: 'f4', status: 'PASS', red: false, checks, notes, evidence });
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

interface CliOptions {
  only: Set<string>;
  outDir: string;
  killFractions?: number[];
}

function parseCli(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    only: new Set(['f1', 'f2', 'f3', 'f4']),
    outDir: path.join(REPO_ROOT, '.runtime', 'eval-cap01-r7-faults', new Date().toISOString().replace(/[:.]/g, '-')),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--only' && argv[index + 1] !== undefined) {
      options.only = new Set((argv[index + 1] ?? '').split(',').map((item) => item.trim()).filter((item) => item !== ''));
      index += 1;
    } else if (arg === '--out-dir' && argv[index + 1] !== undefined) {
      options.outDir = path.resolve(argv[index + 1] ?? '');
      index += 1;
    } else if (arg === '--kill-fractions' && argv[index + 1] !== undefined) {
      options.killFractions = (argv[index + 1] ?? '')
        .split(',')
        .map((item) => Number(item.trim()))
        .filter((value) => Number.isFinite(value) && value > 0);
      index += 1;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  mkdirSync(cli.outDir, { recursive: true });
  const wants = (fault: string): boolean => cli.only.has(fault);
  console.log(`[cap01-r7] mode=scripted（真模型 0 次，预算 0/24）only=${[...cli.only].join(',')} outDir=${cli.outDir}`);
  const outcomes: FaultOutcome[] = [];
  if (wants('f1')) outcomes.push(await fault1(cli.outDir, cli.killFractions ?? [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.95, 1.08]));
  if (wants('f2')) outcomes.push(await fault2());
  if (wants('f3')) outcomes.push(await fault3());
  if (wants('f4')) outcomes.push(await fault4());
  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'scripted',
    modelCalls: 0,
    callBudgetMax: 24,
    faults: Object.fromEntries(outcomes.map((outcome) => [
      outcome.fault,
      { status: outcome.status, red: outcome.red, checks: outcome.checks, notes: outcome.notes, evidence: outcome.evidence },
    ])),
  };
  const summaryPath = path.join(cli.outDir, 'summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  for (const outcome of outcomes) {
    console.log(`[cap01-r7] ${outcome.fault}=${outcome.status}${outcome.red ? '（红）' : ''}`);
    for (const item of outcome.checks) {
      console.log(`[cap01-r7]   ${item.status} (${item.kind}) ${item.name} — ${item.detail}`);
    }
    for (const note of outcome.notes) {
      console.log(`[cap01-r7]   note: ${note}`);
    }
  }
  console.log(`[cap01-r7] 汇总=${summaryPath}`);
  if (outcomes.some((outcome) => outcome.red)) process.exitCode = 1;
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error('[cap01-r7] 入口失败：', error);
    process.exitCode = 1;
  });
}
