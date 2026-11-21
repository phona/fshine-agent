/**
 * 能力目录派生守卫（判据档 §2 / 本切片 A3·G1）：目录必须完全由 operation 声明派生，
 * 没有任何手写业务名常量表。每条断言在「故意破坏」时必须红。
 */
import { describe, expect, it } from 'vitest';
import {
  deriveCapabilityCatalog,
  renderCapabilitySummary,
  type CapabilityEntry,
} from './src/capability-catalog';
import type { RawGatewayOperation } from './src/dummy-cli-client';

function op(name: string, access: 'read' | 'write' | 'scratch', capability?: string): RawGatewayOperation {
  return { name, access, ...(capability === undefined ? {} : { capability }) };
}

describe('能力目录派生（单一来源，无手写清单）', () => {
  it('① 空清单 → 空目录（没有任何硬编码业务名漏出来）', () => {
    expect(deriveCapabilityCatalog([])).toEqual([]);
  });

  it('② 全部 operation 未声明 capability → 空目录 + 空摘要（退化为现状）', () => {
    const ops = [op('a.query', 'read'), op('a.commit', 'write')];
    expect(deriveCapabilityCatalog(ops)).toEqual([]);
    expect(renderCapabilitySummary(deriveCapabilityCatalog(ops))).toBe('');
  });

  it('③ 同 capability 的 query/prepare/commit 合并为一项，read/write 取并集', () => {
    const ops = [
      op('dummy.query', 'read', '记录办理'),
      op('dummy.prepare', 'write', '记录办理'),
      op('dummy.commit', 'write', '记录办理'),
    ];
    expect(deriveCapabilityCatalog(ops)).toEqual([{ name: '记录办理', read: true, write: true }]);
  });

  it('④ 给清单加一个带新 capability 的 operation → 目录多一条（证明是派生的）', () => {
    const base = [op('dummy.query', 'read', '记录办理')];
    const before = deriveCapabilityCatalog(base);
    const after = deriveCapabilityCatalog([...base, op('new.export', 'write', '全新能力')]);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
    expect(after).toContainEqual({ name: '全新能力', read: false, write: true });
  });

  it('⑤ 只读能力只读标记、仅写能力写标记，互不串味（复用 access 派生）', () => {
    const ops = [
      op('a.query', 'read', '只读核对'),
      op('a.export', 'write', '长时导出'),
      op('a.local', 'scratch', '本地计算'),
    ];
    expect(deriveCapabilityCatalog(ops)).toEqual([
      { name: '只读核对', read: true, write: false },
      { name: '长时导出', read: false, write: true },
      // scratch 既不是 read 也不是 write → 两项皆 false（不冒充读写）。
      { name: '本地计算', read: false, write: false },
    ]);
  });

  it('⑥ 摘要只含业务名与读/写标记，不含 operation 名、不含 --、不含参数名', () => {
    const entries: CapabilityEntry[] = [
      { name: '记录办理', read: true, write: true },
      { name: '长时导出', read: false, write: true },
      { name: '只读核对', read: true, write: false },
    ];
    const summary = renderCapabilitySummary(entries);
    expect(summary).toBe('可办：记录办理（含写入）、长时导出（写入）、只读核对');
    expect(summary).not.toContain('dummy.');
    expect(summary).not.toContain('--');
    expect(summary).not.toContain('collection');
  });
});
