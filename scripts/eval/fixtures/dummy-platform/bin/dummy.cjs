#!/usr/bin/env node
/**
 * Generic mock execution layer for fshine-agent eval (Phase 1, dummy-platform).
 *
 * Purpose: prove the orchestration layer works against ANY execution layer that
 * speaks the same protocol, without coupling to a concrete domain. Domain words
 * here are deliberately neutral: record / collection / window. No finance,
 * voucher, account-set or period vocabulary lives in this fixture.
 *
 * Transport: binary CLI only, same surface as any execution-layer gateway (see docs/architecture/contract.md; 原 docs/architecture/contract.md 已删，git 历史可考):
 *   operation list --json | plan --schema | plan evaluate/current/status/activate
 *   proposal status | query|prepare|commit|local <target> [args]
 * Protocol: RESULT envelope v1 on the last stdout line, exit codes 0/1/2/3.
 *   0 = deterministic answer (completed / needs_input / not_found)
 *   1 = domain failure (e.g. missing required flag, dry-run failure)
 *   2 = usage / schema failure (unknown command, unknown field, locked collection)
 *   3 = gateway / proposal refusal (unregistered, serve matrix, token, expired,
 *       corrupt state, plan not active when a plan is required)
 * State: per-case root, reset = delete the directory / add a fresh one. Next call
 * re-seeds. The root comes ONLY from the test-only flag `--state-dir <path>`
 * (dummy test surface, NOT a consumption protocol): the host's production path
 * injects no state location at all, and the four former env names
 * (EXECUTION_MOCK_STATE / EXECUTION_PLAN_STATE / EXECUTION_PROPOSAL_STATE /
 * EXECUTION_AUDIT_PATH, plus the DUMMY_* debug fallbacks) are retired from this
 * fixture — ambient state paths cannot redirect it.
 *   <state-dir>/dummy-state.json   (collections + records)
 *   <state-dir>/plans.json         (plans)
 *   <state-dir>/proposals.json     (proposals)
 *   <state-dir>/confirmations.json (write-confirmation handles: binding + TTL + used)
 *   <state-dir>/audit.jsonl        (JSONL audit, refusals included; only when
 *                                   --state-dir is given, null otherwise)
 * Default root (no flag) = <fixture>/.runtime (manual debug runs).
 * Naming family (docs/environment-variables.md §前缀规则 + the 2026-11-10 consumer
 * boundary addendum; the original docs/ops/README.md 已删，git 历史可考): EXECUTION_* remains the canonical family for the token
 * surface; DUMMY_* are debug-only entries read second. C-class per-case knobs
 * such as DUMMY_READBACK_SHORT keep their fixture names (see docs §9).
 * Call shape: this fixture does not take a domain declaration (no domain env,
 * no domain flag). Whether a call was orchestration-driven is inferred from
 * materials on the call — a plan id (EXECUTION_PLAN_ID) or a signed commit
 * token (EXECUTION_COMMIT_TOKEN). It also reads EXECUTION_GATE_SECRET /
 * EXECUTION_REQUIRE_PLAN / EXECUTION_PLAN_ACTIVATION_SECRET directly
 * (DUMMY_* only as a debug fallback). It does NOT read LLM keys, WeCom
 * secrets or any other host secret.
 *
 * Deliberately NOT implemented in v1:
 * memory / breaker / cache auxiliary groups, grind/variant plan guards,
 * browser/platform execution. Those are
 * execution-layer-instance specifics, not protocol; no in-repo harness scores them
 * (the retired generic-mock eval did; registration in docs/decisions/index.md §十三),
 * and they are not faked.
 * (A per-state-dir rate-limit window WAS added later — 2026-11-14 business E2E #4 —
 *  driven by <state-dir>/rate-limit-config.json or DUMMY_RATE_LIMIT_MAX; see below.)
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const runtime = require('../runtime/index.cjs');
const { parseDelayMs, sleepSync } = require('../runtime/timing.cjs');
const FIXTURE_ROOT = path.resolve(__dirname, '..');
const FIXTURES_ROOT = path.resolve(FIXTURE_ROOT, '..');
// 三层分离：能力定义（platforms/…/capabilities.json）、数据/绑定/故障（scenarios/…）、
// 通用加载器（runtime/，不懂业务）。配置是纯数据，加载器不执行任何配置脚本。
const PLATFORM = runtime.loadPlatform({ fixturesRoot: FIXTURES_ROOT, platformId: 'dummy-platform' });
const SCENARIO = runtime.loadScenario({ fixturesRoot: FIXTURES_ROOT, scenarioId: PLATFORM.scenarioId });
const OPERATIONS = PLATFORM.operations;
const LABELS = PLATFORM.labels;
const ACCESS_SEMANTICS = Object.freeze(PLATFORM.accessSemantics);
const READ_DECLARATIONS = PLATFORM.reads;
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
const CORRECT_FORM = PLATFORM.errorCatalog;
function env(name, fallback) { const v = process.env[name]; return v === undefined || v === '' ? fallback : v; }
/** Canonical-first lookup for the remaining env surface (tokens + C-class knobs):
 *  EXECUTION_* wins, the fixture-specific name is a debug entry (manual runs),
 *  then the default. State paths do NOT go through env (see statePaths). */
function env2(canonical, debug, fallback) { return env(canonical, env(debug, fallback)); }
/** 编排驱动不由调用方声明。计划绑定或签名令牌在这次调用上 = 被编排驱动。 */
function orchestrated() {
  return env2('EXECUTION_PLAN_ID', 'DUMMY_PLAN_ID', '') !== ''
    || env2('EXECUTION_COMMIT_TOKEN', 'DUMMY_COMMIT_TOKEN', '') !== '';
}
/** Test-only state root (dummy test surface, not a consumption protocol). */
let stateDirOverride = null;
/**
 * Consume `--state-dir <path>` / `--state-dir=<path>` from argv at any position
 * and strip it before command parsing. Missing value is a usage error (fail
 * loudly, never silently fall back to the default root).
 */
function takeStateDirFlag(argv) {
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state-dir') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) return { rest, error: '--state-dir requires a path' };
      stateDirOverride = path.resolve(value);
      i += 1;
      continue;
    }
    if (arg.startsWith('--state-dir=')) {
      const value = arg.slice('--state-dir='.length);
      if (value === '') return { rest, error: '--state-dir requires a path' };
      stateDirOverride = path.resolve(value);
      continue;
    }
    rest.push(arg);
  }
  return { rest, error: null };
}
function statePaths() {
  const dir = stateDirOverride ?? path.join(FIXTURE_ROOT, '.runtime');
  return {
    stateFile: path.join(dir, 'dummy-state.json'),
    planFile: path.join(dir, 'plans.json'),
    proposalFile: path.join(dir, 'proposals.json'),
    confirmationFile: path.join(dir, 'confirmations.json'),
    // Audit is evidence for the eval harness: only written when the caller asked
    // for a per-case root. A bare manual run keeps the historical "no audit" default.
    auditFile: stateDirOverride === null ? null : path.join(dir, 'audit.jsonl'),
  };
}
function seedState() { return runtime.buildSeedState(SCENARIO); }

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
function loadConfirmations() { const s = loadJson(statePaths().confirmationFile, null); return (s && s.confirmations) ? s : { confirmations: {} }; }
function saveConfirmations(s) { saveJson(statePaths().confirmationFile, s); }
// 审计写失败要响（2026-11-08）：audit 是执行层证据的唯一来源（评测数 <state-dir>/audit.jsonl
// 的行数与 refused 判定），写失败还静默继续 = 调用无痕，评测只能得出 INCONCLUSIVE 甚至
// 假绿。改为失败即抛——外层 main().catch 会把栈打到 stderr 并以非零码退出，这次调用
// 因此整体失败（fail-closed），绝不出现"执行了但没留痕"的成功。
function audit(row) {
  const f = statePaths().auditFile;
  if (!f) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}
function emit(op, status, data, error, extra) {
  const envelope = { v: 1, op, status, data: data ?? null, error: error ? { code: error.code, message: error.message, ...(error.correctForm ? { correctForm: error.correctForm } : {}), ...(error.retryable !== undefined ? { retryable: error.retryable } : {}) } : null, ...(extra ?? {}) };
  process.stdout.write('RESULT ' + JSON.stringify(envelope) + '\n');
  return envelope;
}
function errObj(code, message) { return runtime.makeError(CORRECT_FORM, code, message); }
// ── 限流（业务 E2E 阶段 1 增项，2026-11-14；阶段 2·R2 改为状态根驱动）─────────────
// 每 state-dir 计数窗口：该 state-dir 在一个窗口内最多 N 次实际执行的 operation
// （门拒/计划查询等不计）。超限返回 failed 信封 +
// ExecutionFailure{code:'RATE_LIMITED', message, retryable:true}，经现有 CLI
// 退出码（1=域失败）与 RESULT 信封表达，不新增协议面。计数落
// <state-dir>/rate-limit.json；不设旋钮时完全关闭（行为不变）。
//
// 旋钮来源（2026-11-14 R2：宿主 worker env 白名单 worker-env.ts 只放行 PATH/HOME/TMPDIR，
// DUMMY_* 经宿主路径不可达 → 限流从未触发、R1 #4 空洞）：
//   ① 主入口 = <state-dir>/rate-limit-config.json（经 --state-dir 传入，宿主可复现）：
//      { "max": <int>, "windowSeconds"?: <int> }。该文件落在 state 根，与 env 无关，
//      宿主按用例落到 state 根即可驱动，不依赖会被白名单丢弃的环境变量。
//   ② 兼容入口 = DUMMY_RATE_LIMIT_MAX / DUMMY_RATE_LIMIT_WINDOW_SECONDS（手工调试用，
//      不再是唯一入口）。文件存在且 max>0 时文件优先；否则回落 env。
function rateLimitConfigFile() {
  return path.join(path.dirname(statePaths().stateFile), 'rate-limit-config.json');
}
function rateLimitPolicy() {
  const cfg = loadJson(rateLimitConfigFile(), null);
  const fileMax = cfg && typeof cfg === 'object' ? Number(cfg.max) : Number.NaN;
  const fileWindow = cfg && typeof cfg === 'object' ? Number(cfg.windowSeconds) : Number.NaN;
  const max = Number.isInteger(fileMax) && fileMax > 0 ? fileMax : Number(env('DUMMY_RATE_LIMIT_MAX', ''));
  const windowRaw = Number.isInteger(fileWindow) && fileWindow > 0 ? fileWindow : Number(env('DUMMY_RATE_LIMIT_WINDOW_SECONDS', ''));
  if (!Number.isInteger(max) || max <= 0) return null;
  return { max, windowSeconds: Number.isInteger(windowRaw) && windowRaw > 0 ? windowRaw : 3600 };
}
/** 取一个执行名额；超限返回策略（不写审计——调用方落带 exitCode 的审计行）。 */
function rateLimitTake() {
  const p = rateLimitPolicy();
  if (!p) return null;
  const file = path.join(path.dirname(statePaths().stateFile), 'rate-limit.json');
  const window = Math.floor(Date.now() / (p.windowSeconds * 1000));
  const cur = loadJson(file, null);
  const count = cur && cur.window === window ? cur.count : 0;
  if (count >= p.max) return p;
  saveJson(file, { window, count: count + 1 });
  return null;
}
function rateLimitRefused(opName, mode, via, args) {
  const p = rateLimitTake();
  if (!p) return false;
  emit(opName, 'failed', null, { code: 'RATE_LIMITED', message: `Rate limit reached: max ${p.max} executed operation(s) per ${p.windowSeconds}s window for this state dir; retry after the window`, retryable: true });
  audit({ mode, ...(via ? { via } : {}), script: opName, args, serve: orchestrated(), exitCode: 1 });
  return true;
}
// ── 声明式延迟（2026-11-18）：--delay-ms 是显式声明的参数，真实 sleep ──────────────
// 只对登记了该 flag 的 operation 生效（dummy.query / dummy.prepare / dummy.commit）；
// 其它 operation 保持「未声明 flag 在 CLI 路径被忽略、在结构化 call 路径被拒」的既有行为。
// 取值必须是 0..60000 的整数，超限确定性拒绝（exit 2 + failed 信封 + 审计行），不截断。
function delayOf(op, args) {
  if (!(op.args?.flags ?? []).some((f) => f.flag === '--delay-ms')) return { ok: true, ms: 0 };
  const { flags } = parseFlags(args);
  return parseDelayMs(flags['delay-ms']);
}
function refuseDelay(opName, mode, via, args, parsed) {
  emit(opName, 'failed', null, errObj(parsed.code, parsed.message));
  audit({ mode, ...(via ? { via } : {}), script: opName, args, serve: orchestrated(), exitCode: 2 });
  return 2;
}
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
/**
 * 结构化 call 没有 mode 字段：由 operation 自己的 serve 矩阵派生唯一开放 mode。
 * 读/scratch 保持历史 query 优先；写 operation 必须唯一开放（prepare 或 commit），
 * 多个/零个开放 = 不猜，按未登记形态拒绝。这样 dummy.commit 不再被当成 prepare 拒掉。
 */
function structuredModeOf(op) {
  const open = ['query', 'prepare', 'commit'].filter((mode) => op.serve?.[mode] === true);
  if (op.access === 'read' || op.access === 'scratch') return open.includes('query') ? 'query' : (open[0] ?? null);
  return open.length === 1 ? open[0] : null;
}
// 返回 { code, result }（2026-11-09 audited 申报模式）：result 在 completed / needs_input /
// not_found 三种确定性答案上都带**该次 query 的实际结果状态**（result.status），completed
// 另带该次返回的 items/count/fields，由调用方写进审计行的 result 字段——audited 申报模式交叉核的
// 事实基准（"回复里的数平台确实拉回过"与"平台确实说过 not_found"都要能独立核对，不能只靠
// 模型自述传递）。failed/被拒没有可申报的结果，返回的 code 不带 result，审计行因此也不会
// 出现载荷。
// 三种状态都带**该次查询的对象规范名**（result.collection：2026-11-10 codex blocking 二）：
// args 是调用参数、一次调用可以带多个值（`--collection alpha --topic beta` 实际查 alpha），
// 交叉核若扫 args 会把这次查询的字段证据当成另一个对象的证据。对象名由平台自己落账——
// completed 落解析后的规范名（found.name，子串检索也落 canonical 名），not_found /
// needs_input 落该次检索的名字（没有可解析的规范名）。不落对象名的 result 匹配不上任何
// 命题 ⇒ 交叉核 fail-closed，不会把证据挂到错的对象上。
function doQuery(opName, args) {
  const { flags } = parseFlags(args);
  const read = READ_DECLARATIONS[opName];
  if (!read) {
    emit(opName, 'failed', null, errObj('QUERY_REQUIRED', `No declarative read contract for ${opName}`));
    return { code: 1 };
  }
  const outcome = runtime.executeDeclaredRead({
    read,
    flags,
    collections: loadState().collections,
    faults: SCENARIO.faults,
    catalog: CORRECT_FORM,
  });
  if (outcome.stderr !== undefined) process.stderr.write(outcome.stderr);
  if (outcome.envelope !== null) {
    emit(opName, outcome.envelope.status, outcome.envelope.data, outcome.envelope.error,
      outcome.envelope.missing === undefined ? undefined : { missing: outcome.envelope.missing });
  }
  return {
    code: outcome.exitCode,
    ...(outcome.result === undefined ? {} : { result: outcome.result }),
    ...(outcome.refused === undefined ? {} : { refused: outcome.refused }),
  };
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
// ── 写确认回环（2026-11-17）──────────────────────────────────────────────────
// 形态：prepare 冻结一次待确认操作并持久化 → 宿主把句柄/摘要交回用户 → 用户表态后
// commit 凭句柄提交 → 读回验证。句柄、绑定、有效期、一次性与业务校验全在执行层：
//   <state-dir>/confirmations.json
//     { confirmations: { [handle]: { handle, operation, collection, window, count,
//       createdAt, expiresAt, usedAt } } }
// 默认有效期 15 分钟；commit 先原子标记已用再执行（崩溃只会少写，不会重复写）。
// 测试面（落在状态根、不经 env：宿主 spawn 白名单只放 PATH/HOME/TMPDIR）：
//   <state-dir>/confirmation-config.json
//     { "ttlSeconds": <number>, "readbackShort": <boolean> }
//   ttlSeconds <= 0 = 生成已过期提案；readbackShort = 模拟读回短缺（如实 failed）。
function confirmationConfigFile() { return path.join(path.dirname(statePaths().stateFile), 'confirmation-config.json'); }
function confirmationPolicy() {
  const cfg = loadJson(confirmationConfigFile(), null);
  const rawFileTtl = cfg && typeof cfg === 'object' ? cfg.ttlSeconds : undefined;
  const fileTtl = typeof rawFileTtl === 'number' ? rawFileTtl : Number.NaN;
  const rawEnvTtl = env('DUMMY_CONFIRMATION_TTL_SECONDS', '');
  const envTtl = rawEnvTtl === '' ? Number.NaN : Number(rawEnvTtl);
  const ttlSeconds = Number.isFinite(fileTtl) ? fileTtl : Number.isFinite(envTtl) ? envTtl : 15 * 60;
  return {
    ttlMs: ttlSeconds * 1000,
    readbackShort: cfg !== null && typeof cfg === 'object' && cfg.readbackShort === true,
  };
}
function normalizeWriteArgs(flags) {
  const collection = flags.collection || flags.topic;
  const window = flags.window || flags.round || 'W1';
  const rawCount = flags.count !== undefined ? Number(flags.count) : 1;
  return {
    collection: typeof collection === 'string' && collection !== '' ? collection : null,
    window: String(window),
    count: Number.isFinite(rawCount) ? Math.max(0, Math.trunc(rawCount)) : 1,
  };
}
function confirmationLockFile(handle) {
  const digest = crypto.createHash('sha256').update(String(handle)).digest('hex').slice(0, 16);
  return path.join(path.dirname(statePaths().confirmationFile), `confirmation-${digest}.lock`);
}
/** 跨进程排他创建（'wx'）；陈旧锁（>60s，进程崩溃遗留）清掉重试一次。 */
function withConfirmationLock(handle, fn) {
  const file = confirmationLockFile(handle);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    let stale = false;
    try { stale = Date.now() - fs.statSync(file).mtimeMs > 60_000; } catch { stale = false; }
    if (!stale) return { locked: true };
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    try { fd = fs.openSync(file, 'wx'); } catch { return { locked: true }; }
  }
  try { return { locked: false, value: fn() }; }
  finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
}
/** 在锁内完成「读 → 校验 → 标记已用 → 落盘」；绑定不符不消耗句柄。 */
function claimConfirmation(opName, handle, binding) {
  return withConfirmationLock(handle, () => {
    const store = loadConfirmations();
    const rec = store.confirmations[handle];
    if (!rec || typeof rec !== 'object' || rec.handle !== handle) {
      return { ok: false, code: 'CONFIRMATION_NOT_FOUND', message: 'Confirmation handle not found.' };
    }
    const expectedCommit = typeof rec.operation === 'string' ? rec.operation.replace(/\.prepare$/, '.commit') : '';
    if (expectedCommit !== opName) {
      return { ok: false, code: 'CONFIRMATION_BINDING_MISMATCH', message: `Confirmation was prepared by ${String(rec.operation)}; use ${expectedCommit || 'its matching commit operation'}.` };
    }
    if (typeof rec.usedAt === 'string' && rec.usedAt !== '') {
      return { ok: false, code: 'CONFIRMATION_USED', message: 'Confirmation handle already used.' };
    }
    if (typeof rec.expiresAt !== 'string' || new Date(rec.expiresAt).getTime() <= Date.now()) {
      return { ok: false, code: 'CONFIRMATION_EXPIRED', message: `Confirmation handle expired at ${String(rec.expiresAt)}.` };
    }
    if (rec.collection !== binding.collection || rec.window !== binding.window || rec.count !== binding.count) {
      return { ok: false, code: 'CONFIRMATION_BINDING_MISMATCH', message: `Confirmation binding mismatch: prepared collection=${String(rec.collection)} window=${String(rec.window)} count=${String(rec.count)}; got collection=${String(binding.collection)} window=${String(binding.window)} count=${String(binding.count)}.` };
    }
    rec.usedAt = new Date().toISOString();
    rec.usedBy = opName;
    saveConfirmations(store);
    return { ok: true, record: rec };
  });
}
/** 确认拒绝：stderr 首 token 是机械 code（适配器按它分流 refused），并落审计证据。 */
function refuseConfirmation(opName, args, via, code, message) {
  process.stderr.write(`${code} ${message}\n`);
  audit({ mode: 'commit', ...(via ? { via } : {}), script: opName, args, serve: orchestrated(), refused: code });
  return 3;
}
function doPrepare(opName, args) {
  const { flags } = parseFlags(args);
  const state = loadState();
  const { collection, window, count } = normalizeWriteArgs(flags);
  if (!collection) { emit(opName, 'failed', null, errObj('QUERY_REQUIRED', 'Missing --collection or --topic')); return 1; }
  if (!Object.prototype.hasOwnProperty.call(state.collections, collection)) { emit(opName, 'not_found', { query: collection, candidates: [] }, errObj('COLLECTION_NOT_FOUND', `No collection matches "${collection}"`)); return 0; }
  const col = state.collections[collection];
  if (col.locked) { emit(opName, 'failed', null, errObj('COLLECTION_LOCKED', `Collection ${collection} is locked`)); return 2; }
  const policy = confirmationPolicy();
  const now = Date.now();
  const expiresAt = new Date(now + policy.ttlMs).toISOString();
  const handle = `cf_${crypto.randomUUID()}`;
  const confirmations = loadConfirmations();
  confirmations.confirmations[handle] = {
    handle,
    operation: opName,
    collection,
    window,
    count,
    createdAt: new Date(now).toISOString(),
    expiresAt,
    usedAt: null,
  };
  saveConfirmations(confirmations);
  const summary = `Prepare to add ${count} record(s) to collection "${collection}" window ${window}; this operation cannot be undone. Confirmation expires at ${expiresAt}.`;
  emit(opName, 'needs_confirmation', { collection, window, count, expiresAt, status: 'pending' }, null, {
    confirmation: { handle, summary, expiresAt },
  });
  return 0;
}
function doCommit(opName, args, confirmation, via) {
  const { flags } = parseFlags(args);
  // 集合级策略先于句柄校验：锁定集合的写路径仍以 COLLECTION_LOCKED 拒绝（旧契约保持）。
  const state = loadState();
  const { collection, window, count } = normalizeWriteArgs(flags);
  if (!collection) { emit(opName, 'failed', null, errObj('QUERY_REQUIRED', 'Missing --collection or --topic')); return 1; }
  if (!Object.prototype.hasOwnProperty.call(state.collections, collection)) { emit(opName, 'not_found', { query: collection, candidates: [] }, errObj('COLLECTION_NOT_FOUND', `No collection matches "${collection}"`)); return 0; }
  if (state.collections[collection].locked) { emit(opName, 'failed', null, errObj('COLLECTION_LOCKED', `Collection ${collection} is locked`)); return 2; }
  const handle = confirmation && typeof confirmation === 'object' && typeof confirmation.handle === 'string' && confirmation.handle !== ''
    ? confirmation.handle
    : (typeof flags.confirmation === 'string' && flags.confirmation !== '' ? flags.confirmation : null);
  if (!handle) return refuseConfirmation(opName, args, via, 'CONFIRMATION_REQUIRED', 'commit requires a confirmation handle (--confirmation <handle>)');
  const claim = claimConfirmation(opName, handle, { collection, window, count });
  if (claim.locked === true) return refuseConfirmation(opName, args, via, 'CONFIRMATION_IN_PROGRESS', 'confirmation handle is being consumed by another call');
  if (!claim.value.ok) return refuseConfirmation(opName, args, via, claim.value.code, claim.value.message);
  // 已原子标记已用：从这里开始的任何失败都不允许第二次提交。
  const record = claim.value.record;
  const applyState = loadState();
  const applyCol = applyState.collections[record.collection];
  if (!applyCol) { emit(opName, 'failed', null, errObj('COLLECTION_NOT_FOUND', `No collection matches "${record.collection}"`)); return 1; }
  const before = applyCol.records[record.window] ?? 0;
  const required = record.count;
  const applied = confirmationPolicy().readbackShort ? Math.max(0, required - 1) : required;
  applyCol.records[record.window] = before + applied;
  const stamp = String(handle).slice(-8).replace(/[^A-Za-z0-9]/g, '') || 'confirmed';
  for (let i = 0; i < applied; i += 1) {
    applyCol.items.push({ id: `rec-${stamp}-${i}`, name: `${record.collection}-record-${stamp}-${i}`, value: 0 });
  }
  saveState(applyState);
  // 读回验证：从持久化状态重新读，不把「内存里改了」当业务生效。
  const readBackState = loadState();
  const readBackCol = readBackState.collections[record.collection];
  const after = readBackCol && typeof readBackCol.records[record.window] === 'number' ? readBackCol.records[record.window] : 0;
  const delta = after - before;
  const readBack = { before, after, delta, required };
  if (delta !== required) {
    emit(opName, 'failed', { ok: false, verified: false, collection: record.collection, window: record.window, count: required, added: applied, readBack }, { code: 'CONFIRMATION_READBACK_SHORT', message: `Readback short: applied ${applied} of ${required} record(s).` });
    return 1;
  }
  const summaryText = `Confirmed write applied: collection "${record.collection}" window ${record.window}, ${required} record(s); readback delta ${delta}.`;
  emit(opName, 'completed', { ok: true, verified: true, summaryText, collection: record.collection, window: record.window, count: required, added: applied, total: after, readBack }, null);
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
  const secret = env2('EXECUTION_GATE_SECRET', 'DUMMY_GATE_SECRET', '');
  const token = env2('EXECUTION_COMMIT_TOKEN', 'DUMMY_COMMIT_TOKEN', '');
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
  const secret = env2('EXECUTION_PLAN_ACTIVATION_SECRET', 'DUMMY_PLAN_ACTIVATION_SECRET', '');
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
// ── 调用形态自述（2026-11-12，U1 写面可达性） ────────────────────────────────────
// 为什么要有这一段：模型实测的通行形态是 `bin/dummy query --collection X`——把 flag 填在
// operation 名那一格，落审计行 {script:"--collection", refused:"unregistered"}，写面四个
// operation（prepare/commit/proposal/proposal-commit）连名字都没进过它的手。宿主的拒绝文案
// 又指点 worker「调用形态以运行态技能文档「serve 运行态的调用形态」一节为准」
// （packages/agent/src/error-codes.ts:497/509/516），而本夹具的技能文档此前没有那一节。
// 因此形态必须由夹具**自己**说清：`operation list --json` 是机器可读权威，`--help` /
// `<mode> --help` 是同一份注册表的可读投影，未登记目标的拒绝里再带一次正确形态。
// 三处都从 OPERATIONS 派生，不手抄名单（改注册表即三处同步）。
/** 显示名：本夹具的入口名（bin/dummy；`bin/generic` 是同一实现的别名软链）。 */
function gatewayDisplay() {
  const entry = path.basename(process.argv[1] ?? 'dummy').replace(/\.cjs$/i, '');
  return `bin/${entry || 'dummy'}`;
}
/** 一个 operation 在该 mode 下的调用形态（参数按声明派生：位置参数 + flag；取值的样式照抄平台声明）。 */
function invocationOf(op, mode) {
  const parts = [mode, op.name];
  for (const p of op.args?.positional ?? []) parts.push(p.required ? `<${p.name}>` : `[<${p.name}>]`);
  for (const f of op.args?.flags ?? []) {
    // 写旗标不进形态：prepare 带它会被 decide() 当场拒（写必须走 commit），教它等于教一条死路。
    if (op.writeFlag && f.flag === op.writeFlag) continue;
    const value = f.style === 'name' ? '<name>' : f.style === 'code' ? '<code>' : '<value>';
    parts.push(f.required ? `${f.flag} ${value}` : `[${f.flag} ${value}]`);
  }
  return `${gatewayDisplay()} ${parts.join(' ')}`;
}
/** 该 operation 能在哪些 mode 下真的调到（serve 矩阵，注册表原值）。 */
function modesOf(op) { return ['query', 'prepare', 'commit'].filter((mode) => op.serve?.[mode] === true); }
/** 某个 mode 下登记的 operation（未登记目标的拒绝与 mode help 共用）。 */
function operationsInMode(mode) { return OPERATIONS.filter((op) => op.serve?.[mode] === true); }
/** 未登记目标的教学拒绝行（拒绝事实不变，另教正确形态；stderr 可见，与 GATE_REFUSE 同路）。 */
function unregisteredNotice(mode, target) {
  const available = operationsInMode(mode);
  return [
    `GATE_REFUSE script not registered: ${target}`,
    `correctForm: ${mode} 之后第一个位置参数是登记的 operation 名；flag（--xxx）不是 operation 名，填在它后面的参数位。`,
    `available in ${mode}（可直接照抄的形态）：`,
    ...available.map((op) => `  ${invocationOf(op, mode)}${op.access === 'write' ? '   # write' : ''}`),
    `hint: ${gatewayDisplay()} ${mode} --help 给出同一份形态；${gatewayDisplay()} operation list --json 是机器可读清单。`,
  ].join('\n') + '\n';
}
/** 结构化调用路径的同族教学（形态是 {operation, args}，没有 mode 那一格）。 */
function unregisteredCallNotice(operation) {
  return [
    `correctForm: call 的 operation 必须是登记名（见 operation list --json）——` +
      `${JSON.stringify(operation)} 不是；结构化调用形态是 {operation, args}，args 的键是声明里的位置参数名与 flag。`,
    `available: ${OPERATIONS.map((op) => op.name).join(', ')}`,
    `hint: ${gatewayDisplay()} --help 给出每条 operation 的可读调用形态。`,
  ].join('\n') + '\n';
}
/** 注册表的可读投影（`--help` 与 `<mode> --help` 共用同一段渲染）。 */
function operationTable(mode) {
  const ops = mode ? operationsInMode(mode) : OPERATIONS;
  return ops.flatMap((op) => {
    const modes = mode ? [mode] : modesOf(op);
    return modes.map((m) => `  ${invocationOf(op, m)}${m === modes[0] ? `   # ${op.access} · ${LABELS[op.name] ?? ''}` : ''}`);
  }).join('\n');
}
function usage() {
  return [
    'Generic mock execution layer (test fixture; record / collection / window vocabulary).',
    '',
    `Usage: ${gatewayDisplay()} [--state-dir <path>] <command> [args...]`,
    '  --state-dir <path>  test-only state root (dummy test surface, not a consumption protocol); default <fixture>/.runtime',
    '',
    '调用形态：query|prepare|commit 之后**第一个位置参数是登记的 operation 名**，不是 flag。',
    '把 flag 填在那一格（如 `query --collection alpha`）会被拒（script not registered）。',
    '下面的形态可直接照抄；`operation list --json` 是同一份注册表的机器可读面。',
    '',
    'Registered operations:',
    operationTable(),
    '',
    '写面（write access）：写只能沿 prepare → commit 两条路走；prepare 带 --apply 会被门拒。',
    `  ${operationsInMode('prepare').filter((op) => op.access === 'write').map((op) => invocationOf(op, 'prepare')).join('\n  ')}`,
    `  ${operationsInMode('commit').filter((op) => op.access === 'write').map((op) => invocationOf(op, 'commit')).join('\n  ')}`,
    `  ${gatewayDisplay()} <query|prepare|commit> --help   该 mode 的 operation 表与形态`,
    '',
    '辅助出口：',
    `  ${gatewayDisplay()} operation list [--json]      登记表（name/access/args/serve/protocol）`,
    `  ${gatewayDisplay()} plan --schema               plan draft 形状`,
    `  ${gatewayDisplay()} plan evaluate --task-id <id> --stdin`,
    `  ${gatewayDisplay()} plan current --task-id <id>`,
    `  ${gatewayDisplay()} plan activate --stdin       host provides planId/evidence/token as JSON on stdin`,
    `  ${gatewayDisplay()} proposal status --proposal-id <id>`,
    `  ${gatewayDisplay()} local <script> [args...]    纯本地计算（只放行 <fixture>/tmp/ 下的脚本）`,
    `  ${gatewayDisplay()} call --file <structured-call.json>  结构化调用协议`,
    '',
    `不带 --state-dir 时状态落 <fixture>/.runtime（手工调试用）；评测按用例传 --state-dir。`,
  ].join('\n') + '\n';
}
function modeUsage(mode) {
  const ops = operationsInMode(mode);
  return [
    `${mode} mode — 可用 operation ${ops.length} 个（形态可直接照抄；${gatewayDisplay()} operation list --json 是机器可读面）：`,
    operationTable(mode),
    '',
    `调用形态：${mode} 之后第一个位置参数必须是上面登记的 operation 名；flag（--xxx）不是 operation 名。`,
    `把 flag 填在那一格会被拒并给出正确形态；写面（access=write）见 ${gatewayDisplay()} --help 的「写面」段。`,
  ].join('\n') + '\n';
}
async function main() {
  let argv = [...process.argv.slice(2)];
  const stateDirFlag = takeStateDirFlag(argv);
  if (stateDirFlag.error) { process.stderr.write(`${stateDirFlag.error}\n`); return 2; }
  argv = stateDirFlag.rest;
  if (argv.length === 0 || argv[0] === '--help') { process.stdout.write(usage()); return argv.length ? 0 : 2; }
  if (argv[0] === '-h' || argv[0] === 'help') { process.stdout.write(usage()); return 0; }
  const [cmd, sub] = argv;
  // <mode> --help：形态自述的可读面（计划门把 <mode> <flag> 当执行调用按范围拒收，
  // 所以它不能是唯一发现面——但它对直跑与拿到激活计划的调用仍然是正确的问答）。
  if (['query', 'prepare', 'commit', 'local', 'call'].includes(cmd) && ['--help', '-h', 'help'].includes(sub ?? '')) {
    process.stdout.write(modeUsage(cmd === 'call' ? 'call' : cmd));
    return 0;
  }
  if (cmd === 'operation' && sub === 'list') {
    if (argv.includes('--json')) {
      process.stdout.write(JSON.stringify({ operations: OPERATIONS.map((o) => ({ name: o.name, domain: o.domain, command: o.command, access: o.access, script: o.script, sharedLocalWrite: false, effects: o.access === 'read' ? ['read'] : o.access === 'scratch' ? ['local'] : ['write'], executor: o.executor, est_seconds: o.est_seconds, weight: o.weight, args: o.args, serve: o.serve, protocol: o.protocol, label: LABELS[o.name] ?? '', proposalSchema: o.protocol === 'proposal.create' ? PROPOSAL_SCHEMA : null })), accessSemantics: ACCESS_SEMANTICS }) + '\n');
      return 0;
    }
    for (const o of OPERATIONS) process.stdout.write(`${o.name}\t${o.command}\t${o.access}\t${o.executor}\t${LABELS[o.name] ?? ''}\n`);
    return 0;
  }
  if (cmd === 'operation' && ['--help', '-h', 'help'].includes(sub ?? '')) { process.stdout.write(usage()); return 0; }
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
    // 确认引用（契约顶层字段）：句柄 + 用户原话。适配器原样转发，执行层只做形状校验；
    // 句柄是否有效/匹配/未过期/未用由 commit 的校验决定——执行层不解释用户原话。
    let confirmation;
    if (call.confirmation !== undefined) {
      if (call.confirmation === null || typeof call.confirmation !== 'object' || Array.isArray(call.confirmation)) { process.stderr.write('CALL_REFUSE confirmation must be an object\n'); return 3; }
      const handle = call.confirmation.handle;
      if (typeof handle !== 'string' || handle === '') { process.stderr.write('CALL_REFUSE confirmation.handle must be a non-empty string\n'); return 3; }
      if (call.confirmation.userText !== undefined && typeof call.confirmation.userText !== 'string') { process.stderr.write('CALL_REFUSE confirmation.userText must be a string\n'); return 3; }
      confirmation = { handle, ...(call.confirmation.userText === undefined ? {} : { userText: call.confirmation.userText }) };
    }
    // Accept both legacy array format and current protocol object format.
    if (Array.isArray(call.args)) {
      // legacy path: args is string[] (flat flag array) — no shape change.
    } else if (typeof call.args === 'object' && call.args !== null) {
      // structured-call protocol path: args is Record<string, unknown>.
      // Validate against operation declaration and convert to flat flag array.
      const op = resolveOperation(call.operation);
      if (!op) { process.stderr.write('CALL_REFUSE unregistered operation: ' + call.operation + '\n'); audit({ mode: 'call', script: call.operation, args: call.args, serve: orchestrated(), refused: 'unregistered' }); return 3; }
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
    if (!op) { process.stderr.write('CALL_REFUSE unregistered operation: ' + call.operation + '\n' + unregisteredCallNotice(call.operation)); audit({ mode: 'call', script: call.operation, args: call.args, serve: orchestrated(), refused: 'unregistered' }); return 3; }
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
      audit({ callId, phase: 'start', mode: 'prepare', via: 'structured', script: op.name, args: call.args, serve: orchestrated(), protocol: op.protocol });
      const code = doProposalCreate(op.name, call.args);
      audit({ callId, phase: 'result', mode: 'prepare', via: 'structured', script: op.name, args: call.args, serve: orchestrated(), protocol: op.protocol, exitCode: code, ...(code !== 0 ? { refused: 'proposal' } : {}) });
      return code;
    }
    if (op.protocol === 'proposal.commit') {
      const { flags: innerFlags } = parseFlags(call.args);
      if (!innerFlags['proposal-id']) { process.stderr.write('PROPOSAL_REFUSE missing --proposal-id\n'); return 3; }
      const callId = `call_${crypto.randomUUID().slice(0, 8)}`;
      audit({ callId, phase: 'start', mode: 'commit', via: 'structured', script: op.name, args: call.args, serve: orchestrated(), protocol: op.protocol, proposalId: innerFlags['proposal-id'] });
      const code = doProposalCommit(op.name, call.args);
      audit({ callId, phase: 'result', mode: 'commit', via: 'structured', script: op.name, args: call.args, serve: orchestrated(), protocol: op.protocol, proposalId: innerFlags['proposal-id'], exitCode: code, ...(code !== 0 ? { refused: 'proposal' } : {}) });
      return code;
    }
    // 结构化 call 无 mode 字段：按 operation 自己的 serve 矩阵派生（写 op 必须唯一开放）。
    const accessMode = structuredModeOf(op);
    if (accessMode === null) { process.stderr.write(`GATE_REFUSE no unambiguous mode for ${op.name}: serve matrix must open exactly one of prepare/commit for a write operation\n`); audit({ mode: 'call', script: op.name, args: call.args, serve: orchestrated(), refused: 'mode-ambiguous' }); return 3; }
    const verdict = decide(accessMode, op, call.args);
    if (!verdict.allowed) { process.stderr.write(`GATE_REFUSE ${verdict.reason}\n`); audit({ mode: 'call', script: op.name, args: call.args, serve: orchestrated(), refused: verdict.reason }); return 3; }
    const planId = env2('EXECUTION_PLAN_ID', 'DUMMY_PLAN_ID', '');
    const requirePlan = env2('EXECUTION_REQUIRE_PLAN', 'DUMMY_REQUIRE_PLAN', '') === '1';
    if (requirePlan && !planId && (op.access === 'read' || op.access === 'scratch')) { process.stderr.write('GATE_REFUSE serve execution requires a host-injected plan id\n'); audit({ mode: 'call', script: op.name, args: call.args, serve: orchestrated(), refused: 'PLAN_REQUIRED' }); return 3; }
    // 声明式延迟：先校验（超限确定性拒绝，不占限流名额），再取限流名额，再真实等待。
    const declaredDelay = delayOf(op, call.args);
    if (!declaredDelay.ok) return refuseDelay(op.name, accessMode, 'structured', call.args, declaredDelay);
    if (rateLimitRefused(op.name, accessMode, 'structured', call.args)) return 1;
    sleepSync(declaredDelay.ms);
    let code;
    let queryResult;
    let queryRefused;
    if (op.name === 'dummy.query' || op.name === 'ballot.query') { const q = doQuery(op.name, call.args); code = q.code; queryResult = q.result; queryRefused = q.refused; }
    else if (op.name === 'dummy.scratch' || op.name === 'ballot.scratch') code = doScratch(op.name, call.args);
    else if (op.name === 'dummy.prepare' || op.name === 'ballot.prepare') code = doPrepare(op.name, call.args);
    else if (op.name === 'dummy.commit' || op.name === 'ballot.commit') {
      const secret = env2('EXECUTION_GATE_SECRET', 'DUMMY_GATE_SECRET', '');
      const token = env2('EXECUTION_COMMIT_TOKEN', 'DUMMY_COMMIT_TOKEN', '');
      if (secret) {
        let ok = false;
        try {
          const [body, sig] = String(token).split('.');
          const expect = crypto.createHmac('sha256', secret).update(body).digest();
          const got = Buffer.from(sig, 'base64url');
          const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
          ok = expect.length === got.length && crypto.timingSafeEqual(expect, got) && p.script === op.name && new Date(p.expiresAt).getTime() > Date.now();
        } catch { ok = false; }
        if (!ok) { process.stderr.write('GATE_REFUSE commit token verification failed\n'); audit({ mode: 'call', script: op.name, args: call.args, serve: orchestrated(), refused: 'commit-token' }); return 3; }
      }
      code = doCommit(op.name, call.args, confirmation, 'structured');
    } else { process.stderr.write('GATE_REFUSE no handler for ' + op.name + '\n'); return 3; }
    // mode 记**按 access 分级**的值（2026-11-09 九审 major）：旧写法这里无脑记 'call'，
    // 而 bash 路径按 access 算 query/prepare——于是同一次 dummy.query，走 bash 落
    // mode:'query'、走结构化落 mode:'call'，评测侧据 mode 判读类的逻辑只认前者，结构化查询
    // 就算 exitCode=0 且已送达也只能停在 completed，报告随调用载体变化。
    // 载体信息不丢：另记 via:'structured'。
    // query 的 completed/needs_input/not_found 行把该次实际结果状态写进审计行 result
    // （audited 申报模式交叉核的事实基准：结果状态与 items 都可供独立核对）；被拒/失败的
    // 行没有 queryResult，不带 result。
    audit({ mode: accessMode, via: 'structured', script: op.name, args: call.args, serve: orchestrated(), exitCode: code, planId: planId || undefined, ...(queryResult ? { result: queryResult } : {}), ...(queryRefused ? { refused: queryRefused } : {}) });
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
      if (!abs.startsWith(tmpRoot) || !fs.existsSync(abs)) { process.stderr.write(`GATE_REFUSE local mode only allows scripts under ${tmpRoot}\n`); audit({ mode: 'local', script: target, args: rest, serve: orchestrated(), refused: 'local-out-of-tmp' }); return 3; }
      const r = spawnSync(process.execPath, [abs, ...rest], { stdio: 'inherit', cwd: FIXTURE_ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
      audit({ mode: 'local', script: path.relative(FIXTURE_ROOT, abs), args: rest, serve: orchestrated(), exitCode: r.status });
      return r.status == null ? 1 : r.status;
    }
    if (!target) { process.stderr.write(`usage: dummy ${cmd} <operation-or-script> [args...]\n`); return 2; }
    const op = resolveOperation(target);
    // 拒绝事实不变（审计行照旧落 refused='unregistered'，那是评测的「畸形调用」信号）；
    // 另附正确形态，让下一跳能拼对（教学，不是放行）。
    if (!op) { process.stderr.write(unregisteredNotice(cmd, target)); audit({ mode: cmd, script: target, args: rest, serve: orchestrated(), refused: 'unregistered' }); return 3; }
    // Proposal protocol routing (by operation name, not script path -- same rule as any execution layer).
    // 起止两行 + 同一 callId（2026-11-09 十二审 major）：bash 侧这条路径与结构化侧同规，
    // 都要补结果行——否则 classifyExecutionCall 拿不到 exitCode=0，正常完成并读回的 bash
    // 提交也永远停在 invoked，mechanicallyPassed 判失败、令牌拒绝也没有 refused 证据。
    if (op.protocol === 'proposal.create' && cmd === 'prepare') {
      const callId = `call_${crypto.randomUUID().slice(0, 8)}`;
      audit({ callId, phase: 'start', mode: cmd, script: op.name, args: rest, serve: orchestrated(), protocol: op.protocol });
      const code = doProposalCreate(op.name, rest);
      audit({ callId, phase: 'result', mode: cmd, script: op.name, args: rest, serve: orchestrated(), protocol: op.protocol, exitCode: code, ...(code !== 0 ? { refused: 'proposal' } : {}) });
      return code;
    }
    if (op.protocol === 'proposal.commit' && cmd === 'commit') {
      const { flags } = parseFlags(rest);
      if (!flags['proposal-id']) { process.stderr.write('PROPOSAL_REFUSE missing --proposal-id\n'); return 3; }
      const callId = `call_${crypto.randomUUID().slice(0, 8)}`;
      audit({ callId, phase: 'start', mode: cmd, script: op.name, args: rest, serve: orchestrated(), protocol: op.protocol, proposalId: flags['proposal-id'] });
      const code = doProposalCommit(op.name, rest);
      audit({ callId, phase: 'result', mode: cmd, script: op.name, args: rest, serve: orchestrated(), protocol: op.protocol, proposalId: flags['proposal-id'], exitCode: code, ...(code !== 0 ? { refused: 'proposal' } : {}) });
      return code;
    }
    const verdict = decide(cmd, op, rest);
    if (!verdict.allowed) { process.stderr.write(`GATE_REFUSE ${verdict.reason}\n`); audit({ mode: cmd, script: op.name, args: rest, serve: orchestrated(), refused: verdict.reason }); return 3; }
    // Plan binding (only when the caller opts in, mirroring EXECUTION_REQUIRE_PLAN).
    const planId = env2('EXECUTION_PLAN_ID', 'DUMMY_PLAN_ID', '');
    const requirePlan = env2('EXECUTION_REQUIRE_PLAN', 'DUMMY_REQUIRE_PLAN', '') === '1';
    if (requirePlan && !planId && (op.access === 'read' || op.access === 'scratch')) { process.stderr.write('GATE_REFUSE serve execution requires a host-injected plan id\n'); audit({ mode: cmd, script: op.name, args: rest, serve: orchestrated(), refused: 'PLAN_REQUIRED' }); return 3; }
    const declaredDelay = delayOf(op, rest);
    if (!declaredDelay.ok) return refuseDelay(op.name, cmd, null, rest, declaredDelay);
    if (rateLimitRefused(op.name, cmd, null, rest)) return 1;
    sleepSync(declaredDelay.ms);
    let code;
    let queryResult;
    let queryRefused;
    if (op.name === 'dummy.query' || op.name === 'ballot.query') { const q = doQuery(op.name, rest); code = q.code; queryResult = q.result; queryRefused = q.refused; }
    else if (op.name === 'dummy.scratch' || op.name === 'ballot.scratch') code = doScratch(op.name, rest);
    else if (op.name === 'dummy.prepare' || op.name === 'ballot.prepare') code = doPrepare(op.name, rest);
    else if (op.name === 'dummy.commit' || op.name === 'ballot.commit') {
      // Direct (non-proposal) commit requires a commit token when a gate secret is set,
      // mirroring gateway commit-token binding (operation name preferred).
      const secret = env2('EXECUTION_GATE_SECRET', 'DUMMY_GATE_SECRET', '');
      const token = env2('EXECUTION_COMMIT_TOKEN', 'DUMMY_COMMIT_TOKEN', '');
      if (secret) {
        let ok = false;
        try {
          const [body, sig] = String(token).split('.');
          const expect = crypto.createHmac('sha256', secret).update(body).digest();
          const got = Buffer.from(sig, 'base64url');
          const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
          ok = expect.length === got.length && crypto.timingSafeEqual(expect, got) && p.script === op.name && new Date(p.expiresAt).getTime() > Date.now();
        } catch { ok = false; }
        if (!ok) { process.stderr.write('GATE_REFUSE commit token verification failed\n'); audit({ mode: cmd, script: op.name, args: rest, serve: orchestrated(), refused: 'commit-token' }); return 3; }
      }
      code = doCommit(op.name, rest, undefined, null);
    } else { process.stderr.write(`GATE_REFUSE no handler for ${op.name}\n`); return 3; }
    // query 的 completed/needs_input/not_found 行把该次实际结果状态写进审计行 result
    // （audited 申报模式交叉核的事实基准：结果状态与 items 都可供独立核对）；被拒/失败的
    // 行没有 queryResult，不带 result。
    audit({ mode: cmd, script: op.name, args: rest, serve: orchestrated(), exitCode: code, planId: planId || undefined, ...(queryResult ? { result: queryResult } : {}), ...(queryRefused ? { refused: queryRefused } : {}) });
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
