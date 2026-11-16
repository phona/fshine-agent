/**
 * run_js 执行器（CAP-01 S0；docs/product/cap01-main-direct-execution.md §2/§3/§8）。
 *
 * 覆盖（S0 验收 ①-⑥，逐条对应）：
 *   ① 脚本读 in/、写 out/ → 产物登记成新 fileId、**原件 sha256 不变**（存储字节不动、
 *      out/ 原件原样——copy-on-register 不是 move）；exceljs 真跑一例（产物可重解析）；
 *   ② 脚本读宿主 .env（run 目录外）→ 被拒：子进程非零退出、stderr 含 ACCESS_DENIED、产物为空；
 *      同仓宿主文件（package.json）一样被拒；
 *   ③ 脚本调 child_process → 被拒（spawn 调用点 ERR_ACCESS_DENIED；require 本身不拦，
 *      本机 Node v24.20.0 实测）；
 *   ④ 死循环脚本 → 超时被进程组 SIGKILL（exitCode null / killReason=timeout），ps 全表
 *      无残留；abort 信号同路径；killRunProcessGroup 对「父 + 非 detached 孙进程」整组
 *      生效（沙箱里脚本造不出孙进程——child_process 被拒——所以组杀机制单独实测）；
 *   ⑤ out/ 里放 symlink（文件/目录）与 hardlink → 不被登记，普通文件照常，行数=1；
 *   ⑥ 越限输出被截断：stdout/stderr 流式截断并标 truncated；超大产物（size_limit）与
 *      超份数产物（count_limit）不登记。
 *
 * 另覆盖输入面：pending / 越权 / 不存在 → 同码 FILE_REF_UNAVAILABLE，且不起子进程。
 *
 * 目录用临时 workspace（mkdtemp）；node_modules 用真实仓内目录（require('exceljs') 的
 * 授权读根）；不触网、不碰真实平台。
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { openTaskStore } from '@fshine/core';
import {
  createFileStore,
  FileRefUnavailableError,
  fileStoragePathOf,
  runDirOf,
  sessionDirOf,
  type FileStore,
} from './src/file-store';
import {
  createRunJsExecutor,
  killRunProcessGroup,
  type RunJsExecutor,
} from './src/run-js-executor';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = { principalId: 'wecom:u-s0', sessionId: 'cap01-s0' };

interface Fixture {
  fixtureRoot: string;
  workspaceRoot: string;
  hostEnvPath: string;
  store: ReturnType<typeof openTaskStore>;
  fileStore: FileStore;
  executor: RunJsExecutor;
}

function makeFixture(executorOverrides: Partial<Parameters<typeof createRunJsExecutor>[0]> = {}): Fixture {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'run-js-s0-'));
  dirs.push(fixtureRoot);
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  // 宿主 .env 形状的文件：在 workspace 根之外、run 目录之外（读取必须被权限模型拒）。
  const hostEnvPath = path.join(fixtureRoot, '.env');
  writeFileSync(hostEnvPath, 'LLM_FAKE_SECRET=sentinel\nWECOM_FAKE_SECRET=sentinel\n', 'utf8');
  const store = openTaskStore(':memory:');
  const fileStore = createFileStore({ store, workspaceRoot });
  const executor = createRunJsExecutor({ fileStore, nodeModulesDir: NODE_MODULES, ...executorOverrides });
  return { fixtureRoot, workspaceRoot, hostEnvPath, store, fileStore, executor };
}

/** 轮询直到文件出现（父进程写 pid 文件的窗口）。 */
async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待文件超时：${filePath}`);
}

/** 进程存活探针：活着返回 true（ESRCH = 死透）。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('run_js 执行器（CAP-01 S0）', () => {
  it('① 脚本读 in/、写 out/ → 产物登记成新 fileId；原件 sha256 不变、out/ 原件原样', async () => {
    const { workspaceRoot, store, fileStore, executor } = makeFixture();
    const inputBytes = Buffer.from('原始输入字节', 'utf8');
    const input = fileStore.putFile({ scope: SCOPE, name: '数据.txt', bytes: inputBytes, activatedAt: Date.now() });
    const inputSha = createHash('sha256').update(inputBytes).digest('hex');
    expect(input.sha256).toBe(inputSha);

    const code = [
      `const fs = require('node:fs');`,
      `const read = fs.readFileSync('in/${input.fileId}.txt', 'utf8');`,
      `fs.writeFileSync('out/回执.txt', '收到:' + read, 'utf8');`,
      `console.log('done');`,
    ].join('\n');
    const result = await executor.runJs({ code, inputs: [input.fileId], scope: SCOPE });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('done');
    // 产物：新 fileId（不是输入的），行已登记且已激活
    expect(result.outputs).toHaveLength(1);
    const output = result.outputs[0]!;
    expect(output.name).toBe('回执.txt');
    expect(output.fileId).not.toBe(input.fileId);
    const outputRow = store.getFileRef(output.fileId, SCOPE);
    expect(outputRow).toBeDefined();
    expect(outputRow?.activatedAt).toBeDefined();
    // 登记的是副本且字节正确（copy-on-register，从存储位读回）
    const outputStorage = fileStoragePathOf(workspaceRoot, SCOPE, output.fileId, '回执.txt');
    expect(readFileSync(outputStorage, 'utf8')).toBe('收到:原始输入字节');
    // 原件 1：存储位字节 sha256 前后不变（run 碰不到登记区）
    const inputStorage = fileStoragePathOf(workspaceRoot, SCOPE, input.fileId, '数据.txt');
    const inputShaAfter = createHash('sha256').update(readFileSync(inputStorage)).digest('hex');
    expect(inputShaAfter).toBe(inputSha);
    // 原件 2：out/ 里的原文件原样存在（登记是拷贝不是搬移）
    const outOriginal = path.join(result.audit.runDir, 'out', '回执.txt');
    expect(readFileSync(outOriginal, 'utf8')).toBe('收到:原始输入字节');
    // 审计面
    expect(result.audit.scriptSha256).toBe(createHash('sha256').update(Buffer.from(code, 'utf8')).digest('hex'));
    expect(result.audit.inputFileIds).toEqual([input.fileId]);
    expect(result.audit.materializedInputs[0]?.materializedName).toBe(`${input.fileId}.txt`);
    expect(result.audit.skippedOutputs).toEqual([]);
    expect(result.audit.durationMs).toBeGreaterThanOrEqual(0);
    store.close();
  });

  it('①b exceljs 真跑：脚本在权限模型下生成 xlsx 产物 → 登记后可重解析', async () => {
    const { workspaceRoot, executor } = makeFixture();
    const code = [
      `(async () => {`,
      `  const ExcelJS = require('exceljs');`,
      `  const wb = new ExcelJS.Workbook();`,
      `  const ws = wb.addWorksheet('S0');`,
      `  ws.addRow(['品名', '数量']);`,
      `  ws.addRow(['苹果', 12]);`,
      `  await wb.xlsx.writeFile('out/汇总.xlsx');`,
      `  console.log('xlsx written');`,
      `})();`,
    ].join('\n');
    const result = await executor.runJs({ code, scope: SCOPE });
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]!.name).toBe('汇总.xlsx');

    // Oracle 重解析：登记的存储字节就是合法 xlsx 且内容一致。
    const storage = fileStoragePathOf(workspaceRoot, SCOPE, result.outputs[0]!.fileId, '汇总.xlsx');
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.readFile(storage);
    const ws = wb2.getWorksheet('S0')!;
    expect(ws.getRow(2).getCell(1).value).toBe('苹果');
    expect(ws.getRow(2).getCell(2).value).toBe(12);
  });

  it('② 脚本读宿主 .env → 非零退出 + stderr 含 ACCESS_DENIED、产物为空；同仓宿主文件一样被拒', async () => {
    const { hostEnvPath, executor } = makeFixture();
    // 未捕获形状：子进程非零退出，stderr 带机械错误码（ask 的断言口径）。
    const uncaught = await executor.runJs({
      code: `require('node:fs').readFileSync(${JSON.stringify(hostEnvPath)});`,
      scope: SCOPE,
    });
    expect(uncaught.exitCode).not.toBe(0);
    expect(uncaught.stderr).toContain('ACCESS_DENIED');
    expect(uncaught.outputs).toEqual([]);

    // 捕获形状：两个 run 目录之外的宿主文件（.env 与仓内 package.json）都是 ERR_ACCESS_DENIED。
    const caught = await executor.runJs({
      code: [
        `const fs = require('node:fs');`,
        `try { fs.readFileSync(${JSON.stringify(hostEnvPath)}); console.log('env:LEAK'); }`,
        `catch (e) { console.log('env:' + e.code); }`,
        `try { fs.readFileSync(${JSON.stringify(path.join(REPO_ROOT, 'package.json'))}); console.log('pkg:LEAK'); }`,
        `catch (e) { console.log('pkg:' + e.code); }`,
      ].join('\n'),
      scope: SCOPE,
    });
    expect(caught.exitCode).toBe(0);
    expect(caught.stdout).toContain('env:ERR_ACCESS_DENIED');
    expect(caught.stdout).toContain('pkg:ERR_ACCESS_DENIED');
    expect(caught.stdout).not.toContain('LEAK');
    expect(caught.outputs).toEqual([]);
  });

  it('③ 脚本调 child_process → 被拒（spawn 调用点 ERR_ACCESS_DENIED）、产物为空', async () => {
    const { executor } = makeFixture();
    const result = await executor.runJs({
      code: `require('node:child_process').spawnSync('echo', ['leak']);`,
      scope: SCOPE,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('ACCESS_DENIED');
    expect(result.outputs).toEqual([]);
  });

  it('④ 死循环脚本 → 超时被进程组 SIGKILL；ps 全表无残留', async () => {
    const { executor } = makeFixture({ timeoutMs: 1200 });
    const result = await executor.runJs({ code: 'for(;;){}', scope: SCOPE });
    expect(result.exitCode).toBeNull();
    expect(result.exitSignal).toBe('SIGKILL');
    expect(result.audit.killReason).toBe('timeout');
    expect(result.audit.durationMs).toBeGreaterThanOrEqual(1100);
    expect(result.outputs).toEqual([]);

    // 残留检查：runJs 返回（close 已 reap）后，进程表里不应再有本 run 的任何进程。
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,args=']);
    expect(stdout).not.toContain(result.audit.runId);
  });

  it('④b killRunProcessGroup 整组生效：父进程 + 非 detached 孙进程一并终止', async () => {
    const { fixtureRoot } = makeFixture();
    const gcPidPath = path.join(fixtureRoot, 'gc.pid');
    const gcScript = path.join(fixtureRoot, 'gc.cjs');
    const parentScript = path.join(fixtureRoot, 'parent.cjs');
    // 孙进程不 detached（与执行器的威胁模型一致：组内进程），busy 循环保活。
    writeFileSync(gcScript, 'for(;;){}\n', 'utf8');
    writeFileSync(
      parentScript,
      [
        `const { spawn } = require('node:child_process');`,
        `const fs = require('node:fs');`,
        `const gc = spawn(process.execPath, [${JSON.stringify(gcScript)}], { stdio: 'ignore' });`,
        `fs.writeFileSync(${JSON.stringify(gcPidPath)}, String(gc.pid));`,
        `for(;;){}`,
      ].join('\n'),
      'utf8',
    );
    const parent = spawn(process.execPath, [parentScript], { detached: true, stdio: 'ignore' });
    const parentPid = parent.pid;
    if (parentPid === undefined) throw new Error('父进程 spawn 失败');
    try {
      await waitForFile(gcPidPath, 5000);
      const gcPid = Number(readFileSync(gcPidPath, 'utf8'));
      expect(Number.isInteger(gcPid)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100)); // 孙进程 spawn 收尾窗口

      killRunProcessGroup(parentPid);

      const deadline = Date.now() + 5000;
      while ((processAlive(parentPid) || processAlive(gcPid)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(processAlive(parentPid)).toBe(false);
      expect(processAlive(gcPid)).toBe(false);
    } finally {
      killRunProcessGroup(parentPid); // 断言失败也不留活体
    }
  });

  it('④c 宿主 abort 信号 → 进程组被杀，killReason=abort', async () => {
    const { executor } = makeFixture();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await executor.runJs({ code: 'for(;;){}', scope: SCOPE, signal: controller.signal });
    expect(result.exitCode).toBeNull();
    expect(result.exitSignal).toBe('SIGKILL');
    expect(result.audit.killReason).toBe('abort');
    expect(result.audit.durationMs).toBeLessThan(30_000);
  });

  it('⑤ out/ 里的 symlink（文件/目录）与 hardlink 不被登记；普通文件照常登记', () => {
    const { workspaceRoot, store, fileStore } = makeFixture();
    const runDir = runDirOf(workspaceRoot, SCOPE, 'run_scanfixture');
    const outDir = path.join(runDir, 'out');
    mkdirSync(outDir, { recursive: true });
    const outsideTarget = path.join(workspaceRoot, 'target.bin');
    writeFileSync(outsideTarget, '外部目标', 'utf8');
    writeFileSync(path.join(outDir, 'real.txt'), '正常产物', 'utf8');
    symlinkSync(outsideTarget, path.join(outDir, 'sym.txt')); // symlink 文件
    linkSync(outsideTarget, path.join(outDir, 'hard.txt')); // hardlink（nlink=2）
    const linkedDir = path.join(workspaceRoot, 'linked-dir');
    mkdirSync(linkedDir, { recursive: true });
    writeFileSync(path.join(linkedDir, 'inside.txt'), '不应出现', 'utf8');
    symlinkSync(linkedDir, path.join(outDir, 'symdir')); // symlink 目录（不递归）

    const { outputs, skipped } = fileStore.registerOutputsFromOut({
      runDir,
      scope: SCOPE,
      limits: { maxFileBytes: 1024, maxCount: 10 },
    });

    expect(outputs.map((file) => file.name)).toEqual(['real.txt']);
    const skippedByName = new Map(skipped.map((item) => [item.name, item.reason]));
    expect(skippedByName.get('sym.txt')).toBe('symlink');
    expect(skippedByName.get('symdir')).toBe('symlink');
    expect(skippedByName.get('hard.txt')).toBe('linked');
    // 只为 real.txt 建了行；被拒者没有行
    expect(store.listFileRefs(SCOPE)).toHaveLength(1);
    expect(store.getFileRef(outputs[0]!.fileId, SCOPE)!.name).toBe('real.txt');
    store.close();
  });

  it('⑥a 越限 stdout/stderr 被流式截断并标 truncated', async () => {
    const { executor } = makeFixture({ maxStreamBytes: 4096 });
    const result = await executor.runJs({
      code: [
        `process.stdout.write('O'.repeat(9000));`,
        `process.stderr.write('E'.repeat(9000));`,
      ].join('\n'),
      scope: SCOPE,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('O'.repeat(4096));
    expect(result.stderr).toBe('E'.repeat(4096));
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });

  it('⑥b 超大产物不登记（size_limit），普通产物照常', async () => {
    const { executor } = makeFixture({ maxOutputFileBytes: 1024 });
    const result = await executor.runJs({
      code: [
        `const fs = require('node:fs');`,
        `fs.writeFileSync('out/big.bin', 'B'.repeat(4096));`,
        `fs.writeFileSync('out/a.txt', '1');`,
      ].join('\n'),
      scope: SCOPE,
    });
    expect(result.exitCode).toBe(0);
    expect(result.outputs.map((file) => file.name)).toEqual(['a.txt']);
    expect(result.audit.skippedOutputs).toEqual([{ name: 'big.bin', reason: 'size_limit' }]);
  });

  it('⑥c 超份数产物不登记（count_limit），截尾按 relPath 排序可复现', async () => {
    const { executor } = makeFixture({ maxOutputCount: 2 });
    const result = await executor.runJs({
      code: [
        `const fs = require('node:fs');`,
        `fs.writeFileSync('out/a.txt', '1');`,
        `fs.writeFileSync('out/b.txt', '2');`,
        `fs.writeFileSync('out/c.txt', '3');`,
      ].join('\n'),
      scope: SCOPE,
    });
    expect(result.exitCode).toBe(0);
    expect(result.outputs.map((file) => file.name)).toEqual(['a.txt', 'b.txt']);
    expect(result.audit.skippedOutputs).toEqual([{ name: 'c.txt', reason: 'count_limit' }]);
  });

  it('输入面：pending / 越权 / 不存在 → 同码 FILE_REF_UNAVAILABLE，且不起子进程（无 run.cjs）', async () => {
    const { workspaceRoot, fileStore, executor } = makeFixture();
    const pending = fileStore.putFile({ scope: SCOPE, name: 'p.txt', bytes: Buffer.from('x') });
    const foreign = fileStore.putFile({
      scope: { principalId: SCOPE.principalId, sessionId: 'other-session' },
      name: 'o.txt',
      bytes: Buffer.from('y'),
      activatedAt: Date.now(),
    });
    for (const fileId of [pending.fileId, foreign.fileId, 'file_absent']) {
      await expect(executor.runJs({ code: 'console.log(1)', inputs: [fileId], scope: SCOPE })).rejects.toThrow(
        FileRefUnavailableError,
      );
    }
    // 三种拒绝不泄漏存在性差异：异常消息同码（机械 reason 只随异常对象带出）。
    for (const fileId of [pending.fileId, 'file_absent']) {
      await expect(
        executor.runJs({ code: 'console.log(1)', inputs: [fileId], scope: SCOPE }),
      ).rejects.toThrow(/FILE_REF_UNAVAILABLE/);
    }
    // 校验失败发生在写 run.cjs/spawn 之前：runs/ 下没有任何 run.cjs。
    const runsDir = path.join(sessionDirOf(workspaceRoot, SCOPE), 'runs');
    const sessionRuns = readdirSync(runsDir);
    expect(sessionRuns.length).toBeGreaterThan(0);
    for (const run of sessionRuns) {
      expect(existsSync(path.join(runsDir, run, 'run.cjs'))).toBe(false);
    }
  });
});
