// [L4 集成] fshine + example-gateway 一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：手机事故对话回归——连续性 + 呈现卫生，一个用例钉两族修复。
 * 共享替身见 ./harness.ts（真 SQLite、真 bin/example-gateway 计划门、mock 执行器）。
 *
 * 2026-09-27/28 一次真实企微通话暴露了两族问题，本文件把那次通话固化为回归：
 *   ① 连续性（机制细节见 turn-loop-session-entities.test.ts）：澄清 → 裸编号"1" →
 *      期间追问不死锁；
 *   ② 呈现卫生（dda524f 修的执行层语言泄漏）：通话里用户可见的回复不得带执行语言
 *      指纹——operation 名、内部控制词（额度/熔断/计划门…）、脚本路径、错误码。
 *      事故原声里这些全中。
 *
 * 与 session-entities 篇的分工：那篇钉机制（来源 A/B、clarification_event 双态、
 * 实体来源注入），本篇钉**用户看到的那通电话**——连续、干净、无术语。
 *
 * 已知边界（fixture 保真度，非产品缺陷）：共享替身的 worker 叙述体会把
 * "执行 <op>: RESULT {信封}" 拼进 worker 文本，needs 回路转达时随 worker 文本外发；
 * 真实驱动里主模型自行组织终稿，不复读信封（F4 守卫只挡"整段就是协议材料"的复读
 * ——{"recorded"/"step"} 协议 JSON 与 RESULT 信封（D-069），不裁判 worker 文本里
 * 夹带的叙述）。故本篇对追问轮断言"事故原声的具体泄漏形态缺席"（脚本路径/错误码/
 * 内部控制词），澄清轮（宿主机械组装，无 fixture 叙述体混入）断言完整指纹零命中。
 * 信封整段复读的外发缺口由 PHONE-2 钉住（同文件下方）。
 */
import { describe, expect, it } from 'vitest';
import { executionLanguageFingerprints } from '@fshine/agent';
import { balanceCalls, boot, gatedWorker, mainDriver, totalActualCalls, withoutPlatformEnvelope, type WorkerStep } from './harness';

/**
 * 信封复读型 Main Agent（D-069 的形状）：按脚本申报计划步骤，脚本派完后不组织终稿，
 * 把上一条工具结果里 worker 文本夹带的平台 RESULT 信封**原样抠出来**当回复。
 *
 * 真实驱动里主模型确实看得见信封（worker 把 "执行 <op>: RESULT {信封}" 拼进结果文本），
 * 已暴露的坏习惯是不做翻译、整段信封怼回用户；宿主侧的 F4 复读守卫（runtime.ts 的
 * looksLikeProtocolMaterial）必须把这种形状与 {"recorded"/"step"} 协议 JSON 同族挡下。
 */
function envelopeReplayMainDriver(requests: readonly string[]) {
  let cursor = 0;
  return {
    run: async (input: {
      tools: unknown[];
      messages: unknown[];
      exec: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
    }) => {
      const transcript: unknown[] = [...input.messages];
      for (;;) {
        const request = requests[Math.min(cursor, requests.length - 1)]!;
        cursor += 1;
        const callId = `call_${cursor}`;
        const declaration = { kind: 'delegate', request };
        transcript.push({
          role: 'assistant',
          content: [{ type: 'toolCall', id: callId, name: 'route_current_turn', arguments: declaration }],
          timestamp: Date.now(),
        } as never);
        let outcome: { text?: unknown } | null;
        try {
          outcome = (await input.exec('route_current_turn', declaration)) as { text?: unknown } | null;
        } catch (error) {
          transcript.push({
            role: 'toolResult', toolCallId: callId, toolName: 'route_current_turn',
            content: [{ type: 'text', text: (error as Error).message }], timestamp: Date.now(),
          } as never);
          return { text: (error as Error).message, messages: transcript };
        }
        const serialized = JSON.stringify(outcome);
        transcript.push({
          role: 'toolResult', toolCallId: callId, toolName: 'route_current_turn',
          content: [{ type: 'text', text: serialized }], timestamp: Date.now(),
        } as never);
        // 脚本耗尽：把工具结果 worker 文本里的 RESULT 信封原样当回复（复读，不翻译）。
        // 抠不到信封 = 共享替身的叙述形状漂了，让用例响亮地红，而不是悄悄退化成复读
        // 协议 JSON（那被旧守卫挡着，会假绿）。
        const envelope = /RESULT (\{.*\})\s*$/m.exec(String(outcome?.text ?? ''))?.[1];
        if (cursor >= requests.length) {
          if (!envelope) throw new Error('fixture 漂移：计划步骤工具结果里找不到平台 RESULT 信封');
          return { text: envelope, messages: transcript };
        }
      }
    },
  };
}

describe('[L4 集成] 离线全链 e2e：手机事故对话回归（连续 + 呈现）', () => {
  it('PHONE-1 事故通话三连：澄清干净、编号绑定、期间追问不死锁，无事故泄漏形态', async () => {
    const before = totalActualCalls();
    const worker = gatedWorker([
      // 回合1：mock 对「幻辰」返回 needs_input + ACCOUNT_SET_AMBIGUOUS → 宿主发澄清
      { plan: balanceCalls('幻辰', '202609') },
      { text: '（worker 翻译体：按设计不上屏）' },
      { end: true },
      // 回合2：用户"1" → 宿主绑定候选，查询落地
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }] },
      { text: '幻辰财税本期应收余额为 86,000 元（借方）。' },
      { end: true },
      // 回合3：用户只发"202609"——事故轮：旧行为是实体门死锁 + 要求重新报名字
      // 202609 在 mock 里无余额键 → 单调用计划撞 not_found + PERIOD_NO_DATA：错误态快路径
      // v2 后镜像在本跳以宿主话术收束（无贴文本段，见 harness terminalMirror 注释）——
      // 用户看到的是宿主模板话术，不是 worker 叙述体。
      { plan: balanceCalls('幻辰财税', '202609') },
    ] as WorkerStep[], { enforceEntityScope: true });

    const declarations: Array<Record<string, unknown>> = [
      { kind: 'delegate', request: '查询幻辰的应收账款余额' },
    ];
    const { send, assembly } = await boot({ main: mainDriver(declarations), worker });

    // ── 回合1：宿主机械组装的澄清——完整指纹零命中（fixture 叙述体不混入此路）──
    const asked = await send('查一下幻辰 202609 的应收账款');
    expect(asked).toContain('幻辰财税');
    expect(asked).toContain('幻辰实业有限公司');
    expect(asked).toContain('你要查哪个');
    expect(executionLanguageFingerprints(asked)).toEqual([]);

    // ── 回合2：裸编号"1"被宿主绑定，查询落地 ──
    declarations.push({ kind: 'delegate', request: '查询幻辰财税本期的应收账款余额', text: '幻辰财税本期应收余额为 86,000 元（借方）。' });
    const picked = await send('1');
    expect(picked).toContain('86,000');
    expect(picked).not.toContain('没有找到唯一匹配');

    // ── 回合3：期间追问不死锁（事故轮）──
    // 不带 text 兜底：本轮以宿主终局话术收束（context.ts 的 terminalFailure 分支经
    // ToolUserError 终结，申报 text 走不到），贴一段叙述体反而是旧形状的残影。
    declarations.push({ kind: 'delegate', request: '查询幻辰财税账套 202609 的应收账款余额' });
    const followed = await send('202609');
    // 先剥掉替身拼进 worker 文本的平台信封段（harness 已知保真度边界，见 withoutPlatformEnvelope）：
    // 平台自己的中文 correctForm 含"请确认期间编码"、错误码 PERIOD_NO_DATA 是平台码，
    // 都不是模型说漏嘴——要判的是 worker 叙述体。
    expect(withoutPlatformEnvelope(followed)).toContain('幻辰财税');
    expect(withoutPlatformEnvelope(followed)).not.toContain('请确认');
    expect(withoutPlatformEnvelope(followed)).not.toContain('没有产生任何平台查询');

    // ── 呈现卫生（追问轮，fixture 保真度内的判据）：事故原声的泄漏形态全部缺席 ──
    for (const [label, reply] of [['编号', picked], ['追问', followed]] as const) {
      const said = withoutPlatformEnvelope(reply);
      expect(said, `${label} 回复漏脚本路径`).not.toMatch(/src\/[^\s）)，,，；;]*\.js/);
      expect(said, `${label} 回复漏错误码`).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
      expect(said, `${label} 回复漏内部控制词`).not.toMatch(/额度|配额|熔断|计划门|拒绝上限|重试上限/);
    }

    // 三个回合各一次真实平台调用（事故里回合③ 零执行 + 要求重新报名字）
    expect(totalActualCalls()).toBe(before + 3);
    await assembly.close();
  });

  it('PHONE-2 主模型把平台 RESULT 信封当回复：守卫收尾替换，信封不外发（D-069）', async () => {
    const before = totalActualCalls();
    const worker = gatedWorker([
      // 计划步骤真跑过一次查询：回合有执行痕迹，worker 文本里夹带着真实平台信封。
      // 查 202606（有余额键）：错误态快路径 v2 后，单调用计划撞无数据终局的本跳文本
      // 是宿主话术、不再夹带信封——本用例的意图是 D-069 复读守卫，需要信封在场。
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税本期应收余额为 86,000 元（借方）。' },
      { end: true },
    ] as WorkerStep[]);
    const { send, assembly } = await boot({
      main: envelopeReplayMainDriver(['第1/1步：查询幻辰财税账套 202609 的应收账款余额']),
      worker,
    });

    const reply = await send('查一下幻辰财税 202609 的应收账款');

    // 查询真跑过：被复读的信封来自真实平台调用（mock 执行器），不是手抄的 fixture
    expect(totalActualCalls()).toBe(before + 1);
    // 宿主收尾替换：计划步骤事实汇总顶上（planFallback 家族），信封一个字不外发
    expect(reply).toContain('本轮拆解的进度如下');
    expect(reply).toContain('已执行成功的步骤：第 1/1 步');
    expect(reply).not.toContain('"v":1');
    expect(reply).not.toContain('"op"');
    expect(reply).not.toContain('finance.query-receivables');
    // 收尾文本本身也是干净的：执行语言指纹零命中
    expect(executionLanguageFingerprints(reply)).toEqual([]);
    await assembly.close();
  });
});
