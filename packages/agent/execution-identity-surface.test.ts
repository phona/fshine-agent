/**
 * 执行层身份面守卫（W1 C8 落地）：W1 scope 内零 "17dz" 字样（大小写不敏感）。
 *
 * 覆盖面 = 公开仓身份面子集（迁移门①的 W1 子集）：四个包的 src 目录（agent /
 * core / contracts / channel-wecom）、apps、
 * 模板 / .env.example / package.json 归 W3 与波次 4（openDecisions #6 的分工），
 * 不在本守卫范围——范围收窄是有意的，不要"顺手"扩大。
 *
 * 两级排除机制（均为待办签，不是永久豁免；W4 落地时两类签同时清空）：
 *  · 整文件排除：budget-policy-cross-repo.test.ts——夹具与断言锚在
 *    CROSS_REPO_17DZ_ROOT 变量名上，随 W4 跨仓校验退出宿主时整文件删除
 *    （W4 C4 同批移出本清单）；budget-policy.test.ts 已由 W4 C2 清零并
 *    移出本清单（守卫覆盖收紧）；
 *  · 行内排除：`identity-defer: W4` 签——scripts/ci.sh 里引用
 *    CROSS_REPO_17DZ_ROOT 变量名的行（budget-policy.ts 的签已随 W4 C2
 *    清零；ci.sh 的签随 C4 scope 注改写清空，届时本机制整体退役）。
 *
 * 变异自反（F3）内建于测试：①排除清单里列出的文件被断言确实含 17dz（排除非空转）；
 * ②挂签行被断言确实含签（签机制被删行不虚计）。往 scope 内任一文件注入一处 17dz
 * 应使本测试红（F3 变异①⑥的验证形态，手工注入即红）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** 整文件排除：W4 预算改名批次（openDecisions #7），W4 落地时清空本清单。 */
const FILE_EXCLUSIONS_W4: ReadonlyArray<string> = [
  'packages/agent/src/budget-policy-cross-repo.test.ts',
];

/** 行内排除签：变量名改名归 W4 的行挂此签（签内容自说明，见 openDecisions #7）。 */
const INLINE_DEFER_MARKER = 'identity-defer: W4';

/** 扫描目标：目录（递归）与单文件混排，相对 REPO_ROOT。 */
const TARGETS: ReadonlyArray<string> = [
  'packages/agent/src',
  'packages/core/src',
  'packages/contracts/src',
  'packages/channel-wecom/src',
  'apps',
  '.github/workflows/ci.yml',
  'scripts/ci.sh',
];

const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.yml', '.yaml', '.sh', '.json', '.md']);

function* walkFiles(entry: string): Generator<string> {
  const stat = statSync(entry);
  if (stat.isFile()) {
    yield entry;
    return;
  }
  for (const name of readdirSync(entry)) {
    if (name === 'node_modules' || name === 'dist' || name === 'data') continue;
    const child = path.join(entry, name);
    if (statSync(child).isDirectory()) yield* walkFiles(child);
    else yield child;
  }
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function scanScope(): Hit[] {
  const hits: Hit[] = [];
  for (const target of TARGETS) {
    const absolute = path.join(REPO_ROOT, target);
    for (const file of walkFiles(absolute)) {
      const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      if (FILE_EXCLUSIONS_W4.includes(relative)) continue;
      if (!TEXT_EXTENSIONS.has(path.extname(file))) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        if (!/17dz/i.test(line)) continue;
        if (line.includes(INLINE_DEFER_MARKER)) continue;
        hits.push({ file: relative, line: index + 1, text: line.trim().slice(0, 160) });
      }
    }
  }
  return hits;
}

describe('W1 身份面守卫：scope 内零 17dz 字样（大小写不敏感）', () => {
  it('全 scope 计数 = 0（命中清单直接可行动：文件:行 + 行文本）', () => {
    const hits = scanScope();
    const report = hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n');
    expect(hits, `W1 身份面守卫红：scope 内出现 ${hits.length} 处 17dz 字样（大小写不敏感）。\n${report}\n处置判据见本文件头注释与 docs/change-safety.md §25`).toEqual([]);
  });

  it('排除机制非空转（变异自反①）：被整文件排除的预算文件确实含 17dz', () => {
    for (const relative of FILE_EXCLUSIONS_W4) {
      const content = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
      expect(/17dz/i.test(content), `${relative} 已不含 17dz——W4 改名已落地，请把该文件移出 FILE_EXCLUSIONS_W4（守卫覆盖收紧）`).toBe(true);
    }
  });

  it('挂签机制非空转（变异自反②）：行内签真实存在于 scope 且行内容确含 17dz', () => {
    let signedLines = 0;
    for (const target of TARGETS) {
      const absolute = path.join(REPO_ROOT, target);
      for (const file of walkFiles(absolute)) {
        const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
        if (FILE_EXCLUSIONS_W4.includes(relative)) continue;
        if (!TEXT_EXTENSIONS.has(path.extname(file))) continue;
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (line.includes(INLINE_DEFER_MARKER)) {
            signedLines += 1;
            expect(/17dz/i.test(line), `挂签行不含 17dz——签已失效，请删除该行签（${relative}）：${line.trim()}`).toBe(true);
          }
        }
      }
    }
    expect(signedLines, 'scope 内零挂签行——W4 签已全部清空，请同步删除 INLINE_DEFER_MARKER 机制（守卫语义收敛为无条件零）').toBeGreaterThan(0);
  });
});
