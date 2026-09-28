/**
 * 离线全链 e2e：手机事故对话回归——连续性 + 呈现卫生，一个用例钉两族修复。
 * 共享替身见 ./harness.ts（真 SQLite、真 bin/17dz 计划门、mock 执行器）。
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
 * 真实驱动里主模型自行组织终稿，不复读信封（F4 守卫 currently 只挡
 * {"recorded"/"step"} 两种协议 JSON、不挡 RESULT 信封——该缺口已记入债务台账）。
 * 故本篇对追问轮断言"事故原声的具体泄漏形态缺席"（脚本路径/错误码/内部控制词），
 * 澄清轮（宿主机械组装，无 fixture 叙述体混入）断言完整指纹零命中。
 */
import { describe, expect, it } from 'vitest';
import { executionLanguageFingerprints } from '@fshine/agent';
import { balanceCalls, boot, gatedWorker, mainDriver, totalActualCalls, type WorkerStep } from './harness';

describe('离线全链 e2e：手机事故对话回归（连续 + 呈现）', () => {
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
      { plan: balanceCalls('幻辰财税', '202609') },
      { text: '幻辰财税 202609 应收余额为 0 元。' },
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
    declarations.push({ kind: 'delegate', request: '查询幻辰财税账套 202609 的应收账款余额', text: '幻辰财税 202609 应收余额为 0 元。' });
    const followed = await send('202609');
    expect(followed).toContain('幻辰财税');
    expect(followed).not.toContain('请确认');
    expect(followed).not.toContain('没有产生任何平台查询');

    // ── 呈现卫生（追问轮，fixture 保真度内的判据）：事故原声的泄漏形态全部缺席 ──
    for (const [label, reply] of [['编号', picked], ['追问', followed]] as const) {
      expect(reply, `${label} 回复漏脚本路径`).not.toMatch(/src\/[^\s）)，,，；;]*\.js/);
      expect(reply, `${label} 回复漏错误码`).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
      expect(reply, `${label} 回复漏内部控制词`).not.toMatch(/额度|配额|熔断|计划门|拒绝上限|重试上限/);
    }

    // 三个回合各一次真实平台调用（事故里回合③ 零执行 + 要求重新报名字）
    expect(totalActualCalls()).toBe(before + 3);
    await assembly.close();
  });
});
