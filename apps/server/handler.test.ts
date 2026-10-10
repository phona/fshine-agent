import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { validatePlanEntities } from '@fshine/agent';
import type { AgentReply, AgentRuntime, AuditStore, IncomingAttachment, IncomingChannelMessage, TrustedContext } from '@fshine/contracts';
import {
  collectProducedFiles,
  createMessageHandler,
  parseAttachmentEnvelope,
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

  it('附件-only：不调 Agent，落审计为 attachment_received，回复要能收尾流', async () => {
    const { handler, inserted, seen } = probe();
    const reply = await handler(msg({ attachmentOnly: true, attachments: [file('a.xlsx')] }));
    expect(seen).toHaveLength(0);
    expect(reply).toBe('已收到 a.xlsx');
    // 必须非空：适配器只在 rich.text 非空时才发 finish=true，空回复会让客户端 spinner 永转
    expect(reply).not.toBe('');
    // 文案纪律：不出现"请告诉我需要做什么"这类噪音（一发 N 个文件就刷 N 遍）
    expect(reply).not.toContain('请告诉我');
    expect(inserted.map((r) => r.outcome)).toEqual(['attachment_received']);
    expect(inserted[0]!.input).toContain(file('a.xlsx').path);
  });

  it('暂存的附件在带正文的回合被交付，并消费掉', async () => {
    const { handler, seen } = probe();
    await handler(msg({ attachmentOnly: true, attachments: [file('a.xlsx'), file('b.xls')] }));
    await handler(msg({ text: '帮我做工资表' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.request).toContain('帮我做工资表');
    expect(seen[0]!.request).toContain(file('a.xlsx').path);
    expect(seen[0]!.request).toContain(file('b.xls').path);
  });

  // 2026-10-07 翻案：曾有"取走即清空"的实现，于是用户重复指令时附件集已空，机器人回
  // "没收到数据"而用户完全无法理解——用户心智是"我在这个对话里上传过文件"。
  it('附件在会话内累积:后续每个正文回合都带上(不清空)', async () => {
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
    expect(reply).toContain('late.xlsx');
    expect(reply).toContain('指令再发一次'); // 可行动,不是干等
  });

  it('会话里第一个文件不算迟到:不出现补发提示', async () => {
    const { handler } = probe();
    const reply = await handler(msg({ attachmentOnly: true, attachments: [file('a.xlsx')] }));
    expect(reply).toBe('已收到 a.xlsx');
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
    const handler = createMessageHandler({ store, runtime: runtime as unknown as AgentRuntime });
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
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(seen).toHaveLength(1);
  });

  it('附件-only 消息不参与防抖:立刻返回确认', async () => {
    const a = realFile('a.xlsx');
    const { handler } = harness(2000);
    const t0 = Date.now();
    const reply = await handler(msg({ attachmentOnly: true, attachments: [a] }));
    expect(Date.now() - t0).toBeLessThan(1000); // 没有等满 2 秒
    expect(reply).toContain('a.xlsx');
  });

  it('默认窗口 2000ms(未显式配置时)', async () => {
    const seen: string[] = [];
    const runtime: AgentRuntime = { handleTurn: async (_c, request: string) => { seen.push(request); return { text: 'ok' }; } };
    const handler = createMessageHandler({ store: fakeStore(), runtime: runtime as unknown as AgentRuntime });
    const t0 = Date.now();
    await handler(msg({ text: '在吗' }));
    const elapsed = Date.now() - t0;
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
  const timed = async (handler: ReturnType<typeof build>) => { const t0 = Date.now(); await handler(msg('x')); return Date.now() - t0; };

  it('env 未设该键 → 用默认 2000', async () => {
    expect(await timed(build({}))).toBeGreaterThanOrEqual(1900);
  });

  it('env 设为 0 → 关闭防抖(不等)', async () => {
    expect(await timed(build({ FSHINE_INBOUND_DEBOUNCE_MS: '0' }))).toBeLessThan(1000);
  });

  it('env 设为 300 → 按配置等', async () => {
    const el = await timed(build({ FSHINE_INBOUND_DEBOUNCE_MS: '300' }));
    expect(el).toBeGreaterThanOrEqual(250);
    expect(el).toBeLessThan(1500);
  });

  it('env 是空串 → 仍用默认(不是 0)', async () => {
    expect(await timed(build({ FSHINE_INBOUND_DEBOUNCE_MS: '' }))).toBeGreaterThanOrEqual(1900);
  });

  it('env 是垃圾值 → 回退默认,不崩', async () => {
    expect(await timed(build({ FSHINE_INBOUND_DEBOUNCE_MS: 'abc' }))).toBeGreaterThanOrEqual(1900);
  });
});

describe('入站防抖的配置来源', () => {
  function build(env?: Record<string, string | undefined>) {
    const runtime: AgentRuntime = { handleTurn: async () => ({ text: 'ok' }) };
    return createMessageHandler({ store: fakeStore(), runtime: runtime as unknown as AgentRuntime, ...(env ? { env } : {}) });
  }
  const msg = (text: string): IncomingChannelMessage => ({ wecomUserId: USER, conversationId: USER, messageId: `m_${Math.random().toString(36).slice(2, 8)}`, text, receivedAt: new Date().toISOString() });
  const timed = async (handler: ReturnType<typeof build>) => { const t0 = Date.now(); await handler(msg('x')); return Date.now() - t0; };

  it('env 未设该键 → 用默认 2000', async () => { expect(await timed(build({}))).toBeGreaterThanOrEqual(1900); });
  it('env 设为 0 → 关闭防抖', async () => { expect(await timed(build({ FSHINE_INBOUND_DEBOUNCE_MS: '0' }))).toBeLessThan(1000); });
  it('env 设为 300 → 按配置等', async () => {
    const el = await timed(build({ FSHINE_INBOUND_DEBOUNCE_MS: '300' }));
    expect(el).toBeGreaterThanOrEqual(250);
    expect(el).toBeLessThan(1500);
  });
  it('env 空串 → 仍用默认(不是 0)', async () => { expect(await timed(build({ FSHINE_INBOUND_DEBOUNCE_MS: '' }))).toBeGreaterThanOrEqual(1900); });
  it('env 垃圾值 → 回退默认,不崩', async () => { expect(await timed(build({ FSHINE_INBOUND_DEBOUNCE_MS: 'abc' }))).toBeGreaterThanOrEqual(1900); });
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

  // 宿主 requestId = newId('req') = req_<uuid>；草稿位置名必须是这个形态才会被
  // isScratchDirName 认出来（与生产同一条判据，不另造一个假名字）。
  const REQUEST_ID = `req_${randomUUID()}`;
  const OTHER_SESSION_ID = `req_${randomUUID()}`;

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
    const files = collectProducedFiles(root, sinceTurnStart(), REQUEST_ID);
    expect(files.map((f) => f.filename)).toEqual(['工资表.xlsx']);
    expect(files[0]!.data.toString()).toBe('DATA');
  });

  it('since 之前就存在的老文件不收(那不是本轮产物)', () => {
    const root = freshRoot();
    const stale = put(root, '上一轮落下的产物.xlsx');
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(stale, longAgo, longAgo);                          // 把 mtime 推到一小时前
    expect(collectProducedFiles(root, new Date().toISOString(), REQUEST_ID)).toEqual([]);
  });

  it('tmp/attachments/ 里的不收(那是本轮输入,不是产物)', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    put(root, 'attachments/用户上传的原料.xlsx');
    expect(collectProducedFiles(root, since, REQUEST_ID)).toEqual([]);
  });

  it('别的会话的 tmp/req_<别的id>/ 不收', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    put(root, `${OTHER_SESSION_ID}/别人的草稿.xlsx`);
    expect(collectProducedFiles(root, since, REQUEST_ID)).toEqual([]);
  });

  it('本请求的 tmp/req_<本id>/ 收', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    put(root, `${REQUEST_ID}/整理好的表.xlsx`, 'MINE');
    const files = collectProducedFiles(root, since, REQUEST_ID);
    expect(files.map((f) => f.filename)).toEqual(['整理好的表.xlsx']);
    expect(files[0]!.data.toString()).toBe('MINE');
  });

  it('非办公扩展名不收(.py 是中间产物,不是交付物)', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    put(root, 'transform.py', 'print(1)');
    expect(collectProducedFiles(root, since, REQUEST_ID)).toEqual([]);
  });

  it('超过 20MB 不收', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    const big = put(root, '超大.xlsx', Buffer.alloc(20 * 1024 * 1024 + 1, 1));
    expect(statSync(big).size).toBeGreaterThan(20 * 1024 * 1024);
    expect(collectProducedFiles(root, since, REQUEST_ID)).toEqual([]);
  });

  it('最多 3 个', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    for (let i = 0; i < 6; i++) put(root, `f${i}.xlsx`);
    expect(collectProducedFiles(root, since, REQUEST_ID)).toHaveLength(3);
  });

  it('同一文件不重复收取(按解析后的真实路径去重)', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    const real = put(root, '工资表.xlsx', 'DATA');
    const link = path.join(root, 'tmp', REQUEST_ID, '工资表.xlsx');
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(real, link);                                      // 同一个文件,两个名字
    const files = collectProducedFiles(root, since, REQUEST_ID);
    expect(files).toHaveLength(1);
    expect(files[0]!.data.toString()).toBe('DATA');
  });

  it('指向 tmp/ 之外的符号链接不外发(解引用后仍须在受信边界内)', () => {
    const root = freshRoot();
    const since = sinceTurnStart();
    const outside = path.join(root, 'secret.docx');
    writeFileSync(outside, 'SECRET');
    symlinkSync(outside, path.join(root, 'tmp', '外泄.xlsx'));
    expect(collectProducedFiles(root, since, REQUEST_ID)).toEqual([]);
  });
});
