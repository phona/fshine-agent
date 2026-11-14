/**
 * P7a 结构化轨迹（`ask --script <file> --trace <dir>` 与交互式留证）——测试先行（P7-T03）。
 *
 * 依据：R4 验收设计 §3.1（evidence: [replies, executions, notifications, task_rows, audit]）与
 * P7-T03「11 类证据齐全（与 runner schema 一致）；断言引擎输出 pass/fail 与失败定位」；
 * owner 裁定 P7a 只做前置能力：轨迹 = runner 证据 schema 的**适用子集**，缺失类显式声明
 * （blocked / not_applicable + 原因），不假装齐全。
 *
 * 本文件钉住的契约（实现前红）：
 *   · `--trace <dir>` 产出固定证据文件集（11 类适用子集 + assertions.json + evidence.manifest.json）；
 *   · 证据区与运行态分离：runtime/ 子目录承载底账/审计/配置副本，证据文件在根；
 *   · audit.jsonl 证据件剔除时钟字段（ts）以保证回放逐字可复现；原始审计在 runtime/state 保留；
 *   · evidence.manifest.json 声明每个类别的状态；judgment=not_applicable（P7a 用 assertions.json）、
 *     notifications/resources=blocked（P4/P5 未合入）；
 *   · validateTraceDir：schema/类别覆盖/文件存在与可解析校验；缺类或坏 schema 必须判错；
 *   · 交互式记录器（createTraceRecorder, mode='interactive'）产出可校验轨迹。
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');

const dirs: string[] = [];
function tempDir(prefix = 'p7a-trace-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HOST_LEAK_KEYS = [
  'LLM_API_KEY', 'LLM_API_BASE_URL', 'LLM_MODEL', 'LLM_MAIN_MODEL',
  'LLM_THINKING_LEVEL', 'LLM_MAIN_THINKING_LEVEL', 'LLM_CONTEXT_WINDOW',
  'AGENT_CONFIG_PATH', 'DB_PATH', 'INIT_CWD',
];

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of HOST_LEAK_KEYS) delete env[key];
  env['TMPDIR'] ??= os.tmpdir();
  return env;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runAsk(args: readonly string[], env: NodeJS.ProcessEnv = baseEnv()): CliResult {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/ask.ts', ...args],
    { cwd: REPO_ROOT, env, encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function readLines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

/** 证据文件集（根目录文件；runtime/ 为运行态，不属证据）。 */
const EVIDENCE_FILES = [
  'assertions.json',
  'audit.index.json',
  'audit.jsonl',
  'evidence.manifest.json',
  'executions.json',
  'inputs.json',
  'meta.json',
  'model.json',
  'reply.jsonl',
  'toolcalls.jsonl',
  'transcript.main.json',
  'transcript.worker.jsonl',
] as const;

/** runner 证据 schema 的 11 类（memory：inputs/model/toolcalls/transcripts(2)/audit/audit.index/executions/reply/meta/judgment）。 */
const RUNNER_CLASSES = [
  'inputs', 'model', 'toolcalls', 'transcript_main', 'transcript_worker',
  'audit', 'audit_index', 'executions', 'reply', 'meta', 'judgment',
] as const;

interface ClassRecord {
  status: string;
  path?: string;
  reason?: string;
}
interface ManifestLike {
  schema: string;
  mode: string;
  classes: Record<string, ClassRecord>;
}
interface TraceValidation {
  ok: boolean;
  errors: string[];
  manifest?: ManifestLike;
}
interface TraceRecorderLike {
  recordTurn: (record: Record<string, unknown>) => void;
  finish: (input?: Record<string, unknown>) => ManifestLike;
}
interface TraceModule {
  validateTraceDir: (dir: string) => TraceValidation;
  createTraceRecorder: (input: Record<string, unknown>) => TraceRecorderLike;
}

async function loadTraceModule(): Promise<TraceModule> {
  const modulePath: string = './ask-trace';
  return await import(modulePath) as TraceModule;
}

/** 回放（带轨迹）按需执行；afterEach 会清掉临时目录，缓存失效时重建重跑。 */
let tracedDir = '';

function ensureTracedRun(): string {
  if (tracedDir !== '' && existsSync(tracedDir)) return tracedDir;
  const dir = tempDir('p7a-trace-run-');
  const script = path.join(dir, 'script.yaml');
  writeFileSync(script, [
    'scenario: p7a-trace',
    'session:',
    '  principal: "wecom:fixture-user"',
    '  session: "s-trace"',
    'threshold: deterministic',
    'turns:',
    '  - kind: message',
    '    text: "帮我查 beta 集合、窗口 W1 的数据"',
    '    model:',
    '      reply: "已查到：beta 集合在窗口 W1 有 3 条记录。"',
    '      delegate:',
    '        - request: "查询 beta 集合、窗口 W1 的数据"',
    '          worker:',
    '            operation: dummy.query',
    '            args: { collection: beta, window: W1 }',
    '          summary: "beta 集合在窗口 W1 有 3 条记录。"',
    'expect:',
    '  - { after: all, assert: reply_contains, value: "3 条记录" }',
    'evidence: [replies, executions, audit]',
    '',
  ].join('\n'));
  const trace = path.join(dir, 'trace');
  const result = runAsk([`--script=${script}`, `--trace=${trace}`]);
  if (result.status !== 0) {
    throw new Error(`回放未成功（实现前红）: status=${result.status}\n${result.stderr}${result.stdout}`);
  }
  tracedDir = trace;
  return tracedDir;
}

describe('P7a 轨迹 schema：证据文件集与 manifest 声明', () => {
  it('产出固定证据文件集；runtime/ 承载运行态', () => {
    const dir = ensureTracedRun();
    const files = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    expect(files).toEqual([...EVIDENCE_FILES].sort());
    expect(existsSync(path.join(dir, 'runtime', 'db', 'state.db'))).toBe(true);
    expect(existsSync(path.join(dir, 'runtime', 'state', 'audit.jsonl'))).toBe(true);
    expect(existsSync(path.join(dir, 'runtime', 'config', 'agent-config.yaml'))).toBe(true);
  });

  it('validateTraceDir 通过；manifest 覆盖 11 类并显式声明缺失/blocked', async () => {
    const dir = ensureTracedRun();
    const { validateTraceDir } = await loadTraceModule();
    const validation = validateTraceDir(dir);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    const manifest = validation.manifest!;
    expect(manifest.schema).toBe('p7a-trace-v1');
    expect(manifest.mode).toBe('script');
    for (const name of RUNNER_CLASSES) {
      expect(manifest.classes[name], `manifest 缺类别 ${name}`).toBeDefined();
    }
    expect(manifest.classes['judgment']!.status).toBe('not_applicable');
    expect(manifest.classes['judgment']!.reason).toBeTruthy();
    expect(manifest.classes['notifications']!.status).toBe('blocked');
    expect(manifest.classes['resources']!.status).toBe('blocked');
    expect(manifest.classes['assertions']!.status).toBe('present');
    for (const name of ['inputs', 'model', 'reply', 'executions', 'audit', 'meta']) {
      expect(['present', 'empty']).toContain(manifest.classes[name]!.status);
    }
  });

  it('audit 证据件剔除时钟字段；原始审计在 runtime/state 保留', () => {
    const dir = ensureTracedRun();
    const evidence = readLines(path.join(dir, 'audit.jsonl')).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(evidence.length).toBeGreaterThan(0);
    for (const row of evidence) expect(row['ts']).toBeUndefined();
    const raw = readLines(path.join(dir, 'runtime', 'state', 'audit.jsonl'));
    expect(raw.length).toBe(evidence.length);
    for (const line of raw) expect(line).toContain('"ts"');
    // audit.index.json 与归一化后的证据件对齐
    const index = JSON.parse(readFileSync(path.join(dir, 'audit.index.json'), 'utf8')) as {
      turns: Array<Record<string, unknown>>;
      totalLines: number;
    };
    expect(index.totalLines).toBe(evidence.length);
  });

  it('validateTraceDir：缺类/坏 schema 判错并给出定位', async () => {
    const traceRoot = ensureTracedRun();
    const { validateTraceDir } = await loadTraceModule();
    const missing = tempDir('p7a-trace-missing-');
    cpSync(traceRoot, missing, { recursive: true });
    rmSync(path.join(missing, 'executions.json'));
    const missingResult = validateTraceDir(missing);
    expect(missingResult.ok).toBe(false);
    expect(missingResult.errors.join('\n')).toContain('executions');

    const badSchema = tempDir('p7a-trace-schema-');
    cpSync(traceRoot, badSchema, { recursive: true });
    const manifestPath = path.join(badSchema, 'evidence.manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['schema'] = 'not-a-trace';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const schemaResult = validateTraceDir(badSchema);
    expect(schemaResult.ok).toBe(false);
    expect(schemaResult.errors.join('\n')).toContain('schema');
  });
});

describe('P7a 轨迹：交互式记录器（mode=interactive）', () => {
  it('recordTurn + finish 产出可校验轨迹；缺失类显式声明', async () => {
    const { createTraceRecorder, validateTraceDir } = await loadTraceModule();
    const dir = tempDir('p7a-trace-interactive-');
    const recorder = createTraceRecorder({
      dir,
      mode: 'interactive',
      principalId: 'wecom:fixture-user',
      sessionId: 's-interactive',
    });
    recorder.recordTurn({
      index: 1,
      session: 's-interactive',
      text: '你好',
      reply: '你好，我能帮你查数据。',
      taskIds: [],
      executionCount: 0,
      auditLines: [],
      mainMessages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好，我能帮你查数据。' },
      ],
      workerMessages: [],
    });
    const manifest = recorder.finish({ scenario: 'p7a-interactive-unit' });

    expect(manifest.mode).toBe('interactive');
    expect(manifest.classes['judgment']!.status).toBe('not_applicable');
    expect(manifest.classes['notifications']!.status).toBe('blocked');
    const validation = validateTraceDir(dir);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    const replies = readLines(path.join(dir, 'reply.jsonl')).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(replies).toHaveLength(1);
    expect(replies[0]!['text']).toBe('你好，我能帮你查数据。');
  });
});
