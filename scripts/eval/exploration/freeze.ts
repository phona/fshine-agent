/**
 * Exploration Suite 冻结工具：把套件自身的用例与共享判定面哈希写入 <suite>/criteria.lock。
 *
 * 用法：
 *   node --import tsx scripts/eval/exploration/freeze.ts scripts/eval/exploration/e05-adjacent
 *
 * 与 R1 的关系：不触碰 convergence-r1/criteria.lock；runner 运行时对套件只比
 * criteriaSha256 / casesSha256 两个聚合值（与 R1 同规则，fail-closed），files 清单供复核员。
 * 套件判据文档默认沿用 R1 的 buildCriteriaDocument（同一套冻结规则文字）。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex, stableStringify } from '../convergence-r1/hash';
import { buildCriteriaDocument } from '../convergence-r1/criteria';
import { REPO_ROOT, loadSuite } from './suite-contract';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function canonicalJson(value: unknown): string {
  return JSON.stringify(JSON.parse(stableStringify(value)), null, 2) + '\n';
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === undefined || arg.trim() === '') {
    console.error('用法：node --import tsx scripts/eval/exploration/freeze.ts <suite-dir>');
    process.exitCode = 2;
    return;
  }
  const suiteDir = path.isAbsolute(arg) ? path.resolve(arg) : path.resolve(REPO_ROOT, arg);
  const suite = await loadSuite(suiteDir);

  const criteriaText = canonicalJson((suite.criteriaDocument ?? buildCriteriaDocument)());
  const casesText = canonicalJson(suite.cases);

  const files: Record<string, string> = {};
  const addFile = (absolute: string): void => {
    files[path.relative(REPO_ROOT, absolute)] = sha256Hex(readFileSync(absolute));
  };
  // 套件自身：suite.ts + cases/*.ts
  addFile(path.join(suiteDir, 'suite.ts'));
  const casesDir = path.join(suiteDir, 'cases');
  for (const name of readdirSync(casesDir).filter((entry) => entry.endsWith('.ts')).sort()) {
    addFile(path.join(casesDir, name));
  }
  // 共享判定面（引用即纳入，漂移可见）：接缝契约 / 判定器 / 判据 / 用例类型 / 哈希 / 证据 schema / 隔离门。
  for (const relative of [
    'scripts/eval/exploration/suite-contract.ts',
    'scripts/eval/convergence-r1/judge.ts',
    'scripts/eval/convergence-r1/criteria.ts',
    'scripts/eval/convergence-r1/cases.ts',
    'scripts/eval/convergence-r1/hash.ts',
    'scripts/eval/convergence-r1/evidence.ts',
    'scripts/eval/safety-gate.ts',
  ]) {
    addFile(path.join(REPO_ROOT, relative));
  }

  const lock = {
    generatedBy: 'node --import tsx scripts/eval/exploration/freeze.ts <suite-dir>',
    suiteId: suite.id,
    frozenAt: new Date().toISOString(),
    criteriaSha256: sha256Hex(criteriaText),
    casesSha256: sha256Hex(casesText),
    files,
    note: '冻结后不得修改本套件的 cases 与共享判定面；runner 校验两聚合哈希，不一致即拒绝运行（fail-closed）。',
  };
  writeFileSync(suite.lockPath, JSON.stringify(lock, null, 2) + '\n');
  console.log(`[freeze] suite=${suite.id}`);
  console.log(`[freeze] criteriaSha256=${lock.criteriaSha256}`);
  console.log(`[freeze] casesSha256=${lock.casesSha256}`);
  console.log(`[freeze] ${Object.keys(files).length} files → ${path.relative(REPO_ROOT, suite.lockPath)}`);
}

await main().catch((error: unknown) => {
  console.error('探索套件冻结失败：', error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
