// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：W4 重发路由（2026-10-20 事故的直接修法）。
 * 共享替身见 ./harness.ts（真 SQLite、真配置派生的网关计划门、mock 执行器）。
 *
 * 事故形状：用户说"发一下 幻骥达2026年08月个税申报.xlsx"，模型申报委派、凭记忆把
 * 路径写错（/tmp + 编造 UUID），worker 拿着假路径 ls 失败后满目录 hunt，交还文本
 * "委派中给出的原文件路径已不存在……"原样上用户的屏。重发枝之后这条路是：申报
 * resend → runtime 记账零委派 → handler 依会话产物库确定性回答。
 *
 * 本文件钉三件事：
 *   ① 申报 resend → 零平台调用（委派被完全跳过，路由本身承重）；
 *   ② 回复文本由宿主依产物记录合成（带生成时间与显式时区），文件从库里取字节；
 *   ③ ref 不存在时确定回答"没有交付过"，零委派、不编造。
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

describe('[L4 集成] 离线全链 e2e：W4 重发路由（申报 resend → 零委派 → 宿主确定性回答）', () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

  /** 在会话产物库里放一份可重发的产物（真实字节落盘，ref 由调用方给）。 */
  async function seedArtifact(assembly: ServerAssembly, ref: string, sessionId: string = SESSION_ID): Promise<void> {
    const repo = assembly.store.sessionArtifacts;
    if (!repo) throw new Error('装配的 store 缺少 sessionArtifacts（W2 产物库）');
    const root = mkdtempSync(path.join(tmpdir(), 'resend-e2e-'));
    roots.push(root);
    const file = path.join(root, '工资表.xlsx');
    // 真实 sha256/size（读回校验启用后，假 seed——空串哈希、size 谎报——过不了重发门）。
    writeFileSync(file, 'XLSX-BYTES');
    await repo.insert({
      ref,
      sessionId,
      filename: '工资表.xlsx',
      sha256: createHash('sha256').update('XLSX-BYTES').digest('hex'),
      size: Buffer.byteLength('XLSX-BYTES'),
      createdAt: '2026-10-20T07:03:35.876Z',
      status: 'available',
      path: file,
    });
  }

  it('R1 申报 resend：零平台调用，宿主从库里取文件并合成带出处的回复', async () => {
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

  it('R2 申报不存在的 ref：确定性回答，零平台调用', async () => {
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
    await seedArtifact(assembly, '1', 'wecom:grp_e2e');

    const reply = await send('发一下 工资表.xlsx', { userid: 'e2e_user_b', group: true });
    expect(totalActualCalls()).toBe(before);
    expect(reply).toContain('重发：#1 工资表.xlsx');
    expect(reply).toContain('本轮回传：工资表.xlsx');
    // 记录确实在群会话键下：窗口内全员可见、可指代（群语义的产品决策）
    const rows = await assembly.store.sessionArtifacts!.listBySession('wecom:grp_e2e');
    expect(rows).toHaveLength(1);
  });
});