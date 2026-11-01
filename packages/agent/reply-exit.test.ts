import { describe, expect, it } from 'vitest';
import { sanitizeDirectExitReply, sanitizeServerPathReply, sanitizeUserVisibleReply } from './src/reply-exit';

/** 一次实测漏进终稿的路径（2026-10-19，幻骥达工资表任务）。 */
const WORKSPACE_PATH = 'tmp/task_d42fffce-ce9a-4ff7-b648-b26e9131d9b1/';

describe('sanitizeUserVisibleReply', () => {
  it('零命中时原文原样返回（同一引用）、不带事件', () => {
    const clean = '应发合计 123,456.78；实发合计 120,000.00。12 人逐人零差异。';
    const out = sanitizeUserVisibleReply({ text: clean, executed: true, needsRounds: 0, evidence: () => '' });
    expect(out.text).toBe(clean);
    expect(out.events).toEqual([]);
  });

  // ── D-138（Z1 实测 2026-10-26）：确认续跑轮模型曾把工具调用写成正文，宿主终稿
  // 出口原样上屏 318 字符 <tool_call> XML。协议原文是"用户没法用的那一截"，与删
  // 路径同族——删标签留其余；整段都是协议时替换为可行动兜底话术。
  it('工具调用协议原文：删标记留其余文本，事件带 execution_language_scrubbed（D-138）', () => {
    const out = sanitizeUserVisibleReply({
      text: '查询进行中。\n<tool_call>\n<function=route_current_turn>\n<parameter=kind>\ndelegate\n</parameter>\n</function>\n</tool_call>\n稍后汇总。',
      executed: true,
      needsRounds: 0,
      evidence: () => '',
    });
    expect(out.text).not.toMatch(/tool_call|function=|parameter=/);
    expect(out.text).toContain('查询进行中');
    expect(out.text).toContain('稍后汇总');
    expect(out.events).toEqual([{ level: 'warn', event: 'execution_language_scrubbed', detail: { labels: ['工具调用协议'], tokens: 6 } }]);
  });

  it('整段回复都是协议原文：替换为格式异常兜底话术（D-138；事件名随 D-144 收敛为申报替换）', () => {
    const out = sanitizeUserVisibleReply({
      text: '<tool_call><function=route_current_turn><parameter=kind>delegate</parameter></function></tool_call>',
      executed: true,
      needsRounds: 0,
      evidence: () => '',
    });
    expect(out.text).not.toMatch(/tool_call|function=|parameter=/);
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.text).toMatch(/格式|异常|重发|换个/);
    // 这条整段=route 申报（ASCII 参数版）：D-144 起走更精确的申报替换支（终稿文本不变，
    // 事件从 execution_language_scrubbed 改记 route_declaration_reply_replaced）。
    expect(out.events[0]?.event).toBe('route_declaration_reply_replaced');
  });

  // ── D-144（eval14-misc 实测 2026-10-31）：续跑轮整理模型把 route 申报原文写成正文。
  // 第三形态「终稿=申报」：continueTaskId/request 的参数值本身是中文自然语言，删完标签
  // 剩约 56 个汉字，「剩余非 ASCII<4」的整段协议判据失明——删除式救不了，必须整段替换
  // 为调用方给的 fallback（worker 整理文本或确定性话术）。
  /** eval14 实测泄漏原文（conversation_sessions.state msg7 整段，中文参数）。 */
  const LEAKED_ROUTE_DECLARATION = [
    '<tool_call>',
    '<function=route_current_turn>',
    '<parameter=continueTaskId>',
    'task_812c1535-2a5f-4b18-9995-9e3a883f84fc',
    '</parameter>',
    '<parameter=kind>',
    'delegate',
    '</parameter>',
    '<parameter=progress>',
    '幻州幻仁汽车技术有限公司的做账进度',
    '</parameter>',
    '<parameter=request>',
    '第3/10步：查询幻州幻仁汽车技术有限公司的做账进度，当前处理到哪个月、凭证是否已录完',
    '</parameter>',
    '</function>',
    '</tool_call>',
  ].join('\n');

  it('整段=申报（XML 形，中文参数）：整段替换为调用方 fallback，事件带 form 与 replacedLength（D-144）', () => {
    const out = sanitizeUserVisibleReply({
      text: LEAKED_ROUTE_DECLARATION,
      executed: true,
      needsRounds: 0,
      evidence: () => '',
      declarationFallback: '幻州幻仁：做账已处理到 2026 年 8 月，凭证已录完。',
    });
    expect(out.text).toBe('幻州幻仁：做账已处理到 2026 年 8 月，凭证已录完。');
    expect(out.text).not.toMatch(/tool_call|route_current_turn|task_812c|function=|parameter=/);
    expect(out.events).toEqual([{
      level: 'warn',
      event: 'route_declaration_reply_replaced',
      detail: { form: 'xml', replacedLength: LEAKED_ROUTE_DECLARATION.length },
    }]);
  });

  it('整段=申报（JSON 形）：kind 首键 + request/continueTaskId 的整段 JSON 替换为 fallback（D-144）', () => {
    const leaked = '{"kind":"delegate","continueTaskId":"task_812c1535","request":"第3/10步：查询幻州幻仁汽车技术有限公司的做账进度"}';
    const out = sanitizeUserVisibleReply({
      text: leaked,
      executed: true,
      needsRounds: 0,
      evidence: () => '',
      declarationFallback: '本步已完成。回复『继续』推进下一步，或告诉我下一步要做什么。',
    });
    expect(out.text).toBe('本步已完成。回复『继续』推进下一步，或告诉我下一步要做什么。');
    expect(out.text).not.toContain('kind');
    expect(out.events).toEqual([{
      level: 'warn',
      event: 'route_declaration_reply_replaced',
      detail: { form: 'json', replacedLength: leaked.length },
    }]);
  });

  it('调用方没给 fallback 时整段=申报回落格式异常话术（正常路径同一把尺）', () => {
    const out = sanitizeUserVisibleReply({ text: LEAKED_ROUTE_DECLARATION, executed: true, needsRounds: 0, evidence: () => '' });
    expect(out.text).not.toMatch(/tool_call|route_current_turn|task_812c/);
    expect(out.text).toMatch(/格式|异常|重发|换个/);
    expect(out.events[0]?.event).toBe('route_declaration_reply_replaced');
  });

  it('防误伤：正文里只引用一小段 JSON 的正常回复不被替换', () => {
    const normal = '接口偶发返回 {"kind":"delegate","request":"…"} 之类的内部标记，已忽略；实际余额 42 元。';
    const out = sanitizeUserVisibleReply({
      text: normal,
      executed: true,
      needsRounds: 0,
      evidence: () => '',
      declarationFallback: '不该出现的替换文本',
    });
    expect(out.text).toBe(normal);
    expect(out.events).toEqual([]);
  });

  it('防误伤：标签混在自然语言里（D-138 第一形态）即使给了 fallback 也不整段替换，仍走删除支', () => {
    const out = sanitizeUserVisibleReply({
      text: '查询进行中。\n<tool_call>\n<function=route_current_turn>\n<parameter=kind>\ndelegate\n</parameter>\n</function>\n</tool_call>\n稍后汇总。',
      executed: true,
      needsRounds: 0,
      evidence: () => '',
      declarationFallback: '不该出现的替换文本',
    });
    expect(out.text).toContain('查询进行中');
    expect(out.text).toContain('稍后汇总');
    expect(out.text).not.toContain('不该出现的替换文本');
    expect(out.events).toEqual([{ level: 'warn', event: 'execution_language_scrubbed', detail: { labels: ['工具调用协议'], tokens: 6 } }]);
  });

  // ── D-136（F6 双向实测）：模型偶发把平台错误码（PERIOD_NO_DATA 族）说给用户。
  // 码对用户无用，删码留解释文本——只删全大写 snake 形态，避免误伤普通小写词。
  it('全大写错误码：删码留其余文本（D-136）', () => {
    const out = sanitizeUserVisibleReply({
      text: '该期间查不到数据（PERIOD_NO_DATA），建议确认期间后重查。',
      executed: true,
      needsRounds: 0,
      evidence: () => '',
    });
    expect(out.text).toBe('该期间查不到数据（），建议确认期间后重查。');
    expect(out.events).toEqual([{ level: 'warn', event: 'execution_language_scrubbed', detail: { labels: ['错误码'], tokens: 1 } }]);
  });

  it('普通小写 snake 词与中文数字零误伤', () => {
    const clean = '按 account_set 口径，202606 余额 61,000 元与上月一致。';
    const out = sanitizeUserVisibleReply({ text: clean, executed: true, needsRounds: 0, evidence: () => '' });
    expect(out.text).toBe(clean);
    expect(out.events).toEqual([]);
  });

  it('宿主码表词保留（TASK_FORBIDDEN 族是宿主话术的产品行为，非泄漏）', () => {
    const hostAuthored = 'TASK_FORBIDDEN: 期望 taskId 是本会话里未完成的编号；实际 无权继续别人的任务。';
    const out = sanitizeUserVisibleReply({ text: hostAuthored, executed: true, needsRounds: 0, evidence: () => '' });
    expect(out.text).toBe(hostAuthored);
    expect(out.events).toEqual([]);
  });

  it('路径命中：删路径、留内容，事件带 removed 与 executed', () => {
    const out = sanitizeUserVisibleReply({
      text: `已产出文件（${WORKSPACE_PATH}）：整理好的2026年08月工资表.xlsx`,
      executed: false,
      needsRounds: 0,
      evidence: () => '',
    });
    expect(out.text).toBe('已产出文件：整理好的2026年08月工资表.xlsx');
    expect(out.events).toEqual([{ level: 'warn', event: 'server_path_leak', detail: { removed: 1, executed: false } }]);
  });

  it('先删路径再扫金额：删掉之后正文里剩的数字才是判据', () => {
    // 金额只在路径里出现过一次、正文里一次：删完路径后仍在，且证据里有它 → 不告警。
    // 反过来（证据里只有路径那一份）会误报，所以顺序必须是"先删再扫"。
    const out = sanitizeUserVisibleReply({
      text: `见 ${WORKSPACE_PATH}123,456.78 与 12 人。`,
      executed: false,
      needsRounds: 0,
      evidence: () => 'nothing here',
    });
    expect(out.events).toHaveLength(1);
    expect(out.events[0]?.event).toBe('server_path_leak');
  });

  it('零执行 + 金额在证据里逐字找不到：记一条 conversation_unsourced_amounts', () => {
    const out = sanitizeUserVisibleReply({
      text: '实发合计 120,000.00。',
      executed: false,
      needsRounds: 2,
      evidence: () => '历史里只有 12 人和零差异',
    });
    expect(out.text).toBe('实发合计 120,000.00。');
    expect(out.events).toEqual([{ level: 'warn', event: 'conversation_unsourced_amounts', detail: { count: 1, needsRounds: 2 } }]);
  });

  it('金额在证据里（含 toLocaleString 形态）找得到：不告警', () => {
    for (const evidence of ['上轮算过 120000.00', '上轮算过 120,000.00']) {
      const out = sanitizeUserVisibleReply({ text: '实发合计 120,000.00。', executed: false, needsRounds: 0, evidence: () => evidence });
      expect(out.events, evidence).toEqual([]);
    }
  });

  it('有执行痕迹的轮次跳过金额探查（数字天然有出处）', () => {
    const out = sanitizeUserVisibleReply({ text: '实发合计 120,000.00。', executed: true, needsRounds: 0, evidence: () => '' });
    expect(out.events).toEqual([]);
  });

  it('零执行 + 正文没有千分位金额：不碰 evidence（懒取）', () => {
    let called = 0;
    const out = sanitizeUserVisibleReply({ text: '12 人零差异。', executed: false, needsRounds: 0, evidence: () => { called += 1; return ''; } });
    expect(called).toBe(0);
    expect(out.events).toEqual([]);
  });

  it('两支同时命中时按顺序各出一条（先路径后金额）', () => {
    const out = sanitizeUserVisibleReply({
      text: `已产出文件（${WORKSPACE_PATH}）：实发合计 120,000.00。`,
      executed: false,
      needsRounds: 1,
      evidence: () => '没有这个数字',
    });
    expect(out.events.map((entry) => entry.event)).toEqual(['server_path_leak', 'conversation_unsourced_amounts']);
    expect(out.text).toBe('已产出文件：实发合计 120,000.00。');
  });
});

describe('sanitizeServerPathReply', () => {
  it('direct exit execution is unknown unless the caller supplies a fact', () => {
    const out = sanitizeServerPathReply({ text: `见 ${WORKSPACE_PATH}。` });
    expect(out.events).toEqual([{ level: 'warn', event: 'server_path_leak', detail: { removed: 1 } }]);
  });
});

// ── D-144 出口收敛：direct 出口（finishDirectReply 等）此前只删路径（§22 留观察），
// 整理模型/平台文本经它直达终稿时协议申报与执行语言零检测。现在与正常路径同一把尺
// （路径 + 整段申报替换 + 执行语言删除），只缺数值溯源——direct 文本不是本轮模型
// 自由产出，"编造金额"的探查不适用。
describe('sanitizeDirectExitReply', () => {
  it('整段=申报：direct 出口同样整段替换为格式异常话术（无调用方 fallback）', () => {
    const out = sanitizeDirectExitReply({ text: '<tool_call>\n<function=route_current_turn>\n<parameter=kind>delegate</parameter>\n</function>\n</tool_call>', executed: true });
    expect(out.text).not.toMatch(/tool_call|route_current_turn/);
    expect(out.text).toMatch(/格式|异常|重发|换个/);
    expect(out.events[0]?.event).toBe('route_declaration_reply_replaced');
  });

  it('宿主确定性话术零命中原样返回（同一引用）、不带事件', () => {
    const hostText = '平台登录态过期，需要重新登录后才能继续查询。';
    const out = sanitizeDirectExitReply({ text: hostText });
    expect(out.text).toBe(hostText);
    expect(out.events).toEqual([]);
  });

  it('删路径照旧（与原 sanitizeServerPathReply 行为一致）', () => {
    const out = sanitizeDirectExitReply({ text: `已产出文件（${WORKSPACE_PATH}）：工资表.xlsx`, executed: false });
    expect(out.text).toBe('已产出文件：工资表.xlsx');
    expect(out.events).toEqual([{ level: 'warn', event: 'server_path_leak', detail: { removed: 1, executed: false } }]);
  });
});
