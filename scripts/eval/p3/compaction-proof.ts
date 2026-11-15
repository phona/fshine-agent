/**
 * P3 窗口选择确定性证明（零真实模型）：
 *   所选 contextWindow 会在 P3-A 长会话转录量级下**真实触发压缩**（shouldCompact = true，
 *   且越过回合前 INV 复核线 → 走 compactTranscriptWithPi 的 force 压缩路径），
 *   同时满足装配期下界（W ≥ CONTEXT_WINDOW_FLOOR_TOKENS=6656）；对照缺省 128k 窗口
 *   在同一转录下不触发（证明窗口选择是有效变量，不是无意义填充）。
 *
 * 运行：node --import tsx scripts/eval/p3/compaction-proof.ts
 */
import { estimateContextTokens, shouldCompact } from '@earendil-works/pi-agent-core';
import {
  CONTEXT_WINDOW_FLOOR_TOKENS,
  CONTEXT_REQUEST_FRAMING_TOKENS,
  MIN_OUTPUT_BUDGET_TOKENS,
  compactionSettingsFor,
  fixedRequestOverheadTokens,
} from '../../../packages/agent/src/pi-driver';

/** P3-A 长会话转录夹具（确定性字符串，无随机）：多轮业务对话 + 分页工具结果量级。 */
function p3aTranscript(turns = 40): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `（第${index + 1}轮）请继续处理订单 ORD-2026-${String(index).padStart(4, '0')} 的核对，并保留分页游标 cursor=eyJvZmZzZXQiOjEwMH0 一字不改。${'背景上下文与既往结论占位。'.repeat(40)}` }] });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `已核对第${index + 1}批：对象 ORD-2026-${String(index).padStart(4, '0')}，游标原样保留 cursor=eyJvZmZzZXQiOjEwMH0。${'核对明细与中间结论占位。'.repeat(40)}` }] });
  }
  return messages;
}

/** P3 装配的代表性系统提示 + 工具面（与 dummy 只读面同量级），用于 Δ_worst 实测。 */
const SYS_PROMPT = '你是业务助理，按执行契约只读核对。'.repeat(8);
const TOOLS = [
  { name: 'dummy.query', description: '查询仓内 dummy 集合', inputSchema: { type: 'object', properties: { collection: { type: 'string' }, cursor: { type: 'string' } }, required: ['collection'] } },
];

function report(label: string, contextWindow: number): Record<string, unknown> {
  const messages = p3aTranscript();
  const est = estimateContextTokens(messages as never);
  const settings = compactionSettingsFor(contextWindow);
  const threshold = contextWindow - settings.reserveTokens;
  const fixedOverhead = fixedRequestOverheadTokens(SYS_PROMPT, TOOLS);
  const invariantLimit = contextWindow - fixedOverhead - MIN_OUTPUT_BUDGET_TOKENS;
  return {
    label,
    contextWindow,
    floor: CONTEXT_WINDOW_FLOOR_TOKENS,
    passesAssemblyFloor: contextWindow >= CONTEXT_WINDOW_FLOOR_TOKENS,
    transcriptTokens: est.tokens,
    compactionThreshold: threshold,
    shouldCompact: shouldCompact(est.tokens, contextWindow, settings),
    preRequestInvariantBreach: est.tokens > invariantLimit, // true → 回合前 force 压缩路径必走
    invariantLimit,
    fixedOverheadDeltaWorst: fixedOverhead,
    reserveTokens: settings.reserveTokens,
    keepRecentTokens: settings.keepRecentTokens,
    framingConstant: CONTEXT_REQUEST_FRAMING_TOKENS,
  };
}

const chosen = report('P3 选定窗口', 8_192);
const contrast = report('对照：缺省 128k', 128_000);
const verdict = chosen.passesAssemblyFloor
  && chosen.shouldCompact === true
  && chosen.preRequestInvariantBreach === true
  && contrast.shouldCompact === false;

console.log(JSON.stringify({ chosen, contrast, verdict }, null, 2));
if (!verdict) {
  console.error('P3 窗口选择证明未成立：选定窗口未同时满足（过装配下界 / 会触发压缩 / 对照窗口不触发）。');
  process.exit(1);
}
