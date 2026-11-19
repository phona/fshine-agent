/**
 * ops/alerts：运营告警巡检（仓内只读脚本，不进产品运行时）。
 *
 * 为什么需要它：用户侧已经改成「静默到有结果」，出事必须由我们自己看得见。本脚本把
 * `.runtime/server/wecom-live.log`（增量）与 `.runtime/state.db`（只读打开）投影成结构化
 * 事实，交给 packages/agent/src/alert-rules.ts 判成告警，命中后**双出口**：
 *   ① 追加到 `.runtime/ops/alerts.jsonl`（每行含**原始文本** raw；超长时另落
 *      `.runtime/ops/evidence/<id>.txt` 并在行里给路径）；
 *   ② 通过企微主动文字（SDK `sendMessage`，即宿主 sendText 同一通道）推给 owner 账号。
 *
 * 用法：
 *   npm run alerts                 # 缺省 --dry-run：只打印命中，不落盘、不推送
 *   npm run alerts -- --run        # 真正落盘 alerts.jsonl 并推送 owner
 *   npm run alerts -- --config=<path>   # 与 ask/tasks/ops 同义（决定 dbPath 与收件人）
 *
 * 边界（硬约束，见 docs/ops/alerts.md）：
 *   · **绝不改任务事实 / 绝不重启服务 / 绝不写 state.db**：state.db 一律只读打开，
 *     不建库、不迁移、不触碰一行；
 *   · 告警本身只带摘要，但每条告警凭 evidenceRef（messageId / taskId / 日志字节偏移 /
 *     事件 id）+ raw **回到当时的原始文本**；既有日志原文不因「对用户收口」而删——
 *     这是不变量，不是实现细节；
 *   · 推送失败只记一条 `alert_push_failed`，**不影响落盘**；
 *   · 收件人 userid 从 config/agent.yaml 的 principals 里取（enabled 的单聊主体），
 *     **不硬编码**；凭据取部署配置/`.env` 的 WECOM_BOT_ID / WECOM_BOT_SECRET。
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WSClient } from '@wecom/aibot-node-sdk';
import { effectiveDeploymentEnv, loadConfig, openTaskStore } from '@fshine/core';
import type { AppConfig } from '@fshine/contracts';
import {
  evaluateAlerts,
  type AlertCooldownState,
  type AlertFact,
  type AlertItem,
} from '../../packages/agent/src/alert-rules';
import { explicitConfigFrom } from '../resolve-config-path';
import { resolveTaskDbPath } from '../tasks';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 缺省日志路径（server 的标准输出重定向落点；部署可 --log 覆盖）。 */
export const DEFAULT_LOG_PATH = path.join(REPO_ROOT, '.runtime', 'server', 'wecom-live.log');
/** 缺省 ops 落点目录（与 `npm run ops` 同目录，.runtime/ 已 gitignore）。 */
export const DEFAULT_OPS_DIR = path.join(REPO_ROOT, '.runtime', 'ops');
/** raw 内联上限（字节）：超过时另落证据文件，但 raw 字段仍保留全文、绝不截断。 */
export const EVIDENCE_INLINE_LIMIT_BYTES = 8192;
/** 企微连接/认证超时（毫秒）。 */
const WECOM_CONNECT_TIMEOUT_MS = 15_000;

const USAGE = '用法：npm run alerts [-- --run] [--config=<path>] [--log=<path>]\n'
  + '  缺省 --dry-run：只打印命中；--run 才落盘 alerts.jsonl 并推送 owner。';

/** 持久化状态：日志增量偏移 + 冷却表（同一 subject 冷却窗口内只告一次）。 */
export interface AlertsState {
  version: 1;
  /** 已在上一轮消费到的日志字节偏移（下一轮从此处续读）。 */
  logOffset: number;
  /** 冷却状态：`${rule}\u0000${subject}` → 上次告警时刻（ISO）。 */
  cooldown: AlertCooldownState;
}

export function emptyState(): AlertsState {
  return { version: 1, logOffset: 0, cooldown: {} };
}

export function parseState(raw: string | undefined): AlertsState {
  if (raw === undefined || raw.trim() === '') return emptyState();
  try {
    const parsed = JSON.parse(raw) as Partial<AlertsState>;
    return {
      version: 1,
      logOffset: typeof parsed.logOffset === 'number' && parsed.logOffset >= 0 ? parsed.logOffset : 0,
      cooldown: parsed.cooldown !== null && typeof parsed.cooldown === 'object' ? (parsed.cooldown as AlertCooldownState) : {},
    };
  } catch {
    return emptyState();
  }
}

export interface AlertsCliArgs {
  run: boolean;
  logPath?: string;
  configPath?: string;
}

export function parseAlertsArgs(argv: readonly string[]): AlertsCliArgs | { usageError: string } {
  const args: AlertsCliArgs = { run: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--run') { args.run = true; continue; }
    if (arg === '--dry-run') { args.run = false; continue; }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length).trim();
      if (value === '') return { usageError: '--config 缺少路径。' };
      args.configPath = value;
      continue;
    }
    if (arg.startsWith('--log=')) {
      const value = arg.slice('--log='.length).trim();
      if (value === '') return { usageError: '--log 缺少路径。' };
      args.logPath = value;
      continue;
    }
    if (arg.startsWith('--')) return { usageError: `未知参数：${arg}` };
    return { usageError: `不接受位置参数：${arg}` };
  }
  return args;
}

/** 从一行日志投影出事实；非结构化行（SDK 文本日志）返回 undefined。 */
export function logLineToFact(line: string, logOffset: number, nowIso: string): AlertFact | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    obj = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const event = obj['event'];
  if (typeof event !== 'string' || event === '') return undefined;

  const detail: NonNullable<AlertFact['detail']> = {};
  if (typeof obj['operation'] === 'string') detail.operation = obj['operation'];
  const error = obj['error'];
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const err = error as Record<string, unknown>;
    if (typeof err['code'] === 'string') detail.errorCode = err['code'];
    if (typeof err['kind'] === 'string') detail.failureKind = err['kind'];
  }
  if (typeof obj['failureKind'] === 'string') detail.failureKind = obj['failureKind'];
  if (event === 'file_delivery' && typeof obj['status'] === 'string') detail.deliveryStatus = obj['status'];
  // 投递结果（2026-11-19 第 3 档接线）：`notification_delivery_terminal` 的 exhausted/skipped、
  // `task_long_running_notice` 的 sent/failed——判据只在 isDeliveryFailure 里，不在这里猜。
  if (typeof obj['result'] === 'string') detail.deliveryResult = obj['result'];
  // 部署模式事实（跳过终局带）：live + skipped 要告警（渠道配错）。
  if (typeof obj['deliveryMode'] === 'string') detail.deliveryMode = obj['deliveryMode'];
  if (typeof obj['taskStatus'] === 'string') detail.taskStatus = obj['taskStatus'];

  const fact: AlertFact = {
    source: 'log',
    event,
    // 结构化行普遍不带时间戳：事实时刻取处理时刻（task_stuck 只走底账，不依赖此值）。
    at: typeof obj['at'] === 'string' ? obj['at'] : nowIso,
    raw: line,
    logOffset,
  };
  if (typeof obj['taskId'] === 'string') fact.taskId = obj['taskId'];
  if (typeof obj['principalId'] === 'string') fact.principalId = obj['principalId'];
  if (typeof obj['sessionId'] === 'string') fact.sessionId = obj['sessionId'];
  if (typeof obj['messageId'] === 'string') fact.messageId = obj['messageId'];
  if (Object.keys(detail).length > 0) fact.detail = detail;
  return fact;
}

export interface LogScanResult {
  facts: AlertFact[];
  /** 消费到的字节偏移（只到最后一个完整行；半行留给下一轮）。 */
  nextOffset: number;
}

/** 从 offset 增量读日志，解析为事实。半行不消费（避免读到写一半的行）。 */
export function scanLog(logPath: string, fromOffset: number, nowIso: string): LogScanResult {
  if (!existsSync(logPath)) return { facts: [], nextOffset: fromOffset };
  const size = statSync(logPath).size;
  // 文件被截断/轮转（size < offset）时从头再读，避免永久漏读。
  const start = size < fromOffset ? 0 : fromOffset;
  if (size <= start) return { facts: [], nextOffset: start };
  const length = size - start;
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(logPath, 'r');
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  const chunk = buffer.toString('utf8');
  const lastNewline = chunk.lastIndexOf('\n');
  // 无完整行 = 整段都是半行，保留不动，下一轮再读。
  if (lastNewline < 0) return { facts: [], nextOffset: start };
  const complete = chunk.slice(0, lastNewline + 1);
  const facts: AlertFact[] = [];
  let cursor = start;
  for (const line of complete.split('\n')) {
    if (line !== '') {
      const fact = logLineToFact(line, cursor, nowIso);
      if (fact !== undefined) facts.push(fact);
    }
    cursor += Buffer.byteLength(line, 'utf8') + 1; // + '\n'
  }
  return { facts, nextOffset: start + Buffer.byteLength(complete, 'utf8') };
}

/** 把任务/执行底账行投影成事实（只读，绝不写）。 */
export function ledgerFacts(dbPath: string): { facts: AlertFact[]; note?: string } {
  if (!existsSync(dbPath)) return { facts: [], note: `底账不存在，跳过：${dbPath}` };
  let store;
  try {
    store = openTaskStore(dbPath, { readOnly: true });
  } catch (error) {
    return { facts: [], note: `底账只读打开失败，跳过：${error instanceof Error ? error.message : String(error)}` };
  }
  const facts: AlertFact[] = [];
  try {
    for (const stored of store.listTasks()) {
      const task = stored.task;
      const at = task.updatedAt;
      if (task.status === 'running' || task.status === 'waiting_user') {
        const since = task.status === 'waiting_user'
          ? (task.waitingSince ?? task.updatedAt)
          : (task.runningSince ?? task.updatedAt);
        facts.push({
          source: 'ledger',
          event: 'task_state',
          at: since,
          raw: JSON.stringify(task),
          taskId: task.taskId,
          principalId: task.principalId,
          sessionId: task.sessionId,
          evidenceRef: `task:${task.taskId}`,
          detail: { taskStatus: task.status },
        });
      }
      for (const execution of stored.executions) {
        const detail: NonNullable<AlertFact['detail']> = {
          operation: execution.operation,
          // 结局状态进投影：retry_storm 的 (operation, 错误码) 计数只认失败类结局，
          // 成功/待确认/受理等合法重复不算（2026-11-19 真部署假阳性修复）。
          status: execution.status,
        };
        const err = execution.error;
        if (err !== null && typeof err === 'object' && !Array.isArray(err)) {
          const e = err as Record<string, unknown>;
          if (typeof e['code'] === 'string') detail.errorCode = e['code'];
        }
        facts.push({
          source: 'ledger',
          event: 'execution',
          at,
          raw: JSON.stringify(execution),
          taskId: task.taskId,
          principalId: task.principalId,
          sessionId: task.sessionId,
          evidenceRef: `task:${task.taskId}`,
          detail,
        });
      }
    }
  } finally {
    store.close();
  }
  return { facts };
}

/** 从配置取 owner 收件人：enabled 的单聊（非群）企微主体的 userid；不硬编码。 */
export function resolveRecipients(config: AppConfig): string[] {
  const out: string[] = [];
  for (const [id, principal] of Object.entries(config.principals)) {
    if (!principal.enabled) continue;
    if (!id.startsWith('wecom:')) continue;
    if (id.startsWith('wecom:group:')) continue;
    const userid = id.slice('wecom:'.length).trim();
    if (userid !== '') out.push(userid);
  }
  return out;
}

export interface PushResult {
  ok: boolean;
  error?: string;
}

/** 通过企微主动文字通道推送（SDK sendMessage；宿主 sendText 同源）。 */
export async function pushWecomText(input: {
  botId: string;
  botSecret: string;
  recipients: readonly string[];
  text: string;
  connectTimeoutMs?: number;
}): Promise<PushResult> {
  if (input.botId.trim() === '' || input.botSecret.trim() === '') {
    return { ok: false, error: '缺少 WECOM_BOT_ID / WECOM_BOT_SECRET' };
  }
  const client = new WSClient({
    botId: input.botId.trim(),
    secret: input.botSecret.trim(),
    maxReconnectAttempts: 0,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('连接企微超时')),
        input.connectTimeoutMs ?? WECOM_CONNECT_TIMEOUT_MS,
      );
      client.on('authenticated', () => { clearTimeout(timer); resolve(); });
      client.on('error', (error: Error) => { clearTimeout(timer); reject(error); });
      client.connect();
    });
    for (const recipient of input.recipients) {
      await client.sendMessage(recipient, { msgtype: 'markdown', markdown: { content: input.text } });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try { client.disconnect(); } catch { /* 断开失败不影响结果 */ }
  }
}

interface AlertLine extends AlertItem {
  id: string;
  evidencePath?: string;
}

/** 把一条告警序列化为落盘行；超长原文另落证据文件（raw 仍保留全文）。 */
export function buildAlertLine(item: AlertItem, id: string, opsDir: string): { line: AlertLine; evidenceWritten?: string } {
  const bytes = Buffer.byteLength(item.raw, 'utf8');
  if (bytes <= EVIDENCE_INLINE_LIMIT_BYTES) {
    return { line: { ...item, id } };
  }
  const evidenceDir = path.join(opsDir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, `${id}.txt`);
  writeFileSync(evidencePath, item.raw, 'utf8');
  return { line: { ...item, id, evidencePath }, evidenceWritten: evidencePath };
}

function renderPushText(items: readonly AlertItem[]): string {
  const head = `**运维告警**（${items.length} 条）`;
  const body = items.map((item, index) => {
    return `${index + 1}. [${item.severity}] ${item.rule} · ${item.summary}\n   证据：${item.evidenceRef}`;
  }).join('\n');
  return `${head}\n\n${body}`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const parsed = parseAlertsArgs(argv);
  if ('usageError' in parsed) {
    console.error(parsed.usageError);
    console.error(USAGE);
    return 2;
  }
  const opsDir = DEFAULT_OPS_DIR;
  const logPath = parsed.logPath !== undefined ? path.resolve(parsed.logPath) : DEFAULT_LOG_PATH;
  const statePath = path.join(opsDir, 'alerts-state.json');
  const jsonlPath = path.join(opsDir, 'alerts.jsonl');

  const state = parseState(existsSync(statePath) ? readFileSync(statePath, 'utf8') : undefined);

  // dbPath：显式 --config / AGENT_CONFIG_PATH / DB_PATH / 缺省 .runtime/state.db（与 tasks/ops 同源）。
  const configExplicit = parsed.configPath ?? explicitConfigFrom(argv, process.env);
  const { dbPath } = resolveTaskDbPath({
    argv: configExplicit !== undefined ? [`--config=${configExplicit}`] : [],
    env: process.env,
    repoRoot: REPO_ROOT,
    cwd: process.cwd(),
  });

  const now = new Date();
  const nowIso = now.toISOString();
  const { facts: logFacts, nextOffset } = scanLog(logPath, state.logOffset, nowIso);
  const { facts: dbFacts, note } = ledgerFacts(dbPath);
  if (note !== undefined) console.error(JSON.stringify({ event: 'alerts_ledger_note', note }));

  const { alerts, cooldownState } = evaluateAlerts([...logFacts, ...dbFacts], {
    now,
    cooldownState: state.cooldown,
  });

  console.log(JSON.stringify({
    event: 'alerts_run_summary',
    mode: parsed.run ? 'run' : 'dry-run',
    logPath,
    dbPath,
    logFacts: logFacts.length,
    dbFacts: dbFacts.length,
    alerts: alerts.length,
  }));

  if (alerts.length === 0) return 0;

  if (!parsed.run) {
    for (const item of alerts) console.log(JSON.stringify({ event: 'alert_hit', ...item }));
    console.log('（--dry-run：未落盘、未推送；加 --run 才生效）');
    return 0;
  }

  // ① 落盘：确保 ops 目录存在，逐条 append；超长原文落证据文件。
  mkdirSync(opsDir, { recursive: true });
  const lines: string[] = [];
  alerts.forEach((item, index) => {
    const id = `${now.getTime()}-${index}-${item.rule}`;
    const { line } = buildAlertLine(item, id, opsDir);
    lines.push(JSON.stringify(line));
    console.log(JSON.stringify({ event: 'alert_persisted', id, rule: line.rule, subject: line.subject }));
  });
  appendFileSync(jsonlPath, lines.join('\n') + '\n', 'utf8');

  // ② 推送 owner（推送失败只记一条 alert_push_failed，不影响已落盘）。
  const configPath = configExplicit ?? path.join(REPO_ROOT, 'config', 'agent.yaml');
  let recipients: string[] = [];
  let env: NodeJS.ProcessEnv = process.env;
  if (existsSync(configPath)) {
    const config = loadConfig({ yamlPath: configPath, env: process.env });
    env = effectiveDeploymentEnv(config, process.env);
    recipients = resolveRecipients(config);
  } else {
    console.error(JSON.stringify({ event: 'alerts_config_missing', configPath }));
  }
  const push = await pushWecomText({
    botId: env['WECOM_BOT_ID'] ?? '',
    botSecret: env['WECOM_BOT_SECRET'] ?? '',
    recipients,
    text: renderPushText(alerts),
  });
  if (!push.ok) {
    const failure = JSON.stringify({
      event: 'alert_push_failed',
      at: nowIso,
      recipients,
      error: push.error,
      // 落盘的告警本身不受影响：失败只作为独立观测事件追加。
      alertCount: alerts.length,
    });
    appendFileSync(jsonlPath, `${failure}\n`, 'utf8');
    console.error(failure);
  } else {
    console.log(JSON.stringify({ event: 'alert_pushed', recipients, alerts: alerts.length }));
  }

  // 状态持久化：日志偏移 + 更新后的冷却表。
  const nextState: AlertsState = { version: 1, logOffset: nextOffset, cooldown: cooldownState };
  writeFileSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
  return 0;
}

if (import.meta.main) {
  await main()
    .then((code) => { if (code !== 0) process.exit(code); })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
