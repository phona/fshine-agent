/**
 * 离线全链 e2e：附件/文件消息的真实渠道路径。
 * 共享替身见 ./harness.ts（真企微 adapter、真 handler、真 SQLite、真 bin/17dz 计划门、mock 执行器）。
 *
 * apps/server/handler.test.ts 已把暂存/FIFO/迟到文件的 handler 语义钉死，但那些用例直接调
 * handler、附件是手工造的 IncomingAttachment——"用户发文件 → SDK 下载 → 落盘 → 暂存/交付 →
 * 委派"这条真实渠道路径在全链上不存在：此前 e2e 只发 text 帧，adapter 的 message.file
 * 分发、saveAttachments 落盘、attachmentOnly 短路从未在生产装配里跑过。
 *
 * 本文件经 boot 的 sendFile（与生产同形状的 message.file 帧）走完整链路，钉三件事：
 *   ① 附件-only：暂存确认 + attachment_received 落库 + 字节真实落盘（平台工作区内）；
 *   ② 先文件后指令：附件路径由 handler 注入请求文本（withAttachmentPaths），worker 提交的
 *      计划参数带该路径能过实体门（镜像 handler.test.ts :182「附件路径 + 期间一起注入后过门」；
 *      flag 形态是对它的适配——harness 可执行脚本面只有 finance.*，路径作 --query 取值，
 *      实体门对位置/flag 取值是同一把尺：非 flag 值逐字包含判定）；
 *   ③ 下载失败：失败说明降级成文字不吞消息，且照常启 Agent 回合（表征——handler 的
 *      attachment-only 短路要求"有已保存附件"，下载失败一个都没有，于是走普通回合；
 *      与 handler 单测语义不冲突但全链形状在此钉实）。
 *
 * 纪律：DZ_EXECUTOR=mock 由 harness 钉死；本文件只新增用例，不改 harness 与既有文件。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServerAssembly } from '../../apps/server/assembly';
import { parseAttachmentEnvelope } from '../../apps/server/handler';
import {
  boot,
  gatedWorker,
  mainDriver,
  PLATFORM_ROOT,
  totalActualCalls,
  withoutPlatformEnvelope,
} from './harness';

/** 附件信封的会话键：单聊 conversationId=userid，与 handler 的 sessionKey 拼法一致。 */
const SESSION_KEY = 'e2e_user:e2e_user';

/** 生产恢复路径的同一入口：读本 principal 最近的 attachment_received 行。 */
async function recentAttachmentRows(assembly: ServerAssembly) {
  return (await assembly.store.requests.listRecentAttachments?.(
    'wecom:e2e_user',
    new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  )) ?? [];
}

/** 审计观察：包一层 requests.insert 记录每条请求的 outcome（不改行为，只看结果）。 */
function recordRequestOutcomes(assembly: ServerAssembly): string[] {
  const outcomes: string[] = [];
  const originalInsert = assembly.store.requests.insert.bind(assembly.store.requests);
  assembly.store.requests.insert = async (record) => {
    outcomes.push(record.outcome);
    await originalInsert(record);
  };
  return outcomes;
}

describe('离线全链 e2e：附件/文件消息的真实渠道路径', () => {
  it('AT-1 附件-only 消息：只暂存不启回合，确认文案、attachment_received 落库与真实落盘齐全', async () => {
    // 若这条消息意外启了 Agent 回合，主 Agent 的申报文本会顶替确认回复，精确断言当场响
    const { sendFile, assembly } = await boot({
      main: mainDriver([{ kind: 'conversation', text: '不应有回合：附件-only 消息不得启 Agent' }]),
      worker: gatedWorker([]),
    });
    const outcomes = recordRequestOutcomes(assembly);

    const reply = await sendFile('对账单-202606.csv');

    // 暂存确认（表征钉真实文案）：短、只说事实，没有"请告诉我需要做什么"式噪音
    expect(reply).toBe('已收到 对账单-202606.csv');
    // 没启 Agent 回合：唯一的审计就是附件接收登记，没有 replied
    expect(outcomes).toEqual(['attachment_received']);
    // 登记行带着机器可解析的信封（生产重启恢复的同一数据源），路径可取回
    const rows = await recentAttachmentRows(assembly);
    const parsed = rows.flatMap((row) => parseAttachmentEnvelope(row.input, SESSION_KEY));
    expect(parsed).toHaveLength(1);
    const att = parsed[0];
    if (!att) throw new Error('附件信封解析失败：attachment_received 行里没有可恢复的路径');
    expect(att.filename).toBe('对账单-202606.csv');
    // 真实落盘：目录在平台 tmp 下的 boot 专属附件区（adapter 落点自检的受信边界），字节一致
    expect(att.path.startsWith(path.join(PLATFORM_ROOT, 'tmp', 'attachments-e2e-'))).toBe(true);
    expect(existsSync(att.path)).toBe(true);
    expect(readFileSync(att.path, 'utf8')).toBe('e2e-attachment-bytes');
    // basename 化：落盘名 = uuid 前缀 + 安全化文件名，用户可写的目录结构不保留
    expect(path.basename(att.path).endsWith('对账单-202606.csv')).toBe(true);
    expect(readdirSync(path.dirname(att.path))).toHaveLength(1);
    await assembly.close();
  });

  it('AT-2 先文件后指令：附件路径随请求交付 worker，计划过实体门并真实执行', async () => {
    const before = totalActualCalls();
    const declarations: Array<Record<string, unknown>> = [];
    // worker 替身晚装配：附件落盘路径要等 sendFile 之后才知道，计划参数才能逐字带上它
    const captured: Array<{ messages: unknown[]; entitySources?: { currentMessage?: string } }> = [];
    let inner: ReturnType<typeof gatedWorker> | null = null;
    const worker = {
      run: async (input: { messages: unknown[]; entitySources?: { currentMessage?: string } }) => {
        captured.push({ messages: input.messages, entitySources: input.entitySources });
        if (!inner) throw new Error('worker 替身未装配：附件路径在 sendFile 之后才可用');
        return inner.run(input as never);
      },
    };
    const { sendFile, turn, assembly } = await boot({ main: mainDriver(declarations), worker });
    const outcomes = recordRequestOutcomes(assembly);

    expect(await sendFile('对账单-202606.csv')).toBe('已收到 对账单-202606.csv');
    const rows = await recentAttachmentRows(assembly);
    const att = rows.flatMap((row) => parseAttachmentEnvelope(row.input, SESSION_KEY))[0];
    if (!att) throw new Error('附件信封解析失败：attachment_received 行里没有可恢复的路径');

    // mock 账套按"名字包含查询词"命中：查询词是整条附件路径，得种一份名字含它的账套，
    // 否则 ACCOUNT_SET_NOT_FOUND（选择类澄清码）会让宿主组装澄清问题接管终稿，交付链的
    // "执行结果上屏"就验不到。种 mock 状态文件是它的正常用法（重置/预置 = 写这个文件），
    // 执行器仍是 mock，DZ_EXECUTOR 没动。
    const statePath = process.env['DZ_MOCK_STATE'];
    if (!statePath) throw new Error('harness 未设置 DZ_MOCK_STATE');
    const seed = JSON.parse(
      readFileSync(path.join(PLATFORM_ROOT, 'src', 'execution', 'mocks', 'fixtures', 'seed.json'), 'utf8'),
    ) as { accountSets: Record<string, unknown> };
    seed.accountSets[att.path] = {
      subjects: [
        { code: '1122', name: '应收账款', useAssistant: false, assistantType: '', balances: { 202606: { debit: 9800, credit: 0, balance: 9800 } } },
      ],
      assistants: [],
      vouchers: {},
    };
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(seed));

    // 计划镜像 handler.test.ts :182「附件路径 + 用户给出的期间一起注入后过实体门」：
    // 路径逐字来自宿主注入的请求文本（withAttachmentPaths），期间 202606 来自用户原话。
    inner = gatedWorker([
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', att.path, '--period', '202606'] }] },
      { text: '已读取对账单附件并核对完成：202606 余额与平台应收账款一致。' },
    ], { enforceEntityScope: true });
    declarations.push({ kind: 'delegate', request: `核对已上传的对账单 202606，附件在 ${att.path}` });

    const { text: reply, notices } = await turn('核对一下我刚发的对账单 202606');

    // 全链落地：附件登记 → 正文回合 replied；计划激活 + 一次真实平台调用（记账可查）
    expect(outcomes).toEqual(['attachment_received', 'replied']);
    expect(totalActualCalls()).toBe(before + 1);
    // worker 收到的材料：宿主注入的实体来源（门禁判定面）与本任务请求都带着附件路径——
    // 路径若没被注入，实体门会像 handler.test.ts :191 的反证那样拒掉同一个计划
    expect(captured).toHaveLength(1);
    expect(captured[0]?.entitySources?.currentMessage).toContain(att.path);
    expect(captured[0]?.entitySources?.currentMessage).toContain('202606');
    expect(JSON.stringify(captured[0]?.messages)).toContain(att.path);
    // 用户看到 worker 的核对结论（委派 terminate 语义），不是主 Agent 的兜底文本
    expect(reply).toContain('已读取对账单附件并核对完成');
    expect(reply).not.toContain('不应外发');
    // 执行痕迹在替身文本里是原始形态（harness 已知保真边界，withoutPlatformEnvelope 的存在理由）
    expect(reply).toContain('执行 finance.query-receivables');
    // 回复卫生：剥掉平台执行信封后，叙述体不带信封、不带整条附件路径（披露只说文件名）；
    // 宿主内部目录（harness stateDir 前缀）在任何帧都不得出现
    const clean = withoutPlatformEnvelope(reply);
    expect(clean).not.toContain('RESULT {');
    expect(clean).not.toContain(att.path);
    expect(reply).not.toContain('fshine-turn-loop-');
    // 交付披露（规则二）：说文件名，不刷路径
    const disclosure = notices.find((t) => t.startsWith('本轮使用文件'));
    expect(disclosure).toBe('本轮使用文件：对账单-202606.csv');
    await assembly.close();
  });

  it('AT-3 附件下载失败：失败说明降级成文字不吞消息，且照常启 Agent 回合（表征）', async () => {
    const observed: string[] = [];
    const { sendFile, assembly } = await boot({
      // 生产形状：模型读到 adapter 的失败说明并转达，给用户可行动的建议。e2e 钉的是管道
      // （失败文本到达模型、用户拿到收尾帧），不是模型的措辞——所以转达文本由替身给出。
      main: mainDriver([
        { kind: 'conversation', text: '[附件下载失败] 文件没有拿到，请重新发送一次，收到后我会接着处理。' },
      ], (input) => { observed.push(JSON.stringify(input.messages)); }),
      worker: gatedWorker([]),
    });
    const outcomes = recordRequestOutcomes(assembly);

    const reply = await sendFile('对账单-202606.csv', { failDownload: true });

    // 用户收到带失败标记的回复（adapter 的降级说明经模型转达），不是干等一个不来的回复
    expect(reply).toContain('[附件下载失败');
    // 失败文本确实作为用户消息进了 Agent 回合——降级不是静默丢
    expect(observed.some((line) => line.includes('[附件下载失败'))).toBe(true);
    // 表征钉（与 handler 单测的 attachment-only 短路语义对照着读）：这条消息**有** Agent
    // 回合。handler 只对"带已保存附件"的 attachmentOnly 消息短路；下载失败一条都没保存，
    // 降级成文字后照常走普通回合，落审计为 replied；失败的东西也不进暂存池——
    // 没有任何 attachment_received 登记。
    expect(outcomes).toEqual(['replied']);
    expect(await recentAttachmentRows(assembly)).toEqual([]);
    // 下载失败不落盘：boot 的附件目录根本不会被创建（mkdir 发生在下载成功之后）
    const tmpEntries = existsSync(path.join(PLATFORM_ROOT, 'tmp'))
      ? readdirSync(path.join(PLATFORM_ROOT, 'tmp')).filter((name) => name.startsWith('attachments-e2e-'))
      : [];
    expect(tmpEntries).toEqual([]);
    await assembly.close();
  });
});
