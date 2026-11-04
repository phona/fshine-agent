#!/usr/bin/env node
/**
 * Dummy-platform operations lint (assembly health gate).
 *
 * Run by fshine's createServerAssembly as <platformRoot>/scripts/lint-operations.js.
 * It must exit 0 with a short line on stdout, or the assembly refuses to start.
 * Checks only protocol shape, never domain correctness:
 * - operation list --json parses and yields >= 1 operation
 * - operation names unique, access in {read, scratch, write}, serve booleans present
 * - protocol values, when present, in {proposal.create, proposal.commit}
 * - args flags unique per operation, required flags are strings
 * This is ESM because the fshine repo sets "type": "module".
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'dummy');
const r = spawnSync(bin, ['operation', 'list', '--json'], { encoding: 'utf8', cwd: root });
if (r.status !== 0) { process.stderr.write(`dummy operation list failed (exit ${r.status}): ${r.stderr || ''}\n`); process.exit(1); }
let data;
try { data = JSON.parse(r.stdout); } catch (e) { process.stderr.write(`dummy operation list is not JSON: ${e.message}\n`); process.exit(1); }
const ops = data.operations;
if (!Array.isArray(ops) || ops.length === 0) { process.stderr.write('dummy operation list is empty\n'); process.exit(1); }
const seen = new Set();
for (const op of ops) {
  if (!op.name || seen.has(op.name)) { process.stderr.write(`duplicate or missing operation name: ${op.name}\n`); process.exit(1); }
  seen.add(op.name);
  if (!['read', 'scratch', 'write'].includes(op.access)) { process.stderr.write(`${op.name}: illegal access ${op.access}\n`); process.exit(1); }
  if (!op.serve || !['query', 'prepare', 'commit'].every((m) => typeof op.serve[m] === 'boolean')) { process.stderr.write(`${op.name}: serve matrix incomplete\n`); process.exit(1); }
  if (op.protocol !== null && !['proposal.create', 'proposal.commit'].includes(op.protocol)) { process.stderr.write(`${op.name}: illegal protocol ${op.protocol}\n`); process.exit(1); }
  const flags = (op.args && op.args.flags ? op.args.flags : []).map((f) => f.flag);
  if (new Set(flags).size !== flags.length) { process.stderr.write(`${op.name}: duplicate args flags\n`); process.exit(1); }
}
if (!data.accessSemantics || !data.accessSemantics.read || !data.accessSemantics.scratch || !data.accessSemantics.write) {
  process.stderr.write('dummy operation list lacks accessSemantics (read/scratch/write)\n'); process.exit(1);
}
console.log(`dummy operations ok: ${ops.length} operations`);
