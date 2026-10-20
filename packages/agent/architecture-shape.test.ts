import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 架构形状守卫（方案 2 · 拆 handleTurn 的 R6 + 防环，见 docs/change-safety.md §3）。
 *
 * 两条机械断言，都是"改错就红"的守卫（F3）：
 *
 *   1. **模块间无 import 环**：packages/agent/src 下的相对 import 建图后检测环。
 *      分批 1 曾把 usefulWorkerNote / composeClarificationReply 搬进 turn-relay.ts，
 *      造成 runtime.ts ↔ turn-relay.ts 循环 import（那两条函数的判据本体在 runtime 一侧，
 *      而 composeClarificationReply 直接调用 usefulWorkerNote）。当时只能靠"想起来"发现；
 *      这条断言让同类回归在 CI 里现形，失败消息带环路径（如 runtime → turn-relay → runtime）。
 *   2. **runtime.ts 行数预算（只减不增）**：每批抽取后把常数改成抽取后的真实行数
 *      （不留余量——留余量等于没压）。基线 1969（分批 1 前）→ 1789（分批 1 后）
 *      → 1735（分批 2a：抽 turn-state.ts 后）→ 1685（分批 2b：抽 plan-binding.ts 后）
 *      → 1521（分批 3a：抽 turn-exit.ts + turn-context.ts 后）
 *      → 1203（分批 3b：抽 turn-persistence.ts 后，方案 2 最后一批）。
 *      → 1221（方案 1 B 波 B3：新增"提案已登记"分支——宿主持有的确定性文本终结本轮，
 *        与 writeClosed 同族。这是**功能新增**而不是回退：常数随真实行数上移，下一批抽取
 *        时照旧只减不增）。
 *      → 1237（token 消耗统计，纯加法遥测：Main 侧 turn_span 的 usage 采集——正常回合规口、
 *        跳过申报重试两段合并、恢复路径整理轮规口、finishDirectReply 透传。同样是功能新增，
 *        无行为分支变化；下一批抽取时照旧只减不增）。
 *
 * 变异验证：在 src 里加一条反向 **值** import（如 turn-relay → runtime）→ 断言 1 红；
 * 往 runtime.ts 加几行 → 断言 2 红。
 */

const SRC_DIR = join(__dirname, 'src');
const RUNTIME_PATH = join(SRC_DIR, 'runtime.ts');

/**
 * 本批抽取后的真实行数。纪律：**只减不增**——每批抽取把这个常数改小，改大就是回退。
 * 留余量等于没压，所以这里放的是当前真实行数（不含任何 slack）。
 *
 * 1221 → 1225（2026-10-17）：SYSTEM_PROMPT 增加委派边界纪律一句（追加/扩范围优先扩当前
 * 计划；同题重问硬豁免）+ 数据理由注释。上移依据与 B3 条目同先例：探针实测新开委派
 * ≈ +31s、同委派内追加调用 ≈ +2s（scripts/perf/delegation-boundaries.ts，126 对可合并）。
 * 第一版因缺"同题重问"豁免被 F6 门打回（B1 零调用召回），带豁免重落；评审复核后按
 * rule-landing"同一事实只存在一处"收敛为双处分工（全文在 business-skill.md，提示词只留
 * 原则句），1226 → 1225。登记见 rule-landing §3.1 条目 12。
 *
 * 1237 → 1241（同日）：token 消耗遥测（sumUsage + 三采集点 + turn_span/delegation_span
 * 字段，见 e21570f）使基数升到 1237；P2 边界句恢复后 +4 = 1241。
 *
 * 1241 → 1251（2026-10-16）：SYSTEM_PROMPT 首条的日期行移出为 DATE_SUFFIX 常量，改拼在
 * 组装后系统提示词的最尾部（business skill 之后；恢复路径整理提示词同样拼尾）。动机：
 * prompt cache 按前缀逐字节命中，动态日期排在稳定内容之前会把整个前缀炸断——跨天每次
 * 调用对 SYSTEM_PROMPT + skill 全额付价；移到尾部后跨天只有尾注一行未命中。文案一字不差，
 * 行为等价（非抽取回退）：+10 = 注释块 6 + 常量 1 + 拼装处 3。下一批抽取时照旧只减不增。
 *
 * 1251 → 1293（2026-10-18，功能新增非抽取）：资源耗尽终稿（"失败必达"路径 1）。委派
 * catch 与恢复路径各接一段 RESOURCE_EXHAUSTED 合成接线（判定与渲染住新模块
 * resource-exhausted.ts：这里只做"检测 DELEGATION_TIMEOUT_FAILURE 话术 → 取底账 →
 * 渲染 → 抛出/返回"），turn_span 增 resource_exhausted 结局。+42 = import 2 + 委派
 * catch 接线 26 + 恢复路径接线 12 + turn_span 2。判据本体不在 runtime，后续抽取时照旧只减不增。
 *
 * 2026-10-20 波：重复请求复核 + 服务器路径不外发。判据住 repeat-request.ts /
 * reply-exit.ts（后者一并收走原本散在出口处的数值溯源探查），runtime 只留两处调用与
 * 打点。这一批同时把两块既有的 I/O 包装抽出去付账：会话实体安全读（→ session-entities.ts，
 * 判据本体保持"抛错向上传播"，降级是调用策略）与平台冷却拦截（→ platform-health.ts，
 * 一次读取同时拿回复文本与日志载荷，分三次读会在到期边界上各说各话）。
 * 1293 → 1290。
 */
const RUNTIME_LINE_BUDGET = 1290;

/**
 * import / export 语句：`(import|export) [type] <子句> from './xxx'`。
 * 子句用懒惰匹配跨行（src 里存在多行 import，如 runtime.ts 的 clarification-events）。
 * 第 1 捕获组 = 整条语句是 type-only（`import type {...}` / `export type {...}`）。
 */
const IMPORT_STATEMENT = /(?:import|export)\s+(type\s+)?([\s\S]*?)from\s+'\.\/([^']+)'/g;

/**
 * 建 import 图：文件 → 它 import 的同目录模块（只留在 src 内的边）。
 *
 * **只收值 import**：`import type {...}` 被 TS/esbuild 整条擦除，不产生运行期模块边，
 * 因此不可能造成循环初始化那类故障——守卫要防的是批次 1 那种值 import 环
 * （runtime ↔ turn-relay：函数互相调用）。把 type-only 边也算进来会得到假阳性：
 * driver.ts 有一条 `import type { PendingPlanConfirmation } from './plan-runtime'`，
 * 而 plan-runtime → error-codes → driver 是值链，三者合起来是个纯类型环
 * （编译期成立、运行期不存在），它不是本守卫要抓的东西。
 */
function buildImportGraph(files: string[]): Map<string, string[]> {
  const known = new Set(files);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const edges: string[] = [];
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_STATEMENT)) {
      if (match[1]) continue; // type-only：擦除，不成边
      const target = join(SRC_DIR, `${match[3]}.ts`);
      if (known.has(target)) edges.push(target);
    }
    graph.set(file, edges);
  }
  return graph;
}

/**
 * 深度优先找环。返回环路径（如 ['runtime.ts', 'turn-relay.ts', 'runtime.ts']），
 * 无环返回 null。path 既是递归栈，也是环的现形路径。
 */
function findCycle(graph: Map<string, string[]>): string[] | null {
  const DONE = new Set<string>();
  const path: string[] = [];
  const onPath = new Set<string>();

  const walk = (node: string): string[] | null => {
    if (onPath.has(node)) return [...path.slice(path.indexOf(node)), node];
    if (DONE.has(node)) return null;
    path.push(node);
    onPath.add(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    path.pop();
    onPath.delete(node);
    DONE.add(node);
    return null;
  };

  for (const file of [...graph.keys()].sort()) {
    const cycle = walk(file);
    if (cycle) return cycle;
  }
  return null;
}

/** 与 `wc -l` 一致的行数（文件以换行结尾，末尾空串不算一行）。 */
function countLines(path: string): number {
  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

describe('packages/agent/src 的架构形状', () => {
  it('模块间无 import 环（相对 import 建图后检测）', () => {
    const files = readdirSync(SRC_DIR)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(SRC_DIR, name))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    const cycle = findCycle(buildImportGraph(files));
    // 无环 = null（不是 undefined：可选链会把 null 也变成 undefined，断言就永远红）
    const rendered = cycle ? cycle.map((file) => file.slice(SRC_DIR.length + 1)) : null;
    expect(rendered, rendered ? `import 环：${rendered.join(' → ')}` : '').toBeNull();
  });

  it('runtime.ts 行数不超预算（只减不增，每批抽取后把常数改小）', () => {
    expect(countLines(RUNTIME_PATH)).toBeLessThanOrEqual(RUNTIME_LINE_BUDGET);
  });
});
