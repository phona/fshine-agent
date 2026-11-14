/**
 * P0-T05 S3「redo 语义正名」文档扫描（确定性；只读文档与 CLI 帮助，零产品代码）。
 *
 * 口径：`--redo` = **重新交办**（新任务、输入=存储的委派原文逐字），
 * 不是人工接管、也不是会话续跑（真续跑 = Pi 原生会话恢复，单独缺口，见 README 边界与
 * `docs/product/r3-open-decisions.md`）。
 *
 * 判据：
 *  ① README 的语义边界句保持逐字（换行归一后比对）；
 *  ② decision-log §二十（P3 历史记录）加注「名称说明」，且历史标题保留不改（加注不改正文）；
 *  ③ P3 报告首部（`## 一` 之前）加注「名称说明」，历史标题行逐字保留；
 *  ④ 三个文件里非标题/非引注行不得出现把 redo 说成接管/续跑的无否定表述；
 *  ⑤ CLI 帮助（scripts/tasks.ts 的 USAGE）只说「重新交办」。
 *
 * 范围说明：只扫产品面与历史注记的这三个文件 + CLI 帮助；其余历史文档（rule-landing
 * 等）承载其他机制的「续跑」语义，S3 不要求改写（R4 边界：不改历史证据）。
 * 现状（实现前）：②③ 缺「名称说明」注记 → 红；实现（P0 docs 提交）后全绿。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const DECISION_LOG_PATH = path.join(REPO_ROOT, 'docs', 'decision-log.md');
const P3_REPORT_PATH = path.join(REPO_ROOT, 'docs', 'product', 'p3-human-redo.md');

/** 去空白（含换行）归一：把跨行句子变成可精确比对的连续串。 */
function flat(text: string): string {
  return text.replace(/\s+/g, '');
}

/** 非标题/非引注行里，出现 redo 语义 + 接管/续跑却无任何否定/区分标记的行。 */
const NEGATION = /不是|≠|并非|而非|不得混淆|区分|不同于/;

function unnegatedMisdescriptions(file: string, text: string): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((line, index) => {
    if (line.trimStart().startsWith('#') || line.trimStart().startsWith('>')) return;
    if (!/redo|重新交办|重新推进/i.test(line)) return;
    if (!/接管|续跑/.test(line)) return;
    if (NEGATION.test(line)) return;
    hits.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
  });
  return hits;
}

const CANONICAL_BOUNDARY = '不是人工接管、也不是会话续跑';

describe('P0-T05 S3 redo 口径文档扫描', () => {
  it('README：`--redo` 语义边界句逐字保持，人工接管的提法均被否定', () => {
    const text = readFileSync(README_PATH, 'utf8');
    expect(flat(text)).toContain('`--redo`是「重新交办」，不是人工接管、也不是会话续跑');
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.includes('人工接管')) continue;
      expect(NEGATION.test(line), `README.md:${index + 1} 把 redo 说成接管且无否定：${line.trim()}`).toBe(true);
    }
  });

  it('decision-log §二十：加注「名称说明」且历史标题保留不改', () => {
    const text = readFileSync(DECISION_LOG_PATH, 'utf8');
    expect(text).toContain('## 二十、P3 产品切片：人工接管 v1');
    const start = text.indexOf('## 二十、');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = text.slice(start + 1);
    const nextHeading = rest.search(/\n## /);
    const section = nextHeading < 0 ? rest : rest.slice(0, nextHeading);
    expect(section, 'decision-log §二十 缺「名称说明」加注').toContain('名称说明');
    expect(flat(section), `decision-log §二十 注记需含「${CANONICAL_BOUNDARY}」`).toContain(CANONICAL_BOUNDARY);

    const mis = unnegatedMisdescriptions('docs/decision-log.md', text);
    expect(mis, `decision-log 出现未否定的 redo=接管/续跑表述：\n${mis.join('\n')}`).toEqual([]);
  });

  it('P3 报告：首部加注「名称说明」；历史标题与正文不改', () => {
    const text = readFileSync(P3_REPORT_PATH, 'utf8');
    // 历史证据不改：标题行逐字保持（注记只能追加，不得改写）。
    expect(text.split('\n')[0]).toBe('# P3 切片报告：人工接管 v1（`npm run tasks -- <id> --redo`）');
    const headEnd = text.indexOf('## 一');
    expect(headEnd).toBeGreaterThan(0);
    const head = text.slice(0, headEnd);
    expect(head, 'P3 报告首部缺「名称说明」加注').toContain('名称说明');
    expect(flat(head), `P3 报告首部注记需含「${CANONICAL_BOUNDARY}」`).toContain(CANONICAL_BOUNDARY);

    const mis = unnegatedMisdescriptions('docs/product/p3-human-redo.md', text);
    expect(mis, `P3 报告出现未否定的 redo=接管/续跑表述：\n${mis.join('\n')}`).toEqual([]);
  });

  it('CLI 帮助一致：tasks USAGE 只说重新交办，不提接管/续跑', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'scripts', 'tasks.ts'), 'utf8');
    const start = source.indexOf('const USAGE =');
    expect(start).toBeGreaterThanOrEqual(0);
    const usage = source.slice(start, source.indexOf(';', start));
    expect(usage).toContain('重新交办');
    expect(usage).not.toContain('接管');
    expect(usage).not.toContain('续跑');
  });
});
