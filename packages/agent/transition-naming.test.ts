/**
 * 过渡命名收敛守卫（TDD：先在旧命名上红，收口改名后绿）。
 *
 * 为什么需要它：重命名收口只做一次；一旦再有 `minimal-*` 文件、`Minimal*` 标识符或
 * `m2` / `v2` 之类过渡词混回生产面，靠人工审查不容易逐次发现。本守卫把「仓库不得
 * 出现过渡期命名」变成常驻测试。
 *
 * 扫描范围 = `git ls-files` 的跟踪文件（排除 gitignored 本地产物与 node_modules，
 * 结果与工作区清洗状态无关），减去白名单：
 *   · 守卫自身（模式串即被禁词，无法自扫）；
 *   · `docs/**`（决定记录允许引用历史命名）；
 *   · `.zcode/**`（客户端本地工件）。
 *
 * 判据（文件路径 + 代码标识符）：
 *   · 路径：每个跟踪文件的相对路径按.camelCase / 下划线 / 字母-数字边界切词后不得
 *     命中被禁词（大小写不敏感）——拦 `scripts/ask-minimal.ts`、`src/minimal/`；
 *   · 标识符：代码文件（.ts/.tsx/.js/.mjs/.cjs）经 TS 解析后的 Identifier 名，同样
 *     切词比对——拦 `MinimalSession`、`MINIMAL_ROOT`、`m2Wave`。
 *   注：注释与字符串不在判据内（历史注释、外部协议字面量不属于命名面）；生产面的
 *   `grep -ri minimal` 验收另见收口记录。
 *
 * 窄豁免（需理由）：`packages/agent/src/pi-driver.ts` 的 `minimal` 是 Pi 统一思考
 * 档位词表（off/minimal/low/medium/high/xhigh/max）的外部取值，作为字面量发送给
 * 模型端点，改名即行为变化——不是过渡命名。豁免双向闭合：豁免表里每条必须真实命中
 * （无陈旧豁免），命中集必须全部被豁免覆盖（无漏网）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GUARD_FILE = 'packages/agent/transition-naming.test.ts';

/** 白名单只允许这三类（见文件头）；其余跟踪文件全部在扫描范围。 */
const WHITELIST: readonly RegExp[] = [/^docs\//, /^\.zcode\//];

/** 被禁过渡词：按完整 token 比对（大小写不敏感），不做子串匹配。 */
const FORBIDDEN = new Set(['minimal', 'legacy', 'deprecated', 'm2', 'm3', 'v2']);

const CODE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;

/** token 切分：非字母数字分隔 + camelCase / 字母-数字边界。 */
function tokensOf(input: string): string[] {
  return input
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/([A-Za-z])([0-9])/g, '$1_$2')
      .replace(/([0-9])([A-Za-z])/g, '$1_$2')
      .split('_'))
    .filter((token) => token !== '')
    .map((token) => token.toLowerCase());
}

function forbiddenTokensIn(input: string): string[] {
  return tokensOf(input).filter((token) => FORBIDDEN.has(token));
}

interface IdentifierHit {
  file: string;
  identifier: string;
  token: string;
}

/**
 * 窄豁免表（file + identifier 精确匹配；理由见文件头）。
 * 每条都必须真实命中——豁免对象不存在时守卫同样红，防止陈旧豁免长期积灰。
 */
const NARROW_EXEMPT_IDENTIFIERS: ReadonlyArray<{ file: string; identifier: string; token: string; reason: string }> = [
  {
    file: 'packages/agent/src/pi-driver.ts',
    identifier: 'minimal',
    token: 'minimal',
    reason: 'Pi 统一思考档位词表的外部取值（off/minimal/low/medium/high/xhigh/max），改名即行为变化',
  },
];

function exemptKey(hit: { file: string; identifier: string; token: string }): string {
  return `${hit.file}\u0000${hit.identifier}\u0000${hit.token}`;
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '');
}

function inScope(file: string): boolean {
  if (file === GUARD_FILE) return false;
  return !WHITELIST.some((pattern) => pattern.test(file));
}

function identifierHits(): IdentifierHit[] {
  const hits: IdentifierHit[] = [];
  for (const file of trackedFiles()) {
    if (!inScope(file) || !CODE_FILE.test(file)) continue;
    const kind = /\.(ts|tsx)$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const source = ts.createSourceFile(
      file,
      readFileSync(path.join(REPO_ROOT, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      kind,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        for (const token of forbiddenTokensIn(node.text)) {
          hits.push({ file, identifier: node.text, token });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return hits;
}

describe('过渡命名收敛守卫', () => {
  it('跟踪文件路径不含过渡词', () => {
    const files = trackedFiles().filter(inScope);
    const hits = files.flatMap((file) => forbiddenTokensIn(file).map((token) => `${file} -> ${token}`));
    console.log(JSON.stringify({ event: 'naming_guard_paths', files: files.length, hits: hits.length }));
    expect(hits, `文件路径命中过渡词：\n${hits.join('\n')}`).toEqual([]);
  });

  it('代码标识符不含过渡词，窄豁免逐条闭合', () => {
    const hits = identifierHits();
    console.log(JSON.stringify({
      event: 'naming_guard_identifiers',
      scanned: trackedFiles().filter((file) => inScope(file) && CODE_FILE.test(file)).length,
      hits: hits.length,
      exemptions: NARROW_EXEMPT_IDENTIFIERS.map((entry) => `${entry.file}:${entry.identifier}`),
    }));

    const exempt = new Set(NARROW_EXEMPT_IDENTIFIERS.map(exemptKey));
    const unexplained = hits.filter((hit) => !exempt.has(exemptKey(hit)));
    const unexplainedLabels = [...new Set(unexplained.map((hit) => `${hit.file} :: ${hit.identifier} (${hit.token})`))];
    expect(unexplainedLabels, `标识符命中过渡词且无豁免理由：\n${unexplainedLabels.join('\n')}`).toEqual([]);

    // 反向绊线：豁免表不得含陈旧条目（对象已不存在时必须删豁免，而不是继续放行）。
    const hitKeys = new Set(hits.map(exemptKey));
    const stale = NARROW_EXEMPT_IDENTIFIERS
      .filter((entry) => !hitKeys.has(exemptKey(entry)))
      .map((entry) => `${entry.file} :: ${entry.identifier}（豁免理由：${entry.reason}）`);
    expect(stale, `陈旧豁免（豁免对象已不存在）：\n${stale.join('\n')}`).toEqual([]);
  });
});
