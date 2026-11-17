/**
 * 污染检测 + 模拟用户 prompt 泄漏守卫的机制单测（确定性、零模型）。
 */
import { describe, expect, it } from 'vitest';
import { detectContamination, normalizeForMatch } from './contamination';
import { buildSimulatorPrompt, findCaseLeaks, findPromptLeaks } from './simulator';
import type { SimCase } from './case';

const CASE: SimCase = {
  id: 'C-01',
  goal: '核对 alpha 集合的合计金额',
  persona: '谨慎的业务员',
  knowledge: ['alpha 集合我有权限', '上周已经问过一次'],
  initialMessage: '帮我看一下 alpha 的合计',
  behaviorRules: ['一次只问一件事'],
  forbiddenKnowledge: ['内部工单号 INC-7788'],
  allowedActions: ['say', 'wait', 'finish'],
  terminal: { satisfied: '拿到合计金额', gaveUp: '系统反复答非所问' },
  fixtureId: 'dummy-fixture-alpha',
  oracleId: 'fact:alpha:sum',
  limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 60_000, trials: 1 },
};

const TRUTH = ['2000'];

describe('detectContamination', () => {
  it('未命中 → 不污染', () => {
    const report = detectContamination('帮我看看 alpha 的合计', { forbiddenKnowledge: CASE.forbiddenKnowledge, truthPatterns: TRUTH });
    expect(report.contaminated).toBe(false);
    expect(report.hits).toEqual([]);
    expect(report.original).toBe('帮我看看 alpha 的合计');
  });

  it('命中真值模式 → 污染，保留原文与命中项', () => {
    const report = detectContamination('合计应该是 2,000 吧', { forbiddenKnowledge: [], truthPatterns: TRUTH });
    expect(report.contaminated).toBe(true);
    expect(report.hits).toEqual([{ source: 'truth', pattern: '2000' }]);
    expect(report.original).toBe('合计应该是 2,000 吧');
  });

  it('命中 forbiddenKnowledge → 污染（来源标记）', () => {
    const report = detectContamination('我这边工单是 inc-7788，你看下', { forbiddenKnowledge: CASE.forbiddenKnowledge, truthPatterns: [] });
    expect(report.contaminated).toBe(true);
    expect(report.hits).toEqual([{ source: 'forbiddenKnowledge', pattern: '内部工单号 INC-7788' }]);
  });

  it('空白与大小写归一化后仍能命中', () => {
    expect(normalizeForMatch(' Alpha  合计 ')).toBe('alpha合计');
    expect(detectContamination('ALPHA   合计 是 2000', { forbiddenKnowledge: ['alpha 合计'], truthPatterns: [] }).contaminated).toBe(true);
  });

  it('归一化后 <2 字符的模式跳过（避免 2 这类假污染）', () => {
    expect(detectContamination('给我第 2 个', { forbiddenKnowledge: [], truthPatterns: ['2'] }).contaminated).toBe(false);
  });

  it('中文金额归一化：两千 / 一千二 命中对应真值', () => {
    expect(detectContamination('好像是两千吧', { forbiddenKnowledge: [], truthPatterns: ['2000'] }).contaminated).toBe(true);
    expect(detectContamination('两千多一点点', { forbiddenKnowledge: [], truthPatterns: ['2000'] }).contaminated).toBe(true);
    expect(detectContamination('我记得是一千二', { forbiddenKnowledge: [], truthPatterns: ['1200'] }).contaminated).toBe(true);
    expect(detectContamination('八百左右', { forbiddenKnowledge: [], truthPatterns: ['800'] }).contaminated).toBe(true);
  });

  it('中文/阿拉伯数量归一化：两条 / 2 条 / 2条 命中同一数量真值', () => {
    for (const message of ['我记得是两条', '一共 2 条', '就是2条']) {
      const report = detectContamination(message, { forbiddenKnowledge: [], truthPatterns: ['2条'] });
      expect(report.contaminated, message).toBe(true);
    }
    // 声明写成中文、消息写成阿拉伯，也必须收敛到同一 token。
    expect(detectContamination('一共 2 条', { forbiddenKnowledge: [], truthPatterns: ['两条'] }).contaminated).toBe(true);
  });

  it('序号/编号不是数量：第 2 步 / 2 号 / 第二条 不误判', () => {
    const input = { forbiddenKnowledge: [], truthPatterns: ['2条', '2000'] };
    for (const message of ['第 2 步怎么做', '去 2 号窗口', '第二条呢', '第2条记录']) {
      expect(detectContamination(message, input).contaminated, message).toBe(false);
    }
    // 理由：`2 号` / `第 2 步` 的数字是编号/序号，不是「两条」这种数量；`第二条` 是序数指代。
    // 若把序数也拼成数量 token，SIM-02 的正常「第二条」指代会被判成污染——这是不允许的假阳性。
  });
});

describe('模拟用户视角与 prompt 泄漏守卫', () => {
  const view = {
    goal: CASE.goal,
    persona: CASE.persona,
    knowledge: CASE.knowledge,
    behaviorRules: CASE.behaviorRules,
    terminal: CASE.terminal,
    allowedActions: CASE.allowedActions,
    userMessages: ['帮我看一下 alpha 的合计'],
    lastSystemReply: 'alpha 共有 2 条记录，合计 2000。',
    userTurn: 2,
  };

  it('prompt 含目标/人设/已知/行为/终态/历史/可见回复与协议', () => {
    const prompt = buildSimulatorPrompt(view);
    expect(prompt.user).toContain(CASE.goal);
    expect(prompt.user).toContain(CASE.terminal.satisfied);
    expect(prompt.user).toContain('alpha 共有 2 条记录，合计 2000。');
    expect(prompt.user).toContain('"action":"say"');
    expect(prompt.system).toContain('模拟业务用户');
  });

  it('prompt 不含 fixtureId / oracleId / 禁知（用户看不到 Harness 面）', () => {
    const prompt = buildSimulatorPrompt(view);
    const text = prompt.system + prompt.user;
    expect(text).not.toContain(CASE.fixtureId);
    expect(text).not.toContain(CASE.oracleId);
    for (const secret of CASE.forbiddenKnowledge) expect(text).not.toContain(secret);
    expect(findPromptLeaks(prompt, CASE, TRUTH, normalizeForMatch)).toEqual([]);
  });

  it('系统回复里的真值不算泄漏（用户当然看得到回复）', () => {
    const prompt = buildSimulatorPrompt({ ...view, lastSystemReply: '合计为 2000' });
    // 真值出现在系统可见回复里是正常的；守卫只查 fixture/oracle/禁知。
    expect(findPromptLeaks(prompt, CASE, [], normalizeForMatch)).toEqual([]);
  });

  it('用例作者把真值写进 knowledge → findCaseLeaks 命中', () => {
    const leaks = findCaseLeaks({ ...CASE, knowledge: [...CASE.knowledge, '合计是 2000'] }, TRUTH, normalizeForMatch);
    expect(leaks).toEqual(['2000']);
  });

  it('禁知若出现在 prompt（装配错误）→ findPromptLeaks 命中', () => {
    const prompt = buildSimulatorPrompt({ ...view, knowledge: ['内部工单号 INC-7788'] });
    expect(findPromptLeaks(prompt, CASE, TRUTH, normalizeForMatch)).toContain('内部工单号 INC-7788');
  });
});
