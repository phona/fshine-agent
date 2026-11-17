/**
 * CAP-01 R3b 攻击面加厚验收（全脚本化；真模型只属 R2，本脚本 0 次 LLM 调用）。
 *
 * 口径（docs/product/cap01-main-direct-execution.md v8 §3/§11）：只验安全不变量与用户可见
 * 结果；全样本保留，不筛绿；失败样本连证据一起落盘；判据来自设计稿与现有单测的机械语义，
 * 设计稿没写清的行为一律记 UNDEFINED/观察项，不发明判据。owner 裁决（v8 §11）：网络未阻断
 * 已接受、防护=基础防护（权限模型+进程组 kill+截断+产物校验+最小 env）、run_js 对业务用户开放。
 *
 * 七类攻击（run_js 执行器端到端：真实受限子进程 + 真实登记面）：
 *   a1 路径穿越：脚本写 `out/../escape`、`out/../../escape2`、`scratch/../../../escape3`、
 *      `scratch/`+8×`../`+`escape7`（穿出夹具根直达用户家目录一侧）、rename `out/bye.txt`→
 *      `../escape4`、fd append `out/../escape6`、mkdir `out/../escape-dir`。判据：每个穿越形
 *      写入/改名/建目录都被拒（ERR_ACCESS_DENIED），磁盘全树无 escape 文件、夹具根顶层不变、
 *      穿出夹具根的目标路径不存在；授权内的 `out/./x`、`out/sub/../x`、scratch→out rename 照常
 *      （out/ 仍是交付箱）。产物名带 `../`：登记名来自 readdir，机械上不可能出现 `..` 分量——
 *      按不变量断言（a1-registered-names-no-traversal-component）。
 *   a2 文件名 shell 元字符 `$(id)`、反引号、单/双引号、`*?`、换行、嵌套目录同名、255 字节整名
 *      与 300 字节超长名。判据：能落盘的名字原样登记（name 保真）、存储位一律 fileId 派生
 *      （files/ 下不允许出现原名形文件）、字节回读一致；超长名行为（ENAMETOOLONG 与否）如实
 *      记录，判据只锁「子进程优雅处理 + 宿主不受影响 + 落盘成功 ⇔ 登记一致」。
 *   a3 out/ 预植指向 /etc 的目录符号链接（+文件符号链接）：登记面必须拒收 symlink（含 symlink
 *      目录不递归——连 skipped 都不得出现其内部条目），/etc 内容不得成为产物行；子进程自建
 *      symlink/hardlink 必须被拒（ERR_ACCESS_DENIED）。观察项（如实记录，不判红）：Node 权限
 *      模型读检查不解析 symlink——预植符号链接存在时子进程可穿透读 /etc/passwd（用与执行器
 *      同 argv 形状的直测取证）；可达性依赖「子进程无法自建 symlink」这道门 + 宿主不植链，
 *      属 v8 §3「不是沙箱」的如实残余面。
 *   a4 凭据隔离：脚本读 process.env 与 /proc/self/environ。判据：子进程 env 键集合恰为
 *      {PATH, HOME, TMPDIR, NODE_PATH}（fail-closed 白名单 worker-env.ts:27 + 执行器覆写
 *      HOME/TMPDIR、加 NODE_PATH）；无任何 LLM_ 前缀/WECOM_ 前缀/AGENT_CONFIG_PATH/DB_PATH 键名；
 *      夹具哨兵值与本进程真实敏感族值不得出现在子进程可见面；HOME/TMPDIR 指向 run 目录；
 *      真实 HOME 值不得出现在任何非 PATH env 值（PATH 继承含家目录路径是设计登记面——记
 *      观察项，不算红）；/proc/self/environ 拒读，若未来可读则内容必须过同一套值扫描。
 *   a5 fork bomb（4 层递归子进程）：判据：spawn 全部形状（spawnSync/spawn/exec）在层 1 即被拒
 *      （ERR_ACCESS_DENIED，v8 §3 实测）→ 炸弹无法起步；无论哪条分支（被拒自然退出 / 若未来
 *      spawn 可用则超时组杀），ps 全表无本 run 残留。另做机制侧深树实测（a5b）：与执行器同形
 *      的 detached 父 + 4 层非 detached 递归子进程，killRunProcessGroup 后 4 个 pid 全死、
 *      ps 按 argv marker 扫描无残留。
 *   a6 内存：① Buffer.alloc(2GB)（外部内存，不经 V8 堆）→ 判据：宿主不被带走（执行器按期
 *      返回、后续 run 正常）；子进程实际 RSS 如实记录。② V8 堆越过 512MB（逐页触碰的真实
 *      分配）→ 判据：堆上限生效（非零退出/SIGABRT/子进程自报 capped 三者其一）+ 宿主存活。
 *      观察：--max-old-space-size 只封 V8 堆，Buffer 外部内存不在封顶内（设计 §3 只声明 V8 堆）。
 *   a7 两次 run_js 并发写同名产物：判据：两次都成功、runDir 互异、fileId 互异、各自字节与
 *      自己的标记一致（无交叉污染）。同名产物在登记面共存（2 行同名）→ UNDEFINED：设计稿
 *      （v8 §2/§7）未定义交付面同名展示/改名规则，登记为开放决定，不自主判红。
 *
 * 运行：
 *   node --import tsx scripts/eval/cap01/r3b-attacks.ts [--attack a1,a2,...] [--out-dir <dir>]
 * 缺省 out-dir = .runtime/eval-cap01-r3b/<时间戳>（.runtime 不进 git）。
 * 退出码：0 = 全过；1 = 任一 FAIL。
 */
import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openTaskStore } from '@fshine/core';
import {
  createFileStore,
  fileStoragePathOf,
  principalHashOf,
  sessionHashOf,
  type FileStore,
} from '../../../packages/agent/src/file-store';
import {
  createRunJsExecutor,
  killRunProcessGroup,
  RUN_JS_MAX_OUTPUT_COUNT,
  RUN_JS_MAX_OUTPUT_FILE_BYTES,
  type RunJsExecutor,
} from '../../../packages/agent/src/run-js-executor';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');
const REAL_HOME = os.homedir();

// ── 哨兵凭据：执行器从本进程 env 重建子进程 env——先注入哨兵再跑攻击，泄漏面才真的有靶子 ──
const SECRET_SENTINELS: ReadonlyArray<readonly [string, string]> = [
  ['LLM_API_KEY', 'r3b-sentinel-llm-key-do-not-leak'],
  ['LLM_MODEL', 'r3b-sentinel-model'],
  ['WECOM_CORP_SECRET', 'r3b-sentinel-wecom-secret-do-not-leak'],
  ['AGENT_CONFIG_PATH', 'r3b-sentinel-agent-config-path'],
  ['DB_PATH', 'r3b-sentinel-db-path'],
];
for (const [key, value] of SECRET_SENTINELS) process.env[key] = value;
/** 本进程 env 里全部敏感族（哨兵 + 可能真实存在的 LLM_ 前缀与 WECOM_ 前缀键）——子进程可见面禁止出现。 */
const SECRET_SURFACE = Object.entries(process.env).filter(
  ([key, value]) => value !== undefined && /^(LLM_|WECOM_|AGENT_CONFIG_PATH|DB_PATH)/.test(key),
) as ReadonlyArray<readonly [string, string]>;
const SECRET_VALUES = SECRET_SURFACE.map(([, value]) => value).filter((value) => value.length >= 8);
const SECRET_KEY_NAMES = SECRET_SURFACE.map(([key]) => key);

const SCOPE = { principalId: 'wecom:r3b-attacker', sessionId: 'cap01-r3b' };

// ── 断言收集 ────────────────────────────────────────────────────────────────

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

class Checks {
  readonly list: Check[] = [];

  check(name: string, pass: boolean, detail: string): void {
    this.list.push({ name, pass, detail });
  }

  get allPassed(): boolean {
    return this.list.every((entry) => entry.pass);
  }
}

interface AttackOutcome {
  attack: string;
  status: 'pass' | 'fail';
  checks: Check[];
  notes: string[];
  error?: string;
  evidence: unknown;
  evidencePath?: string;
}

type AttackPartial = Omit<AttackOutcome, 'status' | 'evidencePath'>;

// ── 夹具 ────────────────────────────────────────────────────────────────────

interface Fixture {
  fixtureRoot: string;
  workspaceRoot: string;
  store: ReturnType<typeof openTaskStore>;
  fileStore: FileStore;
  executor: RunJsExecutor;
}

function makeFixture(timeoutMs?: number): Fixture {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'r3b-attacks-'));
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  const store = openTaskStore(':memory:');
  const fileStore = createFileStore({ store, workspaceRoot });
  const executor = createRunJsExecutor({
    fileStore,
    nodeModulesDir: NODE_MODULES,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { fixtureRoot, workspaceRoot, store, fileStore, executor };
}

/** 会话 files/ 目录（布局派生，与 file-store 同一公式）。 */
function filesDirOf(workspaceRoot: string): string {
  return path.join(workspaceRoot, principalHashOf(SCOPE.principalId), sessionHashOf(SCOPE.sessionId), 'files');
}

/** 目录递归（lstat 语义，不跟 symlink）。 */
function walkDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      found.push(abs);
      if (entry.isDirectory()) walk(abs);
    }
  };
  walk(root);
  return found;
}

async function psTable(): Promise<string> {
  const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,args=']);
  return stdout;
}

function psResidueCount(table: string, marker: string): string[] {
  return table.split('\n').filter((line) => line.includes(marker));
}

function redact(text: string): string {
  let output = text;
  for (const value of SECRET_VALUES) output = output.split(value).join('<r3b-redacted>');
  return output;
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待文件超时：${filePath}`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ProbeAttempt {
  label: string;
  /** true = 该尝试是穿越/逃逸形（宿主按「必须被拒」断言）；false = 授权内行为自检。 */
  escape?: boolean;
  ok: boolean;
  code?: string;
  result?: string;
}

/** 子进程探针骨架：t(label, escape, fn) 逐条记录成败；probe.json 回带宿主断言。 */
function probeScript(attemptsSource: string, probeFile: string, epilogue: string): string {
  return [
    `const fs = require('node:fs');`,
    `const path = require('node:path');`,
    `const out = [];`,
    `function t(label, escape, fn) { try { const r = fn(); out.push({ label, escape, ok: true, result: String(r).slice(0, 60) }); } catch (e) { out.push({ label, escape, ok: false, code: e.code ?? String(e).slice(0, 60) }); } }`,
    attemptsSource,
    `fs.writeFileSync('out/${probeFile}', JSON.stringify(out, null, 2));`,
    epilogue,
  ].join('\n');
}

// ── a1 路径穿越 ─────────────────────────────────────────────────────────────

async function attackA1(): Promise<AttackPartial> {
  const checks = new Checks();
  const notes: string[] = [];
  const fixture = makeFixture();
  const { fixtureRoot, executor } = fixture;

  const attempts: ReadonlyArray<readonly [string, boolean, string]> = [
    ['write out/../escape', true, `() => { fs.writeFileSync('out/../escape', 'escape-a'); return 'written'; }`],
    ['write out/../../escape2', true, `() => { fs.writeFileSync('out/../../escape2', 'escape-b'); return 'written'; }`],
    ['write scratch/../../../escape3', true, `() => { fs.writeFileSync('scratch/../../../escape3', 'escape-c'); return 'written'; }`],
    ['write scratch/+8x../escape7（穿出夹具根）', true, `() => { fs.writeFileSync('scratch/' + '../'.repeat(8) + 'escape7', 'escape-d'); return 'written'; }`],
    ['rename out/bye.txt -> ../escape4', true, `() => { fs.writeFileSync('out/bye.txt', 'bye'); fs.renameSync('out/bye.txt', '../escape4'); return 'renamed'; }`],
    ['fd-append out/../escape6', true, `() => { const fd = fs.openSync('out/../escape6', 'a'); fs.writeSync(fd, 'x'); fs.closeSync(fd); return 'written'; }`],
    ['mkdir out/../escape-dir', true, `() => { fs.mkdirSync('out/../escape-dir'); return 'created'; }`],
    ['write inside out: out/./ok2.txt', false, `() => { fs.writeFileSync('out/./ok2.txt', 'ok2'); return 'written'; }`],
    ['write inside out: out/sub/../ok.txt', false, `() => { fs.mkdirSync('out/sub'); fs.writeFileSync('out/sub/../ok.txt', 'inner-ok'); return 'written'; }`],
    ['rename scratch/mid.txt -> out/renamed.txt', false, `() => { fs.writeFileSync('scratch/mid.txt', 'mid'); fs.renameSync('scratch/mid.txt', 'out/renamed.txt'); return 'renamed'; }`],
  ];

  const attemptsSource = attempts
    .map(([label, escape, fn]) => `t(${JSON.stringify(label)}, ${JSON.stringify(escape)}, ${fn});`)
    .join('\n');
  const code = probeScript(
    attemptsSource,
    'probe.json',
    `console.log('denied=' + out.filter(x => !x.ok).length + '/total=' + out.length);`,
  );

  const result = await executor.runJs({ code, scope: SCOPE });
  const probePath = path.join(result.audit.runDir, 'out', 'probe.json');
  const probe: ProbeAttempt[] = existsSync(probePath) ? JSON.parse(readFileSync(probePath, 'utf8')) as ProbeAttempt[] : [];

  const escapeAttempts = probe.filter((entry) => entry.escape === true);
  const denied = escapeAttempts.filter((entry) => !entry.ok && entry.code === 'ERR_ACCESS_DENIED');
  checks.check(
    'a1-traversal-write-denied',
    escapeAttempts.length === 7 && denied.length === escapeAttempts.length,
    `穿越形尝试 ${escapeAttempts.length}/7，被拒（ERR_ACCESS_DENIED）${denied.length} 个；明细：${JSON.stringify(escapeAttempts)}`,
  );
  const insideAttempts = probe.filter((entry) => entry.escape === false);
  checks.check(
    'a1-inside-granted-writes-ok',
    insideAttempts.length === 3 && insideAttempts.every((entry) => entry.ok),
    `授权内写入 ${insideAttempts.length}/3 成功（夹具形状自检；失败=攻击脚本形状跑错）：${JSON.stringify(insideAttempts)}`,
  );

  // 磁盘全树：夹具根下只允许 workspace/；任何层级不得出现 escape 名；穿出夹具根的目标不存在。
  const tree = walkDirs(fixtureRoot);
  const workspaceRootAbs = path.join(fixtureRoot, 'workspace');
  const outsideWorkspace = tree.filter(
    (abs) => abs !== workspaceRootAbs && !abs.startsWith(workspaceRootAbs + path.sep),
  );
  const escapeFiles = tree.filter((abs) => path.basename(abs).includes('escape'));
  const escape7Target = path.resolve(result.audit.runDir, 'scratch', ...Array<string>(8).fill('..'), 'escape7');
  checks.check(
    'a1-no-escape-files-on-disk',
    outsideWorkspace.length === 0 && escapeFiles.length === 0
      && !existsSync(escape7Target) && readdirSync(fixtureRoot).length === 1,
    `夹具根顶层=${JSON.stringify(readdirSync(fixtureRoot))}；workspace 外条目=${outsideWorkspace.length}；树内 escape 名=${escapeFiles.length}；穿出夹具根目标 ${escape7Target} 存在=${existsSync(escape7Target)}`,
  );

  const registeredNames = result.outputs.map((file) => file.name);
  checks.check(
    'a1-out-is-delivery-box-despite-attacks',
    registeredNames.includes('probe.json') && registeredNames.includes('bye.txt') && registeredNames.includes('ok2.txt')
      && registeredNames.includes('ok.txt') && registeredNames.includes('renamed.txt'),
    `登记产物=${JSON.stringify(registeredNames)}（穿越被拒后 out/ 照常是交付箱；scratch→out 的 rename 照常登记）`,
  );
  checks.check(
    'a1-registered-names-no-traversal-component',
    registeredNames.every((name) => name.split('/').every((part) => part !== '..' && part !== '.')),
    `登记名无 .. /. 分量：${JSON.stringify(registeredNames)}`,
  );

  notes.push('产物名带 ../ 的到达路径：登记名来自 readdir 逐项（file-store.ts collectCandidates），文件系统层不可能出现 `..` 分量；不变量由 a1-registered-names-no-traversal-component 钉住。');
  const evidence = {
    runDir: result.audit.runDir,
    exitCode: result.exitCode,
    exitSignal: result.exitSignal,
    killReason: result.audit.killReason ?? null,
    stdout: result.stdout,
    stderr: redact(result.stderr).slice(0, 4000),
    probe,
    registeredNames,
    skippedOutputs: result.audit.skippedOutputs,
    treeEscapeNames: escapeFiles,
    outsideWorkspace,
    escape7Target,
  };
  rmSync(fixtureRoot, { recursive: true, force: true });
  return { attack: 'a1', checks: checks.list, notes, evidence };
}

// ── a2 文件名 shell 元字符 / 换行 / 超长 ────────────────────────────────────

async function attackA2(): Promise<AttackPartial> {
  const checks = new Checks();
  const notes: string[] = [];
  const fixture = makeFixture();
  const { workspaceRoot, store, executor } = fixture;

  const metaNames: readonly string[] = ['$(id).txt', '`id`.txt', "quote'sq.txt", 'quote"dq.txt', 'p*q?.txt', 'a\nb.txt', '$(id)_dir/$(id).txt'];
  const metaMarkers = metaNames.map((_, index) => `marker-a2-${index}`);
  const long255 = 'A'.repeat(251) + '.txt'; // 恰 255 字节（ext4 每分量上限内）
  const long300 = 'A'.repeat(296) + '.txt'; // 300 字节（预期 ENAMETOOLONG，行为如实记录）

  const attemptsSource = [
    ...metaNames.map((name, index) =>
      `t(${JSON.stringify(`write ${JSON.stringify(name)}`)}, false, () => { fs.mkdirSync(path.dirname('out/' + ${JSON.stringify(name)}), { recursive: true }); fs.writeFileSync('out/' + ${JSON.stringify(name)}, ${JSON.stringify(metaMarkers[index])}); return 'written'; });`),
    `t('write 255B name', false, () => { fs.writeFileSync('out/' + ${JSON.stringify(long255)}, 'long255'); return 'written'; });`,
    `t('write 300B name', false, () => { fs.writeFileSync('out/' + ${JSON.stringify(long300)}, 'long300'); return 'written'; });`,
  ].join('\n');
  const code = probeScript(attemptsSource, 'probe.json', `console.log('ok=' + out.filter(x => x.ok).length + '/total=' + out.length);`);

  const result = await executor.runJs({ code, scope: SCOPE });
  const probePath = path.join(result.audit.runDir, 'out', 'probe.json');
  const probe: ProbeAttempt[] = existsSync(probePath) ? JSON.parse(readFileSync(probePath, 'utf8')) as ProbeAttempt[] : [];

  checks.check(
    'a2-child-graceful',
    result.exitCode === 0 && result.audit.killReason === undefined && probe.length === metaNames.length + 2,
    `子进程 exit=${result.exitCode}，killReason=${result.audit.killReason ?? '无'}，探针=${probe.length}/${metaNames.length + 2}（怪名不得炸掉子进程/宿主）`,
  );

  const registered = result.outputs;
  const byName = new Map(registered.map((file) => [file.name, file] as const));
  const missingMeta = metaNames.filter((name) => !byName.has(name));
  checks.check(
    'a2-metachar-names-registered-verbatim',
    missingMeta.length === 0 && byName.has('probe.json'),
    `元字符名逐个登记：缺=${JSON.stringify(missingMeta)}；全部登记名=${JSON.stringify(registered.map((file) => file.name))}`,
  );

  // 存储位一律 fileId 派生：files/ 下不允许出现原名形文件；登记名不用于拼路径。
  const fileDirEntries = readdirSync(filesDirOf(workspaceRoot));
  const rawNameLeaks = fileDirEntries.filter((entry) => !/^file_[0-9a-f]{32}(\.[A-Za-z0-9]{1,16})?$/.test(entry));
  checks.check(
    'a2-storage-path-is-fileid-derived',
    rawNameLeaks.length === 0,
    `files/ 共 ${fileDirEntries.length} 个文件，非 fileId 形=${rawNameLeaks.length}：${JSON.stringify(rawNameLeaks.slice(0, 6))}`,
  );

  // 字节回读一致（每个登记产物 = 自己的标记）+ 存储位 = fileId + 安全扩展名。
  const mismatches: string[] = [];
  for (let index = 0; index < metaNames.length; index += 1) {
    const name = metaNames[index]!;
    const file = byName.get(name);
    if (file === undefined) continue;
    const storage = fileStoragePathOf(workspaceRoot, SCOPE, file.fileId, name);
    const bytes = readFileSync(storage, 'utf8');
    if (bytes !== metaMarkers[index]) mismatches.push(`${JSON.stringify(name)}:内容不符 expected=${JSON.stringify(metaMarkers[index])} actual=${JSON.stringify(bytes)} hex=${readFileSync(storage).subarray(0, 12).toString('hex')}`);
    const expectedBase = `${file.fileId}${/(\.[A-Za-z0-9]{1,16})$/.exec(name)?.[1] ?? ''}`;
    if (path.basename(storage) !== expectedBase) mismatches.push(`${JSON.stringify(name)}:存储位非 fileId 派生`);
  }
  checks.check(
    'a2-content-roundtrip-and-storage',
    mismatches.length === 0,
    mismatches.length === 0
      ? `全部 ${metaNames.length} 个元字符名产物字节回读一致且存储位 fileId 派生`
      : JSON.stringify(mismatches),
  );

  // 255/300 字节名的实际行为（OS 边界）：只锁「优雅处理 + 落盘成功 ⇔ 登记一致」，长度本身如实记录。
  const p255 = probe.find((entry) => entry.label === 'write "255B name"' || entry.label.includes('255B'));
  const p300 = probe.find((entry) => entry.label.includes('300B'));
  const reg255 = byName.has(long255);
  const reg300 = byName.has(long300);
  const consistent255 = (p255?.ok === true) === reg255;
  const consistent300 = (p300?.ok === true) === reg300;
  checks.check(
    'a2-long-name-graceful-and-consistent',
    consistent255 && consistent300,
    `255B 名：子进程 ok=${p255?.ok ?? '?'} 登记=${reg255}；300B 名：子进程 ok=${p300?.ok ?? '?'}（code=${p300?.code ?? '-'}）登记=${reg300}；「落盘成功 ⇔ 登记一致」255=${consistent255} 300=${consistent300}`,
  );
  notes.push(`UNDEFINED：255/300 字节名的接受边界是 OS/文件系统行为（本机实测 255B ok=${String(p255?.ok)}、300B code=${p300?.code ?? '-'}）；设计稿未定义产物名长度规则，只按「落盘成功 ⇔ 登记一致」判。`);
  notes.push('UNDEFINED：同名/怪名在交付面（渠道展示、下载文件名）如何呈现，设计稿未定义；本 eval 不接渠道，只验登记面。');

  const evidence = {
    runDir: result.audit.runDir,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: redact(result.stderr).slice(0, 2000),
    probe,
    registered: registered.map((file) => ({ name: file.name, fileId: file.fileId, bytes: file.bytes })),
    filesDirSample: fileDirEntries.slice(0, 10),
  };
  rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  store.close();
  return { attack: 'a2', checks: checks.list, notes, evidence };
}

// ── a3 out/ 预植 /etc 符号链接 ──────────────────────────────────────────────

async function attackA3(): Promise<AttackPartial> {
  const checks = new Checks();
  const notes: string[] = [];
  const fixture = makeFixture();
  const { store, executor, fileStore } = fixture;

  // ① 执行器端到端：子进程自建 symlink/hardlink 必须被拒（权限模型无 --allow-symlink）。
  const selfProbe = await executor.runJs({
    code: probeScript(
      [
        `t('symlink out/etcdir2 -> /etc（自建）', true, () => { fs.symlinkSync('/etc', 'out/etcdir2'); return 'created'; });`,
        `t('hardlink out/hardpw -> /etc/passwd（自建）', true, () => { fs.linkSync('/etc/passwd', 'out/hardpw'); return 'created'; });`,
        `t('普通文件照常', false, () => { fs.writeFileSync('out/placeholder.txt', 'p'); return 'written'; });`,
      ].join('\n'),
      'probe.json',
      `console.log('probe-done');`,
    ),
    scope: SCOPE,
  });
  const selfProbePath = path.join(selfProbe.audit.runDir, 'out', 'probe.json');
  const selfProbeData: ProbeAttempt[] = existsSync(selfProbePath)
    ? JSON.parse(readFileSync(selfProbePath, 'utf8')) as ProbeAttempt[]
    : [];
  const selfLink = selfProbeData.filter((entry) => entry.label.includes('自建'));
  checks.check(
    'a3-child-cannot-create-links',
    selfLink.length === 2 && selfLink.every((entry) => !entry.ok && entry.code === 'ERR_ACCESS_DENIED'),
    `子进程自建 symlink/hardlink：${JSON.stringify(selfLink)}（都须 ERR_ACCESS_DENIED——这是「预植 symlink 不可达」的那道门）`,
  );

  // ② 预植（宿主侧，模拟「symlink 已经出现在 out/」的威胁面）→ 走执行器同一登记函数。
  const outDir = path.join(selfProbe.audit.runDir, 'out');
  symlinkSync('/etc', path.join(outDir, 'etcdir'));
  symlinkSync('/etc/passwd', path.join(outDir, 'pwlink'));
  const { outputs, skipped } = fileStore.registerOutputsFromOut({
    runDir: selfProbe.audit.runDir,
    scope: SCOPE,
    limits: { maxFileBytes: RUN_JS_MAX_OUTPUT_FILE_BYTES, maxCount: RUN_JS_MAX_OUTPUT_COUNT },
  });
  const skippedNames = new Map(skipped.map((entry) => [entry.name, entry.reason]));
  checks.check(
    'a3-registration-rejects-symlinks',
    skippedNames.get('etcdir') === 'symlink' && skippedNames.get('pwlink') === 'symlink',
    `登记拒收：skipped=${JSON.stringify(skipped)}（预植 etcdir/pwlink 都须 reason=symlink）`,
  );
  const outputNames = outputs.map((file) => file.name);
  const symlinkLeaks = outputNames.filter((name) => name === 'etcdir' || name === 'pwlink' || name.startsWith('etcdir/'));
  const noRecursion = skipped.every((entry) => !entry.name.startsWith('etcdir/'));
  checks.check(
    'a3-no-symlink-entries-registered',
    symlinkLeaks.length === 0 && noRecursion && outputNames.includes('placeholder.txt'),
    `登记产物=${JSON.stringify(outputNames)}；symlink 目录不递归（skipped 无 etcdir/ 内部条目）=${noRecursion}`,
  );
  const rows = store.listFileRefs(SCOPE);
  const etcRows = rows.filter((row) => row.name.includes('passwd') || row.name.includes('etcdir'));
  checks.check(
    'a3-no-etc-derived-rows',
    etcRows.length === 0 && !existsSync('/etc/pwned-by-r3b'),
    `file_refs 含 passwd/etcdir 名行=${etcRows.length}；/etc/pwned-by-r3b 存在=${existsSync('/etc/pwned-by-r3b')}`,
  );

  // ③ 观察项取证：与执行器同 argv 形状的权限模型直测——预植 symlink 存在时读穿透行为。
  const probeRun = mkdtempSync(path.join(os.tmpdir(), 'r3b-symprobe-'));
  const runDir = path.join(probeRun, 'run');
  mkdirSync(path.join(runDir, 'out'), { recursive: true });
  symlinkSync('/etc', path.join(runDir, 'out', 'etcdir'));
  symlinkSync('/etc/passwd', path.join(runDir, 'out', 'pwlink'));
  writeFileSync(
    path.join(runDir, 'run.cjs'),
    probeScript(
      [
        `t('read via 预植 etcdir/passwd', true, () => fs.readFileSync('out/etcdir/passwd', 'utf8').length);`,
        `t('read via 预植 pwlink', true, () => fs.readFileSync('out/pwlink', 'utf8').length);`,
        `t('copy 预植 pwlink -> out/leak.txt', true, () => { fs.copyFileSync('out/pwlink', 'out/leak.txt'); return 'copied'; });`,
        `t('write through 预植 etcdir -> /etc/pwned-by-r3b', true, () => { fs.writeFileSync('out/etcdir/pwned-by-r3b', 'x'); return 'written'; });`,
      ].join('\n'),
      'probe.json',
      `console.log('probe-done');`,
    ),
    { mode: 0o600 },
  );
  const { execFileSync } = await import('node:child_process');
  let symProbeStderr = '';
  try {
    execFileSync(
      process.execPath,
      [
        '--permission',
        `--allow-fs-read=${runDir}`,
        `--allow-fs-read=${NODE_MODULES}`,
        `--allow-fs-write=${path.join(runDir, 'out')}`,
        `--allow-fs-write=${path.join(runDir, 'scratch')}`,
        `--max-old-space-size=512`,
        path.join(runDir, 'run.cjs'),
      ],
      { cwd: runDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    symProbeStderr = error instanceof Error ? String(error.message).slice(0, 500) : String(error);
  }
  const symProbePath = path.join(runDir, 'out', 'probe.json');
  const symProbe: ProbeAttempt[] = existsSync(symProbePath)
    ? JSON.parse(readFileSync(symProbePath, 'utf8')) as ProbeAttempt[]
    : [];
  const readThrough = symProbe.filter((entry) => entry.label.startsWith('read via'));
  const leakCopy = symProbe.find((entry) => entry.label.includes('leak.txt'));
  const writeThrough = symProbe.find((entry) => entry.label.includes('write through'));
  notes.push(
    `观察项（不判红）：权限模型读检查不解析 symlink——预植符号链接存在时子进程可穿透读 /etc/passwd`
    + `（直测 read 结果=${JSON.stringify(readThrough)}；copy→out/leak.txt=${leakCopy ? (leakCopy.ok ? '成功，作为普通产物可登记' : String(leakCopy.code)) : '?'}；`
    + `write through → /etc/pwned=${writeThrough ? (writeThrough.ok ? '成功' : String(writeThrough.code)) : '?'}）。`
    + `可达性依赖两道门：子进程无法自建 symlink（a3-child-cannot-create-links 锁定）+ 宿主不植链；`
    + `登记面拒收 symlink（a3-registration-rejects-symlinks 锁定）。属 v8 §3「不是沙箱」的如实残余面。`,
  );

  const evidence = {
    runDir: selfProbe.audit.runDir,
    selfProbeExit: selfProbe.exitCode,
    selfProbe,
    outputs,
    skipped,
    rowNames: rows.map((row) => row.name),
    symProbe,
    symProbeStderr: redact(symProbeStderr),
    etcPwnedExists: existsSync('/etc/pwned-by-r3b'),
  };
  rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  rmSync(probeRun, { recursive: true, force: true });
  store.close();
  return { attack: 'a3', checks: checks.list, notes, evidence };
}

// ── a4 凭据隔离（env 与 /proc/self/environ）────────────────────────────────

async function attackA4(): Promise<AttackPartial> {
  const checks = new Checks();
  const notes: string[] = [];
  const fixture = makeFixture();
  const { store, executor } = fixture;

  const code = [
    `const fs = require('node:fs');`,
    `const envJson = JSON.stringify(process.env, null, 2);`,
    `fs.writeFileSync('out/env.json', envJson);`,
    `const out = [];`,
    `function t(label, fn) { try { const r = fn(); out.push({ label, ok: true, result: String(r).slice(0, 80) }); } catch (e) { out.push({ label, ok: false, code: e.code ?? String(e).slice(0, 60) }); } }`,
    `t('read /proc/self/environ', () => { const b = fs.readFileSync('/proc/self/environ'); fs.writeFileSync('out/environ-dump.txt', b); return b.length; });`,
    `t('read /proc/self/cwd (目录读)', () => fs.readdirSync('/proc/self/cwd').length);`,
    `t('process.cwd()', () => process.cwd());`,
    `fs.writeFileSync('out/proc-probe.json', JSON.stringify(out, null, 2));`,
    `console.log('env-keys=' + Object.keys(process.env).sort().join(','));`,
  ].join('\n');
  const result = await executor.runJs({ code, scope: SCOPE });

  const envPath = path.join(result.audit.runDir, 'out', 'env.json');
  const childEnv: Record<string, string> = existsSync(envPath)
    ? JSON.parse(readFileSync(envPath, 'utf8')) as Record<string, string>
    : {};
  const childKeys = Object.keys(childEnv).sort();
  const expectedKeys = ('PATH' in process.env
    ? ['HOME', 'NODE_PATH', 'PATH', 'TMPDIR']
    : ['HOME', 'NODE_PATH', 'TMPDIR']).sort();
  checks.check(
    'a4-env-keyset-exact',
    JSON.stringify(childKeys) === JSON.stringify(expectedKeys),
    `子进程 env 键=${JSON.stringify(childKeys)}；白名单期望=${JSON.stringify(expectedKeys)}（worker-env.ts:27 fail-closed + 执行器覆写 HOME/TMPDIR、加 NODE_PATH）`,
  );

  const envText = JSON.stringify(childEnv);
  const keyHits = childKeys.filter(
    (key) => /^(LLM_|WECOM_)/.test(key) || key.startsWith('AGENT_CONFIG_PATH') || key === 'DB_PATH',
  );
  const valueHits = SECRET_VALUES.filter((value) => envText.includes(value));
  checks.check(
    'a4-no-llm-wecom-secrets',
    keyHits.length === 0 && valueHits.length === 0,
    `LLM_*/WECOM_*/AGENT_*/DB_PATH 键命中=${JSON.stringify(keyHits)}；哨兵/真实敏感值命中=${valueHits.length === 0 ? '0' : `${valueHits.length} 个（已脱敏不落证据）`}`,
  );

  const runHome = path.join(result.audit.runDir, 'home');
  const runTmp = path.join(result.audit.runDir, 'tmp');
  checks.check(
    'a4-home-tmpdir-point-into-run-dir',
    childEnv['HOME'] === runHome && childEnv['TMPDIR'] === runTmp,
    `HOME=${childEnv['HOME'] ?? '(缺)'} 期望=${runHome}；TMPDIR=${childEnv['TMPDIR'] ?? '(缺)'} 期望=${runTmp}（真实 HOME=${REAL_HOME} 不得作为 HOME）`,
  );

  // 真实 HOME 泄漏判据：非 PATH 的 env 值里，凡含真实 HOME 路径又不在「设计登记的落点」上的
  // （run 目录指针 = 执行器覆写的 HOME/TMPDIR；repo 根 = 执行器注入的 NODE_PATH）都算泄漏。
  // 值恰好等于真实 HOME 本身（HOME=真实家目录原值）在任何键上都算泄漏。
  const sanctionedPrefixes = [result.audit.runDir, REPO_ROOT];
  const homeLeaks = Object.entries(childEnv).filter(([key, value]) => {
    if (key === 'PATH') return false;
    if (value === REAL_HOME) return true;
    return value.includes(REAL_HOME) && !sanctionedPrefixes.some((prefix) => value.startsWith(prefix));
  });
  checks.check(
    'a4-real-home-not-in-non-path-values',
    homeLeaks.length === 0,
    `非 PATH env 值中真实 HOME 泄漏（不含 run 目录/repo 根这两个登记落点）=${homeLeaks.length === 0 ? '0' : JSON.stringify(homeLeaks)}`,
  );
  const pathHomeEntries = (childEnv['PATH'] ?? '').split(':').filter((entry) => entry.includes(REAL_HOME)).length;
  notes.push(`观察项（设计登记面）：PATH 按白名单继承宿主（worker-env.ts:9-11），其中含真实 HOME 路径的条目 ${pathHomeEntries} 个；属登记过的非机密面，不算红，但如实记录。`);

  // /proc/self/environ：拒读=防线生效；若未来可读，dump 内容必须过同一套键名+值扫描。
  const procProbePath = path.join(result.audit.runDir, 'out', 'proc-probe.json');
  const procProbe: ProbeAttempt[] = existsSync(procProbePath)
    ? JSON.parse(readFileSync(procProbePath, 'utf8')) as ProbeAttempt[]
    : [];
  const procSelf = procProbe.find((entry) => entry.label === 'read /proc/self/environ');
  const dumpPath = path.join(result.audit.runDir, 'out', 'environ-dump.txt');
  const dumpExists = existsSync(dumpPath);
  const dumpText = dumpExists ? readFileSync(dumpPath, 'utf8') : '';
  const dumpClean = !dumpExists
    || (SECRET_VALUES.every((value) => !dumpText.includes(value)) && !/LLM_|WECOM_|AGENT_CONFIG_PATH|DB_PATH/.test(dumpText));
  checks.check(
    'a4-proc-environ-denied-or-clean',
    procSelf !== undefined && ((procSelf.ok === false && procSelf.code === 'ERR_ACCESS_DENIED') || dumpClean),
    `/proc/self/environ 探针=${JSON.stringify(procSelf)}；dump 存在=${dumpExists} 且干净=${dumpClean}（拒读=防线生效；可读则内容必须过键名+值扫描）`,
  );

  const evidence = {
    runDir: result.audit.runDir,
    exitCode: result.exitCode,
    childEnvKeys: childKeys,
    childEnvRedacted: redact(JSON.stringify(childEnv, null, 2)),
    procProbe,
    dumpExists,
    dumpClean,
    stdout: result.stdout,
    stderr: redact(result.stderr).slice(0, 2000),
    pathHomeEntries,
  };
  rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  store.close();
  return { attack: 'a4', checks: checks.list, notes, evidence };
}

// ── a5 fork bomb（4 层递归子进程）───────────────────────────────────────────

async function attackA5(): Promise<AttackPartial> {
  const checks = new Checks();
  const notes: string[] = [];
  const fixture = makeFixture(8_000); // 收紧超时：若 fork 真的起步，8s 内必须被组杀
  const { store, executor } = fixture;

  // 4 层递归炸弹体（只有 spawn 真的可用时才会生长）：每层 spawn 2 个下一层（depth 上限 4），然后忙循环。
  const bombProgram = [
    `const { spawn } = require('node:child_process');`,
    `const depth = Number(process.env.R3B_DEPTH || '0');`,
    `if (depth < 4) {`,
    `  for (let i = 0; i < 2; i++) {`,
    `    try { spawn(process.execPath, [__filename], { stdio: 'ignore', env: { ...process.env, R3B_DEPTH: String(depth + 1) } }); } catch (e) {}`,
    `  }`,
    `}`,
    `for(;;){}`,
  ].join('\n');
  const code = [
    `const fs = require('node:fs');`,
    `const { spawnSync, spawn, exec } = require('node:child_process');`,
    `const bombProgram = ${JSON.stringify(bombProgram)};`,
    `fs.writeFileSync('scratch/bomb.cjs', bombProgram);`,
    `const results = { attempts: [] };`,
    `function attempt(label, fn) { try { const r = fn(); results.attempts.push({ label, ok: true, info: String(r).slice(0, 40) }); } catch (e) { results.attempts.push({ label, ok: false, code: e.code ?? String(e).slice(0, 60) }); } }`,
    `attempt('spawnSync-layer1', () => spawnSync(process.execPath, ['scratch/bomb.cjs']).status);`,
    `attempt('spawn-layer1', () => spawn(process.execPath, ['scratch/bomb.cjs'], { stdio: 'ignore' }).pid);`,
    `attempt('exec-layer1', () => exec('id', () => {}));`,
    `const denied = results.attempts.every(a => !a.ok);`,
    `fs.writeFileSync('out/fork-probe.json', JSON.stringify(results, null, 2));`,
    `if (!denied) { try { spawn(process.execPath, ['scratch/bomb.cjs'], { stdio: 'ignore' }); } catch (e) {} for(;;){} }`,
    `console.log('all-spawn-forms-denied=' + denied);`,
  ].join('\n');

  const result = await executor.runJs({ code, scope: SCOPE });
  const probePath = path.join(result.audit.runDir, 'out', 'fork-probe.json');
  const probeRaw: { attempts: ProbeAttempt[] } = existsSync(probePath)
    ? JSON.parse(readFileSync(probePath, 'utf8')) as { attempts: ProbeAttempt[] }
    : { attempts: [] };
  const probe = probeRaw.attempts;

  const anySpawned = probe.some((entry) => entry.ok);
  const allDenied = probe.length === 3 && probe.every((entry) => !entry.ok && entry.code === 'ERR_ACCESS_DENIED');
  checks.check(
    'a5-forkbomb-contained',
    allDenied || (anySpawned && result.audit.killReason === 'timeout' && result.exitSignal === 'SIGKILL'),
    allDenied
      ? `spawn 三形状全部层 1 被拒（ERR_ACCESS_DENIED）：${JSON.stringify(probe)}——4 层递归无法起步，权限模型是第一道防线`
      : `spawn 未被拒（行为变化！）：fork 实际起步，超时组杀 killReason=${result.audit.killReason} exitSignal=${result.exitSignal}`,
  );

  const table = await psTable();
  const residue = psResidueCount(table, result.audit.runId);
  checks.check(
    'a5-no-residue',
    residue.length === 0,
    `ps 全表按 runId 扫描残留=${residue.length}（runId=${result.audit.runId}）`,
  );
  notes.push(anySpawned
    ? '分支：spawn 未被拒，组杀路径被实测。'
    : '分支：spawn 层 1 全拒（Node v24 权限模型默认无 --allow-child-process），炸弹零起步；进程组杀机制另由 a5b 深树实测兜底。');

  const evidence = {
    runDir: result.audit.runDir,
    exitCode: result.exitCode,
    exitSignal: result.exitSignal,
    killReason: result.audit.killReason ?? null,
    stdout: result.stdout,
    stderr: redact(result.stderr).slice(0, 2000),
    probe,
    residueLines: residue,
  };
  rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  store.close();
  return { attack: 'a5', checks: checks.list, notes, evidence };
}

/** a5b：与执行器同形的 detached 父 + 4 层非 detached 递归子进程 → killRunProcessGroup 整组兜住。 */
async function attackA5b(): Promise<AttackPartial> {
  const checks = new Checks();
  const notes: string[] = [];
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'r3b-deeptree-'));
  const marker = `r3b-deeptree-${Date.now()}-${process.pid}`;
  const pidDir = path.join(fixtureRoot, `pids-${marker}`); // marker 进 argv，ps 残留扫描才真的有靶子
  mkdirSync(pidDir, { recursive: true });
  const levelScript = path.join(fixtureRoot, 'level.cjs');
  writeFileSync(
    levelScript,
    [
      `const fs = require('node:fs');`,
      `const [, , pidDir, level] = process.argv;`,
      `fs.writeFileSync(require('node:path').join(pidDir, 'pid-' + level + '.txt'), String(process.pid));`,
      `if (Number(level) < 4) {`,
      `  const { spawn } = require('node:child_process');`,
      `  spawn(process.execPath, [__filename, pidDir, String(Number(level) + 1)], { stdio: 'ignore' });`,
      `}`,
      `for(;;){}`,
    ].join('\n'),
    'utf8',
  );
  const parent = spawn(process.execPath, [levelScript, pidDir, '1'], { detached: true, stdio: 'ignore' });
  const parentPid = parent.pid;
  if (parentPid === undefined) throw new Error('深树父进程 spawn 失败');
  try {
    const pidFiles: number[] = [];
    for (let level = 1; level <= 4; level += 1) {
      await waitForFile(path.join(pidDir, `pid-${level}.txt`), 10_000);
      pidFiles.push(Number(readFileSync(path.join(pidDir, `pid-${level}.txt`), 'utf8')));
    }
    await new Promise((resolve) => setTimeout(resolve, 200)); // 末层 spawn 收尾窗口

    killRunProcessGroup(parentPid);
    const deadline = Date.now() + 8_000;
    while (pidFiles.some((pid) => processAlive(pid)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const alive = pidFiles.filter((pid) => processAlive(pid));
    checks.check(
      'a5b-group-kill-deep-tree',
      alive.length === 0,
      `4 层树（detached 父 pgid=${parentPid}，pids=${JSON.stringify(pidFiles)}）组杀后存活=${alive.length}`,
    );
    const table = await psTable();
    const residue = psResidueCount(table, marker);
    checks.check('a5b-no-residue', residue.length === 0, `ps 全表按 argv marker 扫描残留=${residue.length}`);
    notes.push('深树与执行器同形：detached:true 起组、子层非 detached（继承组）；kill(-pgid, SIGKILL) 一次整组带走。');
  } finally {
    killRunProcessGroup(parentPid); // 断言失败也不留活体
    await new Promise((resolve) => setTimeout(resolve, 200));
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
  return { attack: 'a5b', checks: checks.list, notes, evidence: { marker, parentPid } };
}

// ── a6 内存（Buffer 2GB / V8 堆越限）────────────────────────────────────────

async function attackA6(): Promise<AttackPartial> {
  const checks = new Checks();
  const notes: string[] = [];
  const fixture = makeFixture();
  const { store, executor } = fixture;
  const hostRssBefore = Math.round(process.memoryUsage().rss / 1_048_576);

  // ① Buffer.alloc(2GB)：外部内存，不经 V8 堆——宿主必须不被带走。
  const bufCode = [
    `const fs = require('node:fs');`,
    `const b = Buffer.alloc(2 * 1024 * 1024 * 1024, 1);`,
    `const mu = process.memoryUsage();`,
    `const info = { rssMB: Math.round(mu.rss / 1048576), heapUsedMB: Math.round(mu.heapUsed / 1048576), externalMB: Math.round(mu.external / 1048576), len: b.length };`,
    `fs.writeFileSync('out/mem.json', JSON.stringify(info, null, 2));`,
    `console.log('rssMB=' + info.rssMB);`,
  ].join('\n');
  const bufResult = await executor.runJs({ code: bufCode, scope: SCOPE });
  const memPath = path.join(bufResult.audit.runDir, 'out', 'mem.json');
  const memInfo = existsSync(memPath)
    ? JSON.parse(readFileSync(memPath, 'utf8')) as { rssMB: number; heapUsedMB: number; externalMB: number; len: number }
    : undefined;

  const followup = await executor.runJs({ code: `console.log('host-alive');`, scope: SCOPE });
  checks.check(
    'a6-host-survives-2gb-buffer',
    bufResult.audit.killReason === undefined && followup.exitCode === 0 && followup.stdout.includes('host-alive'),
    `2GB Buffer 分配后：执行器按期返回（killReason=${bufResult.audit.killReason ?? '无'}，exit=${bufResult.exitCode}），后续 run 正常（exit=${followup.exitCode}）；宿主 RSS before=${hostRssBefore}MB after=${Math.round(process.memoryUsage().rss / 1_048_576)}MB`,
  );
  notes.push(
    memInfo !== undefined && memInfo.rssMB >= 2048
      ? `观察项：子进程实际持有 ${memInfo.rssMB}MB RSS（Buffer 外部内存不受 --max-old-space-size=512 约束，v8 §3 只声明 V8 堆上限）；owner 裁决「基础防护就够」，宿主未被带走，如实登记。`
      : `观察项：2GB 分配未完整持有（子进程 info=${JSON.stringify(memInfo ?? null)}），行为如实记录。`,
  );

  // ② V8 堆越限：逐页触碰的真实分配冲 512MB 上限 → 必须被 cap（否则判红）。
  const heapCode = [
    `const fs = require('node:fs');`,
    `const chunks = [];`,
    `let touched = 0;`,
    `let capped = null;`,
    `try {`,
    `  for (let i = 0; i < 96; i++) {`,
    `    const s = 'y'.repeat(16 * 1048576);`,
    `    for (let j = 0; j < s.length; j += 4096) touched += s.charCodeAt(j);`,
    `    chunks.push(s);`,
    `  }`,
    `} catch (e) { capped = e.constructor.name + ':' + String(e.message).slice(0, 80); }`,
    `fs.writeFileSync('out/heap-probe.json', JSON.stringify({ touched, grownMB: chunks.length * 16, capped }, null, 2));`,
    `console.log('capped=' + (capped ?? 'no') + ' chunks=' + chunks.length);`,
  ].join('\n');
  const heapResult = await executor.runJs({ code: heapCode, scope: SCOPE });
  const heapPath = path.join(heapResult.audit.runDir, 'out', 'heap-probe.json');
  const heapInfo = existsSync(heapPath)
    ? JSON.parse(readFileSync(heapPath, 'utf8')) as { touched: number; grownMB: number; capped: string | null }
    : undefined;
  const cappedByError = heapResult.exitCode !== 0
    || heapResult.exitSignal !== null
    || (heapInfo?.capped !== undefined && heapInfo.capped !== null);
  checks.check(
    'a6b-v8-heap-cap-enforced',
    cappedByError && followup.exitCode === 0,
    `V8 堆冲 512MB：exit=${heapResult.exitCode} signal=${heapResult.exitSignal} killReason=${heapResult.audit.killReason ?? '无'} 子进程自报=${JSON.stringify(heapInfo ?? null)}（非零退出/SIGABRT/自报 capped 三者其一必须成立；宿主后续 run 正常）`,
  );
  if (heapResult.exitCode === 0 && (heapInfo?.grownMB ?? 0) >= 1536) {
    notes.push('观察项：堆冲到 ≥1.5GB 仍 exit=0——--max-old-space-size 未生效，按判据 a6b 已判红（本行只在异常分支出现）。');
  }
  const finalTable = await psTable();
  const residue = psResidueCount(finalTable, bufResult.audit.runId).concat(psResidueCount(finalTable, heapResult.audit.runId));
  checks.check('a6-no-residue', residue.length === 0, `两次大内存 run 后 ps 残留=${residue.length}`);

  const evidence = {
    hostRssBeforeMB: hostRssBefore,
    hostRssAfterMB: Math.round(process.memoryUsage().rss / 1_048_576),
    bufferRun: {
      exitCode: bufResult.exitCode,
      killReason: bufResult.audit.killReason ?? null,
      memInfo: memInfo ?? null,
      stdout: bufResult.stdout,
      stderr: redact(bufResult.stderr).slice(0, 1000),
    },
    heapRun: {
      exitCode: heapResult.exitCode,
      exitSignal: heapResult.exitSignal,
      killReason: heapResult.audit.killReason ?? null,
      heapInfo: heapInfo ?? null,
      stderrHead: redact(heapResult.stderr).slice(0, 500),
    },
    residue,
  };
  rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  store.close();
  return { attack: 'a6', checks: checks.list, notes, evidence };
}

// ── a7 两次 run_js 并发写同名产物 ───────────────────────────────────────────

async function attackA7(): Promise<AttackPartial> {
  const checks = new Checks();
  const notes: string[] = [];
  const fixture = makeFixture();
  const { workspaceRoot, store, executor } = fixture;

  const markerA = 'a7-marker-A-run-content';
  const markerB = 'a7-marker-B-run-content';
  const codeOf = (marker: string): string =>
    [
      `const fs = require('node:fs');`,
      `fs.writeFileSync('out/汇总.txt', ${JSON.stringify(marker)});`,
      `console.log('done');`,
    ].join('\n');
  const [resultA, resultB] = await Promise.all([
    executor.runJs({ code: codeOf(markerA), scope: SCOPE }),
    executor.runJs({ code: codeOf(markerB), scope: SCOPE }),
  ]);

  checks.check(
    'a7-both-runs-succeed',
    resultA.exitCode === 0 && resultB.exitCode === 0
      && resultA.outputs.length === 1 && resultB.outputs.length === 1
      && resultA.outputs[0]!.name === '汇总.txt' && resultB.outputs[0]!.name === '汇总.txt',
    `两次并发 run exit=${resultA.exitCode}/${resultB.exitCode}；产物=${JSON.stringify(resultA.outputs)} / ${JSON.stringify(resultB.outputs)}`,
  );
  const idA = resultA.outputs[0]!.fileId;
  const idB = resultB.outputs[0]!.fileId;
  checks.check(
    'a7-distinct-rundirs-and-fileids',
    resultA.audit.runDir !== resultB.audit.runDir && idA !== idB,
    `runDir 互异=${resultA.audit.runDir !== resultB.audit.runDir}；fileId 互异=${idA !== idB}（per-run 目录隔离）`,
  );
  const storageA = fileStoragePathOf(workspaceRoot, SCOPE, idA, '汇总.txt');
  const storageB = fileStoragePathOf(workspaceRoot, SCOPE, idB, '汇总.txt');
  const bytesA = readFileSync(storageA, 'utf8');
  const bytesB = readFileSync(storageB, 'utf8');
  const rows = store.listFileRefs(SCOPE).filter((row) => row.name === '汇总.txt');
  checks.check(
    'a7-no-cross-contamination',
    bytesA === markerA && bytesB === markerB && rows.length === 2,
    `A 存储字节=${JSON.stringify(bytesA)}（hex=${readFileSync(storageA).subarray(0, 12).toString('hex')}）；B 存储字节=${JSON.stringify(bytesB)}（hex=${readFileSync(storageB).subarray(0, 12).toString('hex')}）；同名行=${rows.length}（无交叉污染）`,
  );
  notes.push('UNDEFINED：同名产物在交付面的展示/改名/合并规则，设计稿（v8 §2 契约与 §7 交付）未定义；登记面行为=两行同名不同 fileId 共存，交由交付接线裁定。');

  const evidence = {
    runDirA: resultA.audit.runDir,
    runDirB: resultB.audit.runDir,
    outputsA: resultA.outputs,
    outputsB: resultB.outputs,
    sameNameRows: rows.length,
  };
  rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  store.close();
  return { attack: 'a7', checks: checks.list, notes, evidence };
}

// ── 入口 ────────────────────────────────────────────────────────────────────

interface CliOptions {
  attacks: readonly string[];
  outDir: string;
}

function parseCli(argv: readonly string[]): CliOptions {
  const all = ['a1', 'a2', 'a3', 'a4', 'a5', 'a5b', 'a6', 'a7'];
  const options: CliOptions = {
    attacks: all,
    outDir: path.join(REPO_ROOT, '.runtime', 'eval-cap01-r3b', new Date().toISOString().replace(/[:.]/g, '-')),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--attack') {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error('--attack 需要值（a1,a2,a3,a4,a5,a5b,a6,a7，逗号分隔）');
      const picked = value.split(',').map((item) => item.trim()).filter((item) => item !== '');
      const valid = picked.filter((item) => all.includes(item));
      if (valid.length !== picked.length || valid.length === 0) throw new Error(`--attack 只认 ${all.join('/')}: ${value}`);
      options.attacks = valid;
    } else if (arg === '--out-dir') {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error('--out-dir 需要值');
      options.outDir = path.resolve(value);
    } else {
      throw new Error(`未知参数：${arg}（支持 --attack / --out-dir）`);
    }
  }
  return options;
}

const ATTACK_RUNNERS: Record<string, () => Promise<AttackPartial>> = {
  a1: attackA1,
  a2: attackA2,
  a3: attackA3,
  a4: attackA4,
  a5: attackA5,
  a5b: attackA5b,
  a6: attackA6,
  a7: attackA7,
};

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  mkdirSync(cli.outDir, { recursive: true });
  console.log(`[cap01-r3b] 攻击面加厚验收 attacks=${cli.attacks.join(',')} outDir=${cli.outDir} node=${process.version}`);
  console.log(`[cap01-r3b] 哨兵注入：${SECRET_KEY_NAMES.join(',')}（值不落证据）`);

  const outcomes: AttackOutcome[] = [];
  for (const attack of cli.attacks) {
    const runner = ATTACK_RUNNERS[attack];
    if (runner === undefined) throw new Error(`无此攻击：${attack}`);
    console.log(`[cap01-r3b] ── 攻击 ${attack} 开始 ──`);
    const started = Date.now();
    let partial: AttackPartial;
    try {
      partial = await runner();
    } catch (error) {
      partial = {
        attack,
        checks: [{ name: `${attack}-harness`, pass: false, detail: `攻击场景抛错：${error instanceof Error ? (error.stack ?? error.message) : String(error)}` }],
        notes: ['场景级异常：夹具/执行器层失败即 FAIL，证据缺失不冒充通过'],
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        evidence: {},
      };
    }
    const allPassed = partial.checks.every((entry) => entry.pass);
    const evidencePath = path.join(cli.outDir, `${partial.attack}-evidence.json`);
    writeFileSync(evidencePath, redact(JSON.stringify(partial.evidence ?? {}, null, 2)) + '\n');
    for (const entry of partial.checks) {
      console.log(`[cap01-r3b] ${partial.attack} ${entry.pass ? 'PASS' : 'FAIL'} ${entry.name} — ${entry.detail}`);
    }
    for (const note of partial.notes) {
      console.log(`[cap01-r3b] ${partial.attack} NOTE ${note}`);
    }
    console.log(`[cap01-r3b] ── 攻击 ${partial.attack} ${allPassed ? 'PASS' : 'FAIL'}（${Date.now() - started}ms，证据=${evidencePath}）──`);
    outcomes.push({ ...partial, status: allPassed ? 'pass' : 'fail', evidencePath });
  }

  const summary = {
    mode: 'scripted',
    model: 'scripted', // 攻击面全脚本化；真模型只属 R2（0 次 LLM 调用）
    nodeVersion: process.version,
    secretSurfaceKeys: SECRET_KEY_NAMES,
    attacks: Object.fromEntries(outcomes.map((outcome) => [
      outcome.attack,
      {
        status: outcome.status,
        checks: outcome.checks,
        notes: outcome.notes,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        evidencePath: outcome.evidencePath,
      },
    ])),
  };
  const summaryPath = path.join(cli.outDir, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  const allPass = outcomes.every((outcome) => outcome.status === 'pass');
  for (const outcome of outcomes) {
    console.log(`[cap01-r3b] ${outcome.attack}=${outcome.status.toUpperCase()}`);
  }
  console.log(`[cap01-r3b] 汇总=${summaryPath}`);
  if (!allPass) process.exitCode = 1;
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error('[cap01-r3b] 入口失败：', error);
    process.exitCode = 1;
  });
}
