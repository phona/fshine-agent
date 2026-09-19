/** Main Pi Agent runtime with one narrow delegation tool for the 17dz subagent. */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentReply, ConversationSessionRepo, TrustedContext } from '@fshine/contracts';
import { loadTranscript, saveTranscript } from './session';
import { ToolUserError, type TurnDriver } from './driver';
import { RUN_17DZ_TASK_TOOL, type ContextTaskRunner } from './context';

const DEFAULT_SESSION_TTL_MS = 86_400_000;
const DEFAULT_TURN_BUDGET_MS = 150_000;

export const FALLBACK_TIMEOUT = '查询超时,请稍后再试';
export const FALLBACK_FAILURE = '查询失败,请稍后再试或联系管理员';

export interface TaxAgentRuntimeDeps {
  driver: TurnDriver;
  sessions: Pick<ConversationSessionRepo, 'get' | 'upsert'>;
  platformTask: ContextTaskRunner;
  sessionTtlMs?: number;
  turnBudgetMs?: number;
}

export function createTaxAgentRuntime(deps: TaxAgentRuntimeDeps): import('@fshine/contracts').AgentRuntime {
  const sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const turnBudgetMs = deps.turnBudgetMs ?? DEFAULT_TURN_BUDGET_MS;
  const tools = [deps.platformTask.tool];

  return {
    async handleTurn(ctx: TrustedContext, userMessage: string): Promise<AgentReply> {
      const { messages: loaded, expired } = await loadTranscript(deps.sessions, ctx.sessionId, sessionTtlMs);
      let context = loaded;
      if (expired && loaded.length > 0) {
        console.info(JSON.stringify({ event: 'session_resume_seeding', sessionId: ctx.sessionId, staleMessages: loaded.length }));
        context = deps.driver.compact ? await deps.driver.compact(loaded, { force: true }) : loaded;
      }
      if (deps.driver.compact) context = await deps.driver.compact(context);
      context.push({ role: 'user', content: userMessage, timestamp: Date.now() } as unknown as AgentMessage);

      const deadline = Date.now() + turnBudgetMs;
      const result = await deps.driver.run({
        systemPrompt: SYSTEM_PROMPT,
        tools,
        messages: context,
        onStep: ctx.onStep ?? (() => {}),
        exec: async (tool, args, signal) => {
          if (tool !== RUN_17DZ_TASK_TOOL) throw new ToolUserError('当前主 Agent 未授权该工具。');
          return deps.platformTask.run({
            request: String(args['request'] ?? ''),
            ...(typeof args['taskId'] === 'string' ? { taskId: args['taskId'] } : {}),
          }, { trusted: ctx }, signal);
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

const SYSTEM_PROMPT = [
  '你是企业财务助手和面向用户的主 Agent。',
  '凡是需要访问或处理 幻账平台真实数据的任务，必须调用 run_17dz_task，不得凭历史结果或常识编造。',
  '17dz 子 Agent 返回自然语言。你负责理解它并决定下一步：直接回答、向用户转达问题，或携带 taskId 继续同一子任务。',
  '当前仅支持查询、核对、分析类任务。任何新增/修改/删除凭证、过账、结账等写操作，直接说明当前仅支持查询并拒绝；不得描述修改路径、不得给出操作方案、不得承诺"确认后可执行"——即使子 Agent 的回复里包含这类内容也不得转述。',
  '不要把 taskId 等内部标识展示给用户。新任务不要复用旧 taskId。',
  '回答始终使用简体中文；数据结论应保留子 Agent 给出的账套、期间、来源和证据。',
].join('\n');
