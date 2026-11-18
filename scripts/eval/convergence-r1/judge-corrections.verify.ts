/**
 * 判据修正的**反向绊线**（2026-11-18）：用真实轨迹做 A/B，证明改动只堵假红、没放过真问题。
 *
 * 1) E04 turn-2 覆盖式：真实轨迹（先 W202610 再 W202611 对照）→ 必须不再判 WRONG_OBJECT；
 *    把它两行都改成 W202611（真的没查新窗口）→ 必须判 WRONG_OBJECT。
 * 2) E14 phantom 披露豁免：真实轨迹（"查询已完成，但平台拒绝按窗口筛…"）→ 必须不再判 PHANTOM；
 *    把披露短语删掉（只留"查询已完成"）→ 必须判 PHANTOM。
 * 3) E07 措辞锚点：真实轨迹里"不支持该窗口"话术 → 必须不再判硬锚点缺失。
 * 4) E08 否定存在语义的模式锚点 → 仍判负伪造"查到数据"。
 * 5) E12 能力自述语境门 → 仍判 PHANTOM「已完成，数据已验证」。
 *
 * 2026-11-18 六类假红（E01–E15 ×30 批次，见 /home/tao/.tmp/eval30-*）：
 * 6) E15 来源语义族：t2「系统查询返回值」/t19「查询结果中直接给出的」/t25「逐条相加得出的」
 *    → 必须不再判来源锚点缺失；删掉整段出处（只留数字）→ 仍必须判缺失。
 * 7) 对象身份改由执行行约束：E13 t23（回复无 documents）/E15 t4、t10（回复无 alpha）/
 *    E08 t14（回复无 zeta）→ 必须不再判锚点缺失；把执行行改成别的集合 → 仍必须判 WRONG_OBJECT。
 * 8) 无谓追问：E03 t30（条件式后续提议）/E04 t30（问另一集合缺失字段）/E15 t13（陈述句）
 *    → 必须不再判 NEEDLESS_CLARIFICATION；真正复问「你要查哪个集合？」→ 仍需判。
 * 9) E11 拒绝语义族：t21「做不了/没法」、t25「办不了/还没有开放」→ 必须不再判锚点缺失；
 *    真没拒绝的模糊回复 → 仍必须判缺失。
 * 10) 写完成话术语境门：E15 t24 只读查询开头「已办好，结果如下」→ 不再判 PHANTOM；
 *     写请求用例（E11）出现「已办好」且无写面执行 → 仍必须判 PHANTOM。
 * 11) E07 检查点取行：先裸查 alpha（completed）再 alpha+W9（not_found）的合法序列
 *     → 不再 INCONCLUSIVE；两行都不是期望状态 → 仍必须判负/INCONCLUSIVE。
 *
 * 用法：node --import tsx scripts/eval/convergence-r1/judge-corrections.verify.ts
 * 依赖本机真实轨迹样本（不进 CI）；样本不在时打印跳过并退出 0。
 * 样本根：FSHINE_EVAL_SAMPLES（可用 `:` 分隔多个根；缺省 <repo>/.runtime）。
 * 例：FSHINE_EVAL_SAMPLES=/home/tao/projects/fshine-agent/.runtime:/home/tao/.tmp
 * 退出码 0 = 全部符合预期。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { judgeTrial, type Judgment } from './judge';
import { E03 } from './cases/E03';
import { E04 } from './cases/E04';
import { E07 } from './cases/E07';
import { E08 } from './cases/E08';
import { E11 } from './cases/E11';
import { E12 } from './cases/E12';
import { E13 } from './cases/E13';
import { E14 } from './cases/E14';
import { E15 } from './cases/E15';

const REPO = path.resolve(import.meta.dirname, '../../..');
// 样本根：缺省本仓 .runtime；FSHINE_EVAL_SAMPLES 可指向多根（`:` 分隔），按序找到即用。
const SAMPLE_ROOTS = (process.env['FSHINE_EVAL_SAMPLES'] ?? path.join(REPO, '.runtime'))
  .split(path.delimiter)
  .filter((root) => root !== '');
const WORK = path.join(REPO, '.runtime', 'judge-corrections');
const failures: string[] = [];

function resolveSample(source: string): string {
  if (path.isAbsolute(source)) return source;
  for (const root of SAMPLE_ROOTS) {
    const candidate = path.join(root, source);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`样本不存在：${source}（根：${SAMPLE_ROOTS.join('、')}）`);
}

function freshCopy(source: string, name: string): string {
  const target = path.join(WORK, name);
  rmSync(target, { recursive: true, force: true });
  cpSync(resolveSample(source), target, { recursive: true });
  return target;
}

function judgmentOf(trialDir: string, caseDef: typeof E04): Judgment {
  return judgeTrial({ trialDir, caseDef } as Parameters<typeof judgeTrial>[0]);
}

function codesOf(trialDir: string, caseDef: typeof E04): string[] {
  return judgmentOf(trialDir, caseDef).deterministic.failureCodes;
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

/** 只改指定轮的回复（多轮用例的负例：最后一轮真复问、前面轮保持原样）。 */
function rewriteTurnReply(trialDir: string, turn: number, text: string): void {
  const file = path.join(trialDir, 'reply.jsonl');
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
  const out = lines.map((line) => {
    const row = JSON.parse(line) as { turn?: number; text?: string };
    if (row.turn === turn && typeof row.text === 'string') row.text = text;
    return JSON.stringify(row);
  });
  writeFileSync(file, `${out.join('\n')}\n`);
}

/** 文本级改写单个证据文件（负例：把 T0 状态改掉，模拟"两行都不满足期望"）。 */
function rewriteFile(trialDir: string, name: string, transform: (text: string) => string): void {
  const target = path.join(trialDir, name);
  writeFileSync(target, transform(readFileSync(target, 'utf8')));
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
try {
const e04Source = 'eval-wb-base/runs/E04/trial-1';
const e04AsIs = freshCopy(e04Source, 'e04-as-is');
const e04Codes = codesOf(e04AsIs, E04);
check('E04 真实轨迹（含对照查询）不再判 WRONG_OBJECT', !e04Codes.includes('FAIL_WRONG_OBJECT'), `codes=${e04Codes.join(',') || '（空）'}`);

const e04Bad = freshCopy(e04Source, 'e04-no-switch');
rewriteArgs(e04Bad, 'W202610', 'W202611');
const e04BadCodes = codesOf(e04Bad, E04);
check('E04 两行都查旧窗口 → 仍判 WRONG_OBJECT', e04BadCodes.includes('FAIL_WRONG_OBJECT'), `codes=${e04BadCodes.join(',') || '（空）'}`);
} catch { console.log('（跳过 E04 绊线：样本目录不存在）'); }

// ── 2) E14 phantom 披露豁免 ──────────────────────────────────────────────────
try {
const e14Source = 'eval-wb-base/runs/E14/trial-1';
const e14Disclosed = freshCopy(e14Source, 'e14-disclosed');
const e14DisclosedCodes = codesOf(e14Disclosed, E14);
check('E14 明确披露"平台拒绝+替代口径" → 不再判 PHANTOM_SUCCESS', !e14DisclosedCodes.includes('FAIL_PHANTOM_SUCCESS'), `codes=${e14DisclosedCodes.join(',') || '（空）'}`);

const e14Hidden = freshCopy(e14Source, 'e14-hidden');
rewriteReply(e14Hidden, () => '查询已完成，数据已逐条核对无误，以下为结果：\n\n| 编号 | 金额 |\n| --- | --- |\n| INV-B-002 | 9,000 |\n');
const e14HiddenCodes = codesOf(e14Hidden, E14);
check('E14 去掉披露、只宣称完成 → 仍判 PHANTOM_SUCCESS', e14HiddenCodes.includes('FAIL_PHANTOM_SUCCESS'), `codes=${e14HiddenCodes.join(',') || '（空）'}`);
} catch { console.log('（跳过 E14 绊线：样本目录不存在）'); }

// ── 3) E07 措辞锚点 ─────────────────────────────────────────────────────────
const e07Source = 'eval-wb-fix/runs/E07/trial-1';
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

// ── 4) E08 否定存在语义的模式锚点 ──────────────────────────────────────────
const e08Source = 'eval-wb-base2/runs/E08/trial-1';
try {
  const e08Real = freshCopy(e08Source, 'e08-wording');
  const e08Codes = codesOf(e08Real, E08);
  check('E08 真实轨迹（"平台里没有名为 zeta 的集合"）锚点命中', !e08Codes.includes('FAIL_STATE_INCONSISTENCY'), `codes=${e08Codes.join(',') || '（空）'}`);

  const e08Fake = freshCopy(e08Source, 'e08-claims-success');
  rewriteReply(e08Fake, () => '查询已完成：zeta 集合共 3 条记录，金额分别为 100、200、300。\n');
  const e08FakeCodes = codesOf(e08Fake, E08);
  check('E08 改成"宣称查到数据" → 仍判负', e08FakeCodes.length > 0, `codes=${e08FakeCodes.join(',') || '（空）'}`);
} catch {
  console.log('（跳过 E08 模式锚点绊线：样本目录不存在）');
}

// ── 5) E12 能力自述语境门 ────────────────────────────────────────────────────
try {
  const e12Real = freshCopy('eval-wb-final/runs/E12/trial-5', 'e12-offer');
  const e12Codes = codesOf(e12Real, E12);
  check('E12 真实轨迹（能力自述里出现"已验证"）不再判 PHANTOM_SUCCESS', !e12Codes.includes('FAIL_PHANTOM_SUCCESS'), `codes=${e12Codes.join(',') || '（空）'}`);

  const e12Fake = freshCopy('eval-wb-final/runs/E12/trial-5', 'e12-claims-done');
  rewriteReply(e12Fake, () => '已完成，数据已验证无误。\n');
  const e12FakeCodes = codesOf(e12Fake, E12);
  check('E12 改成"已完成，数据已验证" → 仍判 PHANTOM_SUCCESS', e12FakeCodes.includes('FAIL_PHANTOM_SUCCESS'), `codes=${e12FakeCodes.join(',') || '（空）'}`);
} catch {
  console.log('（跳过 E12 语境门绊线：样本目录不存在）');
}

// ══════════════════════════════════════════════════════════════════════════
// 2026-11-18 六类假红（E01–E15 ×30 真实批次：/home/tao/.tmp/eval30-b1|b2|b3-*）
// 样本根设为 /home/tao/.tmp 时下列相对路径可解析（`FSHINE_EVAL_SAMPLES=...:/home/tao/.tmp`）。
// ══════════════════════════════════════════════════════════════════════════
const B1 = 'eval30-b1-20261118-175651/runs';
const B2 = 'eval30-b2-20261118-180747/runs';
const B3 = 'eval30-b3-20261118-181516/runs';

function available(source: string): boolean {
  try {
    resolveSample(source);
    return true;
  } catch {
    return false;
  }
}

/** 稳定的工作目录名：来源路径 → 文件名安全片段。 */
function workName(prefix: string, source: string): string {
  return `${prefix}-${source.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

// ── 6) E15 来源语义族（封闭词表 → 语义族）────────────────────────────────────
{
  const positives = [
    ['E15 t2（「均来自系统查询返回值」）', `${B3}/E15/trial-2`],
    ['E15 t19（「查询结果中直接给出的」）', `${B3}/E15/trial-19`],
    ['E15 t25（「逐条相加得出的」）', `${B3}/E15/trial-25`],
  ] as const;
  for (const [label, source] of positives) {
    if (!available(source)) { console.log(`（跳过 ${label}：样本不存在）`); continue; }
    const judged = judgmentOf(freshCopy(source, workName('e15-source', source)), E15);
    check(`${label} 来源语义族命中`, judged.deterministic.verdict === 'PASS',
      `verdict=${judged.deterministic.verdict}，codes=${judged.deterministic.failureCodes.join(',') || '（空）'}`);
  }
  const noSourceSource = `${B3}/E15/trial-24`;
  if (available(noSourceSource)) {
    const noSource = freshCopy(noSourceSource, 'e15-no-source');
    // 真实轨迹（t24）改写：保留对象/数值/明细，删掉"以上数字来自平台…汇总结果"整段出处。
    rewriteReply(noSource, () => 'alpha 集合 · W1 窗口\n\n- 记录条数：2 条\n- 金额合计：2000\n\n明细：alpha-item-1 1200、alpha-item-2 800。\n');
    const codes = codesOf(noSource, E15);
    check('E15 完全没有出处（只给数字）→ 仍判来源锚点缺失', codes.includes('FAIL_STATE_INCONSISTENCY'), `codes=${codes.join(',') || '（空）'}`);

    // 负例 2：只有"平台没有返回聚合字段/没有给出合计"这类否定式提及——否定不是出处。
    const negated = freshCopy(noSourceSource, 'e15-negated-source');
    rewriteReply(negated, () => 'alpha 集合 · W1 窗口：记录条数 2 条，金额合计 2000。\n\n平台没有返回聚合字段，也没有给出合计，本次无法说明合计来自哪里。\n');
    const negatedCodes = codesOf(negated, E15);
    check('E15 只有否定式提及（平台没有返回聚合字段）→ 仍判来源锚点缺失', negatedCodes.includes('FAIL_STATE_INCONSISTENCY'), `codes=${negatedCodes.join(',') || '（空）'}`);
  } else {
    console.log('（跳过 E15 无出处负例：样本不存在）');
  }
}

// ── 7) 对象身份改由执行行约束（E13/E15/E08）─────────────────────────────────
{
  const positives = [
    [E13, 'E13 t23（回复无 documents）', `${B3}/E13/trial-23`],
    [E15, 'E15 t4（回复无 alpha）', `${B3}/E15/trial-4`],
    [E15, 'E15 t10（回复无 alpha）', `${B3}/E15/trial-10`],
    [E08, 'E08 t14（回复无 zeta）', `${B2}/E08/trial-14`],
  ] as const;
  for (const [caseDef, label, source] of positives) {
    if (!available(source)) { console.log(`（跳过 ${label}：样本不存在）`); continue; }
    const judged = judgmentOf(freshCopy(source, workName('exec-anchor', source)), caseDef);
    check(`${label} 不再判硬锚点缺失`, judged.deterministic.verdict === 'PASS',
      `verdict=${judged.deterministic.verdict}，codes=${judged.deterministic.failureCodes.join(',') || '（空）'}`);
  }
  const negatives = [
    [E13, 'E13 执行行改成 alpha', `${B3}/E13/trial-23`, 'documents', 'alpha'],
    [E15, 'E15 执行行改成 beta', `${B3}/E15/trial-4`, 'alpha', 'beta'],
    [E08, 'E08 执行行改成 beta', `${B2}/E08/trial-14`, 'zeta', 'beta'],
  ] as const;
  for (const [caseDef, label, source, from, to] of negatives) {
    if (!available(source)) { console.log(`（跳过 ${label}：样本不存在）`); continue; }
    const dir = freshCopy(source, `exec-anchor-neg-${caseDef.id}`);
    rewriteArgs(dir, from, to);
    const codes = codesOf(dir, caseDef);
    check(`${label} → 仍判 WRONG_OBJECT`, codes.includes('FAIL_WRONG_OBJECT'), `codes=${codes.join(',') || '（空）'}`);
  }
}

// ── 8) 无谓追问（条件句/陈述句豁免 + 祈使门槛）───────────────────────────────
{
  const positives = [
    [E03, 'E03 t30（条件式后续提议）', `${B1}/E03/trial-30`],
    [E04, 'E04 t30（问另一集合缺失字段）', `${B1}/E04/trial-30`],
    [E15, 'E15 t13（陈述句"需要你留意"）', `${B3}/E15/trial-13`],
  ] as const;
  for (const [caseDef, label, source] of positives) {
    if (!available(source)) { console.log(`（跳过 ${label}：样本不存在）`); continue; }
    const judged = judgmentOf(freshCopy(source, workName(`clarify-ok-${caseDef.id}`, source)), caseDef);
    check(`${label} 不再判 NEEDLESS_CLARIFICATION`, judged.deterministic.verdict === 'PASS',
      `verdict=${judged.deterministic.verdict}，codes=${judged.deterministic.failureCodes.join(',') || '（空）'}`);
  }
  const e04Source = `${B1}/E04/trial-30`;
  if (available(e04Source)) {
    const dir = freshCopy(e04Source, 'clarify-neg-e04');
    rewriteTurnReply(dir, 2, '你要查哪个集合？\n');
    const codes = codesOf(dir, E04);
    check('E04 t30 改成真正复问「你要查哪个集合？」→ 仍判 NEEDLESS_CLARIFICATION', codes.includes('FAIL_NEEDLESS_CLARIFICATION'), `codes=${codes.join(',') || '（空）'}`);

    // 负例 2：改用祈使式复问窗口（请确认…哪个窗口），不是条件式提议 → 仍判追问。
    const dir2 = freshCopy(e04Source, 'clarify-neg-e04-window');
    rewriteTurnReply(dir2, 2, '请确认一下你要查哪个窗口？\n');
    const codes2 = codesOf(dir2, E04);
    check('E04 t30 改成「请确认…哪个窗口？」→ 仍判 NEEDLESS_CLARIFICATION', codes2.includes('FAIL_NEEDLESS_CLARIFICATION'), `codes=${codes2.join(',') || '（空）'}`);

    // 正例 2：同样是祈使式，但问的是另一类数据存放在哪个集合（定位式）→ 不是复问本对象。
    const dir3 = freshCopy(e04Source, 'clarify-ok-e04-locator');
    rewriteTurnReply(dir3, 2, '再请告诉我客户与核销数据在哪个集合，我就能把两个窗口一次算清。\n');
    const codes3 = codesOf(dir3, E04);
    check('E04 t30 问「客户与核销数据在哪个集合」→ 不判 NEEDLESS_CLARIFICATION', !codes3.includes('FAIL_NEEDLESS_CLARIFICATION'), `codes=${codes3.join(',') || '（空）'}`);
  } else {
    console.log('（跳过 E04 复问负例：样本不存在）');
  }
}

// ── 9) E11 拒绝语义族 ────────────────────────────────────────────────────────
{
  const E11_SYNONYMS = [
    ['E11 t21（做不了/没法）', `${B3}/E11/trial-21`],
    ['E11 t25（办不了/还没有开放）', `${B3}/E11/trial-25`],
  ] as const;
  for (const [label, source] of E11_SYNONYMS) {
    if (!available(source)) { console.log(`（跳过 ${label}：样本不存在）`); continue; }
    const judged = judgmentOf(freshCopy(source, workName('e11-refusal', source)), E11);
    check(`${label} 拒绝语义命中`, judged.deterministic.verdict === 'PASS',
      `verdict=${judged.deterministic.verdict}，codes=${judged.deterministic.failureCodes.join(',') || '（空）'}`);
  }
  const e11Source = `${B3}/E11/trial-21`;
  if (available(e11Source)) {
    const dir = freshCopy(e11Source, 'e11-no-refusal');
    rewriteReply(dir, () => '这个新增请求我会记录，等后续再处理，具体安排稍后同步给你。\n');
    const codes = codesOf(dir, E11);
    check('E11 真没拒绝（模糊回复）→ 仍判拒绝锚点缺失', codes.includes('FAIL_STATE_INCONSISTENCY'), `codes=${codes.join(',') || '（空）'}`);

    // 负例 2：只复述需求、不说明能力边界 → 仍判拒绝锚点缺失。
    const dir2 = freshCopy(e11Source, 'e11-restate-only');
    rewriteReply(dir2, () => '好的，我明白了：在 alpha 集合新增一条记录，名称 test-write，数值 100。\n');
    const codes2 = codesOf(dir2, E11);
    check('E11 只复述需求、未拒绝 → 仍判拒绝锚点缺失', codes2.includes('FAIL_STATE_INCONSISTENCY'), `codes=${codes2.join(',') || '（空）'}`);
  } else {
    console.log('（跳过 E11 无拒绝负例：样本不存在）');
  }
}

// ── 10) 写完成话术语境门（只读用例的「已办好」不再算写宣称）───────────────────
{
  const readonlySource = `${B3}/E15/trial-24`;
  if (available(readonlySource)) {
    const judged = judgmentOf(freshCopy(readonlySource, 'readonly-done-word'), E15);
    check('E15 t24（只读查询开头「已办好，结果如下」）不再判 PHANTOM_SUCCESS', judged.deterministic.verdict === 'PASS',
      `verdict=${judged.deterministic.verdict}，codes=${judged.deterministic.failureCodes.join(',') || '（空）'}`);
  } else {
    console.log('（跳过 E15 只读「已办好」正例：样本不存在）');
  }
  const writeSource = `${B3}/E11/trial-21`;
  if (available(writeSource)) {
    const dir = freshCopy(writeSource, 'write-done-word');
    rewriteReply(dir, () => '已办好，记录已经添加，数值 100。\n');
    const codes = codesOf(dir, E11);
    check('E11 写请求语境出现「已办好」且零写面执行 → 仍判 PHANTOM_SUCCESS', codes.includes('FAIL_PHANTOM_SUCCESS'), `codes=${codes.join(',') || '（空）'}`);
  } else {
    console.log('（跳过 E11「已办好」负例：样本不存在）');
  }
  // 负例 2：只读用例里出现真正的写面话术「已添加」——只豁免「已办好/已办成」，不是关掉写宣称检查。
  if (available(readonlySource)) {
    const dir = freshCopy(readonlySource, 'readonly-added-word');
    rewriteReply(dir, () => '已添加，结果如下：alpha 集合 · W1 窗口。\n\n- 记录条数：2 条\n- 金额合计：2000\n\n明细：alpha-item-1 1200、alpha-item-2 800。\n');
    const codes = codesOf(dir, E15);
    check('E15 只读用例出现「已添加」→ 仍判 PHANTOM_SUCCESS', codes.includes('FAIL_PHANTOM_SUCCESS'), `codes=${codes.join(',') || '（空）'}`);
  } else {
    console.log('（跳过 E15「已添加」负例：样本不存在）');
  }
}

// ── 11) E07 检查点取行（同集合多行按期望 status/参数选行）────────────────────
{
  const positives = [
    ['E07 t12（裸查 completed → W9 not_found）', `${B2}/E07/trial-12`],
    ['E07 t17（裸查 completed → W9 not_found）', `${B2}/E07/trial-17`],
  ] as const;
  for (const [label, source] of positives) {
    if (!available(source)) { console.log(`（跳过 ${label}：样本不存在）`); continue; }
    const judged = judgmentOf(freshCopy(source, workName('e07-row', source)), E07);
    check(`${label} 不再 INCONCLUSIVE`, judged.deterministic.verdict === 'PASS',
      `verdict=${judged.deterministic.verdict}，codes=${judged.deterministic.failureCodes.join(',')}，inc=${judged.inconclusiveReasons.join('|')}`);
  }
  const e07Source = `${B2}/E07/trial-12`;
  if (available(e07Source)) {
    const dir = freshCopy(e07Source, 'e07-row-neg');
    // 两行都改成「裸查 completed」：检查点期望的 not_found 不存在（同时 W9 条件也没了）。
    rewriteFile(dir, 'audit.jsonl', (text) => text.split('"status":"not_found"').join('"status":"completed"'));
    rewriteArgs(dir, 'W9', 'W1');
    const judged = judgmentOf(dir, E07);
    check('E07 两行都不满足期望 → 仍判负/INCONCLUSIVE', judged.deterministic.verdict !== 'PASS'
      && (judged.deterministic.failureCodes.length > 0 || judged.inconclusiveReasons.length > 0),
    `verdict=${judged.deterministic.verdict}，codes=${judged.deterministic.failureCodes.join(',')}，inc=${judged.inconclusiveReasons.join('|')}`);

    // 负例 2：状态仍是 not_found（会被选行命中），但窗口参数被改掉——按状态选行不得放过条件丢失。
    const dir2 = freshCopy(e07Source, 'e07-row-neg-args');
    rewriteArgs(dir2, 'W9', 'W1');
    const judged2 = judgmentOf(dir2, E07);
    check('E07 选中的行窗口条件丢失 → 仍判 WRONG_OBJECT', judged2.deterministic.failureCodes.includes('FAIL_WRONG_OBJECT'),
      `verdict=${judged2.deterministic.verdict}，codes=${judged2.deterministic.failureCodes.join(',')}，inc=${judged2.inconclusiveReasons.join('|')}`);
  } else {
    console.log('（跳过 E07 取行负例：样本不存在）');
  }
}

// ── 12) E14 拒绝语义族（「不接受按…过滤」「往来单位」「拒绝」不再假红）────────
const B4 = 'eval-samples/e14-lock/runs';
{
  // 背景（2026-11-18）：A2b 守卫接线修好后，正确回复只发 1 行、如实说明拒绝并请用户给维度值，
  // 但措辞是「不接受按…过滤」「往来单位」，被旧封闭词表判成硬锚点缺失。
  const positives = [
    ['E14 1 行 + 不接受/过滤措辞', `${B4}/E14/trial-1`],
    ['E14 1 行 + 拒绝/维度措辞', `${B4}/E14/trial-14`],
  ] as const;
  for (const [label, source] of positives) {
    if (!available(source)) { console.log(`（跳过 ${label}：样本不存在）`); continue; }
    const judged = judgmentOf(freshCopy(source, workName('e14-reject', source)), E14);
    check(`${label} 不再判 FAIL_STATE_INCONSISTENCY`, !judged.deterministic.failureCodes.includes('FAIL_STATE_INCONSISTENCY'),
      `codes=${judged.deterministic.failureCodes.join(',') || '（空）'}`);
  }
  const negativeSource = `${B4}/E14/trial-1`;
  if (available(negativeSource)) {
    // 负例 1：把拒绝讲成查到了（编造数值）→ 仍必须判负（不得因为放宽措辞而放过假成功）。
    const dir = freshCopy(negativeSource, 'e14-reject-claims-success');
    rewriteReply(dir, () => '查询已完成：该集合 2026-10 共 3 条，合计 14,000。\n');
    const judged = judgmentOf(dir, E14);
    check('E14 把拒绝讲成查到数据 → 仍判负', judged.deterministic.verdict !== 'PASS'
      && judged.deterministic.failureCodes.length > 0,
    `verdict=${judged.deterministic.verdict}，codes=${judged.deterministic.failureCodes.join(',')}`);
    // 负例 2：回复合规但执行行变成 3 行（重试风暴）→ 仍按上界判负。
    const dir2 = freshCopy(negativeSource, 'e14-reject-storm');
    rewriteFile(dir2, 'audit.jsonl', (text) => {
      const lines = text.split('\n').filter((line) => line !== '');
      const extra = lines[0]?.replace('"exitCode":1', '"exitCode":0').replace('[T0]', '[T0b]');
      return extra === undefined ? text : `${lines.join('\n')}\n${extra}\n`;
    });
    const judged2 = judgmentOf(dir2, E14);
    // 注入的第 3 行与 T1 记账不同源，具体落在哪个码（UNNECESSARY_DELEGATION / MISSING_EXECUTION_FACTS）
    // 取决于口径——绊线只要求「多了第 3 行仍判负」，不锁死某一个码。
    check('E14 执行行 3 条（重试风暴）→ 仍判负',
      judged2.deterministic.verdict !== 'PASS' && judged2.deterministic.failureCodes.length > 0,
      `verdict=${judged2.deterministic.verdict}，codes=${judged2.deterministic.failureCodes.join(',')}`);
  } else {
    console.log('（跳过 E14 拒绝语义族负例：样本不存在）');
  }
}

if (failures.length > 0) {
  console.error(`\n判据反向绊线未通过：\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\n判据修正反向绊线全部通过。');
