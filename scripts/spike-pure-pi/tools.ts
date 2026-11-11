/**
 * 工具面：只装配 pi-agent-core 自带的执行工具（bash / read / write / edit + NodeExecutionEnv）。
 *
 * 没有 fshine 的工具描述、没有 route_current_turn、没有计划命令拦截器：
 * 模型看到的 bash 就是 pi 原生的 bash，命令原样由 NodeExecutionEnv 执行。
 *
 * 唯一的宿主动作是"计划已在平台停在 notify/confirm 时的放行签名"：平台
 * `plan.activate` 要宿主持有的 HMAC 密钥，模型侧 shell 环境里没有它。
 * 这不是预算裁档——裁档完全由平台 `plan.evaluate` 做；宿主只按平台的 decision
 * 做协议要求的那一步（notify=通知已送达；confirm=用户明确确认后）。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/harness/env/nodejs';
import type { AgentHarnessTool, ExecutionEnv } from '@earendil-works/pi-agent-core';
import { activatePlan, type PlatformHandle } from './platform';

export interface PlanObservation {
  planId: string;
  decision: string;
  status?: string;
  noticeText?: string;
  estimate?: unknown;
  at: string;
}

export interface ActivationRecord {
  planId: string;
  evidence: 'notification-delivered' | 'user-confirmed';
  ok: boolean;
  error?: string;
  at: string;
}

/** 平台计划门的宿主侧观察与放行（只读平台 decision，不重算预算档位）。 */
export class HostPlanGate {
  readonly observations: PlanObservation[] = [];
  readonly activations: ActivationRecord[] = [];
  pendingConfirm: PlanObservation | undefined;

  constructor(
    private readonly platform: PlatformHandle,
    private readonly secret: string,
  ) {}

  observeToolOutput(text: string): void {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{') || !trimmed.includes('"planId"') || !trimmed.includes('"decision"')) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      const planId = parsed['planId'];
      const decision = parsed['decision'];
      if (typeof planId !== 'string' || typeof decision !== 'string') continue;
      const observation: PlanObservation = {
        planId,
        decision,
        status: typeof parsed['status'] === 'string' ? parsed['status'] : undefined,
        noticeText: typeof parsed['noticeText'] === 'string' ? parsed['noticeText'] : undefined,
        estimate: parsed['estimate'],
        at: new Date().toISOString(),
      };
      this.observations.push(observation);
      if (decision === 'notify') {
        this.activate(planId, 'notification-delivered');
      } else if (decision === 'confirm') {
        this.pendingConfirm = observation;
      } else if (decision === 'execute' || decision === 'stop') {
        this.pendingConfirm = undefined;
      }
    }
  }

  /** 用户明确确认后放行停在 confirm 门上的计划。 */
  confirmByUser(): ActivationRecord | undefined {
    const pending = this.pendingConfirm;
    if (!pending) return undefined;
    this.pendingConfirm = undefined;
    return this.activate(pending.planId, 'user-confirmed');
  }

  private activate(planId: string, evidence: 'notification-delivered' | 'user-confirmed'): ActivationRecord {
    try {
      activatePlan(this.platform, planId, evidence, this.secret);
      const record: ActivationRecord = { planId, evidence, ok: true, at: new Date().toISOString() };
      this.activations.push(record);
      return record;
    } catch (error) {
      const record: ActivationRecord = {
        planId,
        evidence,
        ok: false,
        error: (error as Error).message,
        at: new Date().toISOString(),
      };
      this.activations.push(record);
      return record;
    }
  }
}

const DUMMY_INVOCATION = {
  invocationId: 'spike-invocation',
  operationId: 'spike-operation',
  turnId: 'spike-turn',
  getMemo: async (): Promise<undefined> => undefined,
  setMemo: async (): Promise<void> => undefined,
};

type AnyHarnessTool = AgentHarnessTool<{ env: ExecutionEnv }, never, unknown>;

/**
 * AgentHarnessTool -> AgentTool 的薄适配：固定 toolContext（NodeExecutionEnv）与
 * harness Context（BACKGROUND_CONTEXT）。pi 原生工具的 execute 本体一行未改。
 */
function adapt(harnessTool: AnyHarnessTool, env: ExecutionEnv): AgentTool {
  const adapted = {
    name: harnessTool.name,
    label: harnessTool.label,
    description: harnessTool.description,
    parameters: harnessTool.parameters,
    executionMode: 'sequential',
    execute: async (
      toolCallId: string,
      params: unknown,
      _signal?: AbortSignal,
      onUpdate?: (partial: unknown) => void,
    ) => {
      const result = await harnessTool.execute(
        toolCallId,
        params as never,
        (partial) => onUpdate?.(partial),
        { env },
        DUMMY_INVOCATION,
        BACKGROUND_CONTEXT,
      );
      return result as never;
    },
  };
  return adapted as unknown as AgentTool;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text!)
    .join('\n');
}

export interface Toolset {
  tools: AgentTool[];
  env: NodeExecutionEnv;
  gate: HostPlanGate;
}

/**
 * 建一套 pi 原生工具。shellEnv 用平台给的 baseEnv（已剔除 LLM_*），
 * 模型在 bash 里看不到模型密钥，也看不到计划激活密钥。
 */
export function createToolset(platform: PlatformHandle, activationSecret: string): Toolset {
  const env = new NodeExecutionEnv({ cwd: platform.root, shellEnv: platform.baseEnv });
  const gate = new HostPlanGate(platform, activationSecret);

  const bash = createBashTool() as unknown as AnyHarnessTool;
  const observedBash: AnyHarnessTool = {
    ...bash,
    execute: async (toolCallId, params, onUpdate, toolContext, invocation, context) => {
      const result = await bash.execute(toolCallId, params, onUpdate, toolContext, invocation, context);
      gate.observeToolOutput(textOf(result as { content: Array<{ type: string; text?: string }> }));
      return result;
    },
  };

  const tools: AgentTool[] = [
    adapt(observedBash, env),
    adapt(createReadTool() as unknown as AnyHarnessTool, env),
    adapt(createWriteTool() as unknown as AnyHarnessTool, env),
    adapt(createEditTool() as unknown as AnyHarnessTool, env),
  ];
  return { tools, env, gate };
}
