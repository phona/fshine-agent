/**
 * Generic, trusted context worker.
 *
 * A context profile is operator configuration, never model input.  It gives a
 * fresh Pi worker a working directory and skill roots while task state stays
 * in fshine's SQLite store. Tool execution is supplied by a tiny provider
 * contract; the default implementation exposes generic workspace tools.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DriverMessage, TurnDriver } from './driver';
import { ToolUserError } from './driver';
import { createSkillRegistry, FileSkillRegistry, type SkillMetadata, type SkillRegistry } from './skills';
import type {
  ContextProfileConfig,
  DiscoveredTool,
  PlatformTaskRecord,
  PlatformTaskRepo,
  PlatformTaskStatus,
  TrustedContext,
} from '@fshine/contracts';
import { createWorkspaceToolProvider } from './workspace-tools';

export const RUN_17DZ_TASK_TOOL = 'run_17dz_task';
const DEFAULT_WORKER_TIMEOUT_MS = 600_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;

export const RUN_17DZ_TASK_DESCRIPTION = [
  '当用户的问题需要访问或处理 幻账平台中的真实财税数据时调用本工具。',
  '',
  '支持的任务包括：查找和确认账套、会计期间、科目、客户、供应商等平台档案；查询科目余额和辅助余额；查询记账凭证及分页；查看账套科目体系和平台信息；以及平台内的财税任务、校验、预览和需要确认的流程。',
  '',
  '调用后，幻账平台 Worker 会加载受信的平台工作目录和 Skill，自行完成必要的查询、分析和后续操作。涉及 17dz 实时数据时不要凭历史对话或常识作答，也不要在主 Agent 中猜测账套 ID、科目编码或客户 ID。',
  '',
  '不支持：普通会计知识解释、与 17dz 实时数据无关的计算、任意代码执行，以及未经用户明确确认的破坏性操作。',
  '',
  '返回状态包括 completed（完成）、needs_input（需要选择或补充信息）、preview（已生成预览等待确认）、blocked（无法继续）和 failed（执行失败）。当返回 needs_input 或 preview 时，后续调用必须携带返回的 taskId，并在 answer 中传入用户的选择或确认。',
].join('\n');

export interface Run17dzTaskArgs {
  request: string;
  taskId?: string;
  answer?: string;
}

export interface PlatformTaskResult {
  status: Exclude<PlatformTaskStatus, 'created' | 'running' | 'cancelled'>;
  taskId: string;
  answer?: string;
  questions?: string[];
  evidence?: unknown[];
  error?: string;
}

export interface ContextTaskRunnerOptions {
  profiles: Record<string, ContextProfileConfig>;
  tasks: PlatformTaskRepo;
  /** Main and worker drivers are separate in production; tests may provide a queue. */
  workerDriver: TurnDriver;
  /** Generic fshine skills (Finance by default) loaded before profile skills. */
  commonSkillRegistry?: SkillRegistry;
  /** Optional in-process capability provider supplied by the deployment. */
  provider?: ContextToolProvider;
  /** Set false only for deployments that intentionally provide no worker tools. */
  genericWorkspaceTools?: boolean;
  profileId?: string;
}

export interface ContextTaskExecutionContext {
  trusted: TrustedContext;
  /** Optional generic execution capability supplied by the mounted context. */
  provider?: ContextToolProvider;
}

/** The only optional execution contract a mounted context needs. */
export interface ContextToolProvider {
  tools(): readonly DiscoveredTool[];
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close?(): void | Promise<void>;
}

export interface ContextTaskRunner {
  readonly tool: DiscoveredTool;
  run(args: Run17dzTaskArgs, ctx: ContextTaskExecutionContext): Promise<PlatformTaskResult>;
}

export const RUN_17DZ_TASK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['request'],
  additionalProperties: false,
  properties: {
    request: { type: 'string', minLength: 1, description: '用户原始任务或对当前 17dz 任务的补充说明' },
    taskId: { type: 'string', description: '继续已有任务时使用工具返回的 taskId' },
    answer: { type: 'string', description: '用户对 needs_input 或 preview 的选择、补充或确认' },
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
    async run(args, ctx) {
      if (!args || typeof args.request !== 'string' || args.request.trim() === '') {
        throw new ToolUserError('17dz 任务不能为空。');
      }
      if (args.taskId !== undefined && typeof args.taskId !== 'string') {
        throw new ToolUserError('17dz taskId 无效。');
      }
      if (args.answer !== undefined && typeof args.answer !== 'string') {
        throw new ToolUserError('17dz 任务回答无效。');
      }
      const profile = await resolveContextProfile(options.profiles, profileId);
      const existing = args.taskId ? await options.tasks.get(args.taskId) : null;
      if (args.taskId && !existing) throw new ToolUserError('未找到可继续的 17dz 任务。');
      if (existing && (existing.principalId !== ctx.trusted.principalId || existing.parentSessionId !== ctx.trusted.sessionId)) {
        throw new ToolUserError('无权继续该 17dz 任务。');
      }
      const taskId = existing?.taskId ?? `task_${randomUUID()}`;
      const createdAt = existing?.createdAt ?? new Date().toISOString();
      const running: PlatformTaskRecord = {
        taskId,
        pluginId: profileId,
        parentSessionId: ctx.trusted.sessionId,
        principalId: ctx.trusted.principalId,
        status: 'running',
        workerMessages: existing?.workerMessages ?? [],
        ...(existing?.currentStep ? { currentStep: existing.currentStep } : {}),
        createdAt,
        updatedAt: new Date().toISOString(),
      };
      await options.tasks.upsert(running);

      const skillRegistry = new CompositeSkillRegistry([
        options.commonSkillRegistry ?? createSkillRegistry(),
        ...profile.skillRoots.map((root) => new FileSkillRegistry({ rootDir: root })),
      ]);
      const skills = await skillRegistry.discover();
      const skillText = await readSkills(skillRegistry, skills);
      const provider = ctx.provider
        ?? options.provider
        ?? (options.genericWorkspaceTools === false ? undefined : createWorkspaceToolProvider(profile.root, {
          commandTimeoutMs: profile.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        }));
      const nativeTools = options.workerDriver.managesNativeTools === true;
      if (!provider && !nativeTools) {
        return await finish(options.tasks, running, {
          status: 'blocked', taskId, error: 'CAPABILITY_UNAVAILABLE: 当前 17dz 上下文未提供可执行能力。',
        });
      }
      const workerTools = provider?.tools() ?? [];
      if (workerTools.length === 0 && !nativeTools) {
        return await finish(options.tasks, running, { status: 'blocked', taskId, error: 'CAPABILITY_UNAVAILABLE: 当前 17dz 上下文没有可用工具。' });
      }
      const messages = [...(existing?.workerMessages ?? []), { role: 'user', content: args.answer ? `${args.request}\n用户补充：${args.answer}` : args.request, timestamp: Date.now() } as unknown as DriverMessage];
      const deadline = Date.now() + (profile.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS);
      try {
        const result = await options.workerDriver.run({
          systemPrompt: workerSystemPrompt(profile.root, skills, skillText, workerTools),
          tools: workerTools,
          messages: messages as DriverMessage[],
          cwd: profile.root,
          skillRoots: profile.skillRoots,
          sessionId: taskId,
          onStep: ctx.trusted.onStep ?? (() => {}),
          exec: async (name, toolArgs, signal) => {
            if (!provider) throw new ToolUserError('当前 Worker 未配置外部工具执行器。');
            if (!workerTools.some((tool) => tool.name === name)) {
              throw new ToolUserError('该工具未被 17dz 上下文授权。');
            }
            try {
              return await provider.call(name, toolArgs, signal);
            } catch (error) {
              if (error instanceof ToolUserError) throw error;
              throw new ToolUserError(error instanceof Error ? error.message : String(error));
            }
          },
          deadline,
        });
        const classified = classifyWorkerText(result.text);
        const final: PlatformTaskResult = {
          status: classified.status,
          taskId,
          ...(result.text.trim() ? { answer: result.text } : {}),
          ...(classified.questions ? { questions: classified.questions } : {}),
        };
        await options.tasks.upsert({
          ...running,
          status: final.status,
          workerMessages: result.messages as unknown[],
          ...(final.questions ? { pendingQuestions: final.questions } : {}),
          lastResult: final,
          updatedAt: new Date().toISOString(),
        });
        return final;
      } catch (error) {
        return await finish(options.tasks, running, {
          status: 'failed', taskId, error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

async function finish(repo: PlatformTaskRepo, base: PlatformTaskRecord, result: PlatformTaskResult): Promise<PlatformTaskResult> {
  await repo.upsert({ ...base, status: result.status, lastResult: result, updatedAt: new Date().toISOString() });
  return result;
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
  return {
    root,
    skillRoots,
    workerTimeoutMs: configured.workerTimeoutMs,
    commandTimeoutMs: configured.commandTimeoutMs,
  };
}

interface ResolvedContextProfile {
  root: string;
  skillRoots: string[];
  workerTimeoutMs?: number;
  commandTimeoutMs?: number;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

class CompositeSkillRegistry implements SkillRegistry {
  private readonly registries: SkillRegistry[];
  constructor(registries: readonly SkillRegistry[]) { this.registries = [...registries]; }
  async discover(): Promise<readonly SkillMetadata[]> {
    const all = (await Promise.all(this.registries.map((registry) => registry.discover()))).flat();
    const names = new Set<string>();
    return all.filter((skill) => !names.has(skill.name) && names.add(skill.name));
  }
  async read(name: string) {
    // Common fshine skills have precedence when a profile happens to mount a
    // directory containing the same name. Discovery still de-duplicates the
    // visible metadata, so a duplicate cannot expand the prompt.
    for (const registry of this.registries) {
      try { return await registry.read(name); } catch { /* try the next root */ }
    }
    throw new Error(`未找到技能:${name}`);
  }
}

async function readSkills(registry: SkillRegistry, skills: readonly SkillMetadata[]): Promise<string> {
  const loaded = await Promise.all(skills.map((skill) => registry.read(skill.name)));
  return loaded.map((skill) => `## ${skill.name}\n${skill.content}`).join('\n\n');
}

function workerSystemPrompt(root: string, skills: readonly SkillMetadata[], skillText: string, tools: readonly DiscoveredTool[]): string {
  return [
    '你是 幻账平台任务 Worker。你在受信工作目录中为主 Agent 执行一项具体任务。',
    `平台工作目录：${root}`,
    '只能基于工具结果和工作目录中的平台知识回答；实时账务数据必须调用可用工具，不得编造。',
    '遇到缺少选择或需要用户确认时，明确提出问题；不要自行提交写操作。',
    `可用工具：${tools.map((tool) => `${tool.name}:${tool.description}`).join('\n')}`,
    `已加载技能：${skills.map((skill) => skill.name).join(', ') || '无'}`,
    skillText,
  ].join('\n\n');
}

function classifyWorkerText(text: string): { status: PlatformTaskResult['status']; questions?: string[] } {
  const trimmed = text.trim();
  if (!trimmed) return { status: 'failed' };
  if (/(请选择|请提供|需要.*(选择|补充)|存在歧义|无法确定)/.test(trimmed)) return { status: 'needs_input', questions: [trimmed] };
  if (/(等待确认|请确认|预览|是否提交|是否执行)/.test(trimmed)) return { status: 'preview' };
  if (/(无法继续|不支持|权限不足|阻止执行)/.test(trimmed)) return { status: 'blocked' };
  return { status: 'completed' };
}
