/**
 * 性能评测 · 报告：两个维度一张报告。
 *
 *   A. 测试套件耗时分布——读 .runtime/perf/suite-r*.log（run-suite.ts 的产物），回答
 *      "测试时间花在哪个功能模块、哪些文件、稳不稳"。测试耗时分布反映的是测试怎么写
 *      （真实时钟、真 spawn CLI），不是系统运行热点——读数时要带着这个前提。
 *   B. 真实链路延迟画像——读 .runtime/ 下的 probe-fshine-probe-*.json（eval:probe 的
 *      产物，每轮带真实 ms 与平台调用数），回答"系统真实一轮多快、钱花在哪、长会话
 *      衰不衰减、尾部有多长"。
 *
 * 两边都不改动任何被测对象，纯只读分析；没有日志时 A 段跳过，B 段随时可出。
 *
 * 用法：node --import tsx scripts/perf/analyze.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根 = scripts/perf/analyze.ts 上三级（与 packages/core/config.ts 的锚定同法；
// 不用 import.meta.dirname——它在 tsx 的 --import 接线下不可靠）。
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const perfDir = path.join(repoRoot, '.runtime', 'perf');

// ── 功能模块映射（测试文件 → 功能模块，前缀规则按序匹配，specific 在前）────
// 这是分析口径不是产品口径：一个文件横两个模块时归主责模块。改映射不改结论方向，
// 只改归属百分比。
const MODULE_RULES: Array<[RegExp, string]> = [
  [/channel-wecom|notice-handler|attachments|adapter|text\.test/, '渠道接入（收发/附件/呈现帧）'],
  [/progress-frames|phone-incident|recall-facts|step-text|error-codes|operation-labels/, '呈现与召回纪律'],
  [/handler\.test|business-skill/, '回合处理与装配（server）'],
  [/routing|input-shape-variants|turn-contract|reference-evidence/, '申报路由与回合契约'],
  [/context|memory|long-memory|session-entities|history-tools|turn-persistence|turn-state|turn-relay|scratch-cleanup/, '上下文·指代·记忆'],
  [/plan-gate|plan-runtime|plan-mode|plan-binding|plan-facts|plan-steps|plan-confirmation|task-plan|plan-shape-fuzz|plan-teaching|plan-awareness|confirmation|plan-replay|plan-reject|concurrent|pingpong|interleaved|disambiguation|needs|activated-plan|resume|local-fake/, '计划门·预算·长任务'],
  [/write|proposal|commit/, '写链路（提案→确认→落账）'],
  [/security|serve-gate|leak-lint|executor-bypass|docs-reality|architecture-shape|platform-entities/, '安全与越权防线'],
  [/delegation-failure|platform-health|worker-timeout|platform-contract|platform-mock/, '失败降级与健康'],
  [/long-session-invariants/, '长会话不变量'],
  [/dims|judge|score|eval/, '评测基建（L7）'],
  [/store\.test|config\.test|memory-records/, '存储与配置'],
  [/skills|turn-exit|runtime\.test|pi-|driver/, '编排主链与驱动'],
];
const moduleOf = (f: string) => MODULE_RULES.find(([re]) => re.test(f))?.[1] ?? '其他';
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// ── A 段：套件耗时 ────────────────────────────────────────────────────
interface FileStat { area: string; tests: number; ms: number[] }

function analyzeSuite(): void {
  const logs = fs.existsSync(perfDir)
    ? fs.readdirSync(perfDir).filter(f => /^suite-r\d+\.log$/.test(f)).sort()
    : [];
  if (!logs.length) {
    console.log('── A. 套件耗时：没有 .runtime/perf/suite-r*.log，跳过（先跑 perf:suite）──\n');
    return;
  }
  const all: Record<string, FileStat> = {};
  const internals: string[] = [];
  for (const log of logs) {
    const text = fs.readFileSync(path.join(perfDir, log), 'utf8');
    for (const m of text.matchAll(/[✓✗❌×] \|(\w+)\| (\S+\.test\.ts) \((\d+) tests\) (\d+)ms/g)) {
      (all[m[2]] = all[m[2]] || { area: m[1], tests: +m[3], ms: [] }).ms.push(+m[4]);
    }
    const d = text.match(/Duration\s+([\d.]+)s \(transform ([\d.]+)s, setup (\d+)ms, collect ([\d.]+)s, tests ([\d.]+)s, environment (\d+)ms, prepare ([\d.]+)s\)/);
    if (d) internals.push(`总 ${d[1]}s = 并行测试 ${d[5]}s + 收集 ${d[4]}s + 准备 ${d[7]}s + 转换 ${d[2]}s`);
  }
  console.log('── A. 套件耗时分布 ──');
  console.log(`每轮 vitest 内部：\n  ${internals.join('\n  ')}`);
  const rows = Object.entries(all).map(([f, s]) => ({
    f, tests: s.tests,
    mean: s.ms.reduce((a, b) => a + b, 0) / s.ms.length,
    spread: Math.max(...s.ms) - Math.min(...s.ms),
  }));
  const grand = rows.reduce((s, r) => s + r.mean, 0);
  const byModule: Record<string, { ms: number; tests: number; files: number; e2eMs: number }> = {};
  for (const r of rows) {
    const mod = moduleOf(r.f);
    byModule[mod] = byModule[mod] || { ms: 0, tests: 0, files: 0, e2eMs: 0 };
    byModule[mod].ms += r.mean; byModule[mod].tests += r.tests; byModule[mod].files++;
    if (r.f.startsWith('tests/')) byModule[mod].e2eMs += r.mean;
  }
  console.log('\n按功能模块（文件耗时求和，' + logs.length + ' 轮均值，串行口径）：');
  for (const [mod, v] of Object.entries(byModule).sort((a, b) => b[1].ms - a[1].ms)) {
    console.log(`  ${mod.padEnd(24)} ${String(v.files).padStart(2)}文件 ${String(v.tests).padStart(4)}例 ${v.ms.toFixed(0).padStart(7)}ms (${(100 * v.ms / grand).toFixed(1)}%)  [e2e ${v.e2eMs.toFixed(0)}]`);
  }
  console.log(`  ${'合计'.padEnd(24)} ${String(rows.length).padStart(2)}文件 ${String(rows.reduce((s, r) => s + r.tests, 0)).padStart(4)}例 ${grand.toFixed(0)}ms`);
  console.log('\n最慢 10 个文件（均值 ms，±=轮间极差/2）：');
  for (const r of rows.sort((a, b) => b.mean - a.mean).slice(0, 10)) {
    console.log(`  ${r.mean.toFixed(0).padStart(6)} (±${(r.spread / 2).toFixed(0)}) ${String(r.tests).padStart(3)}例  ${r.f}`);
  }
  const worst = rows.sort((a, b) => b.spread - a.spread)[0];
  console.log(`轮间波动最大：${worst.f}（极差 ${worst.spread}ms）——极差秒级以上才算 flake 嫌疑`);
  console.log('');
}

// ── B 段：真实链路延迟 ────────────────────────────────────────────────
interface Turn { date: string; id: string; idx: number; ms: number; calls: number; replyLen: number }

function analyzeProbes(): void {
  const turns: Turn[] = [];
  const runs: Array<{ date: string; id: string; n: number }> = [];
  for (const f of fs.readdirSync(path.join(repoRoot, '.runtime')).filter(f => /^probe-fshine-probe-.+\.json$/.test(f))) {
    let j: { at?: string; results?: Array<{ id: string; turns?: Array<{ ms?: number; calls?: number; reply?: string }> }> };
    try { j = JSON.parse(fs.readFileSync(path.join(repoRoot, '.runtime', f), 'utf8')); } catch { continue; }
    const date = (j.at || '').slice(0, 10);
    for (const r of j.results ?? []) {
      (r.turns ?? []).forEach((t, idx) => turns.push({
        date, id: r.id, idx: idx + 1, ms: t.ms ?? 0, calls: t.calls ?? 0, replyLen: (t.reply ?? '').length,
      }));
      if ((r.turns ?? []).length) runs.push({ date, id: r.id, n: (r.turns ?? []).length });
    }
  }
  if (!turns.length) { console.log('── B. 真实链路：.runtime 下没有探针 json，跳过（先跑 eval:probe）──'); return; }
  const latest = turns.reduce((acc, t) => t.date > acc ? t.date : acc, '');
  console.log('── B. 真实链路延迟画像（真 LLM + mock 执行器）──');
  console.log(`数据：${runs.length} 个探针实例 / ${turns.length} 轮，最新标定批 ${latest}`);

  const byId: Record<string, number[]> = {};
  for (const t of turns.filter(t => t.date === latest)) (byId[t.id] = byId[t.id] || []).push(t.ms);
  console.log('\n最新批分场景（每轮中位）：');
  for (const [id, ms] of Object.entries(byId).sort()) console.log(`  ${id.padEnd(4)} n=${String(ms.length).padStart(2)}  中位 ${(median(ms) / 1000).toFixed(1)}s  范围 ${(Math.min(...ms) / 1000).toFixed(0)}-${(Math.max(...ms) / 1000).toFixed(0)}s`);

  const byCalls: Record<number, number[]> = {};
  for (const t of turns.filter(t => t.date === latest)) (byCalls[t.calls] = byCalls[t.calls] || []).push(t.ms);
  console.log('\n成本模型（按平台调用数分组，中位）：');
  for (const [c, ms] of Object.entries(byCalls).sort((a, b) => +a[0] - +b[0])) {
    console.log(`  ${c} 次调用: n=${String(ms.length).padStart(2)}  中位 ${(median(ms) / 1000).toFixed(1)}s`);
  }
  const zc = byCalls[0] ?? [], oc = byCalls[1] ?? [];
  if (zc.length && oc.length) console.log(`  → 委派边界边际（1调用−0调用）：${((median(oc) - median(zc)) / 1000).toFixed(1)}s；贵在 worker 会话的模型轮次，不在平台调用本身`);

  // 长会话组内对照（≥12 轮实例：前 5 轮 vs 末 5 轮中位，消除场景混合偏差）
  const longRuns: Record<string, Record<number, number>> = {};
  for (const t of turns) {
    if (t.idx > 20) continue;
    const key = `${t.date}-${t.id}`;
    const count = runs.filter(r => r.date === t.date && r.id === t.id && r.n >= 12).length;
    if (!count) continue;
    (longRuns[key] = longRuns[key] || {})[t.idx] = t.ms;
  }
  console.log('\n长会话组内对照（≥12 轮实例，前5轮 vs 末5轮中位）：');
  let slower = 0, total = 0;
  for (const [key, byIdx] of Object.entries(longRuns)) {
    const idxs = Object.keys(byIdx).map(Number).sort((a, b) => a - b);
    if (idxs.length < 12) continue;
    const head = median(idxs.slice(0, 5).map(i => byIdx[i]));
    const tail = median(idxs.slice(-5).map(i => byIdx[i]));
    total++;
    if (tail > head) slower++;
    console.log(`  ${key.padEnd(14)} ${idxs.length}轮  ${((head) / 1000).toFixed(1)}s → ${((tail) / 1000).toFixed(1)}s  ${tail > head ? '变慢' : '变快/持平'}`);
  }
  console.log(`  → ${total} 个长会话实例中 ${slower} 个末段变慢：${slower === 0 ? '上下文装配没有随轮数增长变慢（压缩/裁剪有效）' : '存在衰减，值得查'}`);

  const sorted = turns.map(t => t.ms).sort((a, b) => a - b);
  const pct = (p: number) => (sorted[Math.floor(sorted.length * p)] / 1000).toFixed(1);
  console.log(`\n全历史 ${sorted.length} 轮：p50=${pct(0.5)}s  p90=${pct(0.9)}s  p99=${pct(0.99)}s  max=${(sorted[sorted.length - 1] / 1000).toFixed(0)}s`);
  console.log('最慢 5 轮（尾部来自多步/纠错的重规划循环）：');
  for (const t of [...turns].sort((a, b) => b.ms - a.ms).slice(0, 5)) {
    console.log(`  ${(t.ms / 1000).toFixed(0).padStart(3)}s  ${t.date} ${t.id} 第${t.idx}轮 平台调用${t.calls} 回复${t.replyLen}字`);
  }
}

analyzeSuite();
analyzeProbes();
