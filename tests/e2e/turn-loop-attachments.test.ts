/**
 * 离线全链 e2e：附件/文件消息的真实渠道路径。
 * 共享替身见 ./harness.ts（真企微 adapter、真 handler、真 SQLite、真 bin/17dz 计划门、mock 执行器）。
 *
 * apps/server/handler.test.ts 已把暂存/FIFO/迟到文件的 handler 语义钉死，但那些用例直接调
 * handler、附件是手工造的 IncomingAttachment——"用户发文件 → SDK 下载 → 落盘 → 暂存/交付 →
 * 委派"这条真实渠道路径在全链上不存在：此前 e2e 只发 text 帧，adapter 的 message.file
 * 分发、saveAttachments 落盘、attachmentOnly 短路从未在生产装配里跑过。
 *
 * 本文件经 boot 的 sendFile（与生产同形状的 message.file 帧）走完整链路，钉四件事：
 *   ① 附件-only：暂存确认 + attachment_received 落库 + 字节真实落盘（平台工作区内）；
 *   ② 先文件后指令：附件路径由 handler 注入请求文本（withAttachmentPaths），worker 提交的
 *      计划参数带该路径能过实体门（镜像 handler.test.ts :182「附件路径 + 期间一起注入后过门」；
 *      flag 形态是对它的适配——harness 可执行脚本面只有 finance.*，路径作 --query 取值，
 *      实体门对位置/flag 取值是同一把尺：非 flag 值逐字包含判定）；
 *   ③ 下载失败：失败说明降级成文字不吞消息，且照常启 Agent 回合（表征——handler 的
 *      attachment-only 短路要求"有已保存附件"，下载失败一个都没有，于是走普通回合；
 *      与 handler 单测语义不冲突但全链形状在此钉实）；
 *   ④ 突发形态（2026-10-19）：几个文件 + 一条指令连发时，文件消息一个气泡都不开，收据
 *      只由指令回合带一次（实测 3 文件 + 1 指令曾出现 4 条气泡且互相穿插）。
 *
 * 纪律：EXECUTION_EXECUTOR=mock 由 harness 钉死；本文件只新增用例，不改 harness 与既有文件。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ServerAssembly } from '../../apps/server/assembly';
import { parseAttachmentEnvelope, TURN_ACCEPTED_TEXT } from '../../apps/server/handler';
import {
  boot,
  gatedWorker,
  mainDriver,
  PLATFORM_ROOT,
  totalActualCalls,
  withoutPlatformEnvelope,
} from './harness';

/** 附件信封的会话键：单聊 conversationId=userid，与 handler 的 sessionKey 拼法一致。 */
const SESSION_KEY = 'e2e_user';

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
  it('AT-1 附件-only 消息：只暂存不启回合，孤儿收据、attachment_received 落库与真实落盘齐全', async () => {
    // 若这条消息意外启了 Agent 回合，主 Agent 的申报文本会顶替确认回复，精确断言当场响
    const { sendFile, assembly } = await boot({
      main: mainDriver([{ kind: 'conversation', text: '不应有回合：附件-only 消息不得启 Agent' }]),
      worker: gatedWorker([]),
    });
    const outcomes = recordRequestOutcomes(assembly);

    const reply = await sendFile('对账单-202606.csv');

    // 没有指令跟来：渠道并窗到点补一条收据（2026-10-19 起文件消息自己不再回气泡）。
    // 2026-10-20 起收据不再带"等待你的指令"后缀——气泡本身就是回应，那句把"存个档"
    // 误设成待办；措辞与回合披露逐字相同（contracts.formatFileReceipt）
    expect(reply).toBe('已收到 1 个文件：对账单-202606.csv');
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
    expect(att.path.startsWith(path.join(PLATFORM_ROOT, 'tmp', 'attachments', 'e2e-'))).toBe(true);
    expect(existsSync(att.path)).toBe(true);
    expect(readFileSync(att.path, 'utf8')).toBe('e2e-attachment-bytes');
    // basename 化：落盘名 = uuid 前缀 + 安全化文件名，用户可写的目录结构不保留
    expect(path.basename(att.path).endsWith('对账单-202606.csv')).toBe(true);
    expect(readdirSync(path.dirname(att.path))).toHaveLength(1);
    // ── locality 契约（2026-10-20 钉死）──────────────────────────────────────
    // 契约只认"宿主可见的本地绝对路径"：宿主与 worker 按同一个路径引用同一份文件，实体门
    // 也按"路径在本轮请求文本里"执法。adapter 负责把渠道上的文件落到这个位置——企微要
    // aeskey 解密下载，web/小程序客户端大概会放在对象存储里，那时也是 adapter 先下载到
    // 同一个附件目录，契约一个字不用改。所以这里显式钉住"不是 URL、不是存储 key"：
    // 谁若让 worker 直接读签名 URL，裂开的是这条契约（且文件会在签名过期后静默失效）。
    expect(path.isAbsolute(att.path)).toBe(true);
    expect(att.path).not.toMatch(/^[a-z][a-z0-9+.-]*:\/\//i);
    expect(att.path).not.toContain('?');                         // 签名参数不进契约
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

    // 文件消息等不及指令：并窗先补一条孤儿收据（sendFile 等的就是这条终帧）。
    // 2026-10-20 起不带"等待你的指令"后缀（气泡本身就是回应）
    expect(await sendFile('对账单-202606.csv')).toBe('已收到 1 个文件：对账单-202606.csv');
    const rows = await recentAttachmentRows(assembly);
    const att = rows.flatMap((row) => parseAttachmentEnvelope(row.input, SESSION_KEY))[0];
    if (!att) throw new Error('附件信封解析失败：attachment_received 行里没有可恢复的路径');

    // mock 账套按"名字包含查询词"命中：查询词是整条附件路径，得种一份名字含它的账套，
    // 否则 ACCOUNT_SET_NOT_FOUND（选择类澄清码）会让宿主组装澄清问题接管终稿，交付链的
    // "执行结果上屏"就验不到。种 mock 状态文件是它的正常用法（重置/预置 = 写这个文件），
    // 执行器仍是 mock，EXECUTION_EXECUTOR 没动。
    const statePath = process.env['EXECUTION_MOCK_STATE'];
    if (!statePath) throw new Error('harness 未设置 EXECUTION_MOCK_STATE');
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
    // 交付披露（规则二）：说文件名，不刷路径；与渠道孤儿收据同一句措辞，只少"等待指令"
    const disclosure = notices.find((t) => t.startsWith('已收到'));
    expect(disclosure).toBe('已收到 1 个文件：对账单-202606.csv');
    await assembly.close();
  });

  it('AT-3 附件下载失败：失败说明降级成文字不吞消息，且照常启 Agent 回合（表征）', async () => {
    const observed: string[] = [];
    const { sendFile, assembly, attachmentDir } = await boot({
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
    expect(existsSync(attachmentDir)).toBe(false);
    await assembly.close();
  });

  // 2026-10-19 实测形态的守卫：用户发 3 个 Excel + 1 条指令，会话里出现 4 条机器人气泡
  // （3 条"已收到 X" + 一串回合帧），且文件回执与回合帧互相穿插。根因在渠道：企微流式
  // 回复按入站消息的 req_id 走，一条用户消息就是一个气泡，SDK 没有跨消息合并的接口
  // （reply() 只转发 frame.headers.req_id）。修法是"不为文件起气泡"——这里在全链上钉死。
  it('AT-4 突发形态（2 个文件 + 1 条指令连发）：文件消息零帧，收据只由指令回合带一次', async () => {
    const { sdk, assembly, turn } = await boot({
      main: mainDriver([{ kind: 'conversation', text: '两个文件都读到了，202606 核对完成。' }]),
      worker: gatedWorker([]),
    });
    const outcomes = recordRequestOutcomes(assembly);

    // 直接派发 file 帧：与 sendFile 同形状，但不等它的终帧——这一条断言的前提恰恰是
    // "文件消息不产生终帧"，等一个不来的终帧会把用例挂死。
    const emitFile = async (filename: string): Promise<void> => {
      sdk.fileToServe = { filename, buffer: Buffer.from('e2e-attachment-bytes') };
      const messageId = `msg_${Math.random().toString(36).slice(2, 10)}`;
      sdk.emit('message.file', {
        headers: { req_id: `req_${messageId}` },
        body: {
          msgtype: 'file',
          from: { userid: 'e2e_user' },
          msgid: messageId,
          chattype: 'single',
          file: { url: `https://wecom-mock/${filename}`, aeskey: 'e2e-aes-key' },
        },
      });
      // 等暂存登记落库：确认 handler 真的处理过这条消息，指令才不会早于它到达
      await vi.waitFor(async () => {
        expect((await recentAttachmentRows(assembly)).length).toBeGreaterThanOrEqual(emitted);
      });
      emitted += 1;
    };

    let emitted = 0;
    await emitFile('对账单-202606.csv');
    await emitFile('工资表-202608.xlsx');
    const framesAfterFiles = sdk.frames.length;
    // 两个文件消息一个气泡都没开：没有 ack、没有收据、没有转圈的 spinner。
    // （并窗已在跑，但指令随后就到——见下面的取消断言。）
    expect(sdk.frames).toEqual([]);

    const { text, notices } = await turn('核对一下我刚发的两个文件 202606');

    // 收据在全链上只出现一次，且与孤儿收据逐字同句（2026-10-20 起后缀也去掉了）
    const receipts = sdk.frames.filter((frame) => frame.content.startsWith('已收到'));
    expect(receipts).toHaveLength(1);
    // 两个文件名都在同一帧里（顺序不钉：交付集按路径排序，而 e2e 的落盘名带 uuid 前缀，
    // 顺序由前缀决定——"并成一条"才是这条用例要守的东西）
    expect(receipts[0]!.content).toMatch(/^已收到 2 个文件：.+、.+$/);
    expect(receipts[0]!.content).toContain('对账单-202606.csv');
    expect(receipts[0]!.content).toContain('工资表-202608.xlsx');
    expect(receipts[0]!.finish).toBe(false);            // 披露帧，不是终帧
    expect(notices.some((t) => t.startsWith('已收到 2 个文件：'))).toBe(true);
    // 并窗被指令取消：否则这里会有第二条收据。2026-10-20 前靠"等待你的指令"后缀区分两条，
    // 后缀去掉后判别并到上面的 length===1（同一措辞，多一条就是冗余）
    // 附件回合的终稿照常送达，两个文件都进了暂存池（登记两条）
    expect(text).toContain('两个文件都读到了');
    expect(outcomes).toEqual(['attachment_received', 'attachment_received', 'replied']);
    await assembly.close();
  });

  // 2026-10-20 用户观察（企微会话实录）：用户先发几个 Excel + 一条指令，之后又问了一句
  // 与附件无关的话（"发一下 幻骥达2026年08月个税申报.xlsx 给我"），那一回合的气泡里又
  // 冒出"已收到 3 个文件：…"——用户原话："怎么不管怎么样都会显示说收到附件？"
  // 根因：收据帧挂在"本轮交付集非空"上，而规则一在"没有新附件"时沿用上次委派的交付集
  // （纠正/重试流），于是每一句后续指令都复读旧清单。handler 单测钉死语义，这里在全链上
  // 钉死形状：收据只属于"文件刚到"那一轮，与附件无关的后续回合安静交付（文件照旧进请求）。
  it('AT-5 文件到过之后：与附件无关的后续回合不再复读收据（交付不变）', async () => {
    const observed: string[] = [];
    const { sdk, turn, assembly } = await boot({
      main: mainDriver([
        { kind: 'conversation', text: '两个文件都读到了，202606 核对完成。' },
        { kind: 'conversation', text: '个税申报表在平台导出目录里，我发你。' },
      ], (input) => { observed.push(JSON.stringify(input.messages)); }),
      worker: gatedWorker([]),
    });
    const outcomes = recordRequestOutcomes(assembly);

    // 直接派发 file 帧（与 AT-4 同法：文件消息没有终帧可等，并窗到点才补孤儿收据，
    // 而指令随后就到——这条用例守的正是"指令回合的收据只播一次"）
    const emitFile = async (filename: string): Promise<void> => {
      sdk.fileToServe = { filename, buffer: Buffer.from('e2e-attachment-bytes') };
      const messageId = `msg_${Math.random().toString(36).slice(2, 10)}`;
      sdk.emit('message.file', {
        headers: { req_id: `req_${messageId}` },
        body: {
          msgtype: 'file',
          from: { userid: 'e2e_user' },
          msgid: messageId,
          chattype: 'single',
          file: { url: `https://wecom-mock/${filename}`, aeskey: 'e2e-aes-key' },
        },
      });
      await vi.waitFor(async () => {
        expect((await recentAttachmentRows(assembly)).length).toBeGreaterThanOrEqual(emitted);
      });
      emitted += 1;
    };

    let emitted = 0;
    await emitFile('工资表2026-8月(1).xlsx');
    await emitFile('幻骥达26年8月社保实际缴费金额模版（幻企赢导入.xls');
    const first = await turn('核对一下我刚发的两个文件 202606');
    const second = await turn('发一下 幻骥达2026年08月个税申报.xlsx 给我');   // 一个字附件都没有

    // 整个会话里收据只出现一次，且只属于第一个（文件刚到那一个）回合
    const receipts = sdk.frames.filter((frame) => frame.content.startsWith('已收到'));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.content).toContain('工资表2026-8月(1).xlsx');
    expect(receipts[0]!.content).toContain('幻骥达26年8月社保实际缴费金额模版（幻企赢导入.xls');
    // 第二个回合零收据：不播旧清单，受理帧照旧（没有收据顶替它时它就是"开跑了"的证据）
    expect(second.notices.filter((t) => t.startsWith('已收到'))).toEqual([]);
    expect(second.steps).toContain(TURN_ACCEPTED_TEXT);
    expect(second.text).toBe('个税申报表在平台导出目录里，我发你。');
    // 但文件仍交付给 worker（规则一的纠正/重试沿用）：请求文本里两个文件名都在
    expect(observed).toHaveLength(2);
    expect(observed[1]).toContain('工资表2026-8月(1).xlsx');
    expect(observed[1]).toContain('幻骥达26年8月社保实际缴费金额模版（幻企赢导入.xls');
    // 第二个回合是真正的 replied 回合，不是被附件短路掉的那种
    expect(outcomes).toEqual(['attachment_received', 'attachment_received', 'replied', 'replied']);
    expect(first.text).toContain('两个文件都读到了');
    await assembly.close();
  });
});
