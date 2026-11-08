/**
 * 验收报告收集的形状兼容（PR #21 十审 minor 的回归锁）。
 *
 * acceptance.ts 自 L7 起写出 `{records, writeChain, auditPath}` 对象，而收集侧旧写法只认
 * 顶层数组——于是当前生成的报告全被静默跳过、台账显示"无数据"，明明有记录却读不到。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectAcceptanceFiles } from './case-ledger';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function dir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'case-ledger-'));
  roots.push(d);
  return d;
}

describe('collectAcceptanceFiles：两种报告根形状都收（十审 minor）', () => {
  it('L7 起的对象形状 {records, writeChain, auditPath}', async () => {
    const d = dir();
    writeFileSync(path.join(d, 'acceptance-report-20261109.json'), JSON.stringify({
      records: [{ id: '5.1', ok: true }, { id: '5.2', ok: false }],
      writeChain: [],
      auditPath: '/tmp/a.jsonl',
    }));
    const rows = await collectAcceptanceFiles(d);
    expect(rows.map((r) => r.id)).toEqual(['5.1', '5.2']);
  });

  it('L7 之前的裸数组形状仍收（向后兼容）', async () => {
    const d = dir();
    writeFileSync(path.join(d, 'acceptance-report-20261001.json'), JSON.stringify([{ id: '1.1' }, { id: '1.2' }]));
    const rows = await collectAcceptanceFiles(d);
    expect(rows.map((r) => r.id)).toEqual(['1.1', '1.2']);
  });

  it('非 acceptance-report-* 的文件与坏 JSON 都跳过，不抛', async () => {
    const d = dir();
    writeFileSync(path.join(d, 'probe-x.json'), JSON.stringify([{ id: 'p' }]));
    writeFileSync(path.join(d, 'acceptance-report-broken.json'), '{not json');
    const rows = await collectAcceptanceFiles(d);
    expect(rows).toEqual([]);
  });

  it('对象形状但 records 不是数组 → 跳过（不猜）', async () => {
    const d = dir();
    writeFileSync(path.join(d, 'acceptance-report-weird.json'), JSON.stringify({ writeChain: [] }));
    expect(await collectAcceptanceFiles(d)).toEqual([]);
  });
});
