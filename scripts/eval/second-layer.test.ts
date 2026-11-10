/**
 * Second execution-layer proof (Package 4): fshine orchestration against the
 * stock fixture, with ZERO changes to fshine production code.
 *
 * This test lives in scripts/eval/ (a test/eval file, not packages/ or
 * apps/ production code) and proves, deterministically and without a model:
 * - the stock gateway speaks the same protocol (operation list, plan,
 *   proposal, RESULT envelope, exit codes, per-case state isolation);
 * - fshine's own operation-list consumers derive labels/specs/semantics/
 *   protocols/proposalSchema from the stock list unchanged;
 * - the generic host mechanisms (plan gate, proposal dry-run + readback,
 *   step cap, handover, committed_unverified) walk the stock domain;
 * - the stock layer's own mock, memory, breaker and cache (admission
 *   A10-A12) are deterministic and state-isolated.
 * It does NOT prove a real model would drive this domain, and it does NOT
 * touch any real platform: the host holds no "may this deployment write"
 * switch at all (2026-11-08 architecture ruling), and no execution-layer
 * authorization variable is set here.
 */
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HANDOVER_VERSION,
  loadOperationArgSpecs,
  loadOperationLabels,
  loadOperationProtocols,
  loadOperationSemantics,
  loadProposalSchema,
  mechanicalReview,
  mergeExecutedCalls,
  parseHandover,
  readHandoverFile,
  stepCapDecision,
  writeHandoverFile,
  isCommittedUnverified,
} from '@fshine/agent';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(evalDir, 'fixtures', 'stock-platform');
const stockBin = path.join(fixtureRoot, 'bin', 'stock');

function makeCtx(extraEnv: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'second-layer-'));
  const env = {
    ...process.env,
    // 状态根走测试专用 `--state-dir` flag（docs §4a，dummy 测试面，非消费协议）：四个
    // STATE 路径不再经 env 注入，夹具也不再读它们。辅助组的规范名与状态根同目录（辅助组
    // 注入面的收口不在本片）。令牌面只注入规范族 EXECUTION_*
    // （docs/env-naming-ruling-20261110.md）。
    EXECUTION_MEMORY_STATE: path.join(dir, 'memory.json'),
    EXECUTION_BREAKER_STATE: path.join(dir, 'breaker.json'),
    EXECUTION_CACHE_STATE: path.join(dir, 'cache.json'),
    EXECUTION_PLAN_ACTIVATION_SECRET: 'second-layer-plan-secret',
    EXECUTION_GATE_SECRET: 'second-layer-gate-secret',
    // 用例声明的 C 类旋钮（如 STOCK_READBACK_SHORT）；不在用例体里逐调用改 env。
    ...extraEnv,
  };
  return { dir, env, run: (args: string[], input?: string) => {
    const r = spawnSync(stockBin, ['--state-dir', dir, ...args], { encoding: 'utf8', cwd: fixtureRoot, env, input });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function envelope(stdout: string) {
  const m = stdout.match(/^RESULT (\{.*\})\s*$/m);
  if (!m) return null;
  return JSON.parse(m[1]!) as { v: number; op: string; status: string; data: Record<string, unknown> | null; error: { code: string } | null };
}
function proposalToken(proposalId: string, expiresAt: string, secret: string): string {
  const body = Buffer.from(JSON.stringify({ proposalId, expiresAt })).toString('base64url');
  return `${body}.${Buffer.from(createHmac('sha256', secret).update(body).digest()).toString('base64url')}`;
}
function planToken(planId: string, evidence: string, secret: string): string {
  const expires = Date.now() + 60_000;
  const body = Buffer.from(JSON.stringify({ planId, evidence, expires })).toString('base64url');
  return `${body}.${Buffer.from(createHmac('sha256', secret).update(body).digest()).toString('base64url')}`;
}

describe('second execution layer: stock', () => {
  it('operation list is machine-readable, stock-only, with proposal protocol roles', () => {
    const ctx = makeCtx();
    try {
      const r = ctx.run(['operation', 'list', '--json']);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as { operations: Array<Record<string, unknown>>; accessSemantics: Record<string, Record<string, boolean>> };
      expect(parsed.operations.map((o) => o.name)).toEqual(['stock.query', 'stock.scratch', 'stock.prepare', 'stock.commit', 'stock.proposal', 'stock.proposal-commit']);
      expect(parsed.accessSemantics.read).toEqual({ plan: true, confirm: false, mock: true });
      expect(parsed.accessSemantics.write).toEqual({ plan: true, confirm: true, mock: true });
      const byName = Object.fromEntries(parsed.operations.map((o) => [o.name, o]));
      expect(byName['stock.proposal']?.protocol).toBe('proposal.create');
      expect(byName['stock.proposal-commit']?.protocol).toBe('proposal.commit');
      expect(byName['stock.proposal']?.proposalSchema).toMatchObject({ properties: expect.objectContaining({ shelf: expect.anything(), batch: expect.anything(), items: expect.anything() }) });
      expect(byName['stock.query']?.proposalSchema).toBeNull();
    } finally { ctx.cleanup(); }
  });

  it('fshine operation-list consumers derive everything from the stock list unchanged', async () => {
    expect((await loadOperationLabels(fixtureRoot, 'bin/stock')).get('stock.query')).toBeTruthy();
    expect((await loadOperationArgSpecs(fixtureRoot, 'bin/stock')).get('stock.query')).toBeTruthy();
    expect((await loadOperationSemantics(fixtureRoot, 'bin/stock')).get('stock.query')).toBeTruthy();
    const protocols = await loadOperationProtocols(fixtureRoot, 'bin/stock');
    expect(protocols.get('stock.proposal')).toBe('proposal.create');
    expect(protocols.get('stock.proposal-commit')).toBe('proposal.commit');
    const schema = await loadProposalSchema(fixtureRoot, 'bin/stock');
    expect(schema).toMatchObject({ properties: expect.objectContaining({ shelf: expect.anything(), items: expect.anything() }) });
  });

  it('query / ambiguity / not-found / zero are distinct deterministic answers', () => {
    const ctx = makeCtx();
    try {
      const ok = envelope(ctx.run(['query', 'stock.query', '--shelf', 'north', '--batch', 'B1']).stdout);
      expect(ok?.status).toBe('completed'); expect(ok?.data?.count).toBe(2);
      const amb = envelope(ctx.run(['query', 'stock.query', '--shelf', 'nor']).stdout);
      expect(amb?.status).toBe('needs_input');
      expect(((amb?.data as Record<string, unknown>)?.candidates as Array<{ name: string }>).map((c) => c.name)).toEqual(['north', 'north-wing']);
      const nf = envelope(ctx.run(['query', 'stock.query', '--shelf', 'nope']).stdout);
      expect(nf?.status).toBe('not_found'); expect(nf?.error?.code).toBe('SHELF_NOT_FOUND');
      const zero = envelope(ctx.run(['query', 'stock.query', '--shelf', 'empty-shelf']).stdout);
      expect(zero?.status).toBe('completed'); expect(zero?.data?.count).toBe(0);
    } finally { ctx.cleanup(); }
  });

  it('plan gate: execute, confirm-by-weight, activate, bad token refused', () => {
    const ctx = makeCtx();
    try {
      const e1 = ctx.run(['plan', 'evaluate', '--task-id', 't1', '--stdin'], JSON.stringify({ calls: [{ operation: 'stock.query', args: ['--shelf', 'north'] }] }));
      const j1 = JSON.parse(e1.stdout);
      expect(e1.code).toBe(0); expect(j1.decision).toBe('execute'); expect(j1.status).toBe('active'); expect(j1.estimate.weight).toBe(2);
      const big = ctx.run(['plan', 'evaluate', '--task-id', 't2', '--stdin'], JSON.stringify({ calls: Array.from({ length: 40 }, () => ({ operation: 'stock.query', args: ['--shelf', 'north'] })) }));
      const jb = JSON.parse(big.stdout);
      expect(jb.decision).toBe('confirm'); expect(jb.status).toBe('pending');
      const act = ctx.run(['plan', 'activate', '--stdin'], JSON.stringify({ planId: jb.planId, evidence: 'user-confirmed', token: planToken(jb.planId, 'user-confirmed', 'second-layer-plan-secret') }));
      expect(act.code).toBe(0); expect(JSON.parse(act.stdout).status).toBe('active');
      const bad = ctx.run(['plan', 'activate', '--stdin'], JSON.stringify({ planId: jb.planId, evidence: 'user-confirmed', token: 'bad.token' }));
      expect(bad.code).toBe(3);
    } finally { ctx.cleanup(); }
  });

  it('proposal flow end-to-end: dry-run, create, commit verified, readback delta, no second commit', () => {
    const ctx = makeCtx();
    try {
      const before = envelope(ctx.run(['query', 'stock.query', '--shelf', 'north', '--batch', 'B1']).stdout);
      const beforeCount = before?.data?.count as number;
      const prep = envelope(ctx.run(['prepare', 'stock.prepare', '--shelf', 'north', '--batch', 'B1', '--count', '1']).stdout);
      expect((prep?.data as Record<string, unknown>)?.dryRun).toBe(true);
      const payloadFile = path.join(ctx.dir, 'payload.json');
      writeFileSync(payloadFile, JSON.stringify({ shelf: 'north', batch: 'B1', items: [{ sku: 'new-sku-1', qty: 400 }] }));
      const created = ctx.run(['prepare', 'stock.proposal', payloadFile]);
      const ce = envelope(created.stdout);
      expect(created.code).toBe(0); expect(ce?.data?.status).toBe('pending');
      const proposalId = ce?.data?.proposalId as string;
      const status = ctx.run(['proposal', 'status', '--proposal-id', proposalId]);
      expect(status.stdout).toContain('"status":"pending"');
      const saved = ctx.env;
      const env2 = { ...saved, EXECUTION_COMMIT_TOKEN: proposalToken(proposalId, (ce!.data as Record<string, unknown>).expiresAt as string, 'second-layer-gate-secret') };
      const commitRun = spawnSync(stockBin, ['--state-dir', ctx.dir, 'commit', 'stock.proposal-commit', '--proposal-id', proposalId], { encoding: 'utf8', cwd: fixtureRoot, env: env2 });
      const commitEnv = envelope(commitRun.stdout ?? '');
      expect(commitRun.status).toBe(0); expect((commitEnv?.data as Record<string, unknown>)?.verified).toBe(true);
      const after = envelope(ctx.run(['query', 'stock.query', '--shelf', 'north', '--batch', 'B1']).stdout);
      expect(after?.data?.count).toBe(beforeCount + 1);
      const second = ctx.run(['commit', 'stock.proposal-commit', '--proposal-id', proposalId]);
      expect(second.code).toBe(3);
    } finally { ctx.cleanup(); }
  });

  it('readback-short classifies committed_unverified on the host, never completed', () => {
    const ctx = makeCtx({ STOCK_READBACK_SHORT: '1' });
    try {
      const payloadFile = path.join(ctx.dir, 'payload.json');
      writeFileSync(payloadFile, JSON.stringify({ shelf: 'north', batch: 'B1', items: [{ sku: 's1', qty: 1 }, { sku: 's2', qty: 2 }] }));
      const ce = envelope(ctx.run(['prepare', 'stock.proposal', payloadFile]).stdout);
      const proposalId = ce?.data?.proposalId as string;
      const env2 = { ...ctx.env, EXECUTION_COMMIT_TOKEN: proposalToken(proposalId, (ce!.data as Record<string, unknown>).expiresAt as string, 'second-layer-gate-secret') };
      const commitRun = spawnSync(stockBin, ['--state-dir', ctx.dir, 'commit', 'stock.proposal-commit', '--proposal-id', proposalId], { encoding: 'utf8', cwd: fixtureRoot, env: env2 });
      const commitEnv = envelope(commitRun.stdout ?? '');
      expect(commitEnv?.status).toBe('failed'); expect((commitEnv?.data as Record<string, unknown>)?.verified).toBe(false);
      expect(isCommittedUnverified({ ok: false, verified: false, errorCode: 'PROPOSAL_VERIFY_SHORT' })).toBe(true);
    } finally { ctx.cleanup(); }
  });

  it('stock memory / breaker / cache are deterministic and state-isolated', () => {
    const ctx = makeCtx();
    try {
      expect(envelope(ctx.run(['memory', 'set', '--key', 'shelf-note', '--value', 'checked']).stdout)?.status).toBe('completed');
      expect(envelope(ctx.run(['memory', 'get', '--key', 'shelf-note']).stdout)?.data?.value).toBe('checked');
      expect(envelope(ctx.run(['memory', 'get', '--key', 'missing']).stdout)?.status).toBe('not_found');
      expect(envelope(ctx.run(['breaker', 'status']).stdout)?.data?.state).toBe('closed');
      ctx.run(['breaker', 'trip']);
      const blocked = ctx.run(['query', 'stock.query', '--shelf', 'north']);
      expect(blocked.code).toBe(1); expect(blocked.stdout).toContain('BREAKER_OPEN');
      ctx.run(['breaker', 'reset']);
      expect(ctx.run(['query', 'stock.query', '--shelf', 'north']).code).toBe(0);
      expect(envelope(ctx.run(['cache', 'put', '--key', 'north-B1', '--value', '2']).stdout)?.status).toBe('completed');
      expect(envelope(ctx.run(['cache', 'get', '--key', 'north-B1']).stdout)?.data).toMatchObject({ hit: true, value: '2' });
      expect(envelope(ctx.run(['cache', 'get', '--key', 'nope']).stdout)?.data).toMatchObject({ hit: false });
      ctx.run(['cache', 'clear']);
      expect(envelope(ctx.run(['cache', 'get', '--key', 'north-B1']).stdout)?.data).toMatchObject({ hit: false });
    } finally { ctx.cleanup(); }
  });

  it('host generic mechanisms walk the stock domain unchanged', async () => {
    const schema = await loadProposalSchema(fixtureRoot, 'bin/stock');
    // mechanicalReview returns null when mechanical checks pass (the model
    // reviewer would then decide); it only blocks on inconsistency.
    expect(mechanicalReview({ proposalSchema: schema, dryRunEnvelope: { status: 'completed' }, summaryText: 'north B1, 1 item' })).toBeNull();
    expect(mechanicalReview({ proposalSchema: null, dryRunEnvelope: { status: 'completed' }, summaryText: 'x' })?.verdict).toBe('inconsistent');
    expect(stepCapDecision(51).windDown).toBe(true);
    expect(stepCapDecision(50).windDown).toBe(false);
    const root = mkdtempSync(path.join(os.tmpdir(), 'second-layer-handover-'));
    try {
      const handover = { version: HANDOVER_VERSION, taskId: 'task-1', planId: 'plan-1', planVersion: 2, completedSteps: ['stock.query --shelf north'], executedCalls: [{ operation: 'stock.query', args: ['--shelf', 'north'] }], unfinishedSteps: ['step-b'], nextAction: 'run step-b', lastResultSummary: 'north read ok', updatedAt: '2026-11-04T00:00:00.000Z' };
      const file = writeHandoverFile(root, 'task-1', handover);
      expect(readHandoverFile(root, 'task-1')).toEqual(handover);
      expect(file.endsWith(path.join('tmp', 'task-1', 'handover.json'))).toBe(true);
      expect(mergeExecutedCalls(handover.executedCalls, [{ operation: 'stock.query', args: ['--shelf', 'north'] }, { operation: 'stock.query', args: ['--shelf', 'south'] }]).length).toBe(2);
      expect(parseHandover(JSON.stringify({ ...handover, version: 99 }))).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('state isolation: one case commit does not move another case', () => {
    const a = makeCtx(); const b = makeCtx();
    try {
      const payloadFile = path.join(a.dir, 'payload.json');
      writeFileSync(payloadFile, JSON.stringify({ shelf: 'south', batch: 'B1', items: [{ sku: 'iso-1', qty: 10 }] }));
      const ce = envelope(a.run(['prepare', 'stock.proposal', payloadFile]).stdout);
      const proposalId = ce?.data?.proposalId as string;
      const env2 = { ...a.env, EXECUTION_COMMIT_TOKEN: proposalToken(proposalId, (ce!.data as Record<string, unknown>).expiresAt as string, 'second-layer-gate-secret') };
      spawnSync(stockBin, ['--state-dir', a.dir, 'commit', 'stock.proposal-commit', '--proposal-id', proposalId], { encoding: 'utf8', cwd: fixtureRoot, env: env2 });
      expect(envelope(a.run(['query', 'stock.query', '--shelf', 'south']).stdout)?.data?.count).toBe(4);
      expect(envelope(b.run(['query', 'stock.query', '--shelf', 'south']).stdout)?.data?.count).toBe(3);
    } finally { a.cleanup(); b.cleanup(); }
  });
});
