/**
 * 进程内告警引擎 · 确定性用例（假时钟 + 假定时器 + 假投递端口，零网络、零 WS）。
 *
 * 六条用例（owner 2026-11-20 要求）：
 *   1. 运行中注入 host_fault 事件 → alerts.jsonl 出现一行（字段齐、含 raw）+ 推送被发起；
 *   2. 同 subject 冷却窗口内第二次 → 不推、不重写行；
 *   3. 重启：新实例对同一 subject 不重发（冷却持久化）；alerts.jsonl 追加不是覆盖；
 *   4. 聚合规则：retry_storm 在扫描周期内命中（可注入时钟 + 短周期）；
 *   5. AI 可消费：一行 jsonl 用 JSON.parse 解出字段齐全（守卫断言形状，不只断言文件存在）；
 *   6. 反向绊线（实测红后还原）：
 *      (a) 去掉 server 的 log→observe 接线 → 用例 1 红；
 *      (b) 去掉冷却持久化（evaluateAndPersistAlerts 不读回状态） → 用例 3 红。
 *
 * 事件形状取真生产者：host_fault（结构化事件）、execution（底账投影）、
 * host_fault_reported 的判据全在 alert-rules.ts（本测试不复制规则）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig, ChannelRoute, DeliveryReceipt, IncomingChannelMessage } from '@fshine/contracts';
import { openTaskStore } from '@fshine/core';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { TurnDriver } from '../../packages/agent/src/driver-contract';
import type { AlertTimers } from './inprocess-alerts';
import { createInprocessAlerts, SCAN_INTERVAL_MS } from './inprocess-alerts';
import { createServer, type FileDeliveryPort } from './server';
import { readAlertsState } from '../../packages/agent/src/alert-persistence';

const NOW_ISO = '2026-11-20T09:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const OWNER: ChannelRoute = { channel: 'wecom', conversationId: 'owner-user' };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'inproc-alerts-'));
  dirs.push(dir);
  return dir;
}

/** 假定时器：不真 sleep；手动 fire。 */
function fakeTimers(): AlertTimers & { fire(): void; cleared: () => number } {
  let cb: (() => void) | undefined;
  let clearedCount = 0;
  return {
    set(callback) { cb = callback; return 1; },
    clear() { clearedCount += 1; cb = undefined; },
    fire() { const current = cb; cb = undefined; current?.(); },
    cleared: () => clearedCount,
  };
}

/** 假推送端口：记录每次推送文本。 */
function fakePush() {
  const pushed: string[] = [];
  return {
    pushed,
    port: {
      async sendText(_route: ChannelRoute, text: string) {
        pushed.push(text);
        return { parts: [{ kind: 'text' }] };
      },
    },
  };
}

function readLines(jsonlPath: string): Array<Record<string, unknown>> {
  if (!existsSync(jsonlPath)) return [];
  return readFileSync(jsonlPath, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

/** host_fault 结构化事件（真生产者形状：event=host_fault, failureKind=host_fault）。 */
function hostFaultEvent(taskId: string): Record<string, unknown> {
  return {
    event: 'host_fault',
    taskId,
    failureKind: 'host_fault',
    message: '我方执行层装配缺陷',
  };
}

function makeEngine(dir: string, opts: {
  timers: AlertTimers;
  nowMs?: () => number;
  push?: ReturnType<typeof fakePush>;
  logs?: Array<Record<string, unknown>>;
}) {
  return createInprocessAlerts({
    opsDir: dir,
    dbPath: path.join(dir, 'state.db'),
    scanIntervalMs: SCAN_INTERVAL_MS,
    timers: opts.timers,
    now: () => new Date(opts.nowMs?.() ?? NOW_MS),
    log: (line) => opts.logs?.push(line),
    ...(opts.push === undefined ? {} : { ownerRoute: OWNER, pushPort: opts.push.port }),
  });
}

describe('进程内告警引擎', () => {
  it('1. 注入 host_fault 事件 → jsonl 出现一行（字段齐、含 raw）+ 推送被发起', async () => {
    const dir = tempDir();
    const timers = fakeTimers();
    const push = fakePush();
    const logs: Array<Record<string, unknown>> = [];
    const engine = makeEngine(dir, { timers, push, logs });
    try {
      engine.observe(hostFaultEvent('task-hf-1'));
      // 推送是异步 promise：让微任务跑完。
      await Promise.resolve();
      await Promise.resolve();

      const lines = readLines(path.join(dir, 'alerts.jsonl'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        v: 1,
        rule: 'host_fault_reported',
        severity: 'critical',
        subject: 'task:task-hf-1',
        taskId: 'task-hf-1',
      });
      expect(typeof lines[0]!['id']).toBe('string');
      expect(typeof lines[0]!['evidenceRef']).toBe('string');
      expect(typeof lines[0]!['at']).toBe('string');
      expect(typeof lines[0]!['summary']).toBe('string');
      // raw 全文保留（含原始事件原文）。
      expect(String(lines[0]!['raw'])).toContain('task-hf-1');
      expect(String(lines[0]!['raw'])).toContain('host_fault');
      // 推送被发起（假端口记录到）。
      expect(push.pushed).toHaveLength(1);
      expect(push.pushed[0]).toContain('host_fault_reported');
      // 观测事件：落盘 + 推送各一条。
      expect(logs.some((line) => line['event'] === 'alert_persisted')).toBe(true);
      expect(logs.some((line) => line['event'] === 'alert_pushed')).toBe(true);
    } finally {
      engine.close();
    }
  });

  it('2. 同 subject 冷却窗口内第二次 → 不推、不重写行', async () => {
    const dir = tempDir();
    const timers = fakeTimers();
    const push = fakePush();
    const engine = makeEngine(dir, { timers, push });
    try {
      engine.observe(hostFaultEvent('task-cool'));
      await Promise.resolve();
      await Promise.resolve();
      engine.observe(hostFaultEvent('task-cool'));
      await Promise.resolve();
      await Promise.resolve();

      expect(readLines(path.join(dir, 'alerts.jsonl'))).toHaveLength(1);
      expect(push.pushed).toHaveLength(1);
      const state = readAlertsState(path.join(dir, 'alerts-state.json'));
      expect(Object.keys(state.cooldown)).toEqual(['host_fault_reported\u0000task:task-cool']);
    } finally {
      engine.close();
    }
  });

  it('3. 重启：新实例对同一 subject 不重发；jsonl 是追加不是覆盖', () => {
    const dir = tempDir();
    const first = makeEngine(dir, { timers: fakeTimers() });
    first.observe(hostFaultEvent('task-restart'));
    first.close();
    const afterFirst = readLines(path.join(dir, 'alerts.jsonl'));
    expect(afterFirst).toHaveLength(1);

    // 新实例（模拟重启）：同一 subject 仍在 30 分钟冷却内 → 不重发。
    const push = fakePush();
    const second = makeEngine(dir, { timers: fakeTimers(), push });
    try {
      second.observe(hostFaultEvent('task-restart'));
      const afterSecond = readLines(path.join(dir, 'alerts.jsonl'));
      // 追加而非覆盖：原有那行仍在，且没有新增第二行。
      expect(afterSecond).toHaveLength(1);
      expect(afterSecond[0]!['id']).toBe(afterFirst[0]!['id']);
      expect(push.pushed).toHaveLength(0);
    } finally {
      second.close();
    }
  });

  it('4. 聚合规则：retry_storm 在扫描周期内命中（注入时钟 + 短周期）', () => {
    const dir = tempDir();
    const timers = fakeTimers();
    const push = fakePush();
    const engine = makeEngine(dir, { timers, push });
    try {
      // 真正把执行事实写进只读可投影的底账（executions 表），与手动脚本同投影口径。
      seedRetryStormLedger(path.join(dir, 'state.db'));
      // 到达扫描周期：定时器触发一次扫描。
      timers.fire();

      const lines = readLines(path.join(dir, 'alerts.jsonl'));
      const storm = lines.find((line) => line['rule'] === 'retry_storm');
      expect(storm, `应有 retry_storm 告警，实际行：${JSON.stringify(lines)}`).toBeDefined();
      expect(storm!['severity']).toBe('warning');
      expect(storm!['taskId']).toBe('task-storm');
      expect(String(storm!['raw']).length).toBeGreaterThan(0);
    } finally {
      engine.close();
    }
  });

  it('5. AI 可消费：一行 jsonl 用 JSON.parse 解出字段齐全（守卫断言形状）', () => {
    const dir = tempDir();
    const engine = makeEngine(dir, { timers: fakeTimers() });
    try {
      engine.observe(hostFaultEvent('task-schema'));
      const raw = readFileSync(path.join(dir, 'alerts.jsonl'), 'utf8').trim();
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // 自包含结构化行：版本字段 + 告警项字段齐全（v:1 单源由 buildAlertLine 落）。
      expect(parsed['v']).toBe(1);
      for (const key of ['id', 'rule', 'severity', 'subject', 'evidenceRef', 'summary', 'raw', 'at', 'taskId']) {
        expect(parsed[key], `字段 ${key} 应存在`).toBeDefined();
      }
      expect(['critical', 'warning', 'info']).toContain(parsed['severity']);
      expect(new Date(String(parsed['at'])).toISOString()).toBe(String(parsed['at']));
    } finally {
      engine.close();
    }
  });
});

/** 往底账写 5 条同任务执行事实（retry_storm 阈值）：用 core 的只写引擎，与生产同库同 schema。 */
function seedRetryStormLedger(dbPath: string): void {
  const store = openTaskStore(dbPath);
  try {
    store.insertTask({
      taskId: 'task-storm',
      principalId: 'wecom:owner',
      sessionId: 'wecom:conv',
      request: '压测重试风暴',
      status: 'running',
      runningSince: NOW_ISO,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
    for (let i = 0; i < 5; i += 1) {
      store.insertExecution({
        requestId: `req-${i}`,
        taskId: 'task-storm',
        operation: 'dummy.query',
        status: 'failed',
        error: { code: 'E_STORM' },
      });
    }
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// server 装配级接线（真生产者）：server 的结构化事件经 log→observe 就地判。
// 反向绊线 (a)：去掉 server.ts 的 log→observe 接线，本用例红。
// 用 execution_accepted_undeclared（协议违约 = host_fault 规则命中）作真实事件源：
// 后台执行器返回 accepted，而执行面 manifest 未声明 long_running → runtime 落该事件。
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');
const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }], // 未声明 long_running
};

/** 执行面：manifest 未声明 long_running，但 execute 返回 accepted → 协议违约。 */
class ProtocolViolationClient implements ExecutionClient {
  async capabilities(): Promise<CapabilityManifest> { return MANIFEST; }
  async execute(): Promise<ExecutionOutcome> {
    return { status: 'accepted', operationId: 'op-violation', pollAfterMs: 5 };
  }
}

/** Main 只交办一句（任务交办 = 回合非空）。 */
function delegatingMain(): TurnDriver {
  return {
    async run(input) {
      // 真实 Pi：工具错误变成工具结果交回模型，不抛出（这里任务同步失败也不让回合挂掉）。
      await input.exec('task_run', { task: '触发协议违约' }).catch(() => undefined);
      return { text: '已受理。', messages: [...input.messages, { role: 'assistant', content: '已受理。' } as never] };
    },
  };
}

/** Worker：调用 execute_operation（执行面会返回未声明的 accepted → runtime 落协议违约事件）。 */
function protocolViolationWorker(): TurnDriver {
  return {
    async run(input) {
      await input.exec('execute_operation', { operation: 'dummy.query', args: {} }).catch(() => undefined);
      return { text: '（测试）worker 收尾。', messages: [...input.messages, { role: 'assistant', content: '（测试）worker 收尾。' } as never] };
    },
  };
}

class SilentDelivery implements FileDeliveryPort {
  readonly deliveryMode = 'live' as const;
  async sendToConversation(route: ChannelRoute): Promise<DeliveryReceipt> {
    return { route, parts: [] };
  }
  async sendText(route: ChannelRoute, text: string): Promise<DeliveryReceipt> {
    return { route, parts: [{ kind: 'text', index: 0, status: 'sent' }] };
  }
}

function serverConfig(): AppConfig {
  return {
    principals: { 'wecom:owner': { enabled: true, role: 'operator' } },
    contextProfiles: { dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] } },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
  };
}

function serverIncoming(): IncomingChannelMessage {
  return {
    wecomUserId: 'owner',
    channel: 'wecom',
    conversationId: 'conv-owner',
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    chatType: 'single',
    text: '帮我触发一次协议违约',
    receivedAt: new Date().toISOString(),
  };
}

async function waitFor(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try { assertion(); return; } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe('server 装配接线：结构化事件 → 进程内告警（反向绊线 a 的锚）', () => {
  it('server 运行中产出协议违约事件 → alerts.jsonl 出现 host_fault_reported 一行 + 推送被发起', async () => {
    const dir = tempDir();
    const push = fakePush();
    const timers = fakeTimers();
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: serverConfig(),
      dbPath: path.join(dir, 'state.db'),
      createDrivers: () => ({ mainDriver: delegatingMain(), workerDriver: protocolViolationWorker() }),
      createExecutionFace: async () => ({ client: new ProtocolViolationClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      fileDelivery: new SilentDelivery(),
      logger: () => {},
      inprocessAlerts: {
        enabled: true,
        opsDir: dir,
        ownerRoute: OWNER,
        pushPort: push.port,
        timers,
        scanIntervalMs: SCAN_INTERVAL_MS,
        now: () => new Date(NOW_MS),
      },
    });
    try {
      await server.handler(serverIncoming());
      await waitFor(() => {
        const lines = readLines(path.join(dir, 'alerts.jsonl'));
        expect(lines.some((line) => line['rule'] === 'host_fault_reported')).toBe(true);
      });
      const line = readLines(path.join(dir, 'alerts.jsonl')).find((l) => l['rule'] === 'host_fault_reported')!;
      expect(line['v']).toBe(1);
      expect(line['severity']).toBe('critical');
      expect(typeof line['raw']).toBe('string');
      expect(String(line['raw'])).toContain('execution_accepted_undeclared');
      await waitFor(() => expect(push.pushed.length).toBeGreaterThan(0));
      expect(push.pushed[0]).toContain('host_fault_reported');
    } finally {
      await server.close();
    }
  });
});
