/**
 * #4 限流端到端（业务 E2E 阶段 2·R2 修复 ① 的验收）——**零真实模型**。
 *
 * 用确定性假 driver（Main 委派 + Worker 三次结构化查询）+ **仓内真实 dummy 执行层**
 * （不注入假执行面），经宿主全链装配跑一个样本。限流旋钮由 harness 落
 * `<state-dir>/rate-limit-config.json`（用例声明 `DUMMY_RATE_LIMIT_MAX`，经 --state-dir 可达，
 * 不再被 worker env 白名单丢弃）→ 第 3 次执行确实触发 RATE_LIMITED。
 *
 * 钉住：R1「#4 空洞、限流从未触发」在本批端到端可复现。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bizCases } from '../exploration/bizprobe/cases';
import { expandBizprobeItems } from './scenarios';
import { runBizprobeBatch } from './assembly';
import { createModelExecutor } from './model-executor';
import type { TurnDriver } from '../../../packages/agent/src/driver-contract';

const B04 = bizCases[3]!; // 限流与部分完成：授权 alpha/beta/documents，env DUMMY_RATE_LIMIT_MAX=2

let tmpRoots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'biz-e2e-ratelimit-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true }); });

describe('① #4 端到端：限流经 state-dir 触发 RATE_LIMITED（真 dummy + 假 driver）', () => {
  it('三次执行 → 第 3 次 RATE_LIMITED；样本如实报告部分失败且不谎报全成', async () => {
    const outRoot = path.join(freshRoot(), 'out');
    const items = expandBizprobeItems([B04], 1); // 只跑 B04#1，聚焦单样本全链

    const mainDriver: TurnDriver = {
      async run(input) {
        const tool = input.tools.find((t) => t.name === 'task_run') ?? input.tools[0]!;
        await input.exec(tool.name, { task: '把 alpha(W1)、beta(W1)、documents(W202611) 三个集合都核对一遍。' });
        const reply = 'alpha 与 beta 已核对；documents 命中限流失败，未能完成。';
        return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
      },
    };
    const workerDriver: TurnDriver = {
      async run(input) {
        // 夹具走内部 exec 路由（execute_operation 兼容入口）：op_* 工具面只收声明过的业务字段，
        // 不再兼容 {operation,args} 包装；本夹具直调内部路由，不经工具面。
        await input.exec('execute_operation', { operation: 'dummy.query', args: { collection: 'alpha', window: 'W1' } });
        await input.exec('execute_operation', { operation: 'dummy.query', args: { collection: 'beta', window: 'W1' } });
        await input.exec('execute_operation', { operation: 'dummy.query', args: { collection: 'documents', window: 'W202611' } });
        const reply = 'alpha、beta 完成；documents 限流失败。';
        return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
      },
    };

    const executor = createModelExecutor({
      createDrivers: () => ({ mainDriver, workerDriver }),
      // 不注入 createExecutionFace → 走仓内真实 dummy 执行层（经 --state-dir）。
      env: { LLM_API_KEY: 'test-placeholder', LLM_MODEL: 'test-model', LLM_API_BASE_URL: 'http://localhost' },
    });

    const report = await runBizprobeBatch({ cases: [B04], items, executor, outRoot, concurrency: 1 });

    // 旋钮确实落到 state 根（修复 ① 的宿主可达路径）。
    const stateDir = path.join(outRoot, 'work', 'B04#1', 'state');
    expect(existsSync(path.join(stateDir, 'rate-limit-config.json'))).toBe(true);
    const cfg = JSON.parse(readFileSync(path.join(stateDir, 'rate-limit-config.json'), 'utf8'));
    expect(cfg).toMatchObject({ max: 2 });

    // 执行层证据：三次结构化查询，第 3 次 failed + RATE_LIMITED。
    // 注：执行层 RESULT 信封带 retryable:true，但宿主适配器 failureOf
    // （packages/agent/src/dummy-cli-client.ts:228）只保留 code/message/correctForm，
    // retryable 未进 ExecutionOutcome → 端到端此处拿不到 retryable（产品面缺陷，只登记不修）。
    // 2026-11-19 模型可见面收口：模型侧工具结果（tool-calls.json 的 result）不再逐字带
    // error.code/error.message——failed 投影只给 {status, kind, note}（RATE_LIMITED 只进
    // execution_failure_classified 日志与底账）。此处断言模型可见面的收口形状。
    const toolCalls = (JSON.parse(readFileSync(path.join(outRoot, 'B04', '1', 'tool-calls.json'), 'utf8')) as { toolCalls: Array<Record<string, any>> }).toolCalls;
    const execCalls = toolCalls.filter((c) => c.tool === 'execute_operation' || c.tool.startsWith('op_'));
    expect(execCalls).toHaveLength(3);
    const statuses = execCalls.map((c) => c.result?.status);
    expect(statuses).toEqual(['completed', 'completed', 'failed']);
    const third = execCalls[2]!;
    // 收口断言：模型可见面不含原始码（error 不再下放），含 kind（表外码 → executor_failed）。
    expect(third.result?.error).toBeUndefined();
    expect(third.result?.kind).toBe('executor_failed');
    expect(JSON.stringify(third.result)).not.toContain('RATE_LIMITED');

    // 判定与行为面：机械判过（无越界/无虚假完成）；部分失败如实报告。
    const sample = report.samples[0]!;
    expect(sample.mechanical.pass).toBe(true);
    expect(sample.behavior?.partialFailureReportedHonestly).toBe(true);
    expect(sample.ux?.notifications ?? 0).toBeGreaterThanOrEqual(1); // 状态迁移派生通知行（修复 ②）
  });
});
