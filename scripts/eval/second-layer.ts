/**
 * Second-layer proof runner (Package 4, no model, no real platform).
 * Runs the stock gateway through its protocol surface and proves the
 * zero-production-change claim: `git diff --name-only <baseline> -- packages apps`
 * must be empty (working tree + committed range), and the same for
 * `git diff --name-only -- packages apps` (uncommitted).
 * Usage: node --import tsx scripts/eval/second-layer.ts [baselineCommit]
 * Baseline default is the Package-3 head (17aafe3) — the commit before
 * Package 4 started. Exit 0 only if every check passes.
 */
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(evalDir, '..', '..');
const fixtureRoot = path.join(evalDir, 'fixtures', 'stock-platform');
const stockBin = path.join(fixtureRoot, 'bin', 'stock');
const baseline = process.argv[2] ?? '17aafe3';
/**
 * 辅助组的 B 类隔离键（规范名 + 调试专名）。辅助组不再按 run 注入后，ambient 值会经
 * 夹具的 env2 查找盖过 auxPaths() 的 per-run 派生，必须在子进程 env 里清场。
 */
const AUX_GROUP_ENV_KEYS = [
  'EXECUTION_MEMORY_STATE', 'EXECUTION_BREAKER_STATE', 'EXECUTION_CACHE_STATE',
  'STOCK_MEMORY_STATE', 'STOCK_BREAKER_STATE', 'STOCK_CACHE_STATE',
] as const;

const dir = mkdtempSync(path.join(os.tmpdir(), 'second-layer-run-'));
// 只注入规范族 EXECUTION_*（docs/env-naming-ruling-20261110.md）：夹具仍认 STOCK_*
// 调试专名，但评测进程不设它；规范名优先保证 ambient 专名无法改道 per-case 隔离。
// 辅助组（memory / breaker / cache）不按 run 注入：stock.cjs 的 auxPaths() 从
// statePaths().stateFile 的目录派生，状态路径按 run 隔离后辅助文件自动落进同一目录。
// 但 ambient 的辅助组键（规范名或调试名）会盖过该派生，故先清场（见 AUX_GROUP_ENV_KEYS）。
const env: NodeJS.ProcessEnv = { ...process.env,
  EXECUTION_MOCK_STATE: path.join(dir, 'state.json'), EXECUTION_PLAN_STATE: path.join(dir, 'plans.json'),
  EXECUTION_PROPOSAL_STATE: path.join(dir, 'proposals.json'), EXECUTION_AUDIT_PATH: path.join(dir, 'audit.jsonl'),
  EXECUTION_GATE_SECRET: 'second-layer-gate-secret',
  EXECUTION_PLAN_ACTIVATION_SECRET: 'second-layer-plan-secret' };
for (const key of AUX_GROUP_ENV_KEYS) delete env[key];
function run(args: string[], input?: string) {
  const r = spawnSync(stockBin, args, { encoding: 'utf8', cwd: fixtureRoot, env, input });
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
  const commit = spawnSync(stockBin, ['commit', 'stock.proposal-commit', '--proposal-id', proposalId], { encoding: 'utf8', cwd: fixtureRoot, env: { ...env, EXECUTION_COMMIT_TOKEN: token } });
  const ce = envOf(commit.stdout ?? '');
  ok = check('commit verified readback', commit.status === 0 && (ce?.data as Record<string, unknown>)?.verified === true, `${commit.status} ${JSON.stringify(ce?.data)}`) && ok;
  const mem = envOf(run(['memory', 'set', '--key', 'k', '--value', 'v']).stdout);
  ok = check('memory set', mem?.status === 'completed', String(mem?.status)) && ok;
  const git = (args: string[]) => spawnSync('git', args, { encoding: 'utf8', cwd: repoRoot }).stdout.trim();
  const committedDiff = git(['diff', '--name-only', baseline, 'HEAD', '--', 'packages', 'apps']);
  const workDiff = git(['diff', '--name-only', '--', 'packages', 'apps']);
  ok = check(`production diff vs ${baseline} empty`, committedDiff === '', committedDiff || '(empty)') && ok;
  ok = check('production worktree diff empty', workDiff === '', workDiff || '(empty)') && ok;
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(ok ? 'Second-layer proof: PASS' : 'Second-layer proof: FAIL');
process.exit(ok ? 0 : 1);
