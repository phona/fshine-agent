/**
 * CAP-01 R2D 非结构化附件（文本型 PDF）业务用例——真模型行为读数 + 宿主机械面验收。
 *
 * 场景（一个回合，假渠道 = 直调 server.handler；装配 = apps/server/server.ts 生产缺省链，
 * 与 r2-functional 同源：dummy 执行层/run_js/fileStore/清单注入/主动投递）：
 *   用户发一张**文本型 PDF 发票**（scripts/eval/fixtures/unstructured/invoice-2026-10-18.pdf，
 *   三行：日期 / 金额 / 客户名），并要求「把金额和日期提出来，汇总成表发回」。
 *
 * 判据分两栏，互不混算（实现见 r2d-judge.ts）：
 *
 *   【宿主面：必须绿】
 *     ① 附件登记成功：inbound_files_registered 事件 + file_refs 行（name/sha/bytes）+ 已激活；
 *     ② 清单注入/委派链路正常：Main 回合看到 fileId+文件名+脚本内路径；task_run 必须带
 *        inputFiles 且真的产生任务副本/Worker 可见；run_js.inputs 只能引用 Main 作用域文件；
 *     ③ 产物（若有）逐格正确或诚实为空：xlsx 重开逐格比对「日期/金额」表头 + 一行数据；
 *        CSV 同口径；空表/空文件只有回复如实说明读不出时才算诚实为空；
 *     ④ 回复里不得出现夹具里没有的金额/日期（虚构即判红）；
 *     ⑤ 交付面与登记一致：每个交付文件 sha+name 对回 file_refs；sent 事实只在真交付时出现；
 *        零交付不得声称「已发回/见附件」（假成功）。
 *
 *   【模型能力：只读数，不判宿主】
 *     read（读到日期+金额）/ partial-read（只读到一项）/ honest-cannot（如实说读不出）/
 *     vague（含糊，记录）/ fabricated（编造，红）。仓内没有 PDF 解析库，所以「读不出」是
 *     预期内的诚实结果；这一栏把旧长会话 S5 的 UNDEFINED 变成有读数。
 *
 * 反向绊线：judge 的宿主栏虚构检测可被 `detectReplyFabrication=false` 关掉（仅测试用）；
 * r2d-judge.test.ts 用编数假样本证明关掉后模型栏仍判 fabricated、整体仍红。
 *
 * 模型口径：缺省 real（真实 Pi 驱动，env 的 LLM_*，与 r2 同源）；`--scripted` 或无
 * LLM_API_KEY 时降级脚本化驱动（同一段断言原样跑，报告写 model=scripted）。脚本化样本是
 * 「Main 交办 + Worker 如实说读不出」——宿主链路全绿、模型栏 honest-cannot。
 *
 * 运行：
 *   node --env-file=<含 LLM_API_KEY 的 env> --import tsx scripts/eval/cap01/r2d-unstructured.ts \
 *     [--scripted] [--out-dir <dir>]
 * 缺省 out-dir = .runtime/eval-cap01-r2d/<时间戳>（.runtime 不进 git）。
 * 证据：evidence.json（含回复/日志/工具调用/驱动转录/file_refs/产物逐格）、summary.json、
 * reply.txt、delivered/（交付原件字节）。
 * 退出码：0 = 宿主绿且模型栏非红；1 = 宿主红或模型栏红（含糊 amber 只记录，不判红）。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import type {
  AppConfig,
  ChannelReply,
  ChannelRoute,
  DeliveryReceipt,
  IncomingAttachment,
  IncomingChannelMessage,
  OutgoingFileReply,
} from '@fshine/contracts';
import type { DriverMessage, TurnDriver } from '../../../packages/agent/src/driver-contract';
import { createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import { contextWindowFrom, compactionSettingsFrom } from '../../ask-runtime';
import { materializeEvalConfig } from '../../resolve-config-path';
import { createServer, type FileDeliveryPort } from '../../../apps/server/server';
import { createSqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import { INVOICE_FACT } from '../fixtures/unstructured/invoice-fact';
import { inspectArtifact } from './r2d-artifact';
import {
  R2D_FACTS,
  judgeR2d,
  type ArtifactView,
  type DeliveredFileView,
  type FileRefView,
  type JudgeResult,
  type JudgeSample,
  type ToolCallView,
} from './r2d-judge';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');
const FIXTURE_PDF = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'unstructured', INVOICE_FACT.pdfFilename);
const FIXTURE_RELATIVE = path.relative(REPO_ROOT, FIXTURE_PDF);

const PRINCIPAL_ID = 'wecom:fixture-user';
const CONVERSATION_ID = 'conv-cap01-r2d';
const INSTRUCTION = '这张 PDF 发票请把金额和日期提出来，汇总成一张表发回，表头用「日期、金额」，一行数据即可。';
const EXPECTED_GRID: readonly (readonly string[])[] = [
  ['日期', '金额'],
  [INVOICE_FACT.date, INVOICE_FACT.amount],
];

// ── 记录包装器（与 r2-functional 的 recordingDriver 同形；透传不改语义） ──────

interface ToolCallRecord {
  agent: 'main' | 'worker';
  seq: number;
  tool: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
  resultSummary?: string;
}

interface DriverRunRecord {
  agent: 'main' | 'worker';
  systemPrompt: string;
  toolNames: readonly string[];
  messages: readonly DriverMessage[];
  injections: readonly string[];
  resultText: string;
  resultMessages: readonly DriverMessage[];
}

interface ScenarioSink {
  calls: ToolCallRecord[];
  runs: DriverRunRecord[];
}

function safeClone(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value === undefined ? null : value)) as unknown;
  } catch {
    return `<unserializable:${String(value).slice(0, 200)}>`;
  }
}

function recordingDriver(inner: TurnDriver, agent: 'main' | 'worker', sink: ScenarioSink): TurnDriver {
  return {
    async run(input) {
      const runRecord: DriverRunRecord = {
        agent,
        systemPrompt: input.systemPrompt,
        toolNames: input.tools.map((tool) => tool.name),
        messages: safeClone(input.messages) as readonly DriverMessage[],
        injections: [...(input.injections ?? [])],
        resultText: '',
        resultMessages: [],
      };
      sink.runs.push(runRecord);
      let seq = 0;
      const result = await inner.run({
        ...input,
        exec: async (tool, args, signal) => {
          seq += 1;
          try {
            const value = await input.exec(tool, args, signal);
            sink.calls.push({
              agent,
              seq,
              tool,
              args: safeClone(args),
              result: safeClone(value),
              resultSummary: typeof value === 'string' ? value.slice(0, 300) : undefined,
            });
            return value;
          } catch (error) {
            sink.calls.push({
              agent,
              seq,
              tool,
              args: safeClone(args),
              isError: true,
              resultSummary: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      });
      runRecord.resultText = result.text;
      runRecord.resultMessages = safeClone(result.messages) as readonly DriverMessage[];
      return result;
    },
    ...(inner.synthesizeAssistant !== undefined ? { synthesizeAssistant: inner.synthesizeAssistant.bind(inner) } : {}),
  };
}

// ── 交付端口（live 捕获） ────────────────────────────────────────────────────

interface DeliveredFile {
  filename: string;
  bytes: number;
  sha256: string;
  data: Buffer;
}

interface PortCapture {
  calls: Array<{ route: ChannelRoute; files: DeliveredFile[] }>;
}

function capturePort(): PortCapture & FileDeliveryPort {
  const capture: PortCapture = { calls: [] };
  return {
    ...capture,
    deliveryMode: 'live',
    async sendToConversation(route, files: readonly OutgoingFileReply[]): Promise<DeliveryReceipt> {
      const delivered: DeliveredFile[] = files.map((file) => ({
        filename: file.filename,
        bytes: file.data.length,
        sha256: createHash('sha256').update(file.data).digest('hex'),
        data: file.data,
      }));
      capture.calls.push({ route, files: delivered });
      return {
        route,
        parts: delivered.map((_, index) => ({ kind: 'file' as const, index, status: 'sent' as const })),
      };
    },
  };
}

// ── 脚本化驱动（model=scripted 降级；Main 交办 + Worker 如实说读不出） ────────

function fileIdsInText(text: string): string[] {
  return [...text.matchAll(/fileId:\s*(file_[0-9a-f]{32})/g)].map((match) => match[1]!);
}

function messageText(message: DriverMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : (part as { text?: string })?.text ?? '')).join('\n');
  return JSON.stringify(content ?? '');
}

function scriptedAssistant(text: string): DriverMessage {
  return {
    role: 'assistant',
    content: text,
    api: 'openai-completions',
    provider: 'scripted',
    model: { id: 'scripted', name: 'scripted', api: 'openai-completions', provider: 'scripted', baseUrl: '', input: [], cost: {} },
    usage: { input: 0, output: 0, totalTokens: 0, cost: 0 },
    stopReason: 'stop',
  } as unknown as DriverMessage;
}

function scriptedMainDriver(): TurnDriver {
  return {
    async run(input) {
      const fileId = fileIdsInText((input.injections ?? []).join('\n'))[0];
      if (fileId !== undefined) {
        await input.exec('task_run', {
          task: '从 PDF 发票中提取日期和金额，汇总成一张表（表头「日期、金额」）。',
          inputFiles: [fileId],
        });
      }
      const text = '附件已交给执行层，但执行层反馈无法读取 PDF 内容，未能提取金额和日期；请提供文本版或截图后再试。';
      return { text, messages: [scriptedAssistant(text)] };
    },
  };
}

function scriptedWorkerDriver(): TurnDriver {
  return {
    async run(input) {
      // 真实执行调用（不是空汇报）：零执行汇报会被产品判为「未发起执行」（task-runner/
      // task-registry 的如实交付判据），委派工具因此报错、宿主链路不成立——所以这里必须
      // 落一次真实 run_js。脚本不引用输入文件：模型能力栏只该读到「读不出」，不该从
      // run_js 结果的 inputs[].name（如 invoice-2026-10-18.pdf）里误读出一个日期。
      await input.exec('run_js', {
        code: [
          "console.log('pdf_text_extractable=false: 当前执行环境没有 PDF 解析能力');",
        ].join('\n'),
      });
      const text = '无法读取 PDF 内容（当前执行环境没有 PDF 解析能力），未能提取金额和日期。';
      return { text, messages: [scriptedAssistant(text)] };
    },
  };
}

// ── 场景夹具：server 生产装配 ───────────────────────────────────────────────

interface ScenarioPaths {
  dir: string;
  dbPath: string;
}

interface ScenarioHarness {
  paths: ScenarioPaths;
  server: Awaited<ReturnType<typeof createServer>>;
  logs: Array<Record<string, unknown>>;
  sink: ScenarioSink;
  port: PortCapture & FileDeliveryPort;
  modelObserved: () => string | undefined;
}

async function makeHarness(options: {
  port: PortCapture & FileDeliveryPort;
  scripted: boolean;
  label: string;
}): Promise<ScenarioHarness> {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cap01-r2d-${options.label}-`));
  const dbPath = path.join(dir, 'state.db');
  const configCopy = path.join(dir, 'agent-config.yaml');
  materializeEvalConfig(FIXTURE_CONFIG, configCopy);
  const configDoc = parseYaml(readFileSync(configCopy, 'utf8')) as Record<string, unknown>;
  configDoc['store'] = { dbPath };
  writeFileSync(configCopy, stringifyYaml(configDoc));
  const config: AppConfig = loadConfig({ yamlPath: configCopy });
  const env = effectiveDeploymentEnv(config, process.env);

  const sink: ScenarioSink = { calls: [], runs: [] };
  const createDrivers = options.scripted
    ? (): { mainDriver: TurnDriver; workerDriver: TurnDriver } => ({
        mainDriver: recordingDriver(scriptedMainDriver(), 'main', sink),
        workerDriver: recordingDriver(scriptedWorkerDriver(), 'worker', sink),
      })
    : (driverEnv: NodeJS.ProcessEnv): { mainDriver: TurnDriver; workerDriver: TurnDriver } => {
        const make = (agent: 'main' | 'worker', reuseConversation: boolean): TurnDriver =>
          recordingDriver(
            createPiTurnDriver({
              env: driverEnv,
              ...contextWindowFrom(driverEnv),
              ...compactionSettingsFrom(driverEnv),
              ...(reuseConversation ? { reuseConversation: true } : {}),
            }),
            agent,
            sink,
          );
        return { mainDriver: make('main', true), workerDriver: make('worker', false) };
      };

  const logs: Array<Record<string, unknown>> = [];
  const server = await createServer({
    env,
    config,
    dbPath,
    stateDir: path.join(dir, 'state'),
    createDrivers,
    fileDelivery: options.port,
    logger: (line) => logs.push(line),
  });
  return {
    paths: { dir, dbPath },
    server,
    logs,
    sink,
    port: options.port,
    modelObserved: () => observedModelOf(sink.runs),
  };
}

function observedModelOf(runs: readonly DriverRunRecord[]): string | undefined {
  for (const run of [...runs].reverse()) {
    for (const message of [...run.resultMessages].reverse()) {
      const model = (message as { model?: { id?: unknown } }).model;
      if (model !== null && typeof model === 'object' && typeof model.id === 'string' && model.id !== '') {
        return model.id;
      }
    }
  }
  return undefined;
}

function assistantCount(messages: readonly DriverMessage[]): number {
  return messages.filter((message) => (message as { role?: unknown }).role === 'assistant').length;
}

// ── 场景执行 ────────────────────────────────────────────────────────────────

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stagedAttachment(root: string, filename: string, bytes: Buffer): IncomingAttachment {
  const dir = path.join(root, 'attachments');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, bytes);
  return { filename, path: filePath, bytes: bytes.length };
}

function incomingMessage(messageId: string, text: string, attachment: IncomingAttachment): IncomingChannelMessage {
  return {
    wecomUserId: 'fixture-user',
    channel: 'wecom',
    conversationId: CONVERSATION_ID,
    messageId,
    chatType: 'single',
    text,
    attachments: [attachment],
    receivedAt: new Date().toISOString(),
  };
}

function textOf(reply: ChannelReply): string {
  return typeof reply === 'string' ? reply : reply.text ?? '';
}

interface ScenarioOutcome {
  judge: JudgeResult;
  reply: string;
  handlerError?: string;
  logs: Array<Record<string, unknown>>;
  sink: ScenarioSink;
  fileRows: FileRefView[];
  taskRows: Array<{ taskId: string }>;
  delivered: DeliveredFileView[];
  deliveredData: DeliveredFile[];
  artifacts: ArtifactView[];
  manifestText: string;
  observedModel?: string;
  mode: 'scripted' | 'real';
  fixtureSha: string;
  durationMs: number;
}

async function runScenario(scripted: boolean, pdfBytes: Buffer): Promise<ScenarioOutcome> {
  const started = Date.now();
  const port = capturePort();
  const harness = await makeHarness({ port, scripted, label: 'r2d' });
  const fixtureSha = sha256Of(pdfBytes);
  let reply: ChannelReply = '';
  let handlerError: string | undefined;
  try {
    const attachment = stagedAttachment(harness.paths.dir, INVOICE_FACT.pdfFilename, pdfBytes);
    try {
      reply = await harness.server.handler(incomingMessage('r2d-1', INSTRUCTION, attachment));
    } catch (error) {
      handlerError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    await harness.server.close();
  }

  const scope = { principalId: PRINCIPAL_ID, sessionId: `wecom:${CONVERSATION_ID}` };
  let fileRows: FileRefView[] = [];
  let taskRows: Array<{ taskId: string }> = [];
  try {
    const registry = createSqliteTaskRegistry(harness.paths.dbPath, { readOnly: true });
    taskRows = registry.list().map((task) => ({ taskId: task.taskId }));
    fileRows = registry.store.listFileRefs(scope).map((row) => ({
      fileId: row.fileId,
      ...(row.taskId === undefined ? {} : { taskId: row.taskId }),
      name: row.name,
      sha256: row.sha256,
      bytes: row.bytes,
      activated: row.activatedAt !== undefined,
    }));
    registry.close();
  } catch {
    // 底账读失败由宿主栏的登记检查判红（fileRows 为空）。
  }

  const inboundLog = harness.logs.find((line) => line['event'] === 'inbound_files_registered');
  const eventFileIds = Array.isArray(inboundLog?.['fileIds'])
    ? (inboundLog['fileIds'] as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
  const inboundRow = fileRows.find((row) =>
    row.taskId === undefined && row.name === INVOICE_FACT.pdfFilename && row.sha256 === fixtureSha);
  const inboundFileId = inboundRow?.fileId ?? eventFileIds[0];

  const mainRuns = harness.sink.runs.filter((run) => run.agent === 'main');
  const workerRuns = harness.sink.runs.filter((run) => run.agent === 'worker');
  const manifestText = mainRuns.flatMap((run) => run.injections).join('\n');
  const workerFileIds = [...new Set(workerRuns.flatMap((run) =>
    fileIdsInText([...run.messages.map(messageText), ...run.injections].join('\n'))))];
  const toolResultText = harness.sink.calls
    .map((call) => {
      const value = call.result !== undefined ? call.result : call.resultSummary;
      return typeof value === 'string' ? value : JSON.stringify(value ?? '');
    })
    .join('\n');

  const deliveries = port.calls.flatMap((call) => call.files.map((file): DeliveredFileView => ({
    filename: file.filename,
    sha256: file.sha256,
    bytes: file.bytes,
    conversationId: call.route.conversationId,
    channel: call.route.channel,
  })));
  const deliveredData = port.calls.flatMap((call) => call.files);
  const artifacts: ArtifactView[] = [];
  for (const file of deliveredData) {
    artifacts.push(await inspectArtifact(file));
  }

  const doneLog = harness.logs.find((line) => line['event'] === 'message_done') as Record<string, unknown> | undefined;
  const deliveryFact = (doneLog?.['fileDelivery'] ?? undefined) as { status?: string; files?: number } | undefined;
  const deliveryEvents = harness.logs
    .filter((line) => line['event'] === 'file_delivery')
    .map((line) => String(line['status'] ?? 'unknown'));

  const toolCalls: ToolCallView[] = harness.sink.calls.map((call) => ({
    agent: call.agent,
    tool: call.tool,
    args: call.args,
    ...(call.isError === true ? { isError: true } : {}),
  }));

  const sample: JudgeSample = {
    facts: R2D_FACTS,
    inbound: { name: INVOICE_FACT.pdfFilename, sha256: fixtureSha, bytes: pdfBytes.length },
    ...(inboundFileId === undefined ? {} : { inboundFileId }),
    registration: { eventFileIds, rows: fileRows },
    manifest: { injected: manifestText.includes('[本会话文件清单]'), text: manifestText },
    turn: { completed: handlerError === undefined, ...(handlerError === undefined ? {} : { error: handlerError }) },
    replyText: textOf(reply),
    toolCalls,
    taskRows,
    workerFileIds,
    toolResultText,
    deliveries,
    deliveryFact: deliveryFact ?? {},
    deliveryEvents,
    artifacts,
    conversationId: CONVERSATION_ID,
    channel: 'wecom',
  };
  const judge = judgeR2d(sample);

  return {
    judge,
    reply: textOf(reply),
    ...(handlerError === undefined ? {} : { handlerError }),
    logs: harness.logs,
    sink: harness.sink,
    fileRows,
    taskRows,
    delivered: deliveries,
    deliveredData,
    artifacts,
    manifestText,
    ...(harness.modelObserved() === undefined ? {} : { observedModel: harness.modelObserved() }),
    mode: scripted ? 'scripted' : 'real',
    fixtureSha,
    durationMs: Date.now() - started,
  };
}

// ── 入口 ────────────────────────────────────────────────────────────────────

interface CliOptions {
  scripted: boolean;
  outDir: string;
}

function parseCli(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    scripted: false,
    outDir: path.join(REPO_ROOT, '.runtime', 'eval-cap01-r2d', new Date().toISOString().replace(/[:.]/g, '-')),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--scripted') options.scripted = true;
    else if (arg === '--out-dir') {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error('--out-dir 需要值');
      options.outDir = path.resolve(value);
    } else {
      throw new Error(`未知参数：${arg}（支持 --scripted / --out-dir）`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const requestedModel = process.env['LLM_MODEL'] ?? '';
  const hasKey = (process.env['LLM_API_KEY'] ?? '').trim() !== '';
  const scripted = cli.scripted || !hasKey;
  if (!hasKey) {
    console.log('[cap01-r2d] 未检测到 LLM_API_KEY——按验收口径降级脚本化，报告写 model=scripted。');
  }
  const mode = scripted ? 'scripted' : 'real';
  mkdirSync(cli.outDir, { recursive: true });
  console.log(`[cap01-r2d] mode=${mode} requestedModel=${requestedModel || '(env 未设置)'} outDir=${cli.outDir}`);

  const pdfBytes = readFileSync(FIXTURE_PDF);
  let outcome: ScenarioOutcome;
  try {
    outcome = await runScenario(scripted, pdfBytes);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const evidencePath = path.join(cli.outDir, 'evidence.json');
    writeFileSync(evidencePath, `${JSON.stringify({ scenario: 'r2d-unstructured', mode, error: message }, null, 2)}\n`);
    console.error(`[cap01-r2d] 场景级异常（装配/渠道/驱动层），证据=${evidencePath}`);
    console.error(message);
    process.exitCode = 1;
    return;
  }

  // 交付原件落盘（证据可复核；文件名净化，避免目录穿越）。
  const deliveredDir = path.join(cli.outDir, 'delivered');
  for (const [index, file] of outcome.deliveredData.entries()) {
    mkdirSync(deliveredDir, { recursive: true });
    writeFileSync(path.join(deliveredDir, `${index}-${path.basename(file.filename)}`), file.data);
  }

  const calls = outcome.sink.runs.reduce((sum, run) => sum + assistantCount(run.resultMessages), 0);
  const modelField = scripted
    ? 'scripted'
    : outcome.observedModel ?? (requestedModel !== '' ? requestedModel : '(config default)');
  const summary = {
    scenario: 'r2d-unstructured',
    generatedAt: new Date().toISOString(),
    model: modelField,
    requestedModel,
    mode,
    fixture: {
      path: FIXTURE_RELATIVE,
      filename: INVOICE_FACT.pdfFilename,
      bytes: pdfBytes.length,
      sha256: outcome.fixtureSha,
      lines: INVOICE_FACT.lines,
    },
    instruction: INSTRUCTION,
    host: { status: outcome.judge.host.status, checks: outcome.judge.host.checks },
    modelCapability: {
      reading: outcome.judge.model.reading,
      status: outcome.judge.model.status,
      detail: outcome.judge.model.detail,
      correctFacts: outcome.judge.model.correctFacts,
      fabricated: outcome.judge.model.fabricated,
    },
    verdict: outcome.judge.verdict,
    calls,
    durationMs: outcome.durationMs,
    ...(outcome.handlerError === undefined ? {} : { error: outcome.handlerError }),
  };
  const evidence = {
    ...summary,
    reply: outcome.reply,
    handlerError: outcome.handlerError ?? null,
    logs: outcome.logs,
    toolCalls: outcome.sink.calls,
    driverRuns: outcome.sink.runs,
    fileRefs: outcome.fileRows,
    taskRows: outcome.taskRows,
    manifestText: outcome.manifestText,
    deliveredFiles: outcome.delivered,
    artifacts: outcome.artifacts,
    expectedGrid: EXPECTED_GRID,
  };
  const evidencePath = path.join(cli.outDir, 'evidence.json');
  const summaryPath = path.join(cli.outDir, 'summary.json');
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(cli.outDir, 'reply.txt'), `${outcome.reply}\n`);

  for (const check of outcome.judge.host.checks) {
    console.log(`[cap01-r2d] host ${check.pass ? 'PASS' : 'FAIL'} ${check.name} — ${check.detail}`);
  }
  console.log(`[cap01-r2d] model=${outcome.judge.model.reading}/${outcome.judge.model.status} — ${outcome.judge.model.detail}`);
  for (const finding of outcome.judge.model.fabricated) {
    console.log(`[cap01-r2d] model fabricated ${finding.kind} ${JSON.stringify(finding.raw)}→${finding.normalized} @${finding.surface}`);
  }
  console.log(`[cap01-r2d] verdict=${outcome.judge.verdict.toUpperCase()} host=${outcome.judge.host.status.toUpperCase()} model=${outcome.judge.model.status.toUpperCase()} calls=${calls} 证据=${evidencePath}`);
  if (outcome.judge.verdict !== 'pass') process.exitCode = 1;
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error('[cap01-r2d] 入口失败：', error);
    process.exitCode = 1;
  });
}
