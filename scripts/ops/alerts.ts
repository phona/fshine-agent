/**
 * ops/alerts：运营告警巡检（仓内只读脚本，手动 / 离线诊断入口，不进产品运行时）。
 *
 * 为什么需要它：用户侧已经改成「静默到有结果」，出事必须由我们自己看得见。本脚本把
 * `.runtime/server/wecom-live.log`（增量）与 `.runtime/state.db`（只读打开）投影成结构化
 * 事实，交给 packages/agent/src/alert-rules.ts 判成告警，命中后**双出口**：
 *   ① 追加到 `.runtime/ops/alerts.jsonl`（每行含**原始文本** raw；超长时另落
 *      `.runtime/ops/evidence/<id>.txt` 并在行里给路径）；
 *   ② 通过企微主动文字（SDK `sendMessage`，即宿主 sendText 同一通道）推给 owner 账号。
 *
 * 与**进程内告警引擎**（apps/server 的 inprocess-alerts）的关系：
 *   · 两者共用 packages/agent/src/alert-rules.ts 的**同一套规则**与 alert-persistence.ts 的
 *     **同一投影 / 持久化格式 / 冷却文件 schema**（`.runtime/ops/alerts-state.json`）；
 *   · 本脚本是**进程外**诊断入口（读日志 + 只读底账）；进程内引擎就地接结构化事件 + 低频
 *     扫底账，不读自己的日志。两者可同时跑：共享冷却文件能减少重复，但非强一致。
 *
 * 用法：
 *   npm run alerts                 # 缺省 --dry-run：只打印命中，不落盘、不推送
 *   npm run alerts -- --run        # 真正落盘 alerts.jsonl 并推送 owner
 *   npm run alerts -- --config=<path>   # 与 ask/tasks/ops 同义（决定 dbPath 与收件人）
 *
 * 边界（硬约束，见 docs/ops/alerts.md）：**绝不改任务事实 / 绝不重启服务 / 绝不写 state.db**。
 * state.db 一律只读打开，不建库、不迁移、不触碰一行。
 */
import { appendFileSync, existsSync, openSync, readFileSync, readSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WSClient } from '@wecom/aibot-node-sdk';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import type { AppConfig } from '@fshine/contracts';
import { evaluateAlerts, type AlertFact } from '../../packages/agent/src/alert-rules';
import {
  appendAlertLines,
  buildAlertLine,
  EVIDENCE_INLINE_LIMIT_BYTES,
  ledgerFacts,
  logLineToFact,
  parseAlertsState,
  writeAlertsState,
  type AlertLine,
  type AlertsState,
} from '../../packages/agent/src/alert-persistence';
import { explicitConfigFrom } from '../resolve-config-path';
import { resolveTaskDbPath } from '../tasks';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 缺省日志路径（server 的标准输出重定向落点；部署可 --log 覆盖）。 */
export const DEFAULT_LOG_PATH = path.join(REPO_ROOT, '.runtime', 'server', 'wecom-live.log');
/** 缺省 ops 落点目录（与 `npm run ops` 同目录，.runtime/ 已 gitignore）。 */
export const DEFAULT_OPS_DIR = path.join(REPO_ROOT, '.runtime', 'ops');

// 共享确定性层再导出（保持脚本既有导入面；规则/投影/格式/冷却 schema 单源在 alert-persistence）。
export {
  buildAlertLine,
  EVIDENCE_INLINE_LIMIT_BYTES,
  ledgerFacts,
  logLineToFact,
};
export type { AlertLine, AlertsState };

const WECOM_CONNECT_TIMEOUT_MS = 15_000;

const USAGE = '用法：npm run alerts [-- --run] [--config=<path>] [--log=<path>]\n'
  + '  缺省 --dry-run：只打印命中；--run 才落盘 alerts.jsonl 并推送 owner。';

export function emptyState(): AlertsState {
  return { version: 1, logOffset: 0, cooldown: {} };
}

export function parseState(raw: string | undefined): AlertsState {
  return parseAlertsState(raw);
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


/** 从 offset 增量读日志，解析为事实。半行不消费（避免读到写一半的行）。 */
export function scanLog(logPath: string, fromOffset: number, nowIso: string): { facts: AlertFact[]; nextOffset: number } {
  const outFacts: AlertFact[] = [];
  if (!existsSync(logPath)) return { facts: outFacts, nextOffset: fromOffset };
  const size = statSync(logPath).size;
  // 文件被截断/轮转（size < offset）时从头再读，避免永久漏读。
  const start = size < fromOffset ? 0 : fromOffset;
  if (size <= start) return { facts: outFacts, nextOffset: start };
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
  if (lastNewline < 0) return { facts: outFacts, nextOffset: start };
  const complete = chunk.slice(0, lastNewline + 1);
  let cursor = start;
  for (const line of complete.split('\n')) {
    if (line !== '') {
      const fact = logLineToFact(line, cursor, nowIso);
      if (fact !== undefined) outFacts.push(fact);
    }
    cursor += Buffer.byteLength(line, 'utf8') + 1; // + '\n'
  }
  return { facts: outFacts, nextOffset: start + Buffer.byteLength(complete, 'utf8') };
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

function renderPushText(items: readonly { rule: string; severity: string; summary: string; evidenceRef: string }[]): string {
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

  // ① 落盘：逐条 append；超长原文落证据文件（与进程内引擎共用持久化层）。
  const lines: AlertLine[] = [];
  alerts.forEach((item, index) => {
    const id = `${now.getTime()}-${index}-${item.rule}`;
    lines.push(buildAlertLine(item, id, opsDir).line);
    console.log(JSON.stringify({ event: 'alert_persisted', id, rule: item.rule, subject: item.subject }));
  });
  appendAlertLines(jsonlPath, lines);

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
      alertCount: alerts.length,
    });
    appendFileSync(jsonlPath, `${failure}\n`, 'utf8');
    console.error(failure);
  } else {
    console.log(JSON.stringify({ event: 'alert_pushed', recipients, alerts: alerts.length }));
  }

  // 状态持久化：日志偏移 + 更新后的冷却表（schema 与进程内引擎共用）。
  writeAlertsState(statePath, { version: 1, logOffset: nextOffset, cooldown: cooldownState });
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
