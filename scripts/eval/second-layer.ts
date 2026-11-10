/**
 * Second-layer proof runner (Package 4, no model, no real platform).
 * Runs the stock gateway through its protocol surface and proves the
 * zero-production-change claim: `git diff --name-only <baseline> HEAD -- packages apps
 * ':(exclude)*.test.ts'` must be empty, and the same for the uncommitted diff.
 *
 * production = packages/apps 下非 `*.test.ts` 的运行时文件；`*.test.ts` 属测试面，不算
 * 生产改动（2026-11-10 切片 j 起收窄，理由：守卫名义是「零生产改动」，测试文件不属
 * 生产面——典型例：`platform-leak-lint.test.ts` 的 FSHINE_* 登记表新增条目）。生产运行时
 * 文件两查全红，探测力不变（变异自验见 PR 正文）。
 *
 * Usage: node --import tsx scripts/eval/second-layer.ts [baselineCommit]
 * Baseline default is the commit that last re-anchored this proof.
 * Anchor rule (2026-11-10): when production code is changed on purpose,
 * the anchor moves forward to that commit, but only if the six protocol
 * checks pass again on the new code. The diff checks themselves are
 * unchanged: they still fail on any unexpected production drift after
 * the anchor. Moving the anchor is not a way to silence the guard.
 * Exit 0 only if every check passes.
 */
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutFixtureAuxState } from './fixture-aux-state';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(evalDir, '..', '..');
const fixtureRoot = path.join(evalDir, 'fixtures', 'stock-platform');
const stockBin = path.join(fixtureRoot, 'bin', 'stock');
const baseline = process.argv[2] ?? '0a76921cbfe6cbc9092b467f861a14e37f72bd21';

const dir = mkdtempSync(path.join(os.tmpdir(), 'second-layer-run-'));
// 状态根走测试专用 `--state-dir` flag（docs §4a，dummy 测试面，非消费协议）：四个 STATE
// 路径不再经 env 注入，夹具也不再读它们；memory/breaker/cache 从同一状态根派生。辅助组
// 六个 ambient 名（EXECUTION_* / STOCK_*）必须先清场：stock.cjs 的 auxPaths() 用 env2
// 优先读 ambient，否则 shell 里的打开态熔断账本会盖过 per-case 派生（fixture-aux-state）。
// 令牌面只注入规范族 EXECUTION_*（docs/env-naming-ruling-20261110.md）。
const env: NodeJS.ProcessEnv = { ...withoutFixtureAuxState(process.env),
  EXECUTION_GATE_SECRET: 'second-layer-gate-secret',
  EXECUTION_PLAN_ACTIVATION_SECRET: 'second-layer-plan-secret' };
function run(args: string[], input?: string) {
  const r = spawnSync(stockBin, ['--state-dir', dir, ...args], { encoding: 'utf8', cwd: fixtureRoot, env, input });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function envOf(stdout: string) { const m = stdout.match(/^RESULT (\{.*\})\s*$/m); return m ? JSON.parse(m[1]!) : null; }
function check(name: string, pass: boolean, actual: string) { console.log(`${pass ? 'PASS' : 'FAIL'} ${name} :: ${actual}`); return pass; }
let ok = true;
try {
  const list = run(['operation', 'list', '--json']);
  const ops = JSON.parse(list.stdout).operations.map((o: { name: string }) => o.name);
  ok = check('operation list stock-only 6', JSON.stringify(ops) === JSON.stringify(['stock.query', 'stock.scratch', 'stock.prepare', 'stock.commit', 'stock.proposal', 'stock.proposal-commit']), ops.join(',')) && ok;
  const q = envOf(run(['query', 'stock.query', '--shelf', 'north', '--batch', 'B1']).stdout);
  ok = check('query north B1 count 2', q?.status === 'completed' && q?.data?.count === 2, `${q?.status} ${q?.data?.count}`) && ok;
  const plan = JSON.parse(run(['plan', 'evaluate', '--task-id', 't1', '--stdin'], JSON.stringify({ calls: [{ operation: 'stock.query', args: ['--shelf', 'north'] }] })).stdout);
  ok = check('plan execute weight 2', plan.decision === 'execute' && plan.estimate.weight === 2, `${plan.decision} ${plan.estimate.weight}`) && ok;
  const payload = path.join(dir, 'payload.json');
  writeFileSync(payload, JSON.stringify({ shelf: 'north', batch: 'B1', items: [{ sku: 'new-1', qty: 5 }] }));
  const created = envOf(run(['prepare', 'stock.proposal', payload]).stdout);
  const proposalId = created?.data?.proposalId as string;
  ok = check('proposal pending', created?.data?.status === 'pending' && typeof proposalId === 'string', String(created?.data?.status)) && ok;
  const body = Buffer.from(JSON.stringify({ proposalId, expiresAt: created?.data?.expiresAt })).toString('base64url');
  const token = `${body}.${Buffer.from(createHmac('sha256', 'second-layer-gate-secret').update(body).digest()).toString('base64url')}`;
  const commit = spawnSync(stockBin, ['--state-dir', dir, 'commit', 'stock.proposal-commit', '--proposal-id', proposalId], { encoding: 'utf8', cwd: fixtureRoot, env: { ...env, EXECUTION_COMMIT_TOKEN: token } });
  const ce = envOf(commit.stdout ?? '');
  ok = check('commit verified readback', commit.status === 0 && (ce?.data as Record<string, unknown>)?.verified === true, `${commit.status} ${JSON.stringify(ce?.data)}`) && ok;
  const mem = envOf(run(['memory', 'set', '--key', 'k', '--value', 'v']).stdout);
  ok = check('memory set', mem?.status === 'completed', String(mem?.status)) && ok;
  const git = (args: string[]) => spawnSync('git', args, { encoding: 'utf8', cwd: repoRoot }).stdout.trim();
  // 同一 pathspec 口径两查共用：packages/apps 下非 *.test.ts 的运行时文件（见头注）。
  const RUNTIME_PATHS = ['--', 'packages', 'apps', ':(exclude)*.test.ts'];
  const committedDiff = git(['diff', '--name-only', baseline, 'HEAD', ...RUNTIME_PATHS]);
  const workDiff = git(['diff', '--name-only', ...RUNTIME_PATHS]);
  ok = check(`production runtime diff vs ${baseline} empty`, committedDiff === '', committedDiff || '(empty)') && ok;
  ok = check('production runtime worktree diff empty', workDiff === '', workDiff || '(empty)') && ok;
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(ok ? 'Second-layer proof: PASS' : 'Second-layer proof: FAIL');
process.exit(ok ? 0 : 1);
