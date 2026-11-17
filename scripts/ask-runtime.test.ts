/**
 * ask 共享装配（scripts/ask-runtime.ts，P3 从 scripts/ask.ts 抽出）：
 *   · purpose 化话术：purpose='ask' 时五处装配门的拒绝话术逐字节等于抽取前 ask 入口原文；
 *   · redo 以 purpose='重新推进' 复用同一函数（话术随 purpose，装配链不复制）；
 *   · 对仓内 dummy 夹具真装配（假 key：构造不发网络），principal/session/底账按输入落位。
 *
 * 这里钉的是「ask 行为与输出不因抽取改变」的拒绝路径字节金样；成功路径的输出金样由
 * 既有 tasks/ask 形态与真实模型演示对照（本文件不发模型请求、不触网）。
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssemblyRefusedError, assembleAskRuntime, type AskRuntimeInput } from './ask-runtime';

const REPO_ROOT = path.resolve(__dirname, '..');

const dirs: string[] = [];
function tempDir(prefix = 'ask-runtime-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 干净 env：不带任何 LLM_* 泄漏（vitest.setup 已清父进程；这里再显式收敛）。 */
function envWith(key?: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    TMPDIR: process.env['TMPDIR'],
    ...(key === undefined ? {} : { LLM_API_KEY: key }),
  };
}

async function refusalOf(input: AskRuntimeInput): Promise<Error> {
  try {
    await assembleAskRuntime(input);
  } catch (error) {
    return error as Error;
  }
  throw new Error('应当拒绝但没有拒绝');
}

function writeConfig(file: string, lines: string[]): string {
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

describe('ask-runtime：装配门话术（purpose=ask 逐字等于抽取前 ask 原文）', () => {
  it('缺 LLM_API_KEY：ask 话术逐字；同一模板服务 redo（purpose=重新推进）', async () => {
    const ask = await refusalOf({
      purpose: 'ask', argv: [], env: envWith(), runtimeDir: tempDir(), sessionId: 's',
    });
    expect(ask).toBeInstanceOf(AssemblyRefusedError);
    expect(ask.message).toBe('未检测到 LLM_API_KEY——ask 需要真实模型（密钥只在 .env，或配置 llm.apiKey）。');

    const redo = await refusalOf({
      purpose: '重新推进', argv: [], env: envWith(), runtimeDir: tempDir(), sessionId: 's',
    });
    expect(redo).toBeInstanceOf(AssemblyRefusedError);
    expect(redo.message).toBe('未检测到 LLM_API_KEY——重新推进 需要真实模型（密钥只在 .env，或配置 llm.apiKey）。');
  });

  it('多 profile / 缺 gateway / 无 enabled principal：ask 话术逐字（与抽取前 ask.ts 一致）', async () => {
    const dir = tempDir();
    const twoProfiles = writeConfig(path.join(dir, 'two.yaml'), [
      'principals: {}',
      'contextProfiles:',
      '  a:',
      '    root: /tmp/a',
      '    gateway: bin/dummy',
      '    skillRoots: [".agents/skills-serve"]',
      '  b:',
      '    root: /tmp/b',
      '    gateway: bin/dummy',
      '    skillRoots: [".agents/skills-serve"]',
    ]);
    const many = await refusalOf({
      purpose: 'ask', argv: [`--config=${twoProfiles}`], env: envWith('test-key'), runtimeDir: tempDir(), sessionId: 's',
    });
    expect(many.message).toBe('ask 需要单一 contextProfile（当前 2 个）——最小切片不做多 profile 选择。');

    const noGateway = writeConfig(path.join(dir, 'no-gateway.yaml'), [
      'principals: {}',
      'contextProfiles:',
      '  a:',
      '    root: /tmp/a',
      '    skillRoots: [".agents/skills-serve"]',
    ]);
    const gateway = await refusalOf({
      purpose: 'ask', argv: [`--config=${noGateway}`], env: envWith('test-key'), runtimeDir: tempDir(), sessionId: 's',
    });
    expect(gateway.message).toBe('profile 缺少 gateway——最小切片需要执行层挂载声明。');

    const noPrincipal = writeConfig(path.join(dir, 'no-principal.yaml'), [
      'principals: {}',
      'contextProfiles:',
      '  a:',
      '    root: /tmp/a',
      '    gateway: bin/dummy',
      '    skillRoots: [".agents/skills-serve"]',
    ]);
    const principal = await refusalOf({
      purpose: 'ask', argv: [`--config=${noPrincipal}`], env: envWith('test-key'), runtimeDir: tempDir(), sessionId: 's',
    });
    expect(principal.message).toBe('配置里没有 enabled principal——最小切片需要可信身份来源（fail-closed，不回落写死值）。');
  });

  it('执行层零只读 operation：拒绝话术逐字（临时夹具网关，仓内隔离门内）', async () => {
    // 隔离门要求 root 在仓内夹具目录之下：临时夹具必须落在这里（afterEach 清理）。
    const fixtureRoot = mkdtempSync(path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'ask-runtime-empty-'));
    dirs.push(fixtureRoot);
    mkdirSync(path.join(fixtureRoot, 'bin'), { recursive: true });
    const gateway = path.join(fixtureRoot, 'bin', 'gateway');
    writeFileSync(gateway, [
      '#!/usr/bin/env node',
      'process.stdout.write(JSON.stringify({ operations: [{ name: "write-only", access: "write" }] }) + "\\n");',
    ].join('\n') + '\n');
    chmodSync(gateway, 0o755);

    const config = writeConfig(path.join(tempDir(), 'empty-ops.yaml'), [
      'principals:',
      '  "test:user":',
      '    enabled: true',
      'contextProfiles:',
      '  t:',
      `    root: ${fixtureRoot}`,
      '    gateway: bin/gateway',
      '    skillRoots: [".agents/skills-serve"]',
    ]);
    const refused = await refusalOf({
      purpose: 'ask', argv: [`--config=${config}`], env: envWith('test-key'), runtimeDir: tempDir(), sessionId: 's',
    });
    expect(refused).toBeInstanceOf(AssemblyRefusedError);
    expect(refused.message).toBe('执行层没有声明任何只读 operation——最小切片拒绝以空允许集合运行。');
  });
});

describe('ask-runtime：对仓内 dummy 夹具真装配（假 key，不发模型请求）', () => {
  it('缺省配置链：principal 取第一个 enabled；session/底账按输入落位；可关闭', async () => {
    const runtimeDir = tempDir();
    const dbPath = path.join(tempDir(), 'state.db');
    const runtime = await assembleAskRuntime({
      purpose: 'ask',
      argv: [],
      env: envWith('test-key'),
      runtimeDir,
      sessionId: 'test-session',
      dbPath,
    });
    expect(runtime.principalId).toBe('wecom:fixture-user');
    expect(runtime.sessionId).toBe('test-session');
    expect(runtime.dbPath).toBe(dbPath);
    expect(runtime.auditPath).toBe(path.join(runtimeDir, 'state', 'audit.jsonl'));
    expect(runtime.session.tasks()).toEqual([]);
    runtime.close();
  });
});
