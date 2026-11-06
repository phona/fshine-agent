/**
 * 执行层身份面守卫（W1 C8 落地）：W1 scope 内零 "example-gateway" 字样（大小写不敏感）。
 *
 * 覆盖面 = 公开仓身份面子集（迁移门①的 W1 子集）：四个包的 src 目录（agent /
 * core / contracts / channel-wecom）、apps、
 * 模板 / .env.example / package.json 归 W3 与波次 4（openDecisions #6 的分工），
 * 不在本守卫范围——范围收窄是有意的，不要"顺手"扩大。
 *
 * 两级待办排除机制已退役（2026-11-06 W4）：整文件排除（预算测试文件）与行内
 * `identity-defer: W4` 签随预算跨仓校验退出宿主而清空——C2 清 budget-policy
 * 注释并移出一个整文件排除，C4 删跨仓校验脚本与 scope 旧注后清空全部剩余签，
 * 守卫语义收敛为无条件零（当时「排除机制非空转」的两条自反断言随机制一并移除，
 * 其历史形态见 W1 波次记录 change-safety §27 与本文件 git 历史）。
 *
 * 变异自反（F3）改为外部留档形态：往 scope 内任一文件注入一处 example-gateway 应使本测试
 * 红（手工注入即红；变异证据留档 change-safety §25）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

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
      if (!TEXT_EXTENSIONS.has(path.extname(file))) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        if (!/example-gateway/i.test(line)) continue;
        hits.push({ file: relative, line: index + 1, text: line.trim().slice(0, 160) });
      }
    }
  }
  return hits;
}

describe('W1 身份面守卫：scope 内零 example-gateway 字样（大小写不敏感）', () => {
  it('全 scope 计数 = 0（命中清单直接可行动：文件:行 + 行文本）', () => {
    const hits = scanScope();
    const report = hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n');
    expect(hits, `W1 身份面守卫红：scope 内出现 ${hits.length} 处 example-gateway 字样（大小写不敏感）。\n${report}\n处置判据见本文件头注释与 docs/change-safety.md §25`).toEqual([]);
  });
});
