/**
 * P7a 单轮兼容与参数 fail-closed——测试先行（P7-T04 + P7 切片「互斥参数拒绝」）。
 *
 * 依据：R4 验收设计 P7-T04「单轮兼容：输出/退出码逐字不变」；owner 接线纪律
 * 「ask.ts 只加最小 hook」——新入口不得改变单轮行为与五门归类。
 *
 * 本文件钉住的契约：
 *   · 单轮缺密钥五门金样逐字节不变（回归钉，现状即绿）；
 *   · 缺消息/未知参数沿用既有归类（现状即绿）；
 *   · `--interactive` / `--script` 与消息参数互斥、`--trace` 必须配引擎、缺值 fail-closed
 *     （实现前红：现状一律「未知参数」）；
 *   · `--script <file>`（空格形态）不要求 LLM 密钥（确定性层用假 driver，不冒充真实模型）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');

const dirs: string[] = [];
function tempDir(prefix = 'p7a-compat-'): string {
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

function sealedEnv(): NodeJS.ProcessEnv {
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

function runAsk(args: readonly string[]): CliResult {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/ask.ts', ...args],
    { cwd: REPO_ROOT, env: sealedEnv(), encoding: 'utf8', input: '' },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function minimalScript(dir: string): string {
  const file = path.join(dir, 'compat.yaml');
  writeFileSync(file, [
    'scenario: p7a-compat',
    'session:',
    '  principal: "wecom:fixture-user"',
    '  session: "s-compat"',
    'threshold: deterministic',
    'turns:',
    '  - kind: message',
    '    text: "你好"',
    '    model:',
    '      reply: "你好，我是回放助手。"',
    'expect:',
    '  - { after: all, assert: reply_contains, value: "回放助手" }',
    'evidence: [replies]',
    '',
  ].join('\n'));
  return file;
}

describe('P7a 单轮兼容：既有行为不被新入口改变', () => {
  it('单轮缺 LLM_API_KEY：五门话术逐字节、exit 2、stdout 空（回归钉）', () => {
    const result = runAsk(['你好']);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('未检测到 LLM_API_KEY——ask 需要真实模型（密钥只在 .env，或配置 llm.apiKey）。\n');
  });

  it('缺消息与未知参数：沿用既有归类、exit 2（回归钉）', () => {
    const noMessage = runAsk([]);
    expect(noMessage.status).toBe(2);
    expect(noMessage.stderr).toContain('缺少消息。');

    const unknown = runAsk(['你好', '--bogus']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('未知参数：--bogus');
  });
});

describe('P7a 参数边界：互斥与缺值一律 fail-closed（exit 2）', () => {
  it('消息参数与 --interactive/--script 互斥', () => {
    const interactive = runAsk(['你好', '--interactive']);
    expect(interactive.status).toBe(2);
    expect(interactive.stderr).toContain('--interactive 不接受消息参数');

    const dir = tempDir();
    const script = minimalScript(dir);
    const replay = runAsk(['你好', `--script=${script}`]);
    expect(replay.status).toBe(2);
    expect(replay.stderr).toContain('--script 不接受消息参数');

    const both = runAsk(['--interactive', `--script=${script}`]);
    expect(both.status).toBe(2);
    expect(both.stderr).toContain('--interactive 与 --script 互斥');
  });

  it('--trace 必须配 --script/--interactive；--script/--trace 缺值拒绝', () => {
    const dir = tempDir();
    const alone = runAsk([`--trace=${dir}`]);
    expect(alone.status).toBe(2);
    expect(alone.stderr).toContain('--trace 需要与');

    const noScriptValue = runAsk(['--script']);
    expect(noScriptValue.status).toBe(2);
    expect(noScriptValue.stderr).toContain('--script 缺少脚本文件路径');

    const noTraceValue = runAsk(['--interactive', '--trace']);
    expect(noTraceValue.status).toBe(2);
    expect(noTraceValue.stderr).toContain('--trace 缺少目录路径');
  });

  it('--script <file>（空格形态）：确定性层不要求 LLM 密钥，exit 0', () => {
    const dir = tempDir();
    const script = minimalScript(dir);
    const result = runAsk(['--script', script]);
    expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('[pass]');
  });
});
