// [L4 集成] fshine + 17dz 一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * harness 保真度绊线（HF = Harness Fidelity）：把 harness.ts 两处"靠人记得换回来"的
 * 假绿风险改成"不一致就红"。只 import harness、不改 harness——两处风险都在共享替身
 * 文件里，替身自己不能当自己的裁判。
 *
 *   ① access 语义表（D-075 写关闭判据的平台数据面）。2026-10-16 起 harness 已从 18 条
 *      手注替身换回 loadOperationSemantics(PLATFORM_ROOT) 平台派生（翻回条件"平台下发
 *      顶层 accessSemantics"实测成立），但"判据变空表/被手注替换"这两条假绿路依然要在
 *      机械上堵死：HF-1 断言派生非空、harness 表与派生逐条一致、确认类锚点在场（含
 *      替身政权时代缺过覆盖的 5 个 voucher 确认类 operation）。任何一条破，写关闭扫描
 *      就在静默地测一把不存在的尺子。
 *   ② withoutPlatformEnvelope 的信封正则是照 gatedWorker 拼接形状写的，而拼接形状的
 *      权威是平台 CLI 的真实输出。平台哪天改了 RESULT 信封格式，正则剥不动，平台的
 *      中文 correctForm 与错误码就会漏进"叙述体"断言——剥不动不等于断言红，是静默的。
 *      这里真 spawn 一次平台 CLI（mock 执行器），钉住真实输出仍长成该正则认得的形状：
 *      漂移当天这里先红，不用等某条叙述体断言碰巧失败。
 *   ③ args 规格表（D-065 结构化事实的取值来源）。planCallFacts 按平台 `operation list
 *      --json` 的 args 声明名机械取值（harness 的 factsFor 与真实驱动同一份），而整个
 *      e2e **没有任何一处断言 planFacts 的取值**——平台哪天改了 args 规格形状，解析
 *      整份退化为空表/空声明，事实链静默退化，所有 e2e 照样绿。这里钉住派生非空 +
 *      锚点 flag（--query/--period）在声明里，形状漂移当天就响。
 *
 * mock 铁律：本文件只经 import harness 拿环境（EXECUTION_EXECUTOR=mock 已在其 beforeAll 钉死，
 * setupFiles 再把运行者环境的泄漏变量抹掉），本文件不设任何 EXECUTION_/FSHINE_ 开关，绝不
 * FSHINE_REAL_COMMIT=1；护栏②的一次 CLI spawn 走 mock 执行器，不开浏览器不触网。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateAndActivatePlan, type PlanCliRunner } from '../../packages/agent/src/plan-runtime';
import { loadOperationArgSpecs, loadOperationSemantics, type AccessSemantics, type OperationArgsSpec } from '../../packages/agent/src/operation-labels';
import { CURRENT_PERIOD, harnessOperationSemantics, PLATFORM_ROOT, withoutPlatformEnvelope } from './harness';

describe('[L4 集成] harness 保真度绊线', () => {
  // ── 护栏①：access 语义表替身 vs 平台派生 ────────────────────────────────

  it('HF-1 语义表必须平台派生、非空、含确认类锚点（空表/手注漂移=写关闭判据失效）', async () => {
    // loadOperationSemantics 对一切失败路径（CLI 不存在/非零退出/输出不是 JSON/平台
    // 没下发该表）都 resolve 空表、从不 reject——catch 只是照 pi-coding-driver 的同一
    // 防御姿态写，不改变行为。
    const derived = await loadOperationSemantics(PLATFORM_ROOT).catch(() => new Map<string, AccessSemantics>());

    // 第一重：平台真表必须非空。2026-10-16 起 harness 的语义表已从 18 条手注替身换回
    // 平台派生（翻回条件"平台下发 accessSemantics"实测成立：53 条、与替身逐条一致）。
    // 派生为空 = 平台把表收了回去或 CLI 输出变形 = 写关闭扫描静默失效（本护栏存在的
    // 原始假绿风险）。harness 模块加载时会同因抛错，这里独立断言给出人话。
    expect(derived.size, '平台 accessSemantics 表为空或派生失败——写关闭扫描（D-075）会静默失效，先和平台对齐').toBeGreaterThan(0);

    // 第二重：harness 的表必须就是平台派生。有人把手注表塞回来（哪怕逐条抄对）都会在
    // 平台下次调 access 列时静默漂移——这里逐条对照，漂一条红一条。
    expect(harnessOperationSemantics.size, 'harness 语义表为空：判据来源不能是空表').toBeGreaterThan(0);
    for (const [name, semantics] of harnessOperationSemantics) {
      expect(
        derived.get(name),
        `harness 语义表[${name}] 与平台派生不一致——语义表必须平台派生，不许手注（假绿风险见 harness.ts operationSemantics 注释）`,
      ).toEqual(semantics);
    }
    expect(harnessOperationSemantics.size, 'harness 语义表条数少于平台派生——派生表有 confirm=true 条目没进判据（2026-10-16 前替身政权缺过 5 个）').toBe(derived.size);

    // 第三重：锚点两头各钉。确认类（写关闭要拦的）与非确认类（不能误拦的）各一个，
    // 外加替身政权时代缺过、翻回后才覆盖的 5 个确认类 operation——钉住缺口不再复发。
    expect(harnessOperationSemantics.get('voucher.commit')?.confirm, '锚点：voucher.commit 必须是确认类（confirm=true）').toBe(true);
    expect(harnessOperationSemantics.get('query-receivables')?.confirm, '锚点：query-receivables 必须是非确认类（confirm=false）').toBe(false);
    for (const former of ['voucher.proposal', 'voucher.fix-summary', 'voucher.gen-from-journal', 'voucher.create-assistant', 'voucher.upload-all']) {
      expect(harnessOperationSemantics.get(former)?.confirm, `锚点：${former} 必须在判据内且是确认类（替身政权时代的覆盖缺口，不许回退）`).toBe(true);
    }
  });

  // ── 护栏②：平台 CLI 真实信封 vs withoutPlatformEnvelope 的剥离正则 ───────

  // 逐字抄自 harness.ts withoutPlatformEnvelope 的行正则（gm 也在内）。抄是刻意的：
  // 这里要能独立于该函数红——平台改了信封格式，或者有人"顺手"把 harness 正则改成
  // 迁就新格式，两条路都必须在人类知情的情况下过这道闸，不许静默。
  const HARNESS_ENVELOPE_LINE = /^执行 \S+: RESULT \{.*\}$/gm;

  // 照抄自 harness.ts 的模块私有 SCRIPTS（导不进来）：finance.query-receivables 对应的
  // 平台脚本文件名。这是平台清单的契约不是 harness 的发明，抄一份只用于本护栏的 spawn。
  const QUERY_RECEIVABLES_SCRIPT = 'query-receivables.js';

  it('HF-2 平台 CLI 真实输出必须仍长成 withoutPlatformEnvelope 认得的信封（信封格式漂移=剥信封静默失效）', async () => {
    // 与 gatedWorker 同一条激活链：先 evaluateAndActivatePlan 一个最小计划（1 个查询调用
    // < EXECUTION_PLAN_AUTO_CALLS=2 → execute 档，真 CLI、真账本）拿 planId，再按 execute 分支的
    // 原样 env 真跑一次网关 query。信封形状全平台只有一个出口（src/lib/envelope.js 的
    // emit），钉住一个 operation 的真实输出即钉住整类。
    const runCli: PlanCliRunner = ({ platformRoot, args, input, env }) => new Promise((resolve, reject) => {
      const child = spawnSync(path.join(platformRoot, 'bin', '17dz'), args, {
        input, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env },
      });
      if (child.error) return reject(child.error);
      resolve({ code: child.status ?? 1, stdout: child.stdout ?? '', stderr: child.stderr ?? '' });
    });
    const activated = await evaluateAndActivatePlan({
      platformRoot: PLATFORM_ROOT,
      taskId: 'hf-envelope-tripwire',
      calls: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', CURRENT_PERIOD] }],
      onNotice: async () => { /* execute 档用不到；notify 档也不为它红，激活链由门禁用例守 */ },
      runCli,
      activationSecret: process.env['EXECUTION_PLAN_ACTIVATION_SECRET'],
    });
    if (activated.status !== 'active') {
      throw new Error(`最小计划没走到 active（status=${activated.status}）：${activated.message}`);
    }

    // gatedWorker execute 分支的原样 spawn：网关形式 + EXECUTION_PLAN_ID/EXECUTION_REQUIRE_PLAN 绑定。
    const out = spawnSync(path.join(PLATFORM_ROOT, 'bin', '17dz'),
      ['query', QUERY_RECEIVABLES_SCRIPT, '--query', '幻辰财税', '--period', CURRENT_PERIOD], {
        encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, EXECUTION_PLAN_ID: activated.planId, EXECUTION_REQUIRE_PLAN: '1' },
      });
    // 先把"执行没起来"和"信封变形"分开：GATE_REFUSE/限流/脚本未声明走的是 stderr 文本，
    // 不出 RESULT 行——那不是本护栏要抓的漂移，混在一起会把人引去改正则。
    expect(out.status, `平台 query 未成功执行（先查门禁/限流，不是信封问题）：stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);

    // 平台半边契约（envelope.js：stdout 末行单行 `RESULT ` + JSON）。真实输出若在末行前
    // 多出人读行，也只认末行——这正是"末行信封"承诺的字面意思。
    const lastLine = (out.stdout ?? '').trim().split('\n').at(-1) ?? '';
    expect(lastLine, '平台 RESULT 信封不再占 stdout 末行单行——信封格式漂了，不要改正则，先和平台对齐').toMatch(/^RESULT \{.*\}$/);

    // 拼接半边契约：gatedWorker 把 stdout 原文拼成 `执行 <op>: <body>` 进 worker 文本，
    // withoutPlatformEnvelope 剥的正是这一行。真实 body 必须让拼接结果仍匹配那个正则、
    // 且被剥到一字不剩——剥不净就是中文 correctForm/错误码漏进叙述体断言的那天。
    const body = (out.stdout ?? '').trim() || (out.stderr ?? '').trim();
    const composed = `执行 finance.query-receivables: ${body}`;
    expect(composed, 'worker 文本里的平台信封行不再匹配 harness 的剥离正则——信封格式漂了，不要改正则，先和平台对齐').toMatch(HARNESS_ENVELOPE_LINE);
    expect(withoutPlatformEnvelope(composed), '真实信封行没被 withoutPlatformEnvelope 剥净').toBe('');

    // 剥离函数自身的最低行为锚（合成样例，与平台无关）：信封整行剥掉，叙述体一字不动。
    expect(withoutPlatformEnvelope('执行 x: RESULT {y}\n正文行')).toBe('正文行');
  });

  // ── 护栏③：args 规格派生 vs D-065 结构化事实链 ────────────────────────────

  it('HF-3 args 规格必须平台派生、非空、锚点 flag 在声明里（形状漂移=结构化事实链静默退化）', async () => {
    // loadOperationArgSpecs 的失败语义与 loadOperationSemantics 同一族：CLI 不存在/非零
    // 退出/输出不是 JSON/顶层形状不认识——一律 resolve 空表、从不 reject。catch 与 HF-1
    // 同因：照 load* 家族的防御姿态写，不改变行为。
    const specs = await loadOperationArgSpecs(PLATFORM_ROOT).catch(
      () => new Map<string, OperationArgsSpec>(),
    );

    // 第一重：规格必须非空。harness 的 factsFor 与真实驱动的 planCallFacts 都吃这份表，
    // 空表 = accountSet/period/label 全部取不到——D-065 结构化事实链静默退化（e2e 零处
    // 断言 planFacts，退化不会让任何用例红，这正是本护栏存在的理由）。
    expect(specs.size, '平台 args 规格为空或派生失败——D-065 结构化事实链（planCallFacts）会静默退化，先和平台对齐').toBeGreaterThan(0);

    // 第二重：锚点两头钉在 e2e 假设最多的那条 operation 上。balanceCalls 全族提交的都是
    // finance.query-receivables + --query/--period；结构化事实的 accountSet/period、
    // PERIOD_NO_DATA 终局话术里"查的是谁、哪一期"，全靠这两个 flag 在规格里有声明名。
    // 键同时收注册名与 command 裸名（parseOperationArgSpecs 的登记规则，两种都合法）。
    const spec = specs.get('finance.query-receivables') ?? specs.get('query-receivables');
    expect(spec, 'args 规格里找不到 finance.query-receivables（注册名与 command 裸名都不在）——e2e 的 balanceCalls 全族失去声明依据').toBeDefined();
    expect(
      spec!.flagStyles.get('--query'),
      '锚点 flag 缺声明：--query 不在 finance.query-receivables 的规格里——事实提取与参数摘要会漏掉查询词',
    ).toBeDefined();
    expect(
      spec!.flagStyles.get('--period'),
      '锚点 flag 缺声明：--period 不在 finance.query-receivables 的规格里——PERIOD_NO_DATA 终局话术与事实里的期间会静默消失',
    ).toBeDefined();
  });
});
