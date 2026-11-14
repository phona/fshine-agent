/**
 * P7a 脚本化回放（`npm run ask -- --script=<file> [--trace=<dir>]`）——测试先行。
 *
 * 依据：R4 验收设计 §3/§3.1（ask 自动回放设计；脚本字段 scenario/session/config/turns/expect/
 * evidence/threshold）与 P7-T02/T03；owner 裁定 P7a 只做前置能力（交互式 ask、脚本回放、轨迹
 * 采集），依赖 P4/P5/P6 的注入/断言种类一律 blocked（fail-closed，不静默通过、不跳过宣称完成）。
 *
 * 本文件钉住的契约（实现前红）：
 *   · 合法脚本：exit 0；stdout 逐回合回复 + 断言报告（[pass]/[fail]/[blocked]）；证据落盘；
 *   · 确定性：同脚本两跑 stdout 与全部证据文件逐字一致（假 driver，零模型、零网络）；
 *   · 多会话/多 principal：sessions 映射 + turn 级 session 选择，底账按 scope 各归各；
 *   · 坏脚本 fail-closed：exit 2，stderr 带「回放脚本拒绝」+ 原因，不静默降级；
 *   · 断言引擎最小集：reply_contains/not_contains、task_state、task_no、execution_count、
 *     hash_unchanged、no_fabricated；notification_delivered/resource_released/not_blocked
 *     标 blocked（exit 3，绝不 0）；
 *   · blocked 输入种类：inject event（restart/池满等）与 evidence: notifications/resources、
 *     threshold: blackbox → blocked；blocked 后的回合不执行。
 *
 * 说明：本文件只经 CLI（spawn `scripts/ask.ts`）驱动，不 import 待实现模块；断言引擎单测用
 * 变量路径动态 import（实现前红：模块不存在；实现后按同一契约转绿）。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');

const dirs: string[] = [];
function tempDir(prefix = 'p7a-replay-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 宿主泄漏键：逐键剔除；脚本回放是确定性层，不要求也不消费 LLM 密钥。 */
const HOST_LEAK_KEYS = [
  'LLM_API_KEY', 'LLM_API_BASE_URL', 'LLM_MODEL', 'LLM_MAIN_MODEL',
  'LLM_THINKING_LEVEL', 'LLM_MAIN_THINKING_LEVEL', 'LLM_CONTEXT_WINDOW',
  'AGENT_CONFIG_PATH', 'DB_PATH', 'INIT_CWD',
  'FSHINE_WORKER_DISPATCH_MODE', 'FSHINE_PLATFORM_QUEUE_CAPACITY',
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

/** 入口与 `npm run ask` 同一文件（只显式控制 env；不加载 .env）。 */
function runAsk(args: readonly string[], env: NodeJS.ProcessEnv = baseEnv()): CliResult {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/ask.ts', ...args],
    { cwd: REPO_ROOT, env, encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function writeScript(dir: string, name: string, lines: readonly string[]): string {
  const file = path.join(dir, name);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function readLines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

interface ScriptOption {
  scenario?: string;
  session?: string[];
  threshold?: string | null;
  turns?: string[];
  expect?: string[];
  evidence?: string | null;
}

const DEFAULT_SESSION = ['session:', '  principal: "wecom:fixture-user"', '  session: "s-replay"'];

/**
 * 组装一份脚本（缺省即合法最小脚本）。`null` = 刻意删除该字段（坏脚本用例），
 * `undefined` = 用缺省。turns 缺省为单条 message（无委派）。
 */
function yamlScript(option: ScriptOption = {}): string[] {
  const lines: string[] = [];
  lines.push(`scenario: ${option.scenario ?? 'p7a-basic'}`);
  lines.push(...(option.session ?? DEFAULT_SESSION));
  if (option.threshold !== null) lines.push(`threshold: ${option.threshold ?? 'deterministic'}`);
  lines.push('turns:');
  lines.push(...(option.turns ?? [
    '  - kind: message',
    '    text: "你好"',
    '    model:',
    '      reply: "你好，我是回放助手。"',
  ]));
  lines.push('expect:');
  lines.push(...(option.expect ?? ['  - { after: all, assert: task_no }']));
  if (option.evidence !== null) lines.push(`evidence: ${option.evidence ?? '[replies]'}`);
  return lines;
}

/** 标准两回合脚本：回合 1 委派 dummy.query（beta/W1），回合 2 追问。 */
function basicScript(scenario = 'p7a-basic', firstReply = '已查到：beta 集合在窗口 W1 有 3 条记录。'): string[] {
  return yamlScript({
    scenario,
    turns: [
      '  - kind: message',
      '    text: "帮我查 beta 集合、窗口 W1 的数据"',
      '    model:',
      `      reply: "${firstReply}"`,
      '      delegate:',
      '        - request: "查询 beta 集合、窗口 W1 的数据"',
      '          worker:',
      '            operation: dummy.query',
      '            args: { collection: beta, window: W1 }',
      '          summary: "beta 集合在窗口 W1 有 3 条记录。"',
      '  - kind: message',
      '    text: "再确认一下刚才那个任务的结果"',
      '    model:',
      '      reply: "刚才的任务已完成：beta 集合在窗口 W1 有 3 条记录。"',
    ],
    expect: [
      '  - { after: 1, assert: reply_contains, value: "3 条记录" }',
      '  - { after: 1, assert: execution_count, value: 1 }',
      '  - { after: all, assert: task_state, value: completed }',
      '  - { after: all, assert: reply_not_contains, value: "查无此集合" }',
      '  - { after: all, assert: task_no }',
      '  - { after: all, assert: no_fabricated }',
    ],
    evidence: '[replies, executions, audit]',
  });
}

function evidenceFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    files.set(entry.name, readFileSync(path.join(root, entry.name)));
  }
  return files;
}

describe('ask --script：合法脚本回放（exit 0 + 逐回合输出 + 断言报告）', () => {
  it('两回合：回复、机械证据、断言全过；证据文件落盘', () => {
    const dir = tempDir();
    const script = writeScript(dir, 'basic.yaml', basicScript());
    const trace = path.join(dir, 'trace');
    const result = runAsk([`--script=${script}`, `--trace=${trace}`]);

    expect(result.stderr, `stderr=${result.stderr}`).toBe('');
    expect(result.status, `stdout=${result.stdout}`).toBe(0);
    expect(result.stdout).toContain('===== 回合 1 =====');
    expect(result.stdout).toContain('===== 回合 2 =====');
    expect(result.stdout).toContain('已查到：beta 集合在窗口 W1 有 3 条记录。');
    expect(result.stdout).toContain('[pass]');
    expect(result.stdout).not.toContain('[fail]');
    expect(result.stdout).not.toContain('[blocked]');

    // 断言报告（机器可读）
    const assertions = readJson(path.join(trace, 'assertions.json'));
    const summary = assertions['summary'] as Record<string, number>;
    expect(summary['pass']).toBe(6);
    expect(summary['fail']).toBe(0);
    expect(summary['blocked']).toBe(0);

    // 逐回合证据（runner schema 的适用子集）
    const replies = readLines(path.join(trace, 'reply.jsonl')).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(replies).toHaveLength(2);
    expect(replies[0]!['text']).toBe('已查到：beta 集合在窗口 W1 有 3 条记录。');
    const executions = readJson(path.join(trace, 'executions.json')) as { tasks: Array<Record<string, unknown>> };
    expect(executions.tasks).toHaveLength(1);
    expect(executions.tasks[0]!['status']).toBe('completed');
    expect((executions.tasks[0]!['executions'] as unknown[])).toHaveLength(1);
    for (const name of ['inputs.json', 'model.json', 'toolcalls.jsonl', 'audit.jsonl', 'audit.index.json', 'meta.json', 'evidence.manifest.json']) {
      expect(readFileSync(path.join(trace, name)).byteLength, `${name} 缺失`).toBeGreaterThan(0);
    }
  });

  it('确定性：同脚本两跑 stdout 与全部证据文件逐字一致', () => {
    const dir = tempDir();
    const script = writeScript(dir, 'deterministic.yaml', basicScript('p7a-determinism'));
    const trace = path.join(dir, 'trace');
    const first = runAsk([`--script=${script}`, `--trace=${trace}`]);
    expect(first.status, `stdout=${first.stdout}\nstderr=${first.stderr}`).toBe(0);
    const firstFiles = evidenceFiles(trace);
    const second = runAsk([`--script=${script}`, `--trace=${trace}`]);
    expect(second.status, `stdout=${second.stdout}\nstderr=${second.stderr}`).toBe(0);
    const secondFiles = evidenceFiles(trace);

    expect(second.stdout).toBe(first.stdout);
    expect([...secondFiles.keys()].sort()).toEqual([...firstFiles.keys()].sort());
    for (const [name, bytes] of firstFiles) {
      expect(secondFiles.get(name)!.equals(bytes), `${name} 两跑不一致`).toBe(true);
    }
  });

  it('多会话/多 principal：session 映射 + turn 级选择，底账按 scope 各归各', () => {
    const dir = tempDir();
    const script = writeScript(dir, 'multi.yaml', [
      'scenario: p7a-multisession',
      'sessions:',
      '  alice:',
      '    principal: "wecom:fixture-user"',
      '    session: "s-alice"',
      '  bob:',
      '    principal: "wecom:second-user"',
      '    session: "s-bob"',
      'threshold: deterministic',
      'turns:',
      '  - kind: message',
      '    text: "alice 查 beta"',
      '    session: alice',
      '    model:',
      '      reply: "alice 完成：beta 在窗口 W1 有 3 条记录。"',
      '      delegate:',
      '        - request: "alice 查 beta"',
      '          worker:',
      '            operation: dummy.query',
      '            args: { collection: beta, window: W1 }',
      '          summary: "beta 在窗口 W1 有 3 条记录。"',
      '  - kind: message',
      '    text: "bob 查 alpha"',
      '    session: bob',
      '    model:',
      '      reply: "bob 完成：alpha 在窗口 W1 有 2 条记录。"',
      '      delegate:',
      '        - request: "bob 查 alpha"',
      '          worker:',
      '            operation: dummy.query',
      '            args: { collection: alpha, window: W1 }',
      '          summary: "alpha 在窗口 W1 有 2 条记录。"',
      'expect:',
      '  - { after: all, assert: execution_count, value: 2 }',
      '  - { after: all, assert: task_state, value: completed, task: 1 }',
      '  - { after: all, assert: task_state, value: completed, task: 2 }',
      '  - { after: 1, assert: reply_contains, value: "alice 完成" }',
      'evidence: [replies, executions]',
    ]);
    const trace = path.join(dir, 'trace');
    const result = runAsk([`--script=${script}`, `--trace=${trace}`]);

    expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    const executions = readJson(path.join(trace, 'executions.json')) as { tasks: Array<Record<string, unknown>> };
    expect(executions.tasks).toHaveLength(2);
    expect(executions.tasks[0]!['principalId']).toBe('wecom:fixture-user');
    expect(executions.tasks[0]!['sessionId']).toBe('s-alice');
    expect(executions.tasks[1]!['principalId']).toBe('wecom:second-user');
    expect(executions.tasks[1]!['sessionId']).toBe('s-bob');
  });

  it('断言失败：exit 1，失败定位在 stdout 与 assertions.json', () => {
    const dir = tempDir();
    const script = writeScript(dir, 'fail.yaml', yamlScript({
      scenario: 'p7a-assert-fail',
      expect: ['  - { after: 1, assert: reply_contains, value: "这段文本不存在" }'],
    }));
    const trace = path.join(dir, 'trace');
    const result = runAsk([`--script=${script}`, `--trace=${trace}`]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[fail]');
    expect(result.stdout).toContain('reply_contains');
    const assertions = readJson(path.join(trace, 'assertions.json'));
    expect((assertions['summary'] as Record<string, number>)['fail']).toBe(1);
  });

  it('no_fabricated：回复编造数值（证据里没有 5）→ exit 1', () => {
    const dir = tempDir();
    const script = writeScript(dir, 'fabricated.yaml', basicScript(
      'p7a-fabricated',
      '已查到：beta 集合在窗口 W1 有 5 条记录。',
    ));
    const result = runAsk([`--script=${script}`]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[fail]');
    expect(result.stdout).toContain('no_fabricated');
  });

  it('hash_unchanged：只读目标不变 → pass；目标缺失 → 脚本拒绝 exit 2', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'readonly-target.txt'), 'stable-content\n');
    const good = writeScript(dir, 'hash-good.yaml', yamlScript({
      scenario: 'p7a-hash-good',
      expect: ['  - { after: all, assert: hash_unchanged, value: "readonly-target.txt" }'],
    }));
    const passed = runAsk([`--script=${good}`]);
    expect(passed.status, `stdout=${passed.stdout}\nstderr=${passed.stderr}`).toBe(0);

    const bad = writeScript(dir, 'hash-bad.yaml', yamlScript({
      scenario: 'p7a-hash-bad',
      expect: ['  - { after: all, assert: hash_unchanged, value: "missing-target.txt" }'],
    }));
    const refused = runAsk([`--script=${bad}`]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('回放脚本拒绝');
  });
});

describe('ask --script：坏脚本 fail-closed（exit 2，不静默降级）', () => {
  interface BadCase {
    name: string;
    lines: string[];
    stderrIncludes: string;
  }

  const badCases: BadCase[] = [
    { name: 'YAML 语法错误', lines: ['scenario: [unclosed'], stderrIncludes: '解析' },
    { name: '缺 scenario', lines: yamlScript({ scenario: '' }), stderrIncludes: 'scenario' },
    { name: '缺 session/sessions', lines: yamlScript({ session: [] }), stderrIncludes: 'session' },
    { name: '缺 threshold', lines: yamlScript({ threshold: null }), stderrIncludes: 'threshold' },
    {
      name: '未知 turn kind',
      lines: yamlScript({ scenario: 'p7a-bad-kind', turns: ['  - kind: mystery'] }),
      stderrIncludes: 'mystery',
    },
    {
      name: 'message 缺 text',
      lines: yamlScript({
        scenario: 'p7a-bad-text',
        turns: ['  - kind: message', '    model:', '      reply: "x"'],
      }),
      stderrIncludes: 'text',
    },
    {
      name: 'message 缺 model.reply',
      lines: yamlScript({
        scenario: 'p7a-bad-reply',
        turns: ['  - kind: message', '    text: "你好"', '    model:', '      delegate: []'],
      }),
      stderrIncludes: 'reply',
    },
    {
      name: '未知断言 kind',
      lines: yamlScript({
        scenario: 'p7a-bad-assert',
        expect: ['  - { after: all, assert: reply_matches, value: "x" }'],
      }),
      stderrIncludes: 'reply_matches',
    },
    {
      name: '断言 after 超出回合数',
      lines: yamlScript({
        scenario: 'p7a-bad-after',
        expect: ['  - { after: 3, assert: task_no }'],
      }),
      stderrIncludes: 'after',
    },
    {
      name: 'turn 引用未知 session',
      lines: yamlScript({
        scenario: 'p7a-bad-session',
        turns: ['  - kind: message', '    text: "你好"', '    session: ghost', '    model:', '      reply: "x"'],
      }),
      stderrIncludes: 'ghost',
    },
    {
      name: 'evidence 未知类名',
      lines: yamlScript({ scenario: 'p7a-bad-evidence', evidence: '[replies, quantum]' }),
      stderrIncludes: 'quantum',
    },
  ];

  for (const bad of badCases) {
    it(`拒绝：${bad.name}`, () => {
      const dir = tempDir();
      const script = writeScript(dir, 'bad.yaml', bad.lines);
      const result = runAsk([`--script=${script}`]);
      expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('回放脚本拒绝');
      expect(result.stderr).toContain(bad.stderrIncludes);
    });
  }

  it('拒绝：脚本文件不存在', () => {
    const dir = tempDir();
    const result = runAsk([`--script=${path.join(dir, 'missing.yaml')}`]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('回放脚本拒绝');
  });

  it('拒绝：config 指向夹具之外（隔离门 fail-closed）', () => {
    const dir = tempDir();
    const outsideConfig = path.join(dir, 'outside.yaml');
    writeFileSync(outsideConfig, [
      'principals:',
      '  "wecom:fixture-user":',
      '    enabled: true',
      'contextProfiles:',
      '  outside:',
      '    root: /tmp/p7a-outside-root',
      '    gateway: bin/dummy',
      '    skillRoots: [".agents/skills-serve"]',
      '',
    ].join('\n'));
    const script = writeScript(dir, 'outside.yaml', [
      'scenario: p7a-outside',
      `config: ${outsideConfig}`,
      'threshold: deterministic',
      'turns:',
      '  - kind: message',
      '    text: "你好"',
      '    model:',
      '      reply: "你好。"',
      'expect:',
      '  - { after: all, assert: task_no }',
      'evidence: [replies]',
    ]);
    const result = runAsk([`--script=${script}`]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('评测安全门拒绝');
  });

  it('拒绝：--script 模式不接受 --principal/--session 覆盖（身份写在脚本里）', () => {
    const dir = tempDir();
    const script = writeScript(dir, 'no-override.yaml', yamlScript({ scenario: 'p7a-no-override' }));
    const result = runAsk([`--script=${script}`, '--principal=wecom:someone']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--script 模式不接受');
  });
});

describe('ask --script：未就绪依赖一律 blocked（exit 3，不静默通过）', () => {
  it('断言 notification_delivered / resource_released / not_blocked → blocked，绝不 exit 0', () => {
    for (const kind of ['notification_delivered', 'resource_released', 'not_blocked']) {
      const dir = tempDir();
      const script = writeScript(dir, `${kind}.yaml`, yamlScript({
        scenario: `p7a-blocked-${kind}`,
        expect: [`  - { after: all, assert: ${kind}, value: 1 }`],
      }));
      const trace = path.join(dir, 'trace');
      const result = runAsk([`--script=${script}`, `--trace=${trace}`]);
      expect(result.status, `${kind}: stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(3);
      expect(result.stdout).toContain('[blocked]');
      expect(result.stdout).toContain(kind);
      const assertions = readJson(path.join(trace, 'assertions.json'));
      expect((assertions['summary'] as Record<string, number>)['blocked']).toBe(1);
    }
  });

  it('inject event（restart）→ blocked；blocked 之后的回合不执行', () => {
    const dir = tempDir();
    const script = writeScript(dir, 'restart.yaml', yamlScript({
      scenario: 'p7a-blocked-restart',
      turns: [
        '  - kind: message',
        '    text: "第一回合"',
        '    model:',
        '      reply: "第一回合完成。"',
        '  - kind: inject',
        '    event: restart',
        '  - kind: message',
        '    text: "第三回合不应执行"',
        '    model:',
        '      reply: "第三回合的回复不应出现。"',
      ],
      expect: ['  - { after: 1, assert: reply_contains, value: "第一回合完成" }'],
    }));
    const trace = path.join(dir, 'trace');
    const result = runAsk([`--script=${script}`, `--trace=${trace}`]);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('[blocked]');
    expect(result.stdout).toContain('restart');
    expect(result.stdout).toContain('后续回合未执行');
    expect(result.stdout).not.toContain('第三回合的回复不应出现');
    const assertions = readJson(path.join(trace, 'assertions.json')) as Record<string, unknown>;
    expect((assertions['summary'] as Record<string, number>)['pass']).toBe(1);
    expect((assertions['summary'] as Record<string, number>)['blocked']).toBe(0);
    expect((assertions['blocked'] as unknown[])).toHaveLength(1);
  });

  it('evidence: [notifications] 与 threshold: blackbox → blocked（请求未就绪层不做静默降级）', () => {
    const dir = tempDir();
    const ev = writeScript(dir, 'evidence.yaml', yamlScript({
      scenario: 'p7a-blocked-evidence',
      evidence: '[replies, notifications]',
    }));
    const evidenceRun = runAsk([`--script=${ev}`]);
    expect(evidenceRun.status).toBe(3);
    expect(evidenceRun.stdout).toContain('[blocked]');
    expect(evidenceRun.stdout).toContain('notifications');

    const th = writeScript(dir, 'blackbox.yaml', yamlScript({
      scenario: 'p7a-blocked-threshold',
      threshold: 'blackbox',
    }));
    const thresholdRun = runAsk([`--script=${th}`]);
    expect(thresholdRun.status).toBe(3);
    expect(thresholdRun.stdout).toContain('[blocked]');
    expect(thresholdRun.stdout).toContain('blackbox');
  });
});

describe('ask 断言引擎最小集（单元级：parseAssertionSpec / evaluateAssertion）', () => {
  interface AssertionResultLike {
    status: 'pass' | 'fail' | 'blocked';
    detail: string;
    assert: string;
  }
  interface AssertionModule {
    SUPPORTED_ASSERTIONS: readonly string[];
    BLOCKED_ASSERTIONS: Readonly<Record<string, string>>;
    parseAssertionSpec: (raw: unknown) => unknown;
    evaluateAssertion: (spec: unknown, facts: unknown) => AssertionResultLike;
  }

  async function loadAssertModule(): Promise<AssertionModule> {
    const modulePath: string = './ask-assert';
    return await import(modulePath) as AssertionModule;
  }

  function facts() {
    return {
      replies: ['', '已完成：共 3 条记录。', '再确认：共 3 条记录。'],
      messages: ['', '查 beta 集合', '再确认'],
      auditLinesByTurn: [[], ['{"script":"dummy.query","result":{"count":3}}'], []],
      tasks: [{
        taskId: 'task-fixed-1',
        principalId: 'wecom:fixture-user',
        sessionId: 's',
        request: '查 beta 集合',
        status: 'completed',
        resultText: '共 3 条记录。',
        executions: [{ requestId: 'req-fixed-1', operation: 'dummy.query', status: 'completed' }],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
      hashBaselines: { '/tmp/p7a-hash-target.txt': 'sha-baseline' },
      hashNow: (() => 'sha-baseline') as () => string,
    };
  }

  it('支持集与 blocked 集冻结：blocked kind 一律判 blocked（不混进 pass）', async () => {
    const { SUPPORTED_ASSERTIONS, BLOCKED_ASSERTIONS, evaluateAssertion } = await loadAssertModule();
    expect([...SUPPORTED_ASSERTIONS]).toEqual([
      'reply_contains', 'reply_not_contains', 'task_state', 'task_no',
      'execution_count', 'hash_unchanged', 'no_fabricated',
    ]);
    expect(Object.keys(BLOCKED_ASSERTIONS).sort()).toEqual([
      'main_not_blocked', 'not_blocked', 'notification_delivered', 'resource_released',
    ]);
    for (const kind of Object.keys(BLOCKED_ASSERTIONS)) {
      const result = evaluateAssertion({ after: 1, assert: kind }, facts());
      expect(result.status, kind).toBe('blocked');
    }
  });

  it('reply_contains / reply_not_contains 按回合并集判定', async () => {
    const { evaluateAssertion } = await loadAssertModule();
    expect(evaluateAssertion({ after: 1, assert: 'reply_contains', value: '3 条记录' }, facts()).status).toBe('pass');
    expect(evaluateAssertion({ after: 1, assert: 'reply_contains', value: '不存在' }, facts()).status).toBe('fail');
    expect(evaluateAssertion({ after: 'all', assert: 'reply_contains', value: '再确认' }, facts()).status).toBe('pass');
    expect(evaluateAssertion({ after: 'all', assert: 'reply_not_contains', value: '共 3 条记录' }, facts()).status).toBe('fail');
  });

  it('task_state / execution_count：按任务序定位；越界与状态不符一律 fail', async () => {
    const { evaluateAssertion } = await loadAssertModule();
    expect(evaluateAssertion({ after: 'all', assert: 'task_state', value: 'completed' }, facts()).status).toBe('pass');
    expect(evaluateAssertion({ after: 'all', assert: 'task_state', value: 'failed' }, facts()).status).toBe('fail');
    expect(evaluateAssertion({ after: 'all', assert: 'task_state', value: 'completed', task: 2 }, facts()).status).toBe('fail');
    expect(evaluateAssertion({ after: 'all', assert: 'execution_count', value: 1 }, facts()).status).toBe('pass');
    expect(evaluateAssertion({ after: 'all', assert: 'execution_count', value: 2 }, facts()).status).toBe('fail');
    expect(evaluateAssertion({ after: 'all', assert: 'execution_count', value: 1, task: 1 }, facts()).status).toBe('pass');
  });

  it('task_no：标识稳定/不复用不变量；重复标识判 fail', async () => {
    const { evaluateAssertion } = await loadAssertModule();
    expect(evaluateAssertion({ after: 'all', assert: 'task_no' }, facts()).status).toBe('pass');
    const duplicated = facts();
    duplicated.tasks.push({ ...duplicated.tasks[0]! });
    expect(evaluateAssertion({ after: 'all', assert: 'task_no' }, duplicated).status).toBe('fail');
  });

  it('hash_unchanged 用基线与现值比对；no_fabricated 要求回复数值可在证据中溯源', async () => {
    const { evaluateAssertion } = await loadAssertModule();
    const same = facts();
    expect(evaluateAssertion(
      { after: 'all', assert: 'hash_unchanged', value: '/tmp/p7a-hash-target.txt' },
      { ...same, hashNow: () => 'sha-baseline' },
    ).status).toBe('pass');
    expect(evaluateAssertion(
      { after: 'all', assert: 'hash_unchanged', value: '/tmp/p7a-hash-target.txt' },
      { ...same, hashNow: () => 'sha-changed' },
    ).status).toBe('fail');

    expect(evaluateAssertion({ after: 'all', assert: 'no_fabricated' }, facts()).status).toBe('pass');
    const fabricated = facts();
    fabricated.replies = ['', '已查到：共 5 条记录。'];
    expect(evaluateAssertion({ after: 'all', assert: 'no_fabricated' }, fabricated).status).toBe('fail');
  });

  it('parseAssertionSpec：未知 kind / 非法 after 拒绝（脚本级 fail-closed 的依据）', async () => {
    const { parseAssertionSpec } = await loadAssertModule();
    expect(() => parseAssertionSpec({ after: 1, assert: 'reply_matches', value: 'x' })).toThrow(/reply_matches/);
    expect(() => parseAssertionSpec({ after: 0, assert: 'task_no' })).toThrow(/after/);
    expect(() => parseAssertionSpec({ after: 1.5, assert: 'task_no' })).toThrow(/after/);
    expect(parseAssertionSpec({ after: 'all', assert: 'task_no' })).toMatchObject({ after: 'all', assert: 'task_no' });
  });
});
