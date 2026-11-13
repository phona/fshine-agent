// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置（本文件按仓内 eval 夹具跑）：AGENT_CONFIG_PATH=scripts/eval/eval.agent.yaml +
// 脚本化驱动，不碰真平台。通用闭环只认 typecheck + unit + generic-mock，本文件证据不冒充通用证据。
/**
 * 共享保真缝的锁（W1，2026-11-13）。五条缝各自的失效症状都不是"报错"，而是
 * "换一层执行层后静默假绿/静默断链"，所以每条都要一条会在缝坏掉时变红的用例：
 *
 *   P1 {proposal:} 步骤的 operation 名从平台 protocol 列派生（注册名 = 调用唯一依据）。
 *      缝坏症状：命令里的 operation 不被识别层认出 → 提案创建整条断；或换执行层后
 *      继续拿实例名（voucher.proposal）打——两者都靠本用例的审计行证据抓。
 *   P2 fixtureCallCount() 对真执行必须 >0。缝坏症状：计数永远是 0，
 *      "零平台调用"断言退化成 0===0 空跑（原 totalActualCalls 在夹具下正是这样）。
 *   P3 scripted Main 对 tools:[] 的**隔离复核回合**回严格 JSON。缝坏症状：
 *      复核 fail-closed → 提案创建在平台登记之后断掉（用户收到"复核未通过"）。
 *   P6 platformCorrectForm() 从平台 RESULT 信封取 correctForm，缺数响亮失败。
 *      缝坏症状：跨仓读源码文件（换执行层文件不存在）或静默兜底一句错措辞。
 *   P7 ballot.query 经注册名执行（不是被 basename 映射成 dummy.query）。
 *      缝坏症状：读路径"看着有数据"，审计行却记着另一个域的操作（绿得空心）。
 *
 * 每条都走真实装配（真 SQLite、真计划门、真 spawn 网关 CLI、mock 执行器）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boot,
  dummyCalls,
  fixtureAuditRows,
  fixtureCallCount,
  gatedWorker,
  mainDriver,
  operationScripts,
  platformCorrectForm,
  withoutPlatformEnvelope,
} from './harness';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** 活跃执行层是否仓内 dummy 夹具（P1/P2/P3/P6 的语料前提）。 */
const hasDummyOps = operationScripts.has('dummy.query') && operationScripts.has('dummy.proposal');
/** ballot 第二写域（P7）：只有声明它的执行层上才跑。 */
const hasBallotOps = operationScripts.has('ballot.query');

describe('[L4 集成] 共享保真缝锁（P1/P2/P3/P6/P7）', () => {
  describe.skipIf(!hasDummyOps)('dummy 域（P1/P2/P3/P6）', () => {
    it('P2 夹具计数对真执行 >0：零平台调用断言不许再退化成恒零空跑', async () => {
      const before = fixtureCallCount();
      const { send, assembly } = await boot({
        main: mainDriver([{ kind: 'delegate', request: '查询 alpha 的记录' }]),
        worker: gatedWorker([{ plan: dummyCalls('alpha') }, { text: 'alpha 有 2 条记录。' }]),
      });

      const reply = await send('查一下 alpha 的记录');

      expect(withoutPlatformEnvelope(reply)).toContain('2 条记录');
      // 这一条是 P2 的锁：计数必须能"看见"真执行。它红了 = 计数又变成恒 0，
      // resend/repeat-execution/plan-replay 的"零平台调用"断言同时失去检出能力。
      expect(fixtureCallCount(), '夹具计数对真执行必须 >0（否则零调用断言是空跑）').toBeGreaterThan(before);
      expect(
        fixtureAuditRows().some((row) => row['script'] === 'dummy.query' && row['exitCode'] === 0),
        '平台侧审计行缺 dummy.query 成功记录——夹具没被真调到？',
      ).toBe(true);
      await assembly.close();
    });

    it('P1/P3 {proposal:} 经 protocol 派生的注册名创建 + tools:[] 复核回合回 JSON → 提案创建不再 fail-closed', async () => {
      const seen: Array<{ tools: number; systemPrompt?: string }> = [];
      const { send, assembly } = await boot({
        main: mainDriver(
          [{ kind: 'delegate', request: '把这条记录录进 alpha' }],
          (input) => seen.push({ tools: input.tools?.length ?? -1, systemPrompt: input.systemPrompt }),
        ),
        worker: gatedWorker([
          { plan: dummyCalls('alpha') },
          { proposal: { collection: 'alpha', window: 'W1', records: [{ name: 'lock-rec', value: 10 }] } },
        ]),
      });

      const reply = await send('把 lock-rec 录进 alpha 的 W1');

      // 提案创建成功：平台 summaryText 与宿主确认行都在；四类 fail-closed 话术一个都不许出现。
      // （P3 断链时用户看到的正是"提案隔离复核未通过，未发确认码"。）
      expect(reply).toContain('Pending proposal');
      expect(reply).toMatch(/回复「确认 [A-Z0-9]+」/);
      expect(reply).not.toContain('提案隔离复核未通过');
      expect(reply).not.toContain('提案隔离复核未接线');
      expect(reply).not.toContain('平台未下发提案 schema');

      // P1 证据：平台的调用事实落在 dummy.proposal 注册名下（protocol 列派生的那个名字）。
      // 硬编码 voucher.proposal 时 parseProposalCommand 认不出命令，本用例直接在
      // "提案创建命令没有被识别层认出"上红；识别层空表时同样红。
      const proposalRows = fixtureAuditRows().filter(
        (row) => row['script'] === 'dummy.proposal' && row['protocol'] === 'proposal.create',
      );
      expect(proposalRows.length, '提案创建没有落在 dummy.proposal 注册名下（P1 派生断了？）').toBeGreaterThan(0);
      expect(proposalRows.some((row) => row['exitCode'] === 0), '提案创建调用没有成功收口').toBe(true);

      // P3 证据：tools:[] 的复核回合确实被驱动消费过（隔离复核提示词），不是被当成
      // "续跑整理"回合顺手放过。
      expect(
        seen.some((s) => s.tools === 0 && (s.systemPrompt ?? '').includes('isolated proposal reviewer')),
        'tools:[] 复核回合没有被表驱动观察到——P3 缝没被本用例覆盖',
      ).toBe(true);

      // 宿主侧事实：待确认意图在册（提案创建成功的另一半证据在 store，不在回复文本里）
      const pending = await assembly.store.changeIntents!.findPendingBySession('wecom:e2e_user', 'wecom:e2e_user');
      expect(pending?.proposalId, '提案创建成功但待确认意图不在册').toBeTruthy();
      await assembly.close();
    });

    it('P6 correctForm 从平台信封取数；无信封/码不符即响亮失败（不静默兜底）', () => {
      const probe = { mode: 'query' as const, operation: 'dummy.query', args: ['--collection', '__no_such_collection__'] };

      const form = platformCorrectForm('COLLECTION_NOT_FOUND', probe);
      expect(typeof form).toBe('string');
      expect(form.length).toBeGreaterThan(0);

      // 取数真的发生了平台调用：审计行里有一条 dummy.query 的 not_found 结果。
      expect(
        fixtureAuditRows().some((row) => {
          const result = row['result'] as { status?: unknown } | undefined;
          return row['script'] === 'dummy.query' && result?.status === 'not_found';
        }),
        'correctForm 取数没有留下平台调用痕迹（探针没真跑？）',
      ).toBe(true);

      // 缺数即失败（两条负路都不许静默兜底）：
      expect(() => platformCorrectForm('COLLECTION_LOCKED', probe), '请求的码与信封不符时必须抛').toThrow(/信封码不符/);
      expect(
        () => platformCorrectForm('COLLECTION_NOT_FOUND', { mode: 'query', operation: 'dummy.not-registered', args: [] }),
        '探针拿不到 RESULT 信封时必须抛',
      ).toThrow(/未返回 RESULT 信封/);

      // P6 缝的机械面：harness 不再跨仓读平台源码文件（旧实现读 error-codes.js）。
      const harnessSrc = readFileSync(path.join(REPO_ROOT, 'tests', 'e2e', 'harness.ts'), 'utf8');
      expect(harnessSrc, 'harness 里仍有跨仓读平台错误码文件的痕迹（P6 回退？）').not.toContain(`'src', 'lib', 'error-codes.js'`);
    });
  });

  describe.skipIf(!hasBallotOps)('ballot 域（P7）', () => {
    it('P7 ballot.query 经注册名执行：审计行的 script 是 ballot.query，不是 dummy.query', async () => {
      const { send, assembly } = await boot({
        main: mainDriver([{ kind: 'delegate', request: '查询 ballot topic alpha 的记录' }]),
        worker: gatedWorker([
          { plan: [{ operation: 'ballot.query', args: ['--topic', 'alpha'] }] },
          { text: 'ballot topic alpha 有 2 条记录。' },
        ]),
      });

      const reply = await send('查询 ballot topic alpha 的记录');
      expect(withoutPlatformEnvelope(reply)).toContain('2 条记录');

      const rows = fixtureAuditRows();
      const executed = rows.filter((row) => row['script'] === 'ballot.query' && row['exitCode'] === 0);
      expect(executed.length, 'ballot.query 没有以注册名执行（审计行缺 script=ballot.query 的成功记录）').toBeGreaterThan(0);
      expect(
        rows.some((row) => row['script'] === 'dummy.query'),
        'ballot 调用被 basename 映射成了 dummy.query（跨域执行，数据对但域错）',
      ).toBe(false);
      await assembly.close();
    });
  });
});
