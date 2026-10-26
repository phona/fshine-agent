import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AuditStore, SessionArtifactRecord } from '@fshine/contracts';
import {
  artifactManifestText,
  artifactSessionDir,
  artifactStoredName,
  evictOverCapArtifacts,
  formatArtifactTime,
  ingestArtifacts,
  nextArtifactRef,
  resolveResendRefs,
  rewriteArtifactRefs,
} from './artifact-store';
import * as artifactStoreModule from './artifact-store';

/** 内存版 sessionArtifacts repo：行为对齐 core store 的排序与 upsert 语义。 */
function fakeArtifactStore(): {
  rows: Map<string, SessionArtifactRecord>;
  repo: NonNullable<import('@fshine/contracts').AuditStore['sessionArtifacts']>;
} {
  const rows = new Map<string, SessionArtifactRecord>();
  return {
    rows,
    repo: {
      insert: async (record) => { rows.set(`${record.sessionId}:${record.ref}`, record); },
      listBySession: async (sessionId) =>
        [...rows.values()]
          .filter((record) => record.sessionId === sessionId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || Number(a.ref) - Number(b.ref)),
      get: async (sessionId, ref) => rows.get(`${sessionId}:${ref}`) ?? null,
      setStatus: async (sessionId, ref, status) => {
        const found = rows.get(`${sessionId}:${ref}`);
        if (found) rows.set(`${sessionId}:${ref}`, { ...found, status });
      },
    },
  };
}

describe('artifact-store 纯函数', () => {
  it('会话目录对 sessionId 编码（冒号不落盘、不同会话不撞车）', () => {
    expect(artifactSessionDir('/data', 'wecom:chat_1')).toBe(path.join('/data', 'sessions', 'wecom%3Achat_1', 'artifacts'));
    expect(artifactSessionDir('/data', 'wecom:a:b')).not.toBe(artifactSessionDir('/data', 'wecom:a_b'));
  });

  it('库内文件名拍平路径分隔符', () => {
    expect(artifactStoredName('3', '工资表.xlsx')).toBe('3__工资表.xlsx');
    expect(artifactStoredName('3', '../escape.xlsx')).toBe('3__.._escape.xlsx');
  });

  it('ref 会话内单调：空表从 1，非数字不参与最大值', () => {
    expect(nextArtifactRef([])).toBe('1');
    expect(nextArtifactRef([{ ref: '1' }, { ref: '7' }, { ref: 'x' }] as SessionArtifactRecord[])).toBe('8');
  });

  it('时间一律显式 UTC+8（库存 UTC，防模型复述裸 UTC）', () => {
    expect(formatArtifactTime('2026-10-20T07:03:35.876Z')).toBe('2026-10-20 15:03 UTC+8');
    expect(formatArtifactTime('not-a-time')).toBe('not-a-time');
  });

  it('清单按登记语义措辞（D-127）：不宣称"已交付"，且说明可经重发获取', () => {
    const text = artifactManifestText([
      { ref: '1', sessionId: 's', filename: '工资表.xlsx', sha256: 'a', size: 1, createdAt: '2026-10-20T07:03:35.876Z', status: 'available', path: '/p' },
    ]);
    // 产物 staged 即入清单，清单不知道投递成败——措辞必须停在"已保存"这一事实，
    // 不能替模型说出"已发过"（交付失败/崩溃后那句就是假陈述）。
    expect(text).toContain('【本会话已保存的产物】');
    expect(text).toContain('重发');
    expect(text).not.toContain('已交付');
  });

  it('清单行首用 # 不用 -（不污染附件交付集的 "- " 行解析）', () => {
    const text = artifactManifestText([
      { ref: '1', sessionId: 's', filename: '工资表.xlsx', sha256: 'a', size: 1, createdAt: '2026-10-20T07:03:35.876Z', status: 'available', path: '/p' },
    ]);
    expect(text).toContain('#1 工资表.xlsx（2026-10-20 15:03 UTC+8）');
    expect(text.split('\n').some((line) => line.startsWith('- '))).toBe(false);
  });

  it('空清单返回空串；evicted 条目列出但标注已淘汰', () => {
    expect(artifactManifestText([])).toBe('');
    const text = artifactManifestText([
      { ref: '2', sessionId: 's', filename: '旧表.xlsx', sha256: 'a', size: 1, createdAt: '2026-10-19T08:24:50.000Z', status: 'evicted', path: '/p' },
    ]);
    expect(text).toContain('#2 旧表.xlsx');
    expect(text).toContain('已淘汰');
  });

  it('ref 改写只换来源路径，空映射原样返回', () => {
    const record = { ref: '4', filename: '个税申报.xlsx' } as SessionArtifactRecord;
    const map = new Map([['/platform/tmp/task_x/个税申报.xlsx', record]]);
    expect(rewriteArtifactRefs('文件在 /platform/tmp/task_x/个税申报.xlsx，请查收', map))
      .toBe('文件在 会话产物 #4（个税申报.xlsx），请查收');
    expect(rewriteArtifactRefs('没有路径的文本', new Map())).toBe('没有路径的文本');
    expect(rewriteArtifactRefs('', map)).toBe('');
  });
});

// ── 「本轮回传：…」收据行的单一权威（D-128）──────────────────────────────────────
// 同一事实（本回合点名回传了哪些文件）此前在 artifact-store（不带 ref）与
// background-delivery（带 #ref）各有一份格式化逻辑，措辞必须只有一个权威位置——
// 与 formatFileReceipt 立过的纪律同源。两道锁：① 字面量只允许出现在权威函数所在文件；
// ② 权威函数同时支持带/不带 ref 两种形态（差异是数据参数，不是第二份措辞）。
describe('收据行单一权威（D-128）', () => {
  it('「本轮回传」字面量只允许出现在 artifact-store.ts（权威位置唯一）', () => {
    // 只认**构造点**（字符串/模板字面量开头的措辞），注释里的提及不算第二权威。
    const offenders: string[] = [];
    for (const entry of readdirSync(__dirname)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      if (readFileSync(path.join(__dirname, entry), 'utf-8').match(/['"`]本轮回传/)) offenders.push(entry);
    }
    expect(offenders, `「本轮回传」的构造点出现在了 ${offenders.join('、')}——收据措辞只允许一个权威位置`).toEqual(['artifact-store.ts']);
  });

  it('权威函数存在且两种形态的 golden 文案不变（带/不带 ref 都是参数）', () => {
    const receipt = (artifactStoreModule as { fileReturnReceipt?: (entries: ReadonlyArray<{ filename: string; ref?: string }>) => string }).fileReturnReceipt;
    expect(typeof receipt, 'artifact-store 未导出收据权威函数 fileReturnReceipt').toBe('function');
    // 不带 ref：inline 回合收口的既有 golden（handler.test 多处按此断言，此处钉源头）。
    expect(receipt!([{ filename: '整理好的2026年08月工资表.xlsx' }])).toBe('本轮回传：整理好的2026年08月工资表.xlsx');
    // 带 ref：后台交付点名的既有形态（#ref 文件名），多文件以顿号连接。
    expect(receipt!([{ filename: '汇总.xlsx', ref: '1' }, { filename: '明细.xlsx', ref: '2' }])).toBe('本轮回传：#1 汇总.xlsx、#2 明细.xlsx');
    // 混合：同一段里既有登记产物又有未登记字节（登记缺失时退回裸文件名）。
    expect(receipt!([{ filename: '汇总.xlsx', ref: '1' }, { filename: 'extra.xlsx' }])).toBe('本轮回传：#1 汇总.xlsx、extra.xlsx');
  });
});

describe('ingestArtifacts', () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
  const freshRoot = (): string => {
    const root = mkdtempSync(path.join(tmpdir(), 'artifact-ingest-'));
    roots.push(root);
    return root;
  };

  it('入库：复制字节、批内 ref 递增、bySourcePath 可做改写', async () => {
    const root = freshRoot();
    const { repo, rows } = fakeArtifactStore();
    const outcome = await ingestArtifacts({
      candidates: [
        { data: Buffer.from('OLD'), filename: '工资表.xlsx', sourcePath: '/tmp/task_x/工资表.xlsx' },
        { data: Buffer.from('TAX'), filename: '个税申报.xlsx', sourcePath: '/tmp/task_x/个税申报.xlsx' },
      ],
      sessionId: 'wecom:chat_1',
      dataRoot: root,
      store: { sessionArtifacts: repo },
      requestId: 'req_1',
      sourceTaskId: 'task_x',
      now: '2026-10-20T07:03:35.876Z',
    });

    expect(outcome.records.map((r) => r.ref)).toEqual(['1', '2']);
    expect(rows.size).toBe(2);
    // 字节真的落在库里（不是 scratch 的同一份）
    expect(readFileSync(path.join(artifactSessionDir(root, 'wecom:chat_1'), '1__工资表.xlsx')).toString()).toBe('OLD');
    expect(outcome.records[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.records[0]?.sourceTaskId).toBe('task_x');
    expect(outcome.bySourcePath.get('/tmp/task_x/个税申报.xlsx')?.ref).toBe('2');
  });

  it('跨批次 ref 继续递增（第二批从 3 开始）', async () => {
    const root = freshRoot();
    const { repo } = fakeArtifactStore();
    const first = await ingestArtifacts({
      candidates: [{ data: Buffer.from('A'), filename: 'a.xlsx' }],
      sessionId: 'wecom:chat_1',
      dataRoot: root,
      store: { sessionArtifacts: repo },
      now: '2026-10-20T07:00:00.000Z',
    });
    const second = await ingestArtifacts({
      candidates: [{ data: Buffer.from('B'), filename: 'b.xlsx' }],
      sessionId: 'wecom:chat_1',
      dataRoot: root,
      store: { sessionArtifacts: repo },
      now: '2026-10-20T08:00:00.000Z',
    });
    expect(first.records[0]?.ref).toBe('1');
    expect(second.records[0]?.ref).toBe('2');
  });

  it('repo 缺失（旧替身/旧部署）时静默 no-op，不抛', async () => {
    const root = freshRoot();
    const outcome = await ingestArtifacts({
      candidates: [{ data: Buffer.from('A'), filename: 'a.xlsx' }],
      sessionId: 'wecom:chat_1',
      dataRoot: root,
      store: {},
      now: '2026-10-20T07:00:00.000Z',
    });
    expect(outcome.records).toEqual([]);
    expect(outcome.bySourcePath.size).toBe(0);
  });

  it('空候选直接返回，不建目录不写库', async () => {
    const root = freshRoot();
    const { repo, rows } = fakeArtifactStore();
    const outcome = await ingestArtifacts({
      candidates: [],
      sessionId: 'wecom:chat_1',
      dataRoot: root,
      store: { sessionArtifacts: repo },
      now: '2026-10-20T07:00:00.000Z',
    });
    expect(outcome.records).toEqual([]);
    expect(rows.size).toBe(0);
  });
});

describe('evictOverCapArtifacts（W5 淘汰：显式 + 最旧优先 + 新批保护）', () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
  const freshRoot = (): string => {
    const root = mkdtempSync(path.join(tmpdir(), 'artifact-evict-'));
    roots.push(root);
    return root;
  };

  /** 灌一条记录（真实字节落盘；size 可虚拟——淘汰账按 record.size 走）。 */
  const seed = async (
    repo: NonNullable<AuditStore['sessionArtifacts']>,
    root: string,
    ref: string,
    opts: { size?: number; status?: 'available' | 'evicted'; atMs: number },
  ): Promise<void> => {
    const p = path.join(root, `${ref}.bin`);
    writeFileSync(p, `DATA-${ref}`);
    await repo.insert({
      ref,
      sessionId: 's',
      filename: `${ref}.bin`,
      sha256: 'x',
      size: opts.size ?? 6,
      createdAt: new Date(opts.atMs).toISOString(),
      status: opts.status ?? 'available',
      path: p,
    });
  };

  it('超数量上限：最旧的先淘汰（status=evicted + 字节删）', async () => {
    const root = freshRoot();
    const { repo, rows } = fakeArtifactStore();
    for (let i = 1; i <= 51; i += 1) await seed(repo, root, String(i), { atMs: 1_700_000_000_000 + i * 1000 });
    const evicted = await evictOverCapArtifacts({ store: { sessionArtifacts: repo }, sessionId: 's' });
    expect(evicted).toEqual(['1']);                                   // 51 - 50，只淘汰最旧 1 条
    expect(rows.get('s:1')?.status).toBe('evicted');
    expect(existsSync(path.join(root, '1.bin'))).toBe(false);         // 字节删掉
    expect(rows.get('s:2')?.status).toBe('available');
  });

  it('freshRefs 永不淘汰：超量时动旧文件，不动刚交付的', async () => {
    const root = freshRoot();
    const { repo, rows } = fakeArtifactStore();
    for (let i = 1; i <= 51; i += 1) await seed(repo, root, String(i), { atMs: 1_700_000_000_000 + i * 1000 });
    const evicted = await evictOverCapArtifacts({ store: { sessionArtifacts: repo }, sessionId: 's', freshRefs: ['51'] });
    expect(evicted).toEqual(['1']);
    expect(rows.get('s:51')?.status).toBe('available');               // 刚入库的不动
  });

  it('freshRefs 永不淘汰（结构性场景）：全部是新批时一条都不动', async () => {
    const root = freshRoot();
    const { repo, rows } = fakeArtifactStore();
    // 60 条全部算本批新入库：超上限 10 条，但候选一条都不能是 fresh。最旧优先的
    // 排序下，守卫只有"新批本身超上限"才可触达——这正是要钉住的形状（删守卫 →
    // 最旧 10 条被误淘汰 → 本用例红）。
    const refs: string[] = [];
    for (let i = 1; i <= 60; i += 1) {
      refs.push(String(i));
      await seed(repo, root, String(i), { atMs: 1_700_000_000_000 + i * 1000 });
    }
    const evicted = await evictOverCapArtifacts({ store: { sessionArtifacts: repo }, sessionId: 's', freshRefs: refs });
    expect(evicted).toEqual([]);
    expect(rows.get('s:1')?.status).toBe('available');
  });
  it('已淘汰条目不占名额：50 available + 10 evicted 不触发新淘汰', async () => {
    const root = freshRoot();
    const { repo } = fakeArtifactStore();
    for (let i = 1; i <= 50; i += 1) await seed(repo, root, String(i), { atMs: 1_700_000_000_000 + i * 1000 });
    for (let i = 51; i <= 60; i += 1) await seed(repo, root, String(i), { atMs: 1_700_000_100_000 + i * 1000, status: 'evicted' });
    const evicted = await evictOverCapArtifacts({ store: { sessionArtifacts: repo }, sessionId: 's' });
    expect(evicted).toEqual([]);
  });

  it('字节闸也生效：虚拟大文件超总字节上限时最旧的先走', async () => {
    const root = freshRoot();
    const { repo, rows } = fakeArtifactStore();
    // 两条 300MB（size 虚拟，真实文件极小）——总和 600MB > 512MB 闸
    await seed(repo, root, '1', { size: 300 * 1024 * 1024, atMs: 1_700_000_000_000 });
    await seed(repo, root, '2', { size: 300 * 1024 * 1024, atMs: 1_700_000_001_000 });
    const evicted = await evictOverCapArtifacts({ store: { sessionArtifacts: repo }, sessionId: 's' });
    expect(evicted).toEqual(['1']);
    expect(rows.get('s:1')?.status).toBe('evicted');
    expect(rows.get('s:2')?.status).toBe('available');
  });

  it('repo 缺失（旧替身/旧部署）时静默 no-op', async () => {
    expect(await evictOverCapArtifacts({ store: {}, sessionId: 's' })).toEqual([]);
  });
});

// ── resolveResendRefs 读回校验（对照 loadTaskArtifactFiles 的纪律：损坏的库文件
// 不当作字节还在的样子发出；tests/e2e/turn-loop-resend 的假 seed 曾因此逍遥）────────
describe('resolveResendRefs（重发读回校验）', () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
  const freshRoot = (): string => {
    const root = mkdtempSync(path.join(tmpdir(), 'artifact-resend-'));
    roots.push(root);
    return root;
  };

  function sha256Of(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  /** 落一份真实字节的产物；overrides 可篡改登记的 sha256/size 或盘上字节。 */
  async function seedOne(
    repo: NonNullable<AuditStore['sessionArtifacts']>,
    root: string,
    ref: string,
    overrides: { registeredSha256?: string; registeredSize?: number; diskBytes?: Buffer } = {},
  ): Promise<void> {
    const bytes = overrides.diskBytes ?? Buffer.from('REAL-XLSX-BYTES');
    const file = path.join(root, `${ref}__工资表.xlsx`);
    writeFileSync(file, bytes);
    await repo.insert({
      ref,
      sessionId: 's',
      filename: '工资表.xlsx',
      sha256: overrides.registeredSha256 ?? sha256Of(bytes),
      size: overrides.registeredSize ?? bytes.length,
      createdAt: '2026-10-20T07:03:35.876Z',
      status: 'available',
      path: file,
    });
  }

  it('完好产物：真实 sha256/size 对得上 → 发出并给出带出处的 note', async () => {
    const root = freshRoot();
    const { repo } = fakeArtifactStore();
    await seedOne(repo, root, '1');
    const out = await resolveResendRefs({ sessionArtifacts: repo } as AuditStore, 's', ['1']);
    expect(out.files).toHaveLength(1);
    expect(out.files[0]?.data.toString()).toBe('REAL-XLSX-BYTES');
    expect(out.notes[0]).toContain('#1 工资表.xlsx');
    expect(out.failures).toEqual([]);
  });

  it('盘上字节被篡改（sha256 不符）→ 不发出、failure 文案、留 artifact_resend_corrupt 痕', async () => {
    const root = freshRoot();
    const { repo } = fakeArtifactStore();
    // 登记的是 REAL 字节的哈希，盘上被换成了别的字节。
    await seedOne(repo, root, '2', { diskBytes: Buffer.from('REAL-XLSX-BYTES'), registeredSha256: sha256Of(Buffer.from('OTHER-BYTES')) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await resolveResendRefs({ sessionArtifacts: repo } as AuditStore, 's', ['2']);
      expect(out.files).toEqual([]);                                 // 坏文件不发出
      expect(out.failures).toEqual(['产物 #2 的文件已损坏，需要重新计算']);
      const traces = warn.mock.calls.map((call) => String(call[0]));
      expect(traces.some((line) => line.includes('"event":"artifact_resend_corrupt"') && line.includes('"ref":"2"'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('长度不符（size 谎报）→ 同样不发出（假 seed 的形态：size 11 但字节只有 10）', async () => {
    const root = freshRoot();
    const { repo } = fakeArtifactStore();
    const bytes = Buffer.from('XLSX-BYTES');
    await seedOne(repo, root, '3', { registeredSha256: sha256Of(bytes), registeredSize: bytes.length + 1 });
    const out = await resolveResendRefs({ sessionArtifacts: repo } as AuditStore, 's', ['3']);
    expect(out.files).toEqual([]);
    expect(out.failures).toEqual(['产物 #3 的文件已损坏，需要重新计算']);
  });

  it('文件缺失（记录在、字节不在）→ 既有"已不在"文案，不误报损坏', async () => {
    const root = freshRoot();
    const { repo } = fakeArtifactStore();
    await seedOne(repo, root, '4');
    rmSync(path.join(root, '4__工资表.xlsx'));
    const out = await resolveResendRefs({ sessionArtifacts: repo } as AuditStore, 's', ['4']);
    expect(out.files).toEqual([]);
    expect(out.failures).toEqual(['产物 #4 的文件已不在，需要重新计算']);
  });
});
