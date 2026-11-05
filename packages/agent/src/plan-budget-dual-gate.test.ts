import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET_THRESHOLDS, decideBudgetTier } from './budget-policy';
import { evaluateAndActivatePlan } from './plan-runtime';
import type { PlanCliRunner, PlanEvaluation } from './plan-runtime';

/**
 * W4 表征 golden（双门叠加语义）+ 两个宿主叠加档现状不对称性钉子 + dummy
 * 第三副本守卫。本文件落在未改任何生产代码的 W4 起点 commit 上：后续
 * commit 断言一条不改；登记项（见「宿主叠加档现状不对称性」组）修复落地时
 * 本文件先红、随修同 commit 翻转——红即归因，不另找证据。
 *
 * 双门判据一致的书面对应关系（中性表述，机械侧证据由跨仓 parity 与本文件
 * dummy 守卫承担）：执行层 decision() 的同形实现 = 宿主 decideBudgetTier，
 * 两者判据向量一致——
 *   · calls/seconds 四线（auto/notify/confirm/hard）全部严格大于（>）；
 *   · weight 四线中 budget 线为大于等于（>=），其余三条严格大于（>）；
 *   · 档位 rank（execute 0 / notify 1 / confirm 2 / stop 3）更严取胜，
 *     同档 tie-break 取 calls/seconds 线的 reasonCode；
 *   · grantLevel 扩容以 scale = 1 + grantLevel 对三条线全部阈值同乘；
 *   · previous 只改 reasonCode 措辞（SCOPE_EXPANSION / INITIAL_SCOPE_THRESHOLD），
 *     不改档位。
 *
 * 本文件全文零执行层实例名；不断言任何含网关名的 CLI 失败文案（身份参数化
 * 波次会改它，防跨波耦合）。本文件不起 driver harness：宿主叠加档用例经
 * 注入 PlanCliRunner 走 evaluateAndActivatePlan 公开路径。
 */

const ROOT = join(__dirname, '..', '..', '..');
const DUMMY_CJS = join(ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform', 'bin', 'dummy.cjs');

/** 从源码中切出 [startMarker, endMarker) 片段；两个锚点缺失都算红（夹具漂移即失败，不静默跳过）。 */
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `夹具缺少片段起点 ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `夹具缺少片段终点 ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('decideBudgetTier：calls 线四阈值边界（执行层 decision() 同形：严格大于）', () => {
  it('autoCalls=2：恰等不升档（execute），超 1 进 auto 线（notify / INITIAL_SCOPE_THRESHOLD）', () => {
    // 同形对应：calls > autoCalls * scale 才出线，2 不出、3 出。
    expect(decideBudgetTier({ calls: 2, seconds: 0, weight: 0 })).toEqual({ tier: 'execute', reasonCode: 'WITHIN_AUTO_THRESHOLD' });
    expect(decideBudgetTier({ calls: 3, seconds: 0, weight: 0 })).toEqual({ tier: 'notify', reasonCode: 'INITIAL_SCOPE_THRESHOLD' });
  });
  it('notifyCalls=10：恰等仍是 auto 线措辞，11 才换 NOTIFY_THRESHOLD（档同措辞变，钉 > 语义）', () => {
    // 同形对应：notify 线严格大于；恰等值 10 留在 auto 线理由上。
    expect(decideBudgetTier({ calls: 10, seconds: 0, weight: 0 })).toEqual({ tier: 'notify', reasonCode: 'INITIAL_SCOPE_THRESHOLD' });
    expect(decideBudgetTier({ calls: 11, seconds: 0, weight: 0 })).toEqual({ tier: 'notify', reasonCode: 'NOTIFY_THRESHOLD' });
  });
  it('confirmCalls=20：恰等是 notify，21 升 confirm', () => {
    // 同形对应：confirm 线严格大于。
    expect(decideBudgetTier({ calls: 20, seconds: 0, weight: 0 })).toEqual({ tier: 'notify', reasonCode: 'NOTIFY_THRESHOLD' });
    expect(decideBudgetTier({ calls: 21, seconds: 0, weight: 0 })).toEqual({ tier: 'confirm', reasonCode: 'CONFIRM_THRESHOLD' });
  });
  it('hardCalls=50：恰等是 confirm，51 升 stop（HARD_LIMIT）', () => {
    // 同形对应：hard 线严格大于，51 > 50 才停。
    expect(decideBudgetTier({ calls: 50, seconds: 0, weight: 0 })).toEqual({ tier: 'confirm', reasonCode: 'CONFIRM_THRESHOLD' });
    expect(decideBudgetTier({ calls: 51, seconds: 0, weight: 0 })).toEqual({ tier: 'stop', reasonCode: 'HARD_LIMIT' });
  });
});

describe('decideBudgetTier：seconds 线四阈值边界（执行层 decision() 同形：严格大于）', () => {
  it('autoSeconds=60：恰等 execute，61 进 auto 线', () => {
    // 同形对应：seconds 与 calls 共用同一组阈值线与同一严格大于语义。
    expect(decideBudgetTier({ calls: 0, seconds: 60, weight: 0 })).toEqual({ tier: 'execute', reasonCode: 'WITHIN_AUTO_THRESHOLD' });
    expect(decideBudgetTier({ calls: 0, seconds: 61, weight: 0 })).toEqual({ tier: 'notify', reasonCode: 'INITIAL_SCOPE_THRESHOLD' });
  });
  it('notifySeconds=180：恰等留 auto 线措辞，181 换 NOTIFY_THRESHOLD', () => {
    expect(decideBudgetTier({ calls: 0, seconds: 180, weight: 0 })).toEqual({ tier: 'notify', reasonCode: 'INITIAL_SCOPE_THRESHOLD' });
    expect(decideBudgetTier({ calls: 0, seconds: 181, weight: 0 })).toEqual({ tier: 'notify', reasonCode: 'NOTIFY_THRESHOLD' });
  });
  it('confirmSeconds=600：恰等 notify，601 升 confirm', () => {
    expect(decideBudgetTier({ calls: 0, seconds: 600, weight: 0 })).toEqual({ tier: 'notify', reasonCode: 'NOTIFY_THRESHOLD' });
    expect(decideBudgetTier({ calls: 0, seconds: 601, weight: 0 })).toEqual({ tier: 'confirm', reasonCode: 'CONFIRM_THRESHOLD' });
  });
  it('hardSeconds=1800：恰等 confirm，1801 升 stop', () => {
    expect(decideBudgetTier({ calls: 0, seconds: 1800, weight: 0 })).toEqual({ tier: 'confirm', reasonCode: 'CONFIRM_THRESHOLD' });
    expect(decideBudgetTier({ calls: 0, seconds: 1801, weight: 0 })).toEqual({ tier: 'stop', reasonCode: 'HARD_LIMIT' });
  });
});

describe('decideBudgetTier：weight 线四阈值边界（执行层 decision() 同形：budget 线 >=，其余 >）', () => {
  it('autoWeight=6：恰等 execute，7 进 auto 线', () => {
    // 同形对应：weight auto 线严格大于。
    expect(decideBudgetTier({ calls: 0, seconds: 0, weight: 6 })).toEqual({ tier: 'execute', reasonCode: 'WITHIN_AUTO_THRESHOLD' });
    expect(decideBudgetTier({ calls: 0, seconds: 0, weight: 7 })).toEqual({ tier: 'notify', reasonCode: 'INITIAL_SCOPE_THRESHOLD' });
  });
  it('notifyWeight=18：恰等留 auto 线措辞，19 换 NOTIFY_THRESHOLD', () => {
    expect(decideBudgetTier({ calls: 0, seconds: 0, weight: 18 })).toEqual({ tier: 'notify', reasonCode: 'INITIAL_SCOPE_THRESHOLD' });
    expect(decideBudgetTier({ calls: 0, seconds: 0, weight: 19 })).toEqual({ tier: 'notify', reasonCode: 'NOTIFY_THRESHOLD' });
  });
  it('budgetWeight=60：59 只有 notify，恰等 60 即 confirm（>= 语义，两方向都是事故面）', () => {
    // 同形对应：budget 线是 weight 族唯一的 >=（59 不出线、60 出线）。
    expect(decideBudgetTier({ calls: 0, seconds: 0, weight: 59 })).toEqual({ tier: 'notify', reasonCode: 'NOTIFY_THRESHOLD' });
    expect(decideBudgetTier({ calls: 0, seconds: 0, weight: 60 })).toEqual({ tier: 'confirm', reasonCode: 'BUDGET_WEIGHT' });
  });
  it('hardWeight=180：恰等退回 budget 线 confirm，181 才 stop（HARD_WEIGHT）', () => {
    // 同形对应：hard weight 线严格大于，恰等值 180 由下一道 >= 线接住。
    expect(decideBudgetTier({ calls: 0, seconds: 0, weight: 180 })).toEqual({ tier: 'confirm', reasonCode: 'BUDGET_WEIGHT' });
    expect(decideBudgetTier({ calls: 0, seconds: 0, weight: 181 })).toEqual({ tier: 'stop', reasonCode: 'HARD_WEIGHT' });
  });
});

describe('decideBudgetTier：grantLevel 扩容 scale 三线同乘（执行层 decision() 同形：scale = 1 + grantLevel）', () => {
  it('calls 线：grantLevel=1 时 51 不再 stop（confirm 线接住），101 才 stop', () => {
    // 同形对应：阈值 ×2 后 hard=100、confirm=40；缺省阈值下 51 是 stop，扩容后降档。
    expect(decideBudgetTier({ calls: 51, seconds: 0, weight: 0, grantLevel: 1 })).toEqual({ tier: 'confirm', reasonCode: 'CONFIRM_THRESHOLD' });
    expect(decideBudgetTier({ calls: 101, seconds: 0, weight: 0, grantLevel: 1 })).toEqual({ tier: 'stop', reasonCode: 'HARD_LIMIT' });
  });
  it('seconds 线：grantLevel=1 时 1801 不再 stop，3601 才 stop', () => {
    expect(decideBudgetTier({ calls: 0, seconds: 1801, weight: 0, grantLevel: 1 })).toEqual({ tier: 'confirm', reasonCode: 'CONFIRM_THRESHOLD' });
    expect(decideBudgetTier({ calls: 0, seconds: 3601, weight: 0, grantLevel: 1 })).toEqual({ tier: 'stop', reasonCode: 'HARD_LIMIT' });
  });
  it('weight 线：grantLevel=1 时 181 不再 stop（budget 线接住），361 才 stop', () => {
    // 同形对应：weight 线也乘同一 scale（hard 360 / budget 120）。
    expect(decideBudgetTier({ calls: 0, seconds: 0, weight: 181, grantLevel: 1 })).toEqual({ tier: 'confirm', reasonCode: 'BUDGET_WEIGHT' });
    expect(decideBudgetTier({ calls: 0, seconds: 0, weight: 361, grantLevel: 1 })).toEqual({ tier: 'stop', reasonCode: 'HARD_WEIGHT' });
  });
});

describe('decideBudgetTier：同档 tie-break 与 previous 措辞（执行层 decision() 同形：同档取 calls/seconds 线）', () => {
  it('两线同档时恒取 calls/seconds 线理由（双向构造）', () => {
    // 同形对应：rank 相等时 weight 线不覆盖 calls/seconds 线——旧调用方认的词汇不因权重线改口。
    // calls=15（notify 线）+ weight=7（auto 线，previous=true）→ NOTIFY_THRESHOLD 而非 SCOPE_EXPANSION。
    expect(decideBudgetTier({ calls: 15, seconds: 0, weight: 7, previous: true })).toEqual({ tier: 'notify', reasonCode: 'NOTIFY_THRESHOLD' });
    // 反向：calls=3（auto 线）+ weight=25（notify 线）→ 仍取 calls/seconds 线的 SCOPE_EXPANSION。
    expect(decideBudgetTier({ calls: 3, seconds: 0, weight: 25, previous: true })).toEqual({ tier: 'notify', reasonCode: 'SCOPE_EXPANSION' });
  });
  it('weight 线更严时 weight 理由胜（rank 严格更高才覆盖）', () => {
    // 同形对应：calls 线 execute + weight 线 notify → notify / NOTIFY_THRESHOLD。
    expect(decideBudgetTier({ calls: 1, seconds: 0, weight: 25 })).toEqual({ tier: 'notify', reasonCode: 'NOTIFY_THRESHOLD' });
  });
  it('previous 只改措辞不改档：同输入仅 reasonCode 在 SCOPE_EXPANSION / INITIAL_SCOPE_THRESHOLD 间切换', () => {
    // 同形对应：previous 出现在 auto 线与 weight auto 线的措辞三元，不影响 tier。
    expect(decideBudgetTier({ calls: 3, seconds: 0, weight: 0 })).toEqual({ tier: 'notify', reasonCode: 'INITIAL_SCOPE_THRESHOLD' });
    expect(decideBudgetTier({ calls: 3, seconds: 0, weight: 0, previous: true })).toEqual({ tier: 'notify', reasonCode: 'SCOPE_EXPANSION' });
  });
});

/** validateCalls（plan-runtime.ts:166）要求至少一个操作：给最小合法 calls，operation 名任意（fake runner 不看它）。 */
const MINIMAL_CALLS = [{ operation: 'noop', args: [] }];

/** 造一份执行层 plan evaluate 的 stdout（合法四档 decision + estimate 三元组）。 */
function platformEvaluationJson(overrides: Partial<PlanEvaluation> = {}): string {
  const base: PlanEvaluation = {
    planId: 'plan-golden-1',
    version: 1,
    decision: 'execute',
    estimate: { calls: 0, seconds: 0, weight: 0 },
    delta: {},
    cumulative: {},
    reasonCode: 'WITHIN_AUTO_THRESHOLD',
    status: 'evaluated',
  };
  return JSON.stringify({ ...base, ...overrides });
}

/** 注入式假 CLI runner（不起 driver harness）：evaluate 请求回给定裁决，其余（activate）回成功 JSON。 */
function fakePlanRunner(evaluateStdout: string): PlanCliRunner {
  return async (request) => {
    if (request.args[1] === 'evaluate') return { code: 0, stdout: evaluateStdout, stderr: '' };
    return { code: 0, stdout: '{"ok":true}', stderr: '' };
  };
}

describe('宿主叠加档现状不对称性（plan-runtime 叠加调用只传 calls/seconds/weight）', () => {
  it('现状钉子①：扩容档（grantLevel）不可达宿主叠加档——执行层已按扩容后容量放行，宿主仍按缺省阈值裁 stop', async () => {
    // 这是登记项（宿主叠加档不认扩容后的生效容量，误拦方向），修法落地时本文件先红。
    // 同形对照：decision() 的同形实现在 grantLevel=1 下对 weight=181 裁 confirm（181 >= 120）；
    // 当前叠加调用 decideBudgetTier({ calls, seconds, weight })（plan-runtime.ts:186）没有
    // grantLevel 槽位，181 > 180 直接 stop——比执行层门更严（收紧方向），但拦下的是
    // 用户已授权扩容后的合法重计划。
    const result = await evaluateAndActivatePlan({
      platformRoot: '/tmp/fshine-golden-root',
      taskId: 'task-golden-grant',
      calls: MINIMAL_CALLS,
      runCli: fakePlanRunner(platformEvaluationJson({ decision: 'execute', estimate: { calls: 0, seconds: 0, weight: 181 } })),
    });
    if (result.status !== 'stop') throw new Error(`期望现状 stop，实际 ${result.status}`);
    expect(result.evaluation.decision).toBe('stop');
    expect(result.evaluation.reasonCode).toBe('HARD_WEIGHT');
  });

  it('现状钉子②：previous 不可达宿主叠加档——重计划场景 reasonCode 恒为 INITIAL_SCOPE_THRESHOLD（措辞漂移）', async () => {
    // 这是登记项（措辞漂移，低危），修法落地时本文件先红。
    // 同形对照：decision() 的同形实现在 previous=true 时 auto 线出 SCOPE_EXPANSION；
    // 当前叠加调用缺 previous 槽位，只要有历史计划也会报「首次范围」措辞。
    const result = await evaluateAndActivatePlan({
      platformRoot: '/tmp/fshine-golden-root',
      taskId: 'task-golden-previous',
      calls: MINIMAL_CALLS,
      activationSecret: 'golden-test-secret',
      onNotice: async () => {},
      runCli: fakePlanRunner(platformEvaluationJson({ decision: 'execute', estimate: { calls: 5, seconds: 0, weight: 0 } })),
    });
    if (result.status !== 'active') throw new Error(`期望 active，实际 ${result.status}`);
    expect(result.evaluation.decision).toBe('notify');
    expect(result.evaluation.reasonCode).toBe('INITIAL_SCOPE_THRESHOLD');
  });

  it('叠加只收紧不放宽：执行层 stop 保住，宿主更宽档不覆盖（平台档始终保留作防线）', async () => {
    // 同形对应：rank 更严取胜；宿主叠加实现为「宿主档 rank 严格更高才覆盖」。
    // 执行层已裁 stop（estimate 全零时宿主只会裁 execute），最终仍 stop 且理由保持执行层措辞。
    const result = await evaluateAndActivatePlan({
      platformRoot: '/tmp/fshine-golden-root',
      taskId: 'task-golden-overlay',
      calls: MINIMAL_CALLS,
      runCli: fakePlanRunner(platformEvaluationJson({ decision: 'stop', reasonCode: 'HARD_LIMIT', estimate: { calls: 0, seconds: 0, weight: 0 } })),
    });
    if (result.status !== 'stop') throw new Error(`期望 stop，实际 ${result.status}`);
    expect(result.evaluation.decision).toBe('stop');
    expect(result.evaluation.reasonCode).toBe('HARD_LIMIT');
  });
});

describe('dummy 参考实例第三副本守卫（受测通用执行层：policy/decision 与协议缺省分叉必须红）', () => {
  it('planPolicy() 12 个缺省值与 DEFAULT_BUDGET_THRESHOLDS 逐键相等（多键/缺键/改值都红）', () => {
    // dummy 是 generic-mock 预算链的受测通用执行层参考实例：其缺省值是协议缺省的
    // 第三份同形副本，与宿主 DEFAULT_BUDGET_THRESHOLDS 必须逐键一致；改任一侧
    // 不同批改另一侧时本守卫红，不许静默分叉。
    const source = readFileSync(DUMMY_CJS, 'utf8');
    const policyBody = sliceBetween(source, 'function planPolicy()', 'function planDecision');
    const parsed = new Map<string, number>();
    for (const match of policyBody.matchAll(/([A-Za-z]+): num\('[^']+', (\d+)\)/g)) {
      const key = match[1];
      const value = match[2];
      if (!key || !value) throw new Error(`planPolicy 缺省解析失败：${match[0]}`);
      parsed.set(key, Number(value));
    }
    const expected = new Map(Object.entries(DEFAULT_BUDGET_THRESHOLDS));
    expect([...parsed.keys()].sort(), 'dummy planPolicy 键集应与协议缺省 12 键一致').toEqual([...expected.keys()].sort());
    for (const [key, value] of expected) expect(parsed.get(key), `dummy planPolicy 缺省 ${key}`).toBe(value);
  });

  it('planDecision() 算子骨架与 decideBudgetTier 同形（budget 线 >=、hard 线 >、rank 取严、scale 三线同乘、previous 只改措辞）', () => {
    // 算子骨架锁：dummy decision 的分支形状与宿主 decideBudgetTier 一一对应；
    // 改任一侧算子（>= 换 >、rank 方向反、scale 漏乘、previous 改档位）即红。
    const source = readFileSync(DUMMY_CJS, 'utf8');
    const body = sliceBetween(source, 'function planDecision(', 'function readStdin');
    // budget weight 线是 >=（恰等升 confirm）。
    expect(body).toMatch(/weight >= p\.budgetWeight \* scale\)/);
    // hard 线（calls 与 weight）是严格 >（恰等不升 stop）。
    expect(body).toMatch(/calls > p\.hardCalls \* scale/);
    expect(body).toMatch(/weight > p\.hardWeight \* scale\)/);
    // scale 来源与同乘：calls/seconds/weight 全部 12 条阈值线都乘 scale。
    expect(body).toMatch(/const scale = 1 \+ \(grantLevel \|\| 0\)/);
    expect((body.match(/\* scale/g) ?? []).length, '12 条阈值线应全部乘 scale').toBe(12);
    // rank 更严取胜；同档保持 calls/seconds 线结果（tie-break 同形）。
    expect(body).toMatch(/rank\[wt\] > rank\[tier\] \? \[wt, wr\] : \[tier, reason\]/);
    // previous 只出现在两处措辞三元（calls auto 线与 weight auto 线），不改档位。
    expect((body.match(/(?:reason|wr) = previous \? 'SCOPE_EXPANSION' : 'INITIAL_SCOPE_THRESHOLD'/g) ?? []).length, 'previous 措辞三元应恰两处（calls auto 线 reason、weight auto 线 wr）').toBe(2);
    // dummy 夹具是紧凑单行风格（tier 赋值与措辞三元同物理行），语句级锁代替按行锁：
    // tier 赋值语句（到分号为止）内不得出现 previous。
    expect(body, 'tier 赋值语句不得依赖 previous').not.toMatch(/tier = [^;]*previous/);
  });
});
