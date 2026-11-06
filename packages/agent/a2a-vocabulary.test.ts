import { readFileSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  A2A_PROTOCOL_VERSION,
  FAILURE_CLASS_POLICIES,
  type CapabilityManifest,
  type DelegationBlock,
  type FailureClass,
  type OperationDeclaration,
  type StructuredCall,
} from '@fshine/contracts';

/**
 * A2A 契约词汇守卫（W5 C2 落地）。
 *
 * 两条纪律钉死：
 *   1. **契约工件纯度**（a2a-protocol.md 参与方表规则 + guard-contract-purity）：
 *      packages/contracts/src/a2a-protocol.ts 零网关名、零脚本路径、零业务字段——
 *      协议词汇只认 operation、委派块、裁决状态、失败分类这些通用概念；
 *   2. **清单不落文件**（guard-manifest-not-file-read）：CapabilityManifest 只作
 *      `<gateway> operation list --json` 的消费投影，宿主不缓存、不复制、不另立
 *      名单（L2）；operations.json 字面量不得出现在 packages/apps/scripts 的非测试
 *      .ts（platform-leak-lint 的 FORBIDDEN 模式，字面量出现即泄漏）。
 *
 * 另钉 C2 的**零行为变化**：新增的 OperationDeclaration / CapabilityManifest /
 * StructuredCall 是纯类型（编译期存在，运行时无值），既有六个 export 的形状不变。
 */

const CONTRACTS_DIR = join(__dirname, '..', 'contracts', 'src');
const REPO_ROOT = join(__dirname, '..', '..');

/** 契约工件禁入模式：网关名/脚本路径/业务字段（guard-contract-purity 判据的机械面）。 */
const FORBIDDEN_IN_CONTRACT = ['bin/', '17dz', '应收', '凭证', '科目', '账套', '期间', 'operations.json'];

/** 非测试 .ts 里不得出现平台内部清单文件字面量（guard-manifest-not-file-read）。 */
const FORBIDDEN_MANIFEST_FILE = 'operations.json';

/**
 * 泄漏 lint 白名单（platform-leak-lint.test.ts 的 ALLOWLIST，同纪律不重抄第二份）：
 * packages/agent/src/platform-contract.ts 是唯一允许出现平台实现细节的适配层，
 * 其**注释**引用 operations.json 注册名是合法形态。方案的机械判据（git grep 命中=0）
 * 漏了这条例外——本守卫按 leak-lint 的白名单执行，否则基线即红。
 */
const LEAK_LINT_ALLOWLIST = new Set([
  join(REPO_ROOT, 'packages', 'agent', 'src', 'platform-contract.ts'),
]);

function srcOf(...segments: string[]): string {
  return readFileSync(join(...segments), 'utf8');
}

describe('a2a 契约词汇纯度', () => {
  const contractSrc = srcOf(CONTRACTS_DIR, 'a2a-protocol.ts');

  it('契约工件零网关名/脚本路径/业务字段', () => {
    for (const pattern of FORBIDDEN_IN_CONTRACT) {
      expect(contractSrc, `契约工件含禁入模式：${pattern}`).not.toContain(pattern);
    }
  });

  it('新增三类型是纯类型声明（运行时零值，零行为变化）', () => {
    // 只作类型存在性断言：接口在编译后不存在于运行时。
    const manifest: CapabilityManifest = {
      version: A2A_PROTOCOL_VERSION,
      operations: [
        {
          operation: 'demo.read',
          requiresPlan: false,
          effects: ['read'],
          estSeconds: 5,
          label: '演示读',
          serveMatrix: ['default'],
        },
      ],
    };
    const call: StructuredCall = { operation: 'demo.read', args: { query: 'x' } };
    const declaration: OperationDeclaration = manifest.operations[0]!;
    expect(declaration.operation).toBe('demo.read');
    expect(declaration.requiresPlan).toBe(false);
    expect(call.args).toEqual({ query: 'x' });
    expect(manifest.version).toBe('1.0');
  });

  it('既有词汇形状不变：协议版本 / 失败五类 / 委派块五字段', () => {
    expect(A2A_PROTOCOL_VERSION).toBe('1.0');
    const classes = Object.keys(FAILURE_CLASS_POLICIES).sort();
    expect(classes).toEqual([
      'CAPABILITY_UNAVAILABLE',
      'HARD_REJECTED',
      'NEEDS_INPUT',
      'PLATFORM_ERROR',
      'RESOURCE_EXHAUSTED',
    ]);
    // Record<FailureClass, …> 穷举：五类各有三义务字段。
    for (const policy of Object.values(FAILURE_CLASS_POLICIES)) {
      expect(typeof policy.judgedBy).toBe('string');
      expect(typeof policy.workerDuty).toBe('string');
      expect(typeof policy.hostDelivery).toBe('string');
    }
    const block: DelegationBlock = {
      request: 'r',
      entities: ['e'],
      workspace: 'w',
      inputs: ['i'],
      protocolVersion: A2A_PROTOCOL_VERSION,
    };
    expect(Object.keys(block).sort()).toEqual(['entities', 'inputs', 'protocolVersion', 'request', 'workspace']);
  });

  it('失败五类是互斥词汇（类型即断言，无第六类）', () => {
    const all: readonly FailureClass[] = [
      'NEEDS_INPUT',
      'CAPABILITY_UNAVAILABLE',
      'PLATFORM_ERROR',
      'RESOURCE_EXHAUSTED',
      'HARD_REJECTED',
    ];
    expect(all).toHaveLength(5);
    expect(new Set(all).size).toBe(5);
  });
});

describe('能力清单不落文件（L2 单一来源）', () => {
  it('packages/apps/scripts 的非测试 .ts 零 operations.json 字面量（白名单模块除外）', () => {
    const offenders: string[] = [];
    for (const dir of ['packages', 'apps', 'scripts']) {
      walk(join(REPO_ROOT, dir), (file) => {
        if (!file.endsWith('.ts') || file.endsWith('.test.ts')) return;
        if (LEAK_LINT_ALLOWLIST.has(file)) return;
        if (srcOf(file).includes(FORBIDDEN_MANIFEST_FILE)) offenders.push(file);
      });
    }
    expect(offenders, `非测试 .ts 出现清单文件字面量：${offenders.join(', ')}`).toEqual([]);
  });

  it('契约工件自身也不许引用清单文件路径', () => {
    expect(srcOf(CONTRACTS_DIR, 'a2a-protocol.ts')).not.toContain(FORBIDDEN_MANIFEST_FILE);
  });
});

/** 递归收集目录下所有文件路径（守卫自校验：目录缺失即红，不静默跳过）。 */
function walk(dir: string, visit: (file: string) => void): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new Error(`a2a-vocabulary 守卫：目录不存在或不可读：${dir}`);
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, visit);
    } else if (entry.isFile()) {
      visit(full);
    }
  }
}
