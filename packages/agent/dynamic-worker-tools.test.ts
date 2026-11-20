/**
 * 动态 Worker 工具面守卫（owner 2026-11-20）：每个 operation 一个 `op_*` 工具，参数用业务
 * 字段名 + 结构化 schema；宿主把结构化值翻回执行层要的形状。
 *
 * 反向绊线（详见各用例注释）：
 *   · 去掉 hostOnly 过滤 → ① 红（hostOnly 参数名漏进 schema）；
 *   · 把 `--` 恢复进 schema 字段名 → ② 红；
 *   · 去掉确认/计数宿主演算 → ④ 红（机制参数被模型值覆盖）。
 */
import { describe, expect, it } from 'vitest';
import type { CapabilityManifest } from '@fshine/contracts/execution-contract';
import {
  mapWorkerOperationArgs,
  workerDelegationManifest,
  workerOperationTools,
  workerOperationToolName,
} from './src/execution-runtime';

/** 一把真实形状的清单：业务字段 + hostOnly 机制参数 + payload.schema。 */
const MANIFEST: CapabilityManifest = {
  contractVersion: 4,
  operations: [
    {
      name: 'dummy.query',
      label: 'query records',
      args: [
        { name: '--collection', required: true, type: 'name' },
        { name: '--window', required: false, type: 'code' },
        { name: '--delay-ms', required: false, type: 'code', hostOnly: true },
      ],
    },
    {
      name: 'dummy.prepare',
      label: 'prepare records',
      args: [
        { name: '--collection', required: true, type: 'name' },
        { name: '--window', required: false, type: 'code' },
        { name: '--count', required: false, type: 'code', hostOnly: true },
        { name: '--apply', required: false, type: 'code', hostOnly: true },
        { name: 'records', required: false, payload: { schema: { type: 'array', items: { type: 'object' } } } },
      ],
    },
    {
      name: 'dummy.commit',
      label: 'commit records',
      args: [
        { name: '--collection', required: true, type: 'name' },
        { name: '--confirmation', required: false, type: 'code', hostOnly: true },
        { name: '--fail-index', required: false, type: 'code', hostOnly: true },
        { name: 'records', required: false, payload: { schema: { type: 'array' } } },
      ],
    },
    {
      name: 'dummy.longtask',
      label: 'long running task',
      args: [
        { name: '--seconds', required: true, type: 'code', hostOnly: true },
        { name: '--fail-after', required: false, type: 'code', hostOnly: true },
      ],
      long_running: true,
    },
  ],
};

const FORBIDDEN = ['--', 'style', 'weight', 'estimatedSeconds', 'effects', 'long_running'];

describe('动态 Worker 工具面：schema 形状', () => {
  it('① schema 不含 `--` 前缀、不含 hostOnly 参数名、不含实现字样（反向绊线：去掉 hostOnly 过滤 → 红）', () => {
    const tools = workerOperationTools(MANIFEST);
    const hostOnlyNames = ['delay-ms', 'count', 'apply', 'confirmation', 'fail-index', 'seconds', 'fail-after'];
    for (const tool of tools) {
      const schema = JSON.stringify(tool.inputSchema);
      for (const word of FORBIDDEN) {
        expect(schema, `${tool.name} schema 不得含 ${word}`).not.toContain(word);
      }
      for (const name of hostOnlyNames) {
        expect(schema, `${tool.name} schema 不得含 hostOnly 参数 ${name}`).not.toContain(name);
      }
    }
  });

  it('② 字段名去 `--` 前缀（反向绊线：把 `--` 恢复进 schema → 红）', () => {
    const tools = workerOperationTools(MANIFEST);
    const query = tools.find((tool) => tool.name === 'op_dummy_query');
    expect(query).toBeDefined();
    expect(Object.keys((query!.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual(['collection', 'window']);
    expect((query!.inputSchema as { required: string[] }).required).toEqual(['collection']);
  });

  it('③ 每个允许集内 operation 恰好一个工具，数量与清单一致', () => {
    const tools = workerOperationTools(MANIFEST);
    expect(tools).toHaveLength(MANIFEST.operations.length);
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length); // 无重复
    for (const operation of MANIFEST.operations) {
      expect(names.filter((name) => name === workerOperationToolName(operation.name))).toHaveLength(1);
    }
    expect(names).not.toContain('execute_operation');
  });

  it('③b 工具描述只用 label + 一句「参数按声明填」，不含实现字样', () => {
    for (const tool of workerOperationTools(MANIFEST)) {
      expect(tool.description).toContain('参数按声明填');
      for (const word of ['--', 'style', 'weight', 'effects', 'long_running']) {
        expect(tool.description, `${tool.name} 描述不得含 ${word}`).not.toContain(word);
      }
    }
  });
});

describe('动态 Worker 工具面：调用映射', () => {
  const prepare = MANIFEST.operations.find((operation) => operation.name === 'dummy.prepare')!;
  const commit = MANIFEST.operations.find((operation) => operation.name === 'dummy.commit')!;

  it('④ 业务字段名映射回执行层参数名；count 从 records 条数自算，模型值被忽略（反向绊线：去掉宿主演算 → 红）', () => {
    const mapped = mapWorkerOperationArgs({
      operation: prepare,
      args: { collection: 'alpha', window: 'W1', count: 99, records: [{ name: 'a', value: 1 }, { name: 'b', value: 2 }] },
    });
    expect(mapped).toMatchObject({
      '--collection': 'alpha',
      '--window': 'W1',
      records: [{ name: 'a', value: 1 }, { name: 'b', value: 2 }],
      '--count': 2, // 不是模型的 99
    });
    expect(mapped['count']).toBeUndefined();
  });

  it('④b 确认哨兵由宿主注入，模型传值被覆盖（反向绊线：去掉确认注入 → 红）', () => {
    const mapped = mapWorkerOperationArgs({
      operation: commit,
      args: { collection: 'alpha', '--confirmation': 'cf_ATTACK' },
      confirmationHandle: 'cf_REAL',
    });
    expect(mapped['--confirmation']).toBe('cf_REAL');
    expect(mapped).not.toContain('cf_ATTACK');
  });

  it('④c 裸名机制参数（如 seconds/apply/count）不可透传——模型只能看到业务字段名', () => {
    const mapped = mapWorkerOperationArgs({
      operation: commit,
      args: { collection: 'alpha', confirmation: 'cf_BARE', count: 99, fail_index: 1 },
    });
    expect(mapped).toEqual({ '--collection': 'alpha' });
  });
});

describe('动态 Worker 工具面：委派清单同步去前缀/去机制参数', () => {
  it('⑤ workerDelegationManifest 同样只留业务字段名、去 hostOnly', () => {
    const projected = workerDelegationManifest(MANIFEST);
    const prepare = projected.operations.find((operation) => operation.name === 'dummy.prepare')!;
    expect(prepare.args.map((arg) => arg.name)).toEqual(['collection', 'window', 'records']);
    for (const operation of projected.operations) {
      for (const arg of operation.args) {
        expect(arg.name).not.toContain('--');
      }
    }
  });
});
