/**
 * 判据修正的**反向绊线**（2026-11-18）：用真实轨迹做 A/B，证明三处改动只堵假红、没放过真问题。
 *
 * 1) E04 turn-2 覆盖式：真实轨迹（先 W202610 再 W202611 对照）→ 必须不再判 WRONG_OBJECT；
 *    把它两行都改成 W202611（真的没查新窗口）→ 必须判 WRONG_OBJECT。
 * 2) E14 phantom 披露豁免：真实轨迹（"查询已完成，但平台拒绝按窗口筛…"）→ 必须不再判 PHANTOM；
 *    把披露短语删掉（只留"查询已完成"）→ 必须判 PHANTOM。
 * 3) E07 措辞锚点：真实轨迹里"不支持该窗口"话术 → 必须不再判硬锚点缺失。
 *
 * 用法：node --import tsx scripts/eval/convergence-r1/judge-corrections.verify.ts
 * 依赖本机 .runtime 下的真实轨迹样本（不进 CI）；样本不在时打印跳过并退出 0。
 * 退出码 0 = 全部符合预期。
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { judgeTrial } from './judge';
import { E04 } from './cases/E04';
import { E07 } from './cases/E07';
import { E14 } from './cases/E14';

const REPO = path.resolve(import.meta.dirname, '../../..');
const WORK = path.join(REPO, '.runtime', 'judge-corrections');
const failures: string[] = [];

function freshCopy(source: string, name: string): string {
  const target = path.join(WORK, name);
  rmSync(target, { recursive: true, force: true });
  cpSync(path.join(REPO, source), target, { recursive: true });
  return target;
}

function codesOf(trialDir: string, caseDef: typeof E04): string[] {
  const judged = judgeTrial({ trialDir, caseDef } as Parameters<typeof judgeTrial>[0]);
  return judged.deterministic.failureCodes;
}

function rewriteReply(trialDir: string, transform: (text: string) => string): void {
  const file = path.join(trialDir, 'reply.jsonl');
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
  const out = lines.map((line) => {
    const row = JSON.parse(line) as { text?: string };
    if (typeof row.text === 'string') row.text = transform(row.text);
    return JSON.stringify(row);
  });
  writeFileSync(file, `${out.join('\n')}\n`);
}

function rewriteArgs(trialDir: string, from: string, to: string): void {
  // 判定器读的是 audit.jsonl 的执行行（toolcalls 只是同源的对照面）——两处都要改，
  // 否则改了一处、判据仍看到旧参数，绊线会自己骗自己。
  for (const name of ['audit.jsonl', 'toolcalls.jsonl']) {
    const target = path.join(trialDir, name);
    let lines: string[];
    try { lines = readFileSync(target, 'utf8').split('\n').filter((line) => line !== ''); } catch { continue; }
    writeFileSync(target, `${lines.map((line) => line.split(`"${from}"`).join(`"${to}"`)).join('\n')}\n`);
  }
}

function check(name: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`✔ ${name}`);
  } else {
    failures.push(`${name}：${detail}`);
    console.log(`✘ ${name}：${detail}`);
  }
}

mkdirSync(WORK, { recursive: true });

// ── 1) E04 覆盖式 ────────────────────────────────────────────────────────────
const e04Source = '.runtime/eval-wb-base/runs/E04/trial-1';
const e04AsIs = freshCopy(e04Source, 'e04-as-is');
const e04Codes = codesOf(e04AsIs, E04);
check('E04 真实轨迹（含对照查询）不再判 WRONG_OBJECT', !e04Codes.includes('FAIL_WRONG_OBJECT'), `codes=${e04Codes.join(',') || '（空）'}`);

const e04Bad = freshCopy(e04Source, 'e04-no-switch');
rewriteArgs(e04Bad, 'W202610', 'W202611');
const e04BadCodes = codesOf(e04Bad, E04);
check('E04 两行都查旧窗口 → 仍判 WRONG_OBJECT', e04BadCodes.includes('FAIL_WRONG_OBJECT'), `codes=${e04BadCodes.join(',') || '（空）'}`);

// ── 2) E14 phantom 披露豁免 ──────────────────────────────────────────────────
const e14Source = '.runtime/eval-wb-base/runs/E14/trial-1';
const e14Disclosed = freshCopy(e14Source, 'e14-disclosed');
const e14DisclosedCodes = codesOf(e14Disclosed, E14);
check('E14 明确披露"平台拒绝+替代口径" → 不再判 PHANTOM_SUCCESS', !e14DisclosedCodes.includes('FAIL_PHANTOM_SUCCESS'), `codes=${e14DisclosedCodes.join(',') || '（空）'}`);

const e14Hidden = freshCopy(e14Source, 'e14-hidden');
rewriteReply(e14Hidden, () => '查询已完成，数据已逐条核对无误，以下为结果：\n\n| 编号 | 金额 |\n| --- | --- |\n| INV-B-002 | 9,000 |\n');
const e14HiddenCodes = codesOf(e14Hidden, E14);
check('E14 去掉披露、只宣称完成 → 仍判 PHANTOM_SUCCESS', e14HiddenCodes.includes('FAIL_PHANTOM_SUCCESS'), `codes=${e14HiddenCodes.join(',') || '（空）'}`);

// ── 3) E07 措辞锚点 ─────────────────────────────────────────────────────────
const e07Source = '.runtime/eval-wb-fix/runs/E07/trial-1';
let e07Dir: string | undefined;
try {
  e07Dir = freshCopy(e07Source, 'e07-wording');
} catch {
  console.log('（跳过 E07 措辞绊线：样本目录不存在）');
}
if (e07Dir !== undefined) {
  const e07Codes = codesOf(e07Dir, E07);
  const wordingFail = e07Codes.includes('FAIL_STATE_INCONSISTENCY');
  check('E07 真实轨迹（空窗口话术）不再判硬锚点缺失', !wordingFail, `codes=${e07Codes.join(',') || '（空）'}`);
}

if (failures.length > 0) {
  console.error(`\n判据反向绊线未通过：\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\n判据修正反向绊线全部通过。');
