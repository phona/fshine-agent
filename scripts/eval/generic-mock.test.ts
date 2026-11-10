/**
 * Generic-mock integration tests (no model, no finance execution layer, no real platform).
 *
 * Proves fshine's own operation-list consumers work against the dummy
 * execution layer: labels, arg specs, semantics and protocol roles are all
 * derived from `bin/dummy operation list --json` (via the bin/generic
 * symlink inside the fixture, which is how fshine's gatewayExecPath
 * addresses any platform root), never from a second copy
 * in this repo. The dummy CLI itself is covered deterministically by
 * scripts/eval/generic-mock.ts; this file covers the fshine side of the
 * same interface.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  loadOperationArgSpecs,
  loadOperationLabels,
  loadOperationProtocols,
  loadOperationSemantics,
} from '@fshine/agent';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(evalDir, 'fixtures', 'dummy-platform');
const dummyBin = path.join(fixtureRoot, 'bin', 'dummy');

function runDummy(args: string[], env: NodeJS.ProcessEnv, stateDir: string) {
  // 状态根走测试专用 --state-dir（docs §4a）；夹具不再读状态路径 env。
  const r = spawnSync(dummyBin, ['--state-dir', stateDir, ...args], { encoding: 'utf8', cwd: fixtureRoot, env });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('generic mock execution layer', () => {
  it('operation list is machine-readable and covers read/scratch/write + protocol roles', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'generic-mock-test-'));
    try {
      const env = { ...process.env };
      const r = runDummy(['operation', 'list', '--json'], env, dir);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as { operations: Array<Record<string, unknown>>; accessSemantics: Record<string, Record<string, boolean>> };
      expect(parsed.operations.map((o) => o.name)).toEqual(expect.arrayContaining(['dummy.query', 'dummy.scratch', 'dummy.prepare', 'dummy.commit', 'dummy.proposal', 'dummy.proposal-commit', 'ballot.query', 'ballot.scratch', 'ballot.prepare', 'ballot.commit', 'ballot.proposal', 'ballot.proposal-commit']));
      expect(parsed.accessSemantics.read).toEqual({ plan: true, confirm: false, mock: true });
      expect(parsed.accessSemantics.scratch).toEqual({ plan: false, confirm: false, mock: false });
      expect(parsed.accessSemantics.write).toEqual({ plan: true, confirm: true, mock: true });
      const byName = Object.fromEntries(parsed.operations.map((o) => [o.name, o]));
      expect(byName['dummy.proposal']?.protocol).toBe('proposal.create');
      expect(byName['dummy.proposal-commit']?.protocol).toBe('proposal.commit');
      expect(byName['ballot.proposal']?.protocol).toBe('proposal.create');
      expect(byName['ballot.proposal-commit']?.protocol).toBe('proposal.commit');
      expect(byName['dummy.query']?.protocol).toBeNull();
      expect(byName['ballot.query']?.protocol).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fshine operation-list consumers derive labels/specs/semantics/protocols from dummy', async () => {
    const labels = await loadOperationLabels(fixtureRoot, 'bin/generic');
    expect(labels.get('dummy.query')).toBeTruthy();
    const specs = await loadOperationArgSpecs(fixtureRoot, 'bin/generic');
    expect(specs.get('dummy.query')).toBeTruthy();
    const semantics = await loadOperationSemantics(fixtureRoot, 'bin/generic');
    expect(semantics.get('dummy.query')).toBeTruthy();
    const protocols = await loadOperationProtocols(fixtureRoot, 'bin/generic');
    expect(protocols.get('dummy.proposal')).toBe('proposal.create');
    expect(protocols.get('dummy.proposal-commit')).toBe('proposal.commit');
  });

  it('lint-operations passes for the dummy fixture (assembly health gate)', () => {
    const r = spawnSync(process.execPath, [path.join(fixtureRoot, 'scripts', 'lint-operations.js')], { encoding: 'utf8', cwd: fixtureRoot });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('dummy operations ok: 12 operations');
  });

  it('query / not-found / zero are distinct deterministic answers', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'generic-mock-test-'));
    try {
      const env = { ...process.env };
      const ok = runDummy(['query', 'dummy.query', '--collection', 'alpha'], env, dir);
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain('"status":"completed"');
      const nf = runDummy(['query', 'dummy.query', '--collection', 'nope'], env, dir);
      expect(nf.code).toBe(0);
      expect(nf.stdout).toContain('"status":"not_found"');
      const zero = runDummy(['query', 'dummy.query', '--collection', 'empty-one'], env, dir);
      expect(zero.code).toBe(0);
      expect(zero.stdout).toContain('"status":"completed"');
      expect(zero.stdout).toContain('"count":0');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
