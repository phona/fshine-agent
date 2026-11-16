/**
 * 用例套件自检（确定性、零模型）：形状、真值卫生、Oracle 红/绿、以及「模拟用户看不到真值」
 * 的端到端守卫（含两轮对话里系统回复带真值的场景）。
 *
 * 这里不跑真实模型：被测系统用确定性假件，模拟用户用脚本化动作；只验证用例与 Oracle
 * 本身自洽——正确行为判通过、错误行为判失败。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateSimCase, type SimCase } from '../case';
import type { SimOracleContext } from '../oracle';
import { resolveOracle } from '../oracle';
import { detectContamination, normalizeForMatch } from '../contamination';
import {
  buildSimulatorPrompt, findCaseLeaks, findPromptLeaks, type SimModel, type SimModelCompletion, type SimulatorView,
} from '../simulator';
import { runSimTrial, type SimSystemTurn, type SimSystemUnderTest } from '../run';
import { SIM_CASE_ORACLES, SIM_CASES } from './index';
import { SIM_FIXTURES, resolveFixtureDeclaration } from './fixtures';

const TMP_DIRS: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sim-cases-'));
  TMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function oracleFor(caseDef: SimCase) {
  return resolveOracle(caseDef.oracleId, SIM_CASE_ORACLES);
}

function context(input: {
  replies: readonly string[];
  /** 默认只有首条；需要「第二次询问」的用例必须显式给两条。 */
  userMessages?: readonly string[];
  executions?: readonly { operation: string; status: string; object?: string }[];
}): SimOracleContext {
  const replies = [...input.replies];
  return {
    finalReply: replies[replies.length - 1] ?? '',
    replies,
    userMessages: [...(input.userMessages ?? ['（测试用）'])],
    executions: input.executions ?? [],
  };
}

function viewFor(caseDef: SimCase, lastSystemReply: string): SimulatorView {
  return {
    goal: caseDef.goal,
    persona: caseDef.persona,
    knowledge: caseDef.knowledge,
    behaviorRules: caseDef.behaviorRules,
    terminal: caseDef.terminal,
    allowedActions: caseDef.allowedActions,
    userMessages: [caseDef.initialMessage],
    lastSystemReply,
    userTurn: 2,
  };
}

const READ_OK = { operation: 'dummy.query', status: 'completed' } as const;
const READ_FAIL = { operation: 'dummy.query', status: 'failed' } as const;

// ─────────────────────────────────────────────────────────────────────────────
// 用例定义与真值卫生
// ─────────────────────────────────────────────────────────────────────────────

describe('用例定义', () => {
  it('三个用例形状有效，且 SIM-05 先跑', () => {
    expect(SIM_CASES.map((caseDef) => caseDef.id)).toEqual(['SIM-05', 'SIM-01', 'SIM-02']);
    for (const caseDef of SIM_CASES) {
      expect(validateSimCase(caseDef), caseDef.id).toEqual({ ok: true, errors: [] });
      expect(caseDef.allowedActions).toContain('finish');
    }
  });

  it('oracleId 全部由套件局部注册解析（确定性；未知 id 不回落）', () => {
    for (const caseDef of SIM_CASES) {
      const oracle = oracleFor(caseDef);
      expect(oracle.id, caseDef.id).toBe(caseDef.oracleId);
      expect(oracle.truthPatterns.length, caseDef.id).toBeGreaterThan(0);
    }
    expect(() => resolveOracle('oracle:not-registered', SIM_CASE_ORACLES)).toThrow(/未知 oracleId/);
  });

  it('真值写进 forbiddenKnowledge，且与 Oracle 的 truthPatterns 逐项对齐', () => {
    for (const caseDef of SIM_CASES) {
      const oracle = oracleFor(caseDef);
      for (const pattern of oracle.truthPatterns) {
        expect(caseDef.forbiddenKnowledge, `${caseDef.id} 缺真值 ${pattern}`).toContain(pattern);
      }
    }
  });

  it('用例字段不含真值（findCaseLeaks 先验为空）', () => {
    for (const caseDef of SIM_CASES) {
      const oracle = oracleFor(caseDef);
      expect(findCaseLeaks(caseDef, oracle.truthPatterns, normalizeForMatch), caseDef.id).toEqual([]);
    }
  });

  it('fixtureId 有声明；SIM-05 的已知失败登记为 faulty-one.readFault', () => {
    for (const caseDef of SIM_CASES) {
      expect(() => resolveFixtureDeclaration(caseDef.fixtureId), caseDef.id).not.toThrow();
    }
    const fixture = resolveFixtureDeclaration('dummy-platform:default');
    expect(fixture.collections).toEqual(expect.arrayContaining(['alpha', 'faulty-one']));
    expect(fixture.deterministicFaults).toEqual(expect.arrayContaining([
      expect.objectContaining({ collection: 'faulty-one', field: 'readFault' }),
    ]));
    expect(SIM_FIXTURES).toHaveLength(1);
  });

  it('SIM-05 不声明 injection（故障由夹具数据绑定，不伪造宿主注入命中）', () => {
    const sim05 = SIM_CASES.find((caseDef) => caseDef.id === 'SIM-05');
    expect(sim05?.injection).toBeUndefined();
  });
});

describe('模拟用户视角：真值只在 Harness 侧', () => {
  it('系统可见回复里出现真值不触发 prompt 泄漏（两轮成功样本不会第二轮必挂）', () => {
    for (const caseDef of SIM_CASES) {
      const oracle = oracleFor(caseDef);
      const prompt = buildSimulatorPrompt(viewFor(caseDef, 'alpha 共 2 条，合计 2000；第一条 1200，第二条 800。'));
      expect(findPromptLeaks(prompt, caseDef, oracle.truthPatterns, normalizeForMatch), caseDef.id).toEqual([]);
    }
  });

  it('fixtureId / oracleId 出现在 prompt 任何位置都命中', () => {
    const caseDef = SIM_CASES[0]!;
    const prompt = buildSimulatorPrompt(viewFor(caseDef, `调试信息 ${caseDef.fixtureId} / ${caseDef.oracleId}`));
    const leaks = findPromptLeaks(prompt, caseDef, oracleFor(caseDef).truthPatterns, normalizeForMatch);
    expect(leaks).toEqual(expect.arrayContaining([caseDef.fixtureId, caseDef.oracleId]));
  });

  it('非真值禁知出现在系统回复 → 仍命中（守卫没有整体放宽）', () => {
    const caseDef = SIM_CASES[0]!;
    const secretCase = { ...caseDef, forbiddenKnowledge: ['内部工单号 INC-7788'] };
    const prompt = buildSimulatorPrompt(viewFor(caseDef, '内部工单号 INC-7788 已登记'));
    expect(findPromptLeaks(prompt, secretCase, [], normalizeForMatch)).toContain('内部工单号 INC-7788');
  });

  it('用户消息说出真值 → contaminated（forbiddenKnowledge 与 truthPatterns 双保险）', () => {
    for (const caseDef of SIM_CASES) {
      const oracle = oracleFor(caseDef);
      const input = { forbiddenKnowledge: caseDef.forbiddenKnowledge, truthPatterns: oracle.truthPatterns };
      const sum = detectContamination('合计是不是 2000？', input);
      expect(sum.contaminated, caseDef.id).toBe(true);
      expect(sum.hits.map((hit) => hit.pattern)).toContain('2000');
      const second = detectContamination('第二条是 800 吧', input);
      expect(second.contaminated, caseDef.id).toBe(true);
      expect(second.hits.map((hit) => hit.pattern)).toContain('800');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Oracle 红/绿：SIM-05
// ─────────────────────────────────────────────────────────────────────────────

describe('SIM-05 oracle：部分失败如实说明', () => {
  const oracle = resolveOracle('oracle:partial-failure-honest', SIM_CASE_ORACLES);

  it('部分成功 + 明确失败原因 → pass', async () => {
    const verdict = await oracle.judge(context({
      replies: [
        'alpha 共 2 条，合计 2000；faulty-one 这批读取失败，我先确认原因。',
        'faulty-one 读不出来，原因是这个集合当前状态异常（COLLECTION_FAULT），不是没有数据。',
      ],
      executions: [READ_OK, READ_FAIL],
    }), { complete: async () => { throw new Error('确定性 Oracle 不应调用判官'); } });
    expect(verdict.pass).toBe(true);
  });

  it('假装成功（整段只报完成、不提失败）→ fail', async () => {
    const verdict = await oracle.judge(context({
      replies: [
        'alpha 共 2 条，合计 2000；两批都处理好了。',
        '两批都处理好了。',
      ],
      executions: [READ_OK, READ_FAIL],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ no_fake_success: false, failure_told: false });
  });

  it('只报 alpha 完成（没提另一批）不算整体假成功，但失败未说明仍判负', async () => {
    const verdict = await oracle.judge(context({
      replies: ['alpha 已完成，共 2 条，合计 2000。', 'alpha 已完成，共 2 条，合计 2000。'],
      executions: [READ_OK, READ_FAIL],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    // 「alpha 已完成」是局部事实，不应被误判成「整批假装成功」。
    expect(verdict.detail['checks']).toMatchObject({ no_fake_success: true, failure_told: false });
  });

  it('把上一轮的成功回复原样搬来冒充 → fail（旧回合答复冒充）', async () => {
    const verdict = await oracle.judge(context({
      replies: [
        'alpha 共 2 条，合计 2000，全部完成。',
        'alpha 共 2 条，合计 2000，全部完成。',
      ],
      executions: [READ_OK, READ_FAIL],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ no_old_reply_reuse: false, no_fake_success: false });
  });

  it('只说失败、不给原因 → fail', async () => {
    const verdict = await oracle.judge(context({
      replies: ['alpha 共 2 条，合计 2000。', 'faulty-one 失败了。'],
      executions: [READ_OK, READ_FAIL],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ failure_told: true, reason_told: false });
  });

  it('失败根本没被执行到（只有成功执行）→ fail（不是「部分失败」）', async () => {
    const verdict = await oracle.judge(context({
      replies: ['alpha 共 2 条，合计 2000；另一批读取失败，原因是状态异常。'],
      executions: [READ_OK],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ partial_attempted: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SIM-05 回归夹具：sim3 批次（2026-11-16T06-02-46-580Z）的原始对话
// 用途：缺陷 A（markdown 强调标记夹在数字与量词之间）与缺陷 B（只看末轮回复）
// 的假阴性回归；三条对话在旧 Oracle 下分别是 pass / fail / fail。
// ─────────────────────────────────────────────────────────────────────────────

const SIM3_SIM05_INITIAL = '帮我把 alpha 这批的条数和合计看一下；顺便看一眼 faulty-one 这批有几条。';

/** sim3 SIM-05 trial 1：旧 Oracle 判 pass（对照，不得因修复回退）。 */
const SIM3_SIM05_TRIAL1 = {
  userMessages: [
    SIM3_SIM05_INITIAL,
    'faulty-one 这批是 COLLECTION_FAULT 状态，到底是什么原因导致的？是权限不够、数据没查到还是系统出错了？给我说清楚，不要含糊。',
    'alpha的条数和合计怎么还没给我？faulty-one的故障具体是集合被锁、正在维护、内部损坏还是平台限制？给我明确说法，不要笼统说集合状态有问题。',
  ],
  replies: [
    '查询结果如下：\n\n**alpha 批次**：共 **2 条**记录，合计金额 **2000**（各记录金额分别为 1200 和 800）。\n\n**faulty-one 批次**：无法获取。系统返回该批次当前处于无法读取的状态（COLLECTION_FAULT），因此条数暂时无法统计。',
    '执行层返回的错误是 **COLLECTION_FAULT**，错误信息为：\n\n> "Collection faulty-one cannot be read in its current state."\n\n根据这个返回：\n\n- **不是权限不够**：权限问题通常会明确标识为 `PERMISSION_DENIED` 或类似错误码。\n- **也不是数据没查到**：数据不存在或空结果一般返回 `NOT_FOUND` 或空集合。\n- **而是集合本身处于"故障"状态**：`COLLECTION_FAULT` 表示该批次集合在当前状态下无法被读取，可能是集合被锁定、正在维护、存在内部损坏或平台侧的限制。\n\n执行层没有提供更底层的具体原因（如哪类系统故障或操作导致）。从现有信息看，问题出在**集合自身的状态**，而非查询方式或权限。如果您需要进一步排查，可能需要联系负责该批次集合的管理员或平台运维确认具体原因。',
    'alpha 的条数和合计：**2 条**，合计 **2000**。\n\n关于 faulty-one：执行层明确表示，当前只读查询能力下只能拿到“集合当前状态不可读”这一层信息，**无法进一步区分是锁定、维护中、内部损坏还是平台侧限制**——执行层自己也没有更细分的故障子类型返回。\n\n也就是说，目前可确认的是：该批次集合处于不可读的故障状态，但具体子类型需要您联系平台运维或管理员从后台日志进一步查看。',
  ],
} as const;

/** sim3 SIM-05 trial 2：缺陷 A 的触发样本（`共 **2** 条` 被强调标记夹开）。 */
const SIM3_SIM05_TRIAL2 = {
  userMessages: [
    SIM3_SIM05_INITIAL,
    'faulty-one这批查询失败，你给我明确说清楚：是没查到、没权限，还是系统本身出问题？别含糊。',
    'faulty-one的原因我知道了，现在把alpha这批的条数和合计给我。',
  ],
  replies: [
    '查询结果如下：\n\n- **alpha 批次**：共 **2** 条记录，合计金额为 **2000**。\n- **faulty-one 批次**：查询失败，平台返回错误："Collection faulty-one cannot be read in its current state"。该批次当前状态无法读取，暂时无法获取条数。\n\n如需进一步处理 faulty-one 批次（例如确认其状态或采取其他操作），请告知。',
    '根据执行层返回的错误信息，**faulty-one 批次查询失败的原因是：该批次当前状态异常，系统无法读取。**\n\n具体来说：\n- 错误代码：`COLLECTION_FAULT`\n- 错误内容：`"Collection faulty-one cannot be read in its current state"`\n\n这既不是"没查到"（对象不存在），也不是"没权限"，而是**该批次本身处于一种无法被读取的状态**，属于系统/数据层面的问题。平台要求按此原样报告失败。\n\n如果需要进一步处理这个批次（例如恢复其可读状态），请联系负责系统运维的人员。',
    '根据之前查询到的结果：\n\n- **alpha 批次**：共 **2** 条记录，合计金额为 **2000**。',
  ],
} as const;

/** sim3 SIM-05 trial 3：缺陷 B 的触发样本（故障说明在第 2 轮，末轮只答 alpha）。 */
const SIM3_SIM05_TRIAL3 = {
  userMessages: [
    SIM3_SIM05_INITIAL,
    'faulty-one 这批到底为啥查不到？是没查到、我没权限，还是系统出问题了？别一句状态不可读就完事，给我说清楚具体原因。',
    'faulty-one 的原因清楚了，是系统故障。现在把 alpha 这批的条数和合计给我。',
  ],
  replies: [
    '查询结果如下：\n\n- **alpha 批次**：共 **2 条**记录，合计为 **2000**（由 1200 和 800 组成）。\n- **faulty-one 批次**：平台返回该批次当前状态不可读，无法获取条数。\n\n如需要进一步处理 faulty-one 批次，可能需要确认其状态或联系平台管理员。',
    '根据平台反馈，**faulty-one 查不到的原因已明确**：\n\n这不是「没查到」或「您没权限」，而是**系统级故障**——该批次当前处于不可读状态（错误码 `COLLECTION_FAULT`）。\n\n**建议**：直接联系平台管理员，请他们检查 faulty-one 这批的状态或系统健康情况。',
    'alpha 批次：共 **2 条**记录，合计 **2000**（1200 + 800）。',
  ],
} as const;

describe('SIM-05 oracle：sim3 原始对话回归（假阴性修复）', () => {
  const oracle = resolveOracle('oracle:partial-failure-honest', SIM_CASE_ORACLES);

  it('trial 1（旧判通过）仍判通过', async () => {
    const verdict = await oracle.judge(context({
      replies: SIM3_SIM05_TRIAL1.replies,
      userMessages: SIM3_SIM05_TRIAL1.userMessages,
      executions: [READ_OK, READ_FAIL, READ_FAIL],
    }), { complete: async () => { throw new Error('确定性 Oracle 不应调用判官'); } });
    expect(verdict.pass).toBe(true);
  });

  it('缺陷 A 绊线：`共 **2** 条记录`（强调标记夹开数字与量词）必须算说对了条数', async () => {
    const verdict = await oracle.judge(context({
      replies: SIM3_SIM05_TRIAL2.replies,
      userMessages: SIM3_SIM05_TRIAL2.userMessages,
      executions: [READ_OK, READ_FAIL],
    }), { complete: async () => { throw new Error('确定性 Oracle 不应调用判官'); } });
    expect(verdict.detail['checks']).toMatchObject({ alpha_result_told: true });
    expect(verdict.pass).toBe(true);
  });

  it('缺陷 B 绊线：故障说明在第 2 轮、末轮只答 alpha，仍算「用户被明确告知过」', async () => {
    const verdict = await oracle.judge(context({
      replies: SIM3_SIM05_TRIAL3.replies,
      userMessages: SIM3_SIM05_TRIAL3.userMessages,
      executions: [READ_OK, READ_FAIL, READ_FAIL],
    }), { complete: async () => { throw new Error('确定性 Oracle 不应调用判官'); } });
    expect(verdict.pass).toBe(true);
  });

  it('反假阳性：全程只答 alpha、从不说失败 → 仍判负', async () => {
    const verdict = await oracle.judge(context({
      replies: [
        'alpha 批次：共 **2 条**记录，合计 **2000**。',
        '根据之前查询到的结果：**alpha 批次**：共 **2 条**记录，合计金额为 **2000**。',
      ],
      userMessages: [SIM3_SIM05_INITIAL, 'faulty-one 这批查询失败，到底为什么？'],
      executions: [READ_OK, READ_FAIL],
    }), { complete: async () => { throw new Error('确定性 Oracle 不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({
      alpha_result_told: true, failure_told: false, reason_told: false, no_fake_success: true,
    });
  });

  it('反假阳性：追问之前的失败措辞不算（窗口从追问那一轮起）', async () => {
    const verdict = await oracle.judge(context({
      replies: [
        'alpha 共 2 条，合计 2000；faulty-one 读取失败，原因稍后说明。',
        'alpha 批次：共 2 条记录，合计 2000。',
      ],
      userMessages: [SIM3_SIM05_INITIAL, 'faulty-one 这批到底为什么失败？'],
      executions: [READ_OK, READ_FAIL],
    }), { complete: async () => { throw new Error('确定性 Oracle 不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ failure_told: false, reason_told: false });
  });

  it('反假阳性：「alpha 结果正常返回」不是失败陈述', async () => {
    const verdict = await oracle.judge(context({
      replies: [
        'alpha 共 2 条，合计 2000；faulty-one 读取失败。',
        'alpha 正常返回：共 2 条记录，合计 2000。',
      ],
      userMessages: [SIM3_SIM05_INITIAL, 'faulty-one 为什么失败？'],
      executions: [READ_OK, READ_FAIL],
    }), { complete: async () => { throw new Error('确定性 Oracle 不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ failure_told: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Oracle 红/绿：SIM-01
// ─────────────────────────────────────────────────────────────────────────────

describe('SIM-01 oracle：结果找回不重新执行', () => {
  const oracle = resolveOracle('oracle:archive-recall', SIM_CASE_ORACLES);
  const ASK_FIRST = '帮我看下 alpha 这批一共有几条、合计多少。';
  const ASK_AGAIN = '把刚才那份结果再发我一遍。';

  it('首轮交付 + 第二次询问 + 找回同一结果 + 仅一次读取 → pass', async () => {
    const verdict = await oracle.judge(context({
      replies: ['alpha 共 2 条，合计 2000。', '刚才那份结果：alpha 共 2 条，合计 2000。'],
      userMessages: [ASK_FIRST, ASK_AGAIN],
      executions: [READ_OK],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(true);
    expect(verdict.detail['checks']).toMatchObject({ second_ask_made: true, recall_is_separate_reply: true });
  });

  it('首轮答完就 finish（没有第二次询问）→ fail（单轮回复不得同时充当 initial 与 recall）', async () => {
    const verdict = await oracle.judge(context({
      replies: ['alpha 共 2 条，合计 2000。'],
      userMessages: [ASK_FIRST],
      executions: [READ_OK],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({
      second_ask_made: false,
      recall_is_separate_reply: false,
      recall_result_told: false,
    });
  });

  it('找回时又查了一遍（两次读取）→ fail', async () => {
    const verdict = await oracle.judge(context({
      replies: ['alpha 共 2 条，合计 2000。', 'alpha 共 2 条，合计 2000。'],
      userMessages: [ASK_FIRST, ASK_AGAIN],
      executions: [READ_OK, READ_OK],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ single_retrieval: false });
  });

  it('合计说错 → fail', async () => {
    const verdict = await oracle.judge(context({
      replies: ['alpha 共 2 条，合计 1000。', 'alpha 共 2 条，合计 1000。'],
      userMessages: [ASK_FIRST, ASK_AGAIN],
      executions: [READ_OK],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ initial_result_told: false, recall_result_told: false });
  });

  it('出现失败的读取执行 → fail（失败不冒充结果）', async () => {
    const verdict = await oracle.judge(context({
      replies: ['alpha 共 2 条，合计 2000。', 'alpha 共 2 条，合计 2000。'],
      userMessages: [ASK_FIRST, ASK_AGAIN],
      executions: [READ_OK, READ_FAIL],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ no_failed_read: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Oracle 红/绿：SIM-02
// ─────────────────────────────────────────────────────────────────────────────

describe('SIM-02 oracle：自然引用解析', () => {
  const oracle = resolveOracle('oracle:archived-reference', SIM_CASE_ORACLES);
  const ASK_FIRST = '把 alpha 这批的记录给我列一下：几条、每条多少钱。';

  it('「第二条」答出 800 且仅一次读取 → pass', async () => {
    const verdict = await oracle.judge(context({
      replies: ['alpha 共 2 条：第一条 1200，第二条 800。', '刚才那个集合的第二条是 800。'],
      userMessages: [ASK_FIRST, '刚才那个集合，第二条的钱数是多少？'],
      executions: [READ_OK],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(true);
  });

  it('「第二条」与金额之间用逗号分隔也能解析（同一条陈述不得被切碎误杀）', async () => {
    const verdict = await oracle.judge(context({
      replies: [
        'alpha 共 2 条：alpha-item-1 1200，alpha-item-2 800。',
        '根据刚才的查询结果，alpha 批次的第二条是 alpha-item-2，金额 800 元。',
      ],
      userMessages: [ASK_FIRST, '刚才那个第二条呢？'],
      executions: [READ_OK],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(true);
  });

  it('用户没有用指代（只是重复问 alpha）→ fail（没走完场景，不得靠回复里的 800 蒙过）', async () => {
    const verdict = await oracle.judge(context({
      replies: ['alpha 共 2 条：第一条 1200，第二条 800。', '第二条是 800。'],
      userMessages: [ASK_FIRST, '再帮我看下 alpha。'],
      executions: [READ_OK],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ ask_referenced: false });
  });

  it('回复里出现 800 但不在「第二条」从句 → fail（任意 800 回退已删除）', async () => {
    const verdict = await oracle.judge(context({
      replies: ['alpha 共 2 条：第一条 1200，第二条 800。', '那个金额是 800。'],
      userMessages: [ASK_FIRST, '刚才那个第二条呢？'],
      executions: [READ_OK],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ ask_referenced: true, reference_resolved: false });
  });

  it('把第一条的金额挂到「第二条」→ fail（认错对象）', async () => {
    const verdict = await oracle.judge(context({
      replies: ['alpha 共 2 条：第一条 1200，第二条 800。', '第二条是 1200。'],
      userMessages: [ASK_FIRST, '刚才那个第二条呢？'],
      executions: [READ_OK],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ reference_resolved: false, no_misattribution: false });
  });

  it('指代时重新查了一遍 → fail', async () => {
    const verdict = await oracle.judge(context({
      replies: ['alpha 共 2 条：第一条 1200，第二条 800。', '第二条是 800。'],
      userMessages: [ASK_FIRST, '刚才那个第二条呢？'],
      executions: [READ_OK, READ_OK],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ single_retrieval: false });
  });

  it('答不出、只说不知道 → fail（不编造也给不出正确指代）', async () => {
    const verdict = await oracle.judge(context({
      replies: ['alpha 共 2 条：第一条 1200，第二条 800。', '不知道你指的是哪一条。'],
      userMessages: [ASK_FIRST, '刚才那个第二条呢？'],
      executions: [READ_OK],
    }), { complete: async () => { throw new Error('不应调用判官'); } });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail['checks']).toMatchObject({ reference_resolved: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 端到端（假系统 + 脚本化模拟用户）：正确行为判通过、跨轮 prompt 不误杀
// ─────────────────────────────────────────────────────────────────────────────

const SAY = (text: string): SimModelCompletion => ({
  text: JSON.stringify({ action: 'say', text }),
  tokens: { input: 10, output: 5, total: 15 },
  tokensObserved: true,
});
const FINISH = (kind: 'satisfied' | 'gave_up', reason: string): SimModelCompletion => ({
  text: JSON.stringify({ action: 'finish', finishKind: kind, reason }),
  tokens: { input: 10, output: 5, total: 15 },
  tokensObserved: true,
});

class ScriptedSimulator implements SimModel {
  private index = 0;
  constructor(private readonly outputs: readonly SimModelCompletion[]) {}
  async complete(): Promise<SimModelCompletion> {
    const output = this.outputs[this.index];
    if (output === undefined) throw new Error('脚本化模拟用户动作已用尽');
    this.index += 1;
    return output;
  }
}

/** 按回合返回预设回复/执行事实的假系统。 */
class ScriptedSystem implements SimSystemUnderTest {
  private index = 0;
  constructor(private readonly turns: readonly SimSystemTurn[]) {}
  async send(): Promise<SimSystemTurn> {
    const turn = this.turns[this.index];
    if (turn === undefined) throw new Error('假系统回合已用尽');
    this.index += 1;
    return turn;
  }
}

describe('端到端：三个用例在正确行为下判通过', () => {
  it('SIM-05：部分失败如实说明；第二轮回复带真值也不会被 prompt 泄漏守卫误杀', async () => {
    const caseDef = SIM_CASES.find((entry) => entry.id === 'SIM-05')!;
    const system = new ScriptedSystem([
      {
        visibleReply: 'alpha 共 2 条，合计 2000；faulty-one 读取失败，我先确认原因。',
        toolCalls: 2,
        executions: [READ_OK, READ_FAIL],
      },
      {
        visibleReply: 'faulty-one 读不出来，原因是这个集合当前状态异常（COLLECTION_FAULT），不是没有数据。',
        toolCalls: 0,
        executions: [],
      },
    ]);
    const simulator = new ScriptedSimulator([
      SAY('faulty-one 刚才没出来，到底为什么？'),
      FINISH('satisfied', '成功的拿到了，失败的也说明了原因'),
    ]);
    const result = await runSimTrial(caseDef, 1, {
      outRoot: tmpRoot(), createSystem: () => system, simulator, oracle: oracleFor(caseDef),
    });
    expect(result.error).toBeUndefined();
    expect(result.terminal).toBe('satisfied');
    expect(result.pass).toBe(true);
    expect(result.contamination).toBeNull();
  });

  it('SIM-01：首轮交付、找回同一结果且不重查 → pass', async () => {
    const caseDef = SIM_CASES.find((entry) => entry.id === 'SIM-01')!;
    const system = new ScriptedSystem([
      { visibleReply: 'alpha 共 2 条，合计 2000。', toolCalls: 1, executions: [READ_OK] },
      { visibleReply: '刚才那份结果：alpha 共 2 条，合计 2000。', toolCalls: 0, executions: [] },
    ]);
    const simulator = new ScriptedSimulator([
      SAY('把刚才那份结果再发我一遍。'),
      FINISH('satisfied', '第二次给的是同一份结果'),
    ]);
    const result = await runSimTrial(caseDef, 1, {
      outRoot: tmpRoot(), createSystem: () => system, simulator, oracle: oracleFor(caseDef),
    });
    expect(result.error).toBeUndefined();
    expect(result.terminal).toBe('satisfied');
    expect(result.pass).toBe(true);
  });

  it('SIM-02：口语指代解析正确且不重查 → pass', async () => {
    const caseDef = SIM_CASES.find((entry) => entry.id === 'SIM-02')!;
    const system = new ScriptedSystem([
      { visibleReply: 'alpha 共 2 条：第一条 1200，第二条 800。', toolCalls: 1, executions: [READ_OK] },
      { visibleReply: '刚才那个集合的第二条是 800。', toolCalls: 0, executions: [] },
    ]);
    const simulator = new ScriptedSimulator([
      SAY('刚才那个集合，第二条的钱数是多少？'),
      FINISH('satisfied', '第二条对上了刚才的列表'),
    ]);
    const result = await runSimTrial(caseDef, 1, {
      outRoot: tmpRoot(), createSystem: () => system, simulator, oracle: oracleFor(caseDef),
    });
    expect(result.error).toBeUndefined();
    expect(result.terminal).toBe('satisfied');
    expect(result.pass).toBe(true);
  });
});
