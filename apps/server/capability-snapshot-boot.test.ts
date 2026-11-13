/**
 * 发现接缝的装配回归（「关进笼子」，2026-11-13）：boot 期**一次**发现 + 派生表注入。
 *
 * 证据形态 = 真装配 + 真 spawn 的假网关（每次调用留一行 argv 日志）：
 *   · boot 后网关日志恰好一行：`operation list --json`（真发现一次；旧实现是七个 loader
 *     各自 spawn，boot 期只跑其中一个，其余散在运行期）；
 *   · 反向绊线：把装配里的发现写成两次，本文件第一断言立刻变两行（见表末尾注释的实测记录）；
 *   · 派生表真的进了消费点：worker 驱动收到 label / args 规格 / 语义 / 协议 / 协议清单，
 *     落账后端收到协议角色表，提案 schema 取问器同根零 spawn（跨根才经同一接缝一次性发现）。
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextTaskRunner } from '@fshine/agent';

vi.mock('@fshine/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fshine/agent')>();
  return {
    ...actual,
    // 透传 spy：只记录装配传入的 options，实现仍是真工厂（构造不 spawn、不起模型）。
    createPiCodingTurnDriver: vi.fn(actual.createPiCodingTurnDriver),
    createContextTaskRunner: vi.fn(actual.createContextTaskRunner),
  };
});

vi.mock('./proposal-commit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proposal-commit')>();
  return { ...actual, createProposalCommitRunner: vi.fn(actual.createProposalCommitRunner) };
});

import { createPiCodingTurnDriver, createContextTaskRunner, type PiCodingTurnDriverOptions } from '@fshine/agent';
import { createServerAssembly } from './assembly';
import { createProposalCommitRunner } from './proposal-commit';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

/** 假执行层清单：两条 operation（一条读、一条提案创建角色）+ 顶层语义表。 */
const MANIFEST = {
  operations: [
    {
      name: 'dummy.query', command: 'query', access: 'read', label: 'query records',
      effects: ['read'], executor: 'compat-script', est_seconds: 10, weight: 2,
      args: { positional: [], flags: [{ flag: '--collection', required: true, style: 'name' }, { flag: '--window', required: false, style: 'code' }] },
      serve: { query: true, prepare: true, commit: true }, protocol: null, proposalSchema: null,
    },
    {
      name: 'dummy.proposal', command: 'proposal', access: 'write', label: 'create proposal',
      effects: ['write'], executor: 'compat-script', est_seconds: 10, weight: 5,
      args: { positional: [{ name: 'payload', required: true }], flags: [{ flag: '--batch', required: false, style: 'code' }] },
      serve: { prepare: true, commit: false }, protocol: 'proposal.create',
      proposalSchema: { $id: 'ChangeProposalPayload', type: 'object' },
    },
  ],
  accessSemantics: { read: { plan: true, confirm: false }, write: { plan: true, confirm: true } },
};

/**
 * 假平台根：lint 过门 + 可观测网关（每次调用把 argv 追加进日志；发现子命令回预置清单）。
 * 返回日志路径与清单路径，供断言"boot 期发现几次"。
 */
function fakePlatformRoot(): { root: string; logPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'cap-snapshot-boot-'));
  roots.push(root);
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'lint-operations.js'), 'process.exit(0);\n');
  const manifestPath = path.join(root, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(MANIFEST));
  const logPath = path.join(root, 'gateway.log');
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  const gateway = path.join(root, 'bin', 'gw-under-test');
  writeFileSync(gateway, [
    '#!/bin/sh',
    `echo "$@" >> "${logPath}"`,
    'if [ "$1" = "operation" ]; then',
    `  cat "${manifestPath}"`,
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(gateway, 0o755);
  mkdirSync(path.join(root, '.agents', 'skills'), { recursive: true });
  return { root, logPath };
}

function seamEnv(platformRoot: string): NodeJS.ProcessEnv {
  const configDir = mkdtempSync(path.join(tmpdir(), 'cap-snapshot-config-'));
  roots.push(configDir);
  writeFileSync(path.join(configDir, 'agent.yaml'), [
    'principals:',
    '  wecom:seam_user:',
    '    accountSetScope: all',
    '    enabled: true',
    'contextProfiles:',
    '  dummy:',
    `    root: ${platformRoot}`,
    '    skillRoots: [".agents/skills"]',
    '    gateway: bin/gw-under-test',
    '',
  ].join('\n'));
  return {
    AGENT_CONFIG_PATH: path.join(configDir, 'agent.yaml'),
    LLM_API_BASE_URL: 'http://127.0.0.1:9',
    LLM_API_KEY: 'seam-test-key',
    LLM_MODEL: 'worker-strong-model',
  };
}

async function bootSeam(env: NodeJS.ProcessEnv): Promise<void> {
  const dbPath = path.join(path.dirname(env['AGENT_CONFIG_PATH']!), 'agent.db');
  const assembly = await createServerAssembly({ env, dbPath });
  await assembly.close();
}

function gatewayLogLines(logPath: string): string[] {
  try {
    return readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function workerFactoryOptions(): PiCodingTurnDriverOptions {
  const call = vi.mocked(createPiCodingTurnDriver).mock.calls.at(-1);
  if (!call) throw new Error('createPiCodingTurnDriver 未被装配调用');
  return call[0];
}

function taskRunnerOptions(): Record<string, unknown> {
  const call = vi.mocked(createContextTaskRunner).mock.calls.at(-1);
  if (!call) throw new Error('createContextTaskRunner 未被装配调用');
  return call[0] as unknown as Record<string, unknown>;
}

describe('发现接缝 · 装配 boot：一次发现 + 派生表注入', () => {
  it('boot 只发现一次（网关日志恰一行 argv），派生表逐项注入 worker 驱动', async () => {
    const { root, logPath } = fakePlatformRoot();
    await bootSeam(seamEnv(root));

    // ① 单一发现：boot 期恰好一次发现调用（形态即 argv 本身）。
    const lines = gatewayLogLines(logPath);
    expect(lines).toEqual(['operation list --json']);

    // ② 派生表注入 worker 驱动（label / args 规格 / 语义 / 协议 / 协议清单）。
    const options = workerFactoryOptions();
    expect(options.operationLabels?.get('dummy.query')).toBe('query records');
    expect(options.operationLabels?.get('query')).toBe('query records');
    expect(options.operationArgSpecs?.get('dummy.query')?.flagStyles.get('--collection')).toBe('name');
    expect(options.operationArgSpecs?.get('dummy.proposal')?.positionalNames).toEqual(['payload']);
    expect(options.operationSemantics?.get('dummy.proposal')).toEqual({ plan: true, confirm: true });
    expect(options.operationSemantics?.get('dummy.query')).toEqual({ plan: true, confirm: false });
    expect(options.operationProtocols?.get('dummy.proposal')).toBe('proposal.create');
    expect(options.capabilityManifest?.operations.map((op) => op.operation)).toEqual(['dummy.query', 'dummy.proposal']);

    // ③ 落账后端拿到同一份协议角色表（boot 快照派生，不再各自 spawn）。
    const commitOptions = vi.mocked(createProposalCommitRunner).mock.calls.at(-1)?.[0];
    expect(commitOptions?.operationProtocols?.get('dummy.proposal')).toBe('proposal.create');

    // ④ 提案 schema 取问器：同根直接取快照派生值（零新发现）。
    const loader = taskRunnerOptions()['proposalSchemaLoader'] as (args: { platformRoot: string; gateway?: string }) => Promise<unknown>;
    const schema = await loader({ platformRoot: root, gateway: 'bin/gw-under-test' });
    expect(schema).toMatchObject({ $id: 'ChangeProposalPayload' });
    expect(gatewayLogLines(logPath)).toEqual(['operation list --json']);

    // ⑤ 换根（多 profile 演进期的直调路径）：经同一接缝一次性发现——新根日志恰一行。
    const other = fakePlatformRoot();
    const foreign = await loader({ platformRoot: other.root, gateway: 'bin/gw-under-test' });
    expect(foreign).toMatchObject({ $id: 'ChangeProposalPayload' });
    expect(gatewayLogLines(other.logPath)).toEqual(['operation list --json']);
  });

  it('反向绊线（实测记录）：装配里发现两次 → 网关日志两行，断言①当场红', async () => {
    // 本用例不改生产代码，只做计数口径的自证：假网关被调用两次就留两行——
    // 断言①的 `toEqual(['operation list --json'])` 因此对"多发现一次"是敏感的。
    // 2026-11-13 实施记录：临时把 assembly 的 `await capabilitySource.load()` 写成两遍，
    // 本文件断言①实测红（日志两行），复原后绿。
    const { root, logPath } = fakePlatformRoot();
    const env = seamEnv(root);
    await bootSeam(env);
    expect(gatewayLogLines(logPath)).toHaveLength(1);
    // 再手动触发一次同形调用（模拟"发现两次"的第二种写法：不缓存、又加载一遍）。
    const cli = path.join(root, 'bin', 'gw-under-test');
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(cli, ['operation', 'list', '--json'], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(gatewayLogLines(logPath)).toEqual(['operation list --json', 'operation list --json']);
  });
});
