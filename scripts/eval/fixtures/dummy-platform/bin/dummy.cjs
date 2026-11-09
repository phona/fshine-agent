#!/usr/bin/env node
/**
 * Generic mock execution layer for fshine-agent eval (Phase 1, dummy-platform).
 *
 * Purpose: prove the orchestration layer works against ANY execution layer that
 * speaks the same protocol, without coupling to a concrete domain. Domain words
 * here are deliberately neutral: record / collection / window. No finance,
 * voucher, account-set or period vocabulary lives in this fixture.
 *
 * Transport: binary CLI only, same surface as any execution-layer gateway (see docs/execution-layer-interface.md):
 *   operation list --json | plan --schema | plan evaluate/current/status/activate
 *   proposal status | query|prepare|commit|local <target> [args]
 * Protocol: RESULT envelope v1 on the last stdout line, exit codes 0/1/2/3.
 *   0 = deterministic answer (completed / needs_input / not_found)
 *   1 = domain failure (e.g. missing required flag, dry-run failure)
 *   2 = usage / schema failure (unknown command, unknown field, locked collection)
 *   3 = gateway / proposal refusal (unregistered, serve matrix, token, expired,
 *       corrupt state, plan not active when a plan is required)
 * State: per-case files, reset = delete the file. Next call re-seeds.
 *   DUMMY_STATE           (collections + records; default <fixture>/.runtime/dummy-state.json)
 *   DUMMY_PLAN_STATE      (plans; default <state-dir>/plans.json)
 *   DUMMY_PROPOSAL_STATE  (proposals; default <state-dir>/proposals.json)
 *   DUMMY_AUDIT_PATH / EXECUTION_AUDIT_PATH (JSONL audit, refusals included)
 * Serve compatibility: when used as bin/generic inside this fixture, fshine sets
 * EXECUTION_SERVE=1 / EXECUTION_INVOCATION / EXECUTION_PLAN_ID / EXECUTION_COMMIT_TOKEN / EXECUTION_GATE_SECRET /
 * EXECUTION_PLAN_ACTIVATION_SECRET. This fixture accepts those names as aliases for
 * its own DUMMY_* names, so fshine code needs no change. It does NOT read
 * LLM keys, WeCom secrets or any other host secret.
 *
 * Deliberately NOT implemented in v1 (see GENERIC_MOCK_NOTES.md):
 * memory / breaker / cache auxiliary groups, grind/variant plan guards,
 * rate-limit token bucket, browser/platform execution. Those are
 * execution-layer-instance specifics, not protocol. The eval script tests what is implemented and
 * lists the rest as TODO, it does not fake them.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const FIXTURE_ROOT = path.resolve(__dirname, '..');
const OPERATIONS = [
  { name: 'dummy.query', domain: 'dummy', command: 'query', access: 'read',
    script: 'src/dummy/scripts/query.js', executor: 'dummy-script', est_seconds: 10, weight: 2,
    args: { positional: [], flags: [
      { flag: '--collection', required: true, style: 'name', desc: 'collection name or keyword (exact match preferred, substring match may be ambiguous)' },
      { flag: '--window', required: false, style: 'code', desc: 'window code, e.g. W1; must exist for the collection' },
    ] },
    serve: { query: true, prepare: true, commit: true }, protocol: null },
  { name: 'dummy.scratch', domain: 'dummy', command: 'scratch', access: 'scratch',
    script: 'src/dummy/scripts/scratch.js', executor: 'dummy-script', est_seconds: 5, weight: 1,
    args: { positional: [], flags: [
      { flag: '--input', required: true, style: 'name', desc: 'input text file path (local computation only)' },
      { flag: '--output', required: false, style: 'name', desc: 'output file path; defaults to <input>.out' },
    ] },
    serve: { query: true, prepare: true, commit: false }, protocol: null },
  { name: 'dummy.prepare', domain: 'dummy', command: 'prepare', access: 'write', writeFlag: '--apply',
    script: 'src/dummy/scripts/prepare.js', executor: 'dummy-script', est_seconds: 10, weight: 5,
    args: { positional: [], flags: [
      { flag: '--collection', required: true, style: 'name', desc: 'collection name (exact)' },
      { flag: '--window', required: false, style: 'code', desc: 'window code' },
      { flag: '--count', required: false, style: 'code', desc: 'record count to prepare' },
      { flag: '--apply', required: false, style: 'code', desc: 'write flag: present means this call WOULD write, prepare must refuse it' },
    ] },
    serve: { query: false, prepare: true, commit: false }, protocol: null },
  { name: 'dummy.commit', domain: 'dummy', command: 'commit', access: 'write',
    script: 'src/dummy/scripts/commit.js', executor: 'dummy-script', est_seconds: 10, weight: 20,
    args: { positional: [], flags: [
      { flag: '--collection', required: true, style: 'name', desc: 'collection name (exact)' },
      { flag: '--window', required: false, style: 'code', desc: 'window code' },
      { flag: '--count', required: false, style: 'code', desc: 'record count to add' },
    ] },
    serve: { query: false, prepare: false, commit: true }, protocol: null },
  { name: 'dummy.proposal', domain: 'dummy', command: 'proposal', access: 'write',
    script: 'src/dummy/scripts/proposal.js', executor: 'dummy-script', est_seconds: 10, weight: 5,
    args: { positional: [{ name: 'payload', required: true, desc: 'proposal payload file (opaque to the host)' }], flags: [
      { flag: '--batch', required: false, style: 'code', desc: 'create multiple proposals (not used in v1, accepted for shape compatibility)' },
    ] },
    serve: { query: false, prepare: true, commit: false }, protocol: 'proposal.create' },
  { name: 'dummy.proposal-commit', domain: 'dummy', command: 'proposal-commit', access: 'write',
    script: 'src/dummy/scripts/proposal-commit.js', executor: 'dummy-script', est_seconds: 10, weight: 20,
    args: { positional: [], flags: [
      { flag: '--proposal-id', required: true, style: 'name', desc: 'proposal id returned by proposal.create' },
    ] },
    serve: { query: false, prepare: false, commit: true }, protocol: 'proposal.commit' },
  // ── ballot-platform (second non-finance write domain, C10 L4 closure) ──────────
  { name: 'ballot.query', domain: 'ballot', command: 'query', access: 'read',
    script: 'src/ballot/scripts/query.js', executor: 'ballot-script', est_seconds: 10, weight: 2,
    args: { positional: [], flags: [
      { flag: '--topic', required: true, style: 'name', desc: 'ballot topic name or keyword' },
      { flag: '--round', required: false, style: 'code', desc: 'round code, e.g. R1' },
    ] },
    serve: { query: true, prepare: true, commit: true }, protocol: null },
  { name: 'ballot.scratch', domain: 'ballot', command: 'scratch', access: 'scratch',
    script: 'src/ballot/scripts/scratch.js', executor: 'ballot-script', est_seconds: 5, weight: 1,
    args: { positional: [], flags: [
      { flag: '--input', required: true, style: 'name', desc: 'input text file path (local computation only)' },
      { flag: '--output', required: false, style: 'name', desc: 'output file path; defaults to <input>.out' },
    ] },
    serve: { query: true, prepare: true, commit: false }, protocol: null },
  { name: 'ballot.prepare', domain: 'ballot', command: 'prepare', access: 'write', writeFlag: '--apply',
    script: 'src/ballot/scripts/prepare.js', executor: 'ballot-script', est_seconds: 10, weight: 5,
    args: { positional: [], flags: [
      { flag: '--topic', required: true, style: 'name', desc: 'ballot topic name (exact)' },
      { flag: '--round', required: false, style: 'code', desc: 'round code' },
      { flag: '--count', required: false, style: 'code', desc: 'ballot count to prepare' },
      { flag: '--apply', required: false, style: 'code', desc: 'write flag: present means this call WOULD write, prepare must refuse it' },
    ] },
    serve: { query: false, prepare: true, commit: false }, protocol: null },
  { name: 'ballot.commit', domain: 'ballot', command: 'commit', access: 'write',
    script: 'src/ballot/scripts/commit.js', executor: 'ballot-script', est_seconds: 10, weight: 20,
    args: { positional: [], flags: [
      { flag: '--topic', required: true, style: 'name', desc: 'ballot topic name (exact)' },
      { flag: '--round', required: false, style: 'code', desc: 'round code' },
      { flag: '--count', required: false, style: 'code', desc: 'ballot count to add' },
    ] },
    serve: { query: false, prepare: false, commit: true }, protocol: null },
  { name: 'ballot.proposal', domain: 'ballot', command: 'proposal', access: 'write',
    script: 'src/ballot/scripts/proposal.js', executor: 'ballot-script', est_seconds: 10, weight: 5,
    args: { positional: [{ name: 'payload', required: true, desc: 'proposal payload file (opaque to the host)' }], flags: [
      { flag: '--batch', required: false, style: 'code', desc: 'create multiple proposals (not used in v1, accepted for shape compatibility)' },
    ] },
    serve: { query: false, prepare: true, commit: false }, protocol: 'proposal.create' },
  { name: 'ballot.proposal-commit', domain: 'ballot', command: 'proposal-commit', access: 'write',
    script: 'src/ballot/scripts/proposal-commit.js', executor: 'ballot-script', est_seconds: 10, weight: 20,
    args: { positional: [], flags: [
      { flag: '--proposal-id', required: true, style: 'name', desc: 'proposal id returned by proposal.create' },
    ] },
    serve: { query: false, prepare: false, commit: true }, protocol: 'proposal.commit' },
];
const LABELS = { 'dummy.query': 'query records', 'dummy.scratch': 'local computation', 'dummy.prepare': 'prepare records', 'dummy.commit': 'commit records', 'dummy.proposal': 'create proposal', 'dummy.proposal-commit': 'commit proposal',
  'ballot.query': 'query ballots', 'ballot.scratch': 'ballot scratch', 'ballot.prepare': 'prepare ballots', 'ballot.commit': 'commit ballots', 'ballot.proposal': 'create ballot proposal', 'ballot.proposal-commit': 'commit ballot proposal' };
const ACCESS_SEMANTICS = Object.freeze({
  read: Object.freeze({ plan: true, confirm: false, mock: true }),
  scratch: Object.freeze({ plan: false, confirm: false, mock: false }),
  write: Object.freeze({ plan: true, confirm: true, mock: true }),
});
const PLAN_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'PlanDraft', title: 'PlanDraft',
  description: 'Plan draft shape (host -> platform bin/dummy plan evaluate --stdin). calls is required; requestId/goal are declared optional metadata. additionalProperties is false: an undeclared top-level field is refused loudly, never silently ignored.',
  type: 'object', required: ['calls'], additionalProperties: false,
  properties: {
    calls: { type: 'array', description: 'Required: read-only PlanCall array. Each item: {operation: registered read-only operation name, args: string array}.' },
    requestId: { type: 'string', minLength: 1, description: 'Optional host request id. Same requestId + calls returns the existing plan (idempotent).' },
    goal: { type: 'string', minLength: 1, description: 'Optional host task goal metadata. Not consumed, not stored, not part of the decision.' },
  },
};
const PROPOSAL_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'ChangeProposalPayload', title: 'ChangeProposalPayload',
  description: 'Proposal payload shape (host -> platform bin/dummy prepare dummy.proposal <file>). The host holds only an opaque proposalId; it must not parse, validate or re-render this payload. additionalProperties is false; max 50 records.',
  type: 'object', required: ['collection', 'window', 'records'], additionalProperties: false,
  properties: {
    collection: { type: 'string', minLength: 1 },
    window: { type: 'string', minLength: 1 },
    records: { type: 'array', maxItems: 50, items: { type: 'object', required: ['name', 'value'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1 }, value: { type: 'number' } } } },
  },
};
const CORRECT_FORM = {
  QUERY_REQUIRED: 'Provide --collection <name>.',
  COLLECTION_NOT_FOUND: 'No collection matches that keyword. Check the exact collection name and retry.',
  COLLECTION_AMBIGUOUS: 'More than one collection matches. Confirm the exact collection name and retry.',
  WINDOW_NO_DATA: 'That window has no data for this collection. Retry with a window from availableWindows.',
  COLLECTION_LOCKED: 'That collection is locked. It cannot accept writes in its current state.',
  PLAN_UNKNOWN_FIELD: 'Plan draft has an undeclared top-level field. Remove it and resubmit.',
  PLAN_CALLS_REQUIRED: 'Plan draft must contain a non-empty calls array.',
  PLAN_UNKNOWN_OPERATION: 'Plan call names an unregistered operation.',
  PLAN_OPERATION_NOT_READ_ONLY: 'Plan calls may only name read-only operations (dummy.query, dummy.scratch).',
  PROPOSAL_UNKNOWN_FIELD: 'Proposal payload has an undeclared top-level field. Remove it and resubmit.',
  PROPOSAL_NOT_PENDING: 'Proposal is no longer pending. Do not commit it again.',
  PROPOSAL_EXPIRED: 'Proposal has expired. Create a new proposal.',
  PROPOSAL_TOKEN_UNTRUSTED: 'Proposal commit token is missing, malformed, expired or does not match this proposal.',
  PROPOSAL_STATE_CORRUPT: 'Proposal state is corrupt. Fail closed; do not guess.',
  PLAN_ACTIVATION_UNTRUSTED: 'Plan activation token is missing, malformed, expired or does not match this plan.',
  PLAN_NOT_FOUND: 'No such plan.',
  PLAN_NOT_PENDING: 'Plan is not pending activation.',
};
function env(name, fallback) { const v = process.env[name]; return v === undefined || v === '' ? fallback : v; }
function env2(a, b, fallback) { return env(a, env(b, fallback)); }
function statePaths() {
  const stateFile = env2('DUMMY_STATE', 'EXECUTION_MOCK_STATE', path.join(FIXTURE_ROOT, '.runtime', 'dummy-state.json'));
  const dir = path.dirname(stateFile);
  return {
    stateFile,
    planFile: env2('DUMMY_PLAN_STATE', 'EXECUTION_PLAN_STATE', path.join(dir, 'plans.json')),
    proposalFile: env('DUMMY_PROPOSAL_STATE', path.join(dir, 'proposals.json')),
    auditFile: env2('DUMMY_AUDIT_PATH', 'EXECUTION_AUDIT_PATH', null),
  };
}
function seedState() {
  return {
    collections: {
      alpha: { items: [{ id: 'rec-001', name: 'alpha-item-1', value: 1200 }, { id: 'rec-002', name: 'alpha-item-2', value: 800 }], windows: ['W1', 'W2'], locked: false, records: { W1: 2, W2: 1 } },
      beta: { items: [{ id: 'rec-101', name: 'beta-item-1', value: 500 }, { id: 'rec-102', name: 'beta-item-2', value: 300 }, { id: 'rec-103', name: 'beta-item-3', value: 200 }], windows: ['W1'], locked: false, records: { W1: 3 } },
      'alpha-group': { items: [{ id: 'rec-201', name: 'alpha-group-item-1', value: 700 }], windows: ['W1'], locked: false, records: { W1: 1 } },
      'locked-one': { items: [{ id: 'rec-301', name: 'locked-item-1', value: 900 }], windows: ['W1'], locked: true, records: { W1: 1 } },
      'empty-one': { items: [], windows: ['W1'], locked: false, records: { W1: 0 } },
      // 自然名歧义对 1（探针 A3 / C2 第一次澄清 / X1）：查询 "contoso" 不是精确键，
      // 子串命中下面两个 → COLLECTION_AMBIGUOUS。trade 双 window（W1 有数据）供 C2 选择后
      // 续查；logistics 只有 W1——X1 的 window 切换轮（选 "the second one" 后问 W2）因此
      // 落在无数据窗口上，考"该window无数据"的合法回复形态。
      'contoso-trade': { items: [{ id: 'rec-401', name: 'contoso-trade-item-1', value: 1500 }, { id: 'rec-402', name: 'contoso-trade-item-2', value: 600 }], windows: ['W1', 'W2'], locked: false, records: { W1: 2, W2: 1 } },
      'contoso-logistics': { items: [{ id: 'rec-501', name: 'contoso-logistics-item-1', value: 450 }], windows: ['W1'], locked: false, records: { W1: 1 } },
      // 自然名歧义对 2（C2 第二次澄清）：查询 "fabrikam" → 子串命中两个 → 歧义。
      // 与 contoso 对分开，避免同一歧义样本反复考同一条路径（移植前中文财税域语料的
      // 两对公司名歧义对同款设计）。
      'fabrikam-retail': { items: [{ id: 'rec-601', name: 'fabrikam-retail-item-1', value: 880 }], windows: ['W1'], locked: false, records: { W1: 1 } },
      'fabrikam-wholesale': { items: [{ id: 'rec-701', name: 'fabrikam-wholesale-item-1', value: 1320 }], windows: ['W1'], locked: false, records: { W1: 1 } },
    },
  };
}
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
// 原子写（2026-11-08 修）：writeFileSync 是截断+写，读者在半写窗口读到不完整 JSON 会触发
// loadPlans/loadProposals 的重新初始化——把累计的计划/提案/调用计数连锅端。读者多起来后
// （宿主每次建会话都问一次 plan current）这个窗口必被踩：实测 C2 跑批 ledgerCalls 变负、
// 模型工具调用被拒后开始说元话语。tmp + renameSync 在同一文件系统上原子替换，消除半写窗口。
function saveJson(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n'); fs.renameSync(tmp, file); }
function loadState() { const s = loadJson(statePaths().stateFile, null); return (s && s.collections) ? s : seedState(); }
function saveState(s) { saveJson(statePaths().stateFile, s); }
// loader 一律只读不写（2026-11-08 修）：读失败/缺键时返回空状态即可，写回初始化是破坏性竞态——
// 并发的另一个进程刚 saveJson 出新状态，这个进程读到旧内容（或半写内容）后一 save 就把它盖掉。
function loadPlans() { const s = loadJson(statePaths().planFile, null); return (s && s.plans) ? s : { plans: {}, tasks: {} }; }
function savePlans(s) { saveJson(statePaths().planFile, s); }
function loadProposals() { const s = loadJson(statePaths().proposalFile, null); return (s && s.proposals) ? s : { proposals: {} }; }
function saveProposals(s) { saveJson(statePaths().proposalFile, s); }
// 审计写失败要响（2026-11-08）：audit 是执行层证据的唯一来源（评测按 EXECUTION_AUDIT_PATH
// 的行数与 refused 判定），写失败还静默继续 = 调用无痕，评测只能得出 INCONCLUSIVE 甚至
// 假绿。改为失败即抛——外层 main().catch 会把栈打到 stderr 并以非零码退出，这次调用
// 因此整体失败（fail-closed），绝不出现"执行了但没留痕"的成功。
function audit(row) {
  const f = statePaths().auditFile;
  if (!f) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}
function emit(op, status, data, error) {
  const envelope = { v: 1, op, status, data: data ?? null, error: error ? { code: error.code, message: error.message, ...(error.correctForm ? { correctForm: error.correctForm } : {}) } : null };
  process.stdout.write('RESULT ' + JSON.stringify(envelope) + '\n');
  return envelope;
}
function errObj(code, message) { return { code, message, correctForm: CORRECT_FORM[code] }; }
function parseFlags(argv) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) { flags[a.slice(2)] = argv[i + 1]; i += 1; }
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}
function resolveOperation(ref) {
  if (!ref) return null;
  const byName = OPERATIONS.find((o) => o.name === ref);
  if (byName) return byName;
  const base = path.basename(ref).replace(/\.js$/i, '').replace(/\.py$/i, '');
  const map = { query: 'dummy.query', scratch: 'dummy.scratch', prepare: 'dummy.prepare', commit: 'dummy.commit', proposal: 'dummy.proposal', 'proposal-commit': 'dummy.proposal-commit',
    'ballot-query': 'ballot.query', 'ballot-scratch': 'ballot.scratch', 'ballot-prepare': 'ballot.prepare', 'ballot-commit': 'ballot.commit', 'ballot-proposal': 'ballot.proposal', 'ballot-proposal-commit': 'ballot.proposal-commit' };
  const name = map[base];
  return name ? OPERATIONS.find((o) => o.name === name) ?? null : null;
}
function decide(mode, op, args) {
  if (!['query', 'prepare', 'commit'].includes(mode)) return { allowed: false, reason: `Unknown mode "${mode}"` };
  if (!op.serve || op.serve[mode] !== true) return { allowed: false, reason: `${op.name} is not open in ${mode} mode (serve.${mode} is not true)` };
  const sem = ACCESS_SEMANTICS[op.access];
  if (!sem) return { allowed: false, reason: `${op.name} has undeclared access "${op.access}"` };
  if (mode === 'query' && sem.confirm) return { allowed: false, reason: `query only allows operations that do not write; ${op.name} requires confirmation, use commit` };
  if (mode === 'prepare') {
    if (op.access === 'write' && !op.writeFlag) return { allowed: false, reason: `prepare does not allow always-write operation ${op.name}` };
    if (op.writeFlag && args.includes(op.writeFlag)) return { allowed: false, reason: `prepare does not allow ${op.writeFlag} on ${op.name} -- a write must go through commit` };
  }
  return { allowed: true };
}
function findCollection(state, keyword) {
  if (Object.prototype.hasOwnProperty.call(state.collections, keyword)) return { exact: state.collections[keyword], name: keyword };
  const matches = Object.keys(state.collections).filter((n) => n.includes(keyword));
  if (matches.length === 1) return { exact: state.collections[matches[0]], name: matches[0] };
  if (matches.length > 1) return { ambiguous: matches };
  return { none: true };
}
// 返回 { code, result }（2026-11-09 audited 申报模式）：result 在 completed / needs_input /
// not_found 三种确定性答案上都带**该次 query 的实际结果状态**（result.status），completed
// 另带该次返回的 items/count/fields，由调用方写进审计行的 result 字段——audited 申报模式交叉核的
// 事实基准（"回复里的数平台确实拉回过"与"平台确实说过 not_found"都要能独立核对，不能只靠
// 模型自述传递）。failed/被拒没有可申报的结果，返回的 code 不带 result，审计行因此也不会
// 出现载荷。
function doQuery(opName, args) {
  const { flags } = parseFlags(args);
  const state = loadState();
  if (!flags.collection && !flags.topic) { emit(opName, 'failed', null, errObj('QUERY_REQUIRED', 'Missing --collection or --topic')); return { code: 1 }; }
  const collection = flags.collection || flags.topic;
  const found = findCollection(state, collection);
  if (found.ambiguous) { emit(opName, 'needs_input', { query: collection, candidates: found.ambiguous.map((name) => ({ name })) }, errObj('COLLECTION_AMBIGUOUS', `More than one collection matches "${collection}"`)); return { code: 0, result: { status: 'needs_input' } }; }
  if (found.none) { emit(opName, 'not_found', { query: collection, candidates: [] }, errObj('COLLECTION_NOT_FOUND', `No collection matches "${collection}"`)); return { code: 0, result: { status: 'not_found' } }; }
  const col = found.exact;
  const window = flags.window || flags.round;
  if (window && !col.windows.includes(window)) {
    emit(opName, 'not_found', { query: collection, window, availableWindows: col.windows }, errObj('WINDOW_NO_DATA', `Window ${window} has no data for collection ${found.name}`));
    return { code: 0, result: { status: 'not_found' } };
  }
  const items = col.items;
  emit(opName, 'completed', { collection: found.name, window: window ?? null, items, count: items.length }, null);
  // fields = 平台原始 items 的字段名（nocaliber 命题的事实基准）：items 本身按 value 核对
  // 契约落账，字段名单独保留，避免"投影后的形状"冒充平台原始数据模型。
  return { code: 0, result: { status: 'completed', items, count: items.length, fields: [...new Set(items.flatMap((item) => Object.keys(item)))] } };
}
function doScratch(opName, args) {
  const { flags } = parseFlags(args);
  if (!flags.input) { emit(opName, 'failed', null, errObj('QUERY_REQUIRED', 'Missing --input')); return 1; }
  let text;
  try { text = fs.readFileSync(flags.input, 'utf8'); } catch (e) { emit(opName, 'failed', null, { code: 'INPUT_NOT_FOUND', message: String(e.message) }); return 1; }
  const out = flags.output || `${flags.input}.out`;
  const result = { lines: text.split('\n').filter((l) => l.length > 0).length, chars: text.length };
  try { fs.writeFileSync(out, JSON.stringify(result) + '\n'); } catch (e) { emit(opName, 'failed', null, { code: 'OUTPUT_WRITE_FAILED', message: String(e.message) }); return 1; }
  emit(opName, 'completed', { input: flags.input, output: out, ...result }, null);
  return 0;
}
function doPrepare(opName, args) {
  const { flags } = parseFlags(args);
  const state = loadState();
  const collection = flags.collection || flags.topic;
  if (!collection) { emit(opName, 'failed', null, errObj('QUERY_REQUIRED', 'Missing --collection or --topic')); return 1; }
  if (!Object.prototype.hasOwnProperty.call(state.collections, collection)) { emit(opName, 'not_found', { query: collection, candidates: [] }, errObj('COLLECTION_NOT_FOUND', `No collection matches "${collection}"`)); return 0; }
  const col = state.collections[collection];
  if (col.locked) { emit(opName, 'failed', null, errObj('COLLECTION_LOCKED', `Collection ${collection} is locked`)); return 2; }
  const count = flags.count !== undefined ? Number(flags.count) : 1;
  emit(opName, 'completed', { collection, window: flags.window || flags.round || null, preparedCount: Number.isFinite(count) ? count : 1, dryRun: true }, null);
  return 0;
}
function doCommit(opName, args) {
  const { flags } = parseFlags(args);
  const state = loadState();
  const collection = flags.collection || flags.topic;
  if (!collection) { emit(opName, 'failed', null, errObj('QUERY_REQUIRED', 'Missing --collection or --topic')); return 1; }
  if (!Object.prototype.hasOwnProperty.call(state.collections, collection)) { emit(opName, 'not_found', { query: collection, candidates: [] }, errObj('COLLECTION_NOT_FOUND', `No collection matches "${collection}"`)); return 0; }
  const col = state.collections[collection];
  if (col.locked) { emit(opName, 'failed', null, errObj('COLLECTION_LOCKED', `Collection ${collection} is locked`)); return 2; }
  const count = flags.count !== undefined ? Number(flags.count) : 1;
  const window = flags.window || flags.round || 'W1';
  col.records[window] = (col.records[window] ?? 0) + (Number.isFinite(count) ? count : 1);
  saveState(state);
  emit(opName, 'completed', { collection, window, added: count, total: col.records[window] }, null);
  return 0;
}
function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function sign(body, secret) { return body + '.' + Buffer.from(crypto.createHmac('sha256', secret).update(body).digest()).toString('base64url'); }
function verifyProposalToken(token, proposalId, expiresAt, secret) {
  try {
    if (!secret || !token) return false;
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return false;
    const expect = crypto.createHmac('sha256', secret).update(body).digest();
    const got = Buffer.from(sig, 'base64url');
    if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) return false;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.proposalId === proposalId && p.expiresAt === expiresAt && new Date(expiresAt).getTime() >= Date.now();
  } catch { return false; }
}
function proposalTtlMs() { const n = Number(env('DUMMY_PROPOSAL_TTL_SECONDS', '')); return Number.isInteger(n) && n > 0 ? n * 1000 : 30 * 60 * 1000; }
function doProposalCreate(opName, args) {
  const { positional } = parseFlags(args);
  const file = positional[0];
  if (!file) { process.stderr.write('PROPOSAL_REFUSE missing payload file\n'); return 3; }
  let payload;
  try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { process.stderr.write(`PROPOSAL_REFUSE payload unreadable: ${e.message}\n`); return 3; }
  const allowed = ['collection', 'window', 'records'];
  const extra = Object.keys(payload).filter((k) => !allowed.includes(k));
  if (extra.length) { process.stderr.write(`PROPOSAL_REFUSE unknown field: ${extra.join(',')}\n`); emit(opName, 'failed', null, errObj('PROPOSAL_UNKNOWN_FIELD', `Unknown field: ${extra.join(',')}`)); return 3; }
  if (!payload.collection || !payload.window || !Array.isArray(payload.records)) { process.stderr.write('PROPOSAL_REFUSE payload shape invalid\n'); return 3; }
  if (payload.records.length > 50) { process.stderr.write('PROPOSAL_REFUSE too many records\n'); return 3; }
  // Domain dry-run only: validate collection exists and is not locked, do NOT write records.
  const state = loadState();
  if (!Object.prototype.hasOwnProperty.call(state.collections, payload.collection)) { emit(opName, 'failed', null, errObj('COLLECTION_NOT_FOUND', `No collection matches "${payload.collection}"`)); return 1; }
  if (state.collections[payload.collection].locked) { emit(opName, 'failed', null, errObj('COLLECTION_LOCKED', `Collection ${payload.collection} is locked`)); return 2; }
  const proposals = loadProposals();
  const proposalId = `prop_${crypto.randomUUID()}`;
  const now = Date.now();
  const expiresAt = new Date(now + proposalTtlMs()).toISOString();
  proposals.proposals[proposalId] = { proposalId, payload, createdAt: new Date(now).toISOString(), expiresAt, status: 'pending' };
  saveProposals(proposals);
  const summaryText = `Pending proposal ${proposalId}: collection "${payload.collection}" window ${payload.window}, ${payload.records.length} record(s). Confirm to apply; expires at ${expiresAt}.`;
  emit(opName, 'completed', { proposalId, summaryText, collection: payload.collection, window: payload.window, count: payload.records.length, expiresAt, status: 'pending' }, null);
  return 0;
}
function doProposalStatus(proposalId) {
  const proposals = loadProposals();
  const rec = proposals.proposals[proposalId];
  if (!rec || typeof rec !== 'object' || rec.proposalId !== proposalId || !['pending', 'committed'].includes(rec.status) || typeof rec.createdAt !== 'string' || typeof rec.expiresAt !== 'string') {
    process.stdout.write(JSON.stringify({ proposalId, status: 'missing', expired: false }) + '\n'); return 0;
  }
  process.stdout.write(JSON.stringify({ proposalId, status: rec.status, createdAt: rec.createdAt, expiresAt: rec.expiresAt, expired: new Date(rec.expiresAt).getTime() < Date.now() }) + '\n');
  return 0;
}
function doProposalCommit(opName, args) {
  const { flags } = parseFlags(args);
  const proposalId = flags['proposal-id'];
  if (!proposalId) { process.stderr.write('PROPOSAL_REFUSE missing --proposal-id\n'); return 3; }
  const proposals = loadProposals();
  const rec = proposals.proposals[proposalId];
  if (!rec || typeof rec !== 'object' || rec.proposalId !== proposalId || typeof rec.createdAt !== 'string' || typeof rec.expiresAt !== 'string' || !['pending', 'committed'].includes(rec.status)) {
    process.stderr.write('PROPOSAL_REFUSE proposal state corrupt\n'); emit(opName, 'failed', null, errObj('PROPOSAL_STATE_CORRUPT', 'Proposal state is corrupt')); return 3;
  }
  if (rec.status !== 'pending') { process.stderr.write(`PROPOSAL_REFUSE proposal not pending: status=${rec.status}\n`); emit(opName, 'failed', null, errObj('PROPOSAL_NOT_PENDING', `status=${rec.status}`)); return 3; }
  if (new Date(rec.expiresAt).getTime() < Date.now()) { process.stderr.write('PROPOSAL_REFUSE proposal expired\n'); emit(opName, 'failed', null, errObj('PROPOSAL_EXPIRED', rec.expiresAt)); return 3; }
  const secret = env2('DUMMY_GATE_SECRET', 'EXECUTION_GATE_SECRET', '');
  const token = env2('DUMMY_COMMIT_TOKEN', 'EXECUTION_COMMIT_TOKEN', '');
  // Fail-closed（2026-11-08 修）：secret 缺失不再跳过整道门。宿主只把 gate secret 程序化
  // 注入给自己的 commit runner（从不进 process.env），worker bash 直调时恰好没有 secret——
  // 旧写法 `secret && !verify(...)` 恰好在那条路上把门整个跳过，无令牌也能提交。现在
  // secret 为空或令牌不符一律拒（verifyProposalToken 对 !secret || !token 返回 false）。
  // 注意：dummy.commit 直提路径（无提案状态）仍是另一套 `if (secret)` 有门才验的契约，
  // 两者不一致已登记 debt-ledger，本轮不合并。
  if (!verifyProposalToken(token, proposalId, rec.expiresAt, secret)) { process.stderr.write('PROPOSAL_REFUSE proposal token untrusted\n'); emit(opName, 'failed', null, errObj('PROPOSAL_TOKEN_UNTRUSTED', 'Token does not match this proposal or has expired')); return 3; }
  // Pre-commit readback baseline, then apply, then post-commit readback.
  const state = loadState();
  const col = state.collections[rec.payload.collection];
  if (!col) { process.stderr.write('PROPOSAL_REFUSE collection missing at commit\n'); return 3; }
  if (col.locked) { emit(opName, 'failed', null, errObj('COLLECTION_LOCKED', `Collection ${rec.payload.collection} is locked`)); return 2; }
  const before = col.records[rec.payload.window] ?? 0;
  const required = rec.payload.records.length;
  // Readback-short scenario (test-only, via env, never via payload): when
  // DUMMY_READBACK_SHORT=1, apply only part, so delta < required. This models a
  // partial posting without inventing a second failure mode and without letting
  // a test marker into the proposal payload (additionalProperties is false).
  const short = env('DUMMY_READBACK_SHORT', '') === '1';
  const applied = short ? Math.max(0, required - 1) : required;
  col.records[rec.payload.window] = before + applied;
  // Also append applied records to items for query visibility (only the applied part).
  for (let i = 0; i < applied; i += 1) { const r = rec.payload.records[i]; col.items.push({ id: `rec-${proposalId.slice(5, 13)}-${i}`, name: r.name, value: r.value }); }
  saveState(state);
  rec.status = 'committed';
  saveProposals(proposals);
  const after = col.records[rec.payload.window];
  const delta = after - before;
  if (delta < required) {
    // Committed, NOT pending (never allow a second commit), but NOT verified.
    // The host must report committed_unverified, never "completed".
    emit(opName, 'failed', { proposalId, ok: false, verified: false, readBack: { before, after, delta, required } }, { code: 'PROPOSAL_VERIFY_SHORT', message: 'Readback short: applied fewer records than required' });
    return 1;
  }
  const summaryText = `Proposal ${proposalId} applied: collection "${rec.payload.collection}" window ${rec.payload.window}, ${required} record(s); readback delta ${delta}.`;
  emit(opName, 'completed', { ok: true, proposalId, verified: true, summaryText, collection: rec.payload.collection, window: rec.payload.window, count: required, readBack: { before, after, delta, required } }, null);
  return 0;
}
// ---- plan ----
function planPolicy() {
  const num = (name, dflt) => { const n = Number(env(name, '')); return Number.isFinite(n) && n > 0 ? n : dflt; };
  return {
    autoCalls: num('DUMMY_PLAN_AUTO_CALLS', 2), notifyCalls: num('DUMMY_PLAN_NOTIFY_CALLS', 10), confirmCalls: num('DUMMY_PLAN_CONFIRM_CALLS', 20), hardCalls: num('DUMMY_PLAN_HARD_CALLS', 50),
    autoSeconds: num('DUMMY_PLAN_AUTO_SECONDS', 60), notifySeconds: num('DUMMY_PLAN_NOTIFY_SECONDS', 180), confirmSeconds: num('DUMMY_PLAN_CONFIRM_SECONDS', 600), hardSeconds: num('DUMMY_PLAN_HARD_SECONDS', 1800),
    autoWeight: num('DUMMY_PLAN_AUTO_WEIGHT', 6), notifyWeight: num('DUMMY_PLAN_NOTIFY_WEIGHT', 18), budgetWeight: num('DUMMY_PLAN_BUDGET_WEIGHT', 60), hardWeight: num('DUMMY_PLAN_HARD_WEIGHT', 180),
  };
}
function planDecision(calls, seconds, weight, p, grantLevel, previous) {
  const scale = 1 + (grantLevel || 0);
  const rank = { execute: 0, notify: 1, confirm: 2, stop: 3 };
  let tier = 'execute'; let reason = 'WITHIN_AUTO_THRESHOLD';
  if (calls > p.hardCalls * scale || seconds > p.hardSeconds * scale) { tier = 'stop'; reason = 'HARD_LIMIT'; }
  else if (calls > p.confirmCalls * scale || seconds > p.confirmSeconds * scale) { tier = 'confirm'; reason = 'CONFIRM_THRESHOLD'; }
  else if (calls > p.notifyCalls * scale || seconds > p.notifySeconds * scale) { tier = 'notify'; reason = 'NOTIFY_THRESHOLD'; }
  else if (calls > p.autoCalls * scale || seconds > p.autoSeconds * scale) { tier = 'notify'; reason = previous ? 'SCOPE_EXPANSION' : 'INITIAL_SCOPE_THRESHOLD'; }
  let wt = 'execute'; let wr = 'WITHIN_AUTO_THRESHOLD';
  if (weight > p.hardWeight * scale) { wt = 'stop'; wr = 'HARD_WEIGHT'; }
  else if (weight >= p.budgetWeight * scale) { wt = 'confirm'; wr = 'BUDGET_WEIGHT'; }
  else if (weight > p.notifyWeight * scale) { wt = 'notify'; wr = 'NOTIFY_THRESHOLD'; }
  else if (weight > p.autoWeight * scale) { wt = 'notify'; wr = previous ? 'SCOPE_EXPANSION' : 'INITIAL_SCOPE_THRESHOLD'; }
  return rank[wt] > rank[tier] ? [wt, wr] : [tier, reason];
}
function readStdin() { return new Promise((resolve) => { let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { data += c; }); process.stdin.on('end', () => resolve(data)); }); }
async function planEvaluate(taskId, argv) {
  const { flags } = parseFlags(argv);
  let inputText = '';
  if (flags.stdin) inputText = await readStdin();
  else if (flags.json) inputText = flags.json;
  else { process.stderr.write('plan evaluate requires --stdin or --json\n'); return 2; }
  let input;
  try { input = JSON.parse(inputText); } catch { process.stderr.write('PLAN_REFUSE plan draft is not JSON\n'); return 2; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) { process.stderr.write('PLAN_REFUSE plan draft is not an object\n'); return 2; }
  const allowed = ['calls', 'requestId', 'goal'];
  const extra = Object.keys(input).filter((k) => !allowed.includes(k));
  if (extra.length) { process.stderr.write(`PLAN_REFUSE unknown field: ${extra.join(',')}\n`); return 2; }
  if (!Array.isArray(input.calls) || input.calls.length === 0) { process.stderr.write('PLAN_REFUSE plan calls required\n'); return 2; }
  const calls = [];
  for (const c of input.calls) {
    if (!c || typeof c.operation !== 'string' || !Array.isArray(c.args)) { process.stderr.write('PLAN_REFUSE bad plan call\n'); return 2; }
    const op = OPERATIONS.find((o) => o.name === c.operation);
    if (!op) { process.stderr.write(`PLAN_REFUSE unknown operation: ${c.operation}\n`); return 2; }
    if (op.access !== 'read' && op.access !== 'scratch') { process.stderr.write(`PLAN_REFUSE operation not read-only: ${c.operation}\n`); return 2; }
    calls.push({ operation: op.name, args: c.args.map(String), seconds: op.est_seconds, weight: op.weight, key: JSON.stringify([op.name, c.args]) });
  }
  const plans = loadPlans();
  const p = planPolicy();
  const previous = plans.tasks[taskId] || { actual: { calls: 0, seconds: 0 }, latestPlanId: null, grantLevel: 0, declaredWeight: 0 };
  const requestKey = crypto.createHash('sha256').update(JSON.stringify({ requestId: input.requestId || null, calls: calls.map((c) => [c.operation, c.args]) })).digest('hex');
  const oldPlan = previous.latestPlanId ? plans.plans[previous.latestPlanId] : null;
  if (oldPlan && oldPlan.requestKey === requestKey) {
    process.stdout.write(JSON.stringify({ planId: oldPlan.id, version: oldPlan.version, decision: oldPlan.decision, estimate: oldPlan.estimate, delta: oldPlan.delta, cumulative: { calls: previous.actual.calls, seconds: previous.actual.seconds, estimatedCalls: previous.actual.calls + oldPlan.estimate.calls, estimatedSeconds: previous.actual.seconds + oldPlan.estimate.seconds }, reasonCode: oldPlan.reasonCode, status: oldPlan.status }) + '\n');
    return 0;
  }
  const seconds = calls.reduce((s, c) => s + c.seconds, 0);
  const weight = calls.reduce((s, c) => s + c.weight, 0);
  previous.declaredWeight = (previous.declaredWeight || 0) + weight;
  const totalCalls = previous.actual.calls + calls.length;
  const totalSeconds = previous.actual.seconds + seconds;
  const [decision, reasonCode] = planDecision(totalCalls, totalSeconds, previous.declaredWeight, p, previous.grantLevel || 0, Boolean(oldPlan));
  if (decision !== 'stop') { for (const prior of Object.values(plans.plans)) { if (prior.taskId === taskId && ['active', 'pending'].includes(prior.status)) prior.status = 'superseded'; } }
  const id = crypto.randomUUID();
  const version = (oldPlan ? oldPlan.version : 0) + 1;
  const status = decision === 'execute' ? 'active' : decision === 'stop' ? 'stopped' : 'pending';
  const plan = { id, taskId, version, requestKey, status, decision, reasonCode, estimate: { calls: calls.length, seconds, weight }, delta: { addedCalls: calls.length, addedSeconds: seconds, calls: calls.map((c) => ({ operation: c.operation, args: c.args })) }, calls, actual: { calls: 0, seconds: 0 } };
  plans.plans[id] = plan;
  previous.latestPlanId = id;
  plans.tasks[taskId] = previous;
  savePlans(plans);
  process.stdout.write(JSON.stringify({ planId: id, version, decision, estimate: plan.estimate, delta: plan.delta, cumulative: { calls: previous.actual.calls, seconds: previous.actual.seconds, estimatedCalls: totalCalls, estimatedSeconds: totalSeconds }, reasonCode, status, scopeSummary: `${calls.length} call(s), ${seconds}s, weight ${weight}` }) + '\n');
  return 0;
}
function planCurrent(taskId) {
  const plans = loadPlans();
  const task = plans.tasks[taskId];
  const plan = task && task.latestPlanId ? plans.plans[task.latestPlanId] : null;
  if (plan && plan.status === 'active') process.stdout.write(JSON.stringify({ taskId, planId: plan.id, version: plan.version, status: 'active' }) + '\n');
  else process.stdout.write(JSON.stringify({ taskId, planId: null, version: null, status: 'none' }) + '\n');
  return 0;
}
function planStatus(planId) {
  const plans = loadPlans();
  const plan = plans.plans[planId];
  if (!plan) { process.stdout.write(JSON.stringify({ planId: String(planId), version: null, status: 'missing' }) + '\n'); return 0; }
  process.stdout.write(JSON.stringify({ planId: plan.id, version: plan.version, status: plan.status, decision: plan.decision, reasonCode: plan.reasonCode }) + '\n');
  return 0;
}
async function planActivate(argv) {
  const { flags } = parseFlags(argv);
  let inputText = '';
  if (flags.stdin) inputText = await readStdin(); else { process.stderr.write('plan activate requires --stdin\n'); return 2; }
  let input;
  try { input = JSON.parse(inputText); } catch { process.stderr.write('PLAN_REFUSE activation input is not JSON\n'); return 2; }
  const { planId, evidence, token } = input;
  const secret = env2('DUMMY_PLAN_ACTIVATION_SECRET', 'EXECUTION_PLAN_ACTIVATION_SECRET', '');
  let ok = false;
  try {
    if (secret && token) {
      const [body, sig] = String(token).split('.');
      const expect = crypto.createHmac('sha256', secret).update(body).digest();
      const got = Buffer.from(sig, 'base64url');
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      ok = expect.length === got.length && crypto.timingSafeEqual(expect, got) && parsed.planId === planId && parsed.evidence === evidence && Number.isFinite(parsed.expires) && parsed.expires >= Date.now() && parsed.expires <= Date.now() + 5 * 60 * 1000;
    }
  } catch { ok = false; }
  if (!ok) { process.stderr.write('PLAN_REFUSE activation token untrusted\n'); return 3; }
  const plans = loadPlans();
  const plan = plans.plans[planId];
  if (!plan) { process.stderr.write('PLAN_REFUSE plan not found\n'); return 3; }
  if (plan.status === 'active' && plan.activatedEvidence === evidence) { process.stdout.write(JSON.stringify({ planId, version: plan.version, status: plan.status }) + '\n'); return 0; }
  if (plan.status !== 'pending') { process.stderr.write(`PLAN_REFUSE plan not pending: ${plan.status}\n`); return 3; }
  plan.status = 'active'; plan.activatedEvidence = evidence;
  const task = plans.tasks[plan.taskId];
  if (task && (plan.reasonCode === 'BUDGET_WEIGHT' || plan.reasonCode === 'CONFIRM_THRESHOLD')) task.grantLevel = (task.grantLevel || 0) + 1;
  savePlans(plans);
  process.stdout.write(JSON.stringify({ planId, version: plan.version, status: 'active' }) + '\n');
  return 0;
}
function usage() {
  return [
    'Usage: dummy [--mode build|serve] <plan evaluate|current|activate|memory|breaker|cache|proposal status|operation list|query|prepare|commit|local|call> [args...]',
    'Examples:',
    '  dummy plan evaluate --task-id task-1 --stdin',
    '  dummy plan current --task-id task-1',
    '  dummy plan activate --stdin  # host provides planId/evidence/token as JSON on stdin',
    '  dummy plan --schema          # print plan draft shape',
    '  dummy proposal status --proposal-id prop_1234',
    '  dummy operation list --json',
    '  dummy query dummy.query --collection alpha --window W1',
    '  dummy prepare dummy.proposal <payload-file>  # proposal.create, by operation name',
    '  dummy commit dummy.proposal-commit --proposal-id prop_1234',
    '  dummy call --file <structured-call.json>  # structured call protocol',
  ].join('\n') + '\n';
}
async function main() {
  let argv = [...process.argv.slice(2)];
  let mode = 'build';
  if (argv[0] === '--mode') { mode = argv[1]; argv = argv.slice(2); if (!['build', 'serve'].includes(mode)) { process.stderr.write(`Unknown CLI mode: ${mode}\n`); return 2; } }
  if (argv.length === 0 || argv[0] === '--help') { process.stdout.write(usage()); return argv.length ? 0 : 2; }
  const [cmd, sub] = argv;
  if (cmd === 'operation' && sub === 'list') {
    if (argv.includes('--json')) {
      process.stdout.write(JSON.stringify({ operations: OPERATIONS.map((o) => ({ name: o.name, domain: o.domain, command: o.command, access: o.access, script: o.script, sharedLocalWrite: false, effects: o.access === 'read' ? ['read'] : o.access === 'scratch' ? ['local'] : ['write'], executor: o.executor, est_seconds: o.est_seconds, weight: o.weight, args: o.args, serve: o.serve, protocol: o.protocol, label: LABELS[o.name] ?? '', proposalSchema: o.protocol === 'proposal.create' ? PROPOSAL_SCHEMA : null })), accessSemantics: ACCESS_SEMANTICS }) + '\n');
      return 0;
    }
    for (const o of OPERATIONS) process.stdout.write(`${o.name}\t${o.command}\t${o.access}\t${o.executor}\t${LABELS[o.name] ?? ''}\n`);
    return 0;
  }
  if (cmd === 'plan') {
    if (sub === '--schema') { process.stdout.write(JSON.stringify(PLAN_SCHEMA, null, 2) + '\n'); return 0; }
    if (sub === 'evaluate') { const { flags } = parseFlags(argv.slice(2)); if (!flags['task-id']) { process.stderr.write('plan evaluate requires --task-id\n'); return 2; } return planEvaluate(flags['task-id'], argv.slice(2)); }
    if (sub === 'current') { const { flags } = parseFlags(argv.slice(2)); if (!flags['task-id']) { process.stderr.write('plan current requires --task-id\n'); return 2; } return planCurrent(flags['task-id']); }
    if (sub === 'status') { const { flags } = parseFlags(argv.slice(2)); if (!flags['plan-id']) { process.stderr.write('plan status requires --plan-id\n'); return 2; } return planStatus(flags['plan-id']); }
    if (sub === 'activate') return planActivate(argv.slice(2));
    process.stderr.write('Usage: dummy plan evaluate --task-id <id> (--stdin|--json <json>) | plan current --task-id <id> | plan status --plan-id <id> | plan activate --stdin | plan --schema\n'); return 2;
  }
  if (cmd === 'proposal' && sub === 'status') {
    const { flags } = parseFlags(argv.slice(2));
    if (!flags['proposal-id']) { process.stderr.write('proposal status requires --proposal-id\n'); return 2; }
    return doProposalStatus(flags['proposal-id']);
  }
  if (cmd === 'call') {
    const { flags } = parseFlags(argv.slice(1));
    const file = flags['file'];
    if (!file) { process.stderr.write('call requires --file <structured-call.json>\n'); return 2; }
    let call;
    try { call = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { process.stderr.write(`CALL_REFUSE payload unreadable: ${e.message}\n`); return 3; }
    if (!call.operation) { process.stderr.write('CALL_REFUSE payload must be { operation: string, args: ... }\n'); return 3; }
    // Accept both legacy array format and current protocol object format.
    if (Array.isArray(call.args)) {
      // legacy path: args is string[] (flat flag array) — no shape change.
    } else if (typeof call.args === 'object' && call.args !== null) {
      // structured-call protocol path: args is Record<string, unknown>.
      // Validate against operation declaration and convert to flat flag array.
      const op = resolveOperation(call.operation);
      if (!op) { process.stderr.write('CALL_REFUSE unregistered operation: ' + call.operation + '\n'); audit({ mode: 'call', script: call.operation, args: call.args, serve: mode === 'serve', refused: 'unregistered' }); return 3; }
      const allowed = new Set();
      for (const f of (op.args?.flags || [])) allowed.add(f.flag);
      for (const p of (op.args?.positional || [])) allowed.add(p.name);
      const undeclared = Object.keys(call.args).filter((k) => !allowed.has(k));
      if (undeclared.length > 0) {
        process.stderr.write('CALL_REFUSE undeclared args: ' + undeclared.join(', ') + '\n');
        return 3;
      }
      const flat = [];
      for (const [key, value] of Object.entries(call.args)) {
        if (value === false || value === null || value === undefined) continue;
        flat.push(key);
        if (value !== true) flat.push(String(value));
      }
      call.args = flat;
    } else {
      process.stderr.write('CALL_REFUSE payload args must be string[] or Record<string, unknown>\n'); return 3;
    }
    const op = resolveOperation(call.operation);
    if (!op) { process.stderr.write('CALL_REFUSE unregistered operation: ' + call.operation + '\n'); audit({ mode: 'call', script: call.operation, args: call.args, serve: mode === 'serve', refused: 'unregistered' }); return 3; }
    // Proposal protocol routing (by operation name, not script path -- same rule as any execution layer).
    // 两条路都**先记一行调用事实、再补一行最终结果**（2026-11-09 十审 major）：旧写法只在
    // 调用前记一行、没有 exitCode，于是评测的 classifyExecutionCall 永远拿不到 exitCode=0，
    // 正常确认并读回成功的写链也只能停在 invoked——mechanicallyPassed 恒 false、令牌拒绝也
    // 进不了 gateRefusals。执行层自己的账必须含"这次调用最终成没成"，否则调用方无从判定。
    // 起止两行共用同一个 callId（2026-11-09 十一审 major）：评测侧据此把"开始"与"结果"
    // 合并成同一次调用——否则开始行（无 exitCode）会永久停在 invoked，messageLadderRung 取
    // 最低档后即使提交成功也报 invoked/机械失败，且调用数被重复计一次。开始行仍然要留：
    // 进程在调用中途崩溃时只有它，那是"这次调用发出过但没有结果"的唯一证据。
    if (op.protocol === 'proposal.create') {
      const callId = `call_${crypto.randomUUID().slice(0, 8)}`;
      audit({ callId, phase: 'start', mode: 'prepare', via: 'structured', script: op.name, args: call.args, serve: mode === 'serve', protocol: op.protocol });
      const code = doProposalCreate(op.name, call.args);
      audit({ callId, phase: 'result', mode: 'prepare', via: 'structured', script: op.name, args: call.args, serve: mode === 'serve', protocol: op.protocol, exitCode: code, ...(code !== 0 ? { refused: 'proposal' } : {}) });
      return code;
    }
    if (op.protocol === 'proposal.commit') {
      const { flags: innerFlags } = parseFlags(call.args);
      if (!innerFlags['proposal-id']) { process.stderr.write('PROPOSAL_REFUSE missing --proposal-id\n'); return 3; }
      const callId = `call_${crypto.randomUUID().slice(0, 8)}`;
      audit({ callId, phase: 'start', mode: 'commit', via: 'structured', script: op.name, args: call.args, serve: mode === 'serve', protocol: op.protocol, proposalId: innerFlags['proposal-id'] });
      const code = doProposalCommit(op.name, call.args);
      audit({ callId, phase: 'result', mode: 'commit', via: 'structured', script: op.name, args: call.args, serve: mode === 'serve', protocol: op.protocol, proposalId: innerFlags['proposal-id'], exitCode: code, ...(code !== 0 ? { refused: 'proposal' } : {}) });
      return code;
    }
    // Determine mode from operation access.
    const accessMode = op.access === 'read' || op.access === 'scratch' ? 'query' : 'prepare';
    const verdict = decide(accessMode, op, call.args);
    if (!verdict.allowed) { process.stderr.write(`GATE_REFUSE ${verdict.reason}\n`); audit({ mode: 'call', script: op.name, args: call.args, serve: mode === 'serve', refused: verdict.reason }); return 3; }
    const planId = env2('DUMMY_PLAN_ID', 'EXECUTION_PLAN_ID', '');
    const requirePlan = env2('DUMMY_REQUIRE_PLAN', 'EXECUTION_REQUIRE_PLAN', '') === '1';
    if (requirePlan && !planId && (op.access === 'read' || op.access === 'scratch')) { process.stderr.write('GATE_REFUSE serve execution requires a host-injected plan id\n'); audit({ mode: 'call', script: op.name, args: call.args, serve: mode === 'serve', refused: 'PLAN_REQUIRED' }); return 3; }
    let code;
    let queryResult;
    if (op.name === 'dummy.query' || op.name === 'ballot.query') { const q = doQuery(op.name, call.args); code = q.code; queryResult = q.result; }
    else if (op.name === 'dummy.scratch' || op.name === 'ballot.scratch') code = doScratch(op.name, call.args);
    else if (op.name === 'dummy.prepare' || op.name === 'ballot.prepare') code = doPrepare(op.name, call.args);
    else if (op.name === 'dummy.commit' || op.name === 'ballot.commit') {
      const secret = env2('DUMMY_GATE_SECRET', 'EXECUTION_GATE_SECRET', '');
      const token = env2('DUMMY_COMMIT_TOKEN', 'EXECUTION_COMMIT_TOKEN', '');
      if (secret) {
        let ok = false;
        try {
          const [body, sig] = String(token).split('.');
          const expect = crypto.createHmac('sha256', secret).update(body).digest();
          const got = Buffer.from(sig, 'base64url');
          const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
          ok = expect.length === got.length && crypto.timingSafeEqual(expect, got) && p.script === op.name && new Date(p.expiresAt).getTime() > Date.now();
        } catch { ok = false; }
        if (!ok) { process.stderr.write('GATE_REFUSE commit token verification failed\n'); audit({ mode: 'call', script: op.name, args: call.args, serve: mode === 'serve', refused: 'commit-token' }); return 3; }
      }
      code = doCommit(op.name, call.args);
    } else { process.stderr.write('GATE_REFUSE no handler for ' + op.name + '\n'); return 3; }
    // mode 记**按 access 分级**的值（2026-11-09 九审 major）：旧写法这里无脑记 'call'，
    // 而 bash 路径按 access 算 query/prepare——于是同一次 dummy.query，走 bash 落
    // mode:'query'、走结构化落 mode:'call'，评测侧据 mode 判读类的逻辑只认前者，结构化查询
    // 就算 exitCode=0 且已送达也只能停在 completed，报告随调用载体变化。
    // 载体信息不丢：另记 via:'structured'。
    // query 的 completed/needs_input/not_found 行把该次实际结果状态写进审计行 result
    // （audited 申报模式交叉核的事实基准：结果状态与 items 都可供独立核对）；被拒/失败的
    // 行没有 queryResult，不带 result。
    audit({ mode: accessMode, via: 'structured', script: op.name, args: call.args, serve: mode === 'serve', exitCode: code, planId: planId || undefined, ...(queryResult ? { result: queryResult } : {}) });
    if (planId && code === 0 && (op.access === 'read' || op.access === 'scratch')) {
      try {
        const plans = loadPlans();
        const plan = plans.plans[planId];
        if (plan) { plan.actual.calls += 1; plan.actual.seconds += op.est_seconds; savePlans(plans); }
      } catch { /* accounting must not turn a success into a failure */ }
    }
    return code;
  }
  if (['query', 'prepare', 'commit', 'local'].includes(cmd)) {
    const target = argv[1];
    const rest = argv.slice(2);
    // local: scratch scripts under <fixture>/tmp/ only (mirrors the local rule of an execution layer, simplified).
    if (cmd === 'local') {
      if (!target) { process.stderr.write('usage: dummy local <script> [args...]\n'); return 2; }
      const abs = path.resolve(target);
      const tmpRoot = path.join(FIXTURE_ROOT, 'tmp') + path.sep;
      if (!abs.startsWith(tmpRoot) || !fs.existsSync(abs)) { process.stderr.write(`GATE_REFUSE local mode only allows scripts under ${tmpRoot}\n`); audit({ mode: 'local', script: target, args: rest, serve: mode === 'serve', refused: 'local-out-of-tmp' }); return 3; }
      const r = spawnSync(process.execPath, [abs, ...rest], { stdio: 'inherit', cwd: FIXTURE_ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
      audit({ mode: 'local', script: path.relative(FIXTURE_ROOT, abs), args: rest, serve: mode === 'serve', exitCode: r.status });
      return r.status == null ? 1 : r.status;
    }
    if (!target) { process.stderr.write(`usage: dummy ${cmd} <operation-or-script> [args...]\n`); return 2; }
    const op = resolveOperation(target);
    if (!op) { process.stderr.write(`GATE_REFUSE script not registered: ${target}\n`); audit({ mode: cmd, script: target, args: rest, serve: mode === 'serve', refused: 'unregistered' }); return 3; }
    // Proposal protocol routing (by operation name, not script path -- same rule as any execution layer).
    // 起止两行 + 同一 callId（2026-11-09 十二审 major）：bash 侧这条路径与结构化侧同规，
    // 都要补结果行——否则 classifyExecutionCall 拿不到 exitCode=0，正常完成并读回的 bash
    // 提交也永远停在 invoked，mechanicallyPassed 判失败、令牌拒绝也没有 refused 证据。
    if (op.protocol === 'proposal.create' && cmd === 'prepare') {
      const callId = `call_${crypto.randomUUID().slice(0, 8)}`;
      audit({ callId, phase: 'start', mode: cmd, script: op.name, args: rest, serve: mode === 'serve', protocol: op.protocol });
      const code = doProposalCreate(op.name, rest);
      audit({ callId, phase: 'result', mode: cmd, script: op.name, args: rest, serve: mode === 'serve', protocol: op.protocol, exitCode: code, ...(code !== 0 ? { refused: 'proposal' } : {}) });
      return code;
    }
    if (op.protocol === 'proposal.commit' && cmd === 'commit') {
      const { flags } = parseFlags(rest);
      if (!flags['proposal-id']) { process.stderr.write('PROPOSAL_REFUSE missing --proposal-id\n'); return 3; }
      const callId = `call_${crypto.randomUUID().slice(0, 8)}`;
      audit({ callId, phase: 'start', mode: cmd, script: op.name, args: rest, serve: mode === 'serve', protocol: op.protocol, proposalId: flags['proposal-id'] });
      const code = doProposalCommit(op.name, rest);
      audit({ callId, phase: 'result', mode: cmd, script: op.name, args: rest, serve: mode === 'serve', protocol: op.protocol, proposalId: flags['proposal-id'], exitCode: code, ...(code !== 0 ? { refused: 'proposal' } : {}) });
      return code;
    }
    const verdict = decide(cmd, op, rest);
    if (!verdict.allowed) { process.stderr.write(`GATE_REFUSE ${verdict.reason}\n`); audit({ mode: cmd, script: op.name, args: rest, serve: mode === 'serve', refused: verdict.reason }); return 3; }
    // Plan binding (only when the caller opts in, mirroring EXECUTION_REQUIRE_PLAN).
    const planId = env2('DUMMY_PLAN_ID', 'EXECUTION_PLAN_ID', '');
    const requirePlan = env2('DUMMY_REQUIRE_PLAN', 'EXECUTION_REQUIRE_PLAN', '') === '1';
    if (requirePlan && !planId && (op.access === 'read' || op.access === 'scratch')) { process.stderr.write('GATE_REFUSE serve execution requires a host-injected plan id\n'); audit({ mode: cmd, script: op.name, args: rest, serve: mode === 'serve', refused: 'PLAN_REQUIRED' }); return 3; }
    let code;
    let queryResult;
    if (op.name === 'dummy.query' || op.name === 'ballot.query') { const q = doQuery(op.name, rest); code = q.code; queryResult = q.result; }
    else if (op.name === 'dummy.scratch' || op.name === 'ballot.scratch') code = doScratch(op.name, rest);
    else if (op.name === 'dummy.prepare' || op.name === 'ballot.prepare') code = doPrepare(op.name, rest);
    else if (op.name === 'dummy.commit' || op.name === 'ballot.commit') {
      // Direct (non-proposal) commit requires a commit token when a gate secret is set,
      // mirroring gateway commit-token binding (operation name preferred).
      const secret = env2('DUMMY_GATE_SECRET', 'EXECUTION_GATE_SECRET', '');
      const token = env2('DUMMY_COMMIT_TOKEN', 'EXECUTION_COMMIT_TOKEN', '');
      if (secret) {
        let ok = false;
        try {
          const [body, sig] = String(token).split('.');
          const expect = crypto.createHmac('sha256', secret).update(body).digest();
          const got = Buffer.from(sig, 'base64url');
          const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
          ok = expect.length === got.length && crypto.timingSafeEqual(expect, got) && p.script === op.name && new Date(p.expiresAt).getTime() > Date.now();
        } catch { ok = false; }
        if (!ok) { process.stderr.write('GATE_REFUSE commit token verification failed\n'); audit({ mode: cmd, script: op.name, args: rest, serve: mode === 'serve', refused: 'commit-token' }); return 3; }
      }
      code = doCommit(op.name, rest);
    } else { process.stderr.write(`GATE_REFUSE no handler for ${op.name}\n`); return 3; }
    // query 的 completed/needs_input/not_found 行把该次实际结果状态写进审计行 result
    // （audited 申报模式交叉核的事实基准：结果状态与 items 都可供独立核对）；被拒/失败的
    // 行没有 queryResult，不带 result。
    audit({ mode: cmd, script: op.name, args: rest, serve: mode === 'serve', exitCode: code, planId: planId || undefined, ...(queryResult ? { result: queryResult } : {}) });
    // Plan accounting: a successful plannable call under a plan id counts toward it.
    if (planId && code === 0 && (op.access === 'read' || op.access === 'scratch')) {
      try {
        const plans = loadPlans();
        const plan = plans.plans[planId];
        if (plan) { plan.actual.calls += 1; plan.actual.seconds += op.est_seconds; savePlans(plans); }
      } catch { /* accounting must not turn a success into a failure */ }
    }
    return code;
  }
  process.stderr.write(usage());
  return 2;
}
main().then((code) => { process.exitCode = code; }).catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exitCode = 1; });
