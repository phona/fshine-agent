import { describe, expect, it } from 'vitest';
import { sanitizeServerPathReply, sanitizeUserVisibleReply } from './src/reply-exit';

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

  it('整段回复都是协议原文：替换为格式异常兜底话术（D-138）', () => {
    const out = sanitizeUserVisibleReply({
      text: '<tool_call><function=route_current_turn><parameter=kind>delegate</parameter></function></tool_call>',
      executed: true,
      needsRounds: 0,
      evidence: () => '',
    });
    expect(out.text).not.toMatch(/tool_call|function=|parameter=/);
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.text).toMatch(/格式|异常|重发|换个/);
    expect(out.events[0]?.event).toBe('execution_language_scrubbed');
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
