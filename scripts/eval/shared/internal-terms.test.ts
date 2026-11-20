/**
 * 用户可见文本「内部词」通用守卫的绊线（scripts/eval/shared/internal-terms.test.ts）。
 *
 * 两部分：
 *   ① 匹配器单测：正常文本零命中；「执行层确认过了。」命中 marker 执行层；反向绊线直接可验
 *      （改词表 / 改 findLiteralHits / 改 excerpt 半径，本组用例即红）。
 *   ② 静态守卫：一份**显式文件清单**（write-loop / write-loop-scenarios / convergence-r1 runner
 *      + live-replay）逐个用 **TypeScript AST** 断言文件里确实存在对扫描函数的 CallExpression；
 *      并用 glob 枚举 `scripts/eval/real/write-loop*.ts` 与 `scripts/eval/convergence-r1/runner.ts`，
 *      断言这些文件都在清单里——新增批次忘了接入会红，删掉调用也会红。
 *
 * 「真解析」而非文本包含：用 typescript 自带 createSourceFile 解析源码（不落盘、不 emit），
 * 遍历 AST 找 CallExpression，被调函数名（Identifier.text）等于清单里的扫描函数名才算接入。
 * 注释掉的代码不会成为 AST 节点——所以**注释即红、删除即红**，不会因注释里还留着文本而假绿。
 *
 * 亲跑验证（红→绿）：临时注释掉某入口的扫描调用，静态守卫必红；恢复即绿。读数见交付报告。
 */
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { findLiteralHits, INTERNAL_WORDS, scanUserVisibleText } from './internal-terms';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function repo(relative: string): string {
  return path.join(REPO_ROOT, relative);
}

/**
 * 解析源码，判断是否存在一次「被调函数名（标识符）等于 scanFunction」的 CallExpression。
 * 只用 typescript 自带的解析器，不落盘、不 emit；注释/字符串里的文本不会成为节点。
 * requiredArg 非空时，还要求该调用的某个实参是同名标识符（保住 live-replay 词表面判据强度：
 * 必须真的把 INTERNAL_WORDS 传给 findLiteralHits，而不是随便一次 findLiteralHits 调用）。
 */
function hasScanCall(fileName: string, source: string, scanFunction: string, requiredArg?: string): boolean {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === scanFunction) {
      if (requiredArg === undefined || node.arguments.some((arg) => ts.isIdentifier(arg) && arg.text === requiredArg)) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
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
 *   · 三个用户级批次入口 + live-replay：expectScan=true，fn 是必须真实调用的扫描函数名；
 *   · glob `write-loop*.ts` 还会匹配到 2 个 *.test.ts（绊线测试，不是批次入口）：登记进清单
 *     保证「glob 枚举的文件都在清单里」成立，但它们本身不产出用户可见面，expectScan=false。
 */
const WIRING: ReadonlyArray<{
  file: string;
  fn: string;
  requiredArg?: string;
  expectScan: boolean;
  why: string;
}> = [
  { file: 'scripts/eval/real/write-loop.ts', fn: 'scanWriteLoopLeaks', expectScan: true, why: 'write-loop 用户级批次入口' },
  { file: 'scripts/eval/real/write-loop-scenarios.ts', fn: 'scanScenarioLeaks', expectScan: true, why: 'write-loop-scenarios 用户级批次入口' },
  { file: 'scripts/eval/convergence-r1/runner.ts', fn: 'scanTrialLeaks', expectScan: true, why: 'convergence-r1 runner 用户级批次入口' },
  { file: 'scripts/eval/real/live-replay.ts', fn: 'findLiteralHits', requiredArg: 'INTERNAL_WORDS', expectScan: true, why: 'live-replay 既有内部词断言（词表单一来源）' },
  { file: 'scripts/eval/real/write-loop.test.ts', fn: '', expectScan: false, why: 'write-loop 绊线测试（非批次入口，glob 命中）' },
  { file: 'scripts/eval/real/write-loop-scenarios.test.ts', fn: '', expectScan: false, why: 'write-loop-scenarios 绊线测试（非批次入口，glob 命中）' },
];

describe('静态守卫：所有用户级批次都接入了扫描', () => {
  it('显式清单里的每个批次入口都真实调用了扫描函数（AST：注释/删行即红）', () => {
    for (const entry of WIRING.filter((entry) => entry.expectScan)) {
      const source = readFileSync(repo(entry.file), 'utf8');
      const called = hasScanCall(entry.file, source, entry.fn, entry.requiredArg);
      expect(called, `${entry.file}（${entry.why}）的 AST 中未找到 ${entry.fn}(${entry.requiredArg ?? ''}) 调用——注释或删除即红`).toBe(true);
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
