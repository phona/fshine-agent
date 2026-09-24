import { describe, expect, it } from 'vitest';
import { renderMemoryProjection, type MemoryRecord } from './src/memory-records';

const row = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  memoryId: 'm1',
  principalId: 'p1',
  key: 'response_style',
  type: 'preference',
  content: '用中文简洁回答',
  status: 'active',
  sourceEventIds: ['e1'],
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('MEMORY.md projection', () => {
  it('is a deterministic projection of active and conflicting records with provenance', () => {
    const a = row();
    const b = row({ memoryId: 'm2', key: 'timezone', type: 'fact', content: 'Asia/Shanghai', sourceEventIds: ['e2'] });
    expect(renderMemoryProjection([b, a])).toBe(renderMemoryProjection([a, b]));
    expect(renderMemoryProjection([a, b])).toContain('用中文简洁回答');
    expect(renderMemoryProjection([a, b])).toContain('e1');
  });

  it('does not inject superseded, deleted, or conflicted records into the active projection', () => {
    const markdown = renderMemoryProjection([
      row({ memoryId: 'old', content: '旧偏好', status: 'superseded' }),
      row({ memoryId: 'gone', content: '已删除事实', status: 'deleted' }),
      row({ memoryId: 'conflict', key: 'response_style', content: '用英文回答', status: 'conflicted', sourceEventIds: ['e9'] }),
      row({ memoryId: 'active', key: 'timezone', type: 'fact', content: 'Asia/Shanghai' }),
    ]);
    expect(markdown).not.toContain('旧偏好');
    expect(markdown).not.toContain('已删除事实');
    expect(markdown).not.toContain('冲突待确认');
    expect(markdown).not.toContain('用英文回答');
    expect(markdown).toContain('Asia/Shanghai');
  });

  it('escapes markdown supplied by user content', () => {
    const markdown = renderMemoryProjection([row({ content: '](/unsafe)\n# injected heading' })]);
    expect(markdown).not.toContain('\n# injected heading');
    expect(markdown).toContain('\\# injected heading');
  });
});
