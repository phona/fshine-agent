/**
 * T2 无倾向学习路径（架构调整相位 1）。
 *
 * 两条机械断言：
 *   ① 生产装配传给 createTaxAgentRuntime 的 deps **不含**任何"从会话历史学习用户行为→
 *      影响执行"的接线（contextStates / memoryRecords / memoryCandidateExtractor /
 *      contextModelDriver）——今天的装配四样全接；
 *   ② 生产代码（packages/agent/src + apps + packages/core/src + packages/contracts/src）
 *      里这些字段与路径**一个都不存在**：扫描命中即红。留着一处接线或一处存储层残留，
 *      就是留一条"历史 → 影响执行"的通路，也是让机制看起来还活着的坟。
 *
 * 为什么两条都要：① 钉装配（行为面，能抓"偷偷接回来"），② 钉字段与路径的存在性
 * （结构面，能抓同名复现）。两者都不看实现内部，只看装配产物与代码树。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnDriver } from '@fshine/agent';

vi.mock('@fshine/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fshine/agent')>();
  return {
    ...actual,
    // 透传 spy：记录装配传给 runtime 的 deps，实现仍是真工厂（离线构造安全）。
    createTaxAgentRuntime: vi.fn(actual.createTaxAgentRuntime),
    createPiTurnDriver: vi.fn(actual.createPiTurnDriver),
  };
});

import { createTaxAgentRuntime } from '@fshine/agent';
import { createServerAssembly } from './assembly';

const REPO_ROOT = path.resolve(__dirname, '../..');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
});

/** 最小装配夹具：除授权名单外什么都不配（无 platformRoot → 不触平台 lint/CLI，离线构造）。 */
function minimalEnv(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'no-learning-path-'));
  roots.push(root);
  writeFileSync(path.join(root, 'agent.yaml'), [
    'principals:',
    '  wecom:learn_user:',
    '    accountSetScope: all',
    '    enabled: true',
    '',
  ].join('\n'));
  return {
    AGENT_CONFIG_PATH: path.join(root, 'agent.yaml'),
    LLM_API_BASE_URL: 'http://127.0.0.1:9',
    LLM_API_KEY: 'no-learning-path-key',
    LLM_MODEL: 'step-3.7-flash',
  };
}

async function boot(env: NodeJS.ProcessEnv): Promise<void> {
  const dbPath = path.join(path.dirname(env['AGENT_CONFIG_PATH']!), 'agent.db');
  const assembly = await createServerAssembly({ env, dbPath, driver: idleDriver() });
  await assembly.close();
}

function idleDriver(): TurnDriver {
  return { run: async (input) => ({ text: '', messages: input.messages }) };
}

/**
 * 学习路径字段名（删除集）：这些名字出现在装配产物或编排层生产代码里 = 存在一条
 * "会话历史 → 用户行为模型 → 影响执行"的通路。
 */
const LEARNING_PATH_IDENTIFIERS: readonly string[] = [
  'memoryRecords',
  'MemoryRecordRepo',
  'memoryCandidateExtractor',
  'memoryBatchSize',
  'consolidateLongMemory',
  'reduceLongMemory',
  'renderMemoryProjection',
  'loadMemoryProjection',
  'scheduleMemoryConsolidation',
  'createLongMemoryCandidateExtractor',
  'createMemoryCandidateModel',
  'contextStates',
  'ContextStateRepo',
  'reduceContextState',
  'extractContextWithTurnDriver',
  'contextModelDriver',
];

/**
 * 生产代码扫描面（测试文件豁免：它们本就在描述被删的形状）。
 *
 * `packages/core/src` 与 `packages/contracts/src` 是 2026-11-12 补的：原扫描面只盯
 * 编排层，存储层（长期记忆表/Context State 表与两个 repo、契约类型、桶导出）成了盲区
 * ——机制已裁定删除，残留却仍在，`memory-records.ts` 还带着自己的测试 suite，让
 * 「机制健在」的错觉可复现。扫描面只加不减。
 */
const SCAN_DIRS = [
  'packages/agent/src',
  'apps',
  'packages/core/src',
  'packages/contracts/src',
] as const;

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

describe('T2 装配与生产代码里不存在学习路径', () => {
  it('装配不向 runtime 传 contextStates / memoryRecords / memoryCandidateExtractor / contextModelDriver', async () => {
    await boot(minimalEnv());

    const call = vi.mocked(createTaxAgentRuntime).mock.calls.at(-1);
    expect(call, 'createTaxAgentRuntime 未被装配调用').toBeDefined();
    const deps = call![0] as unknown as Record<string, unknown>;
    for (const key of ['contextStates', 'memoryRecords', 'memoryCandidateExtractor', 'contextModelDriver']) {
      expect(Object.keys(deps), `装配仍在接学习路径依赖：${key}`).not.toContain(key);
    }
  });

  it('生产代码（编排层 + 存储层）里学习路径字段与路径零命中', () => {
    const hits: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(REPO_ROOT, dir))) {
        const content = readFileSync(file, 'utf8');
        for (const identifier of LEARNING_PATH_IDENTIFIERS) {
          if (content.includes(identifier)) hits.push(`${path.relative(REPO_ROOT, file)}: ${identifier}`);
        }
      }
    }
    expect(hits, [
      '生产代码仍存在"会话历史 → 用户行为 → 影响执行"的字段或路径：',
      ...hits,
      '真需要这类能力时先立判据与登记，不要静默接回一条无倾向学习通路。',
    ].join('\n')).toEqual([]);
  });
});
