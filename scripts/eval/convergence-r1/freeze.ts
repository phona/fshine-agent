/**
 * 判据冻结工具：把 criteria + 12 用例文件 + 判定器表面的 sha256 写入 criteria.lock。
 *
 * 用法（冻结后判据/用例/判定器不得再改；run 时 runner 会校验 criteria.lock）：
 *   node --import tsx scripts/eval/convergence-r1/freeze.ts
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_CASES } from './cases';
import { buildCriteriaDocument } from './criteria';
import { sha256Hex, stableStringify } from './hash';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const LOCK_PATH = path.join(HERE, 'criteria.lock');

function canonicalJson(value: unknown): string {
  return JSON.stringify(JSON.parse(stableStringify(value)), null, 2) + '\n';
}

const criteriaText = canonicalJson(buildCriteriaDocument());
const casesText = canonicalJson(ALL_CASES);

const files: Record<string, string> = {};
const caseFiles = readdirSync(path.join(HERE, 'cases')).filter((name) => /^E\d{2}\.ts$/.test(name)).sort();
for (const relative of [
  'criteria.ts',
  'cases.ts',
  'judge.ts',
  'hash.ts',
  'evidence.ts',
  'selftest.ts',
  ...caseFiles.map((name) => path.join('cases', name)),
]) {
  const absolute = path.join(HERE, relative);
  files[path.relative(REPO_ROOT, absolute)] = sha256Hex(readFileSync(absolute));
}

const lock = {
  generatedBy: 'node --import tsx scripts/eval/convergence-r1/freeze.ts',
  frozenAt: new Date().toISOString(),
  criteriaSha256: sha256Hex(criteriaText),
  casesSha256: sha256Hex(casesText),
  files,
  note: '冻结后不得修改 criteria/用例/判定器；runner 校验 criteriaSha256/casesSha256，不一致即拒绝运行（fail-closed）。',
};
writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n');
console.log(`[freeze] criteriaSha256=${lock.criteriaSha256}`);
console.log(`[freeze] casesSha256=${lock.casesSha256}`);
console.log(`[freeze] ${Object.keys(files).length} files → ${path.relative(REPO_ROOT, LOCK_PATH)}`);
