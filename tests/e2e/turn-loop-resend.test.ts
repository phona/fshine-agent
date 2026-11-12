// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：W4 重发路由（2026-10-20 事故的直接修法；直连工具形态）。
 * 共享替身见 ./harness.ts（真 SQLite、真配置派生的网关计划门、mock 执行器）。
 *
 * 事故形状：用户说"发一下 幻骥达2026年08月个税申报.xlsx"，模型凭记忆把路径写错
 * （/tmp + 编造 UUID），worker 拿着假路径 ls 失败后满目录 hunt，交还文本
 * "委派中给出的原文件路径已不存在……"原样上用户的屏。重发工具落地之后这条路是：
 * 模型调用 resend_artifact（refs=产物清单里的 #编号）→ runtime 记账零委派 →
 * handler 依会话产物库确定性回答（存在/淘汰/字节/摘要四态）。
 *
 * 本文件钉：
 *   ① 重发回合零平台调用（委派被完全跳过，路由本身承重）；
 *   ② 回复文本由宿主依产物记录合成（带生成时间与显式时区），文件从库里取字节；
 *   ③ ref 不存在/淘汰/字节不在/摘要不符的确定回答，零委派、不编造；
 *   ④ 非法引用（文件名/路径/空数组/超上限）被宿主复检拒绝：可恢复工具错误、零委派、
 *      零文件；模型换合法编号后仍可重发（同一条工具面）；
 *   ⑤ 群共享窗口的会话归属（B 指代 A 的产物）与未授权用户照常拒绝。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ServerAssembly } from '../../apps/server/assembly';
import { boot, gatedWorker, mainDriver, totalActualCalls } from './harness';

/** 单聊会话：conversationId 回落为 userid（W1 后 sessionId = channel:conversationId）。 */
const SESSION_ID = 'wecom:e2e_user';

describe('[L4 集成] 离线全链 e2e：W4 重发路由（直连 resend_artifact → 零委派 → 宿主确定性回答）', () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

  /** 在会话产物库里放一条产物记录（真实字节落盘，ref 由调用方给）。 */
  async function seedArtifact(
    assembly: ServerAssembly,
    ref: string,
    options: {
      sessionId?: string;
      filename?: string;
      bytes?: string;
      status?: 'available' | 'evicted';
      /** 记录指向的字节路径；缺省在临时目录真写一份 bytes。 */
      path?: string;
      /** 登记摘要（与字节不符时构造"损坏"）；缺省按 bytes 计算。 */
      sha256?: string;
    } = {},
  ): Promise<void> {
    const repo = assembly.store.sessionArtifacts;
    if (!repo) throw new Error('装配的 store 缺少 sessionArtifacts（W2 产物库）');
    const root = mkdtempSync(path.join(tmpdir(), 'resend-e2e-'));
    roots.push(root);
    const filename = options.filename ?? '工资表.xlsx';
    const bytes = options.bytes ?? 'XLSX-BYTES';
    const storedPath = options.path ?? path.join(root, filename);
    if (options.path === undefined) writeFileSync(storedPath, bytes);
    await repo.insert({
      ref,
      sessionId: options.sessionId ?? SESSION_ID,
      filename,
      sha256: options.sha256 ?? createHash('sha256').update(bytes).digest('hex'),
      size: Buffer.byteLength(bytes),
      createdAt: '2026-10-20T07:03:35.876Z',
      status: options.status ?? 'available',
      path: storedPath,
    });
  }

  it('R1 直连 resend：零平台调用，宿主从库里取文件并合成带出处的回复', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'resend', artifactRef: '1' }]),
      worker: gatedWorker([]),
    });
    await seedArtifact(assembly, '1');

    const reply = await send('发一下 工资表.xlsx');
    expect(totalActualCalls()).toBe(before);                        // 零委派：平台一次没调
    expect(reply).toContain('重发：#1 工资表.xlsx');
    expect(reply).toContain('2026-10-20 15:03 UTC+8');              // 出处：生成时间（显式时区）
    expect(reply).toContain('本轮回传：工资表.xlsx');
    // 重发不重新入库：库里仍只有一条
    expect(await assembly.store.sessionArtifacts!.listBySession(SESSION_ID)).toHaveLength(1);
  });

  it('R2 不存在的 ref：确定性回答，零平台调用', async () => {
    const before = totalActualCalls();
    const { send } = await boot({
      main: mainDriver([{ kind: 'resend', artifactRef: '9' }]),
      worker: gatedWorker([]),
    });

    const reply = await send('发一下 不存在的表');
    expect(totalActualCalls()).toBe(before);
    expect(reply).toContain('本会话没有交付过产物 #9');
    expect(reply).not.toContain('本轮回传');                        // 零文件：没有点名行
  });

  it('R3 群聊共享窗口：A 交付的产物，B（另一个用户）在同群指代重发成功', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'resend', artifactRef: '1' }]),
      worker: gatedWorker([]),
    });
    // B 也要有 scope：handler 对每个回合都查授权（重发不委派，授权照查）。
    await assembly.store.principalScopes.upsert({
      wecomUserId: 'e2e_user_b', accountSetIds: [], accountSetScope: 'all', enabled: true,
    });
    // 产物挂在群会话键下（A 在群里交付时入库的形态）。W1 起 session = 聊天窗口：
    // 群不按用户切，B 的回合与 A 的交付落在同一个会话产物库里。
    await seedArtifact(assembly, '1', { sessionId: 'wecom:grp_e2e' });

    const reply = await send('发一下 工资表.xlsx', { userid: 'e2e_user_b', group: true });
    expect(totalActualCalls()).toBe(before);
    expect(reply).toContain('重发：#1 工资表.xlsx');
    expect(reply).toContain('本轮回传：工资表.xlsx');
    // 记录确实在群会话键下：窗口内全员可见、可指代（群语义的产品决策）
    const rows = await assembly.store.sessionArtifacts!.listBySession('wecom:grp_e2e');
    expect(rows).toHaveLength(1);
  });

  it('R4 非法引用形状：可恢复工具错误（模型换合法编号仍可重发），零委派、零文件', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([
        // ① 文件名 ② 路径 ③ 空数组 ④ 超上限（元素合法但给多了）：全部应被宿主复检拒绝，
        // 都不是 terminate——可恢复工具错误交还模型；模型继续本轮换合法编号重发。
        { kind: 'resend', refs: ['工资表.xlsx'] },
        { kind: 'resend', refs: ['/tmp/工资表.xlsx'] },
        { kind: 'resend', refs: [] },
        { kind: 'resend', refs: ['1', '2', '3', '4'] },
        { kind: 'resend', refs: ['#1', '1'] },
      ]),
      worker: gatedWorker([]),
    });
    await seedArtifact(assembly, '1');

    const reply = await send('把工资表再发一次');
    expect(totalActualCalls()).toBe(before);                        // 零委派
    // 最后一条合法（#1 与 1 等价、去重后只发一次）：宿主合成正式回复
    expect(reply).toContain('重发：#1 工资表.xlsx');
    expect(reply).toContain('本轮回传：工资表.xlsx');
    expect(reply.match(/本轮回传/g)).toHaveLength(1);               // 去重：不重复回挂
    expect(reply).not.toContain('重发只接受');                      // 占位/错误话术不上屏
  });

  it('R5 混合合法+非法 ref：note 与 failure 并存，合法文件照挂', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'resend', refs: ['1', '9'] }]),
      worker: gatedWorker([]),
    });
    await seedArtifact(assembly, '1');

    const reply = await send('把 1 号和工作表都发来');
    expect(totalActualCalls()).toBe(before);
    expect(reply).toContain('重发：#1 工资表.xlsx');
    expect(reply).toContain('本会话没有交付过产物 #9');
    expect(reply).toContain('本轮回传：工资表.xlsx');
  });

  it('R6 已淘汰的产物：确定回答"已淘汰，需要重新计算"，零文件', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'resend', artifactRef: '2' }]),
      worker: gatedWorker([]),
    });
    await seedArtifact(assembly, '2', { status: 'evicted' });

    const reply = await send('发一下之前那个表');
    expect(totalActualCalls()).toBe(before);
    expect(reply).toContain('产物 #2 已淘汰，需要重新计算');
    expect(reply).not.toContain('本轮回传');
  });

  it('R7 字节不在：确定回答"文件已不在，需要重新计算"，零文件', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'resend', artifactRef: '3' }]),
      worker: gatedWorker([]),
    });
    const root = mkdtempSync(path.join(tmpdir(), 'resend-e2e-'));
    roots.push(root);
    await seedArtifact(assembly, '3', { path: path.join(root, 'gone.xlsx') });   // 记录在、字节被删

    const reply = await send('发一下那个表');
    expect(totalActualCalls()).toBe(before);
    expect(reply).toContain('产物 #3 的文件已不在，需要重新计算');
    expect(reply).not.toContain('本轮回传');
  });

  it('R8 字节被篡改（摘要不符）：确定回答"文件已损坏，需要重新计算"，零文件', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'resend', artifactRef: '4' }]),
      worker: gatedWorker([]),
    });
    // 盘上字节与登记摘要不符：重发前重读字节 + 复验 sha256/size，绝不拿库行当字节凭据。
    await seedArtifact(assembly, '4', { bytes: 'TAMPERED-BYTES', sha256: createHash('sha256').update('XLSX-BYTES').digest('hex') });

    const reply = await send('发一下那个表');
    expect(totalActualCalls()).toBe(before);
    expect(reply).toContain('产物 #4 的文件已损坏，需要重新计算');
    expect(reply).not.toContain('本轮回传');
  });

  it('R9 未授权用户重发：授权照查（重发不委派 ≠ 豁免身份），零平台调用、零文件', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'resend', artifactRef: '1' }]),
      worker: gatedWorker([]),
    });
    await seedArtifact(assembly, '1');

    // e2e_unknown 没有开通 scope；handler 的授权检查先于 runtime，重发回合不豁免。
    const reply = await send('发一下那个表', { userid: 'e2e_unknown' });
    expect(reply).toContain('未开通查询权限');
    expect(totalActualCalls()).toBe(before);
    expect(reply).not.toContain('本轮回传');
  });
});
