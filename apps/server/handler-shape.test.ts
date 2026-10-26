import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * handler.ts 行数棘轮（2026-10-20 落地，见 docs/change-safety.md §14）。
 *
 * **为什么单给它一根棘轮**：`packages/agent/architecture-shape.test.ts` 守着 runtime.ts
 * （1969 → 1290，拆了七个模块），而 handler.ts 从来没被拆过、也没有任何机械护栏——
 * 附件机器（暂存池 / 规则一账本 / burst 稳定器 / 收据与帧策略 / 产物收集）是它长到今天的
 * 主要原因。没有棘轮时，"再往 handler 里加一段附件逻辑"是零成本的决定；有了它，那是
 * 一次显式决定（要么抽取，要么把常数连同理由一起改）。
 *
 * 纪律（与 runtime.ts 同一套）：
 *   - **只减不增**：每批抽取把这个常数改小，不留余量（留余量等于没压）。
 *   - **功能新增允许上移**，但必须像 runtime.ts 那样在下面记一行"为什么涨、涨的是什么"——
 *     上移依据是功能而不是回退；下一批抽取时照旧只减不增。
 *
 * 行数历史：958（本波前）→ 1013（2026-10-20 交互缝波：D2 终稿点名 + 到达钟可注入 +
 * 渠道前缀参数化 + 三处注释。三条缝都是留缝不是搭桥，净增 55 行的绝大部分是注释与判据
 * 说明——下一波"宿主发事实、渠道演呈现"会把帧策略整段搬去 adapter，那时它往下走）→
 * 1017（2026-10-20 W1 session=聊天窗口：sessionKey 由 `user:conversation` 复合改为单取
 * conversationId，群不再按用户切；净增 4 行全是身份拆分的判据注释，零功能分支）。
 * 1017 → 907（2026-10-25 收口）：W0–W7 产物机器（收集/工作区清单/收据脱敏）与 §18
 * 后台接线后的实际行数——产物与投递判据都住 artifact-store.ts / background-delivery.ts，
 * 压掉 110 行余量（留余量等于没压）。
 *
 * 变异验证（F3）：往 handler.ts 加几行 → 断言红。
 */

const HANDLER_PATH = join(__dirname, 'handler.ts');

/** 当前真实行数（不含任何 slack）。改大 = 回退或未登记的功能新增，都要在这上面留一行理由。 */
const HANDLER_LINE_BUDGET = 907;

function countLines(path: string): number {
  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

describe('apps/server 的架构形状', () => {
  it('handler.ts 行数预算（只减不增；上移必须在文件头留理由）', () => {
    expect(countLines(HANDLER_PATH)).toBeLessThanOrEqual(HANDLER_LINE_BUDGET);
  });
});
