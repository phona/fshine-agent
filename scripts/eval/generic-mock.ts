/**
 * Generic-mock deterministic eval for fshine-agent (Phase 1 protocol + Phase 2 host).
 *
 * This is NOT the real-model Tier-1 probe. It needs no LLM, no WeCom, no
 * execution-layer checkout and no real platform. It spawns the dummy execution layer
 * (scripts/eval/fixtures/dummy-platform/bin/dummy) directly and checks the
 * protocol the orchestration layer consumes: operation list, plan, proposal,
 * RESULT envelope v1, exit codes, and per-case state isolation. Phase 2 adds
 * host-side checks for the four former SKIP cases, at the level that is
 * honestly testable without a model: pure host decisions (step cap boundary,
 * handover file round-trip, tool-definition guard, review gate contract with
 * a scripted reviewer, committed_unverified classification and report).
 *
 * What these Phase 2 cases do NOT prove is stated in GENERIC_MOCK_NOTES.md:
 * a scripted reviewer blocking a tampered summary does not prove a real
 * model reviewer would catch a tamper; a step-cap decision boundary does
 * not prove the live worker driver fires the steer at the 51st call. Those
 * remain open items, not hidden passes.
 *
 * Usage:
 *   node --import tsx scripts/eval/generic-mock.ts [--write-baseline] [--only <id,...>]
 * Exit codes (mirroring scripts/eval/score.ts):
 *   0 = all cases pass and match the baseline (where a baseline exists)
 *   1 = a case fails, or a checked value regressed vs the baseline
 *   2 = baseline missing / corpus-baseline mismatch (run with --write-baseline first)
 *
 * Baseline file: scripts/eval/generic-mock-baseline.json. It records, per case,
 * the expected status / exit code / envelope code / count that the dummy must
 * produce. It is NOT a judge score: there is no model in this loop, so there
 * is nothing for a judge to score. The Main-agent L1 trustworthiness baseline
 * (A1/A2/A3/A4/A5/B1/Y2 with a real model) is a separate artefact and is
 * explicitly NOT produced by this script; see GENERIC_MOCK_NOTES.md.
 */
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Host pure modules, imported by relative path (this script runs under tsx,
// not vitest, so the @fshine/agent alias is not available here).
import { DEFAULT_WORKER_STEP_CAP, parseStepCap, stepCapDecision } from '../../packages/agent/src/worker-step-cap';
import { HANDOVER_VERSION, handoverFilePath, mergeExecutedCalls, parseHandover, readHandoverFile, writeHandoverFile, type TaskHandover } from '../../packages/agent/src/task-handover';
import { mechanicalReview, parseReviewReply } from '../../packages/agent/src/proposal-review';
import { isCommittedUnverified, renderCommittedUnverifiedReply } from '../../packages/agent/src/committed-unverified';
import { decideToolDefinitionGuard } from '../../packages/agent/src/tool-definition-guard';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(evalDir, '..', '..');
const fixtureRoot = path.join(evalDir, 'fixtures', 'dummy-platform');
// Generic gateway entry point (bin/generic -> dummy); the eval proves the
// orchestration layer works through the generic gateway name, not the dummy's
// own file name and not any execution-layer instance's gateway name.
const dummyBin = path.join(fixtureRoot, 'bin', 'generic');
const BASELINE_PATH = path.join(evalDir, 'generic-mock-baseline.json');

interface Check { name: string; pass: boolean; expected: string; actual: string }
interface CaseResult { id: string; pass: boolean; skipped?: boolean; skipReason?: string; checks: Check[] }
interface RunResult { code: number; stdout: string; stderr: string }
interface Envelope { v: number; op: string; status: string; data: Record<string, unknown> | null; error: { code: string; message: string; correctForm?: string } | null }

function parseEnvelope(stdout: string): Envelope | null {
  const m = stdout.match(/^RESULT (\{.*\})\s*$/m);
  if (!m) return null;
  try { const e = JSON.parse(m[1]!) as Envelope; return e.v === 1 ? e : null; } catch { return null; }
}
class Ctx {
  dir: string;
  env: NodeJS.ProcessEnv;
  constructor() {
    this.dir = mkdtempSync(path.join(os.tmpdir(), 'generic-mock-'));
    this.env = {
      ...process.env,
      DUMMY_STATE: path.join(this.dir, 'state.json'),
      DUMMY_PLAN_STATE: path.join(this.dir, 'plans.json'),
      DUMMY_PROPOSAL_STATE: path.join(this.dir, 'proposals.json'),
      DUMMY_AUDIT_PATH: path.join(this.dir, 'audit.jsonl'),
      DUMMY_PLAN_ACTIVATION_SECRET: 'generic-mock-plan-secret',
      DUMMY_GATE_SECRET: 'generic-mock-gate-secret',
    };
  }
  run(args: string[], input?: string): RunResult {
    const r = spawnSync(dummyBin, args, { encoding: 'utf8', cwd: fixtureRoot, env: this.env, input });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }
  cleanup() { try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

function check(name: string, pass: boolean, expected: string, actual: string): Check { return { name, pass, expected, actual }; }
function proposalToken(proposalId: string, expiresAt: string, secret: string): string {
  // Must match dummy.cjs verifyProposalToken: HMAC-SHA256 over base64url({proposalId, expiresAt}).
  const body = Buffer.from(JSON.stringify({ proposalId, expiresAt })).toString('base64url');
  return `${body}.${Buffer.from(createHmac('sha256', secret).update(body).digest()).toString('base64url')}`;
}
function planToken(planId: string, evidence: string, secret: string): string {
  const expires = Date.now() + 60_000;
  const body = Buffer.from(JSON.stringify({ planId, evidence, expires })).toString('base64url');
  return `${body}.${Buffer.from(createHmac('sha256', secret).update(body).digest()).toString('base64url')}`;
}
function writePayload(ctx: Ctx, payload: Record<string, unknown>): string {
  const file = path.join(ctx.dir, `payload-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(payload));
  return file;
}
function createProposal(ctx: Ctx, payload: Record<string, unknown>): { env: Envelope | null; run: RunResult } {
  const file = writePayload(ctx, payload);
  const run = ctx.run(['prepare', 'dummy.proposal', file]);
  return { env: parseEnvelope(run.stdout), run };
}

const cases: Array<{ id: string; run: (ctx: Ctx) => CaseResult | Promise<CaseResult> }> = [
  { id: 'smoke-query', run: (ctx) => {
    const r = ctx.run(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1']);
    const e = parseEnvelope(r.stdout);
    return { id: 'smoke-query', pass: r.code === 0 && e?.status === 'completed' && (e.data?.count as number) === 2,
      checks: [check('exit', r.code === 0, '0', String(r.code)), check('status', e?.status === 'completed', 'completed', String(e?.status)), check('count', (e?.data?.count as number) === 2, '2', String(e?.data?.count))] };
  } },
  { id: 'smoke-prepare-commit', run: (ctx) => {
    const checks: Check[] = [];
    const before = parseEnvelope(ctx.run(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1']).stdout);
    const beforeCount = before?.data?.count as number;
    const prep = ctx.run(['prepare', 'dummy.prepare', '--collection', 'alpha', '--window', 'W1', '--count', '1']);
    const prepEnv = parseEnvelope(prep.stdout);
    checks.push(check('prepare dry-run, no write', prep.code === 0 && prepEnv?.status === 'completed' && (prepEnv.data as Record<string, unknown>)?.dryRun === true, 'completed dryRun=true', `${prep.code} ${prepEnv?.status}`));
    const mid = parseEnvelope(ctx.run(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1']).stdout);
    checks.push(check('prepare did not change count', (mid?.data?.count as number) === beforeCount, String(beforeCount), String(mid?.data?.count)));
    const { env, run } = createProposal(ctx, { collection: 'alpha', window: 'W1', records: [{ name: 'new-item-1', value: 400 }] });
    const proposalId = env?.data?.proposalId as string;
    checks.push(check('proposal created pending', run.code === 0 && env?.status === 'completed' && typeof proposalId === 'string' && (env.data as Record<string, unknown>)?.status === 'pending', 'completed pending + proposalId', `${run.code} ${env?.status}`));
    const status = ctx.run(['proposal', 'status', '--proposal-id', proposalId]);
    checks.push(check('proposal status pending', status.stdout.includes('"status":"pending"'), 'pending', status.stdout.trim()));
    const token = proposalToken(proposalId, (env!.data as Record<string, unknown>).expiresAt as string, 'generic-mock-gate-secret');
    // Commit token travels via env, not argv.
    const savedEnv = ctx.env;
    ctx.env = { ...savedEnv, DUMMY_COMMIT_TOKEN: token };
    const commit2 = ctx.run(['commit', 'dummy.proposal-commit', '--proposal-id', proposalId]);
    ctx.env = savedEnv;
    const commitEnv = parseEnvelope(commit2.stdout);
    checks.push(check('commit verified', commit2.code === 0 && commitEnv?.status === 'completed' && (commitEnv.data as Record<string, unknown>)?.verified === true, 'completed verified=true', `${commit2.code} ${commitEnv?.status}`));
    const after = parseEnvelope(ctx.run(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1']).stdout);
    checks.push(check('readback delta = required', (after?.data?.count as number) === beforeCount + 1, String(beforeCount + 1), String(after?.data?.count)));
    const second = ctx.run(['commit', 'dummy.proposal-commit', '--proposal-id', proposalId]);
    checks.push(check('second commit refused, no double count', second.code === 3, 'exit 3', String(second.code)));
    const after2 = parseEnvelope(ctx.run(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1']).stdout);
    checks.push(check('no double count after refused second commit', (after2?.data?.count as number) === beforeCount + 1, String(beforeCount + 1), String(after2?.data?.count)));
    return { id: 'smoke-prepare-commit', pass: checks.every((c) => c.pass), checks };
  } },
  { id: 'smoke-not-found', run: (ctx) => {
    const checks: Check[] = [];
    const nope = ctx.run(['query', 'dummy.query', '--collection', 'nope']);
    const nopeEnv = parseEnvelope(nope.stdout);
    checks.push(check('unknown collection not_found exit 0', nope.code === 0 && nopeEnv?.status === 'not_found' && nopeEnv.error?.code === 'COLLECTION_NOT_FOUND', '0 not_found COLLECTION_NOT_FOUND', `${nope.code} ${nopeEnv?.status} ${nopeEnv?.error?.code}`));
    const win = ctx.run(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W9']);
    const winEnv = parseEnvelope(win.stdout);
    checks.push(check('missing window not_found with availableWindows', win.code === 0 && winEnv?.status === 'not_found' && winEnv.error?.code === 'WINDOW_NO_DATA' && Array.isArray((winEnv.data as Record<string, unknown>)?.availableWindows), '0 not_found WINDOW_NO_DATA + availableWindows', `${win.code} ${winEnv?.status} ${winEnv?.error?.code}`));
    const empty = ctx.run(['query', 'dummy.query', '--collection', 'empty-one']);
    const emptyEnv = parseEnvelope(empty.stdout);
    checks.push(check('zero is completed, never not_found', empty.code === 0 && emptyEnv?.status === 'completed' && (emptyEnv.data?.count as number) === 0, '0 completed count 0', `${empty.code} ${emptyEnv?.status} ${emptyEnv?.data?.count}`));
    return { id: 'smoke-not-found', pass: checks.every((c) => c.pass), checks };
  } },
  { id: 'g-a1-requery', run: (ctx) => {
    const a = parseEnvelope(ctx.run(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1']).stdout);
    const b = parseEnvelope(ctx.run(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1']).stdout);
    const same = JSON.stringify(a?.data) === JSON.stringify(b?.data);
    return { id: 'g-a1-requery', pass: same, checks: [check('requery returns identical data', same, 'identical', same ? 'identical' : 'differed')] };
  } },
  { id: 'g-a2-cross-contamination', run: (ctx) => {
    const a = parseEnvelope(ctx.run(['query', 'dummy.query', '--collection', 'alpha']).stdout);
    const b = parseEnvelope(ctx.run(['query', 'dummy.query', '--collection', 'beta']).stdout);
    const aNames = ((a?.data as Record<string, unknown>)?.items as Array<{ name: string }> ?? []).map((i) => i.name);
    const bNames = ((b?.data as Record<string, unknown>)?.items as Array<{ name: string }> ?? []).map((i) => i.name);
    const overlap = aNames.filter((n) => bNames.includes(n));
    const amb = parseEnvelope(ctx.run(['query', 'dummy.query', '--collection', 'alp']).stdout);
    const ambCandidates = ((amb?.data as Record<string, unknown>)?.candidates as Array<{ name: string }> ?? []).map((c) => c.name);
    return { id: 'g-a2-cross-contamination', pass: overlap.length === 0 && amb?.status === 'needs_input' && ambCandidates.join(',') === 'alpha,alpha-group',
      checks: [check('alpha/beta items do not overlap', overlap.length === 0, 'no overlap', overlap.join(',') || 'none'), check('ambiguous returns needs_input with exact candidates', amb?.status === 'needs_input' && ambCandidates.join(',') === 'alpha,alpha-group', 'needs_input alpha,alpha-group', `${amb?.status} ${ambCandidates.join(',')}`)] };
  } },
  { id: 'g-a3-ambiguity-mechanical', run: (ctx) => {
    const r = ctx.run(['query', 'dummy.query', '--collection', 'alp']);
    const e = parseEnvelope(r.stdout);
    const leaked = /src\/|\.cjs|\.js\b|bin\//.test(JSON.stringify(e?.data ?? {}));
    return { id: 'g-a3-ambiguity-mechanical', pass: e?.status === 'needs_input' && !leaked && typeof e.error?.correctForm === 'string',
      checks: [check('needs_input only, no script path in data', e?.status === 'needs_input' && !leaked, 'needs_input, no path leak', `${e?.status} leaked=${leaked}`), check('correctForm present', typeof e?.error?.correctForm === 'string', 'correctForm string', String(e?.error?.correctForm))] };
  } },
  { id: 'g-a4-not-found-zero-leak', run: (ctx) => {
    const r = ctx.run(['query', 'dummy.query', '--collection', 'nope']);
    const e = parseEnvelope(r.stdout);
    const leaked = /src\/|\.cjs|bin\/dummy/.test(JSON.stringify(e?.data ?? {}));
    return { id: 'g-a4-not-found-zero-leak', pass: e?.status === 'not_found' && !leaked,
      checks: [check('not_found only, no script path in data', e?.status === 'not_found' && !leaked, 'not_found, no leak', `${e?.status} leaked=${leaked}`)] };
  } },
  { id: 'g-a5-idle-zero-calls', run: (ctx) => {
    // Idle analogue: with a fresh state dir and no dummy invocation, no audit line exists.
    const auditFile = ctx.env.DUMMY_AUDIT_PATH!;
    const exists = existsSync(auditFile);
    return { id: 'g-a5-idle-zero-calls', pass: !exists, checks: [check('idle produces no audit line', !exists, 'no audit file', exists ? 'audit file exists' : 'no audit file')] };
  } },
  { id: 'g-b1-stability', run: (ctx) => {
    const counts: number[] = [];
    for (let i = 0; i < 5; i += 1) { const e = parseEnvelope(ctx.run(['query', 'dummy.query', '--collection', 'beta']).stdout); counts.push(e?.data?.count as number); }
    const stable = counts.every((c) => c === 3);
    return { id: 'g-b1-stability', pass: stable, checks: [check('5 repeated queries identical count', stable, '3,3,3,3,3', counts.join(','))] };
  } },
  { id: 'g-y2-error-honesty', run: (ctx) => {
    const checks: Check[] = [];
    const before = parseEnvelope(ctx.run(['query', 'dummy.query', '--collection', 'locked-one']).stdout);
    const prep = ctx.run(['prepare', 'dummy.prepare', '--collection', 'locked-one']);
    const prepEnv = parseEnvelope(prep.stdout);
    checks.push(check('locked collection refused exit 2', prep.code === 2 && prepEnv?.error?.code === 'COLLECTION_LOCKED', '2 COLLECTION_LOCKED', `${prep.code} ${prepEnv?.error?.code}`));
    const missing = ctx.run(['query', 'dummy.query']);
    const missingEnv = parseEnvelope(missing.stdout);
    checks.push(check('missing required flag failed exit 1', missing.code === 1 && missingEnv?.error?.code === 'QUERY_REQUIRED', '1 QUERY_REQUIRED', `${missing.code} ${missingEnv?.error?.code}`));
    const after = parseEnvelope(ctx.run(['query', 'dummy.query', '--collection', 'locked-one']).stdout);
    checks.push(check('refused calls changed nothing', JSON.stringify(before?.data) === JSON.stringify(after?.data), 'unchanged', JSON.stringify(before?.data) === JSON.stringify(after?.data) ? 'unchanged' : 'changed'));
    return { id: 'g-y2-error-honesty', pass: checks.every((c) => c.pass), checks };
  } },
  { id: 'g-plan-gate', run: (ctx) => {
    const checks: Check[] = [];
    const evalRun = ctx.run(['plan', 'evaluate', '--task-id', 'task-plan', '--stdin'], JSON.stringify({ calls: [{ operation: 'dummy.query', args: ['--collection', 'alpha'] }] }));
    const evalJson = JSON.parse(evalRun.stdout);
    checks.push(check('plan execute decision', evalRun.code === 0 && evalJson.decision === 'execute' && evalJson.status === 'active', 'execute active', `${evalRun.code} ${evalJson.decision} ${evalJson.status}`));
    const bad = ctx.run(['plan', 'evaluate', '--task-id', 'task-plan-bad', '--stdin'], JSON.stringify({ calls: [{ operation: 'dummy.commit', args: [] }] }));
    checks.push(check('plan rejects non-read-only call', bad.code === 2 && bad.stderr.includes('not read-only'), 'exit 2 not read-only', `${bad.code} ${bad.stderr.trim()}`));
    const unknown = ctx.run(['plan', 'evaluate', '--task-id', 'task-plan-bad2', '--stdin'], JSON.stringify({ calls: [{ operation: 'dummy.query', args: [] }], bogus: 1 }));
    checks.push(check('plan rejects unknown field', unknown.code === 2 && unknown.stderr.includes('unknown field'), 'exit 2 unknown field', `${unknown.code} ${unknown.stderr.trim()}`));
    // Activate a confirm plan: 40 query calls weigh 80 >= budget 60 -> confirm,
    // while calls 40 <= hard 50 and seconds 400 <= hard 1800, so the weight line
    // (not the calls line) is what stops it at confirm. With weight 1 this case
    // would hit hardCalls first and stop instead -- that was the first-run bug.
    const bigCalls = Array.from({ length: 40 }, () => ({ operation: 'dummy.query', args: ['--collection', 'alpha'] }));
    const big = ctx.run(['plan', 'evaluate', '--task-id', 'task-big', '--stdin'], JSON.stringify({ calls: bigCalls }));
    const bigJson = JSON.parse(big.stdout);
    checks.push(check('budget-weight plan stops at confirm', bigJson.decision === 'confirm' && bigJson.status === 'pending', 'confirm pending', `${bigJson.decision} ${bigJson.status}`));
    const token = planToken(bigJson.planId, 'user-confirmed', 'generic-mock-plan-secret');
    const act = ctx.run(['plan', 'activate', '--stdin'], JSON.stringify({ planId: bigJson.planId, evidence: 'user-confirmed', token }));
    checks.push(check('plan activate with host token', act.code === 0 && JSON.parse(act.stdout).status === 'active', 'active', `${act.code} ${act.stdout.trim()}`));
    const badToken = ctx.run(['plan', 'activate', '--stdin'], JSON.stringify({ planId: bigJson.planId, evidence: 'user-confirmed', token: 'bad.token' }));
    checks.push(check('plan activate with bad token refused', badToken.code === 3, 'exit 3', String(badToken.code)));
    return { id: 'g-plan-gate', pass: checks.every((c) => c.pass), checks };
  } },
  { id: 'g-serve-matrix', run: (ctx) => {
    const checks: Check[] = [];
    const q = ctx.run(['query', 'dummy.commit', '--collection', 'alpha']);
    checks.push(check('query refuses always-write', q.code === 3, 'exit 3', String(q.code)));
    const p = ctx.run(['prepare', 'dummy.prepare', '--collection', 'alpha', '--apply']);
    checks.push(check('prepare refuses write-flagged call', p.code === 3, 'exit 3', String(p.code)));
    const u = ctx.run(['query', 'dummy.nope', '--collection', 'alpha']);
    checks.push(check('unregistered script refused', u.code === 3, 'exit 3', String(u.code)));
    const list = ctx.run(['operation', 'list', '--json']);
    const parsed = JSON.parse(list.stdout);
    const semantics = parsed.accessSemantics;
    checks.push(check('accessSemantics read/scratch/write', semantics.read.plan === true && semantics.read.confirm === false && semantics.scratch.plan === false && semantics.write.confirm === true, 'read{plan,¬confirm} scratch{¬plan} write{confirm}', JSON.stringify(semantics)));
    const protocols = Object.fromEntries(parsed.operations.map((o: Record<string, unknown>) => [o.name, o.protocol]));
    checks.push(check('protocol roles present', protocols['dummy.proposal'] === 'proposal.create' && protocols['dummy.proposal-commit'] === 'proposal.commit', 'proposal.create / proposal.commit', JSON.stringify(protocols)));
    return { id: 'g-serve-matrix', pass: checks.every((c) => c.pass), checks };
  } },
  { id: 'g-readback-short', run: (ctx) => {
    const checks: Check[] = [];
    const before = parseEnvelope(ctx.run(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1']).stdout);
    const beforeCount = before?.data?.count as number;
    const { env, run } = createProposal(ctx, { collection: 'alpha', window: 'W1', records: [{ name: 'short-1', value: 100 }, { name: 'short-2', value: 200 }] });
    const proposalId = env?.data?.proposalId as string;
    checks.push(check('short proposal created', run.code === 0 && typeof proposalId === 'string', 'proposalId', String(proposalId)));
    const token = proposalToken(proposalId, (env!.data as Record<string, unknown>).expiresAt as string, 'generic-mock-gate-secret');
    const saved = ctx.env;
    // Test-only env for this one commit call (never a payload field).
    ctx.env = { ...saved, DUMMY_COMMIT_TOKEN: token, DUMMY_READBACK_SHORT: '1' };
    const commit = ctx.run(['commit', 'dummy.proposal-commit', '--proposal-id', proposalId]);
    ctx.env = saved;
    const commitEnv = parseEnvelope(commit.stdout);
    const readBack = commitEnv?.data?.readBack as Record<string, number> | undefined;
    checks.push(check('readback short is failed, verified=false, delta < required', commitEnv?.status === 'failed' && (commitEnv?.data as Record<string, unknown>)?.verified === false && (readBack?.delta ?? 99) < (readBack?.required ?? 0), 'failed verified=false delta<required', `${commitEnv?.status} verified=${(commitEnv?.data as Record<string, unknown>)?.verified} delta=${readBack?.delta} required=${readBack?.required}`));
    const classified = commitEnv?.status === 'failed' && (commitEnv?.data as Record<string, unknown>)?.verified === false ? 'committed_unverified' : 'completed';
    checks.push(check('host classification must be committed_unverified, never completed', classified === 'committed_unverified', 'committed_unverified', classified));
    const status = ctx.run(['proposal', 'status', '--proposal-id', proposalId]);
    checks.push(check('short proposal is committed, not pending (no second commit)', status.stdout.includes('"status":"committed"'), 'committed', status.stdout.trim()));
    const after = parseEnvelope(ctx.run(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1']).stdout);
    checks.push(check('partial count applied, not full', (after?.data?.count as number) === beforeCount + 1, String(beforeCount + 1), String(after?.data?.count)));
    return { id: 'g-readback-short', pass: checks.every((c) => c.pass), checks };
  } },
  { id: 'g-proposal-expired', run: (ctx) => {
    const checks: Check[] = [];
    const { env } = createProposal(ctx, { collection: 'alpha', window: 'W1', records: [{ name: 'exp-1', value: 100 }] });
    const proposalId = env?.data?.proposalId as string;
    // Test-only state manipulation: move expiresAt into the past (documented in notes).
    const proposalFile = ctx.env.DUMMY_PROPOSAL_STATE!;
    const state = JSON.parse(readFileSync(proposalFile, 'utf8'));
    state.proposals[proposalId].expiresAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(proposalFile, JSON.stringify(state, null, 2));
    const token = proposalToken(proposalId, (env!.data as Record<string, unknown>).expiresAt as string, 'generic-mock-gate-secret');
    const saved = ctx.env;
    ctx.env = { ...saved, DUMMY_COMMIT_TOKEN: token };
    const commit = ctx.run(['commit', 'dummy.proposal-commit', '--proposal-id', proposalId]);
    ctx.env = saved;
    const commitEnv = parseEnvelope(commit.stdout);
    checks.push(check('expired proposal refused exit 3', commit.code === 3 && commitEnv?.error?.code === 'PROPOSAL_EXPIRED', '3 PROPOSAL_EXPIRED', `${commit.code} ${commitEnv?.error?.code}`));
    const before = parseEnvelope(ctx.run(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1']).stdout);
    checks.push(check('expired commit wrote nothing (count unchanged from seed)', (before?.data?.count as number) === 2, '2', String(before?.data?.count)));
    return { id: 'g-proposal-expired', pass: checks.every((c) => c.pass), checks };
  } },
  { id: 'g-proposal-token-untrusted', run: (ctx) => {
    const { env } = createProposal(ctx, { collection: 'alpha', window: 'W1', records: [{ name: 'tok-1', value: 100 }] });
    const proposalId = env?.data?.proposalId as string;
    const saved = ctx.env;
    ctx.env = { ...saved, DUMMY_COMMIT_TOKEN: 'bad.token' };
    const commit = ctx.run(['commit', 'dummy.proposal-commit', '--proposal-id', proposalId]);
    ctx.env = saved;
    const commitEnv = parseEnvelope(commit.stdout);
    return { id: 'g-proposal-token-untrusted', pass: commit.code === 3 && commitEnv?.error?.code === 'PROPOSAL_TOKEN_UNTRUSTED',
      checks: [check('bad token refused exit 3', commit.code === 3 && commitEnv?.error?.code === 'PROPOSAL_TOKEN_UNTRUSTED', '3 PROPOSAL_TOKEN_UNTRUSTED', `${commit.code} ${commitEnv?.error?.code}`)] };
  } },
  { id: 'g-state-isolation', run: (ctx) => {
    const ctx2 = new Ctx();
    try {
      // Isolation is checked via proposal commits: both contexts start from the same
      // seed, only the context that commits sees its count move.
      const p1 = createProposal(ctx, { collection: 'beta', window: 'W1', records: [{ name: 'iso-1', value: 10 }] });
      const id1 = p1.env?.data?.proposalId as string;
      const tok1 = proposalToken(id1, (p1.env!.data as Record<string, unknown>).expiresAt as string, 'generic-mock-gate-secret');
      const saved = ctx.env; ctx.env = { ...saved, DUMMY_COMMIT_TOKEN: tok1 };
      ctx.run(['commit', 'dummy.proposal-commit', '--proposal-id', id1]); ctx.env = saved;
      const betaA = parseEnvelope(ctx.run(['query', 'dummy.query', '--collection', 'beta']).stdout);
      const betaB = parseEnvelope(ctx2.run(['query', 'dummy.query', '--collection', 'beta']).stdout);
      return { id: 'g-state-isolation', pass: (betaA?.data?.count as number) === 4 && (betaB?.data?.count as number) === 3,
        checks: [check('case A count moved, case B still seed', (betaA?.data?.count as number) === 4 && (betaB?.data?.count as number) === 3, '4 / 3', `${betaA?.data?.count} / ${betaB?.data?.count}`)] };
    } finally { ctx2.cleanup(); }
  } },
  { id: 'g-step-cap-50-51', run: () => {
    // Phase 2, host pure decision only: the boundary is 50 normal / 51
    // wind-down, configurable, invalid values fall back to 50. This does
    // NOT prove the live worker driver fires its steer at the 51st allowed
    // bash — that wiring is code, not a live worker run, and is listed as
    // an open item in GENERIC_MOCK_NOTES.md.
    const checks: Check[] = [
      check('default cap is 50', DEFAULT_WORKER_STEP_CAP === 50, '50', String(DEFAULT_WORKER_STEP_CAP)),
      check('50 calls: no wind-down', stepCapDecision(50).windDown === false, 'false', String(stepCapDecision(50).windDown)),
      check('51 calls: wind-down', stepCapDecision(51).windDown === true, 'true', String(stepCapDecision(51).windDown)),
      check('51 calls: remaining 0', stepCapDecision(51).remaining === 0, '0', String(stepCapDecision(51).remaining)),
      check('custom cap 2 fires at 3', stepCapDecision(3, 2).windDown === true && stepCapDecision(2, 2).windDown === false, '2 no, 3 yes', `${stepCapDecision(2, 2).windDown}/${stepCapDecision(3, 2).windDown}`),
      check('invalid cap falls back to 50', parseStepCap('abc') === 50 && parseStepCap(0) === 50, '50', `${parseStepCap('abc')}/${parseStepCap(0)}`),
    ];
    return { id: 'g-step-cap-50-51', pass: checks.every((c) => c.pass), checks };
  } },
  { id: 'g-handover-file', run: () => {
    // Phase 2, host handover file: write at the task workspace path,
    // read back identical, resume merge does not double-count, corrupt
    // or missing files fail closed to null. No worker text is involved:
    // fields are host facts only.
    const root = mkdtempSync(path.join(os.tmpdir(), 'generic-mock-handover-'));
    try {
      const handover: TaskHandover = {
        version: HANDOVER_VERSION, taskId: 'task-1', planId: 'plan-1', planVersion: 2,
        completedSteps: ['dummy.query --collection alpha'],
        executedCalls: [{ operation: 'dummy.query', args: ['--collection', 'alpha'] }],
        unfinishedSteps: ['step-b'], nextAction: 'run step-b', lastResultSummary: 'alpha read ok',
        updatedAt: '2026-11-04T00:00:00.000Z',
      };
      const file = writeHandoverFile(root, 'task-1', handover);
      const read = readHandoverFile(root, 'task-1');
      const merged = mergeExecutedCalls(handover.executedCalls, [
        { operation: 'dummy.query', args: ['--collection', 'alpha'] },
        { operation: 'dummy.query', args: ['--collection', 'beta'] },
      ]);
      const checks: Check[] = [
        check('handover path is tmp/<taskId>/handover.json', file === handoverFilePath(root, 'task-1') && file.endsWith(path.join('tmp', 'task-1', 'handover.json')), 'tmp/task-1/handover.json', file),
        check('round-trip identical', JSON.stringify(read) === JSON.stringify(handover), 'identical', read ? 'identical' : 'null'),
        check('resume merge does not double-count', merged.length === 2, '2', String(merged.length)),
        check('wrong version parses to null', parseHandover(JSON.stringify({ ...handover, version: 99 })) === null, 'null', String(parseHandover(JSON.stringify({ ...handover, version: 99 })))),
        check('missing file reads to null', readHandoverFile(root, 'task-missing') === null, 'null', String(readHandoverFile(root, 'task-missing'))),
      ];
      return { id: 'g-handover-file', pass: checks.every((c) => c.pass), checks };
    } finally { rmSync(root, { recursive: true, force: true }); }
  } },
  { id: 'g-tool-definition-removed', run: () => {
    // Phase 2, scripted: no model is run. The guard reads only whether
    // tools were present and whether execution occurred, never the model
    // prose — so a confident formatted answer cannot talk it out of
    // blocking. The full turn-exit proof (a formatted fake answer with
    // zero execution is not passed through) lives in
    // packages/agent/src/phase2.test.ts, where the vitest alias resolves.
    const blocked = decideToolDefinitionGuard({ toolsPresent: false, execution: false });
    const withTools = decideToolDefinitionGuard({ toolsPresent: true, execution: false });
    const withExecution = decideToolDefinitionGuard({ toolsPresent: false, execution: true });
    const checks: Check[] = [
      check('tools removed + zero execution blocks', blocked.blocked === true, 'blocked', String(blocked.blocked)),
      check('tools present does not block', withTools.blocked === false, 'not blocked', String(withTools.blocked)),
      check('execution present does not block', withExecution.blocked === false, 'not blocked', String(withExecution.blocked)),
    ];
    return { id: 'g-tool-definition-removed', pass: checks.every((c) => c.pass), checks };
  } },
  { id: 'g-tampered-summary-review', run: () => {
    // Phase 2, scripted reviewer contract: the reviewer here is a fixed
    // function, NOT a model — it proves the host gate (inconsistent =>
    // no confirmation code; consistent => code), not that a real model
    // would catch a tamper. Mechanical pre-checks need no reviewer at
    // all: a failed dry-run or an empty summary is inconsistent by
    // construction. The real-model tamper-detection proof is still open.
    const scriptedReview = (summaryText: string): { verdict: 'consistent' | 'inconsistent'; fields: string[] } =>
      summaryText.includes('TAMPERED') ? { verdict: 'inconsistent', fields: ['summaryText'] } : { verdict: 'consistent', fields: [] };
    const tampered = scriptedReview('TAMPERED summary: 999 records');
    const clean = scriptedReview('2 records, alpha W1');
    const codeIssuedFor = (verdict: 'consistent' | 'inconsistent'): boolean => verdict === 'consistent';
    const failedDryRun = mechanicalReview({ proposalSchema: {}, dryRunEnvelope: { status: 'failed' }, summaryText: 'x' });
    const emptySummary = mechanicalReview({ proposalSchema: {}, dryRunEnvelope: { status: 'completed' }, summaryText: '  ' });
    const parsed = parseReviewReply('{"verdict":"consistent","fields":[]}');
    const garbage = parseReviewReply('looks fine');
    const checks: Check[] = [
      check('tampered summary blocks the code', tampered.verdict === 'inconsistent' && codeIssuedFor(tampered.verdict) === false, 'inconsistent, no code', `${tampered.verdict} code=${codeIssuedFor(tampered.verdict)}`),
      check('consistent summary issues the code', clean.verdict === 'consistent' && codeIssuedFor(clean.verdict) === true, 'consistent, code', `${clean.verdict} code=${codeIssuedFor(clean.verdict)}`),
      check('failed dry-run is inconsistent without a model', failedDryRun?.verdict === 'inconsistent', 'inconsistent', String(failedDryRun?.verdict)),
      check('empty summary is inconsistent without a model', emptySummary?.verdict === 'inconsistent', 'inconsistent', String(emptySummary?.verdict)),
      check('strict-JSON consistent reply parses', parsed?.verdict === 'consistent', 'consistent', String(parsed?.verdict)),
      check('non-JSON reply parses to null (fail-closed)', garbage === null, 'null', String(garbage)),
    ];
    return { id: 'g-tampered-summary-review', pass: checks.every((c) => c.pass), checks };
  } },
  { id: 'g-committed-unverified-report', run: () => {
    // Phase 2, host terminal report: the dummy already proves the platform
    // side (g-readback-short); this case proves the host side — the
    // classifier and the user-facing report. The report must say posted /
    // readback short / needs human reconciliation, and must never say
    // completed.
    const text = renderCommittedUnverifiedReply({ before: 1, after: 2, delta: 1, required: 2 });
    const checks: Check[] = [
      check('readback-short classifies committed_unverified', isCommittedUnverified({ ok: false, verified: false, errorCode: 'PROPOSAL_VERIFY_SHORT' }) === true, 'true', String(isCommittedUnverified({ ok: false, verified: false, errorCode: 'PROPOSAL_VERIFY_SHORT' }))),
      check('delta < required classifies committed_unverified', isCommittedUnverified({ ok: false, verified: false, readBack: { before: 1, after: 2, delta: 1, required: 2 } }) === true, 'true', String(isCommittedUnverified({ ok: false, verified: false, readBack: { before: 1, after: 2, delta: 1, required: 2 } }))),
      check('success does not classify committed_unverified', isCommittedUnverified({ ok: true, verified: true }) === false, 'false', String(isCommittedUnverified({ ok: true, verified: true }))),
      check('report states posted + readback short + reconciliation', text.includes('已落账、读回不足、需人工核对') && text.includes('人工核对入口'), 'both lines', text.split('\n')[0] ?? ''),
      check('report never says completed', !text.includes('已完成'), 'no 已完成', text.includes('已完成') ? 'contains 已完成' : 'absent'),
    ];
    return { id: 'g-committed-unverified-report', pass: checks.every((c) => c.pass), checks };
  } },
  { id: 'g-ballot-second-domain', run: (ctx) => {
    const checks: Check[] = [];
    const list = ctx.run(['operation', 'list', '--json']);
    const parsed = JSON.parse(list.stdout);
    const names = parsed.operations.map((o: Record<string, unknown>) => o.name as string);
    checks.push(check('ballot operations present in list', names.filter((n) => n.startsWith('ballot.')).length === 6, '6 ballot ops', `${names.filter((n) => n.startsWith('ballot.')).length} ballot ops`));
    const ballotOps = parsed.operations.filter((o: Record<string, unknown>) => (o.name as string).startsWith('ballot.'));
    checks.push(check('ballot query is read', ballotOps.find((o: Record<string, unknown>) => o.name === 'ballot.query')?.access === 'read', 'read', String(ballotOps.find((o: Record<string, unknown>) => o.name === 'ballot.query')?.access)));
    checks.push(check('ballot prepare/commit are write', ballotOps.find((o: Record<string, unknown>) => o.name === 'ballot.prepare')?.access === 'write' && ballotOps.find((o: Record<string, unknown>) => o.name === 'ballot.commit')?.access === 'write', 'write+write', `${ballotOps.find((o: Record<string, unknown>) => o.name === 'ballot.prepare')?.access}/${ballotOps.find((o: Record<string, unknown>) => o.name === 'ballot.commit')?.access}`));
    // Read path: ballot.query --topic alpha
    const q = ctx.run(['query', 'ballot.query', '--topic', 'alpha']);
    const qEnv = parseEnvelope(q.stdout);
    checks.push(check('ballot.query returns completed', q.code === 0 && qEnv?.status === 'completed', '0 completed', `${q.code} ${qEnv?.status}`));
    // Write path via proposal: ballot.prepare (dry-run) + ballot.proposal + ballot.proposal-commit
    const prep = ctx.run(['prepare', 'ballot.prepare', '--topic', 'alpha', '--count', '2']);
    const prepEnv = parseEnvelope(prep.stdout);
    const prepOk = prep.code === 0 && prepEnv !== null && prepEnv.status === 'completed';
    const prepDryRun = prepEnv && (prepEnv.data as Record<string, unknown> | null)?.dryRun === true;
    checks.push(check('ballot.prepare dry-run', prepOk && prepDryRun, 'completed dryRun=true', `${prep.code} ${prepEnv?.status}`));
    const mid = ctx.run(['query', 'ballot.query', '--topic', 'alpha']);
    const midEnv = parseEnvelope(mid.stdout);
    const midCount = midEnv && midEnv.data ? (midEnv.data as Record<string, unknown>).count as number : -1;
    const qCount = qEnv && qEnv.data ? (qEnv.data as Record<string, unknown>).count as number : -1;
    checks.push(check('ballot.prepare did not change count', midCount === qCount, String(qCount), String(midCount)));
    // Create ballot proposal
    const payloadFile = writePayload(ctx, { collection: 'alpha', window: 'R1', records: [{ name: 'vote-1', value: 100 }] });
    const { env: propEnv, run: propRun } = createProposal(ctx, { collection: 'alpha', window: 'R1', records: [{ name: 'vote-1', value: 100 }] });
    const proposalId = propEnv?.data?.proposalId as string;
    checks.push(check('ballot proposal created pending', propRun.code === 0 && propEnv?.status === 'completed' && typeof proposalId === 'string' && (propEnv.data as Record<string, unknown>)?.status === 'pending', 'completed pending + proposalId', `${propRun.code} ${propEnv?.status}`));
    const token = proposalToken(proposalId, (propEnv!.data as Record<string, unknown>).expiresAt as string, 'generic-mock-gate-secret');
    const savedEnv = ctx.env;
    ctx.env = { ...savedEnv, DUMMY_COMMIT_TOKEN: token };
    const commit2 = ctx.run(['commit', 'ballot.proposal-commit', '--proposal-id', proposalId]);
    ctx.env = savedEnv;
    const commitEnv = parseEnvelope(commit2.stdout);
    const commitOk = commit2.code === 0 && commitEnv?.status === 'completed';
    const commitVerified = commitEnv && (commitEnv.data as Record<string, unknown>)?.verified === true;
    checks.push(check('ballot proposal commit verified', commitOk && commitVerified, 'completed verified=true', `${commit2.code} ${commitEnv?.status} verified=${commitEnv && (commitEnv.data as Record<string, unknown>)?.verified}`));
    const after = ctx.run(['query', 'ballot.query', '--topic', 'alpha']);
    const afterEnv = parseEnvelope(after.stdout);
    const afterCount = afterEnv && afterEnv.data ? (afterEnv.data as Record<string, unknown>).count as number : -1;
    checks.push(check('ballot.readback delta = required', afterCount === qCount + 1, String(qCount + 1), String(afterCount)));
    return { id: 'g-ballot-second-domain', pass: checks.every((c) => c.pass), checks };
  } },
  { id: 'g-structured-parity', run: (ctx) => {
    // Structured call parity: call --file must produce the same envelope as the direct command.
    const payload = JSON.stringify({ operation: 'dummy.query', args: ['--collection', 'alpha', '--window', 'W1'] });
    const file = writePayload(ctx, { operation: 'dummy.query', args: ['--collection', 'alpha', '--window', 'W1'] });
    const structured = ctx.run(['call', '--file', file]);
    const direct = ctx.run(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1']);
    const sEnv = parseEnvelope(structured.stdout);
    const dEnv = parseEnvelope(direct.stdout);
    const sameStatus = sEnv?.status === dEnv?.status;
    const sameData = JSON.stringify(sEnv?.data) === JSON.stringify(dEnv?.data);
    return { id: 'g-structured-parity', pass: structured.code === 0 && direct.code === 0 && sameStatus && sameData, checks: [
      check('structured call exit 0', structured.code === 0, '0', String(structured.code)),
      check('direct call exit 0', direct.code === 0, '0', String(direct.code)),
      check('same status', sameStatus, String(dEnv?.status), String(sEnv?.status)),
      check('same data', sameData, JSON.stringify(dEnv?.data).slice(0, 80), JSON.stringify(sEnv?.data).slice(0, 80)),
    ] };
  } },
];

interface Baseline { version: number; generatedAt: string; note: string; cases: Record<string, { checks: Record<string, string> }> }
function baselineOf(results: CaseResult[]): Baseline {
  const cases: Baseline['cases'] = {};
  for (const r of results) {
    if (r.skipped) continue;
    cases[r.id] = { checks: Object.fromEntries(r.checks.map((c) => [c.name, c.pass ? 'pass' : 'fail'])) };
  }
  return { version: 2, generatedAt: new Date().toISOString(), note: 'Generic-mock deterministic baseline v2 (Phase 2): protocol checks + host pure-module / scripted checks for the four former SKIP cases + committed_unverified host report. No model, no judge. A check recorded as pass must stay pass; this writer refuses to write a baseline containing a failing case.', cases };
}
function main(): number {
  const args = process.argv.slice(2);
  const writeBaseline = args.includes('--write-baseline');
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim())) : null;
  const selected = cases.filter((c) => !only || only.has(c.id));
  const results: CaseResult[] = [];
  for (const c of selected) {
    const ctx = new Ctx();
    try {
      const r = c.run(ctx);
      const res = r instanceof Promise ? null : r;
      if (!res) { results.push({ id: c.id, pass: false, checks: [check('async case not supported', false, 'sync', 'async')] }); continue; }
      results.push(res);
    } catch (e) { results.push({ id: c.id, pass: false, checks: [check('case threw', false, 'no throw', String((e as Error).message ?? e))] }); }
    finally { ctx.cleanup(); }
  }
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id}`);
    for (const ch of r.checks) if (!ch.pass) console.log(`  FAIL ${ch.name}: expected ${ch.expected}, actual ${ch.actual}`);
  }
  const failed = results.filter((r) => !r.pass);
  if (writeBaseline) {
    if (failed.length) { console.error(`Refusing to write a baseline with failing cases: ${failed.map((r) => r.id).join(', ')}`); return 1; }
    mkdirSync(evalDir, { recursive: true });
    writeFileSync(BASELINE_PATH, JSON.stringify(baselineOf(results), null, 2) + '\n');
    console.log(`Wrote ${BASELINE_PATH} (${results.length} cases, 0 skipped)`);
    return 0;
  }
  if (!existsSync(BASELINE_PATH)) { console.error(`Baseline missing: ${BASELINE_PATH}. Run with --write-baseline first.`); return 2; }
  let baseline: Baseline;
  try { baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline; } catch (e) { console.error(`Baseline unreadable: ${String(e)}`); return 2; }
  const mismatches: string[] = [];
  for (const r of results) {
    const base = baseline.cases[r.id];
    if (!base) { mismatches.push(`${r.id}: not in baseline`); continue; }
    for (const ch of r.checks) {
      const expected = base.checks[ch.name];
      if (expected === undefined) { mismatches.push(`${r.id}/${ch.name}: not in baseline`); continue; }
      if ((expected === 'pass') !== ch.pass) mismatches.push(`${r.id}/${ch.name}: baseline ${expected}, actual ${ch.pass ? 'pass' : 'fail'}`);
    }
  }
  if (failed.length) { console.error(`FAIL: ${failed.map((r) => r.id).join(', ')}`); return 1; }
  if (mismatches.length) { console.error(`BASELINE MISMATCH (exit 2):\n${mismatches.join('\n')}`); return 2; }
  console.log(`Generic-mock eval: ${results.length} cases pass, 0 skipped.`);
  return 0;
}
process.exit(main());
