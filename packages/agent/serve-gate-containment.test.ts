/**
 * GATE 轨（发布阻断 #1，decision-log 七）：解释器包装族的最小 fail-closed 阻断——确定性违约测试。
 *
 * 实证（T2 独立复核，2026-11-12）：以下形态**整类绕过**形态分类、计划前置与驱动层 T5 对账：
 *   `bash -c '…'` / `sh -c`、`sudo <gw> …`、`xargs <gw> …`、`FOO=1 <gw> …` /
 *   `env FOO=1 <gw> …`、命令替换 `$(<gw> …)`、反引号、`command <gw> …`。
 * 本文件先红（基线：门对九条形态全部 ALLOW），修法是 serve-gate 的**保守包含式**判据：
 * 命令串里出现网关令牌（含路径形态）、而整条命令不是任何"已识别的干净形态"
 * （首词 = 网关的既有形态 / 既有元数据形态）→ 拒。
 *
 * 第三组是**权限暴露面**的表征锁定：这组形态在 planDeclarationCovers 里要么取不到网关
 * 引用、要么引用被包装字符污染，没有一条能被对账证明在已声明范围内——它回答"为什么阻断
 * 必须落在门上"。T5 判据本轮不动（门在放行前已拒，对账环节见不到这些形态）。
 */
import { describe, expect, it } from 'vitest';
import { createServeGate, planDeclarationCovers, type ServeGateEvent } from './src/serve-gate';
import { messageTextFor } from './src/error-codes';
import type { PlanCall } from './src/plan-runtime';

const GW = 'bin/example-gateway';

/** 当前可绕过形态（decision-log 七的独立复核实证清单）：门必须全部拒。 */
const WRAPPED_FORMS: readonly string[] = [
  // ── 解释器包装（bash/sh -c）：内层命令整段是引号里的一个词 ──
  `bash -c '${GW} query src/voucher/scripts/query-saved.js A 202609'`,
  `sh -c "${GW} query src/voucher/scripts/query-saved.js A 202609"`,
  // ── 包装命令 / 环境变量前缀：首词不是网关 ──
  `sudo ${GW} query src/voucher/scripts/query-saved.js A 202609`,
  `xargs ${GW} query src/voucher/scripts/query-saved.js A 202609`,
  `FOO=1 ${GW} query src/voucher/scripts/query-saved.js A 202609`,
  `env FOO=1 ${GW} query src/voucher/scripts/query-saved.js A 202609`,
  `command ${GW} query src/voucher/scripts/query-saved.js A 202609`,
  // ── 命令替换：`$(` 与反引号把网关调用塞进另一个词的内部 ──
  `$(${GW} query src/voucher/scripts/query-saved.js A 202609)`,
  `\`${GW} query src/voucher/scripts/query-saved.js A 202609\``,
];

/** 与包装族内层调用同参的声明（用来量 T5 暴露面：这些形态不该被对账成 covered）。 */
const DECLARATIONS: readonly PlanCall[] = [{ operation: 'voucher.query-saved', args: ['A', '202609'] }];

describe('GATE · 解释器包装族：门必须拒（发布阻断 #1）', () => {
  it('九条形态逐条拒，拒绝理由可行动（单独成一条命令 / 不要包装替换前缀）', () => {
    const gate = createServeGate({ planActive: () => true, gateway: GW });
    for (const command of WRAPPED_FORMS) {
      const verdict = gate({ name: 'bash', arguments: { command } });
      expect(verdict?.block, command).toBe(true);
      expect(verdict?.reason, command).toBe(messageTextFor('SERVE_BASH_GATEWAY_WRAPPED'));
    }
  });

  it('拒绝留痕：每条被拒形态在审计事件里 allowed=false + 同一理由（不得留 ok 假痕迹）', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ planActive: () => true, gateway: GW, onEvent: (e) => events.push(e) });
    for (const command of WRAPPED_FORMS) gate({ name: 'bash', arguments: { command } });
    expect(events).toHaveLength(WRAPPED_FORMS.length);
    expect(events.every((event) => event.allowed === false)).toBe(true);
    expect([...new Set(events.map((event) => event.reason))]).toEqual([messageTextFor('SERVE_BASH_GATEWAY_WRAPPED')]);
  });

  it('正向对照：已识别的干净形态不因本判据变拒（首词=网关的既有形态 / 元数据 / local）', () => {
    const gate = createServeGate({ planActive: () => true, scratchDir: 'tmp/req_x', gateway: GW });
    for (const command of [
      `${GW} query src/voucher/scripts/query-saved.js A 202609`,
      `${GW} prepare src/payroll/scripts/transform.py c.json out`,
      `${GW} operation list --json`,
      `${GW} plan --schema`,
      `${GW} local tmp/req_x/run.py`,
      `${GW} memory list --scope customer --id 甲`,
      'node src/payroll/scripts/transform.py a b',
    ]) {
      expect(gate({ name: 'bash', arguments: { command } })?.block, command).toBeUndefined();
    }
  });
});

describe('GATE · 引号内字面分隔符不误拒（Owner 批准的小项）', () => {
  it('引号内分号是字面量，不是命令分隔符 → 不再当命令链拒', () => {
    const gate = createServeGate({ planActive: () => true, gateway: GW });
    for (const command of [
      `echo "x;${GW}"`,
      `echo 'x;${GW}'`,
    ]) {
      expect(gate({ name: 'bash', arguments: { command } })?.block, command).toBeUndefined();
    }
  });

  it('真命令链仍拒（引号内的字面分号不改变真分隔符的判定）', () => {
    const gate = createServeGate({ planActive: () => true, gateway: GW });
    for (const command of [
      `echo x; ${GW} query query-saved.js A 202609`,
      `echo "x; y"; ${GW} query query-saved.js A 202609`,
      `echo 'a; b' || ${GW} query query-saved.js A 202609`,
    ]) {
      const verdict = gate({ name: 'bash', arguments: { command } });
      expect(verdict?.block, command).toBe(true);
      expect(verdict?.reason, command).toBe(messageTextFor('SERVE_BASH_CHAINED_GATEWAY'));
    }
  });
});

describe('GATE · 权限暴露面（为什么阻断必须落在门上）：包装族对账不上声明', () => {
  it('七条取不到网关引用 → T5 返回 not_plan_gated（对账环节对它不设防）', () => {
    // 现状证据（decision-log 七）：提取不到引用的命令，planDeclarationCovers 直接
    // not_plan_gated——没有任何一步能把它们对回声明。因此门是唯一该拦的地方。
    const noReference = WRAPPED_FORMS.filter((command) => !command.startsWith('$') && !command.startsWith('`'));
    for (const command of noReference) {
      expect(planDeclarationCovers(command, DECLARATIONS), command).toBe('not_plan_gated');
    }
  });

  it('`$(…)` 与反引号两条：token 1/2 恰好被读成 mode+脚本，但参数被包装字符污染 → 不是 covered', () => {
    // 这两条是同一暴露面的另一半：extractGateScript 在包装字符串里恰好取到一个引用，
    // 对账不是"不参与"而是"对错了对象"（当前落 expansion——`202609)` 带着尾部括号），
    // 同样不能构成"在声明范围内"的证据。
    for (const command of WRAPPED_FORMS.filter((item) => item.startsWith('$') || item.startsWith('`'))) {
      expect(planDeclarationCovers(command, DECLARATIONS), command).not.toBe('covered');
      expect(planDeclarationCovers(command, DECLARATIONS), command).toBe('expansion');
    }
  });

  it('对照：形态可解析的越范围调用被对账判 expansion（同一判据的正面）', () => {
    expect(planDeclarationCovers(`${GW} query src/voucher/scripts/query-saved.js B 202609`, DECLARATIONS)).toBe('expansion');
    expect(planDeclarationCovers(`${GW} query src/voucher/scripts/query-saved.js A 202609`, DECLARATIONS)).toBe('covered');
  });
});
