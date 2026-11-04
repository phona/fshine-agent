#!/usr/bin/env node
/**
 * 跨仓预算阈值漂移校验（debt/second-truth，主题 3a）。
 *
 * 为什么是校验而不是删一处：两份阈值各有不可删的执法位——
 *   · fshine `packages/agent/src/budget-policy.ts` 的 DEFAULT_BUDGET_THRESHOLDS
 *     是宿主叠加档（stricterTier）的依据；删了它，宿主对平台 decision 就无档可叠，
 *     更严一档的防线消失。
 *   · 17dz `src/execution/plan.js` 的 policy() 缺省是平台执行端门（evaluate 裁档、
 *     reserveInvocation / finishInvocation 的硬上限复核）；删了它，执行端防线消失。
 * 所以两处都保留，漂移由本脚本机械发现，不一致即红（exit 1），解析不到即 fail（exit 2）。
 *
 * 只比对 12 个共用阈值。17dz policy() 另有 4 个平台门专属项（grindGap 30、
 * maxNotify 3、maxReplans 8、maxVariants 3），宿主叠加档不实现磨大守卫与变体
 * 预算，故有意不镜像——它们不是漂移项，改动它们不触发本脚本。
 *
 * 用法：
 *   node scripts/cross-repo/check-budget-thresholds.mjs <17dz 检出根目录>
 *   CROSS_REPO_17DZ_ROOT=<17dz 检出根目录> node scripts/cross-repo/check-budget-thresholds.mjs
 *   node scripts/cross-repo/check-budget-thresholds.mjs <17dz 根> --fshine-root <fshine 根>
 * （--fshine-root 只供测试夹具用；正常运行 fshine 根取本脚本所在仓库。）
 * 本脚本不读、不写任何业务状态，不联网，不改两个仓库的任何文件。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUDGET_KEYS = [
  'autoCalls', 'notifyCalls', 'confirmCalls', 'hardCalls',
  'autoSeconds', 'notifySeconds', 'confirmSeconds', 'hardSeconds',
  'autoWeight', 'notifyWeight', 'budgetWeight', 'hardWeight',
];

const DZ_ENV = {
  autoCalls: 'EXECUTION_PLAN_AUTO_CALLS',
  notifyCalls: 'EXECUTION_PLAN_NOTIFY_CALLS',
  confirmCalls: 'EXECUTION_PLAN_CONFIRM_CALLS',
  hardCalls: 'EXECUTION_PLAN_HARD_CALLS',
  autoSeconds: 'EXECUTION_PLAN_AUTO_SECONDS',
  notifySeconds: 'EXECUTION_PLAN_NOTIFY_SECONDS',
  confirmSeconds: 'EXECUTION_PLAN_CONFIRM_SECONDS',
  hardSeconds: 'EXECUTION_PLAN_HARD_SECONDS',
  autoWeight: 'EXECUTION_PLAN_AUTO_WEIGHT',
  notifyWeight: 'EXECUTION_PLAN_NOTIFY_WEIGHT',
  budgetWeight: 'EXECUTION_PLAN_BUDGET_WEIGHT',
  hardWeight: 'EXECUTION_PLAN_HARD_WEIGHT',
};

function parseFshine(text, file) {
  const block = text.match(/DEFAULT_BUDGET_THRESHOLDS[^=]*=\s*\{([^}]+)\}/);
  if (!block) throw new Error(`fshine 阈值块未找到：${file}`);
  const out = {};
  for (const key of BUDGET_KEYS) {
    const m = block[1].match(new RegExp(`\\b${key}\\s*:\\s*(\\d+)`));
    if (!m) throw new Error(`fshine 缺阈值 ${key}：${file}`);
    out[key] = Number(m[1]);
  }
  return out;
}

function parseDz(text, file) {
  const out = {};
  for (const key of BUDGET_KEYS) {
    const m = text.match(new RegExp(`\\b${key}\\s*:\\s*configured\\(env,\\s*'${DZ_ENV[key]}',\\s*(\\d+)\\)`));
    if (!m) throw new Error(`17dz 缺阈值 ${key}（${DZ_ENV[key]}）：${file}`);
    out[key] = Number(m[1]);
  }
  return out;
}

export function compareBudgetThresholds(fshineRoot, dzRoot) {
  const fshineFile = path.join(fshineRoot, 'packages/agent/src/budget-policy.ts');
  const dzFile = path.join(dzRoot, 'src/execution/plan.js');
  const fshine = parseFshine(readFileSync(fshineFile, 'utf8'), fshineFile);
  const dz = parseDz(readFileSync(dzFile, 'utf8'), dzFile);
  const mismatches = BUDGET_KEYS.filter((k) => fshine[k] !== dz[k])
    .map((k) => ({ key: k, fshine: fshine[k], dz: dz[k] }));
  return { fshine, dz, mismatches };
}

function main(argv) {
  const args = [...argv];
  let fshineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  let dzRoot = process.env.CROSS_REPO_17DZ_ROOT || null;
  let positionalSeen = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--fshine-root') fshineRoot = path.resolve(args[++i]);
    else if (!args[i].startsWith('--') && !positionalSeen) { dzRoot = path.resolve(args[i]); positionalSeen = true; }
    else { console.error(`未知参数：${args[i]}`); return 2; }
  }
  if (!dzRoot) {
    console.error('用法：node scripts/cross-repo/check-budget-thresholds.mjs <17dz 检出根目录> [--fshine-root <fshine 根>]');
    console.error('或设环境变量 CROSS_REPO_17DZ_ROOT=<17dz 检出根目录>。未给 17dz 根时拒绝静默通过。');
    return 2;
  }
  let result;
  try {
    result = compareBudgetThresholds(fshineRoot, dzRoot);
  } catch (e) {
    console.error(`预算阈值校验失败（解析不到即 fail）：${e.message}`);
    return 2;
  }
  for (const k of BUDGET_KEYS) console.log(`${k}: fshine=${result.fshine[k]} 17dz=${result.dz[k]}${result.fshine[k] === result.dz[k] ? '' : '  <-- 不一致'}`);
  if (result.mismatches.length) {
    console.error(`预算阈值漂移 ${result.mismatches.length} 项：${result.mismatches.map((m) => `${m.key}(fshine=${m.fshine},17dz=${m.dz})`).join('、')}——两仓改阈值必须同批改，否则宿主叠加档与平台门在缺省配置下不再同口径。`);
    return 1;
  }
  console.log('预算阈值 12/12 一致。');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
