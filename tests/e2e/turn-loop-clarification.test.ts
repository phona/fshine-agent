// [L4 集成] fshine + 17dz 一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：结构化歧义/未找到 → 宿主机械组装澄清（2026-09-27 Stage 3 事故根治包）。
 * 共享替身见 ./harness.ts（真 SQLite、真 bin/17dz 计划门、mock 执行器）。
 *
 * 事故形状：worker 真调了平台（目录/余额查询返回 ACCOUNT_SET_AMBIGUOUS，exit 0，调用被
 * 计入 execution），却把信封翻译成技术报告——脚本路径、原始错误码、candidates: [] 全上屏。
 * 行为全对（不编造、不代选）但呈现全错。修法：宿主持信封数据机械组装澄清问题，模型不为
 * "状态转换"发音。这条链钉三件事：
 *   ① 单步委派撞歧义 → 用户回复是机械组装的澄清问题（候选清单 + 问句、零执行语言）；
 *   ② 计划模式某步撞歧义 → 停止后续步骤，澄清问题成为本轮回复；
 *   ③ 用户回答后 → 真实查询落地（澄清不是终点，回路照常续跑）。
 */
import { describe, expect, it } from 'vitest';
import { executionLanguageFingerprints } from '../../packages/agent/src/runtime';
import { clarificationTextFor } from '../../packages/agent/src/error-codes';
import { boot, gatedWorker, mainDriver, platformCorrectForm, totalActualCalls, type WorkerStep } from './harness';

/** 事故里的技术报告：执行语言指纹齐全（脚本路径 + 错误码 + JSON 片段）。 */
const TECH_REPORT = '平台返回 ACCOUNT_SET_AMBIGUOUS，candidates: [幻辰财税, 幻辰实业有限公司]；依据 src/finance/scripts/query-receivables.js 的门的规则，实体参数必须逐字来自用户消息。';

/** 记录 worker 实际收到的委派请求（宿主透传 intent.request，不做二次加工）。 */
function recordingWorker(script: WorkerStep[]) {
  const inner = gatedWorker(script);
  const requests: string[] = [];
  return {
    requests,
    driver: {
      run: async (input: { sessionId?: string; messages: Array<{ role: string; content: string }> }) => {
        requests.push(String(input.messages.at(-1)?.content ?? ''));
        return inner.run(input as never);
      },
    },
  };
}

/** 「幻辰」在 mock 目录里命中两个账套：平台返回的选择类候选（只列平台给的）。 */
const QIANLONG_CLARIFICATION = { code: 'ACCOUNT_SET_AMBIGUOUS', query: '幻辰', candidates: ['幻辰财税', '幻辰实业有限公司'] };
const EXPECTED_QUESTION = clarificationTextFor(QIANLONG_CLARIFICATION.code, QIANLONG_CLARIFICATION);

describe('[L4 集成] 离线全链 e2e：结构化歧义 → 宿主机械组装澄清', () => {
  it('C1 单步委派撞歧义：澄清问题由宿主组装，技术报告不上屏；用户回答后真实查询落地', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // 真调了平台：mock 对「幻辰」返回 needs_input + ACCOUNT_SET_AMBIGUOUS（exit 0，
      // 调用计入执行痕迹）——事故形状的关键正是 execution 为真而回复是技术报告
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰', '--period', '202609'] }] },
      { text: TECH_REPORT },
      // worker 收手：这一回合到此为止，用户回答后续跑（同 needs 回路的分段点）
      { end: true },
      // 用户选定「幻辰财税」后续跑：唯一候选，本期余额 86,000（mock 真实数据）
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }] },
      { text: '幻辰财税本期应收余额为 86,000 元。' },
    ]);
    // 只放第一条：歧义回合经 ToolUserError 终止，替身在这一步就返回，第二条声明留给下一回合
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'delegate', request: '查询幻辰的应收账款余额' },
    ];
    const { send, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });

    // ① 歧义回合：用户看到的是宿主持信封数据组装的那一份
    const asked = await send('查一下幻辰的应收账款');
    expect(asked).toBe(EXPECTED_QUESTION);
    expect(asked).toContain('幻辰财税');
    expect(asked).toContain('幻辰实业有限公司');
    expect(asked).toContain('你要查哪个');
    // 执行语言绝迹：脚本路径 / 错误码 / JSON 片段一个都不能出现
    expect(executionLanguageFingerprints(asked)).toEqual([]);
    expect(asked).not.toContain('src/');
    expect(asked).not.toContain('ACCOUNT_SET_AMBIGUOUS');
    expect(asked).not.toContain('candidates');
    expect(asked).not.toContain('不应外发');
    // 平台确实被触达过（不是零执行兜底），但数字结论一条都没有
    expect(totalActualCalls()).toBeGreaterThan(before);

    // ③ 用户回答"幻辰财税"：真实查询落地，回复是数据答案而不是澄清。
    // （零指纹尺只用于澄清回合：替身的 worker 文本机械拼接了原始信封，那不是生产形状。）
    declarations.push({ kind: 'delegate', request: '查询幻辰财税账套本期的应收账款余额' });
    const done = await send('幻辰财税');
    expect(done).toContain('86,000');
    expect(done).not.toContain('没有找到唯一匹配');
    expect(worker.requests[1]).toContain('幻辰财税');
    await assembly.close();
  });

  it('C2 计划模式某步撞歧义：停止后续步骤，澄清问题成为本轮回复', async () => {
    const worker = recordingWorker([
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰', '--period', '202609'] }] },
      { text: TECH_REPORT },
      { end: true },
      // 第二步若被派出去才会用到；澄清终止回合后它不该发生
      // （新兴五金 202609 在 mock 里无余额键 → 若真跑会是 PERIOD_NO_DATA，不是"余额为 0"）
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '新兴五金', '--period', '202609'] }] },
      { text: '新兴五金 202609 应收平台未返回该期间数据。' },
    ]);
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'delegate', request: '第1/2步：查询幻辰的应收账款' },
      { kind: 'delegate', request: '第2/2步：查询新兴五金的应收账款' },
      { kind: 'conversation', text: '汇总：第一步缺信息，第二步已查完。' },
    ];
    const { send, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });

    const reply = await send('查幻辰和新兴五金的应收账款');

    expect(reply).toBe(EXPECTED_QUESTION);
    expect(executionLanguageFingerprints(reply)).toEqual([]);
    // 用户要先回答"查哪个"：第二步没有派发（worker 只被调用一次）
    expect(worker.requests).toHaveLength(1);
    // ② 委派块随载荷走 user message：范围原文在【委派】块里
    expect(worker.requests[0]).toContain('【委派】');
    expect(worker.requests[0]).toContain('范围：查询幻辰的应收账款');
    await assembly.close();
  });

  it('C3 not_found 同样走宿主组装：只给"没有找到"与平台 correctForm 数据', async () => {
    const worker = recordingWorker([
      { plan: [{ operation: 'finance.search-account-sets', args: ['--query', '胜利'] }] },
      { text: '查询完成：候选清单为空（candidates: []），状态 not_found（ACCOUNT_SET_NOT_FOUND），来源 src/finance/scripts/search-account-sets.js。' },
      { end: true },
    ]);
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'delegate', request: '查账套目录里有没有胜利这个帐套' },
      { kind: 'conversation', text: '不应外发' },
    ];
    const { send, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });

    const reply = await send('只查账套目录，看看有没有胜利这个帐套');

    // 宿主只拼结构（"没有找到匹配X的对象。{平台措辞}我再查。"），领域提示是平台 correctForm 数据
    expect(reply).toBe(`没有找到匹配“胜利”的对象。${platformCorrectForm('ACCOUNT_SET_NOT_FOUND')}我再查。`);
    expect(reply).toContain('没有找到匹配“胜利”的对象');
    // 守卫恢复（D-102 已在平台侧修掉）：这条 correctForm 曾含裸 operation 名
    // search-account-sets，经宿主 L2 原样渲染后就是给终端用户看内部协议文本；17dz
    // 已把它改成不含 operation 名的可行动措辞，所以这里回到零命中。尺子本身没动
    // （runtime.ts 的 EXECUTION_LANGUAGE_FINGERPRINTS 报得出这类形态，见 D-098）。
    expect(executionLanguageFingerprints(reply)).toEqual([]);
    await assembly.close();
  });
});
