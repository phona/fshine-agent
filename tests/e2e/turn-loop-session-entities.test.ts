// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：会话实体——实体门禁的第四来源（任务 1 标定修复）。
 * 共享替身见 ./harness.ts（真 SQLite、真配置派生的网关计划门、mock 执行器）。
 *
 * 2026-09-27 一次真实企微通话暴露的事故：实体门按**每轮无状态**标定，产品是**连续会话**——
 * 用户"查完某个对象"之后只补一个范围编码（本轮消息里没有对象名），对象不在「本轮消息 /
 * 宿主证据 / 平台响应」任一里，查询被门禁判死，用户被要求重新报名字。门禁防幻觉的功能
 * 必须保留（flash 模型真幻觉过对象名），错的是出处范围：本会话用户**亲自操作过/确认过**
 * 的实体同样是合法出处。
 *
 * 本文件复刻事故形状并钉两件事：
 *   ① 验收用例（来源 A）：回合1 查询成功（task 落库）→ 回合2 用户只发期间编码（无线索词）
 *      → 门禁放行、查询执行、回复不含"请确认账套"；
 *   ② 完整事故复刻（来源 A + B）：宿主发澄清 → 裸编号"1"被宿主机械绑定到候选（不再过模型
 *      解释）→ 期间追问照常落地（此时对象名来自回合2 执行过的 task，即来源 A）。
 *
 * 替身的实体门禁是**显式开启**的（`gatedWorker(script, { enforceEntityScope: true })`）：
 * 与真实驱动同一把尺（validatePlanEntities + 本任务平台响应）。其余共享夹具先于门禁存在、
 * 参数并非都逐字可溯源，那批夹具的保真改造不在本包范围（见 harness.ts 拦截处说明）。
 */
import { describe, expect, it } from 'vitest';
import { balanceCalls, boot, gatedWorker, mainDriver, totalActualCalls, withoutPlatformEnvelope, type WorkerStep } from './harness';

/** 记录宿主注入给 worker 的实体来源（门禁判定就在它上面做）。 */
function recordingWorker(script: WorkerStep[]) {
  const inner = gatedWorker(script, { enforceEntityScope: true });
  const sources: Array<{ sessionEntities?: readonly string[]; currentMessage: string } | undefined> = [];
  return {
    sources,
    driver: {
      run: async (input: { sessionId?: string; messages: Array<{ role: string; content: string }>; entitySources?: never }) => {
        sources.push(input.entitySources as never);
        return inner.run(input as never);
      },
    },
  };
}

describe('[L4 集成] 离线全链 e2e：会话实体（实体门禁第四来源）', () => {
  it('SE-e2e-1 事故形状：执行过的账套 + 本轮只发期间编码 → 门禁放行、查询落地', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // 回合1：真实执行（计划激活 + 真跑 operation，task 落库带 calls 快照）
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税 202606 应收账款余额为 61000 元。' },
      { end: true },
      // 回合2：用户只发"202609"。模型按上轮结果把对象解析进 request（生产形状），
      // worker 提交的计划带 --query 幻辰财税——它只应来自本会话执行底账（来源 A）。
      // 202609 在 mock 里无余额键（幻辰财税 1122 只有 202606/current）→ 单调用计划撞
      // not_found + PERIOD_NO_DATA：错误态快路径 v2 后镜像在本跳以宿主话术收束本回合，
      // 脚本里不再有"贴无数据文本"的一段（见 harness terminalMirror 注释）。
      { plan: balanceCalls('幻辰财税', '202609') },
    ]);
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额' },
    ];
    const { send, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });

    const first = await send('查一下幻辰财税 202606 的应收账款余额');
    expect(first).toContain('61000');
    expect(first).not.toContain('不应外发');

    // 回合2：消息只有期间编码（无线索词、无对象名）——事故形状
    declarations.push({ kind: 'delegate', request: '查询幻辰财税账套 202609 的应收账款余额' });
    const second = await send('202609');

    // 门禁放行 + 查询真执行（两个回合各一次平台调用）
    expect(totalActualCalls()).toBe(before + 2);
    // 回复是数据答案，不是"请确认账套"式的死局转达。先剥掉替身拼进 worker 文本的平台信封段
    // （harness 已知保真度边界，见 withoutPlatformEnvelope）——平台自己的中文 correctForm
    // 含"请确认期间编码"，不是模型把死局转达给用户。
    expect(withoutPlatformEnvelope(second)).toContain('幻辰财税');
    expect(withoutPlatformEnvelope(second)).not.toContain('请确认');
    expect(second).not.toContain('没有找到唯一匹配');
    expect(second).not.toContain('没有产生任何平台查询');
    expect(second).not.toContain('不应外发');
    // 注入给 worker 的实体来源里带着本会话执行过的对象（本轮消息没有它）
    const secondSources = worker.sources[1];
    expect(secondSources?.currentMessage).toBe('202609');
    expect(secondSources?.sessionEntities).toContain('幻辰财税');
    await assembly.close();
  });

  it('SE-e2e-2 完整事故复刻：澄清 → 裸编号“1”宿主绑定 → 期间追问照常落地', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // 回合1：真调平台——mock 对「幻辰」返回 needs_input + ACCOUNT_SET_AMBIGUOUS
      // （exit 0，调用计入执行痕迹），宿主发澄清
      { plan: balanceCalls('幻辰', '202609') },
      { text: '（worker 的翻译体：不上屏）' },
      { end: true },
      // 回合2：用户"1" → 宿主绑定到候选「幻辰财税」，查询落地
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }] },
      { text: '幻辰财税本期应收余额为 86,000 元。' },
      { end: true },
      // 回合3：用户只发"202609"——对象名此时来自回合2 执行过的 task（来源 A）
      // 同口径：202609 无余额键 → 单调用计划撞 PERIOD_NO_DATA，镜像在本跳以宿主话术
      // 收束本回合（无贴文本段；平台口径是"无数据"，不是"余额为 0"）。
      { plan: balanceCalls('幻辰财税', '202609') },
    ]);
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'delegate', request: '查询幻辰的应收账款余额' },
    ];
    const { send, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });

    // ① 宿主发出澄清（两个候选），用户看到的是机械组装的澄清问题
    const asked = await send('查一下幻辰 202609 的应收账款');
    expect(asked).toContain('幻辰财税');
    expect(asked).toContain('幻辰实业有限公司');
    expect(asked).toContain('你要查哪个');

    // ② 裸编号"1"：宿主绑定（不再让模型猜它是期间编码），查询执行成功
    declarations.push({ kind: 'delegate', request: '查询幻辰财税本期的应收账款余额' });
    const picked = await send('1');
    expect(picked).toContain('86,000');
    expect(picked).not.toContain('没有找到唯一匹配');
    // 注入给 worker 的实体来源带绑定选定的候选（本轮消息只有"1"）
    expect(worker.sources[1]?.currentMessage).toBe('1');
    expect(worker.sources[1]?.sessionEntities).toContain('幻辰财税');

    // ③ 期间追问：门禁放行（对象名来自本会话执行过的 task），查询落地
    declarations.push({ kind: 'delegate', request: '查询幻辰财税账套 202609 的应收账款余额' });
    const followed = await send('202609');
    expect(withoutPlatformEnvelope(followed)).toContain('幻辰财税');
    expect(withoutPlatformEnvelope(followed)).not.toContain('请确认');
    expect(followed).not.toContain('没有找到唯一匹配');
    // 三个回合各一次真实平台调用（事故里回合③ 是死局：零执行 + 要求重新报名字）
    expect(totalActualCalls()).toBe(before + 3);

    // 澄清事件双态落账（真 SQLite）：issued（发出轮）→ resolved（绑定轮，selected 逐字来自候选）
    const events = await assembly.store.conversationLog.list({ principalId: 'wecom:e2e_user', limit: 50 });
    const clarifications = events
      .filter((event) => event.kind === 'clarification_event')
      .map((event) => JSON.parse(event.content ?? '{}') as Record<string, unknown>);
    expect(clarifications).toEqual([
      expect.objectContaining({ status: 'issued', code: 'ACCOUNT_SET_AMBIGUOUS', candidates: ['幻辰财税', '幻辰实业有限公司'] }),
      expect.objectContaining({ status: 'resolved', selected: '幻辰财税' }),
    ]);
    await assembly.close();
  });

  it('SE-e2e-3 对照：没有任何会话实体时，只发期间编码仍被门禁挡下（防幻觉不变）', async () => {
    // 会话里从没执行过查询（platform_tasks 空）：模型提交带对象名的计划照样被拒——
    // 第四来源不破坏"每轮无凭据不放行"的缺省（这正是 flash 幻觉场景要保的）。
    const worker = recordingWorker([
      { plan: balanceCalls('幻辰财税', '202609') },
      { text: '（不会走到：计划先被门禁拒）' },
    ]);
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'delegate', request: '查询幻辰财税账套 202609 的应收账款余额' },
      // 计划被拒 → needs 回路：Main Agent 转达用户（事故里的死局形状）
      { kind: 'conversation', text: '请确认你要查哪个账套，我再查。' },
    ];
    const { send, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });

    const reply = await send('202609');

    expect(reply).toContain('请确认');
    // 零执行：门禁在计划评估前就挡住了，平台一次都没触达
    expect(worker.sources[0]?.sessionEntities ?? []).toEqual([]);
    await assembly.close();
  });
});
