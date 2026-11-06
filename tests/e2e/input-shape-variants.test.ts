// [L4 集成] fshine + example-gateway 一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：输入形状多样性——口语/标点/空白/长度/语气/错字变体不得改变确定性机器的判定。
 * 共享替身见 ./harness.ts（真 SQLite、真 bin/example-gateway 计划门、mock 执行器）。
 *
 * 为什么要有这张离线网：既有 turn-loop 用例的用户消息全是规整财务查询句，而真实企微输入
 * 是口语、全角标点、脏空白、超长铺垫、表情和错字。三个锚场景背后各有一台确定性机器：
 *   · 追问（turn-loop-routing 1.6）：申报 conversation → 模型文本即回复，零平台调用；
 *   · 重查（turn-loop-execution 1.3/5.4）：重复实时数据问题必须产生本轮真实执行；
 *   · 澄清（turn-loop-clarification C1）：结构化歧义 → 宿主机械组装澄清 → 编号机械绑定 → 落地。
 * 本文件把三个锚的驱动脚本原样照抄，只变用户消息文本，钉住"实体周围的填充物形状不改变判定"。
 *
 * 范围诚实声明：申报路由"选 conversation 还是 delegate"由脚本化 mainDriver 钉死，离线网
 * 压的是宿主与门禁这一侧的确定性（适配器、出口校验、计划实体门、澄清组装与绑定、调用计数
 * 都吃真实消息文本）；真实模型把口语听错方向属于模型能力，不在这张网的射程内。
 *
 * 实体门约束（turn-contract.ts 的 validatePlanEntities，逐字包含判定）：带实体的变体只动
 * 实体周围的填充物——账套名「幻辰财税」与期间「202606」保持原样子串；口语、标点、空白、
 * 语气词、表情与错字全部落在填充物上。"应收帐款"（帐 vs 账）是**非实体词**错字：它不出现在
 * 计划参数里，不影响逐字判定，但对上游实体提取是同形状压力。
 *
 * 澄清/消歧的**选择步**不变体（turn-loop-disambiguation 9.2 的口径）：编号回复是宿主机械
 * 绑定、非编号回复按新请求处理——绑定判定不看文本形状，给"1"做变体没有意义。
 *
 * 门禁开关的取舍：重查锚的变体问句带着计划的全部参数（账套+期间），显式开启实体门禁复刻
 * （gatedWorker 的 enforceEntityScope，与 turn-loop-session-entities 同口径）——让逐字包含
 * 判定在真实门禁下过一遍，填充物形状不得造成误拒。追问锚没有计划可判；澄清锚的初始计划带
 * 消息里没有的期间 202609（照抄原锚 C1），开四来源门禁必拒，因此与原锚一致不开启。
 */
import { describe, expect, it } from 'vitest';
import { executionLanguageFingerprints } from '../../packages/agent/src/runtime';
import { clarificationTextFor } from '../../packages/agent/src/error-codes';
import {
  balanceCalls,
  boot,
  gatedWorker,
  mainDriver,
  totalActualCalls,
  withoutPlatformEnvelope,
  type WorkerStep,
} from './harness';

// ── 变体表（模块级常量；每条一句话说明它代表的真实输入形态）─────────────────

/**
 * 重查锚变体：第二回合重问同一件事的问法。实体子串（幻辰财税 / 202606）逐字保留，
 * 只变实体周围的填充物。
 */
const BALANCE_VARIANTS: Array<{ shape: string; message: string }> = [
  // 口语化：连写不带空格、句尾语气词"哈"——手机上最常见的随手一句话
  { shape: '口语化', message: '帮我看下幻辰财税202606的应收余额哈' },
  // 全角标点+全角引号：账套名被“”包住、全角句号收尾——输入法自动配对标点的形状
  { shape: '全角标点与引号', message: '查一下“幻辰财税”202606 的应收账款。' },
  // 首尾空白与连续空格：复制粘贴带来的脏空白，实体前后都有多余空格
  { shape: '首尾与连续空白', message: '   帮我查下  幻辰财税  202606 的应收账款余额   ' },
  // 超长铺垫句：实体埋在 40+ 字的叙述里——用户先把背景讲完才说到需求
  {
    shape: '超长铺垫句',
    message: '这个事情我拖了快两个星期了实在不好意思，刚才开完会老板又问起这个数，麻烦帮我看看幻辰财税 202606 的应收账款余额还有多少，先谢谢啦。',
  },
  // 语气词/表情：动词换成"瞅瞅"、句尾带 emoji——消息软件里的闲聊语气
  { shape: '语气词与表情', message: '幻辰财税 202606 的应收账款 帮我瞅瞅 🙂' },
  // 非实体词错字："应收帐款"（帐 vs 账）——错字落在非实体词上，实体子串原样
  { shape: '非实体词错字', message: '帮我查一下幻辰财税 202606 的应收帐款' },
];

/** 追问锚变体：不带账套的实时余额问法。只动问法，不引入任何账套名。 */
const FOLLOWUP_VARIANTS: Array<{ shape: string; message: string }> = [
  // 口语化短句：零铺垫零敬语，直接一个问句
  { shape: '口语化短句', message: '现在应收是多少呢' },
  // 礼貌铺垫+全角逗号：客气话说在前面的形状
  { shape: '礼貌铺垫与全角逗号', message: '帮我看看当前的应收账款余额，谢谢' },
  // 方言口语+全角问号："啥情况"式的模糊问法
  { shape: '方言口语与全角问号', message: '余额现在啥情况？' },
];

/** 澄清锚变体：歧义简称「幻辰」逐字保留（mock 对它返回 ACCOUNT_SET_AMBIGUOUS），只变填充物。 */
const CLARIFY_VARIANTS: Array<{ shape: string; message: string }> = [
  // 口语化：动词口语化（查下）、宾语省略成"应收"
  { shape: '口语化', message: '帮我查下幻辰的应收' },
  // 实体前置+全角问号：实体开头、闲聊式问法
  { shape: '实体前置与全角问号', message: '幻辰的应收账款怎么样？' },
];

// ── 照抄锚场景的公共夹具 ────────────────────────────────────────────────

/** 事故里的技术报告（同 turn-loop-clarification）：执行语言指纹齐全，宿主必须拦下不上屏。 */
const TECH_REPORT = '平台返回 ACCOUNT_SET_AMBIGUOUS，candidates: [幻辰财税, 幻辰实业有限公司]；依据 src/finance/scripts/query-receivables.js 的门的规则，实体参数必须逐字来自用户消息。';

/** 「幻辰」在 mock 目录里命中两个账套：平台返回的选择类候选（只列平台给的）。 */
const QIANLONG_CLARIFICATION = { code: 'ACCOUNT_SET_AMBIGUOUS', query: '幻辰', candidates: ['幻辰财税', '幻辰实业有限公司'] };
const EXPECTED_QUESTION = clarificationTextFor(QIANLONG_CLARIFICATION.code, QIANLONG_CLARIFICATION);

/** 记录 worker 实际收到的委派请求（宿主透传 intent.request，不做二次加工）。写法同原锚。 */
function recordingWorker(script: WorkerStep[]) {
  const inner = gatedWorker(script);
  const requests: string[] = [];
  return {
    requests,
    driver: {
      run: async (input: { sessionId?: string; messages: Array<{ role: string; content: string }> }) => {
        requests.push(String(input.messages.at(-1)?.content ?? ''));
        return inner.run(input as never);
      },
    },
  };
}

describe('[L4 集成] 离线全链 e2e：输入形状变体不改变确定性机器的判定', () => {
  describe('[L4 集成] 追问锚（照抄 turn-loop-routing 1.6）：不带账套的实时余额问题先追问', () => {
    for (const variant of FOLLOWUP_VARIANTS) {
      it(`1.6 变体[${variant.shape}]「${variant.message}」→ 仍追问账套，零平台调用`, async () => {
        const before = totalActualCalls();
        const { send, sdk, assembly } = await boot({
          // 澄清能力边界时申报 conversation，模型文本即回复（与原锚同一份驱动脚本）
          main: mainDriver([{ kind: 'conversation', text: '要查哪个账套？' }]),
          worker: gatedWorker([{ text: '不应执行' }]),
        });
        const reply = await send(variant.message);
        expect(reply).toContain('账套');
        expect(sdk.noticeTexts()).toHaveLength(0);
        expect(totalActualCalls()).toBe(before);
        await assembly.close();
      });
    }
  });

  describe('[L4 集成] 重查锚（照抄 turn-loop-execution 1.3/5.4）：变体句重问仍必须重查（实体门禁开启）', () => {
    // 每个变体一个用例：第一回合规整句（对照组，兼作表征基线），第二回合变体句重问。
    // 变体表 6 种形态全量过锚——重查锚是三锚里唯一"消息携带全部计划参数"的，
    // 逐字包含判定的形状敏感性只有在这里能被真门禁压到。
    for (const variant of BALANCE_VARIANTS) {
      it(`1.3/5.4 变体[${variant.shape}]：规整句首查后，变体句重问仍重查（两回合各 +1 次真实调用）`, async () => {
        const before = totalActualCalls();
        const worker = gatedWorker([
          // 202606 在 mock 里有真实余额键（seed.json：幻辰财税 1122 → 61000）
          { plan: balanceCalls('幻辰财税', '202606') },
          { text: '幻辰财税 202606 应收账款余额为 61000 元。' },
          // 分段点：第一回合到此收手，剩下的步骤留给重问回合
          { end: true },
          { plan: balanceCalls('幻辰财税', '202606') },
          { text: '幻辰财税 202606 应收账款余额为 61000 元。' },
          // 末尾也补一个分段点：替身的循环走到脚本尽头会重读末步，不补会让重问回合的
          // 回复里同一句话重复三遍（C1 原锚没补，靠 toContain 容忍了重复）
          { end: true },
        ], { enforceEntityScope: true });
        const main = () => mainDriver([
          { kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额' },
          { kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额' },
        ]);

        const first = await boot({ main: main(), worker });
        const firstReply = await first.send('查一下幻辰财税 202606 的应收账款余额');
        // 金额断言剥掉替身拼进 worker 文本的平台信封段：'61000 元' 只能来自叙述体，
        // 不能靠信封 JSON 里的数字凑数（比原锚的裸 toContain 更卫生）
        expect(withoutPlatformEnvelope(firstReply)).toContain('61000 元');
        expect(firstReply).not.toContain('不应外发');
        expect(totalActualCalls()).toBe(before + 1);
        await first.assembly.close();

        // 同一问题换不规整问法重问：仍必须重新查询，不能重放旧答复
        const second = await boot({ main: main(), worker });
        const secondReply = await second.send(variant.message);
        expect(withoutPlatformEnvelope(secondReply)).toContain('61000 元');
        expect(secondReply).not.toContain('不应外发');
        expect(totalActualCalls()).toBe(before + 2);
        await second.assembly.close();
      });
    }
  });

  describe('[L4 集成] 澄清锚（照抄 turn-loop-clarification C1）：变体初始问句 → 澄清 → 编号"1"绑定 → 落地', () => {
    for (const variant of CLARIFY_VARIANTS) {
      it(`C1 变体[${variant.shape}]「${variant.message}」→ 宿主组装澄清 → "1"绑定后真实查询落地`, async () => {
        const before = totalActualCalls();
        const worker = recordingWorker([
          // 真调了平台：mock 对「幻辰」返回 needs_input + ACCOUNT_SET_AMBIGUOUS
          // （exit 0，调用计入执行痕迹）——与原锚同一份驱动脚本
          { plan: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰', '--period', '202609'] }] },
          { text: TECH_REPORT },
          { end: true },
          // 用户选定「幻辰财税」后续跑：唯一候选，本期余额 86,000（mock 真实数据）
          { plan: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }] },
          { text: '幻辰财税本期应收余额为 86,000 元。' },
          // 末尾分段点：同重查锚，防止替身循环重读末步污染回复
          { end: true },
        ]);
        // 只放第一条：歧义回合经 ToolUserError 终止，第二条声明留给下一回合（原锚写法）
        const declarations: Array<Record<string, unknown>> = [
          { kind: 'delegate', request: '查询幻辰的应收账款余额' },
        ];
        const { send, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });

        // ① 变体初始问句撞上同样的歧义：用户看到的仍是宿主机械组装的那一份澄清
        const asked = await send(variant.message);
        expect(asked).toBe(EXPECTED_QUESTION);
        expect(asked).toContain('幻辰财税');
        expect(asked).toContain('幻辰实业有限公司');
        expect(asked).toContain('你要查哪个');
        // 执行语言绝迹：脚本路径 / 错误码 / JSON 片段一个都不能出现
        expect(executionLanguageFingerprints(asked)).toEqual([]);
        expect(asked).not.toContain('src/');
        expect(asked).not.toContain('ACCOUNT_SET_AMBIGUOUS');
        expect(asked).not.toContain('candidates');
        expect(asked).not.toContain('不应外发');
        // 平台确实被触达过（歧义那笔是真实执行，计入痕迹），恰好一次
        expect(totalActualCalls()).toBe(before + 1);

        // ② 选择步不变体（机械绑定）：裸编号"1"由宿主绑到候选「幻辰财税」，真实查询落地
        declarations.push({ kind: 'delegate', request: '查询幻辰财税账套本期的应收账款余额' });
        const done = await send('1');
        expect(withoutPlatformEnvelope(done)).toContain('86,000');
        expect(done).not.toContain('没有找到唯一匹配');
        expect(done).not.toContain('不应外发');
        expect(worker.requests[1]).toContain('幻辰财税');
        expect(totalActualCalls()).toBe(before + 2);
        await assembly.close();
      });
    }
  });
});
