/**
 * 进程内告警引擎（第 3 档的**执行者**；2026-11-20）。
 *
 * 为什么需要它（准入 ①最小可复现失败）：此前「兜不住且用户也做不了什么」的档——通知投递
 * 终局（notification_delivery_terminal/exhausted）、长活提醒失败（task_long_running_notice
 * failed）、结果投递失败（task_result_delivery_failed）、我方故障（host_fault / 协议违约）——
 * 只落进结构化日志，靠人手动跑 `npm run alerts -- --run` 才看得见。没有进程内执行者，
 * 这些告警在没人值守时**根本不会发出**。owner 决定把告警做进运行时、落本地便于回溯与 AI 分析。
 *
 * 设计（已与 owner 对齐）：
 *   · **复用纯规则**：判定只走 packages/agent/src/alert-rules.ts 的 evaluateAlerts / AlertFact，
 *     不写第二套规则；投影 / 持久化 / 冷却 schema 与手动脚本共用 alert-persistence.ts。
 *   · **事件驱动就地判**：server 产出的结构化事件（经本模块的 observe()）即时投影成 AlertFact
 *     并 evaluateAlerts —— **不读自己的日志文件**（进程外脚本才需要绕这一圈）。
 *     覆盖：host_fault_reported（host_fault / 协议违约 / 确认句柄丢失 / 装配缺陷事件）、
 *     delivery_failed（task_result_delivery_failed / notification_delivery_terminal=exhausted /
 *     task_long_running_notice=failed / file_delivery 非 sent）。
 *   · **聚合低频扫描**：retry_storm / task_stuck 需要时间窗与底账聚合，挂一个低频扫描，
 *     复用 task-runner 的单定时器模式（setTimeout 链、非 setInterval），频率用模块常量
 *     （SCAN_INTERVAL_MS = 5 分钟，**不加配置键**；测试注入短周期 / 可注入时钟 now）。
 *   · **冷却持久化**：沿用既有 30 分钟 (rule, subject) 冷却（alert-rules.ts 单源），状态落
 *     .runtime/ops/alerts-state.json（与手动脚本同 schema）——**重启不重发**。
 *   · **双出口**：① append 到 .runtime/ops/alerts.jsonl（v:1 自包含行，raw 全文，超长落
 *     evidence/<id>.txt）；② 通过 **server 自己的投递端口**（注入的 AlertPushPort.sendText，
 *     即 fileDelivery 同一渠道端口）私聊推给 owner —— **不另开企微 WS**（单 WS 约束）。
 *
 * 硬边界：不改任务事实、不写 state.db、不重启服务；告警引擎自身故障（落盘 / 推送抛错）
 * 一律 best-effort 吞掉并降级为一条观测事件，绝不影响 server 的正常事件流。
 * 不新增配置键 / 状态机 / 事件总线 / 第二套规则 / 第二套协议。
 */
import path from 'node:path';
import {
  evaluateAndPersistAlerts,
  logLineToFact,
  ledgerFacts,
  type AlertLine,
} from '../../packages/agent/src/alert-persistence';
import type { AlertFact } from '../../packages/agent/src/alert-rules';
import type { ChannelRoute } from '@fshine/contracts';

/** 聚合扫描频率（模块常量，不加配置键；参考值 5 分钟）。 */
export const SCAN_INTERVAL_MS = 5 * 60 * 1000;

/** owner 私聊投递端口（= server 既有 fileDelivery 的 sendText 面，不另开 WS）。 */
export interface AlertPushPort {
  sendText(route: ChannelRoute, text: string): Promise<{ parts: readonly unknown[] }>;
}

/** 定时器对（复用 task-runner 的 set/clear 形状；测试注入假时钟）。 */
export interface AlertTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface InprocessAlertsOptions {
  /** ops 产物目录（缺省 <dbDir>/ops，测试用临时目录隔离）。 */
  opsDir: string;
  /** 结构化事件观测出口（告警自身事件，缺省 no-op；server 传它的 log）。 */
  log?: (line: Record<string, unknown>) => void;
  /** 时钟注入（聚合扫描判定 + id 时间戳；缺省系统时钟）。 */
  now?: () => Date;
  /** 定时器注入（测试用短周期 / 手动触发；缺省真实 setTimeout 链）。 */
  timers?: AlertTimers;
  /** 扫描周期（缺省 SCAN_INTERVAL_MS；测试缩到极小值，不新增配置键）。 */
  scanIntervalMs?: number;
  /** 任务底账路径（聚合扫描只读投影；缺省 <dbDir>/state.db）。 */
  dbPath: string;
  /**
   * owner 私聊路由（投递出口；缺省无推送 = 只落盘不推）。
   * 单 WS 约束：这里用的是 server 既有投递端口，不新建 WSClient。
   */
  ownerRoute?: ChannelRoute;
  pushPort?: AlertPushPort;
}

export interface InprocessAlerts {
  /** server 产出结构化事件时调用：即时投影 + 判 + 双出口（同步落盘，异步推送）。 */
  observe(event: Record<string, unknown>): void;
  /** 立即跑一次聚合扫描（retry_storm / task_stuck）；启动与定时器都调它。 */
  scanNow(): void;
  /** 停止扫描定时器（server.close 调用；重启不重发靠冷却持久化，不靠内存）。 */
  close(): void;
}

/** 会进告警面的结构化事件（host_fault / delivery_failed 两规则的来源）。 */
const EVENT_DRIVEN_EVENTS: ReadonlySet<string> = new Set([
  'host_fault',
  'execution_accepted_undeclared',
  'task_long_task_unsupported',
  'task_result_delivery_failed',
  'notification_delivery_terminal',
  'task_long_running_notice',
  'file_delivery',
]);

/**
 * 把一条结构化事件投影成 AlertFact（就地，不读日志）。
 * 复用 alert-persistence 的 logLineToFact（与手动脚本同一投影口径）：序列化成一行 JSON 再投影，
 * 保证「进程内事件」与「进程外日志行」走的是**同一个**投影函数，口径不漂移。
 */
function projectEvent(event: Record<string, unknown>, nowIso: string): AlertFact | undefined {
  return logLineToFact(JSON.stringify(event), 0, nowIso);
}

/** 私聊推送文案（规则 + 摘要 + 证据键；与手动脚本同口径，不搬原文进推送）。 */
function renderPushText(lines: readonly AlertLine[]): string {
  const head = `**运维告警**（${lines.length} 条）`;
  const body = lines.map((line, index) =>
    `${index + 1}. [${line.severity}] ${line.rule} · ${line.summary}\n   证据：${line.evidenceRef}`,
  ).join('\n');
  return `${head}\n\n${body}`;
}

export function createInprocessAlerts(options: InprocessAlertsOptions): InprocessAlerts {
  const { opsDir, dbPath } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const jsonlPath = path.join(opsDir, 'alerts.jsonl');
  const statePath = path.join(opsDir, 'alerts-state.json');

  /**
   * 判定 + 持久化 + 推送。冷却状态在两次调用间从文件读回（重启不重发）；进程内同一时刻
   * observe 由 server 的 log 同步 serial（event loop），无并发写竞态。
   */
  const handle = (fact: AlertFact): void => {
    const result = evaluateAndPersistAlerts([fact], {
      now: now(),
      statePath,
      jsonlPath,
      opsDir,
      idPrefix: 'server',
    });
    if (result.lines.length === 0) return;
    for (const line of result.lines) {
      log({ event: 'alert_persisted', id: line.id, rule: line.rule, subject: line.subject, source: 'inprocess' });
    }
    // ② 推送 owner：走 server 既有投递端口（单 WS）；失败只记观测事件，不影响落盘。
    if (options.pushPort !== undefined && options.ownerRoute !== undefined) {
      const route = options.ownerRoute;
      const port = options.pushPort;
      void port.sendText(route, renderPushText(result.lines)).then(
        () => log({ event: 'alert_pushed', rules: result.lines.map((line) => line.rule), source: 'inprocess' }),
        (error: unknown) => log({
          event: 'alert_push_failed',
          rules: result.lines.map((line) => line.rule),
          reason: error instanceof Error ? error.message : String(error),
          source: 'inprocess',
        }),
      );
    }
  };

  const observe = (event: Record<string, unknown>): void => {
    const eventName = event['event'];
    if (typeof eventName !== 'string' || !EVENT_DRIVEN_EVENTS.has(eventName)) return;
    try {
      const fact = projectEvent(event, now().toISOString());
      if (fact !== undefined) handle(fact);
    } catch (error) {
      // 告警引擎自身故障不进 server 事件流：降级为一条观测事件，best-effort。
      log({ event: 'alert_engine_error', stage: 'observe', reason: error instanceof Error ? error.message : String(error) });
    }
  };

  const scanNow = (): void => {
    try {
      // 聚合规则只读底账（只读打开，绝不写 state.db）；事实时刻用底账的 since，now 注入。
      const { facts, note } = ledgerFacts(dbPath);
      if (note !== undefined) log({ event: 'alert_scan_ledger_note', note });
      if (facts.length === 0) return;
      const result = evaluateAndPersistAlerts(facts, {
        now: now(),
        statePath,
        jsonlPath,
        opsDir,
        idPrefix: 'server-scan',
      });
      if (result.lines.length === 0) return;
      for (const line of result.lines) {
        log({ event: 'alert_persisted', id: line.id, rule: line.rule, subject: line.subject, source: 'inprocess-scan' });
      }
      if (options.pushPort !== undefined && options.ownerRoute !== undefined) {
        const route = options.ownerRoute;
        const port = options.pushPort;
        void port.sendText(route, renderPushText(result.lines)).then(
          () => log({ event: 'alert_pushed', rules: result.lines.map((line) => line.rule), source: 'inprocess-scan' }),
          (error: unknown) => log({
            event: 'alert_push_failed',
            rules: result.lines.map((line) => line.rule),
            reason: error instanceof Error ? error.message : String(error),
            source: 'inprocess-scan',
          }),
        );
      }
    } catch (error) {
      log({ event: 'alert_engine_error', stage: 'scan', reason: error instanceof Error ? error.message : String(error) });
    }
  };

  // 单一定时器轮（复用 task-runner 模式）：每次触发后重武装，不用 setInterval（避免堆积）。
  const timers: AlertTimers = options.timers ?? {
    set(callback, delayMs) { return setTimeout(callback, delayMs); },
    clear(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
  };
  const interval = options.scanIntervalMs ?? SCAN_INTERVAL_MS;
  let timer: unknown;
  let closed = false;
  const rearm = (): void => {
    if (closed) return;
    timer = timers.set(() => {
      scanNow();
      rearm();
    }, interval);
  };
  rearm();

  return {
    observe,
    scanNow,
    close() {
      closed = true;
      timers.clear(timer);
    },
  };
}
