/**
 * server 装配（宿主接线）：
 *   渠道消息 → 可信身份（principalId/sessionId 取自渠道事实）→ 回合运行时 → 渠道回复。
 *
 * 本切片不做（后续切片）：计划确认 / 后台派发 / 产物回收 / 提案；附件只登记不消费。
 * 执行面 = profile 声明的网关（缺省仓内 dummy CLI，不触网）；模型 = 真实 Pi 驱动（env）。
 * 任务底账 = SQLite（B 类）：会话共享一个库，list/get 按 principal+session 收口。
 *
 * P0 装配同源：门（单一 profile / gateway）与启动时装载（底账、角色文本、技能）留在本文件，
 * 门之后的装配链走 scripts/ask-runtime.ts 的共享核心（执行面/驱动/底账/提示词均可注入）——
 * 与 ask/redo、eval runner 同一装配点（守卫见 scripts/p0-assembly-single-point.test.ts）。
 * server 不做评测隔离门、不设 EXECUTION_AUDIT_PATH（部署面现行为，零变化）。
 *
 * 测试注入点（假渠道回归用，见 server.test.ts）：createDrivers / createExecutionFace；
 * 缺省实现走真实 Pi 驱动与仓内 dummy 客户端——测试替身不触碰任何真实平台。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AppConfig, ContextProfileConfig, ReplyHandler } from '@fshine/contracts';
import type { TurnDriver } from '../../packages/agent/src/driver-contract';
import { applyExecutorLabel, loadAgentProfile } from '../../packages/agent/src/agent-profile';
import { MAIN_PROTOCOL_NOTE, type Session } from '../../packages/agent/src/execution-runtime';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import { loadWorkerSkills } from '../../packages/agent/src/worker-skills';
import { assembleSessionCore, type ExecutionFace } from '../../scripts/ask-runtime';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 执行面：结构化执行客户端 + 本轮允许集合（从执行层自述的 access=read 派生）。 */
export type { ExecutionFace };

export interface ServerDeps {
  /** 生效环境（LLM_* / 渠道凭据由入口以 effectiveDeploymentEnv 合入）。 */
  env: NodeJS.ProcessEnv;
  config: AppConfig;
  /** SQLite 任务底账路径（入口缺省 .runtime/state.db）。 */
  dbPath: string;
  /** dummy 执行层审计落盘目录；缺省 .runtime/server/state。 */
  stateDir?: string;
  /** 测试注入：Pi 回合驱动工厂；缺省真实 Pi 驱动（读 env）。 */
  createDrivers?: (env: NodeJS.ProcessEnv) => { mainDriver: TurnDriver; workerDriver: TurnDriver };
  /** 测试注入：执行面；缺省仓内 dummy CLI（按 profile root+gateway spawn）。 */
  createExecutionFace?: (profile: ContextProfileConfig, env: NodeJS.ProcessEnv) => Promise<ExecutionFace>;
  logger?: (line: Record<string, unknown>) => void;
}

export interface Server {
  handler: ReplyHandler;
  close(): void;
}

/**
 * 单一 profile 解析（fail-closed）：未指定时 0 个或多个 profile 都拒绝启动，
 * 最小切片不做多 profile 选择，也不静默挑一个。
 */
export function resolveSingleProfile(config: AppConfig): { id: string; profile: ContextProfileConfig } {
  const ids = Object.keys(config.contextProfiles);
  if (ids.length !== 1) {
    throw new Error(`server 需要单一 contextProfile（当前 ${ids.length} 个）——本切片不做多 profile 选择。`);
  }
  const id = ids[0]!;
  return { id, profile: config.contextProfiles[id]! };
}

export async function createServer(deps: ServerDeps): Promise<Server> {
  const { id: profileId, profile } = resolveSingleProfile(deps.config);
  if (profile.gateway === undefined && deps.createExecutionFace === undefined) {
    throw new Error(`contextProfile ${profileId} 缺少 gateway——server 需要执行层挂载声明。`);
  }

  const log = deps.logger ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));
  const taskRegistry = createSqliteTaskRegistry(deps.dbPath);
  // 角色文本与技能面在启动时装载一次：配置坏即启动失败，不静默降级。
  const profileMd = await loadAgentProfile();
  const workerSkills = await loadWorkerSkills(profile.root, profile.skillRoots);
  const mainSystemPrompt = `${applyExecutorLabel(profileMd.instructions, profile.executorLabel)}\n\n${MAIN_PROTOCOL_NOTE}`;
  const stateDir = deps.stateDir ?? path.join(REPO_ROOT, '.runtime', 'server', 'state');

  /** 会话按（principal, session）双键缓存：群聊里不同用户不共享同一个会话对象。 */
  const sessions = new Map<string, Promise<Session>>();
  const sessionFor = (principalId: string, sessionId: string): Promise<Session> => {
    const key = `${principalId}\u0000${sessionId}`;
    let pending = sessions.get(key);
    if (pending === undefined) {
      pending = (async () => {
        // 共享装配核心：执行面缺省 = 仓内 dummy CLI（按 profile root+gateway spawn），
        // 驱动缺省 = 真实 Pi 驱动；底账/提示词/技能为启动时装载的同一份（注入不回写）。
        const assembled = await assembleSessionCore({
          env: deps.env,
          profile,
          principalId,
          sessionId,
          dbPath: deps.dbPath,
          stateDir,
          emptyOperationsMessage: '执行层没有声明任何只读 operation——server 拒绝以空允许集合运行。',
          taskRegistry,
          mainSystemPrompt,
          workerSkills,
          ...(deps.createDrivers !== undefined ? { createDrivers: deps.createDrivers } : {}),
          ...(deps.createExecutionFace !== undefined ? { createExecutionFace: deps.createExecutionFace } : {}),
        });
        return assembled.session;
      })();
      sessions.set(key, pending);
      // 建立失败不缓存：fail-closed 的错误不钉死给后续消息。
      pending.catch(() => sessions.delete(key));
    }
    return pending;
  };

  const handler: ReplyHandler = async (message) => {
    const channel = (message.channel ?? 'wecom').trim() || 'wecom';
    // 可信身份取自渠道事实：principal = 发消息的人，session = 聊天窗口（conversationId）。
    const principalId = `${channel}:${message.wecomUserId}`;
    const sessionId = `${channel}:${message.conversationId}`;
    const principal = deps.config.principals[principalId];
    if (principal === undefined || principal.enabled !== true) {
      log({ event: 'message_refused', principalId, sessionId, messageId: message.messageId, reason: 'principal_not_enabled' });
      return `该账号（${principalId}）未开通使用权限，请联系管理员开通。`;
    }
    if (message.attachmentOnly === true) {
      // 本切片不消费附件（登记缺口：附件暂存/注入归后续切片）；空回复让渠道走文件收据窗。
      log({ event: 'message_attachment_only', principalId, sessionId, messageId: message.messageId });
      return '';
    }
    const session = await sessionFor(principalId, sessionId);
    const turn = await session.send(message.text);
    log({
      event: 'message_done',
      principalId,
      sessionId,
      messageId: message.messageId,
      taskIds: [...turn.taskIds],
      executions: turn.executions.map((execution) => ({
        requestId: execution.requestId,
        operation: execution.operation,
        status: execution.status,
      })),
    });
    return turn.reply;
  };

  return {
    handler,
    close() {
      sessions.clear();
      taskRegistry.close();
    },
  };
}
