import { describe, expect, it } from 'vitest';
import { sanitizeUserVisibleReply } from './src/reply-exit';

/** 一次实测漏进终稿的路径（2026-10-19，幻骥达工资表任务）。 */
const WORKSPACE_PATH = 'tmp/task_d42fffce-ce9a-4ff7-b648-b26e9131d9b1/';

describe('sanitizeUserVisibleReply', () => {
  it('零命中时原文原样返回（同一引用）、不带事件', () => {
    const clean = '应发合计 123,456.78；实发合计 120,000.00。12 人逐人零差异。';
    const out = sanitizeUserVisibleReply({ text: clean, executed: true, needsRounds: 0, evidence: () => '' });
    expect(out.text).toBe(clean);
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
