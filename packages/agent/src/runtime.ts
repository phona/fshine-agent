/**
 * Agent 运行时(转录即状态)。
 * 会话状态 = 一份完整消息转录(含工具调用与结果),每轮全文进模型;
 * 上下文压缩由 driver.compact(pi 原生 compact)负责;数据准入由 17dz 分页契约负责。
 * 这里没有:历史投影、意图分类、游标记账、注入分支——模型看到的就是全部事实。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { loadTranscript, saveTranscript } from './session';
import { NEEDS_LOGIN_MESSAGE, toUserMessage } from './errors';
import { ToolUserError, type TurnDriver } from './driver';
import type { AgentReply, ConversationSessionRepo, HostToolClient, TrustedContext } from '@fshine/contracts';

const DEFAULT_SESSION_TTL_MS = 300_000;
/** 回合预算:超时 driver 中止并返回空文本 */
const DEFAULT_TURN_BUDGET_MS = 150_000;

export const FALLBACK_TIMEOUT = '查询超时,请稍后再试';
export const FALLBACK_FAILURE = '查询失败,请稍后再试或联系管理员';

export interface TaxAgentRuntimeDeps {
  driver: TurnDriver;
  sessions: Pick<ConversationSessionRepo, 'get' | 'upsert'>;
  sessionTtlMs?: number;
  turnBudgetMs?: number;
}

/** 账套授权 + 工具编排全在工具面内;模型看到的转录就是全部事实。 */
export function createTaxAgentRuntime(deps: TaxAgentRuntimeDeps): AgentRuntimeShape {
  const sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const turnBudgetMs = deps.turnBudgetMs ?? DEFAULT_TURN_BUDGET_MS;

  return {
    async handleTurn(ctx: TrustedContext, userMessage: string, tools: HostToolClient): Promise<AgentReply> {
      const discovered = tools.tools();
      // 无可用工具 = host 未就绪/无权限:此回合必然无法完成任何查询,尽早收场
      if (discovered.length === 0) return { text: FALLBACK_FAILURE };

      const { messages } = await loadTranscript(deps.sessions, ctx.sessionId, sessionTtlMs);
      messages.push({ role: 'user', content: userMessage, timestamp: Date.now() } as unknown as AgentMessage);

      const deadline = Date.now() + turnBudgetMs;
      const result = await deps.driver.run({
        systemPrompt: SYSTEM_PROMPT(discovered),
        tools: discovered,
        messages,
        onStep: ctx.onStep ?? (() => {}),
        exec: async (tool, args, signal) => {
          const outcome = await tools.call(tool, args, signal);
          if (!outcome.ok) throw new ToolUserError(toUserMessage(outcome.error));
          return outcome.data;
        },
        deadline,
      });

      await saveTranscript(deps.sessions, {
        sessionId: ctx.sessionId,
        principalId: ctx.principalId,
        messages: result.messages,
      });

      if (!result.text.trim()) {
        const reason = Date.now() >= deadline ? 'turn_timeout' : 'empty_reply';
        console.info(JSON.stringify({ event: 'fallback_reply', requestId: ctx.requestId, reason }));
        return { text: Date.now() >= deadline ? FALLBACK_TIMEOUT : FALLBACK_FAILURE };
      }
      return { text: result.text };
    },
  };
}

type AgentRuntimeShape = import('@fshine/contracts').AgentRuntime;

/** 系统提示:身份 + 工具面 + 纪律规则。规则全部对应实测故障,勿随意删除。 */
function SYSTEM_PROMPT(tools: readonly { name: string; description: string; inputSchema: unknown }[]): string {
  const toolLines = tools
    .map((tool) => `- ${tool.name}:${tool.description};inputSchema=${JSON.stringify(tool.inputSchema)}`)
    .join('\n');
  return [
    '你是企业财务助手。可用工具决定当前权限；不能编造数据或绕过工具权限。',
    '你绝不编造数据,所有回答只能基于本轮与历史中的工具结果;涉及当前数据的问题必须重新调用工具查询,不得仅凭历史对话作答。',
    '',
    '可用工具(名称、描述、inputSchema 的紧凑 JSON):',
    toolLines,
    '',
    '回答规则:',
    '- 数据回复必须带上所用账套名称、会计期间(如使用)与数据来源。',
    '- accountSetId 只能使用工具返回的 as_xxx 原值,严禁用账套名称代替或编造。',
    '- list_vouchers 结果含 nextCursor 时,告知用户可回复"下一页"继续;用户说"下一页"时把 nextCursor 原样传入 cursor 参数,说"上一页"时把 prevCursor 原样传入;已在第一页则如实说明。',
    '- 工具结果可能因长度被截断(带 _xxxTruncated/_entriesTruncated 标记):只能引用实际展示的内容,未展示的明细如实说明无法查看,严禁推算或补全。',
    '- 工具结果出现 NEEDS_LOGIN 时,回复:"' + NEEDS_LOGIN_MESSAGE + '"',
    '- 始终使用简体中文回复。',
  ].join('\n');
}
