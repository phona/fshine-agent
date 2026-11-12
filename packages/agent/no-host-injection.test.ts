/**
 * T9 宿主注入删除（架构调整相位 1，用户裁定）。
 *
 * 用户裁定把「主动回溯证据」与「执行事实台账」两个注入整条删除：召回轮不再由宿主
 * 每回合重算一段摘要塞进上下文头部——那会改写前缀、破坏 prompt cache，而且主流
 * harness（Codex / Pi / OpenClaw / SWE-agent）都选择让模型直接读保留下来的历史。
 * 数据源 platform_tasks 保留（resource-exhausted 与超时恢复还在用），只是不再被
 * 渲染成台账注入。
 *
 * 机械断言：
 *   ① 编排层生产代码里不存在两个注入模块与它们的取数/线索函数；
 *   ② 召回轮（中文线索词在场，旧实现必然命中）的模型输入里没有台账标记串、
 *      没有主动回溯材料、没有注入事件——注入整条路径已删；
 *   ③ 宿主仍然提供本轮平台获取（tool_result 落审计），删除注入不等于删除执行。
 *
 * 昨天九个英文长会话用例被中文线索尺静默关死、单测全绿而台账一次不注入；本文件
 * 用中文召回轮做行为钉，避免"删了注入但旧的注入事件名还在某条分支里"。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationEventRecord, TrustedContext } from '@fshine/contracts';
import type { ContextTaskRunner, SubagentTaskResult } from './src/context';
import { RUN_EXECUTION_TASK_DESCRIPTION, RUN_EXECUTION_TASK_SCHEMA, RUN_EXECUTION_TASK_TOOL } from './src/context';
import type { TurnDriver, TurnDriverInput } from './src/driver';
import { createTaxAgentRuntime } from './src/runtime';
import { FakeSessionRepo } from './test-helpers';

const REPO_ROOT = path.resolve(__dirname, '../..');
/** 旧注入的标记串：模型输入里出现任意一个 = 注入仍在。 */
const OLD_INJECTION_MARKERS = ['【宿主执行事实：', '【宿主主动回溯'] as const;
/** 旧注入的字段/函数名：生产代码里出现任意一个 = 路径仍在。 */
const OLD_INJECTION_IDENTIFIERS = [
  'reference-evidence',
  'execution-facts',
  'collectReferenceEvidence',
  'looksLikeReferenceCue',
  'collectExecutionFacts',
  'executionFactsText',
  'reference_evidence_injected',
  'execution_facts_injected',
] as const;

function makeCtx(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return { requestId: 'req_t9', principalId: 'wecom:user_a', sessionId: 'sess_1', ...overrides };
}

function subagent(): ContextTaskRunner {
  return {
    tool: { name: RUN_EXECUTION_TASK_TOOL, description: RUN_EXECUTION_TASK_DESCRIPTION, inputSchema: RUN_EXECUTION_TASK_SCHEMA },
    run: async (): Promise<SubagentTaskResult> => ({ taskId: 'task_1', text: '子 Agent 完成。' }),
  };
}

function conversationLog() {
  const events: ConversationEventRecord[] = [];
  return {
    events,
    repo: {
      append: async (event: ConversationEventRecord) => { events.push(event); },
      list: async (query: { principalId: string; sessionId?: string; limit: number }) => events
        .filter((event) => event.principalId === query.principalId && (!query.sessionId || event.sessionId === query.sessionId))
        .slice(-query.limit),
      search: async (query: { principalId: string; sessionId?: string; query: string }) => events
        .filter((event) => event.principalId === query.principalId && (!query.sessionId || event.sessionId === query.sessionId) && event.content?.includes(query.query)),
    },
  };
}

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

describe('T9 宿主注入整条删除', () => {
  it('编排层生产代码里两个注入模块与取数/线索函数零命中', () => {
    const hits: string[] = [];
    for (const dir of ['packages/agent/src', 'apps'] as const) {
      for (const file of walk(path.join(REPO_ROOT, dir))) {
        const content = readFileSync(file, 'utf8');
        for (const identifier of OLD_INJECTION_IDENTIFIERS) {
          if (content.includes(identifier)) hits.push(`${path.relative(REPO_ROOT, file)}: ${identifier}`);
        }
      }
    }
    expect(hits, `宿主注入路径仍在：\n${hits.join('\n')}`).toEqual([]);
  });

  it('召回轮（中文线索词在场）的模型输入不含台账/回溯材料，且没有注入事件', async () => {
    const log = conversationLog();
    const inputs: TurnDriverInput[] = [];
    const driver: TurnDriver = {
      run: async (input) => {
        inputs.push(input);
        return { text: '好的。', messages: input.messages };
      },
    };
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const runtime = createTaxAgentRuntime({
        driver,
        sessions: new FakeSessionRepo(),
        platformTask: subagent(),
        conversationLog: log.repo,
        // 旧实现在这个 dep + 中文召回线索下必然注入台账；现在它只在 resource-exhausted 用。
        platformTasks: {
          listBySession: async () => [{
            taskId: 'task_fixture', parentSessionId: 'sess_1', principalId: 'wecom:user_a',
            workerMessages: [], createdAt: '2026-11-10T02:00:00.000Z', updatedAt: '2026-11-10T02:01:00.000Z',
            scopeValues: ['幻辰财税', '202609'], label: '应收账款余额查询', outcome: 'done',
            resultText: '幻辰财税 202609 应收账款余额为 7,321.55 元。',
          }],
        },
      });
      await runtime.handleTurn(makeCtx(), '刚才查的是哪个账套？');

      const prompt = JSON.stringify(inputs[0]!.messages);
      for (const marker of OLD_INJECTION_MARKERS) {
        expect(prompt, `召回轮的模型输入里仍有宿主注入材料：${marker}`).not.toContain(marker);
      }
      const logs = info.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logs).not.toContain('execution_facts_injected');
      expect(logs).not.toContain('reference_evidence_injected');
    } finally {
      info.mockRestore();
    }
  });
});
