import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { validatePlanEntities } from '@fshine/agent';
import type { AgentReply, AgentRuntime, AuditStore, ChannelReply, IncomingAttachment, IncomingChannelMessage, TrustedContext } from '@fshine/contracts';
import {
  collectProducedFiles,
  createMessageHandler,
  describeDeliveredFiles,
  parseAttachmentEnvelope,
  TURN_ACCEPTED_TEXT,
  TURN_STILL_WORKING_TEXT,
  withAttachmentPaths,
} from './handler';

const USER = 'user_a';

/** 最小化 AuditStore 替身:只记录调用 */
function fakeStore(): AuditStore {
  return {
    principalScopes: {
      get: async (userId: string) =>
        userId === USER ? { wecomUserId: USER, accountSetIds: ['as_001'], enabled: true } : null,
      list: async () => [],
      upsert: async () => {},
    },
    requests: {
      insert: async () => {},
      get: async () => null,
      findByWecomMessageId: async () => null,
      setOutcome: async () => {},
    },
    toolCalls: {
      insert: async () => {},
      finish: async () => {},
      listByRequest: async () => [],
    },
    sessions: {
      get: async () => null,
      upsert: async () => {},
    },
  } as unknown as AuditStore;
}

function fakeRuntime(order: string[], delayMs: number): AgentRuntime {
  return {
    handleTurn: async (ctx: TrustedContext): Promise<AgentReply> => {
      order.push(`start:${ctx.sessionId}`);
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(`end:${ctx.sessionId}`);
      return { text: 'ok' };
    },
  };
}

describe('createMessageHandler', () => {
  it('计划确认后携带原 taskId 续跑并返回执行结果', async () => {
    const seen: TrustedContext[] = [];
    const runtime: AgentRuntime = {
      handleTurn: async (ctx) => { seen.push(ctx); return { text: '计划执行完成。' }; },
    };
    const handler = createMessageHandler({
      store: fakeStore(),
      runtime,
      planConfirmation: {
        handle: async () => ({ status: 'activated', planId: 'plan_1', version: 2, taskId: 'task_1' }),
      },
    });
    const reply = await handler({ wecomUserId: USER, conversationId: 'c', messageId: 'm1', text: '确认继续', receivedAt: '2026-09-24T00:00:00.000Z' });

    expect(reply).toBe('计划执行完成。');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.resumeTaskId).toBe('task_1');
  });

  it('R9 待确认计划已被新计划取代时给出确定性解释，不再落到通用失败', async () => {
    const seen: TrustedContext[] = [];
    const runtime: AgentRuntime = {
      handleTurn: async (ctx) => { seen.push(ctx); return { text: '不应继续执行。' }; },
    };
    const handler = createMessageHandler({
      store: fakeStore(),
      runtime,
      planConfirmation: {
        handle: async () => ({ status: 'superseded', planId: 'plan_old', version: 2, taskId: 'task_1' }),
      },
    });
    const reply = await handler({ wecomUserId: USER, conversationId: 'c', messageId: 'm2', text: '确认继续', receivedAt: '2026-09-24T00:00:00.000Z' });

    expect(reply).toContain('已经被更新的计划取代');
    expect(reply).not.toContain('处理失败');
    expect(seen).toHaveLength(0);
  });

  it('记录已送达的执行计划通知到可检索历史', async () => {
    const events: Array<{ eventId: string; kind: string; content?: string }> = [];
    const store = {
      ...fakeStore(),
      conversationLog: { append: async (event: typeof events[number]) => { events.push(event); }, list: async () => [], search: async () => [] },
    } as unknown as AuditStore;
    const runtime: AgentRuntime = {
      handleTurn: async (ctx) => {
        await ctx.onNotice?.('账套「幻辰」；期间2026年01月至2026年09月；预计约2分钟。');
        return { text: '查询完成。' };
      },
    };
    const handler = createMessageHandler({ store, runtime });
    await handler({ wecomUserId: USER, conversationId: 'c', messageId: 'm_plan_notice', text: '查本期应收', receivedAt: '2026-09-24T00:00:00.000Z' }, undefined, async () => {});

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'plan_event', content: expect.stringContaining('2026年01月至2026年09月') });
    expect(events[0]?.eventId).toContain('plan_notice');
  });

  it('未授权用户:拒绝并提示(带其 principalId)', async () => {
    const store = fakeStore();
    const handler = createMessageHandler({
      store,
      runtime: fakeRuntime([], 0),
    });
    const reply = await handler(
      { wecomUserId: 'stranger', conversationId: 'c', messageId: 'm1', text: 'hi', receivedAt: '' },
    );
    expect(reply).toContain('未开通查询权限');
    expect(reply).toContain('wecom:stranger');
  });

  it('同一会话并发消息:串行处理(第二回合在第一回合结束后才开始)', async () => {
    const order: string[] = [];
    const store = fakeStore();
    const handler = createMessageHandler({
      store,
      runtime: fakeRuntime(order, 30),
      inboundDebounceMs: 0, // 本条只验串行性，防抖会把总时长拖过用例超时
    });

    const first = handler({ wecomUserId: USER, conversationId: 'c', messageId: 'm1', text: '第一条', receivedAt: '' });
    const second = handler({ wecomUserId: USER, conversationId: 'c', messageId: 'm2', text: '第二条', receivedAt: '' });
    await Promise.all([first, second]);

    const starts = order.filter((entry) => entry.startsWith('start:')).length;
    expect(starts).toBe(2);
    expect(order.indexOf('start:wecom:user_a:c')).toBeLessThan(order.indexOf('end:wecom:user_a:c'));
    expect(order.indexOf('end:wecom:user_a:c')).toBeLessThan(order.lastIndexOf('start:wecom:user_a:c'));
  });
});

// ── 附件路径注入（2026-10-07）─────────────────────────────────────────────────
// 渠道层只负责把附件落盘并给出路径；路径不出现在请求文本里，worker 就看不见它，
// "用户发了 3 个 Excel"与"什么都没发"对下游完全等价——这正是工资表请求无输入的直接原因。
describe('withAttachmentPaths', () => {
  const xlsx = { filename: '2026年8月工资（幻骥达）.xlsx', path: '/tmp/att/abc-2026年8月工资（幻骥达）.xlsx', bytes: 20480 };

  it('无附件时原样返回,不引入多余文本', () => {
    expect(withAttachmentPaths('帮我做工资表', undefined)).toBe('帮我做工资表');
    expect(withAttachmentPaths('帮我做工资表', [])).toBe('帮我做工资表');
  });

  it('路径与文件名都进文本——worker 与审计都要能引用', () => {
    const out = withAttachmentPaths('帮我做幻骥达的工资表', [xlsx]);
    expect(out).toContain('帮我做幻骥达的工资表');
    expect(out).toContain(xlsx.filename);
    expect(out).toContain(xlsx.path);
    // 原文在前:请求语义仍是用户那句话,附件是补充说明
    expect(out.startsWith('帮我做幻骥达的工资表')).toBe(true);
  });

  it('多个附件逐行列全,顺序与传入一致', () => {
    const a = { filename: 'a.xlsx', path: '/tmp/att/a.xlsx', bytes: 1 };
    const b = { filename: 'b.xls', path: '/tmp/att/b.xls', bytes: 2 };
    const out = withAttachmentPaths('做工资表', [a, b]);
    expect(out.indexOf(a.path)).toBeLessThan(out.indexOf(b.path));
    expect(out).toContain('- a.xlsx：/tmp/att/a.xlsx');
    expect(out).toContain('- b.xls：/tmp/att/b.xls');
  });

  // 实体门判据：计划里每个非 flag 参数值都必须逐字出现在当前消息/平台响应里。
  // 这同时钉住两条为附件链路服务的既有纪律：
  //   ① 附件路径必须在请求文本里（本测试的反证）；
  //   ② 期间编码必须由用户给出——worker 不得把"8月"翻译成"202608"（既有硬规则），
  //      所以正面用例的用户原话里就得带上 202608。
  it('附件路径 + 用户给出的期间一起注入后,计划能过实体门', () => {
    const input = withAttachmentPaths('帮我做 202608 的工资表', [xlsx]);
    const scopeError = validatePlanEntities(
      [{ operation: 'payroll.parse-xlsx', args: [xlsx.path, '--period', '202608'] }],
      { currentMessage: input },
    );
    expect(scopeError).toBeNull();
  });

  it('反证:不注入附件路径,同一个计划被实体门拒', () => {
    const scopeError = validatePlanEntities(
      [{ operation: 'payroll.parse-xlsx', args: [xlsx.path, '--period', '202608'] }],
      { currentMessage: '帮我做 202608 的工资表' },
    );
    expect(scopeError).toContain('未在当前请求');
    expect(scopeError).toContain(xlsx.path.slice(0, 20));
  });

  it('期间编码不随文件名推定:用户只说"8月"时计划过不了门(既有纪律不变)', () => {
    const input = withAttachmentPaths('帮我做 8月的工资表', [xlsx]);
    const scopeError = validatePlanEntities(
      [{ operation: 'payroll.parse-xlsx', args: [xlsx.path, '--period', '202608'] }],
      { currentMessage: input },
    );
    expect(scopeError).toContain('202608');
  });
});

// ── 附件-only 消息：只暂存，不启回合（2026-10-07）─────────────────────────────
// 用户的自然用法是"先发文件，再发指令"。若每条文件消息都启一个 Agent 回合：N 个文件 = N 次
// LLM 调用，且串行堵住会话队列——真正带指令的那条排在后面出不来。
// 实测形态：3 个文件 + 1 条指令 → 4 个 ack、0 个最终回复，第一条文件回合卡在 LLM 上
// （10 分钟预算内不返回），用户的指令被它挡死。
describe('附件-only 消息的暂存与交付', () => {
  // 造真实文件：restoreAttachments 会过滤掉盘上不存在的路径（2026-10-07 加的纪律——
  // 别把打不开的路径交给 worker）。用假路径的旧测试正是被这条过滤挡住的。
  const scratch = mkdtempSync(path.join(tmpdir(), 'attach-files-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const file = (name: string): IncomingAttachment => {
    const p = path.join(scratch, name);
    writeFileSync(p, 'x');
    return { filename: name, path: p, bytes: 1 };
  };

  function msg(over: Partial<IncomingChannelMessage>, userId = USER): IncomingChannelMessage {
    return { wecomUserId: userId, conversationId: userId, messageId: `m_${Math.random().toString(36).slice(2, 8)}`, text: '', receivedAt: new Date().toISOString(), ...over };
  }

  /** 记录 insert 的 store + 可断言请求文本的 runtime */
  function probe() {
    const inserted: Array<{ outcome: string; input: string }> = [];
    const base = fakeStore();
    const store = {
      // 本组要构造第二个 UserID，故放开授权（其余组仍用 fakeStore 的单一 UserID）
      ...base,
      principalScopes: { ...base.principalScopes, get: async (userId: string) => ({ wecomUserId: userId, accountSetIds: ['as_001'], enabled: true }) },
      requests: {
        ...fakeStore().requests,
        insert: async (row: { outcome: string; input: string }) => { inserted.push({ outcome: row.outcome, input: row.input }); },
      },
    } as unknown as AuditStore;
    const seen: Array<{ sessionId: string; request: string }> = [];
    const runtime: AgentRuntime = {
      handleTurn: async (ctx: TrustedContext, request: string): Promise<AgentReply> => {
        seen.push({ sessionId: ctx.sessionId, request });
        return { text: 'ok' };
      },
    };
    return { handler: createMessageHandler({ store, runtime }), inserted, seen };
  }

  it('附件-only：不调 Agent，落审计为 attachment_received，正常路径安静', async () => {
    const { handler, inserted, seen } = probe();
    const reply = await handler(msg({ attachmentOnly: true, attachments: [file('a.xlsx')] }));
    expect(seen).toHaveLength(0);
    // 2026-10-19：正常路径返回空串。企微的流式回复按入站消息的 req_id 走，一条用户消息
    // 就是一个气泡——每个文件各回一条"已收到 X"必然是 N 个气泡，再和指令回合那一串帧
    // 在会话里互相穿插。收据并到回合上（describeDeliveredFiles）；渠道侧对附件-only 不起
    // 流，所以空回复不会留下转圈的 spinner（起不起流由 adapter 决定，不靠"必须非空"）。
    expect(reply).toBe('');
    // 文案纪律：不出现"请告诉我需要做什么"这类噪音（一发 N 个文件就刷 N 遍）
    expect(reply).not.toContain('请告诉我');
    expect(inserted.map((r) => r.outcome)).toEqual(['attachment_received']);
    expect(inserted[0]!.input).toContain(file('a.xlsx').path);
  });

  it('暂存的附件在带正文的回合被交付', async () => {
    const { handler, seen } = probe();
    await handler(msg({ attachmentOnly: true, attachments: [file('a.xlsx'), file('b.xls')] }));
    await handler(msg({ text: '帮我做工资表' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.request).toContain('帮我做工资表');
    expect(seen[0]!.request).toContain(file('a.xlsx').path);
    expect(seen[0]!.request).toContain(file('b.xls').path);
  });

  // 2026-10-09 改写：这一条原本写作「附件在会话内累积:后续每个正文回合都带上(不清空)」，
  // 它钉住的是"池子永不清空 + 每轮整批交付"的旧设计——而那正是同日多任务串味的根源
  // （11:30 的凭证任务拿到 10:00 的工资表，worker 无从分辨归属，安静算错钱）。
  // 现在交付按委派边界取（见下方「附件交付边界」组）：本轮没有新附件时**沿用上次委派
  // 交付的那一批**，而不是"把会话里累积的整批再交一遍"。断言一字未减（两轮都带上
  // a.xlsx），变的是理由——不再是"累积"，而是"沿用上次交付集"。
  it('纠正/重试流:没有新附件时沿用上次委派的交付集(不清空)', async () => {
    const { handler, seen } = probe();
    await handler(msg({ attachmentOnly: true, attachments: [file('a.xlsx')] }));
    await handler(msg({ text: '第一句' }));
    await handler(msg({ text: '第二句' }));
    expect(seen).toHaveLength(2);
    expect(seen[0]!.request).toContain(file('a.xlsx').path);
    expect(seen[1]!.request).toContain(file('a.xlsx').path);
  });

  it('上限 8 个 FIFO 逐出最旧的,并告知被逐出的文件名', async () => {
    const { handler, seen } = probe();
    const many = Array.from({ length: 10 }, (_, i) => file(`f${i}.xlsx`));
    await handler(msg({ attachmentOnly: true, attachments: many }));
    await handler(msg({ text: '做工资表' }));
    const req = seen[0]!.request;
    // 保留最后 8 个：f2..f9；最早的 f0、f1 被逐出
    for (let i = 2; i < 10; i += 1) expect(req, `f${i} 应在`).toContain(file(`f${i}.xlsx`).path);
    expect(req).not.toContain(file('f0.xlsx').path);
    expect(req).not.toContain(file('f1.xlsx').path);
  });

  it('同一条消息里既有正文又有附件：直接启回合，不暂存', async () => {
    const { handler, seen } = probe();
    await handler(msg({ text: '看这个', attachments: [file('a.xlsx')] }));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.request).toContain(file('a.xlsx').path);
  });

  it('超过暂存上限：收下前 N 个，其余明确告知（不静默丢）', async () => {
    const { handler, inserted, seen } = probe();
    const many = Array.from({ length: 10 }, (_, i) => file(`f${i}.xlsx`));
    const reply = await handler(msg({ attachmentOnly: true, attachments: many }));
    expect(seen).toHaveLength(0);
    // 一轮就超限：多出的要明确说，不能静默丢（最初实现只处理了"挤掉旧文件"）
    expect(reply).toContain('超出暂存上限');
    expect(reply).toContain('2 个');
    // 数路径行而不是文件名——文件名在 input 里出现两遍（[附件:x] 占位 + 路径行）
    expect(inserted[0]!.input.match(/f\d\.xlsx：/g)).toHaveLength(8);
  });

  it('迟到的文件:回复必须明确要求补发指令(不静默干等)', async () => {
    const { handler, seen } = probe();
    await handler(msg({ text: '先来的指令' }));
    const reply = await handler(msg({ attachmentOnly: true, attachments: [file('late.xlsx')] }));
    expect(seen).toHaveLength(1); // 迟到文件没有启第二个回合
    expect(seen[0]!.request).not.toContain('late.xlsx');
    expect(reply).toBe('上一条指令已经处理完了，请把指令再发一次，这些文件会一起用上');
  });

  it('会话里第一个文件不算迟到:安静（不出现补发提示）', async () => {
    const { handler } = probe();
    const reply = await handler(msg({ attachmentOnly: true, attachments: [file('a.xlsx')] }));
    expect(reply).toBe('');
  });

  it('会话隔离：A 会话暂存的附件不会进 B 会话的回合', async () => {
    const { handler, seen } = probe();
    await handler(msg({ attachmentOnly: true, attachments: [file('a.xlsx')] }, 'user_a'));
    await handler(msg({ text: '另一条会话' }, 'user_b'));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.request).not.toContain(file('a.xlsx').path);
  });
});

// ── 真并发：文字回合在飞时，迟到的文件必须最终被处理 ─────────────────────────
// 2026-10-07 实测疑点：3 个文件 + 1 条指令，第三个文件（.xls）落盘成功但**一条请求记录都
// 没有**——它的回合疑似在队列里丢了。上面的用例都 `await` 了前一个回合，那是串行，复现不了。
// 这里真正并发：文字回合用慢 runtime 占住队列，文件在其后到达，然后才放行。
describe('附件迟到 + 文字回合在飞(真并发)', () => {
  const file = (name: string): IncomingAttachment => ({ filename: name, path: `/tmp/att/${name}`, bytes: 10 });
  function msg(over: Partial<IncomingChannelMessage>, userId = USER): IncomingChannelMessage {
    return { wecomUserId: userId, conversationId: userId, messageId: `m_${Math.random().toString(36).slice(2, 8)}`, text: '', receivedAt: new Date().toISOString(), ...over };
  }

  it('文字回合进行中到达的文件,回合结束后必须被处理(不得丢)', async () => {
    const base = fakeStore();
    const inserted: Array<{ outcome: string; input: string }> = [];
    const store = {
      ...base,
      principalScopes: { ...base.principalScopes, get: async (userId: string) => ({ wecomUserId: userId, accountSetIds: ['as_001'], enabled: true }) },
      requests: {
        ...base.requests,
        insert: async (row: { outcome: string; input: string }) => { inserted.push({ outcome: row.outcome, input: row.input }); },
      },
    } as unknown as AuditStore;
    let releaseText = (): void => {};
    let entered = (): void => {};
    const enteredText = new Promise<void>((r) => { entered = r; });
    const runtime: AgentRuntime = {
      handleTurn: async (): Promise<AgentReply> => {
        entered();
        await new Promise<void>((r) => { releaseText = r; });
        return { text: 'ok' };
      },
    };
    const handler = createMessageHandler({ store, runtime });

    // 文字回合先发，但不 await —— 它占住队列。先等它真正进入 handleTurn，
    // 否则 releaseText 还是初始 no-op（测试自身的竞态，会假超时）。
    const textTurn = handler(msg({ text: '帮我做工资表' }));
    await enteredText;
    // 文件在文字回合在飞时到达
    const fileTurn = handler(msg({ attachmentOnly: true, attachments: [file('迟到的.xls')] }));
    // 放行文字回合
    releaseText();
    await Promise.all([textTurn, fileTurn]);

    // 迟到文件必须留下记录，且不能被文字回合吞掉
    const outcomes = inserted.map((r) => r.outcome);
    expect(outcomes).toContain('replied');
    expect(outcomes).toContain('attachment_received');
    const late = inserted.find((r) => r.outcome === 'attachment_received')!;
    expect(late.input).toContain('迟到的.xls');
  });
});

describe('会话队列的失败留痕', () => {
  function msg(text: string): IncomingChannelMessage {
    return { wecomUserId: USER, conversationId: USER, messageId: `m_${Math.random().toString(36).slice(2, 8)}`, text, receivedAt: new Date().toISOString() };
  }
  it('回合失败不得毒化队列,且必须留痕(不无声无息)', async () => {
    const boom = new Error('store down');
    const store = fakeStore();
    (store as unknown as { requests: { insert: () => Promise<void> } }).requests.insert = async () => { throw boom; };
    const runtime: AgentRuntime = { handleTurn: async () => ({ text: 'never' } as AgentReply) };
    // 防抖关掉：两条消息先后落进同一个窗口会让第二条白等一个窗口（本条只验失败留痕）
    const handler = createMessageHandler({ store, runtime: runtime as unknown as AgentRuntime, inboundDebounceMs: 0 });
    const logged: string[] = [];
    const orig = console.error;
    console.error = (line: unknown) => { logged.push(String(line)); };
    try {
      // 失败回合
      await expect(handler(msg('第一句'))).rejects.toThrow('store down');
      // 队列未被毒化：下一句仍能跑
      await expect(handler(msg('第二句'))).rejects.toThrow('store down');
    } finally {
      console.error = orig;
    }
    expect(logged.some((l) => l.includes('wecom_turn_failed'))).toBe(true);
    expect(logged.some((l) => l.includes('store down'))).toBe(true);
  });
});

// ── 附件关联跨重启存活（2026-10-07）──────────────────────────────────────────
// 原实现把附件关联只放进程内存：连重启三次后，用户早先上传的文件还在盘上，但 worker 拿到
// 的请求里一个路径都没有，于是它如实回"没有数据",而用户无法理解（他明明传过）。
// 修复：附件接收记录本就落库，input 里带一行机器可解析的信封；重启后从 DB 取回。

// ── 附件关联：跨重启恢复 + 会话隔离（2026-10-07）────────────────────────────
// 两个真实缺陷各有一条回归：
//  ① 附件关联原只在进程内存，服务重启即失记——用户早先上传的文件还在盘上，worker 拿到的
//     请求却零路径，于是它如实回"没有数据"。**当初缺的正是"换个 handler 实例"这条用例**：
//     所有旧用例都在同一个实例内 await，内存态一直活着，根本测不到重启。
//  ② 第一版恢复按**用户**维度查（agent_requests 没有 session 列），同一个人单聊里传的
//     文件会出现在他群聊的请求里；代账会计服务多家客户时，等于把甲客户的文件递给处理乙
//     请求的 worker。现在信封带 sessionKey，恢复时按会话过滤。
describe('附件关联：跨重启恢复与会话隔离', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'attach-restore-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const realFile = (name: string) => { const p = path.join(scratch, name); writeFileSync(p, 'x'); return { filename: name, path: p, bytes: 1 }; };
  function msg(over: Partial<IncomingChannelMessage>, conversationId = USER): IncomingChannelMessage {
    return { wecomUserId: USER, conversationId, messageId: `m_${Math.random().toString(36).slice(2, 8)}`, text: '', receivedAt: new Date().toISOString(), ...over };
  }
  /** 只落 attachment_received 行的 store；rows 由测试控制（模拟 DB 里的存量） */
  function storeWith(rows: Array<{ input: string }>): AuditStore {
    const base = fakeStore();
    return { ...base, requests: { ...base.requests, listRecentAttachments: async () => rows } } as unknown as AuditStore;
  }
  function capture(store: AuditStore) {
    const seen: Array<{ sessionId: string; request: string }> = [];
    const runtime: AgentRuntime = { handleTurn: async (ctx, request: string) => { seen.push({ sessionId: ctx.sessionId, request }); return { text: 'ok' }; } };
    return { handler: createMessageHandler({ store, runtime: runtime as unknown as AgentRuntime }), seen };
  }

  it('信封按会话隔离:sessionKey 不一致不恢复', () => {
    const a = realFile('a.xlsx');
    const text = withAttachmentPaths('', [a], `${USER}:chatA`);
    expect(parseAttachmentEnvelope(text, `${USER}:chatA`).map((f) => f.path)).toEqual([a.path]);
    expect(parseAttachmentEnvelope(text, `${USER}:chatB`)).toEqual([]);
    expect(parseAttachmentEnvelope(text)).toEqual([]); // 不给 sessionKey 一律不恢复
  });

  it('存量行没有信封(加信封之前收的) → 不恢复,也不把人话行当附件', () => {
    // 这正是 2026-10-07 生产的形状：只有 `- 名字：/path` 人话，没有信封
    const legacy = '[附件:a.xlsx]\n\n[本次消息附带的文件路径，可按路径直接使用]\n- a.xlsx：/tmp/x/a.xlsx';
    expect(parseAttachmentEnvelope(legacy, `${USER}:chatA`)).toEqual([]);
  });

  it('跨会话不串:单聊上传的文件不进群聊回合', async () => {
    const a = realFile('a.xlsx');
    const rows = [{ input: withAttachmentPaths('', [a], `${USER}:${USER}`) }]; // 单聊会话键
    const { handler, seen } = capture(storeWith(rows));
    await handler(msg({ text: '在群里问一句' }, 'group_chat_1')); // 群聊会话键不同
    expect(seen[0]!.request).not.toContain(a.path);
  });

  it('同会话恢复:DB 有记录 + 内存空 → 文字回合带上路径', async () => {
    const a = realFile('a.xlsx');
    const rows = [{ input: withAttachmentPaths('', [a], `${USER}:${USER}`) }];
    const { handler, seen } = capture(storeWith(rows));
    await handler(msg({ text: '帮我做工资表' }));
    expect(seen[0]!.request).toContain(a.path);
  });

  // ① 的回归核心：换个 handler 实例 = 服务重启后内存态全空
  it('重启后仍能恢复:新实例(内存空) + DB 有记录 → 附件不丢', async () => {
    const a = realFile('a.xlsx');
    const b = realFile('b.xls');
    const rows = [
      { input: withAttachmentPaths('', [a], `${USER}:${USER}`) },
      { input: withAttachmentPaths('', [b], `${USER}:${USER}`) },
    ];
    // 第一个实例：收附件（写 DB）
    const first = capture(storeWith(rows));
    await first.handler(msg({ attachmentOnly: true, attachments: [a, b] }));
    // 第二个实例：模拟重启，内存态全新，只能靠 DB 恢复
    const second = capture(storeWith(rows));
    await second.handler(msg({ text: '帮我做工资表' }));
    expect(second.seen[0]!.request).toContain(a.path);
    expect(second.seen[0]!.request).toContain(b.path);
  });

  it('路径已被 tmp 清理 → 安静不带上,不把死路径交给 worker', async () => {
    const rows = [{ input: withAttachmentPaths('', [{ filename: 'gone.xlsx', path: '/tmp/definitely-not-here-xyz.xlsx', bytes: 1 }], `${USER}:${USER}`) }];
    const { handler, seen } = capture(storeWith(rows));
    await handler(msg({ text: '做工资表' }));
    expect(seen[0]!.request).toBe('做工资表');
  });

  it('旧库没有 listRecentAttachments → 静默退化为只用内存', async () => {
    const a = realFile('a.xlsx');
    const seen: string[] = [];
    const runtime: AgentRuntime = { handleTurn: async (_c, request: string) => { seen.push(request); return { text: 'ok' }; } };
    const handler = createMessageHandler({ store: fakeStore(), runtime: runtime as unknown as AgentRuntime });
    await handler(msg({ attachmentOnly: true, attachments: [a] }));
    await handler(msg({ text: '做工资表' }));
    expect(seen[0]).toContain(a.path);
  });
});

// ── 附件交付边界：按「自上次委派以来新到达的」算（2026-10-09）──────────────────
//
// 事故形状（P0：安静地算出错钱）：
//   10:00  用户丢 工资.xlsx   「帮我做工资表」→ 成功，附件仍在池里
//   11:30  用户丢 进项票.xlsx 「把凭证也做了」→ 这一轮交付 {工资.xlsx, 进项票.xlsx}
// worker 看到 2 个附件，没有任何机制告诉它哪个属于本次任务：可能两个都读（浪费时间）、
// 读错那个（做错）、或者触发 needs。根因是"池子即交付集、整批交付且永不清空"——那条
// 行为曾被 `附件在会话内累积:后续每个正文回合都带上(不清空)` 一条测试锁定。
//
// 规则一：交付集 = 自「上次委派开始」以来新到达的附件；为空则沿用上次委派的交付集
//         （纠正/重试流）；两次都空则空。界取"开始"不取"完成"——委派执行期间（可能
//         10 分钟）到达的附件其实属于下一轮。
// 规则二：委派启动时把"本轮用了哪些文件"说给用户听，假设错误时几秒内可纠正，而不是
//         10 分钟后拿到一份错结果。
describe('附件交付边界：按委派算，不按会话累积', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'attach-scope-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const file = (name: string): IncomingAttachment => {
    const p = path.join(scratch, name);
    writeFileSync(p, 'x');
    return { filename: name, path: p, bytes: 1 };
  };
  function msg(over: Partial<IncomingChannelMessage>, userId = USER): IncomingChannelMessage {
    return { wecomUserId: userId, conversationId: userId, messageId: `m_${Math.random().toString(36).slice(2, 8)}`, text: '', receivedAt: new Date().toISOString(), ...over };
  }

  /** 交付集 = 请求文本里的文件名清单（排序后）。一眼看出这一轮到底带了哪些文件。 */
  const deliveredNames = (request: string): string[] =>
    request.split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).split('：')[0]!)
      .sort();

  /**
   * 最小装配：可注入 DB 存量行（模拟重启前的审计库），并捕获请求文本、通知帧与
   * "通知 vs 委派"的先后。防抖置 0——本组只验交付边界，不想把 2s 防抖算进每条用例。
   */
  function probe(dbRows: Array<{ input: string }> = []) {
    const base = fakeStore();
    const store = {
      ...base,
      principalScopes: { ...base.principalScopes, get: async (userId: string) => ({ wecomUserId: userId, accountSetIds: ['as_001'], enabled: true }) },
      requests: { ...base.requests, listRecentAttachments: async () => dbRows },
      conversationLog: { append: async () => {}, list: async () => [], search: async () => [] },
    } as unknown as AuditStore;
    const seen: string[] = [];
    const notices: string[] = [];
    const order: string[] = [];
    const runtime: AgentRuntime = {
      handleTurn: async (_ctx: TrustedContext, request: string): Promise<AgentReply> => {
        order.push('delegate');
        seen.push(request);
        return { text: 'ok' };
      },
    };
    const handler = createMessageHandler({ store, runtime: runtime as unknown as AgentRuntime, inboundDebounceMs: 0 });
    const send = (over: Partial<IncomingChannelMessage>, userId = USER): Promise<ChannelReply> =>
      handler(msg(over, userId), undefined, async (text: string) => { order.push('notice'); notices.push(text); });
    return { send, seen, notices, order };
  }

  // ── 规则一：四种场景 ────────────────────────────────────────────────────────
  it('正常流:A,B,C 先到,再发指令 → 三个都交付', async () => {
    const { send, seen } = probe();
    await send({ attachmentOnly: true, attachments: [file('a.xlsx'), file('b.xlsx'), file('c.xls')] });
    await send({ text: '帮我做工资表' });
    expect(deliveredNames(seen[0]!)).toEqual(['a.xlsx', 'b.xlsx', 'c.xls']);
  });

  // 这一条就是本次要修的事故：上一个任务的文件不得进下一个任务。
  it('同日多任务:上次委派已开始,新来的 D + 新指令 → 只交付 {D}', async () => {
    const { send, seen } = probe();
    await send({ attachmentOnly: true, attachments: [file('a.xlsx'), file('b.xlsx'), file('c.xls')] });
    await send({ text: '帮我做工资表' });
    await send({ attachmentOnly: true, attachments: [file('d.xlsx')] });
    await send({ text: '把凭证也做了' });
    expect(deliveredNames(seen[0]!)).toEqual(['a.xlsx', 'b.xlsx', 'c.xls']);
    expect(deliveredNames(seen[1]!)).toEqual(['d.xlsx']);   // A/B/C 已用过,丢弃
  });

  it('纠正/重试流:没有新附件 → 沿用上次委派的交付集', async () => {
    const { send, seen } = probe();
    await send({ attachmentOnly: true, attachments: [file('a.xlsx'), file('b.xls')] });
    await send({ text: '帮我做工资表' });
    await send({ text: '社保填错了,重做' });                 // 一个字附件都没有
    expect(deliveredNames(seen[1]!)).toEqual(['a.xlsx', 'b.xls']);
  });

  it('附件后到:指令先跑,C 才到 → C 不属于已开始的那次委派,下一条指令才带', async () => {
    const { send, seen } = probe();
    await send({ text: '帮我做工资表' });                    // 此刻池子里什么都没有
    expect(deliveredNames(seen[0]!)).toEqual([]);
    await send({ attachmentOnly: true, attachments: [file('c.xls')] });
    await send({ text: '把工资表补上' });
    expect(deliveredNames(seen[1]!)).toEqual(['c.xls']);
  });

  it('与正文同条消息到达的附件永远算本轮的', async () => {
    const { send, seen } = probe();
    await send({ attachmentOnly: true, attachments: [file('a.xlsx')] });
    await send({ text: '做工资表' });                          // 第一回合:交付 {a}
    await send({ text: '看这个', attachments: [file('d.xlsx')] });   // 第二回合
    expect(deliveredNames(seen[1]!)).toEqual(['d.xlsx']);
  });

  it('同一会话里交付集随委派前移,不累积', async () => {
    const { send, seen } = probe();
    await send({ attachmentOnly: true, attachments: [file('a.xlsx')] });
    await send({ text: '第一句' });                          // 交付 {a}
    await send({ attachmentOnly: true, attachments: [file('b.xlsx')] });
    await send({ text: '第二句' });                          // 新到达 {b} → 只交付 {b}
    await send({ text: '第三句' });                          // 无新到达 → 沿用 {b}
    expect(deliveredNames(seen[0]!)).toEqual(['a.xlsx']);
    expect(deliveredNames(seen[1]!)).toEqual(['b.xlsx']);
    expect(deliveredNames(seen[2]!)).toEqual(['b.xlsx']);
  });

  // ── 规则二：把假设说出来 ────────────────────────────────────────────────────
  it('委派启动时告知本轮用了哪些文件(在委派之前,用户几秒内就能看到)', async () => {
    const { send, seen, notices, order } = probe();
    await send({ attachmentOnly: true, attachments: [file('工资.xlsx'), file('进项票.xlsx')] });
    await send({ text: '把凭证也做了' });
    expect(seen).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('工资.xlsx');
    expect(notices[0]).toContain('进项票.xlsx');
    // 先披露再委派：等工作跑完再说就来不及纠正了
    expect(order).toEqual(['notice', 'delegate']);
  });

  it('披露只说文件名,不把整条路径刷上屏(也不出现任何平台实现细节)', async () => {
    const { send, notices } = probe();
    const target = file('工资.xlsx');
    await send({ attachmentOnly: true, attachments: [target] });
    await send({ text: '帮我做工资表' });
    expect(notices[0]).toContain('工资.xlsx');
    expect(notices[0]).not.toContain(target.path);
    expect(notices[0]).not.toContain(scratch);
    expect(notices[0]).not.toContain('handler');
    expect(notices[0]).not.toContain('sessionAttachments');
  });

  it('文件多时截断到前几个 + 总数,不刷屏', async () => {
    const { send, notices } = probe();
    const many = Array.from({ length: 5 }, (_, i) => file(`f${i}.xlsx`));   // 未超暂存上限
    await send({ attachmentOnly: true, attachments: many });
    await send({ text: '做工资表' });
    expect(notices[0]).toContain('f0.xlsx');
    expect(notices[0]).toContain('f1.xlsx');
    expect(notices[0]).toContain('5 个');                   // 总数点得出"还有"
    expect(notices[0]).not.toContain('f3.xlsx');            // 第 4 个起不逐名列
    expect(notices[0]).not.toContain('f4.xlsx');
  });

  it('本轮没有附件 → 不发披露(不制造噪音)', async () => {
    const { send, seen, notices } = probe();
    await send({ text: '在吗' });
    expect(seen).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  it('披露送达失败不影响本轮结果(披露是增强,不是门)', async () => {
    const base = fakeStore();
    const store = {
      ...base,
      principalScopes: { ...base.principalScopes, get: async (userId: string) => ({ wecomUserId: userId, accountSetIds: ['as_001'], enabled: true }) },
      requests: { ...base.requests, listRecentAttachments: async () => [] },
      conversationLog: { append: async () => {}, list: async () => [], search: async () => [] },
    } as unknown as AuditStore;
    const runtime: AgentRuntime = { handleTurn: async () => ({ text: '做完了' }) };
    const handler = createMessageHandler({ store, runtime: runtime as unknown as AgentRuntime, inboundDebounceMs: 0 });
    const reply = await handler(
      msg({ text: '帮我做工资表', attachments: [file('工资.xlsx')] }),
      undefined,
      async () => { throw new Error('WeCom notice delivery failed'); },
    );
    expect(reply).toBe('做完了');
  });

  it('describeDeliveredFiles:收据措辞(空集不发、只列文件名、多了给总数)', () => {
    const f = (filename: string) => ({ filename, path: `/tmp/x/${filename}`, bytes: 1 });
    expect(describeDeliveredFiles([])).toBe('');                       // 调用方据此不发帧
    // 2026-10-19 起这句同时是附件回合的收据（附件-only 不再各自回气泡，否则一发 N 个文件
    // 就是 N 个气泡），所以措辞与渠道的孤儿收据共用 contracts 的 formatFileReceipt
    expect(describeDeliveredFiles([f('工资.xlsx')])).toBe('已收到 1 个文件：工资.xlsx');
    expect(describeDeliveredFiles([f('a.xlsx'), f('b.xls')])).toBe('已收到 2 个文件：a.xlsx、b.xls');
    // 4 个起不逐名列，只给前 3 + 总数：帧是短消息，不是清单
    expect(describeDeliveredFiles([f('a'), f('b'), f('c'), f('d')])).toBe('已收到 4 个文件：a、b、c 等');
    // 同一文件名重复只列一次（去重按 filename，重名文件在文本里仍会出现两次）
    expect(describeDeliveredFiles([f('a.xlsx'), { ...f('a.xlsx'), path: '/tmp/y/a.xlsx' }]))
      .toBe('已收到 1 个文件：a.xlsx');
  });

  // ── 重启降级：账本失记 → 全部未消费（宁可多给,不可漏）─────────────────────
  it('重启降级:新实例没有账本 → DB 里的存量全部交付,一个不漏', async () => {
    const a = file('a.xlsx'); const b = file('b.xls'); const c = file('c.xls');
    const rows = [a, b, c].map((f) => ({ input: withAttachmentPaths('', [f], `${USER}:${USER}`) }));
    const { send, seen, notices } = probe(rows);
    await send({ text: '帮我做工资表' });
    expect(deliveredNames(seen[0]!)).toEqual(['a.xlsx', 'b.xls', 'c.xls']);
    // 降级方向是"多给",所以规则二的披露必须还在——用户看得见本轮到底用了哪些文件
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('a.xlsx');
  });

  it('重启降级只一次性:重启后第一次委派重新立账,此后的新任务只拿新文件', async () => {
    const a = file('a.xlsx'); const b = file('b.xls');
    const rows = [a, b].map((f) => ({ input: withAttachmentPaths('', [f], `${USER}:${USER}`) }));
    const { send, seen } = probe(rows);
    await send({ text: '帮我做工资表' });                    // 重启后第一轮:全部未消费
    await send({ attachmentOnly: true, attachments: [file('d.xlsx')] });
    await send({ text: '把凭证也做了' });                    // 账本已立:只交付新到的
    expect(deliveredNames(seen[0]!)).toEqual(['a.xlsx', 'b.xls']);
    expect(deliveredNames(seen[1]!)).toEqual(['d.xlsx']);
  });

  it('重启降级不会把 DB 存量永久当成新到达(否则规则一被绕过)', async () => {
    const a = file('a.xlsx');
    const rows = [{ input: withAttachmentPaths('', [a], `${USER}:${USER}`) }];
    const { send, seen } = probe(rows);
    await send({ text: '第一句' });                          // 交付 {a},并立账
    await send({ text: '第二句' });                          // 无新到达 → 沿用 {a},不是"又新到达一次"
    expect(deliveredNames(seen[0]!)).toEqual(['a.xlsx']);
    expect(deliveredNames(seen[1]!)).toEqual(['a.xlsx']);
    await send({ text: '第三句' });
    expect(deliveredNames(seen[2]!)).toEqual(['a.xlsx']);
  });
});

// ── 入站防抖（2026-10-08）────────────────────────────────────────────────────
// 企微模型里"3 个文件 + 1 条指令"是 4 条独立消息（MixedMsgItem 只支持 text/image，文件
// 无法与文字同条），而会话队列串行——指令那条一启动，晚到的文件只能排到它后面。
// 2026-10-08 实测：4 条消息同一秒内到达，顺序 文件→指令→文件，指令那轮只带了 2 个，
// 产出 3 人的不完整工资表（全量是 12 人）。
// 修法参照 OpenClaw messages.inbound.debounceMs：文本参与防抖，附件立即 flush。
describe('入站防抖', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'debounce-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const realFile = (name: string) => { const p = path.join(scratch, name); writeFileSync(p, 'x'); return { filename: name, path: p, bytes: 1 }; };
  function msg(over: Partial<IncomingChannelMessage>): IncomingChannelMessage {
    return { wecomUserId: USER, conversationId: USER, messageId: `m_${Math.random().toString(36).slice(2, 8)}`, text: '', receivedAt: new Date().toISOString(), ...over };
  }
  function harness(debounceMs: number) {
    const seen: Array<{ at: number; request: string }> = [];
    const runtime: AgentRuntime = { handleTurn: async (_c, request: string) => { seen.push({ at: Date.now(), request }); return { text: 'ok' }; } };
    return { handler: createMessageHandler({ store: fakeStore(), runtime: runtime as unknown as AgentRuntime, inboundDebounceMs: debounceMs }), seen };
  }

  it('同一burst内晚到的附件,指令回合也能带上', async () => {
    const a = realFile('a.xlsx'); const b = realFile('b.xlsx');
    const { handler, seen } = harness(120);
    // 不等第一条：附件先到并落定
    const f1 = handler(msg({ attachmentOnly: true, attachments: [a] }));
    await f1;
    // 指令到达（会等 120ms），期间第二个文件到达
    const t = handler(msg({ text: '做工资表' }));
    await new Promise((r) => setTimeout(r, 20));
    const f2 = handler(msg({ attachmentOnly: true, attachments: [b] }));
    await Promise.all([t, f2]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.request).toContain(a.path);
    expect(seen[0]!.request).toContain(b.path);
  });

  it('防抖窗口为 0 时不等待(行为退化为立即处理)', async () => {
    const a = realFile('a.xlsx');
    const { handler, seen } = harness(0);
    const t0 = Date.now();
    await handler(msg({ text: '做工资表' }));
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(seen).toHaveLength(1);
  });

  it('附件-only 消息不参与防抖:立刻返回（但正常路径无话可说）', async () => {
    const a = realFile('a.xlsx');
    const { handler } = harness(2000);
    const t0 = Date.now();
    const reply = await handler(msg({ attachmentOnly: true, attachments: [a] }));
    expect(Date.now() - t0).toBeLessThan(1500); // 没有等满 2 秒
    // 2026-10-19：不等待遇不变，但不再回一条气泡（收据由指令回合或渠道并窗承担）
    expect(reply).toBe('');
  });

  // 2026-10-16 首帧提速改写：防抖的新语义是"窗口内首条立即、后续到达才合并"（参照
  // OpenClaw）。默认窗口的钉子因此改为两段——冷启动首条 <1s（这就是用户感知的等待），
  // burst 内第二条等满窗口（附件合并的收益保留）。
  it('默认窗口 2000ms(未显式配置时)：首条立即，burst 内第二条等满窗口', async () => {
    const seen: string[] = [];
    const runtime: AgentRuntime = { handleTurn: async (_c, request: string) => { seen.push(request); return { text: 'ok' }; } };
    const handler = createMessageHandler({ store: fakeStore(), runtime: runtime as unknown as AgentRuntime });
    const t0 = Date.now();
    await handler(msg({ text: '在吗' }));
    expect(Date.now() - t0).toBeLessThan(1500);
    const t1 = Date.now();
    await handler(msg({ text: '第二条' }));
    const elapsed = Date.now() - t1;
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(3500);
  });
});

describe('入站防抖的配置来源', () => {
  const seen: string[] = [];
  function build(env?: Record<string, string | undefined>) {
    seen.length = 0;
    const runtime: AgentRuntime = { handleTurn: async (_c, request: string) => { seen.push(request); return { text: 'ok' }; } };
    return createMessageHandler({ store: fakeStore(), runtime: runtime as unknown as AgentRuntime, ...(env ? { env } : {}) });
  }
  const msg = (text: string): IncomingChannelMessage => ({ wecomUserId: USER, conversationId: USER, messageId: `m_${Math.random().toString(36).slice(2, 8)}`, text, receivedAt: new Date().toISOString() });
  // 2026-10-16 首帧提速改写：时序口径从"单条等满窗口"变成"首条立即 + burst 第二条等窗口"。
  // 配置的观察点因此移到 burst 第二条上（首条在任何配置下都立即）。
  const timed = async (handler: ReturnType<typeof build>) => {
    const t0 = Date.now();
    await handler(msg('首条'));
    const first = Date.now() - t0;
    const t1 = Date.now();
    await handler(msg('第二条'));
    return { first, burst: Date.now() - t1 };
  };

  it('env 未设该键 → 用默认 2000：首条立即、burst 第二条等窗口', async () => {
    const { first, burst } = await timed(build({}));
    expect(first).toBeLessThan(1500);
    expect(burst).toBeGreaterThanOrEqual(1900);
  });

  it('env 设为 0 → 关闭防抖：burst 第二条也不等', async () => {
    const { first, burst } = await timed(build({ FSHINE_INBOUND_DEBOUNCE_MS: '0' }));
    expect(first).toBeLessThan(1500);
    expect(burst).toBeLessThan(1500);
  });

  it('env 设为 300 → 按配置等（只作用在 burst 第二条上）', async () => {
    const { first, burst } = await timed(build({ FSHINE_INBOUND_DEBOUNCE_MS: '300' }));
    expect(first).toBeLessThan(1500);
    expect(burst).toBeGreaterThanOrEqual(250);
    expect(burst).toBeLessThan(1500);
  });

  it('env 是空串 → 仍用默认(不是 0)', async () => {
    const { first, burst } = await timed(build({ FSHINE_INBOUND_DEBOUNCE_MS: '' }));
    expect(first).toBeLessThan(1500);
    expect(burst).toBeGreaterThanOrEqual(1900);
  });

  it('env 是垃圾值 → 回退默认,不崩', async () => {
    const { first, burst } = await timed(build({ FSHINE_INBOUND_DEBOUNCE_MS: 'abc' }));
    expect(first).toBeLessThan(1500);
    expect(burst).toBeGreaterThanOrEqual(1900);
  });
});

describe('入站防抖的配置来源', () => {
  function build(env?: Record<string, string | undefined>) {
    const runtime: AgentRuntime = { handleTurn: async () => ({ text: 'ok' }) };
    return createMessageHandler({ store: fakeStore(), runtime: runtime as unknown as AgentRuntime, ...(env ? { env } : {}) });
  }
  const msg = (text: string): IncomingChannelMessage => ({ wecomUserId: USER, conversationId: USER, messageId: `m_${Math.random().toString(36).slice(2, 8)}`, text, receivedAt: new Date().toISOString() });
  const timed = async (handler: ReturnType<typeof build>) => {
    const t0 = Date.now();
    await handler(msg('首条'));
    const first = Date.now() - t0;
    const t1 = Date.now();
    await handler(msg('第二条'));
    return { first, burst: Date.now() - t1 };
  };

  it('env 未设该键 → 用默认 2000：首条立即、burst 第二条等窗口', async () => {
    const { first, burst } = await timed(build({}));
    expect(first).toBeLessThan(1500);
    expect(burst).toBeGreaterThanOrEqual(1900);
  });
  it('env 设为 0 → 关闭防抖', async () => {
    const { first, burst } = await timed(build({ FSHINE_INBOUND_DEBOUNCE_MS: '0' }));
    expect(first).toBeLessThan(1500);
    expect(burst).toBeLessThan(1500);
  });
  it('env 设为 300 → 按配置等', async () => {
    const { first, burst } = await timed(build({ FSHINE_INBOUND_DEBOUNCE_MS: '300' }));
    expect(first).toBeLessThan(1500);
    expect(burst).toBeGreaterThanOrEqual(250);
    expect(burst).toBeLessThan(1500);
  });
  it('env 空串 → 仍用默认(不是 0)', async () => {
    const { first, burst } = await timed(build({ FSHINE_INBOUND_DEBOUNCE_MS: '' }));
    expect(first).toBeLessThan(1500);
    expect(burst).toBeGreaterThanOrEqual(1900);
  });
  it('env 垃圾值 → 回退默认,不崩', async () => {
    const { first, burst } = await timed(build({ FSHINE_INBOUND_DEBOUNCE_MS: 'abc' }));
    expect(first).toBeLessThan(1500);
    expect(burst).toBeGreaterThanOrEqual(1900);
  });
});

// ── 首帧提速：受理即帧 + 首条零防抖（2026-10-16）─────────────────────────────
// 背景：渠道 ack 秒回"收达"（channel-wecom adapter 的 ACK_TEXT 对所有消息无条件发），
// 但到"回合真正开跑"的第一个反馈之间仍有一段空窗——Main Agent 第一轮 LLM（10–20s）之后
// delegate 轮才产生第一帧「正在…」，conversation 轮直到终稿零帧。修两刀：
//   ① 受理即帧：回合真正开跑时（防抖后、出队列、进 runtime 之前）由宿主经 progress
//      通道发一帧确定性文案——两帧语义递进（ack=已收达、受理帧=已开跑）。它是宿主文案
//      不是模型文本，不经过出口校验；附件-only 不启回合所以不发帧；未授权拒绝很快也不发帧。
//   ② 首条零防抖：防抖窗口内首条消息立即处理、后续到达才合并——冷启动的对话不再白等 2s。
// 时钟断言口径（2026-10-16 评审放宽）："立即"类上界统一 <1500——仍远小于 2000 默认防抖
// 窗，"没等防抖窗"的命题不变，给慢 CI 留抖动余量。
describe('首帧提速：受理即帧与首条零防抖', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'first-frame-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const realFile = (name: string) => { const p = path.join(scratch, name); writeFileSync(p, 'x'); return { filename: name, path: p, bytes: 1 }; };
  function msg(over: Partial<IncomingChannelMessage>, userId = USER): IncomingChannelMessage {
    return { wecomUserId: userId, conversationId: userId, messageId: `m_${Math.random().toString(36).slice(2, 8)}`, text: '', receivedAt: new Date().toISOString(), ...over };
  }

  interface Frame { text: string; at: number }
  /** runtime 替身：进入时记事、可发进度帧、可拖延——受理帧的"先于 runtime"与时序都靠它观察。 */
  function harness(opts: {
    debounceMs: number;
    runtimeDelayMs?: number;
    runtimeSteps?: string[];
    /** runtime 里走 notice 通道发的帧（进度帧走 onStep）。 */
    runtimeNotices?: string[];
    heartbeatMs?: number;
    /** 给 send 也挂上 notice 通道（进度帧走 progress，notice 帧单独记账）。 */
    notice?: boolean;
  }) {
    const frames: Frame[] = [];
    const noticeTexts: string[] = [];
    let framesAtRuntimeStart = -1;
    const runtime: AgentRuntime = {
      handleTurn: async (ctx) => {
        framesAtRuntimeStart = frames.length;
        for (const step of opts.runtimeSteps ?? []) ctx.onStep?.(step);
        for (const text of opts.runtimeNotices ?? []) await ctx.onNotice?.(text);
        await new Promise((r) => setTimeout(r, opts.runtimeDelayMs ?? 0));
        return { text: 'ok' };
      },
    };
    const handler = createMessageHandler({
      store: fakeStore(),
      runtime: runtime as unknown as AgentRuntime,
      inboundDebounceMs: opts.debounceMs,
      ...(opts.heartbeatMs !== undefined ? { turnHeartbeatMs: opts.heartbeatMs } : {}),
    });
    const send = (over: Partial<IncomingChannelMessage>, userId = USER): Promise<{ reply: ChannelReply; elapsed: number }> => {
      const t0 = Date.now();
      // notice 帧与进度帧进同一个序列：帧预算不按通道分别算（一个气泡就是一屏）
      const notice = opts.notice
        ? async (text: string) => { frames.push({ text, at: Date.now() }); noticeTexts.push(text); }
        : undefined;
      return handler(msg(over, userId), (text: string) => { frames.push({ text, at: Date.now() }); }, notice)
        .then((reply) => ({ reply, elapsed: Date.now() - t0 }));
    };
    return { handler, frames, noticeTexts, send, framesAtRuntimeStart: () => framesAtRuntimeStart };
  }

  it('受理即帧：<1.5s 发出宿主受理帧，且先于 runtime（不经过出口校验）', async () => {
    const h = harness({ debounceMs: 2000, runtimeDelayMs: 20 });
    const { elapsed } = await h.send({ text: '在吗' });
    expect(h.frames.map((f) => f.text)[0]).toBe(TURN_ACCEPTED_TEXT);
    // <1.5s：防抖（2s 窗）不许算进首帧延迟；老行为是先等满 2s 防抖且零帧
    expect(elapsed).toBeLessThan(1500);
    // 受理帧在进入 runtime 之前发出：runtime 开跑时它已在帧序列里
    expect(h.framesAtRuntimeStart()).toBeGreaterThanOrEqual(1);
  });

  it('首条零防抖：窗口内第一条带正文消息立即处理', async () => {
    const h = harness({ debounceMs: 2000 });
    const { elapsed } = await h.send({ text: '第一条' });
    expect(elapsed).toBeLessThan(1500);
  });

  it('后续到达才合并：先行消息打开窗口，burst 里的指令回合仍等满窗口（晚到附件能赶上）', async () => {
    const b = realFile('b.xlsx');
    const h = harness({ debounceMs: 200 });
    await h.send({ text: '开场白' });                       // 冷启动：立即（新语义）
    const burst = h.send({ text: '做工资表' });              // 窗口内第二条：等窗口
    await new Promise((r) => setTimeout(r, 20));
    const fileTurn = h.send({ attachmentOnly: true, attachments: [b] }); // 附件立即落定
    const results = await Promise.all([burst, fileTurn]);
    expect(results[0]!.elapsed).toBeGreaterThanOrEqual(150); // 等了防抖窗口
    expect(results[1]!.elapsed).toBeLessThan(150);           // 附件不参与防抖
  });

  it('窗口过期回归零防抖：距上一次到达超过窗口的消息不再等', async () => {
    const h = harness({ debounceMs: 150 });
    await h.send({ text: '第一条' });
    await new Promise((r) => setTimeout(r, 400));            // 窗口（150ms）早已过去
    const { elapsed } = await h.send({ text: '第二条' });
    expect(elapsed).toBeLessThan(1500);
  });

  it('附件-only 不启回合：零帧、零回复（气泡由指令回合或渠道并窗承担）', async () => {
    const a = realFile('a.xlsx');
    const h = harness({ debounceMs: 2000 });
    const { reply } = await h.send({ attachmentOnly: true, attachments: [a] });
    expect(h.frames).toEqual([]);
    expect(reply).toBe('');
  });

  it('未授权拒绝很快：不发受理帧', async () => {
    const h = harness({ debounceMs: 0 });
    const { reply } = await h.send({ text: '在吗' }, 'stranger');
    expect(h.frames).toEqual([]);
    expect(reply).toContain('未开通查询权限');
  });

  it('心跳帧：受理帧之后整整一个周期无任何帧时，补一帧「仍在处理中」', async () => {
    const h = harness({ debounceMs: 0, runtimeDelayMs: 120, heartbeatMs: 40 });
    await h.send({ text: '在吗' });
    // 会话轮零 runtime 帧：受理帧（t≈0）之后的 40ms 盲段由心跳补上，只补一帧
    expect(h.frames.map((f) => f.text)).toEqual([TURN_ACCEPTED_TEXT, TURN_STILL_WORKING_TEXT]);
  });

  it('心跳帧不添噪：真实帧已在流动（或已有披露）时保持静默、不挤占帧预算', async () => {
    const h = harness({ debounceMs: 0, runtimeDelayMs: 120, runtimeSteps: ['正在读取余额…'], heartbeatMs: 40 });
    await h.send({ text: '查余额' });
    // runtime 第一帧在受理帧之后立刻发出：用户不再盲等，心跳不再补帧
    expect(h.frames.map((f) => f.text)).toEqual([TURN_ACCEPTED_TEXT, '正在读取余额…']);
  });

  // ── 2026-10-19 附件回合：收据并到回合气泡上，受理帧让位 ──────────────────
  //
  // 背景：3 个文件 + 1 条指令，用户看到 4 条气泡（3 个"已收到 X" + 1 串回合帧），而且
  // 文件回执和回合帧在会话里互相穿插。根因是企微流式回复按入站消息的 req_id 走，一条
  // 用户消息就是一个气泡——附件-only 各回一句必然是 N 个气泡。所以：附件-only 不再回
  // 气泡，收据改挂到指令回合的首帧（就是披露帧，见 announceDeliveredFiles）。
  it('附件回合首帧就是收据：披露帧顶掉受理帧（不两句近义挨着冒）', async () => {
    const a = realFile('a.xlsx');
    const h = harness({ debounceMs: 0, runtimeDelayMs: 60 });
    await h.send({ attachmentOnly: true, attachments: [a] });   // 只发文件：零帧（气泡省下来了）
    expect(h.frames).toEqual([]);
    await h.send({ text: '做工资表' });                         // 指令回合：收据由它带
    expect(h.frames.map((f) => f.text)).toEqual(['已收到 1 个文件：a.xlsx']);
    // 受理帧被跳过：用户刚看完"已收到哪些文件"，紧跟一句"已受理"只是抖动
    expect(h.frames.some((f) => f.text === TURN_ACCEPTED_TEXT)).toBe(false);
  });

  it('附件回合心跳不丢：披露帧之后又是整周期无帧，仍补一帧（盲段没被"跳过受理帧"吃掉）', async () => {
    const a = realFile('a.xlsx');
    const h = harness({ debounceMs: 0, runtimeDelayMs: 120, heartbeatMs: 40 });
    await h.send({ attachmentOnly: true, attachments: [a] });
    await h.send({ text: '做工资表' });
    // 心跳锚在"受理点"而不是"受理帧"：附件回合没有受理帧，锚点仍落在披露帧之后
    expect(h.frames.map((f) => f.text)).toEqual(['已收到 1 个文件：a.xlsx', TURN_STILL_WORKING_TEXT]);
  });

  it('附件回合心跳不添噪：披露帧之后真实帧开始流动就静默', async () => {
    const a = realFile('a.xlsx');
    const h = harness({ debounceMs: 0, runtimeDelayMs: 120, runtimeSteps: ['正在读取余额…'], heartbeatMs: 40 });
    await h.send({ attachmentOnly: true, attachments: [a] });
    await h.send({ text: '查余额' });
    expect(h.frames.map((f) => f.text)).toEqual(['已收到 1 个文件：a.xlsx', '正在读取余额…']);
  });

  it('披露走 notice 通道：算一帧流量（通道归属也要钉住）', async () => {
    const a = realFile('a.xlsx');
    const h = harness({ debounceMs: 0, runtimeDelayMs: 60, notice: true });
    await h.send({ attachmentOnly: true, attachments: [a] });
    await h.send({ text: '做工资表' });
    // 通道归属：有 notice 时披露走 notice（被 await、不被渠道节流、与计划通知同一审计轨迹），
    // 不是 progress。两条路都改计数，但走哪条决定了它会不会被帧节流挤掉。
    expect(h.noticeTexts).toEqual(['已收到 1 个文件：a.xlsx']);
    expect(h.frames.map((f) => f.text)).toEqual(['已收到 1 个文件：a.xlsx']);
  });

  it('notice 帧也算帧流量：受理帧之后来了计划通知，心跳不再补', async () => {
    const h = harness({ debounceMs: 0, runtimeDelayMs: 120, runtimeNotices: ['计划已确认，开始执行'], heartbeatMs: 40, notice: true });
    await h.send({ text: '做工资表' });
    // notice 上屏 = 用户不再盲等。若只数 progress 帧，这一帧会被漏计，8 秒后心跳再补一句
    // 近义文案——帧预算只有 4，浪费在重复上。
    expect(h.frames.map((f) => f.text)).toEqual([TURN_ACCEPTED_TEXT, '计划已确认，开始执行']);
  });
});

// ── 文件回传（2026-10-08 重构：宿主扫 tmp/，不靠 worker 声明路径）──────────────────
//
// 此前渠道只会把 worker 产出的 xlsx 说成一段 markdown：12 人的工资表塞进 20KB 文本
// 上限被截断，用户既拿不到文件也看不完（实测形态）。现在回复可带 file，经 SDK 临时
// 素材上传回传。
//
// 但"取哪个文件"一度做成了"解析 worker 回复里的 `[发送文件] <路径>` 标记"——那个约定
// 必然失败：产物落在哪不由 worker 决定（平台执行器在目标被 Excel 占用时会自动 fallback
// 到 tmp/ 下另一个名字，见 src/payroll/MECHANISMS.md），它忘了写、写错路径、或压根
// 不知道路径，用户就什么都收不到。现在改成宿主自己扫 tmp/：worker 只说"做完了"，
// 文件由代码按判据收。下面每条用例钉一条判据。
describe('文件回传:宿主扫 tmp/ 收集本轮产物', () => {
  const roots: string[] = [];
  /** 每个用例一个假平台根——目录扫描是有状态的操作，共用一个根会互相污染。 */
  const freshRoot = (): string => {
    const root = mkdtempSync(path.join(tmpdir(), 'produced-'));
    roots.push(root);
    mkdirSync(path.join(root, 'tmp'), { recursive: true });
    return root;
  };
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

  // 任务工作区名与宿主 taskId 同形（task_<uuid>，⑨）；目录名必须是这个形态才会被
  // isScratchDirName 认出来（与生产同一条判据，不另造一个假名字）。
  const TASK_DIR = `task_${randomUUID()}`;
  const OTHER_TASK_DIR = `task_${randomUUID()}`;

  /** 在假平台根的 tmp/ 下写一个文件（rel 可带子路径）；返回绝对路径。 */
  const put = (root: string, rel: string, content: string | Buffer = 'x'): string => {
    const p = path.join(root, 'tmp', rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
    return p;
  };

  /**
   * 本轮委派开始时刻。故意取"1 秒前"而不是"此刻"：inode 的 mtime 由内核粗粒度时钟打点，
   * 实测比 `Date.now()` 落后 1ms 量级（300 次采样最大 1.14ms）——贴着写文件会让"刚产出
   * 的文件"偶发被判成旧的。生产上委派到产物之间隔着整个 LLM 往返（数百毫秒起），不存在
   * 这个量级；测试里显式留出余量，免得把时钟抖动测成功能缺陷。
   */
  const sinceTurnStart = (): string => new Date(Date.now() - 1000).toISOString();

  it('本轮委派开始后落盘的产物被收', () => {
    const root = freshRoot();
    put(root, '工资表.xlsx', 'DATA');
    const files = collectProducedFiles(root, sinceTurnStart());
    expect(files.map((f) => f.filename)).toEqual(['工资表.xlsx']);
    expect(files[0]!.data.toString()).toBe('DATA');
  });

  it('since 之前就存在的老文件不收(那不是本轮产物)', () => {
    const root = freshRoot();
    const stale = put(root, '上一轮落下的产物.xlsx');
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(stale, longAgo, longAgo);                          // 把 mtime 推到一小时前
    expect(collectProducedFiles(root, new Date().toISOString())).toEqual([]);
  });

  it('tmp/attachments/ 里的不收(那是本轮输入,不是产物)', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    put(root, 'attachments/用户上传的原料.xlsx');
    expect(collectProducedFiles(root, since)).toEqual([]);
  });

  it('未登记的任务工作区 tmp/task_<taskId>/ 不收(别的会话/未在册:防把 A 的文件发给 B)', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    put(root, `${OTHER_TASK_DIR}/别人的中间产物.xlsx`);
    put(root, `${TASK_DIR}/没登记就不算本轮产物.xlsx`);
    // 白名单只列了 OTHER_TASK_DIR：它的文件收，未在册的 TASK_DIR 不收
    const files = collectProducedFiles(root, since, [`tmp/${OTHER_TASK_DIR}`]);
    expect(files.map((f) => f.filename)).toEqual(['别人的中间产物.xlsx']);
    // 一个都不列（旧替身/缺 platformTasks 的退化形态）= 只扫 tmp/ 顶层，两个都不收
    expect(collectProducedFiles(root, since)).toEqual([]);
  });

  it('本会话任务工作区里的本轮产物被收(worker 唯一可写位置,2026-10-19 事故形状)', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    put(root, `${TASK_DIR}/整理好的2026年08月工资表.xlsx`, 'XLSX');
    put(root, `${TASK_DIR}/幻骥达2026年08月个税申报.xlsx`, 'TAX');
    const expected = ['幻骥达2026年08月个税申报.xlsx', '整理好的2026年08月工资表.xlsx'];
    const files = collectProducedFiles(root, since, [`tmp/${TASK_DIR}`]);
    expect(files.map((f) => f.filename).sort()).toEqual(expected.sort());
  });

  it('工作区里 since 之前的老文件不收(续跑共享工作区,旧产物不是本轮交付)', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    const stale = put(root, `${TASK_DIR}/上个月落下的工资表.xlsx`);
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(stale, longAgo, longAgo);
    put(root, `${TASK_DIR}/本轮的新表.xlsx`);
    const files = collectProducedFiles(root, since, [`tmp/${TASK_DIR}`]);
    expect(files.map((f) => f.filename)).toEqual(['本轮的新表.xlsx']);
  });

  it('工作区里非办公扩展名不收(契约/脚本是中间产物,不是交付物)', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    put(root, `${TASK_DIR}/final_contract.json`);
    put(root, `${TASK_DIR}/build_contract.py`);
    expect(collectProducedFiles(root, since, [`tmp/${TASK_DIR}`])).toEqual([]);
  });

  it('工作区白名单形态外的入参被忽略(非 tmp/task_<uuid> 一律不当收集范围)', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    put(root, `${TASK_DIR}/工资表.xlsx`);
    put(root, 'attachments/用户上传的原料.xlsx');                       // 输入区:永不是产物
    // 'tmp'（缺一段）、穿越形态、 attachments 都不是合法工作区名 → 白名单为空 → 只扫顶层
    expect(collectProducedFiles(root, since, ['tmp', `tmp/${TASK_DIR}/../${TASK_DIR}x`, 'tmp/attachments'])).toEqual([]);
  });

  it('非办公扩展名不收(.py 是中间产物,不是交付物)', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    put(root, 'transform.py', 'print(1)');
    expect(collectProducedFiles(root, since)).toEqual([]);
  });

  it('超过 20MB 不收', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    const big = put(root, '超大.xlsx', Buffer.alloc(20 * 1024 * 1024 + 1, 1));
    expect(statSync(big).size).toBeGreaterThan(20 * 1024 * 1024);
    expect(collectProducedFiles(root, since)).toEqual([]);
  });

  it('最多 3 个', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    for (let i = 0; i < 6; i++) put(root, `f${i}.xlsx`);
    expect(collectProducedFiles(root, since)).toHaveLength(3);
  });

  it('同一文件不重复收取(按解析后的真实路径去重)', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    const real = put(root, '工资表.xlsx', 'DATA');
    const link = path.join(root, 'tmp', `链接名-${TASK_DIR}.xlsx`);
    symlinkSync(real, link);                                      // 同一个文件,两个名字
    const files = collectProducedFiles(root, since);
    expect(files).toHaveLength(1);
    expect(files[0]!.data.toString()).toBe('DATA');
  });

  it('指向 tmp/ 之外的符号链接不外发(解引用后仍须在受信边界内)', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    const outside = path.join(root, 'secret.docx');
    writeFileSync(outside, 'SECRET');
    symlinkSync(outside, path.join(root, 'tmp', '外泄.xlsx'));
    expect(collectProducedFiles(root, since)).toEqual([]);
  });

  // ── 端到端：工作区产物随最终回复一起回传（2026-10-19 幻骥达事故形状）───────────
  // 事故：worker 把两个 xlsx 写进 tmp/task_d42fffce-…/，宿主按"工作区不是交付通道"
  // 整轮只回文字，用户在企微里什么都拿不到。下面两条钉修好后与退化后的两种形态。
  describe('端到端:本会话任务工作区的产物随回复回传', () => {
    const e2eRoots: string[] = [];
    afterAll(() => { for (const root of e2eRoots) rmSync(root, { recursive: true, force: true }); });
    const freshE2eRoot = (): string => {
      const root = mkdtempSync(path.join(tmpdir(), 'produced-e2e-'));
      e2eRoots.push(root);
      mkdirSync(path.join(root, 'tmp'), { recursive: true });
      return root;
    };

    /** 本会话在册的平台任务替身（taskId 即工作区名）。 */
    const storeWithTasks = (taskIds: string[]): AuditStore => ({
      ...fakeStore(),
      platformTasks: {
        get: async () => null,
        upsert: async () => {},
        listBySession: async () => taskIds.map((taskId) => ({
          taskId,
          parentSessionId: `wecom:${USER}:${USER}`,
          principalId: `wecom:${USER}`,
          workerMessages: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
      },
    }) as unknown as AuditStore;

    const textTurn = (): IncomingChannelMessage => ({
      wecomUserId: USER,
      conversationId: USER,
      messageId: `m_${randomUUID()}`,
      text: '帮我做幻骥达的工资表',
      receivedAt: new Date().toISOString(),
    });

    it('platformTasks 在册:工作区里的交付物挂到回复上回传', async () => {
      const root = freshE2eRoot();
      const taskDir = `task_${randomUUID()}`;
      const deliverable = path.join(root, 'tmp', taskDir, '整理好的2026年08月工资表.xlsx');
      mkdirSync(path.dirname(deliverable), { recursive: true });
      // 交付物在回合执行期间落盘（生产形态：worker 跑域执行器产出），mtime 才会晚于
      // 本轮委派开始时刻——提前写好会被 since 界判成"上一轮的旧产物"而不收。
      // utimesSync 显式把 mtime 拨到"此刻"：内核粗粒度时钟打点可能比 Date.now() 落后
      // 1ms 量级（见 sinceTurnStart 的注释），贴着 delegatedAt 写会让产物偶发被判旧。
      const handler = createMessageHandler({
        store: storeWithTasks([taskDir]),
        runtime: {
          handleTurn: async (): Promise<AgentReply> => {
            writeFileSync(deliverable, 'XLSX');
            utimesSync(deliverable, new Date(), new Date());
            return { text: '做完了' };
          },
        } as unknown as AgentRuntime,
        platformRoot: root,
        inboundDebounceMs: 0,
      });
      const reply = await handler(textTurn());
      expect(typeof reply).not.toBe('string');
      if (typeof reply === 'string') return;
      expect(reply.text).toBe('做完了');
      expect(reply.file?.filename).toBe('整理好的2026年08月工资表.xlsx');
      expect(reply.file?.data.toString()).toBe('XLSX');
    });

    it('platformTasks 缺库(旧替身):退化为只回文字,不因收集失败炸掉回合', async () => {
      const root = freshE2eRoot();
      const taskDir = `task_${randomUUID()}`;
      const p = path.join(root, 'tmp', taskDir, '整理好的2026年08月工资表.xlsx');
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, 'XLSX');
      const handler = createMessageHandler({
        store: fakeStore(),
        runtime: { handleTurn: async (): Promise<AgentReply> => ({ text: '做完了' }) } as unknown as AgentRuntime,
        platformRoot: root,
        inboundDebounceMs: 0,
      });
      const reply = await handler(textTurn());
      expect(reply).toBe('做完了');
    });

    it('在册的是别的会话的工作区:本会话工作区里的文件不外发', async () => {
      const root = freshE2eRoot();
      const taskDir = `task_${randomUUID()}`;
      const otherTaskDir = `task_${randomUUID()}`;
      const mine = path.join(root, 'tmp', taskDir, '我的工资表.xlsx');
      mkdirSync(path.dirname(mine), { recursive: true });
      writeFileSync(mine, 'MINE');
      const handler = createMessageHandler({
        // 在册的只有别人的工作区；我的不在册 → 不收
        store: storeWithTasks([otherTaskDir]),
        runtime: { handleTurn: async (): Promise<AgentReply> => ({ text: '做完了' }) } as unknown as AgentRuntime,
        platformRoot: root,
        inboundDebounceMs: 0,
      });
      const reply = await handler(textTurn());
      expect(reply).toBe('做完了');
    });
  });
});
