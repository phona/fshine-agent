import type { MemoryRecordRecord, MemoryRecordStatus, MemoryRecordType } from '@fshine/contracts';

/** Durable, provenance-bearing long-term memory rows. MEMORY.md is only a projection. */
export type { MemoryRecordStatus, MemoryRecordType };
export type MemoryRecord = MemoryRecordRecord;

/** Render a disposable Markdown view. This accepts records, never prior rendered text. */
export function renderMemoryProjection(records: readonly MemoryRecord[]): string {
  const visible = records
    // Only trusted active facts are injected through MEMORY.md. Conflicts stay in
    // the durable records for review, but must not steer subsequent model turns.
    .filter((record) => record.status === 'active')
    .slice()
    .sort((a, b) => a.type.localeCompare(b.type) || a.key.localeCompare(b.key) || a.memoryId.localeCompare(b.memoryId));
  if (!visible.length) return '# Memory\n\n';

  const lines = ['# Memory', ''];
  for (const record of visible) {
    const label = record.type === 'preference' ? '偏好' : '事实';
    lines.push(`- **${label} · ${escapeMarkdown(record.key)}**：${escapeMarkdown(record.content)} _(来源: ${record.sourceEventIds.map(escapeMarkdown).join(', ')}; v${record.version})_`);
  }
  return `${lines.join('\n')}\n`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}
