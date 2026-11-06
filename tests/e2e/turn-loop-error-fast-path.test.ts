// [L4 集成] fshine + example-gateway 一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：错误态快路径 v2（2026-10-16 重做；第一版 2026-10-17 凌晨因真模型探针
 * 回归被整波回退）。共享替身见 ./harness.ts。
 *
 * 平台确定性终局码（PERIOD_NO_DATA / 客户辅助核算两态）不再走 worker 重规划循环——
 * 数据不能凭重试变出来，循环只会付每轮约 31s 的模型预算，结局不变。驱动早停 + 宿主
 * 模板话术终结，只对**单调用计划**（整份答案）生效；多调用计划一跳撞终局只是进行中的
 * 一步，照旧循环/交还，行为零变化（见 4 号用例）。
 *
 * 【替身契约镜像 · 第一版翻车点】真实驱动早停后 result.text 是空串，宿主空文本检查
 * 先于一切分支抛"未返回可用结果"、被分类 executor_error——真模型探针 4/4 全数触发，
 * 用户拿到"执行失败请稍后再试"。当时的 e2e 全绿是假绿：替身早停镜像总返回非空 text，
 * 只镜像了 happy path。本文件 5 号用例让替身刻意按第一版的失败形状返回 `text: ''` +
 * 挂 terminalFailure（harness gatedWorker 的 terminalEmptyText 档），钉住宿主侧防线
 * （空文本豁免 + 终局分支）独立成立——皮带（驱动合成非空 text）失手时背带仍要接住。
 *
 * 3 号用例是 AMBIGUOUS 的完整性门 fail-safe：平台 mock 的 AMBIGUOUS 信封只带
 * candidates 不带 data.customer（真脚本带），契约不完整就不快转——绝不拿账套搜索词
 * 冒充客户名渲染"没有找到匹配X的对象"。
 */
import { describe, expect, it } from 'vitest';
import {
  balanceCalls,
  boot,
  gatedWorker,
  mainDriver,
  totalActualCalls,
  withoutPlatformEnvelope,
  type WorkerStep,
} from './harness';

/** PERIOD_NO_DATA 的宿主话术（error-codes 唯一来源渲染；这里逐字钉住）。 */
const PERIOD_NO_DATA_REPLY = '没有查到“幻辰财税”在 202609 的数据。平台上有数据的是：202606、平台当前期间。要改查的话，告诉我查哪一项即可。';
/** 客户两态共用的结构句（无候选、无平台 correctForm 措辞——D-102 语域事故不再犯）。 */
const ASSISTANT_REPLY = '没有找到匹配“猫一杯”的对象。请确认准确名称后我再查。';

/** 记录 worker 被委派的次数（快路径的零第二次委派断言用）。 */
function countingWorker(script: WorkerStep[], options?: { terminalEmptyText?: boolean }) {
  const inner = gatedWorker(script, options);
  let delegations = 0;
  return {
    get delegations() { return delegations; },
    driver: {
      run: async (input: Record<string, unknown>) => {
        delegations += 1;
        return inner.run(input as never);
      },
    },
  };
}

describe('[L4 集成] 离线全链 e2e：错误态快路径 v2', () => {
  it('1. PERIOD_NO_DATA 单调用计划：宿主话术一字不差终结，零第二次委派，平台只调一次', async () => {
    const before = totalActualCalls();
    const worker = countingWorker([
      // 单调用计划查 202609（mock 无此键）→ 收尾信封 PERIOD_NO_DATA → 快路径终结。
      // 后面若再排步骤（重规划/贴文本），快路径失效会当场红。
      { plan: balanceCalls('幻辰财税', '202609') },
      { text: '不应该到达：快路径应在此前终结本跳。' },
    ]);
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查询幻辰财税账套 202609 的应收账款余额' }]),
      worker: worker.driver,
    });

    const done = await send('查一下幻辰财税 202609 的应收账款');

    // 话术一字不差：宿主模板渲染，不经模型翻译
    expect(done).toBe(PERIOD_NO_DATA_REPLY);
    // 卫生断言：无平台码、无 RESULT 信封、无平台 correctForm 措辞（那句话是给解析方的规则）
    expect(done).not.toContain('PERIOD_NO_DATA');
    expect(done).not.toContain('RESULT {');
    expect(done).not.toContain('该期间平台无数据');
    // 零第二次委派 + 平台调用计数：一次委派、一次真实调用，没有重规划循环
    expect(worker.delegations).toBe(1);
    expect(totalActualCalls() - before).toBe(1);
    await assembly.close();
  });

  it('2. ASSISTANT_NOT_FOUND：结构句终结，不渲染平台 correctForm（语域纪律）', async () => {
    const before = totalActualCalls();
    const worker = countingWorker([
      // --customer 指向档案里不存在的客户 → not_found + ASSISTANT_NOT_FOUND
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--customer', '猫一杯', '--period', '202606'] }] },
      { text: '不应该到达：快路径应在此前终结本跳。' },
    ]);
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查幻辰财税账套客户猫一杯 202606 的应收余额' }]),
      worker: worker.driver,
    });

    const done = await send('查一下幻辰财税客户猫一杯的应收余额');

    expect(done).toBe(ASSISTANT_REPLY);
    // 卫生断言：结构句之外无码、无信封、无平台 correctForm（"向用户确认客户规范名后重查；
    // 档案以平台现状为准"是给解析方的规则，渲染它就是 D-102 同款语域事故）
    expect(done).not.toContain('ASSISTANT_NOT_FOUND');
    expect(done).not.toContain('RESULT {');
    expect(done).not.toContain('档案以平台现状为准');
    expect(done).not.toContain('规范名后重查');
    expect(worker.delegations).toBe(1);
    expect(totalActualCalls() - before).toBe(1);
    await assembly.close();
  });

  it('3. ASSISTANT_AMBIGUOUS 完整性门 fail-safe：信封缺 customer 不快转，行为零变化', async () => {
    const before = totalActualCalls();
    const worker = countingWorker([
      // --customer 机电 匹配两个档案 → needs_input + ASSISTANT_AMBIGUOUS。
      // 平台 mock 的该信封只带 candidates 不带 data.customer（真脚本带）→ 完整性门不挂：
      // 不快转、不渲染话术，worker 照旧继续（回既有路径），后续步骤正常发生。
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--customer', '机电', '--period', '202606'] }] },
      { text: 'worker 继续处理：该客户名在档案中匹配到多个候选。' },
    ]);
    const { send, assembly } = await boot({
      main: mainDriver([
        { kind: 'delegate', request: '查幻辰财税账套客户机电 202606 的应收余额' },
        { kind: 'conversation', text: '好的。' },
      ]),
      worker: worker.driver,
    });

    const done = await send('查一下幻辰财税客户机电的应收余额');

    // 快路径没有发声：结构句不在（信封缺 customer，宿主绝不拿账套搜索词冒充客户名），
    // worker 照旧走完本跳——后续步骤的文本到达用户即是"没有早停"的直接证据。
    expect(withoutPlatformEnvelope(done)).not.toContain('没有找到匹配');
    expect(withoutPlatformEnvelope(done)).toContain('worker 继续处理');
    expect(worker.delegations).toBe(1);
    expect(totalActualCalls() - before).toBe(1);
    await assembly.close();
  });

  it('4. 多调用计划一跳撞终局：只是进行中的一步，照旧执行完，行为零变化', async () => {
    const before = totalActualCalls();
    const worker = countingWorker([
      // 逐期扫描（先查无数据的 202609，再查有数据的 202606）：第一跳 PERIOD_NO_DATA
      // 只是进行中的一步——快路径不终结多调用计划，第二跳照常执行。
      { plan: [
        { operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202609'] },
        { operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202606'] },
      ] },
      { text: '幻辰财税 202606 应收余额为 51 元。' },
    ]);
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查询幻辰财税账套近期应收余额' }]),
      worker: worker.driver,
    });

    const done = await send('查一下幻辰财税近两个月的应收');

    // 快路径话术不得出现（它只属于"整份答案"）；两跳都真实执行、汇总照常交付
    expect(done).not.toContain(PERIOD_NO_DATA_REPLY);
    expect(done).toContain('幻辰财税 202606 应收余额为 51 元。');
    expect(done).not.toContain('不应该到达');
    expect(worker.delegations).toBe(1);
    expect(totalActualCalls() - before).toBe(2);
    await assembly.close();
  });

  it('5. 替身空 text 镜像（第一版翻车点）：皮带失手时宿主背带仍把话说全', async () => {
    const before = totalActualCalls();
    // terminalEmptyText 档：替身刻意复现第一版失败形状——早停返回 text: '' + 挂
    // terminalFailure。宿主侧空文本豁免 + 终局分支必须独立接住：用户拿到的仍是
    // 完整话术，而不是"example-gateway 子任务执行失败，请稍后再试。"的 executor 兜底。
    const worker = countingWorker([
      { plan: balanceCalls('幻辰财税', '202609') },
    ], { terminalEmptyText: true });
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查询幻辰财税账套 202609 的应收账款余额' }]),
      worker: worker.driver,
    });

    const done = await send('查一下幻辰财税 202609 的应收账款');

    expect(done).toBe(PERIOD_NO_DATA_REPLY);
    expect(done).not.toContain('执行失败');
    expect(done).not.toContain('未返回可用结果');
    expect(worker.delegations).toBe(1);
    expect(totalActualCalls() - before).toBe(1);
    await assembly.close();
  });
});
