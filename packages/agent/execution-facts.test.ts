/**
 * 召回事实注入（执行台账）的渲染测试（D-065：数据源从 Conversation Log 的 tool_result
 * 事件改为 platform_tasks 的结构化事实 + 结果原文）。
 *
 * 钉住四件事：
 *   ① 结构化字段齐全 → 机械结构化条目（时间｜账套 期间 平台label → 结局），原文数值仍附后；
 *   ② 结构化字段缺失 → 降级为结果原文（现有行为），且**不猜不解析**（没有的字段就是没有）；
 *   ③ 混合（部分记录有字段、部分没有）→ 两种形态各自正确，序号即条目身份；
 *   ④ 台账纪律不变：只认召回线索、只机械陈述、条数上限、存储抛错上抛。
 */
import { describe, expect, it } from 'vitest';
import type { PlatformTaskRecord, PlatformTaskRepo } from '@fshine/contracts';
import { collectExecutionFacts, EXECUTION_FACTS_MARKER, MAX_EXECUTION_FACTS } from './src/execution-facts';

function task(overrides: Partial<PlatformTaskRecord> & { taskId: string }): PlatformTaskRecord {
  return {
    parentSessionId: 's1',
    principalId: 'p1',
    workerMessages: [],
    createdAt: '2026-09-26T10:31:00.000Z',
    updatedAt: '2026-09-26T10:31:00.000Z',
    ...overrides,
  };
}

/** 与 SQLite store 同语义：按会话列举、时间正序。 */
function fakeTasks(records: PlatformTaskRecord[]): Pick<PlatformTaskRepo, 'listBySession'> {
  return {
    async listBySession(principalId, sessionId) {
      return records
        .filter((record) => record.principalId === principalId && record.parentSessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
  };
}

const SCOPE = { principalId: 'p1', sessionId: 's1' } as const;
const RECALL = '刚才查出来是多少钱？';

/** 台账正文（去掉纪律头后的条目行）。 */
function entries(text: string): string[] {
  return text.split('\n').filter((line) => /^[①-⑩]/.test(line));
}

describe('召回事实注入：执行台账（platform_tasks 结构化事实）', () => {
  it('结构化字段齐全 → 机械结构化条目，结果原文（数值）仍附在其后', async () => {
    const facts = await collectExecutionFacts({
      platformTasks: fakeTasks([task({
        taskId: 'task_a',
        createdAt: '2026-09-26T10:31:00.000Z',
        accountSet: '幻辰财税', period: '202606', label: '查应收账款余额',
        outcome: 'done',
        calls: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202606'] }],
        resultText: '幻辰财税 202606 应收账款余额为 61000 元。',
      })]),
      ...SCOPE,
      userMessage: RECALL,
    });

    expect(facts).not.toBeNull();
    expect(facts!.count).toBe(1);
    const line = entries(facts!.text)[0]!;
    // 结构化条目：时间｜账套 期间 平台label → 结局｜原文（数值只能在原文里）
    expect(line).toContain('2026-09-26 10:31｜幻辰财税 202606 查应收账款余额 → done');
    expect(line).toContain('61000 元');
    // 纪律必须写在材料里：只能依据条目、不得混列、没有的结论不得填充
    expect(facts!.text).toContain('只能依据这些条目陈述');
    expect(facts!.text).toContain('不得把不同条目混称为一次查询');
    expect(facts!.text.startsWith(EXECUTION_FACTS_MARKER)).toBe(true);
  });

  it('结局机械映射：needs → 缺信息、failed → 失败（不发明状态词，不洗白"没有执行"）', async () => {
    const facts = await collectExecutionFacts({
      platformTasks: fakeTasks([
        task({ taskId: 't1', outcome: 'needs', resultText: '子 Agent 本轮没有执行平台查询，还缺少信息：查询对象。原因：用户没有给出要查的对象。' }),
        task({ taskId: 't2', createdAt: '2026-09-26T10:40:00.000Z', outcome: 'failed', resultText: '平台登录态过期，需要重新登录后才能继续查询。' }),
      ]),
      ...SCOPE,
      userMessage: RECALL,
    });

    const lines = entries(facts!.text);
    expect(lines[0]).toContain('→ 缺信息');
    expect(lines[0]).toContain('还缺少信息');
    expect(lines[1]).toContain('→ 失败');
    // 没有结果的条目就没有结果：不能把别的条目数字安过来
    expect(lines[0]).not.toContain('61000');
  });

  it('字段缺失的旧任务降级为结果原文（现有行为），不猜不解析', async () => {
    const facts = await collectExecutionFacts({
      platformTasks: fakeTasks([task({
        taskId: 'old_task',
        // 升级前的记录：没有任何结构化字段，只有结果原文
        resultText: '新兴五金 202609 没有已保存的凭证（平台返回 0 条）。',
      })]),
      ...SCOPE,
      userMessage: RECALL,
    });

    const line = entries(facts!.text)[0]!;
    // 降级形态：时间｜原文——没有账套/期间/label/结局，就没有这些段（不出空泛占位）
    expect(line).toBe('① 2026-09-26 10:31｜新兴五金 202609 没有已保存的凭证（平台返回 0 条）。');
    expect(line).not.toContain('→');
    expect(line).not.toContain('undefined');
  });

  it('混合：结构化任务与旧任务同列，序号即条目身份', async () => {
    const facts = await collectExecutionFacts({
      platformTasks: fakeTasks([
        task({ taskId: 'old', resultText: '幻辰财税 202606 应收账款余额为 61000 元。' }),
        task({
          taskId: 'new', createdAt: '2026-09-26T10:35:00.000Z',
          accountSet: '新兴五金', period: '202609', label: '查已存档凭证', outcome: 'done',
          resultText: '新兴五金 202609 没有已保存的凭证（平台返回 0 条）。',
        }),
      ]),
      ...SCOPE,
      userMessage: RECALL,
    });

    const lines = entries(facts!.text);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('61000 元');
    expect(lines[0]).not.toContain('→');
    expect(lines[1]).toContain('2026-09-26 10:35｜新兴五金 202609 查已存档凭证 → done');
    // 模型据此逐条归因，不会把两条混成一次查询
    expect(facts!.text).toContain('①');
    expect(facts!.text).toContain('②');
  });

  it('渲染模板零业务词：纪律头里不出现任何领域词（条目内容里的业务词是数据）', async () => {
    const facts = await collectExecutionFacts({
      platformTasks: fakeTasks([task({
        taskId: 't', accountSet: '某账套', period: '202601', label: '查凭证列表', outcome: 'done',
        resultText: '某对象某期间的查询结果',
      })]),
      ...SCOPE,
      userMessage: RECALL,
    });
    const header = facts!.text.split('\n').slice(0, 4).join('\n');
    expect(header).not.toMatch(/应收|凭证|科目|账套|期间|目录|税号|财务|借贷|余额|往来|时间范围|记录|档案|摸底/u);
  });

  it('没有召回线索时不检索、不注入（即使有执行记录）', async () => {
    const facts = await collectExecutionFacts({
      platformTasks: fakeTasks([task({ taskId: 't', resultText: '幻辰财税 202606 应收账款余额为 61000 元。' })]),
      ...SCOPE,
      userMessage: '查一下幻辰财税的应收账款',
    });
    expect(facts).toBeNull();
  });

  it('没有任何可渲染记录时返回 null（空库 / 只有空原文的旧记录）', async () => {
    expect(await collectExecutionFacts({ platformTasks: fakeTasks([]), ...SCOPE, userMessage: RECALL })).toBeNull();
    expect(await collectExecutionFacts({
      platformTasks: fakeTasks([task({ taskId: 'empty', resultText: '   ' })]),
      ...SCOPE,
      userMessage: RECALL,
    })).toBeNull();
  });

  it('执行记录超过上限时只保留最近 5 条并标记截断', async () => {
    const records = Array.from({ length: 7 }, (_, i) => task({
      taskId: `t${i}`,
      createdAt: `2026-09-26T10:0${i}:00.000Z`,
      resultText: `第 ${i} 次查询结果`,
    }));
    const facts = await collectExecutionFacts({ platformTasks: fakeTasks(records), ...SCOPE, userMessage: '刚才那几次查询，哪个结果最高？' });

    expect(facts!.count).toBe(MAX_EXECUTION_FACTS);
    expect(facts!.truncated).toBe(true);
    expect(entries(facts!.text)).toHaveLength(MAX_EXECUTION_FACTS);
    expect(facts!.text).toContain('第 6 次查询结果');
    expect(facts!.text).toContain('第 2 次查询结果');
    expect(facts!.text).not.toContain('第 1 次查询结果');
    expect(facts!.text).not.toContain('第 0 次查询结果');
    expect(facts!.text).toContain('更早的执行不在本材料内');
  });

  it('单条原文超长时截断并留省略号（全文仍在 Log 里可检索）', async () => {
    const facts = await collectExecutionFacts({
      platformTasks: fakeTasks([task({ taskId: 't', resultText: '长'.repeat(500) })]),
      ...SCOPE,
      userMessage: RECALL,
    });
    const line = entries(facts!.text)[0]!;
    expect(line.endsWith('…')).toBe(true);
    expect(line.length).toBeLessThan(400);
  });

  it('存储不可用时抛错，由调用方兜底（不失败回合）', async () => {
    const broken: Pick<PlatformTaskRepo, 'listBySession'> = {
      async listBySession() { throw new Error('disk unavailable'); },
    };
    await expect(collectExecutionFacts({ platformTasks: broken, ...SCOPE, userMessage: RECALL })).rejects.toThrow('disk unavailable');
  });
});
