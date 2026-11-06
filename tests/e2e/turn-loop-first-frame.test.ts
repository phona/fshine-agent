// [L4 集成] fshine + example-gateway 一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：首帧提速——受理即帧（2026-10-16）。共享替身见 ./harness.ts。
 *
 * 背景：渠道 ack（channel-wecom adapter 的 ACK_TEXT）对所有消息秒回"收达"，但到"回合
 * 真正开跑"的第一个反馈之间仍有一段空窗——Main Agent 第一轮 LLM（10–20s）之后，delegate
 * 轮才产生第一帧「正在…」，conversation 轮直到终稿零帧。修复 = 受理即帧：回合真正开跑时
 * （防抖后、出队列、进 runtime 之前）由宿主经 progress 通道发一帧确定性文案
 * （TURN_ACCEPTED_TEXT，两帧语义递进：ack=已收达、受理帧=已开跑）——宿主文案，不是模型
 * 文本，不经过出口校验；附件-only 不启回合所以不发帧。
 *
 * 时序断言口径：harness 的 turn() 只回帧文本不带时刻，这里在生产 adapter 的投递点
 * （sdk.frames）上轮询计时——受理帧出现在投递流里即视为用户可见。
 * harness 的防抖旋钮归零（见 boot 的注释，离线夹具必须把旋钮归零才能验时序本身），
 * 所以上界的钉子是"受理帧不延迟发射"；防抖自身「首条零防抖、后续到达才合并」
 * 的语义由 handler 单测钉（apps/server/handler.test.ts 的「首帧提速」组）。
 * 上界取 <1500（2026-10-16 评审放宽）：仍远小于 2000 默认防抖窗，命题不变，抗慢 CI。
 *
 * 守四件事：
 *   ① 会话轮（此前零帧直到终稿）的受理帧 <1.5s 出现在投递流里；
 *   ② 受理帧每回合恰一帧，且是本回合 steps 的第一帧（先于一切 runtime 帧）；
 *   ③ 受理帧是宿主回执：不进转录、不混进终稿（终稿整体替换仍是纯模型文本）；
 *   ④ 委派轮同样受理即帧，真实进度帧照常跟随。
 */
import { describe, expect, it } from 'vitest';
import { TURN_ACCEPTED_TEXT } from '../../apps/server/handler';
import { boot, mainDriver, type Turn } from './harness';

/** 受理帧文案与 apps/server/handler.ts 的 TURN_ACCEPTED_TEXT 同源（import，不另抄措辞）。 */
const ACCEPTED = TURN_ACCEPTED_TEXT;

/** 在投递流里等某条非 finish 帧出现，返回耗时（毫秒）；超时抛错（红 = 帧没来）。 */
async function waitForFrame(
  sdk: { frames: ReadonlyArray<{ content: string; finish: boolean }> },
  text: string,
  budgetMs = 2_000,
): Promise<number> {
  const start = Date.now();
  for (;;) {
    if (sdk.frames.some((frame) => !frame.finish && frame.content === text)) return Date.now() - start;
    if (Date.now() - start > budgetMs) {
      throw new Error(`等待受理帧超时（${budgetMs}ms）：${text}；已收帧: ${JSON.stringify(sdk.frames)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 会话轮替身：申报 conversation、自由文本回复，不委派（此前这种轮直到终稿零帧）。
 *  文本不带财务数字——出口校验的零执行门会替换"带金额却零执行"的结论，那道门
 *  由 turn-loop-execution 覆盖，这里不测它。 */
function conversationBoot() {
  return boot({
    main: mainDriver([
      { kind: 'conversation', text: '你好，我是记账助手，有什么可以帮你？' },
      { kind: 'conversation', text: '好的，第二句我收到了。' },
    ]),
    worker: { run: async () => { throw new Error('会话轮不应委派'); } },
  });
}

describe('[L4 集成] 离线全链 e2e：受理即帧', () => {
  it('① 会话轮：受理帧 <1.5s 出现在投递流里，终稿照常整体替换', async () => {
    const booted = await conversationBoot();
    const turnPromise: Promise<Turn> = booted.turn('在吗');
    const elapsed = await waitForFrame(booted.sdk, ACCEPTED);
    expect(elapsed).toBeLessThan(1500);
    const turn = await turnPromise;
    expect(turn.text).toContain('记账助手');
    // ③ 受理帧是宿主回执：终稿整体替换后不残留受理文案
    expect(turn.text).not.toContain(ACCEPTED);
    expect(turn.steps).toEqual([ACCEPTED]);
  });

  it('② 每回合恰一帧：第二回合同样受理即帧（不是每会话一帧）', async () => {
    const booted = await conversationBoot();
    const first = await booted.turn('在吗');
    expect(first.steps).toEqual([ACCEPTED]);
    const second = await booted.turn('再问一句');
    expect(second.steps).toEqual([ACCEPTED]);
    expect(second.text).toContain('第二句');
  });

  it('④ 委派轮：受理帧先行，真实进度帧照常跟随', async () => {
    const booted = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额' }]),
      // worker 直接收尾（带执行凭证——否则出口校验的零执行门会替换财务结论，那道门
      // 由 turn-loop-execution 覆盖，这里不测它）。帧形状由 turn-loop-progress-frames
      // 的假 agent 组覆盖，这里只钉"受理帧在前"。
      worker: { run: async (input: { messages: unknown[] }) => ({
        text: '幻辰财税 202606 应收账款余额为 61000 元。',
        messages: [...input.messages, { role: 'assistant', content: '幻辰财税 202606 应收账款余额为 61000 元。', timestamp: Date.now() }],
        execution: { planId: 'plan_first_frame', version: 1, calls: 1 },
      }) },
    });
    const turnPromise: Promise<Turn> = booted.turn('查一下幻辰财税 202606 的应收账款余额');
    const elapsed = await waitForFrame(booted.sdk, ACCEPTED);
    expect(elapsed).toBeLessThan(1500);
    const turn = await turnPromise;
    expect(turn.steps[0]).toBe(ACCEPTED);
    expect(turn.steps.filter((step) => step === ACCEPTED)).toHaveLength(1);
    expect(turn.text).toContain('61000 元');
  });
});
