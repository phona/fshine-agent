/**
 * Thin adapter from the main Agent to a Pi subagent rooted in a trusted
 * platform workspace. The subagent returns natural language; the main Agent
 * decides whether to answer, ask the user, or resume the same session.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DriverMessage, TurnDriver } from './driver';
import { ToolUserError } from './driver';
import type {
  ContextProfileConfig,
  DiscoveredTool,
  PlatformTaskRecord,
  PlatformTaskRepo,
  TrustedContext,
} from '@fshine/contracts';

export const RUN_17DZ_TASK_TOOL = 'run_17dz_task';
const DEFAULT_WORKER_TIMEOUT_MS = 600_000;

export const RUN_17DZ_TASK_DESCRIPTION = [
  '当用户的问题需要访问或处理 幻账平台中的真实财税数据时，将任务委托给 17dz 子 Agent。',
  '子 Agent 在受信的 17dz-platform 工作目录中加载平台 Skill，并返回自然语言结果。',
  '你负责理解该结果：可以直接回答用户、把子 Agent 的问题转达给用户，或携带 taskId 继续同一个任务。',
  '涉及 17dz 实时数据时必须调用本工具，不得凭历史对话猜测账套 ID、科目编码、客户 ID 或实时结果。',
  '继续同一任务时传入此前返回的 taskId，并把用户最新补充完整放入 request；新任务不要复用 taskId。',
].join('\n');

export interface Run17dzTaskArgs {
  request: string;
  taskId?: string;
}

export interface SubagentTaskResult {
  taskId: string;
  text: string;
}

export interface ContextTaskRunnerOptions {
  profiles: Record<string, ContextProfileConfig>;
  tasks: PlatformTaskRepo;
  workerDriver: TurnDriver;
  profileId?: string;
}

export interface ContextTaskExecutionContext {
  trusted: TrustedContext;
}

export interface ContextTaskRunner {
  readonly tool: DiscoveredTool;
  run(
    args: Run17dzTaskArgs,
    ctx: ContextTaskExecutionContext,
    signal?: AbortSignal,
  ): Promise<SubagentTaskResult>;
}

export const RUN_17DZ_TASK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['request'],
  additionalProperties: false,
  properties: {
    request: { type: 'string', minLength: 1, description: '交给 17dz 子 Agent 的完整任务或用户最新补充' },
    taskId: { type: 'string', description: '仅在继续此前 17dz 子任务时使用返回的 taskId' },
  },
};

export function createContextTaskRunner(options: ContextTaskRunnerOptions): ContextTaskRunner {
  const profileId = options.profileId ?? '17dz';
  const tool: DiscoveredTool = {
    name: RUN_17DZ_TASK_TOOL,
    description: RUN_17DZ_TASK_DESCRIPTION,
    inputSchema: RUN_17DZ_TASK_SCHEMA,
  };

  return {
    tool,
    async run(args, ctx, signal) {
      if (!args || typeof args.request !== 'string' || args.request.trim() === '') {
        throw new ToolUserError('17dz 任务不能为空。');
      }
      if (args.taskId !== undefined && (typeof args.taskId !== 'string' || args.taskId.trim() === '')) {
        throw new ToolUserError('17dz taskId 无效。');
      }

      const profile = await resolveContextProfile(options.profiles, profileId);
      const existing = args.taskId ? await options.tasks.get(args.taskId) : null;
      if (args.taskId && !existing) throw new ToolUserError('未找到可继续的 17dz 任务。');
      if (existing && (existing.principalId !== ctx.trusted.principalId || existing.parentSessionId !== ctx.trusted.sessionId)) {
        throw new ToolUserError('无权继续该 17dz 任务。');
      }

      const taskId = existing?.taskId ?? `task_${randomUUID()}`;
      const running: PlatformTaskRecord = {
        taskId,
        parentSessionId: ctx.trusted.sessionId,
        principalId: ctx.trusted.principalId,
        workerMessages: existing?.workerMessages ?? [],
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await options.tasks.upsert(running);

      const messages = [
        ...((existing?.workerMessages ?? []) as DriverMessage[]),
        { role: 'user', content: args.request, timestamp: Date.now() } as unknown as DriverMessage,
      ];
      try {
        const result = await options.workerDriver.run({
          systemPrompt: workerSystemPrompt(profile.root, ctx.trusted.allowedAccountSetIds),
          tools: [],
          messages,
          cwd: profile.root,
          skillRoots: profile.skillRoots,
          sessionId: taskId,
          onStep: ctx.trusted.onStep ?? (() => {}),
          exec: async () => { throw new ToolUserError('17dz 子 Agent 只能使用其工作目录内配置的原生工具。'); },
          deadline: Date.now() + (profile.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS),
          signal,
        });
        if (!result.text.trim()) throw new Error(signal?.aborted ? '17dz 子任务已取消。' : '17dz 子 Agent 未返回可用结果。');
        const final: SubagentTaskResult = { taskId, text: result.text };
        await options.tasks.upsert({
          ...running,
          workerMessages: result.messages as unknown[],
          updatedAt: new Date().toISOString(),
        });
        return final;
      } catch (error) {
        console.error(JSON.stringify({
          event: 'subagent_task_failed',
          taskId,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }));
        await options.tasks.upsert({
          ...running,
          updatedAt: new Date().toISOString(),
        });
        throw new ToolUserError(signal?.aborted ? '17dz 子任务已取消。' : '17dz 子任务执行失败，请稍后再试。');
      }
    },
  };
}

async function resolveContextProfile(profiles: Record<string, ContextProfileConfig>, id: string): Promise<ResolvedContextProfile> {
  const configured = profiles[id];
  if (!configured) throw new ToolUserError(`未配置 17dz 上下文 profile:${id}`);
  const root = await fs.realpath(configured.root).catch(() => { throw new ToolUserError(`17dz 上下文目录不可用:${id}`); });
  const skillRoots: string[] = [];
  for (const relative of configured.skillRoots) {
    if (path.isAbsolute(relative)) throw new ToolUserError('17dz skillRoots 必须是相对 root 的路径。');
    const resolved = await fs.realpath(path.join(root, relative)).catch(() => undefined);
    if (!resolved || !isInside(root, resolved)) throw new ToolUserError('17dz skillRoots 未通过路径安全校验。');
    skillRoots.push(resolved);
  }
  return { root, skillRoots, workerTimeoutMs: configured.workerTimeoutMs };
}

interface ResolvedContextProfile {
  root: string;
  skillRoots: string[];
  workerTimeoutMs?: number;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function workerSystemPrompt(root: string, allowedAccountSetIds: readonly string[]): string {
  const scope = allowedAccountSetIds.length > 0
    ? `调用者的应用层账套 allowlist：${allowedAccountSetIds.join(', ')}。不得查询或操作名单外账套。`
    : '应用层未提供账套 allowlist；账套访问范围必须以平台领域脚本的权限校验为准。';
  return [
    '你是 幻账平台任务子 Agent。你在受信工作目录中为主 Agent 执行一项具体任务。',
    `平台工作目录：${root}`,
    '先按 Pi 的 Skill 机制读取与任务相关的 SKILL.md、MECHANISMS.md 和契约说明，再调用其中指定的领域脚本。',
    '实时账务数据必须来自领域脚本结果，不得编造；不要读取源码后猜内部 ID，也不要自行重实现平台流程。',
    scope,
    '缺少信息时直接用自然语言说明需要用户补充什么；完成时直接返回可供主 Agent 使用的自然语言结果和必要证据。',
    '不要替主 Agent 决定如何回复用户，也不要输出状态 JSON 或控制协议。',
  ].join('\n\n');
}
