/**
 * recalc_xlsx 公式级 Eval（准入五条第 5 项；docs/decision-log.md §九十九）。
 *
 * 目的：给出「增加机制前 / 增加后」两档的可复现读数，证明宿主 recalc 工具不是多余机制——
 *   · 增加前（纯数据臂 / data-level oracle）：只读 xlsx 里现存的缓存值，拿缓存与缓存比对，
 *     陈旧的缓存值被当作真值 → 判定 pass（看不见陈旧，静默交付风险）。
 *   · 增加后（公式级臂 / recalc）：强制 LO 重算后读回计算值，比对缓存与计算值 → valueDiffs
 *     非空 → 判定 fail → 投递闸拦下（真实发现陈旧）。
 *
 * 被测面 = 产品实现同源：createRecalcXlsxExecutor + decideRecalcDelivery（packages/agent/src/
 * recalc-xlsx-executor.ts），宿主装配经 fileStore 物化输入、独立 runDir 落报告。
 *
 * 零真实模型、零真实平台；引擎可用时（PATH 有 soffice 26.8.3）跑真引擎，否则用注入的
 * 确定性计算后工作簿假引擎——两种都给出同一判定口径，读数如实标注 engine 来源。
 * 证据落 .runtime/eval-recalc/<时间>/（gitignored，不进仓库）。
 *
 * 退出码：0 = 两臂读数符合预期（前 pass / 后 fail 且 valueDiffs 命中）；1 = 任一臂不符。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { openTaskStore } from '@fshine/core';
import { createFileStore } from '../../../packages/agent/src/file-store';
import {
  applyRecalcDeliveryGate,
  collectRecalcReports,
  createRecalcXlsxExecutor,
  createSofficeRecalcEngine,
  RECALC_DELIVERY_GATE_STATUS,
  RECALC_XLSX_REQUIRED_VERSION,
  type RecalcEngine,
} from '../../../packages/agent/src/recalc-xlsx-executor';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCOPE = { principalId: 'eval:recalc', sessionId: 'formula-level' };
/** 投毒缓存：A2 真值应 = A1+B1 = 5，缓存写 999。 */
const CELLS: Record<string, ExcelJS.CellValue> = {
  A1: 2,
  B1: 3,
  A2: { formula: 'A1+B1', result: 999 },
};
const EXPECTED_COMPUTED = 5;

async function makeWorkbook(cells: Record<string, ExcelJS.CellValue>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('汇总');
  for (const [address, value] of Object.entries(cells)) ws.getCell(address).value = value;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function fakeComputedEngine(computed: Buffer): RecalcEngine {
  return {
    probe: () => ({ available: true, sofficePath: 'fake', version: RECALC_XLSX_REQUIRED_VERSION }),
    async convert({ sourcePath, outDir }) {
      const out = path.join(outDir, path.basename(sourcePath));
      writeFileSync(out, computed);
      return { outputPath: out };
    },
  };
}

/** 读现存缓存值（不重算）——「增加前」的数据级口径。 */
async function cachedValueOf(bytes: Buffer, ref: string): Promise<ExcelJS.CellValue> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const value = wb.getWorksheet('汇总')!.getCell(ref).value;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'result' in value) {
    return (value as { result: ExcelJS.CellValue }).result ?? null;
  }
  return value ?? null;
}

export interface FormulaLevelReading {
  readonly arm: 'before_data_level' | 'after_formula_level' | 'after_renamed_still_blocked';
  readonly engine: string;
  readonly cached: ExcelJS.CellValue;
  readonly computed: ExcelJS.CellValue | null;
  readonly verdict: string;
  readonly delivered: boolean;
  readonly reason: string;
}

export async function runFormulaLevelEval(): Promise<{
  readings: FormulaLevelReading[];
  pass: boolean;
  evidenceDir: string;
}> {
  const src = await makeWorkbook(CELLS);
  const cached = await cachedValueOf(src, 'A2');

  // ── 增加前：机制前无闸门 = disabled 闸（allow-all）。陈旧缓存被当作真值 → 放行。
  // Codex P2-6：delivered 不再硬编码，而是真走闸门（enabled=false → outgoing 含文件）。
  const beforeGate = await applyRecalcDeliveryGate({
    files: [{ name: '汇总.xlsx', bytes: src }], reports: [], enabled: false,
  });
  const before: FormulaLevelReading = {
    arm: 'before_data_level',
    engine: 'data-oracle(no recalc)',
    cached,
    computed: null,
    verdict: beforeGate.outgoing.length > 0 ? 'pass（陈旧缓存被当作真值，静默通过）' : 'fail',
    delivered: beforeGate.outgoing.length > 0,
    reason: beforeGate.gated[0]?.reason ?? RECALC_DELIVERY_GATE_STATUS.PASS,
  };

  // ── 增加后：公式级 recalc——强制重算读回计算值 → valueDiffs → fail → 不投递。
  const realEngine = createSofficeRecalcEngine();
  const realFacts = realEngine.probe();
  const useReal = realFacts !== null && realFacts.available
    && realFacts.version.startsWith(RECALC_XLSX_REQUIRED_VERSION);
  // 计算后工作簿：真引擎用 A2 真值；假引擎也用真值（口径一致，只来源不同）。
  const computedWorkbook = await makeWorkbook({ A1: 2, B1: 3, A2: { formula: 'A1+B1', result: EXPECTED_COMPUTED } });
  const engine: RecalcEngine = useReal ? realEngine : fakeComputedEngine(computedWorkbook);

  const root = path.join(REPO_ROOT, '.runtime', 'eval-recalc', Date.now().toString());
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'source.xlsx'), src);
  const store = openTaskStore(':memory:');
  const workspaceRoot = path.join(root, 'workspace');
  const fileStore = createFileStore({ store, workspaceRoot });
  const file = fileStore.putFile({ scope: SCOPE, name: '汇总.xlsx', bytes: src, activatedAt: Date.now() });
  const executor = createRecalcXlsxExecutor({ fileStore: fileStore as never, engine });
  const result = await executor.recalc({ file: `in/${file.fileId}.xlsx`, export: 'none', scope: SCOPE as never });
  const diff = result.valueDiffs.find((d) => d.ref === 'A2');
  // Codex P2-6：after 真走 enabled 闸——收集执行器写出的报告，闸门据 name+sha256+status 决定投递，
  // delivered/reason 从闸门结果取（不再取 executor.status，allow-all 会让这里红）。
  const reports = collectRecalcReports(workspaceRoot, SCOPE as never);
  const afterGate = await applyRecalcDeliveryGate({
    files: [{ name: '汇总.xlsx', bytes: src }], reports, enabled: true,
  });
  const after: FormulaLevelReading = {
    arm: 'after_formula_level',
    engine: useReal ? `soffice ${realFacts!.version}` : 'fake-computed(deterministic)',
    cached,
    computed: diff?.computed ?? cached,
    verdict: afterGate.outgoing.length > 0 ? 'pass' : 'fail',
    delivered: afterGate.outgoing.length > 0,
    reason: afterGate.gated[0]?.reason ?? RECALC_DELIVERY_GATE_STATUS.PASS,
  };

  // ── 负向臂（Codex R13-minor）：同字节改名投递仍须命中 fail 报告被拦——证明闸门按 sha
  // 绑定、不被可变文件名绕过；否则准入证据只在「名字恰好一致」时虚绿。
  const renamedGate = await applyRecalcDeliveryGate({
    files: [{ name: 'renamed-clean.csv', bytes: src }], reports, enabled: true,
  });
  const renamed: FormulaLevelReading = {
    arm: 'after_renamed_still_blocked',
    engine: after.engine,
    cached,
    computed: after.computed,
    verdict: renamedGate.outgoing.length > 0 ? 'pass（改名绕过了 fail 报告）' : 'fail',
    delivered: renamedGate.outgoing.length > 0,
    reason: renamedGate.gated[0]?.reason ?? RECALC_DELIVERY_GATE_STATUS.PASS,
  };

  const readings = [before, after, renamed];
  const pass = before.delivered === true
    && after.delivered === false
    && renamed.delivered === false // 改名也必须被拦
    && after.computed === EXPECTED_COMPUTED
    && diff !== undefined
    && diff.cached === 999;
  writeFileSync(path.join(root, 'readings.json'), JSON.stringify({ pass, readings, sha256: createHash('sha256').update(src).digest('hex') }, null, 2));
  return { readings, pass, evidenceDir: path.relative(REPO_ROOT, root) };
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runFormulaLevelEval().then(({ readings, pass, evidenceDir }) => {
    for (const r of readings) {
      console.log(`[${r.arm}] engine=${r.engine} cached=${JSON.stringify(r.cached)} computed=${JSON.stringify(r.computed)} verdict=${r.verdict} delivered=${r.delivered}`);
    }
    console.log(`pass=${pass} evidence=${evidenceDir}`);
    process.exit(pass ? 0 : 1);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
