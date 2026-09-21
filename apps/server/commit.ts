/**
 * 服务端落账执行器（两步确认的第二步，②d 默认实现）：
 * 提案通过 capability/账套校验后，由 fshine 服务端直调平台统一网关 bin/17dz——
 * dry-run 预检、--save 落账、verify-saved 读回。全程不经任何模型；
 * commit 以 HMAC 令牌授权（平台 G2/G3 验签），密钥进程内生成、仅经 env 传给子进程。
 * 契约文件由服务端物化到 data/intents/<intentId>/contract.json（worker 零写）。
 */
import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parsePrepareOutcome, parseVerifyCount, PLATFORM_OPERATIONS, type CommitRequest, type CommitResult, type PrepareRequest, type PrepareResult } from '@fshine/agent';

const execFileAsync = promisify(execFile);
const TOKEN_TTL_MS = 10 * 60_000;

export interface CommitRunnerOptions {
  /** 17dz-platform 仓库根（bin/17dz 统一网关所在）。 */
  platformRoot: string;
  /** HMAC 密钥：进程内生成，仅通过 env 传给 commit 子进程。 */
  gateSecret: string;
}

export function newGateSecret(): string {
  return randomBytes(32).toString('base64url');
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function signCommitToken(payload: { intentId: string; script: string; expiresAt: string }, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`;
}

function stageContract(root: string, intentId: string, contracts: unknown[]): string {
  const dir = path.join(root, 'data', 'intents', intentId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'contract.json');
  writeFileSync(file, JSON.stringify(contracts, null, 2));
  return file;
}

interface GateResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGate(root: string, args: string[], extraEnv: Record<string, string> = {}): Promise<GateResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      // bin/17dz 的 query|prepare|commit 首词即网关兼容壳（gate 语义）；脚本用注册操作名（E1）。
      [path.join(root, 'bin', '17dz'), ...args],
      { cwd: root, env: { ...process.env, ...extraEnv }, maxBuffer: 4 * 1024 * 1024, timeout: 12 * 60_000 },
    );
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr || err.message || String(e) };
  }
}

function parseCount(stdout: string): number | null {
  return parseVerifyCount(stdout);
}

export function createPrepareRunner(opts: CommitRunnerOptions) {
  return async (req: PrepareRequest): Promise<PrepareResult> => {
    const contractFile = stageContract(opts.platformRoot, req.intentId, req.contracts);
    // prepare 默认 dry-run（页面真实预填但不保存）——预检即真实演练
    const r = await runGate(opts.platformRoot, ['prepare', PLATFORM_OPERATIONS.voucherPrepare, contractFile, '--batch']);
    const outcome = parsePrepareOutcome(r.stdout);
    const ok = outcome.ok && outcome.dryRun;
    return {
      ok,
      output: `${r.stdout}\n${r.stderr}`.trim().slice(-2000),
      error: ok ? undefined : (r.stderr || r.stdout || `exit ${r.code}`).slice(-500),
    };
  };
}

export function createCommitRunner(opts: CommitRunnerOptions) {
  return async (req: CommitRequest): Promise<CommitResult> => {
    const contractFile = stageContract(opts.platformRoot, req.intentId, req.contracts);
    // E1：令牌与调用统一绑定注册操作名（平台双绑定过渡期同时兼容旧路径绑定）
    const operation = PLATFORM_OPERATIONS.voucherCommit;
    // 读回基线必须在 commit 之前采集——否则 after-before 恒为 0，校验永假。
    const before = await runGate(opts.platformRoot, ['query', PLATFORM_OPERATIONS.voucherVerifySaved, req.accountSet, req.period]);
    const token = signCommitToken(
      { intentId: req.intentId, script: operation, expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString() },
      opts.gateSecret,
    );
    const r = await runGate(
      opts.platformRoot,
      ['commit', operation, contractFile, '--batch', '--save'],
      { DZ_COMMIT_TOKEN: token, DZ_GATE_SECRET: opts.gateSecret },
    );
    if (r.code !== 0) {
      return { ok: false, output: `${r.stdout}\n${r.stderr}`.trim().slice(-2000), error: `落账命令失败（exit ${r.code}）` };
    }
    // 读回校验：落账前后账套期内凭证 COUNT 差 ≥ 提案张数
    const after = await runGate(opts.platformRoot, ['query', PLATFORM_OPERATIONS.voucherVerifySaved, req.accountSet, req.period]);
    const beforeCount = before.code === 0 ? parseCount(before.stdout) : null;
    const afterCount = after.code === 0 ? parseCount(after.stdout) : null;
    const verified = afterCount !== null && (beforeCount === null || afterCount - beforeCount >= req.contracts.length);
    return {
      ok: verified,
      output: `${r.stdout}\nVERIFY before=${beforeCount ?? '未知'} after=${afterCount ?? '未知'} expected>=${req.contracts.length}`.slice(-2000),
      error: verified ? undefined : '读回校验未通过：期内凭证数变化与提案不符',
    };
  };
}
