/**
 * 回合出口校验（handleTurn 尾部那两段互相独立的门）：**纯决策，零副作用**。
 *
 * 依赖方向铁律：本模块**不 import runtime.ts**（runtime 要用这里的决策，引回来就成环，由
 * packages/agent/architecture-shape.test.ts 的环断言守着）。住在这里的只有"这一回合能不能
 * 把模型文本当回复外发、不能时用哪段文本顶上、记哪个事件"的机械判定；打日志、写 turn、
 * 抛异常、finishDirectReply 的提前返回全部留在 runtime.ts 的调用点——判定与副作用分开，
 * 门内每一支才能用纯数据直接验证（R3）。
 *
 * 两段门（顺序即优先级，与 handleTurn 尾部一字未改）：
 *   ① 执行痕迹门：申报了实时查询（delegate / needs 回路 / 计划模式）却零执行、也没停在
 *      用户确认门时，模型的自由文本不能直接外发。门内再分两支：needs/计划模式转达
 *      （relayed || needs 线索 || 步骤事实汇总）与确定性话术收尾（activatedPlan → 干净
 *      说明附注 → NO_EXECUTION_CLARIFICATION，今天它们是提前返回）。
 *   ② 协议复读门（D-020 / F4 残留）：模型把内部协议材料原样当回复。判据**不依赖
 *      execution**——真有过执行的回合同样要拦，所以它是独立于 ① 的第二段；顶上的文本与
 *      ① 同一家族（步骤事实汇总 / needs 线索 / NO_EXECUTION_CLARIFICATION）。
 *
 * 为什么值得单独成模块：这两段门今天只能靠 runtime.test.ts 的 F4.1–F4.4 与 e2e 间接覆盖
 * （要构造整个 driver harness 才碰得到一次出口）；抽成纯函数后，每一种条件组合——尤其是
 * "有执行但协议复读"这种第二段门的形状——都能用纯数据直接钉住。
 */
import type { SubagentNeeds } from './driver';
import { messageTextFor } from './error-codes';
import { renderPlanStepsRelayFallback } from './plan-facts';
import { renderNeedsUserText } from './turn-relay';

/**
 * 收尾话术：与 runtime.ts 认同一份表值（error-codes.ts 是消息模板的唯一来源，runtime 的
 * 同名常量就是它的再导出）——这里不手抄第二份文本。
 */
const NO_EXECUTION_CLARIFICATION = messageTextFor('NO_EXECUTION_CLARIFICATION');
const ACTIVATED_PLAN_NOT_EXECUTED = messageTextFor('ACTIVATED_PLAN_NOT_EXECUTED');

/**
 * 出口校验的判定入参：全部是调用方已经从 turn / result 上取好的事实（不传对象、不传 deps，
 * 决策因此不写任何状态）。两个判据函数由调用方注入——它们的本体在 runtime.ts 一侧
 * （hasFinancialFigure 读数字正则；usefulWorkerNote 还要读执行语言指纹表与宿主持有的兜底
 * 文案常量），引回来就成环，故按 plan-binding.ts 的 planIdForTask 同族方式注入，
 * 判据仍然只有一处定义。
 */
export interface TurnExitInput {
  /** 委派是否已失败并给出安全话术（消歧问题/熔断汇总/写关闭/冷却拦截）——两段门都放行。 */
  delegationFailed: boolean;
  /** 本回合是否有平台执行痕迹（turn.execution 的真值）。 */
  execution: boolean;
  /** 本回合是否停在用户确认门（turn.pendingPlan 的真值）。 */
  pendingPlan: boolean;
  /** 模型这一轮的结果是否停在用户确认门（result.pendingPlan 的真值）。 */
  resultPendingPlan: boolean;
  /** 本回合申报的动作（null = 没有申报）。 */
  intentKind: 'conversation' | 'delegate' | null;
  /** needs 回路进行中（turn.needsRounds > 0）：Main Agent 的回复是"转达用户缺什么"。 */
  needsLoop: boolean;
  /** 计划模式回合（turn.planSteps > 0）：汇总可因"任一步真跑过"而放行。 */
  planModeTurn: boolean;
  /** needs 回路线索转达的事件字段。 */
  needsRounds: number;
  /** 计划模式步骤数的事件字段。 */
  planSteps: number;
  /** 本回合已派步骤的结局（与刚写的计划事实同源，熔断/复读兜底共用的事实源）。 */
  planStepOutcomes: readonly { label: string; outcome: 'done' | 'needs' | 'failed' }[];
  /** 最近一条结构化线索（回路兜底转达用户时用）。 */
  lastNeeds: SubagentNeeds | null;
  /** 方案已获批准但本次零执行（P1 收尾兜底）：真实状态是"批准了没执行"。 */
  activatedPlan: { planId: string; version: number } | null;
  /** 模型文本是不是内部协议材料的复读（判据本体 looksLikeProtocolMaterial 在 runtime.ts）。 */
  protocolReplay: boolean;
  /** 模型这一轮的回复文本（result.text）。 */
  resultText: string;
  /** "回复里是否带数字结论"的尺（runtime 私有判据，注入）。 */
  hasFinancialFigure: (text: string) => boolean;
  /** "worker 文本里干净有价值的说明"的准入尺（runtime 私有判据，注入）。 */
  usefulWorkerNote: (text: string) => string;
}

/**
 * 出口校验要宿主打的一条日志。`detail` 里不带 requestId——它是调用方的可信上下文，
 * 由调用方在打点时补（与 runtime 其余事件同一形状）。
 */
export interface TurnExitEvent {
  /** 打点级别：info = 正常转达，warn = 拦下了什么。 */
  level: 'info' | 'warn';
  event: string;
  detail: Record<string, unknown>;
}

/**
 * 出口校验的决策。三种结局：
 *   · `ok`：两段门都没拦，模型文本可以外发；
 *   · `relay`：不外发模型文本，用 `text` 顶上（调用方把它赋给 needsRelay，最终成为本轮
 *     回复；text 为空串时与今天一样继续走后面的空回复兜底）；
 *   · `direct`：确定性话术直接成为本轮回复（不经模型、也不进后面的空回复兜底），`outcome`
 *     是 turn_span 的结局字段。今天它们是 finishDirectReply 的提前返回，所以决策必须能
 *     表达"这段文本就是回复 + 用哪个 outcome 记账"。
 *
 * `events` 是这一路要打的日志，顺序即打点顺序。通常一条；"① 转达出的文本是空串"那条边界
 * 上会是两条（① 的 info 之后 ② 的 warn 照样截住），与今天两段门各自打点的现状一致。
 */
export type TurnExitDecision =
  | { kind: 'ok' }
  | { kind: 'relay'; text: string; events: readonly TurnExitEvent[] }
  | { kind: 'direct'; text: string; outcome: string; events: readonly TurnExitEvent[] };

/**
 * 出口校验决策。**纯函数**：不抛异常、不打日志、不写 turn、不碰存储——只回答"这一回合
 * 外发什么、记什么事件"。
 *
 * 分支顺序（一字未改）：① 执行痕迹门（转达支 / 确定性话术支）→ ② 协议复读门。
 */
export function decideTurnExit(input: TurnExitInput): TurnExitDecision {
  const explained = input.resultText.trim();
  // 模型可能把工具结果原样当回复（停在工具结果上没再说话）：那是内部协议材料
  // （任务编号、continueTaskId 字样），由宿主 composing 的转达文本顶上。
  const serializedToolResult = input.protocolReplay;
  const needsText = input.lastNeeds ? renderNeedsUserText(input.lastNeeds, '') : '';
  // 计划模式兜底：没有 needs 线索可转达时，用宿主持有的步骤事实机械汇总顶上
  // （与熔断汇总同一份步骤结局）——绝不让协议 JSON 外发。
  const planFallback = input.planModeTurn ? renderPlanStepsRelayFallback(input.planStepOutcomes) : '';
  const events: TurnExitEvent[] = [];
  let needsRelay = '';

  // ① 执行痕迹门：申报了实时查询，就必须有本轮执行痕迹（激活计划 + 至少一次平台调用），
  // 或停在用户确认门。委派已失败的（安全话术已给出）不在此列。
  // Phase 5 起多一条纠错环出口：needs 回路进行中时，Main Agent 的回复是"转达用户缺什么"，
  // 那是合法回复，不再走 delegate_without_execution 兜底——但数字结论仍然必须本轮有执行，
  // 回路本身不是执行痕迹（架构 §2 第 10 条一动不动）。
  // Phase 6 起计划模式汇总同理：有计划模式执行痕迹（任一步真跑过）即放行；
  // 全部步骤都没执行时，"三步都没查成"这种如实汇总可以外发，但数字结论仍被挡下。
  if (!input.delegationFailed && !input.execution && !input.pendingPlan && !input.resultPendingPlan
    && (input.intentKind === 'delegate' || input.needsLoop || input.planModeTurn)) {
    if ((input.needsLoop || input.planModeTurn) && !input.hasFinancialFigure(serializedToolResult ? '' : explained)) {
      // 复读时 explained 一律不可用：它是宿主与模型之间的内部协议材料（任务编号、
      // 「不要转述给用户」的 next 提示），只能由宿主自己重述事实。
      const relayed = serializedToolResult ? '' : explained;
      needsRelay = relayed || needsText || planFallback;
      const usedFallback = serializedToolResult && !relayed;
      events.push({
        level: 'info',
        event: usedFallback ? 'plan_steps_relayed_fallback' : input.needsLoop ? 'needs_loop_relayed' : 'plan_steps_relayed',
        detail: {
          ...(input.needsLoop ? { needsRounds: input.needsRounds } : { planSteps: input.planSteps }),
          ...(usedFallback ? { reason: 'serialized_tool_result', dispatchedSteps: input.planStepOutcomes.length } : {}),
        },
      });
    } else {
      events.push({
        level: 'warn',
        event: 'delegate_without_execution',
        detail: {
          ...(input.needsLoop ? { needsRounds: input.needsRounds } : input.planModeTurn ? { planSteps: input.planSteps } : {}),
        },
      });
      // 方案已获批准但查询没执行（P1 收尾兜底）：先于下面两条转达/兜底。真实状态是
      // "批准了、通知送到了、查询没跑"，缺的是执行——不能再让用户补充早就给过的范围。
      if (input.activatedPlan) {
        // worker 可能顺手留了一句有价值的说明（具体阻碍）：带上，但只在不带财务数字、
        // 且不是那句通用兜底时才算"有价值"——否则附在状态文案后面只会稀释它。
        const note = input.usefulWorkerNote(input.resultText);
        const useful = Boolean(note);
        events.push({
          level: 'warn',
          event: 'activated_plan_not_executed',
          detail: {
            planId: input.activatedPlan.planId,
            version: input.activatedPlan.version,
            ...(useful ? { withWorkerNote: true } : {}),
          },
        });
        return {
          kind: 'direct',
          text: useful ? `${ACTIVATED_PLAN_NOT_EXECUTED}\n\n${note}` : ACTIVATED_PLAN_NOT_EXECUTED,
          outcome: 'activated_plan_not_executed',
          events,
        };
      }
      // 子 Agent 可能诚实汇报了"平台要求凭单查询必须显式给出范围"这类能力边界——那是有用
      // 信息，不能整段丢掉。带上来源标注转发，用户既看到原因，也知道这不是实时查询结果。
      if (explained && !input.hasFinancialFigure(explained) && !input.protocolReplay) {
        return {
          kind: 'direct',
          text: `${explained}\n\n（以上是子 Agent 的说明；本轮没有真正查到平台数据。）`,
          outcome: 'delegate_without_execution',
          events,
        };
      }
      return { kind: 'direct', text: NO_EXECUTION_CLARIFICATION, outcome: 'delegate_without_execution', events };
    }
  }

  // ② 协议复读门（D-020 / F4 残留）：上面那块出口校验以 `!execution` 为闸门，真有过执行的
  // 回合模型文本一路直发。复读检测因此在这里独立补一道——**有执行也拦**：内部协议材料
  // （任务编号、"不要转述给用户"的 next 提示）绝不能外发。替换文本与零执行收尾同一家族：
  // 计划模式用宿主持有的步骤事实汇总，其余用 needs 线索转达。
  // 最后一级（NO_EXECUTION_CLARIFICATION）只可能被零执行形状走到——有执行 ⟹ 计划模式
  // （单步委派的执行结果以 ToolUserError 终止回合，模型根本说不上话）⟹ 步骤事实非空；
  // needs 与 execution 互斥（驱动侧 needs 只在零执行时派生）。所以这一级不会把"执行过"
  // 说成"没执行"。
  // 与澄清分支互斥：选择类澄清在上面已整体替换过回复，到不了这里。
  if (input.protocolReplay && !needsRelay && !input.delegationFailed && !input.pendingPlan && !input.resultPendingPlan) {
    needsRelay = planFallback || needsText || NO_EXECUTION_CLARIFICATION;
    events.push({
      level: 'warn',
      event: 'execution_language_leak',
      detail: {
        reason: 'protocol_material_replay',
        executed: input.execution,
        ...(input.planModeTurn ? { planSteps: input.planSteps } : {}),
        ...(needsText ? { withNeeds: true } : {}),
      },
    });
  }

  if (events.length === 0) return { kind: 'ok' };
  return { kind: 'relay', text: needsRelay, events };
}
