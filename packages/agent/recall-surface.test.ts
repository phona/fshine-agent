/**
 * T1 召回不许走历史检索（架构调整相位 1）。
 *
 * 两条断言，都来自探针实测的败相：召回轮靠自己检索历史（工具面给了 search_history /
 * get_messages），或干脆从转录自由回忆——两种都会把旧对象/旧范围当成本轮结果。
 * 目标形状：召回轮的回答依据只有平台实时获取动作这一条合法来源——
 *   ① 历史检索工具不在工具面上，模型没有"自己翻旧账"这条路径；
 *   ② 召回轮要新数据时，作答之前宿主确实发起平台获取（platformTask.run 被调用），
 *      且这次执行以 tool_result 事件落进 Conversation Log（审计可查）。
 *
 * 相位 1 的 T9 裁定同时删除了宿主执行台账注入（execution-facts）：召回轮不再有
 * "宿主每回合重算摘要"这条路，作答依据只剩模型直接读保留的历史 + 本轮平台获取。
 * 因此本文件不再断言任何注入存在（那类断言随注入一起删除）。
 */
import { describe, expect, it } from 'vitest';
import type { ConversationEventRecord, TrustedContext } from '@fshine/contracts';
import type { ContextTaskRunner, SubagentTaskResult } from './src/context';
import { RUN_EXECUTION_TASK_DESCRIPTION, RUN_EXECUTION_TASK_SCHEMA, RUN_EXECUTION_TASK_TOOL } from './src/context';
import { ToolUserError, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from './src/driver';
import { createTaxAgentRuntime } from './src/runtime';
import { FakeSessionRepo } from './test-helpers';

/** 夹具：本轮平台实时查询返回的数字。 */
const FIXTURE_NUMBER = '7,321.55';
const RECALL_QUESTION = '刚才查出来的应收余额是多少？';

function makeCtx(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return { requestId: 'req_recall', principalId: 'wecom:user_a', sessionId: 'sess_1', ...overrides };
}

function subagent(run?: ContextTaskRunner['run']): ContextTaskRunner {
  return {
    tool: { name: RUN_EXECUTION_TASK_TOOL, description: RUN_EXECUTION_TASK_DESCRIPTION, inputSchema: RUN_EXECUTION_TASK_SCHEMA },
    run: run ?? (async (): Promise<SubagentTaskResult> => ({ taskId: 'task_1', text: '子 Agent 完成。' })),
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

/** driver 收到的一次输入快照（工具面 + 模型可见消息）。 */
function snapshotDriver(script: (input: TurnDriverInput) => Promise<TurnDriverResult>) {
  const inputs: TurnDriverInput[] = [];
  const driver: TurnDriver = {
    run: async (input) => {
      inputs.push(input);
      return script(input);
    },
  };
  return { driver, inputs };
}

describe('T1 召回轮的工具面与作答依据', () => {
  it('历史检索工具不在工具面上：召回没有"自己翻旧账"这条路径', async () => {
    const log = conversationLog();
    const { driver, inputs } = snapshotDriver((input) => Promise.resolve({ text: '好的。', messages: input.messages }));
    const runtime = createTaxAgentRuntime({
      driver,
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      conversationLog: log.repo,
    });

    await runtime.handleTurn(makeCtx(), RECALL_QUESTION);

    const tools = inputs[0]!.tools.map((tool) => tool.name);
    expect(tools, '历史检索工具仍在工具面上：召回会走历史检索而不是平台获取').not.toContain('search_history');
    expect(tools, '历史检索工具仍在工具面上：召回会走历史检索而不是平台获取').not.toContain('get_messages');
    // 正向半边：委派入口仍在（召回轮要新数据时经它 → 平台获取）。
    expect(tools).toContain('run_task');
  });

  it('召回轮要新数据时，作答前宿主发起平台获取，且执行痕迹落审计（tool_result）', async () => {
    const log = conversationLog();
    const delegated: Array<{ request: string }> = [];
    const inputs: TurnDriverInput[] = [];
    // 模拟 pi 驱动对 terminate 工具结果的落法：exec 抛出确定性话术，驱动把话术作为
    // toolResult 消息交还运行时——运行时据此把本轮平台获取写成 Conversation Log 的
    // tool_result 事件（可审计的执行痕迹）。
    const driver: TurnDriver = {
      run: async (input) => {
        inputs.push(input);
        try {
          await input.exec('run_task', { request: '查询幻辰财税 202609 应收账款余额' });
          throw new Error('委派应以 ToolUserError 终结本轮');
        } catch (error) {
          if (!(error instanceof ToolUserError)) throw error;
          return {
            text: error.message,
            messages: [
              ...input.messages,
              { role: 'toolResult', toolName: 'run_task', toolCallId: 'call_live', content: [{ type: 'text', text: error.message }], timestamp: Date.now() } as never,
            ],
          };
        }
      },
    };
    const runtime = createTaxAgentRuntime({
      driver,
      sessions: new FakeSessionRepo(),
      platformTask: subagent(async (args) => {
        delegated.push({ request: args.request });
        return { taskId: 'task_live', text: `本轮实时查询：${FIXTURE_NUMBER} 元。`, execution: { planId: 'plan_live', version: 1, calls: 1 } };
      }),
      conversationLog: log.repo,
    });

    const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_recall_live' }), RECALL_QUESTION);

    expect(delegated, '召回轮无法发起平台获取').toHaveLength(1);
    expect(inputs[0]!.tools.map((tool) => tool.name)).toContain('run_task');
    expect(reply.text).toContain(FIXTURE_NUMBER);
    // 审计可查：这次平台获取作为 tool_result 事件落进 Conversation Log。
    const toolResults = log.events.filter((event) => event.kind === 'tool_result');
    expect(toolResults, '平台获取没有留下可审计的执行痕迹').not.toHaveLength(0);
    expect(toolResults.map((event) => event.content).join('\n')).toContain(FIXTURE_NUMBER);
  });
});
