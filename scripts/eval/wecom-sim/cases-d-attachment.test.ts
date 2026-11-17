/**
 * D 组·附件时序（W-13～W-18）· 自动用例（企微 × dummy 自动联调；真装配链，见 ./harness.ts）。
 *
 * 机械判据（用户可见结果）：
 *   W-13  文件后 3 秒窗口内补指令 → 合并成一回合，只回一次终帧，且能读到文件内容；
 *   W-14  只发文件 → 一条回执 `已收到 1 个文件`（不带文件名）+ 30s 一条追问（`刚才这 N 个文件…`
 *         + 2~4 个选项）；两条不得都列文件名；写类选项不出现在只读部署；
 *   W-15  文件后补指令 → 不触发追问，直接干活给出真实合计；
 *   W-16  群聊只发文件 → 不发追问（仅单聊触发）；
 *   W-17  连发 3 个文件 → 一条回执（只报个数）+ 一条追问（列文件名），不刷屏；
 *   W-18  追问后回数字 → 按选项执行（真实文件汇总），系统注记接线可查。
 *
 * 时钟纪律：30s 追问经 attachmentNudgeClock 注入 ManualClock（不真 sleep 30s）；
 * 渠道并窗（合并 3s / 回执 2s）是适配器真实定时器——适配器没有时钟注入缝（如实登记，
 * 未擅改产品），用例用事件驱动的 waitFor 等到点（每条 ≤5s 真实等待，无固定 sleep）。
 * 反向绊线见用例文件底部注释与 docs/product/wecom-live-dummy-cases.md 复核记录。
 */
import { describe, expect, it } from 'vitest';
import {
  mainAttachmentSummaryResponses,
  messagesTextOf,
  NUDGE_AFTER_MS,
  settleDispatch,
  startWecomSim,
  salesSampleXlsxAsync,
} from './harness';

const MERGED_SUMMARY_TEXT = '按客户汇总一下金额\n[附件:销售明细.xlsx]';

function optionsOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s/.test(line))
    .map((line) => line.replace(/^\d+\.\s*/, ''));
}

describe('D 组·附件时序（W-13～W-18）', () => {
  it('W-13 文件+3 秒窗口内补指令：合并一回合、只回一次终帧、能读到文件内容', async () => {
    const sample = await salesSampleXlsxAsync();
    const sim = await startWecomSim({ label: 'w13' });
    try {
      sim.book.mainTurn(MERGED_SUMMARY_TEXT, mainAttachmentSummaryResponses(false));
      sim.sendFile('销售明细.xlsx', sample);
      await settleDispatch(); // 文件下载落盘、并入合并窗（live 上毫秒级完成；此处确定性等价）
      sim.sendText('按客户汇总一下金额'); // 窗口内到达（3s 定时器远未到点）
      await sim.waitFor('合并回合终帧', () => sim.finalBubbles().length === 1);

      // 只回一次：终帧恰好一条；且没有附件回执（`已收到…` 不出现）。
      const bubbles = sim.finalBubbles();
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0]!.content).toContain('39000'); // 文件真实内容（合计）被读到
      expect(bubbles[0]!.content).not.toContain('已收到');
      // 机械事实：本回合一次登记、一次 message_done；没有第二个回合。
      expect(sim.logs.filter((line) => line['event'] === 'inbound_files_registered')).toHaveLength(1);
      const doneEvents = sim.logs.filter((line) => line['event'] === 'message_done');
      expect(doneEvents).toHaveLength(1);
      // 不刷两条气泡：合并回合之外没有回执窗补发（wecom_delivery_mode_undeclared 与本判据无关）。
      expect(sim.nudgeTexts()).toHaveLength(0);
    } finally {
      await sim.close();
    }
  }, 60_000);

  it('W-14 只发文件：一条回执（只报个数、不带名）+ 30s 一条追问（列名 + 2~4 个选项）', async () => {
    const sample = await salesSampleXlsxAsync();
    const sim = await startWecomSim({ label: 'w14' });
    try {
      sim.sendFile('销售明细.xlsx', sample);
      // 渠道回执：合并窗 3s flush → 纯附件回合 → 回执并窗 2s → `已收到 1 个文件`（真实定时器到点）。
      await sim.waitFor('回执出现', () => sim.finalBubbles().some((bubble) => bubble.content.startsWith('已收到')));
      const receipt = sim.finalBubbles().find((bubble) => bubble.content.startsWith('已收到'));
      expect(receipt!.content).toContain('已收到 1 个文件');
      expect(receipt!.content).not.toContain('销售明细.xlsx'); // 回执不带文件名（2026-11-17 修）

      // 30s 主动追问：注入时钟推进，不真 sleep。
      await sim.clock.advance(NUDGE_AFTER_MS);
      const nudges = sim.nudgeTexts();
      expect(nudges).toHaveLength(1);
      const nudge = nudges[0]!;
      expect(nudge).toContain('刚才这 1 个文件：销售明细.xlsx');
      expect(nudge).toContain('你想让我先做什么');
      expect(nudge).toContain('回复数字即可');
      const options = optionsOf(nudge);
      expect(options.length).toBeGreaterThanOrEqual(2);
      expect(options.length).toBeLessThanOrEqual(4);
      expect(options).toContain('其他（直接说你的要求）');
      // 只读部署不出现写类选项（默认 allowWriteOperations=false）。
      expect(nudge).not.toContain('生成新的汇总表');
      // 两条气泡不得都列文件名：回执不带名（上面已断）+ 追问带名——组合判据成立。
      expect(sim.logs.filter((line) => line['event'] === 'attachment_nudge_sent')).toHaveLength(1);
    } finally {
      await sim.close();
    }
  }, 60_000);

  it('W-15 文件后补指令（别生成文件）：不触发追问、直接干活给出真实合计、不投文件', async () => {
    const sample = await salesSampleXlsxAsync();
    const sim = await startWecomSim({ label: 'w15' });
    try {
      sim.book.mainTurn('帮我汇总金额，别生成文件', mainAttachmentSummaryResponses(false));
      sim.sendFile('销售明细.xlsx', sample);
      // 等合并窗 flush（纯附件回合已发生、回执已出）——证明追问「本来已排上」。
      await sim.waitFor('纯附件回合已发生', () =>
        sim.logs.some((line) => line['event'] === 'message_attachment_only'));
      await sim.waitFor('回执出现', () => sim.finalBubbles().some((bubble) => bubble.content.startsWith('已收到')));
      sim.sendText('帮我汇总金额，别生成文件');
      await sim.waitFor('干活回合终帧', () => sim.finalBubbles().some((bubble) => bubble.content.includes('39000')));

      expect(sim.finalBubbles().filter((bubble) => bubble.content.includes('39000'))).toHaveLength(1);
      // 不生成文件：零上传、零主动媒体、无 file_delivery 事件。
      expect(sim.sdk.uploads).toHaveLength(0);
      expect(sim.sdk.media).toHaveLength(0);
      expect(sim.logs.some((line) => line['event'] === 'file_delivery')).toBe(false);
      // 用户已给指令：30s 后不发追问。
      await sim.clock.advance(NUDGE_AFTER_MS);
      expect(sim.nudgeTexts()).toHaveLength(0);
      expect(sim.logs.some((line) => line['event'] === 'attachment_nudge_sent')).toBe(false);
    } finally {
      await sim.close();
    }
  }, 60_000);

  it('W-16 群聊只发文件：纯附件回合照常发生，但不发追问（仅单聊触发）', async () => {
    const sample = await salesSampleXlsxAsync();
    const sim = await startWecomSim({ label: 'w16' });
    try {
      sim.sendFile('销售明细.xlsx', sample, { chatType: 'group', conversationId: 'group-w' });
      // 等纯附件回合真实发生（登记已做）——不是「什么都没跑所以没有追问」的假绿。
      await sim.waitFor('群聊纯附件回合已发生', () =>
        sim.logs.some((line) => line['event'] === 'message_attachment_only'));
      await sim.clock.advance(NUDGE_AFTER_MS);
      expect(sim.nudgeTexts()).toHaveLength(0);
      expect(sim.logs.some((line) => line['event'] === 'attachment_nudge_sent')).toBe(false);
    } finally {
      await sim.close();
    }
  }, 60_000);

  it('W-17 连发 3 个文件：一条回执（只报个数）+ 一条追问（列 3 个文件名），不刷屏', async () => {
    const sample = await salesSampleXlsxAsync();
    const sim = await startWecomSim({ label: 'w17' });
    try {
      sim.sendFile('销售明细.xlsx', sample);
      sim.sendFile('客户往来.xlsx', sample);
      sim.sendFile('说明.docx', sample);
      await sim.waitFor('回执出现', () => sim.finalBubbles().some((bubble) => bubble.content.startsWith('已收到')));
      // 一条回执，只报个数、不带名（去重计数=3；不逐条回执）。
      const receipts = sim.finalBubbles().filter((bubble) => bubble.content.startsWith('已收到'));
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.content).toContain('已收到 3 个文件');
      for (const name of ['销售明细.xlsx', '客户往来.xlsx', '说明.docx']) {
        expect(receipts[0]!.content).not.toContain(name);
      }
      // 一条追问，列 3 个文件名 + 选项。
      await sim.clock.advance(NUDGE_AFTER_MS);
      const nudges = sim.nudgeTexts();
      expect(nudges).toHaveLength(1);
      for (const name of ['销售明细.xlsx', '客户往来.xlsx', '说明.docx']) {
        expect(nudges[0]).toContain(name);
      }
      expect(optionsOf(nudges[0]!).length).toBeGreaterThanOrEqual(2);
      expect(optionsOf(nudges[0]!).length).toBeLessThanOrEqual(4);
      // 总共两条用户可见消息：1 回执（终帧）+ 1 追问（主动文字），没有第三条。
      expect(sim.finalBubbles()).toHaveLength(1);
      expect(sim.logs.filter((line) => line['event'] === 'attachment_nudge_sent')).toHaveLength(1);
    } finally {
      await sim.close();
    }
  }, 60_000);

  it('W-18 追问后回 1：按「1=汇总统计」执行（真实文件汇总 39000），注记接线可查', async () => {
    const sample = await salesSampleXlsxAsync();
    const sim = await startWecomSim({ label: 'w18' });
    try {
      sim.book.mainTurn('1', mainAttachmentSummaryResponses(false));
      sim.sendFile('销售明细.xlsx', sample);
      // 与 W-14 同一前半段：回执 → 注入时钟推进 → 追问（ManualClock 不自行走时）。
      await sim.waitFor('回执出现', () => sim.sdk.bubbles.some((bubble) => bubble.finish && bubble.content.startsWith('已收到')));
      await sim.clock.advance(NUDGE_AFTER_MS);
      const nudge = sim.nudgeTexts()[0]!;
      const options = optionsOf(nudge);
      expect(options.length).toBeGreaterThanOrEqual(2); // 追问必须真带选项（编号才有意义）

      sim.sendText('1');
      await sim.waitFor('数字回合终帧', () => sim.finalBubbles().length === 2);
      const reply = sim.finalBubbles()[1]!.content;
      // 按选项执行 = 真实读文件汇总（不是反问「1 是什么意思」，也不是编的数）。
      expect(reply).toContain('39000');
      expect(reply).toContain('华远贸易 21000 元');
      expect(reply).toContain('明达物流 18000 元');
      // 追问的编号靠「系统注记」（doc §6-4）：`1` 回合的模型请求必须带同一份选项。
      const requestText = messagesTextOf(sim.book.requestMessagesOf('main', '1'));
      expect(requestText).toContain('[系统主动提示]');
      for (const option of options) expect(requestText).toContain(option);
    } finally {
      await sim.close();
    }
  }, 60_000);
});

/*
 * 反向绊线（已实测，见 docs/product/wecom-live-dummy-cases.md §10 本轨复核记录）：
 *   ① 把 packages/channel-wecom/src/adapter.ts 的 ATTACHMENT_MERGE_WINDOW_MS 改成 0
 *      （或本夹具 mergeWindowMs: 0）→ W-13 的「只回一次终帧」必红（文件立即 flush 成
 *      纯附件回合 + 回执，指令自成第二回合）；复原后绿。
 *   ② 把 packages/agent/src/attachment-nudge.ts 的 renderAttachmentNudge 选项集合摘掉
 *      （只留首句）→ W-14/W-17 的选项数断言（2~4）与 W-18 的注记选项断言必红；复原后绿。
 */
