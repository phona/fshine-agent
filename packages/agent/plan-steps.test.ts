import { describe, expect, it } from 'vitest';
import { PLAN_STEP_PREFIX_PATTERN, parsePlanStep, planStepNextHint } from './src/plan-steps';

/** 计划模式协议（roadmap Phase 6）：机械、领域无关，只看 request 的「第N/M步：」前缀。 */
describe('计划模式协议：第N/M步 前缀解析', () => {
  it('带前缀 = 计划模式：解析出步号/总步数/标签，协议前缀从请求里剥掉', () => {
    expect(parsePlanStep('第2/3步：查某个对象 202609 的余额')).toEqual({
      stepIndex: 2,
      totalSteps: 3,
      label: '第 2/3 步',
      request: '查某个对象 202609 的余额',
    });
    // 全角冒号同样认（模型两种都可能写）
    expect(parsePlanStep('第1/2步：查某个对象')?.request).toBe('查某个对象');
    // 前缀后面的空白不进入请求
    expect(parsePlanStep('第3/3步：   查某个对象   ')?.request).toBe('查某个对象');
  });

  it('无前缀 = 单步模式：行为与从前完全一样', () => {
    expect(parsePlanStep('查某个对象的余额')).toBeNull();
    expect(parsePlanStep('')).toBeNull();
    // 形似但不是协议前缀（没有"步"字、没有斜杠）都按单步
    expect(parsePlanStep('第 2 步：查某个对象')).toBeNull();
    expect(parsePlanStep('第二步：查某个对象')).toBeNull();
    expect(parsePlanStep('2/3：查某个对象')).toBeNull();
  });

  it('非法前缀按单步：第 0 步、共 0 步、第 N>M 步、只有前缀没有正文', () => {
    expect(parsePlanStep('第0/3步：查某个对象')).toBeNull();
    expect(parsePlanStep('第1/0步：查某个对象')).toBeNull();
    expect(parsePlanStep('第4/3步：查某个对象')).toBeNull();
    expect(parsePlanStep('第1/3步：')).toBeNull();
    expect(parsePlanStep('第1/3步：   ')).toBeNull();
  });

  it('协议正则本身是纯机械的：不匹配任何业务内容', () => {
    // 同样的正则对业务文本零命中——计划模式的识别与领域无关
    for (const text of ['查一下应收余额', '核对三个账套', '第 1/3 个对象', 'step 1/3']) {
      expect(PLAN_STEP_PREFIX_PATTERN.test(text)).toBe(false);
    }
    expect(PLAN_STEP_PREFIX_PATTERN.test('第1/3步：x')).toBe(true);
  });

  it('下一步提示：非最后一步指向下一步，最后一步指向 conversation 汇总', () => {
    const middle = planStepNextHint({ stepIndex: 1, totalSteps: 3, label: '第 1/3 步', request: 'x' }, 'task_a');
    expect(middle).toContain('第2/3步：');
    expect(middle).toContain('task_a');
    expect(middle).toContain('continueTaskId');
    expect(middle).toContain('不阻塞');

    const last = planStepNextHint({ stepIndex: 3, totalSteps: 3, label: '第 3/3 步', request: 'x' }, 'task_a');
    expect(last).toContain('conversation');
    expect(last).toContain('如实报告');
    expect(last).not.toContain('第4/3步');
  });
});
