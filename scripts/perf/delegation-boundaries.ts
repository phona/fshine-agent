/**
 * 性能评测 · 委派边界量化：同任务的追加查询白花了多少次委派边界。
 *
 * 成本模型（analyze.ts B 段实测）：每开一次 worker 委派会话 ≈ +31s（贵在 worker 会话的
 * 模型轮次，不在平台调用本身，同一委派内追加一次平台调用仅 +2s）。因此"同一任务连续
 * 多次委派"里，除第一次外的每次委派都在为同一个任务重复支付这笔边界钱——它们本可以
 * 扩当前计划（计划模式多步）而不是新开委派。
 *
 * 判据（机械部分可复算，语义部分尽力而为）：
 *   - delegate 轮：该轮 turns[i].calls >= 1。平台调用只发生在 worker 会话里，calls>=1
 *     即本轮发生过委派（与 analyze.ts 的"委派边界边际 = 1调用−0调用"同一口径）。
 *     calls 字段缺失的轮次（2026-09-25 旧批次，25 个文件）机械上不可判定，跳过并单独
 *     报数——宁少报不多报。
 *   - 可合并对（机械）：同一探针 result 内，相邻两轮 i、i+1 都是 delegate 轮。一段连续
 *     delegate 轮的首轮是合法边界，其后每一轮都是"非首连续段"——为同任务重复开了边界。
 *   - 语义分层（尽力而为，只影响细分类别、不影响机械对数）：看 i+1 轮的用户消息——
 *       重发同题   文本与本 result 更早某轮完全相同（重发场景的机械形态）
 *       改口重定向 以 算了/不对/不是/取消 开头（仍在原任务附近，但属于用户改主意，
 *                  是否可合并取决于执行层能否改计划，单独列出不计入"干净追加"）
 *       追加/扩范围 显式追加词（再查/顺便/继续/还是看/也看…）、承前追问（那…/…呢？）、
 *                  维度扩展（按客户拆/上个月）——目标行为"扩当前计划"的最干净对象
 *       澄清应答   槽位补全式的短答（"幻辰财税，本月""好，先查幻辰财税吧"）——计划
 *                  因澄清暂停后重入，多半是合法重入而非浪费
 *       新题/其他  其余（新任务混在相邻 delegate 之间，本就不该合并）
 *   首个命中的类别生效，判据顺序即优先级。
 *
 * 只读分析，不改动任何被测对象；没有探针文件时报零并退出。
 * 用法：node --import tsx scripts/perf/delegation-boundaries.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根 = scripts/perf/delegation-boundaries.ts 上三级（与 analyze.ts 的锚定同法；
// 不用 import.meta.dirname——它在 tsx 的 --import 接线下不可靠）。
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const runtimeDir = path.join(repoRoot, '.runtime');

/** 每开一次 worker 委派会话的边际成本（analyze.ts B 段最新批实测中位）。 */
const BOUNDARY_COST_S = 31;

// ── 语义分层（尽力而为）───────────────────────────────────────────────
// 判据顺序即优先级：重发 > 改口 > 追加 > 澄清应答 > 其他。正则只看 i+1 轮的用户消息。
type SemanticClass = '重发同题' | '改口重定向' | '追加/扩范围' | '澄清应答' | '新题/其他';

const APPEND_RES = [
  /再(帮|查|看|问|来|次|跑|说|算)/, // 再查一次 / 再帮我看看
  /顺便/, // 顺便帮我看看…
  /(继续|接着)(刚才|刚才的|查|看|核对)?/, // 继续 / 好，继续刚才的核对
  /还是(查|看|回|问)/, // 还是看回幻辰财税吧
  /也(看|查|帮|问|有|把)/, // 那把 202607 也看一下
  /按.{1,8}(拆|分)|拆(一下|开|分)/, // 按客户拆一下吧
  /^(对了|等等)/, // 话头折回同一任务
  /(上个月|上月|上期|往前)/, // 同对象时间平移：它上个月呢
  /^那(把|它|么|家|笔|个|就|我|这)?/, // 那新兴五金…呢 / 那供应商呢
  /呢[?？]?\s*$/, // 省略式续问：202608 呢
  /^.{0,12}(呢|吗)[?？]\s*$/, // 有异常的吗？
];
const isAppend = (t: string): boolean => APPEND_RES.some((re) => re.test(t));

const REDIRECT_RE = /^(算了|不对|不是|取消|换一个|不查)/;
const CLARIFY_RES = [
  /^(好|行|嗯|哦|ok|OK)[,，，!！.。\s]/, // 好，先查幻辰财税吧
  /^.{1,10}[，,].{1,10}$/, // 幻辰财税，本月（槽位补全式短答）
  /^(只(列|看|查))?.{1,8}的$/, // 幻辰财税的 / 202609 的 / 只列 202609 的（承前槽位）
  /^第[一二三两\d]+[个步就查笔]/, // 第二个（消歧应答）
];

function classify(text: string, earlierTexts: string[]): SemanticClass {
  const t = text.trim();
  if (earlierTexts.includes(t)) return '重发同题';
  if (REDIRECT_RE.test(t)) return '改口重定向';
  if (isAppend(t)) return '追加/扩范围';
  if (CLARIFY_RES.some((re) => re.test(t))) return '澄清应答';
  return '新题/其他';
}

// ── 扫描 ──────────────────────────────────────────────────────────────
interface Pair {
  file: string;
  date: string;
  resultId: string;
  turnIdx: number; // i+1 轮（非首段那一轮，1 起）
  text: string; // i+1 轮用户消息
  klass: SemanticClass;
}

interface Scan {
  files: number;
  results: number;
  judgedTurns: number;
  delegateTurns: number;
  unjudgedTurns: number; // calls 字段缺失（旧批次），机械不可判定
  pairs: Pair[];
}

function scan(): Scan {
  const files = fs.existsSync(runtimeDir)
    ? fs.readdirSync(runtimeDir).filter((f) => /^probe-fshine-probe-.+\.json$/.test(f)).sort()
    : [];
  const out: Scan = { files: 0, results: 0, judgedTurns: 0, delegateTurns: 0, unjudgedTurns: 0, pairs: [] };
  for (const f of files) {
    let j: { at?: string; results?: Array<{ id?: string; turns?: Array<{ text?: string; calls?: number }> }> };
    try { j = JSON.parse(fs.readFileSync(path.join(runtimeDir, f), 'utf8')); } catch { continue; }
    out.files++;
    for (const r of j.results ?? []) {
      const turns = r.turns ?? [];
      if (!turns.length) continue;
      out.results++;
      const earlierTexts: string[] = [];
      let prevDelegateIdx: number | null = null; // 连续段里的上一 delegate 轮（0 起）；非 delegate 轮断开连续段
      turns.forEach((t, idx) => {
        out.judgedTurns++;
        const isDelegate = (t.calls ?? 0) >= 1;
        if (t.calls === undefined) {
          // calls 缺失 = 旧批次没记平台调用数：不可判定，且打断连续段（宁少报不多报）
          out.unjudgedTurns++;
          prevDelegateIdx = null;
          return;
        }
        if (isDelegate) {
          out.delegateTurns++;
          if (prevDelegateIdx !== null) {
            out.pairs.push({
              file: f, date: (j.at || '').slice(0, 10), resultId: r.id ?? '?', turnIdx: idx + 1,
              text: (t.text ?? '').trim(), klass: classify(t.text ?? '', earlierTexts),
            });
          }
          prevDelegateIdx = idx;
        } else {
          prevDelegateIdx = null;
        }
        earlierTexts.push((t.text ?? '').trim());
      });
    }
  }
  return out;
}

// ── 报告 ──────────────────────────────────────────────────────────────
function report(s: Scan): void {
  if (!s.files) { console.log('── 委派边界：.runtime 下没有探针 json，跳过（先跑 eval:probe）──'); return; }
  console.log('── 委派边界量化（同任务追加查询：扩当前计划 vs 新开委派）──');
  console.log(`数据：${s.files} 个探针文件 / ${s.results} 个 result / ${s.judgedTurns} 轮可判定`
    + (s.unjudgedTurns ? `（另有 ${s.unjudgedTurns} 轮无 calls 字段，2026-09-25 旧批次，跳过）` : ''));

  console.log(`\n总边界数（delegate 轮，每次开 worker 会话 ≈ +${BOUNDARY_COST_S}s）：${s.delegateTurns}`);
  console.log(`可合并对数（机械判据：同一 result 内相邻 delegate-delegate，"非首连续段"）：${s.pairs.length}`);
  console.log(`  → 机械上限：${s.pairs.length} 对 × ${BOUNDARY_COST_S}s ≈ ${(s.pairs.length * BOUNDARY_COST_S / 60).toFixed(0)} 分钟重复支付的边界`);

  const classes: SemanticClass[] = ['追加/扩范围', '重发同题', '改口重定向', '澄清应答', '新题/其他'];
  const byClass = new Map<SemanticClass, Pair[]>();
  for (const p of s.pairs) {
    if (!byClass.has(p.klass)) byClass.set(p.klass, []);
    byClass.get(p.klass)!.push(p);
  }
  console.log('\n语义分层（尽力而为，判据见文件头注释）：');
  for (const k of classes) {
    const ps = byClass.get(k) ?? [];
    console.log(`  ${k.padEnd(6)} ${String(ps.length).padStart(3)} 对${k === '追加/扩范围' ? `  ← 干净可合并对象，≈ ${(ps.length * BOUNDARY_COST_S / 60).toFixed(0)} 分钟` : ''}`);
  }

  console.log('\n按探针分组明细（对 = T{n}，括号内为 i+1 轮用户消息截断）：');
  const byFile = new Map<string, Pair[]>();
  for (const p of s.pairs) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file)!.push(p);
  }
  for (const [f, ps] of byFile) {
    console.log(`  ${f} (${ps[0]!.date})`);
    for (const p of ps) {
      const brief = p.text.length > 34 ? `${p.text.slice(0, 34)}…` : p.text;
      console.log(`    ${p.resultId.padEnd(4)} T${p.turnIdx} [${p.klass}] ${brief}`);
    }
  }
}

report(scan());
