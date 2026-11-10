/**
 * 提案落账后端（apps/server/proposal-commit.ts）单测。
 *
 * 这个后端是"平台有提案、宿主持确认码"接缝的另一半（B3 管创建，本文件管落账）。判据全部
 * 不起平台：`runCli` 与协议角色表都是注入点，于是能机械钉住四件事——
 *   · operation 名按 protocol 角色列解析，**表拿不到就拒绝落账**（不回落硬编码网关名）；
 *   · 令牌只绑 {proposalId, expiresAt}（不绑脚本名/业务字段），且只经 env 传给子进程；
 *   · env 纪律：剥 EXECUTION_REQUIRE_PLAN（D-081），且不声明法域 env、命令不带 --mode；
 *   · 落账前先取问平台状态，把"已过期/已终结/读不到"在办调之前现形。
 *
 * 真网关 + mock 执行器的全链覆盖在 tests/e2e/turn-loop-write-chain.test.ts。
 */
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlanCliRunner } from '@fshine/agent';
import type { OperationProtocols } from '@fshine/agent';
import type { ProposalCommitRequest, ProposalCommitResult } from '@fshine/agent';
import { createProposalCommitRunner, type ProposalCommitRunnerOptions } from './proposal-commit';

interface FakeResponse { code?: number; stdout?: string; stderr?: string }

/** 协议角色表替身（形状 = 平台 `operation list --json` 的 protocol 列解析结果）。 */
const PROTOCOLS: OperationProtocols = new Map<string, string>([
  ['voucher.proposal', 'proposal.create'],
  ['proposal', 'proposal.create'],
  ['voucher.commit', 'proposal.commit'],
  ['commit', 'proposal.commit'],
]);

const PROPOSAL_ID = 'prop_bf759dbf-1269-4b13-b3b9-ec5b5cdbf444';
const EXPIRES_AT = new Date(Date.now() + 20 * 60_000).toISOString();
const SECRET = 'unit-test-gate-secret';

function envelope(op: string, status: string, data: Record<string, unknown> | null, error: { code: string; message: string } | null): string {
  return `RESULT ${JSON.stringify({ v: 1, op, status, data, error })}\n`;
}

/** 平台 `proposal status` 的一行 JSON（形状 = 平台 CLI 的 out.write）。 */
function statusJson(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    proposalId: PROPOSAL_ID,
    status: 'pending',
    accountSet: '幻辰财税',
    period: '202609',
    count: 1,
    createdAt: new Date().toISOString(),
    expiresAt: EXPIRES_AT,
    expired: false,
    decidedAt: null,
    result: null,
    ...overrides,
  })}\n`;
}

/** 平台 commit 成功信封（ok/verified/summaryText/readBack 全是平台字段）。 */
const COMMIT_OK = envelope('voucher.commit', 'completed', {
  ok: true,
  proposalId: PROPOSAL_ID,
  verified: true,
  summaryText: `提案 ${PROPOSAL_ID} 已执行：账套「幻辰财税」2026年9月 录入 1 张凭证（借方合计 800.00，贷方合计 800.00）；读回校验通过（凭证数增加 1）。`,
  accountSet: '幻辰财税',
  period: '202609',
  count: 1,
  readBack: { before: 1, after: 2, delta: 1, required: 1 },
}, null);

/** 录下每次 CLI 调用（args + env）并按脚本应答的替身 runner。 */
function recordingCli(script: { status: FakeResponse; commit: FakeResponse }) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const runCli: PlanCliRunner = async ({ args, env }) => {
    calls.push({ args: [...args], env: env ?? {} });
    const next = args[0] === 'proposal' ? script.status : script.commit;
    return { code: next.code ?? 0, stdout: next.stdout ?? '', stderr: next.stderr ?? '' };
  };
  return { calls, runCli };
}

function makeRunner(
  script: { status: FakeResponse; commit: FakeResponse },
  overrides: Partial<ProposalCommitRunnerOptions> = {},
) {
  const cli = recordingCli(script);
  const runner = createProposalCommitRunner({
    platformRoot: '/platform',
    gateSecret: SECRET,
    runCli: cli.runCli,
    operationProtocols: PROTOCOLS,
    ...overrides,
  });
  return { ...cli, run: (req: ProposalCommitRequest = { proposalId: PROPOSAL_ID }) => runner(req) };
}

const OK_SCRIPT = { status: { stdout: statusJson() }, commit: { stdout: COMMIT_OK } };

afterEach(() => {
  delete process.env['EXECUTION_REQUIRE_PLAN'];
  delete process.env['EXECUTION_SERVE'];
});

describe('createProposalCommitRunner：operation 寻址（protocol 角色列，不硬编码）', () => {
  it('按 protocol 列解析出 proposal.commit 角色的 operation，并以其寻址', async () => {
    const cli = makeRunner(OK_SCRIPT, { operationProtocols: PROTOCOLS });

    const result = await cli.run();

    expect(result.ok).toBe(true);
    // 落账调用形态：commit <operation 名> --proposal-id <提案号>（operation 名来自角色列）
    const commit = cli.calls.find((call) => call.args[0] === 'commit');
    expect(commit?.args).toEqual(['commit', 'voucher.commit', '--proposal-id', PROPOSAL_ID]);
  });

  it('表拿不到（空表）：拒绝落账，一次平台调用都不发生（不回落硬编码网关名）', async () => {
    const cli = makeRunner(OK_SCRIPT, { operationProtocols: new Map<string, string>() });

    const result = await cli.run();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('proposal.commit');
    expect(cli.calls).toHaveLength(0);
  });

  it('提案号缺失：拒绝，不办调', async () => {
    const cli = makeRunner(OK_SCRIPT);

    const result = await cli.run({ proposalId: '  ' });

    expect(result.ok).toBe(false);
    expect(cli.calls).toHaveLength(0);
  });
});

describe('createProposalCommitRunner：令牌与 env 纪律', () => {
  it('令牌 = HMAC over {proposalId, expiresAt}，不绑脚本名/业务字段；密钥只进子进程 env', async () => {
    const cli = makeRunner(OK_SCRIPT);

    await cli.run();

    const commit = cli.calls.find((call) => call.args[0] === 'commit')!;
    const token = commit.env['EXECUTION_COMMIT_TOKEN'];
    expect(typeof token).toBe('string');
    const [body, signature, extra] = token!.split('.');
    expect(extra).toBeUndefined();
    // payload 只有两个字段：提案号 + 平台给的有效期（没有脚本名、没有业务字段）
    expect(JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'))).toEqual({ proposalId: PROPOSAL_ID, expiresAt: EXPIRES_AT });
    expect(signature).toBe(createHmac('sha256', SECRET).update(body!).digest('base64url'));
    // 密钥与令牌都只出现在这一个子进程的 env 里
    expect(commit.env['EXECUTION_GATE_SECRET']).toBe(SECRET);
  });

  it('D-081：进程带着 EXECUTION_REQUIRE_PLAN=1，宿主直调仍然把它剥掉，且不设 EXECUTION_SERVE、命令不带 --mode', async () => {
    delete process.env['EXECUTION_SERVE'];
    process.env['EXECUTION_REQUIRE_PLAN'] = '1';
    const cli = makeRunner(OK_SCRIPT);

    await cli.run();

    for (const call of cli.calls) {
      expect(call.env['EXECUTION_REQUIRE_PLAN']).toBeUndefined();
      expect(call.env['EXECUTION_SERVE']).toBeUndefined();
      expect(call.args.join(' ')).not.toContain('--mode');
    }
    expect(process.env['EXECUTION_SERVE']).toBeUndefined();
  });
});

describe('createProposalCommitRunner：落账前的平台取问', () => {
  it('提案已终结（status 非 pending）：不办调，unavailable=not_pending', async () => {
    const cli = makeRunner({ status: { stdout: statusJson({ status: 'committed' }) }, commit: { stdout: COMMIT_OK } });

    const result = await cli.run();

    expect(result).toMatchObject({ ok: false, unavailable: 'not_pending' });
    expect(cli.calls.filter((call) => call.args[0] === 'commit')).toHaveLength(0);
  });

  it('提案已过期（expired=true）：不办调，unavailable=expired', async () => {
    const cli = makeRunner({ status: { stdout: statusJson({ expired: true }) }, commit: { stdout: COMMIT_OK } });

    const result = await cli.run();

    expect(result).toMatchObject({ ok: false, unavailable: 'expired' });
    expect(cli.calls.filter((call) => call.args[0] === 'commit')).toHaveLength(0);
  });

  it('取问失败（exit 3）/ 输出不是 JSON：unavailable=unreadable，不猜平台内部状态', async () => {
    for (const status of [
      { code: 3, stderr: 'PROPOSAL_REFUSE PROPOSAL_STATE_CORRUPT: JSON 解析失败' },
      { stdout: 'not json at all' },
      { stdout: '{"proposalId":"另一个提案号","status":"pending"}\n' },
    ]) {
      const cli = makeRunner({ status, commit: { stdout: COMMIT_OK } });
      const result = await cli.run();
      expect(result, JSON.stringify(status)).toMatchObject({ ok: false, unavailable: 'unreadable' });
      expect(cli.calls.filter((call) => call.args[0] === 'commit')).toHaveLength(0);
    }
  });
});

describe('createProposalCommitRunner：RESULT 信封解析', () => {
  it('completed + ok/verified：成功，summaryText 原样带回，output 带读回计数行', async () => {
    const cli = makeRunner(OK_SCRIPT);

    const result = await cli.run();

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.summaryText).toContain('读回校验通过');
    expect(result.error).toBeUndefined();
    expect(result.unavailable).toBeUndefined();
    // 审计留痕：读回计数（before/after/delta/required）落进 output
    expect(result.output).toContain('VERIFY before=1 after=2 delta=1 required=1');
  });

  it('读回增量不足（ok=false 的错误信封）：判失败，错误码进 error（用户话术由宿主通用文案承担）', async () => {
    const cli = makeRunner({
      status: { stdout: statusJson() },
      commit: {
        code: 1,
        stdout: envelope('voucher.commit', 'failed', { proposalId: PROPOSAL_ID, readBack: { before: 1, after: 1, delta: 0, required: 1 } }, { code: 'PROPOSAL_VERIFY_SHORT', message: '增量 0 < 提案 1 张' }),
      },
    });

    const result = await cli.run();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('PROPOSAL_VERIFY_SHORT');
    expect(result.output).toContain('VERIFY before=1 after=1 delta=0 required=1');
  });

  it('域落账被拒（exit 2 无信封）：判失败且不谎称成功', async () => {
    const cli = makeRunner({ status: { stdout: statusJson() }, commit: { code: 2, stderr: 'SAVE_REJECTED 此会计期已结账' } });

    const result = await cli.run();

    expect(result.ok).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.error).toContain('SAVE_REJECTED');
    expect(result.summaryText).toBe('');
  });

  it('completed 但信封没声明 ok：判失败（写路径不猜平台语义）', async () => {
    const cli = makeRunner({
      status: { stdout: statusJson() },
      commit: { stdout: envelope('voucher.commit', 'completed', { proposalId: PROPOSAL_ID, verified: true }, null) },
    });

    const result = await cli.run();

    expect(result.ok).toBe(false);
  });
});
