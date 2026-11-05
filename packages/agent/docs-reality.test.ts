import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKER_TOOLS } from './src/pi-coding-driver';
import { workerSystemPrompt } from './src/context';

/**
 * 文档-代码对账守卫（docs-reality）——律法/台账的可判主张必须与代码现实一致。
 *
 * 起因（2026-10-16 对账实证的四起漂移，见 architecture-laws 执行纪律 4）：
 *   ① `pi-coding-driver.ts` 头注释写 "read/bash/grep/find/ls"，实际工具面已两度变更未跟；
 *   ② L1 引用 `runtime.ts:1260`，实际在 1169 行——runtime 拆分后行号全体位移；
 *   ③ L1 引用违例于 `runtime.ts:1539`，而现文件只有 1221 行（引用指向拆分前的旧文件）；
 *   ④ L4 仍把 `context.ts:360` 借贷合计 / `ChangeIntentRecord` 业务字段列为"当前违例"，
 *      而 D 波 `3e5a36c` 已将写路径收敛为唯一形态——代码已好、账未关。
 * 根因：这些主张是散文，散文没有谓词，"主张已假"因此不可见。本文件把对账变成机械断言。
 *
 * 三种断言方向（新增关账条目时按阶段挂入）：
 *   ① 已关账判据持续满足 —— 翻红 = 闭环失效（回归守卫）；
 *   ② 防御排除不得失踪 —— 翻红 = 某道防线被删（L1 标签制度的事务性落实）；
 *   ③ 双写断言 —— 同一事实只许一个来源，第二处出现即红。
 * 反方向（"当前违例必须仍在场"）暂无在册条目：登记新违例时在此追加，违例消失而
 * 账未关即红——那正是本守卫要逼出的"文档过时"事件。
 *
 * 范围：只扫 packages 各包 src 目录 + apps/server 的非测试 .ts（与 L1 leak-lint 同范围）。
 * `scripts/` 刻意排除——验收夹具的领域词是测试数据（D-005 附条 / D-006 挂"遗留待清"）。
 */

const ROOT = join(__dirname, '..', '..');
const SRC_DIRS = [
  'packages/agent/src',
  'packages/core/src',
  'packages/contracts/src',
  'packages/channel-wecom/src',
  'apps/server',
];

function tsFiles(relDir: string): string[] {
  const abs = join(ROOT, relDir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...tsFiles(rel));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(rel);
  }
  return out;
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function countAcross(needle: string): number {
  return SRC_DIRS.flatMap(tsFiles).reduce((sum, rel) => sum + read(rel).split(needle).length - 1, 0);
}

describe('docs-reality：文档主张与代码现实对账', () => {
  it('D-003/D-030（L4 写路径保险箱）：写路径唯一形态，legacy 痕迹零命中', () => {
    // D 波 3e5a36c（2026-10-14）退役 FSHINE_PROPOSAL_VIA_GATEWAY / FSHINE_PROPOSAL_COMMIT，
    // 删除 finalizeProposal / LegacyChangeIntentRecord / voucher.batch / 借贷合计渲染。
    // 这些词复现 = 闭环失效（legacy 写路径回潮或新写法带了业务字段），立即停。
    for (const needle of [
      '借贷合计',
      'voucher.batch',
      'LegacyChangeIntentRecord',
      'finalizeProposal',
      'FSHINE_PROPOSAL_VIA_GATEWAY',
      'FSHINE_PROPOSAL_COMMIT',
    ]) {
      expect(countAcross(needle), `"${needle}" 复现：D-003/D-030 闭环失效或新代码带入了 legacy 形态——停止，先关账再改`).toBe(0);
    }
  });

  it('D-001（L1）：persona 无领域定语，"财务助手"在宿主 src 绝迹', () => {
    // D-001 的靶子是 persona 领域定语（"你是企业财务助手"），已改「面向用户的主 Agent」。
    // 断言按精确靶子钉"财务助手"零命中；裸"财务"词的边界框架文案（如 history-tools 的
    // "实时财务查询"）已由 leak-lint 挂"遗留待清"在册，归 leak-lint 管，不在此重复。
    // 命中即 D-001 闭环失效。
    for (const dir of ['packages/agent/src', 'packages/core/src', 'apps/server']) {
      for (const rel of tsFiles(dir)) {
        expect(read(rel).includes('财务助手'), `${rel} 出现"财务助手"——D-001 闭环失效或 persona 回潮`).toBe(false);
      }
    }
  });

  it('D-050（L6）：空壳包 mcp-fake / mcp-host 已删除且不复活', () => {
    expect(existsSync(join(ROOT, 'packages/mcp-fake')), 'packages/mcp-fake 复活——D-050 闭环失效').toBe(false);
    expect(existsSync(join(ROOT, 'packages/mcp-host')), 'packages/mcp-host 复活——D-050 闭环失效').toBe(false);
  });

  it('D-051（L6）：演示彩蛋已清（reply.ts 不存在，renderBarChartPng 零命中）', () => {
    expect(existsSync(join(ROOT, 'apps/server/reply.ts')), 'apps/server/reply.ts 复活——D-051 闭环失效').toBe(false);
    expect(countAcross('renderBarChartPng'), 'renderBarChartPng 复现：演示彩蛋回到生产入口——D-051 闭环失效').toBe(0);
  });

  it('L1 防御排除不得失踪：五条财务正则与 hasFinancialFigure', () => {
    // 这五条正则让记忆提取器对财务事实保持敏感，hasFinancialFigure 守出口校验——
    // 删任何一条 = 防线变聋（leak-lint 会同步红，这里双保险钉存在性）。
    const extractor = read('packages/agent/src/memory-candidate-extractor.ts');
    for (const name of ['PERIOD_RE', 'ACCOUNT_SET_RE', 'BALANCE_RE', 'CURRENCY_AMOUNT_RE', 'FINANCIAL_RESULT_RE']) {
      expect(extractor.includes(name), `防御排除失踪：memory-candidate-extractor 的 ${name} 被删——防线变聋`).toBe(true);
    }
    expect(read('packages/agent/src/runtime-quality.ts').includes('function hasFinancialFigure'), '防御排除失踪：hasFinancialFigure 被删——出口校验变聋').toBe(true);
  });

  it('worker 工具面双写断言：WORKER_TOOLS 是唯一来源', () => {
    expect([...WORKER_TOOLS]).toEqual(['read', 'ls', 'bash', 'write', 'edit']);
    const src = read('packages/agent/src/pi-coding-driver.ts');
    // 会话创建必须消费常量，不许另写字面量（第二份来源 = 下一次漂移的起点）
    expect(src.includes('tools: [...WORKER_TOOLS]'), 'pi-coding-driver 的 tools 未消费 WORKER_TOOLS——双写断言被绕过').toBe(true);
    // 漂移过的旧注释形态不得复发（2026-10-16 实证：头注释与真实工具面脱节两次）
    expect(src.includes('read/bash/grep/find/ls'), '头注释重新出现已漂移的工具面描述——改注释前先核对 WORKER_TOOLS').toBe(false);
  });

  it('D-121：准入闸与授信门的术语边界注释不得失踪', () => {
    // PlatformExecutionGate 只是并发准入闸（FIFO 槽位），不做授权裁决——授权裁决住
    // serve-gate.ts（G1/授信期门）。"拿到 lease=已获准执行"的误读曾在 review 现形，
    // 注释即防线（同 WORKER_TOOLS 双写断言 / L1 防御排除不得失踪的存在性守卫先例）：
    // 头注释被删或漂移，此处翻红。零行为主张。
    const src = read('packages/agent/src/platform-execution-gate.ts');
    expect(src.includes('不构成执行授权'), 'platform-execution-gate 的授权边界声明被删——准入闸/授信门术语混淆防线失效').toBe(true);
    expect(src.includes('serve-gate.ts'), '头注释与授权裁决模块的指向脱钩——读者找不到授信门的权威位置').toBe(true);
  });

  it('D-120（命名债已关，别名已随 C3 退役）：Run17dzTaskArgs 全仓绝迹', () => {
    // task-manager / background-runtime 是通用任务管理基础设施；其公共表面积引用
    // Run17dzTaskArgs 是"新执行层照抄违例样板"的入口。主名 ContextTaskRunArgs 已
    // 中性化；C3 起过渡别名（context.ts 类型 + index.ts 再导出）整体退役——它是
    // `git grep -i 17dz` 门①路径集内的执行层名残留，W1 身份面守卫不容它挂签续命。
    // 此处任何一处复发 = 债回潮。
    expect(read('packages/agent/src/task-manager.ts').includes('Run17dzTaskArgs'), 'task-manager 重新引用 Run17dzTaskArgs——D-120 命名债回潮').toBe(false);
    expect(read('packages/agent/src/background-runtime.ts').includes('Run17dzTaskArgs'), 'background-runtime 重新引用 Run17dzTaskArgs——D-120 命名债回潮').toBe(false);
    expect(read('packages/agent/src/context.ts').includes('Run17dzTaskArgs'), 'context.ts 的过渡别名复活——C3 退役决策被回退').toBe(false);
    expect(read('packages/agent/src/index.ts').includes('Run17dzTaskArgs'), 'index.ts 重新导出 Run17dzTaskArgs——C3 退役决策被回退').toBe(false);
  });

  it('W4：budget-policy 归属表述——通用协议缺省单一源在宿主，执行层引用零回流', () => {
    // W4 上收：budget-policy 的 12 个缺省值改述为通用预算协议缺省档位线
    // （单一真相源在本文件），不再是「逐字对齐执行层 policy()」的第二份叙事。
    // 执行层实例名、执行层源码路径与宿主侧跨仓校验脚本名从本模块清零；
    // 任何一处回流 = 「第二份真相」叙事复辟或跨仓机器细节再次入住通用策略
    // （一致性校验的归属与关账口径住在 debt-ledger D-150/D-151，不在本模块注释里）。
    for (const rel of ['packages/agent/src/budget-policy.ts', 'packages/agent/src/budget-policy.test.ts']) {
      const text = read(rel);
      expect(text, `${rel} 重新出现执行层实例名（/17dz/i）——W4 归属表述回潮`).not.toMatch(/17dz/i);
      expect(text, `${rel} 重新出现执行层源码路径（src/execution/plan.js）——W4 归属表述回潮`).not.toContain('src/execution/plan.js');
      // 禁令串按段拆写：W4 C4 起全仓除台账两文件外不得出现该已删脚本的完整名字
      // （本波验收 grep 判据），守卫自身的禁令串也不例外——语义不变，grep 可复核。
      expect(text, `${rel} 重新出现宿主侧跨仓校验脚本名——跨仓机器细节入住通用策略`).not.toContain(`check-budget-` + `thresholds`);
    }
  });
});

// ── W3-A 渲染级机械锁（2026-11-05）：worker 提示词静态文本零执行层名 ──────────
//
// F1/F7——先锁后改：锁的是已为真的事实（W3-A 时点 workerSystemPrompt 函数体
// `sed -n '1729,1847p' context.ts | grep -i 17dz` 零命中），防 W3-B 文档修正后回潮。
// 唯一实现 = 直接调用 workerSystemPrompt 本体（context.ts 纯测试缝导出，零行为变化），
// 不用 planCommandForm=undefined 的弱实现——那样许可段整段不渲染，会漏掉唯一渗入点
// （planCommandForm 参数注入，permitNotice 段）。正反双向：
//   正向：中性值渲染（许可段/工作区段全部渲染、注入值不含 17dz）→ 提示词零 /17dz/i；
//   反向：注入 'bin/17dz plan …' 时原文出现——证明「唯一网关名渗入点 = 参数注入、
//         静态文本零贡献」，锁的是结构不是碰巧。root 与注入值刻意取不含 17dz 的
//         中性值，防假红。
describe('docs-reality：worker 提示词静态文本零执行层名（渲染级机械锁）', () => {
  it('中性值渲染 → 零 /17dz/i；网关名只能经 planCommandForm 参数注入（静态文本零贡献）', () => {
    const prompt = workerSystemPrompt('/platform-root', 'tmp/req-1', 'gateway plan {"calls":[]}');
    // 前置自证：许可段与工作区段确实渲染了（非 permitNotice 整段缺席的弱实现）
    expect(prompt).toContain('许可：');
    expect(prompt).toContain('写边界：');
    expect(prompt).not.toMatch(/17dz/i);
    // 反向：唯一渗入点 = 参数注入
    const injected = workerSystemPrompt('/platform-root', 'tmp/req-1', 'bin/17dz plan {"calls":[]}');
    expect(injected).toContain('bin/17dz');
  });

  it('W3-B 文档级 tripwire：v0-architecture §10 已修正的过期句不得复发', () => {
    // 弱锁（§10 文案可被后续合法重写绕过）：主锁是渲染级代码断言（workerSystemPrompt
    // 零执行层名）+ plan-teaching 计数锁，本条只防「改回过期句/矛盾句」。两条过期句
    // 的修正事实：① worker 提示词静态文本零执行层名已实测并挂渲染级锁（W3-A）；
    // ② 申报契约已瘦身为三枝四字段（resend 枝 2026-10-20 产物库波，turn-contract.test.ts
    // 钉 schema 恰 4 属性）——「仍 3 字段」与 §10 申报契约行直接矛盾。
    const doc = read('docs/v0-architecture.md');
    expect(doc.includes('worker 提示词仍包含 17dz 网关用法'), '§10 提示词面积行改回过期句——该句已被 W3-A 渲染级锁伪证').toBe(false);
    expect(doc.includes('申报契约仍 3 字段'), '§10 出现「申报契约仍 3 字段」矛盾句——resend 枝 2026-10-20 已新增，契约是三枝四字段').toBe(false);
  });
});
