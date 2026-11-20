/**
 * 用户可见文本「内部词」通用守卫的绊线（scripts/eval/shared/internal-terms.test.ts）。
 *
 * 两部分：
 *   ① 匹配器单测：正常文本零命中；「执行层确认过了。」命中 marker 执行层；反向绊线直接可验
 *      （改词表 / 改 findLiteralHits / 改 excerpt 半径，本组用例即红）。
 *   ② 静态守卫：一份**显式文件清单**（write-loop / write-loop-scenarios / convergence-r1 runner
 *      + live-replay）逐个断言文件里确实调用了扫描；并用 glob 枚举
 *      `scripts/eval/real/write-loop*.ts` 与 `scripts/eval/convergence-r1/runner.ts`，断言这些文件
 *      都在清单里——新增批次忘了接入会红，删掉调用也会红。
 *
 * 亲跑验证（红→绿）：临时注释掉某入口的扫描调用，静态守卫必红；恢复即绿。读数见交付报告。
 */
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findLiteralHits, INTERNAL_WORDS, scanUserVisibleText } from './internal-terms';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function repo(relative: string): string {
  return path.join(REPO_ROOT, relative);
}

// ---------------------------------------------------------------------------
// ① 匹配器单测
// ---------------------------------------------------------------------------

describe('内部词匹配器', () => {
  it('INTERNAL_WORDS 逐字冻结（改一个词即红；单一来源）', () => {
    expect(INTERNAL_WORDS).toEqual([
      '执行层', '执行端', '确认凭据', 'dispatchKey', '长时运行', '能力快照', '宿主运行时',
    ]);
  });

  it('正常文本零命中', () => {
    expect(scanUserVisibleText([
      { where: '回合1 回复', text: '好的，已经办完了，empty-one 的 W1 有 4 条记录。' },
      { where: '主动投递', text: '办好了：你要的那件事。' },
    ]).hits).toEqual([]);
  });

  it('「执行层确认过了。」命中 marker=执行层', () => {
    const { hits } = scanUserVisibleText([{ where: '回合2 回复', text: '执行层确认过了。' }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ where: '回合2 回复', marker: '执行层' });
    // 原文片段含命中词本身（excerpt 不是空、不是别的句子）。
    expect(hits[0]!.excerpt).toContain('执行层');
  });

  it('findLiteralHits：同标记多次命中逐个记录；marker 就是命中的词', () => {
    const hits = findLiteralHits([{ where: 'p', text: '执行层 A，执行层 B。' }], ['执行层']);
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.marker)).toEqual(['执行层', '执行层']);
  });

  it('excerpt 前各 40 字符（命中词在片段里；前后超界用省略号）', () => {
    const before = '前'.repeat(50);
    const after = '后'.repeat(50);
    const text = `${before}执行层${after}`;
    const hit = scanUserVisibleText([{ where: 'p', text }]).hits[0]!;
    expect(hit.excerpt.startsWith('…')).toBe(true);
    expect(hit.excerpt.endsWith('…')).toBe(true);
    expect(hit.excerpt).toContain('执行层');
    // 命中点前后各取 40：49-char head? 精确断言片段里 '前'*40 + 命中词 + '后'*40，两端各带一个省略号。
    expect(hit.excerpt).toBe(`…${'前'.repeat(40)}执行层${'后'.repeat(40)}…`);
  });
});

// ---------------------------------------------------------------------------
// ② 静态守卫：显式清单 + glob 闭包（新增批次忘接入会红，删调用会红）
// ---------------------------------------------------------------------------

/**
 * 显式维护的文件清单（单一来源）。
 *   · 三个用户级批次入口 + live-replay：expectScan=true，必须出现扫描调用标记；
 *   · glob `write-loop*.ts` 还会匹配到 2 个 *.test.ts（绊线测试，不是批次入口）：登记进清单
 *     保证「glob 枚举的文件都在清单里」成立，但它们本身不产出用户可见面，expectScan=false。
 */
const WIRING: ReadonlyArray<{ file: string; marker: string; expectScan: boolean; why: string }> = [
  { file: 'scripts/eval/real/write-loop.ts', marker: 'const leak = scanWriteLoopLeaks', expectScan: true, why: 'write-loop 用户级批次入口' },
  { file: 'scripts/eval/real/write-loop-scenarios.ts', marker: 'const leak = scanScenarioLeaks', expectScan: true, why: 'write-loop-scenarios 用户级批次入口' },
  { file: 'scripts/eval/convergence-r1/runner.ts', marker: 'const leak = scanTrialLeaks', expectScan: true, why: 'convergence-r1 runner 用户级批次入口' },
  { file: 'scripts/eval/real/live-replay.ts', marker: 'findLiteralHits(input.visible, INTERNAL_WORDS)', expectScan: true, why: 'live-replay 既有内部词断言（词表单一来源）' },
  { file: 'scripts/eval/real/write-loop.test.ts', marker: '', expectScan: false, why: 'write-loop 绊线测试（非批次入口，glob 命中）' },
  { file: 'scripts/eval/real/write-loop-scenarios.test.ts', marker: '', expectScan: false, why: 'write-loop-scenarios 绊线测试（非批次入口，glob 命中）' },
];

describe('静态守卫：所有用户级批次都接入了扫描', () => {
  it('显式清单里的每个批次入口都确实调用了扫描（删调用即红）', () => {
    for (const entry of WIRING.filter((entry) => entry.expectScan)) {
      const source = readFileSync(repo(entry.file), 'utf8');
      expect(source, `${entry.file}（${entry.why}）未出现扫描调用标记 ${entry.marker}`).toContain(entry.marker);
    }
  });

  it('每个批次入口都从单一来源导入了 scanUserVisibleText / INTERNAL_WORDS', () => {
    for (const entry of WIRING.filter((entry) => entry.expectScan)) {
      const source = readFileSync(repo(entry.file), 'utf8');
      const importsFromShared = /from ['"][^'"]*shared\/internal-terms['"]/u.test(source)
        || /from ['"][^'"]*live-replay['"]/u.test(source); // live-replay 转发词表给旧测试
      expect(importsFromShared, `${entry.file} 未从 shared/internal-terms 单一来源导入`).toBe(true);
    }
  });

  it('glob 枚举 write-loop*.ts 与 convergence-r1/runner.ts 全部落在清单里（新增批次忘接入即红）', () => {
    const enumerated = [
      ...globSync('scripts/eval/real/write-loop*.ts', { cwd: REPO_ROOT }),
      ...globSync('scripts/eval/convergence-r1/runner.ts', { cwd: REPO_ROOT }),
    ].sort();
    const listed = WIRING.map((entry) => entry.file).sort();
    for (const file of enumerated) {
      expect(listed, `新增/现存批次 ${file} 未登记进通用泄漏守卫清单（忘了接入）`).toContain(file);
    }
    // 清单里至少三个 expectScan 的批次入口被登记（防止把 batches 全标 false 绕过守卫）。
    expect(WIRING.filter((entry) => entry.expectScan)).toHaveLength(4);
  });
});
