/**
 * CAP-01 R6 文件生命周期验收（脚本化，不调模型；每条命令口径见各场景）。
 *
 * 口径（R6 验收指令 ①-⑥ + docs/product/cap01-main-direct-execution.md v8 §4/§8）：
 * 只验用户可见结果与安全不变量；全样本保留，不筛绿；失败样本连证据一起落盘；
 * 设计稿没写清的行为（产物同名、空产物、多附件、未知格式、同内容重传）**如实记录当前
 * 行为 + 影响，标 UNDEFINED，不发明判据**。本脚本零模型调用：Main/Worker 都是脚本化
 * TurnDriver 替身（与 server-cap01-inbound.test.ts 同一注入面），装配 = apps/server/
 * server.ts 生产装配缺省链（fileStore / run_js 执行器 / 清单注入 / 主动投递 B 同源），
 * 执行面注入假 ExecutionClient（生命周期验收不触执行层业务）。
 *
 * 六个场景（每个独立临时 dbPath，互不串扰）：
 *
 *   S1 多轮引用：第 1 条消息带附件 + 文字（登记→激活→第 1 回合清单注入）；第 2 条纯文字
 *      消息引用它。断言：
 *        ① 第 1 回合清单注入含该文件（fileId/name/bytes 与底账行一致）；
 *        ② 第 2 回合清单注入**仍在**（同一会话，同一 fileId）；
 *        ③ 第 2 回合 run_js 按 fileId 引用**真实解析成功**（物化 1 份输入，exitCode 0）；
 *        ④ 底账行已激活（activated_at 非 NULL）。
 *
 *   S2 同名重传（内容不同）：同一文件名两条消息、字节不同。断言：
 *        ① 两条独立 file_refs 行、fileId 不同、同名；
 *        ② 旧行不被覆盖（sha256/bytes 仍为第 1 份内容）；
 *        ③ 旧字节落点不被覆盖（按派生布局现读磁盘字节逐字节等于第 1 份内容）；
 *        ④ 第 2 回合清单含新 fileId。
 *      观察（不判）：第 2 回合清单同时列出**两个同名条目**——清单没有版本/时间戳字段，
 *      模型视角下同名两份并存（影响：模型可能引用错份；是否可接受设计稿未写清）。
 *
 *   S3 同内容重传：同一文件名、同字节两条消息。**UNDEFINED**：设计稿（v8 §4）未定义入站
 *      同内容重传是否复用 fileId——任务产物池有 sha256 去重（file-store.ts registerTaskFile，
 *      CAP-01 S2 ⑤），入站登记（registerInboundFile→registerFromFd）没有。只记录当前行为
 *      （是否复用、行数），不做 pass/fail 判定。
 *
 *   S4 一条消息 2 个附件：契约允许多附件（channel.ts attachments 数组），v8 §4 写「当前
 *      企微文件消息一条一个文件」并暂缓 source_message_id/attachment_index。**UNDEFINED**：
 *      多附件行为未定义判据。只记录当前行为（逐个登记为独立 pending 行、同回合一起激活、
 *      清单并列展示、底账无消息归属字段），不做 pass/fail 判定。
 *
 *   S5 不认识的格式（.pdf/.zip）：登记/激活/清单注入是机械层（file-store 不看内容类型；
 *      安全扩展名规则只影响落盘扩展名，file-store.ts:105）。断言机械事实：不拒收、
 *      正常激活、清单照常注入（名字保留扩展名）。**UNDEFINED**：「追问还是硬算」是模型
 *      行为，本脚本不调模型、不可观察——归 R2 真模型批次；此处只登记机械事实。
 *
 *   S6 跨 principal 同 session 号：两个已开通 principal 向**同一 conversationId** 发消息
 *      （sessionId 同为 "wecom:<conv>"）。A 上传文件；B（同 session 号）run_js 引用 A 的
 *      fileId。断言：
 *        ① B 的引用被拒（工具错误）；
 *        ② **同码**：B 引用 A 的 fileId 与引用一个不存在的 fileId，用户/模型可见错误文本
 *           逐字节相同（防存在性 oracle），底账层同抛 FileRefUnavailableError
 *           code=FILE_REF_UNAVAILABLE（file-store.ts:67）；
 *        ③ 底账隔离：B scope 0 行、A scope 1 行；B 的清单注入不含 A 的 fileId；
 *        ④ A 自己引用同一 fileId 成功（拒的不是文件本身，是越权）。
 *
 * 运行（零模型、零网络、零密钥）：
 *   node --import tsx scripts/eval/cap01/r6-lifecycle.ts [--scenario s1,s2,...] [--out-dir <dir>]
 * 缺省 out-dir = .runtime/eval-cap01-r6-lifecycle/<时间戳>（.runtime 不进 git）。
 * 退出码：0 = 无 FAIL（UNDEFINED 不计失败，进 summary.undefinedScenarios）；1 = 任一 FAIL。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AppConfig,
  ChannelReply,
  ChannelRoute,
  DeliveryReceipt,
  IncomingAttachment,
  IncomingChannelMessage,
  OutgoingFileReply,
} from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import { createFileStore, FileRefUnavailableError, fileStoragePathOf } from '../../../packages/agent/src/file-store';
import type { DriverMessage, TurnDriver, TurnDriverInput } from '../../../packages/agent/src/driver-contract';
import { createSqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import { createServer, workspaceRootOf, type FileDeliveryPort } from '../../../apps/server/server';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** 仓内 dummy 平台夹具根（contextProfile root；与 config/agent.fixture.yaml 同一面）。 */
const DUMMY_PLATFORM_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

/**
 * 输入文件不可用的统一话术（用户/模型可见面）。与 packages/agent/src/execution-runtime.ts:757
 * 的 FILE_INPUT_UNAVAILABLE_MESSAGE（模块内 const，不导出）逐字节一致——这里钉住的是
 * 「越权/不存在/pending/过期同话术」的用户可见结果；产品侧改话术文本时本脚本同步更新。
 */
const EXPECTED_FILE_INPUT_UNAVAILABLE_MESSAGE =
  '输入文件不可用：引用的文件不存在、未激活或已过期；请只用文件清单里给出的 fileId 引用输入文件。';

// ── 夹具字节：确定性 ASCII（生命周期验收不解析内容，字节只用于哈希/逐字节比对） ──

function fixtureBytes(label: string): Buffer {
  return Buffer.from(`r6-lifecycle fixture bytes: ${label}\n`, 'utf8');
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ── 记录 sink（脚本化驱动的观察面） ──────────────────────────────────────────

interface RunRecord {
  agent: 'main' | 'worker';
  turnNo: number;
  injections: readonly string[];
  lastUserText: string;
  resultText: string;
}

interface CallRecord {
  agent: 'main' | 'worker';
  tool: string;
  args: Record<string, unknown>;
  isError: boolean;
  result?: unknown;
  errorMessage?: string;
}

interface Sink {
  runs: RunRecord[];
  calls: CallRecord[];
}

function safeClone(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value === undefined ? null : value)) as unknown;
  } catch {
    return `<unserializable:${String(value).slice(0, 200)}>`;
  }
}

function messageText(message: DriverMessage | undefined): string {
  if (message === undefined) return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : (part as { text?: string })?.text ?? '')).join('\n');
  }
  return JSON.stringify(content ?? '');
}

function assistantMessage(text: string): DriverMessage {
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

/** 脚本化 Main 驱动行为：按回合序号/注入面决定回复与工具调用；观察面进 sink。 */
type MainBehavior = (ctx: {
  turnNo: number;
  injections: readonly string[];
  lastUserText: string;
  exec: TurnDriverInput['exec'];
}) => Promise<string>;

const workerNeverCalled: TurnDriver = {
  async run() {
    throw new Error('（r6-lifecycle）Worker 不应被调用：本脚本无委派场景');
  },
};

function scriptedMainDriver(behavior: MainBehavior, sink: Sink): TurnDriver {
  let turnNo = 0;
  return {
    async run(input) {
      turnNo += 1;
      const myTurn = turnNo;
      const injections = [...(input.injections ?? [])];
      const lastUserText = messageText(input.messages[input.messages.length - 1]);
      const record: RunRecord = { agent: 'main', turnNo: myTurn, injections, lastUserText, resultText: '' };
      sink.runs.push(record);
      const reply = await behavior({
        turnNo: myTurn,
        injections,
        lastUserText,
        exec: async (tool, args, signal) => {
          try {
            const value = await input.exec(tool, args, signal);
            sink.calls.push({ agent: 'main', tool, args: safeClone(args) as Record<string, unknown>, isError: false, result: safeClone(value) });
            return value;
          } catch (error) {
            sink.calls.push({
              agent: 'main',
              tool,
              args: safeClone(args) as Record<string, unknown>,
              isError: true,
              errorMessage: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      });
      record.resultText = reply;
      return { text: reply, messages: [...input.messages, assistantMessage(reply)] };
    },
  };
}

// ── 交付端口（live 捕获；本脚本无产物交付断言，端口只为装配完整） ──────────────

function capturePort(): FileDeliveryPort {
  return {
    deliveryMode: 'live',
    async sendToConversation(route: ChannelRoute, files: readonly OutgoingFileReply[]): Promise<DeliveryReceipt> {
      return { route, parts: files.map((_, index) => ({ kind: 'file' as const, index, status: 'sent' as const })) };
    },
  };
}

// ── 假执行面（生命周期验收不触执行层业务；给 run_task 的能力快照一个非空允许集） ──

const FACE_MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

const faceClient: ExecutionClient = {
  async capabilities(): Promise<CapabilityManifest> {
    return FACE_MANIFEST;
  },
  async execute(): Promise<ExecutionOutcome> {
    return { status: 'completed', data: {} };
  },
};

// ── 场景夹具：server 生产装配（缺省执行器/文件区/清单注入/投递 B），脚本化驱动 ──

const CHANNEL = 'wecom';
const USER_A = 'user-a';
const USER_B = 'user-b';
const CONVERSATION_A = 'conv-r6-solo';
const CONVERSATION_SHARED = 'conv-r6-shared';

interface Harness {
  dir: string;
  dbPath: string;
  workspaceRoot: string;
  server: Awaited<ReturnType<typeof createServer>>;
  logs: Array<Record<string, unknown>>;
  sink: Sink;
}

async function makeHarness(label: string, behavior: MainBehavior, userIds: readonly string[]): Promise<Harness> {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cap01-r6-${label}-`));
  const dbPath = path.join(dir, 'state.db');
  const config: AppConfig = {
    principals: Object.fromEntries(
      userIds.map((userId) => [`${CHANNEL}:${userId}`, { enabled: true, accountSetScope: 'all', capabilities: ['read'] }]),
    ),
    contextProfiles: {
      dummy: { root: DUMMY_PLATFORM_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 0, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
  };
  const sink: Sink = { runs: [], calls: [] };
  const logs: Array<Record<string, unknown>> = [];
  const server = await createServer({
    env: { LLM_MODEL: 'scripted-r6' },
    config,
    dbPath,
    createDrivers: () => ({ mainDriver: scriptedMainDriver(behavior, sink), workerDriver: workerNeverCalled }),
    createExecutionFace: async () => ({
      client: faceClient,
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    fileDelivery: capturePort(),
    logger: (line) => logs.push(line),
  });
  return { dir, dbPath, workspaceRoot: workspaceRootOf(dbPath), server, logs, sink };
}

function stagedAttachment(root: string, filename: string, bytes: Buffer): IncomingAttachment {
  const dir = path.join(root, 'attachments');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, bytes);
  return { filename, path: filePath, bytes: bytes.length };
}

function incomingMessage(input: {
  userId: string;
  conversationId: string;
  messageId: string;
  text: string;
  attachments?: readonly IncomingAttachment[];
}): IncomingChannelMessage {
  return {
    wecomUserId: input.userId,
    channel: CHANNEL,
    conversationId: input.conversationId,
    messageId: input.messageId,
    chatType: 'single',
    text: input.text,
    ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
    receivedAt: new Date().toISOString(),
  };
}

function textOf(reply: ChannelReply): string {
  return typeof reply === 'string' ? reply : reply.text ?? '';
}

interface HandlerCall {
  reply: string;
  error?: string;
}

async function callHandler(harness: Harness, message: IncomingChannelMessage): Promise<HandlerCall> {
  try {
    const reply = await harness.server.handler(message);
    return { reply: textOf(reply) };
  } catch (error) {
    return { reply: '', error: error instanceof Error ? error.message : String(error) };
  }
}

/** 从 server 日志取某 principal 全部入站登记 fileId（聚合所有 inbound_files_registered 事件）。 */
function registeredFileIdsOf(logs: ReadonlyArray<Record<string, unknown>>, principalId: string): string[] {
  const fileIds: string[] = [];
  for (const line of logs) {
    if (line['event'] === 'inbound_files_registered' && line['principalId'] === principalId) {
      if (Array.isArray(line['fileIds'])) fileIds.push(...(line['fileIds'] as string[]));
    }
  }
  return fileIds;
}

/** 渲染清单的行解析（renderFileManifest 的行形状：- <name>（fileId: <id>，<n> 字节））。 */
interface ManifestEntry {
  name: string;
  fileId: string;
  bytes: number;
}

function manifestEntriesOf(injections: readonly string[]): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const linePattern = /^- (.+?)（fileId: (file_[0-9a-f]{32})，(\d+) 字节）$/gm;
  for (const text of injections) {
    for (const match of text.matchAll(linePattern)) {
      entries.push({ name: match[1]!, fileId: match[2]!, bytes: Number(match[3]) });
    }
  }
  return entries;
}

// ── 断言收集 ────────────────────────────────────────────────────────────────

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

class Checks {
  readonly list: Check[] = [];

  check(name: string, pass: boolean, detail: string): void {
    this.list.push({ name, pass, detail });
  }

  get allPassed(): boolean {
    return this.list.every((entry) => entry.pass);
  }
}

interface Observation {
  name: string;
  detail: string;
}

type ScenarioId = 's1' | 's2' | 's3' | 's4' | 's5' | 's6';

interface ScenarioOutcome {
  scenario: ScenarioId;
  title: string;
  status: 'pass' | 'fail' | 'undefined';
  checks: Check[];
  observations: Observation[];
  notes: string[];
  /** UNDEFINED 标记：设计稿没写清的行为——记录当前行为 + 影响，不发明判据。 */
  undefinedReason?: string;
  evidence: Record<string, unknown>;
}

/** 只读底账行投影（验收集闭包用）。 */
interface FileRowView {
  fileId: string;
  name: string;
  sha256: string;
  bytes: number;
  activated: boolean;
  taskId?: string;
}

function readFileRows(dbPath: string, scope: { principalId: string; sessionId: string }): FileRowView[] {
  const registry = createSqliteTaskRegistry(dbPath, { readOnly: true });
  try {
    return registry.store.listFileRefs(scope).map((row) => ({
      fileId: row.fileId,
      name: row.name,
      sha256: row.sha256,
      bytes: row.bytes,
      activated: row.activatedAt !== undefined,
      ...(row.taskId !== undefined ? { taskId: row.taskId } : {}),
    }));
  } finally {
    registry.close();
  }
}

function rowsViewOf(rows: readonly FileRowView[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    fileId: row.fileId,
    name: row.name,
    bytes: row.bytes,
    sha256: row.sha256,
    activated: row.activated,
    ...(row.taskId !== undefined ? { taskId: row.taskId } : {}),
  }));
}

// ── S1 多轮引用 ─────────────────────────────────────────────────────────────

const S1_NAME = '12月销售明细.xlsx';

async function runScenarioS1(): Promise<ScenarioOutcome> {
  const checks = new Checks();
  const observations: Observation[] = [];
  const notes: string[] = [];
  const bytesA = fixtureBytes('s1-turn1 报表 A');
  const state: { fileId?: string } = {};
  const harness = await makeHarness(
    's1',
    async (ctx) => {
      if (ctx.turnNo === 1) return '好的，文件已登记，等你下一步指示。';
      // 第 2 回合：真引用——按清单里的 fileId 调 run_js，验证跨回合解析仍然成立。
      if (state.fileId === undefined) throw new Error('（r6 S1）第 2 回合缺少第 1 回合登记的 fileId');
      await ctx.exec('run_js', {
        code: "const fs = require('fs'); console.log(fs.readdirSync('in').join(','));",
        inputs: [state.fileId],
      });
      return '文件还在，我已经按 fileId 引用并读到了它。';
    },
    [USER_A],
  );
  const scope = { principalId: `${CHANNEL}:${USER_A}`, sessionId: `${CHANNEL}:${CONVERSATION_A}` };
  let handler1: HandlerCall;
  let handler2: HandlerCall;
  try {
    const attachment = stagedAttachment(harness.dir, S1_NAME, bytesA);
    handler1 = await callHandler(harness, incomingMessage({
      userId: USER_A, conversationId: CONVERSATION_A, messageId: 'r6-s1-1',
      text: '这是 12 月销售明细，先收下；我下一条消息再告诉你怎么处理。',
      attachments: [attachment],
    }));
    state.fileId = registeredFileIdsOf(harness.logs, scope.principalId)[0];
    handler2 = await callHandler(harness, incomingMessage({
      userId: USER_A, conversationId: CONVERSATION_A, messageId: 'r6-s1-2',
      text: '刚发的那份明细还在吗？在的话直接按文件清单引用它汇总。',
    }));
  } finally {
    await harness.server.close();
  }

  const turn1 = harness.sink.runs.find((run) => run.turnNo === 1);
  const turn2 = harness.sink.runs.find((run) => run.turnNo === 2);
  const fileId = state.fileId ?? '(未登记)';
  checks.check('s1-both-turns-completed', handler1.error === undefined && handler2.error === undefined,
    handler1.error !== undefined ? `第 1 回合失败：${handler1.error}` : handler2.error !== undefined ? `第 2 回合失败：${handler2.error}` : '两个回合都正常完成');

  // ① 第 1 回合清单注入含该文件。
  const manifest1 = turn1 === undefined ? [] : manifestEntriesOf(turn1.injections);
  checks.check('s1-turn1-manifest-has-file', manifest1.length === 1 && manifest1[0]?.fileId === fileId && manifest1[0]?.name === S1_NAME && manifest1[0]?.bytes === bytesA.length,
    `第 1 回合清单=${JSON.stringify(manifest1)}；期望 [{name:"${S1_NAME}", fileId:${fileId}, bytes:${bytesA.length}}]`);

  // ② 第 2 回合清单里仍在（同一会话、同一 fileId、同 name/bytes）。
  const manifest2 = turn2 === undefined ? [] : manifestEntriesOf(turn2.injections);
  checks.check('s1-turn2-manifest-still-has-file', manifest2.length === 1 && manifest2[0]?.fileId === fileId && manifest2[0]?.name === S1_NAME && manifest2[0]?.bytes === bytesA.length,
    `第 2 回合清单=${JSON.stringify(manifest2)}`);

  // ③ 第 2 回合 run_js 引用真实解析成功（物化 1 份、exitCode 0、物化名 = fileId+扩展名）。
  const runJsCall = harness.sink.calls.find((call) => call.tool === 'run_js');
  const result = runJsCall?.result as { exitCode?: number; inputs?: Array<{ fileId: string; materializedName: string }> } | undefined;
  checks.check('s1-turn2-run-js-resolves-fileid', runJsCall !== undefined && runJsCall.isError === false && result?.exitCode === 0 && result?.inputs?.length === 1 && result?.inputs?.[0]?.fileId === fileId && result?.inputs?.[0]?.materializedName === `${fileId}.xlsx`,
    `run_js=${JSON.stringify({ isError: runJsCall?.isError ?? 'missing', exitCode: result?.exitCode, inputs: result?.inputs })}`);

  // ④ 底账行已激活。
  const rows = readFileRows(harness.dbPath, scope);
  checks.check('s1-row-activated', rows.length === 1 && rows[0]?.fileId === fileId && rows[0]?.activated && rows[0]?.bytes === bytesA.length && rows[0]?.sha256 === sha256Of(bytesA),
    `file_refs=${JSON.stringify(rowsViewOf(rows))}`);

  return {
    scenario: 's1',
    title: '① 多轮引用：第一轮回传文件清单 → 第二轮清单里仍在（同一会话）',
    status: checks.allPassed ? 'pass' : 'fail',
    checks: checks.list,
    observations,
    notes,
    evidence: {
      replies: [handler1, handler2],
      logs: harness.logs,
      driverRuns: harness.sink.runs,
      toolCalls: harness.sink.calls,
      fileRefs: rowsViewOf(readFileRows(harness.dbPath, scope)),
    },
  };
}

// ── S2 同名重传（内容不同） ─────────────────────────────────────────────────

const S2_NAME = '报表.xlsx';

async function runScenarioS2(): Promise<ScenarioOutcome> {
  const checks = new Checks();
  const observations: Observation[] = [];
  const notes: string[] = [];
  const bytesA = fixtureBytes('s2 第一版');
  const bytesB = fixtureBytes('s2 第二版（内容不同）');
  const harness = await makeHarness('s2', async () => '收到。', [USER_A]);
  const scope = { principalId: `${CHANNEL}:${USER_A}`, sessionId: `${CHANNEL}:${CONVERSATION_A}` };
  const handlerCalls: HandlerCall[] = [];
  try {
    for (const [index, bytes] of [[1, bytesA], [2, bytesB]] as const) {
      const attachment = stagedAttachment(harness.dir, S2_NAME, bytes);
      handlerCalls.push(await callHandler(harness, incomingMessage({
        userId: USER_A, conversationId: CONVERSATION_A, messageId: `r6-s2-${index}`,
        text: index === 1 ? '上传第一版报表。' : '这是同名的新版报表，内容改过了。',
        attachments: [attachment],
      })));
    }
  } finally {
    await harness.server.close();
  }

  const fileIds = registeredFileIdsOf(harness.logs, scope.principalId);
  checks.check('s2-both-turns-completed', handlerCalls.every((call) => call.error === undefined),
    handlerCalls.find((call) => call.error !== undefined)?.error ?? '两条消息都正常完成');

  const rows = readFileRows(harness.dbPath, scope);
  const row1 = rows.find((row) => row.fileId === fileIds[0]);
  const row2 = rows.find((row) => row.fileId === fileIds[1]);

  // ① 两条独立行、fileId 不同、同名。
  checks.check('s2-two-rows-distinct-fileids', handlerCalls.every((call) => call.error === undefined) && fileIds.length === 2 && rows.length === 2 && fileIds[0] !== fileIds[1] && row1?.name === S2_NAME && row2?.name === S2_NAME,
    `登记 fileId=${JSON.stringify(fileIds)}；file_refs=${JSON.stringify(rowsViewOf(rows))}`);

  // ② 旧行不被覆盖：sha256/bytes 仍为第 1 份内容；新行 = 第 2 份内容。
  checks.check('s2-old-row-not-overwritten', row1 !== undefined && row1.sha256 === sha256Of(bytesA) && row1.bytes === bytesA.length && row2 !== undefined && row2.sha256 === sha256Of(bytesB) && row2.bytes === bytesB.length,
    `row1=${JSON.stringify(row1)}（期望 sha=${sha256Of(bytesA).slice(0, 12)}… bytes=${bytesA.length}）；row2=${JSON.stringify(row2)}（期望 sha=${sha256Of(bytesB).slice(0, 12)}… bytes=${bytesB.length}）`);

  // ③ 旧字节落点不被覆盖：按派生布局现读磁盘，逐字节等于第 1 份内容。
  let diskOldMatches = false;
  let diskNewMatches = false;
  let diskDetail = '';
  try {
    if (row1 !== undefined && row2 !== undefined) {
      const oldBytes = readFileSync(fileStoragePathOf(harness.workspaceRoot, scope, row1.fileId, row1.name));
      const newBytes = readFileSync(fileStoragePathOf(harness.workspaceRoot, scope, row2.fileId, row2.name));
      diskOldMatches = oldBytes.equals(bytesA);
      diskNewMatches = newBytes.equals(bytesB);
      diskDetail = `旧落点=${oldBytes.length}B equals(A)=${diskOldMatches}；新落点=${newBytes.length}B equals(B)=${diskNewMatches}`;
    } else {
      diskDetail = 'file_refs 行缺失，无法现读落点';
    }
  } catch (error) {
    diskDetail = `现读落点失败：${error instanceof Error ? error.message : String(error)}`;
  }
  checks.check('s2-old-bytes-on-disk-intact', diskOldMatches && diskNewMatches, diskDetail);

  // ④ 第 2 回合清单含新 fileId。
  const turn2 = harness.sink.runs.find((run) => run.turnNo === 2);
  const manifest2 = turn2 === undefined ? [] : manifestEntriesOf(turn2.injections);
  checks.check('s2-turn2-manifest-has-new-fileid', manifest2.some((entry) => entry.fileId === fileIds[1]),
    `第 2 回合清单=${JSON.stringify(manifest2)}；新 fileId=${fileIds[1] ?? '(缺失)'}`);

  // 观察（不判）：清单同时列出两个同名条目（无版本/时间戳字段，模型视角同名并存）。
  observations.push({
    name: 's2-observation-manifest-lists-both-same-name-entries',
    detail: `第 2 回合清单条目=${JSON.stringify(manifest2)}——同名两行并列可见，清单字段只有 fileId/name/bytes，`
      + '模型无法从清单区分哪份是新版（清单注入文本见 execution-runtime.ts renderFileManifest）。'
      + '影响：模型可能引用旧份；该行为是否可接受，设计稿（v8 §4/§8）未写清，如实登记不判定。',
  });

  return {
    scenario: 's2',
    title: '② 同名重传且内容不同 → 新 fileId，旧的不被覆盖',
    status: checks.allPassed ? 'pass' : 'fail',
    checks: checks.list,
    observations,
    notes,
    evidence: {
      replies: handlerCalls,
      logs: harness.logs,
      driverRuns: harness.sink.runs,
      fileRefs: rowsViewOf(rows),
      expectedShaA: sha256Of(bytesA),
      expectedShaB: sha256Of(bytesB),
    },
  };
}

// ── S3 同内容重传（UNDEFINED：记录是否复用 fileId） ─────────────────────────

const S3_NAME = '数据.xlsx';

async function runScenarioS3(): Promise<ScenarioOutcome> {
  const checks = new Checks();
  const observations: Observation[] = [];
  const bytes = fixtureBytes('s3 同一份内容');
  const harness = await makeHarness('s3', async () => '收到。', [USER_A]);
  const scope = { principalId: `${CHANNEL}:${USER_A}`, sessionId: `${CHANNEL}:${CONVERSATION_A}` };
  const handlerCalls: HandlerCall[] = [];
  try {
    for (const index of [1, 2]) {
      const attachment = stagedAttachment(harness.dir, S3_NAME, bytes);
      handlerCalls.push(await callHandler(harness, incomingMessage({
        userId: USER_A, conversationId: CONVERSATION_A, messageId: `r6-s3-${index}`,
        text: index === 1 ? '上传数据文件。' : '重新上传同一份数据文件。',
        attachments: [attachment],
      })));
    }
  } finally {
    await harness.server.close();
  }

  const fileIds = registeredFileIdsOf(harness.logs, scope.principalId);
  const rows = readFileRows(harness.dbPath, scope);
  const reused = fileIds.length === 2 && fileIds[0] === fileIds[1];
  const manifestTurn2 = manifestEntriesOf(harness.sink.runs.find((run) => run.turnNo === 2)?.injections ?? []);

  // 完整性前置（不判复用与否，只保证事实可观测）：两条消息都完成、行全部激活、字节一致。
  checks.check('s3-both-turns-completed', handlerCalls.every((call) => call.error === undefined),
    handlerCalls.find((call) => call.error !== undefined)?.error ?? '两条消息都正常完成');
  checks.check('s3-facts-observable', rows.length >= 1 && rows.every((row) => row.activated) && rows.every((row) => row.sha256 === sha256Of(bytes)),
    `file_refs=${JSON.stringify(rowsViewOf(rows))}（全部激活、sha 一致才可观测）`);
  checks.check('s3-turn2-manifest-consistent-with-rows', manifestTurn2.length === rows.length && manifestTurn2.every((entry) => rows.some((row) => row.fileId === entry.fileId)),
    `第 2 回合清单=${JSON.stringify(manifestTurn2)}；行数=${rows.length}`);

  observations.push({
    name: 's3-observation-fileid-reuse',
    detail: `同内容重传当前行为：登记 fileId=${JSON.stringify(fileIds)}，file_refs 行数=${rows.length}，`
      + `复用=${reused ? '是（同 fileId）' : '否（每次新 fileId）'}；两份字节都落盘（派生布局各自落点）。`
      + '对照：任务产物池登记有 sha256 去重（file-store.ts registerTaskFile：同 (scope, taskId, sha256) 复用旧 fileId），'
      + '入站登记（registerInboundFile→registerFromFd）无去重，恒 newFileId。',
  });

  return {
    scenario: 's3',
    title: '③ 同内容重传 → 记录是否复用 fileId（UNDEFINED）',
    status: checks.allPassed ? 'undefined' : 'fail',
    checks: checks.list,
    observations,
    notes: [],
    undefinedReason: '设计稿（cap01-main-direct-execution.md v8 §4）未定义入站同内容重传是否复用 fileId：'
      + 'file_refs 无 sha 去重键（主键 file_id），任务产物池的去重不覆盖入站面。当前行为=不复用（每次新 fileId、'
      + '旧行保留）；影响=清单里同名同内容条目按重传次数增长，模型可能引用任一重复份。不发明判据，仅登记。',
    evidence: {
      replies: handlerCalls,
      logs: harness.logs,
      driverRuns: harness.sink.runs,
      fileRefs: rowsViewOf(rows),
      manifestTurn2,
    },
  };
}

// ── S4 一条消息 2 个附件（UNDEFINED：记录当前行为） ──────────────────────────

async function runScenarioS4(): Promise<ScenarioOutcome> {
  const checks = new Checks();
  const observations: Observation[] = [];
  const bytesX = fixtureBytes('s4 附件一');
  const bytesY = fixtureBytes('s4 附件二');
  const harness = await makeHarness('s4', async () => '两个文件都收到了。', [USER_A]);
  const scope = { principalId: `${CHANNEL}:${USER_A}`, sessionId: `${CHANNEL}:${CONVERSATION_A}` };
  let call: HandlerCall;
  try {
    const attachments = [
      stagedAttachment(harness.dir, '甲表.xlsx', bytesX),
      stagedAttachment(harness.dir, '乙表.xlsx', bytesY),
    ];
    call = await callHandler(harness, incomingMessage({
      userId: USER_A, conversationId: CONVERSATION_A, messageId: 'r6-s4-1',
      text: '这两个文件都收一下，之后我会用到。',
      attachments,
    }));
  } finally {
    await harness.server.close();
  }

  const fileIds = registeredFileIdsOf(harness.logs, scope.principalId);
  const rows = readFileRows(harness.dbPath, scope);
  const manifest1 = manifestEntriesOf(harness.sink.runs.find((run) => run.turnNo === 1)?.injections ?? []);
  const registeredLog = harness.logs.find((line) => line['event'] === 'inbound_files_registered') as Record<string, unknown> | undefined;

  // 机械事实（可确定的必须确定）：两个附件都登记为独立行、都激活、清单并列、不崩溃。
  checks.check('s4-turn-completed', call.error === undefined, call.error ?? '回合正常完成');
  checks.check('s4-both-attachments-registered-activated', fileIds.length === 2 && rows.length === 2 && rows.every((row) => row.activated)
    && rows.some((row) => row.fileId === fileIds[0] && row.sha256 === sha256Of(bytesX))
    && rows.some((row) => row.fileId === fileIds[1] && row.sha256 === sha256Of(bytesY)),
    `登记 fileId=${JSON.stringify(fileIds)}；file_refs=${JSON.stringify(rowsViewOf(rows))}`);
  checks.check('s4-manifest-lists-both', manifest1.length === 2 && manifest1.every((entry) => fileIds.includes(entry.fileId)),
    `第 1 回合清单=${JSON.stringify(manifest1)}`);

  observations.push({
    name: 's4-observation-multi-attachment-behavior',
    detail: `一条消息 2 个附件当前行为：逐个登记为 2 个独立 pending 行（inbound_files_registered.fileIds=${JSON.stringify(registeredLog?.['fileIds'])}），`
      + `带文字的同条消息把两份一起激活（pending_files_activated），清单并列展示（${JSON.stringify(manifest1.map((entry) => entry.name))}）。`
      + '底账无 source_message_id/attachment_index（v8 §4 明确暂缓）——两份文件在账面上不可区分来自同一条消息。'
      + '对照：v8 §4 写「当前企微文件消息一条一个文件」，契约（channel.ts IncomingChannelMessage.attachments）允许多个，'
      + 'server 逐个登记（server.ts registerInboundAttachments）。',
  });

  return {
    scenario: 's4',
    title: '④ 一条消息带 2 个附件 → 记录当前行为（v8 写「一条一个文件」；UNDEFINED）',
    status: checks.allPassed ? 'undefined' : 'fail',
    checks: checks.list,
    observations,
    notes: [],
    undefinedReason: '契约允许多附件、v8 §4 按「一条一个文件」设计并暂缓 source_message_id/attachment_index；'
      + '一条消息多附件的用户级行为（登记粒度、清单呈现、后续引用口径）设计稿未定义判据。当前行为=逐个登记、'
      + '一起激活、清单并列、无消息归属字段。不发明判据，仅登记。',
    evidence: {
      reply: call,
      logs: harness.logs,
      driverRuns: harness.sink.runs,
      fileRefs: rowsViewOf(rows),
      manifestTurn1: manifest1,
    },
  };
}

// ── S5 不认识的格式（.pdf/.zip；UNDEFINED：追问还是硬算） ────────────────────

async function runScenarioS5(): Promise<ScenarioOutcome> {
  const checks = new Checks();
  const observations: Observation[] = [];
  const bytesPdf = fixtureBytes('s5 季度报告（PDF 字节形状无关紧要：生命周期层不解析）');
  const bytesZip = fixtureBytes('s5 打包资料（ZIP 字节形状无关紧要：生命周期层不解析）');
  const harness = await makeHarness('s5', async () => '收到，我会按清单处理。', [USER_A]);
  const scope = { principalId: `${CHANNEL}:${USER_A}`, sessionId: `${CHANNEL}:${CONVERSATION_A}` };
  const handlerCalls: HandlerCall[] = [];
  try {
    for (const [index, name, bytes, text] of [
      [1, '季度报告.pdf', bytesPdf, '帮我读这份 PDF 里的三季度数字。'],
      [2, '打包资料.zip', bytesZip, '这个 zip 里有一份 xlsx，帮我解开并按月汇总。'],
    ] as const) {
      const attachment = stagedAttachment(harness.dir, name, bytes);
      handlerCalls.push(await callHandler(harness, incomingMessage({
        userId: USER_A, conversationId: CONVERSATION_A, messageId: `r6-s5-${index}`, text, attachments: [attachment],
      })));
    }
  } finally {
    await harness.server.close();
  }

  const fileIds = registeredFileIdsOf(harness.logs, scope.principalId);
  const rows = readFileRows(harness.dbPath, scope);
  const manifest2 = manifestEntriesOf(harness.sink.runs.find((run) => run.turnNo === 2)?.injections ?? []);

  // 机械事实（可确定的必须确定）：不认识的格式不拒收、正常激活、清单照常注入（名字保留扩展名）。
  checks.check('s5-both-turns-completed', handlerCalls.every((call) => call.error === undefined),
    handlerCalls.find((call) => call.error !== undefined)?.error ?? '两条消息都正常完成');
  checks.check('s5-unknown-formats-registered-activated', fileIds.length === 2 && rows.length === 2 && rows.every((row) => row.activated)
    && rows.some((row) => row.name === '季度报告.pdf' && row.sha256 === sha256Of(bytesPdf))
    && rows.some((row) => row.name === '打包资料.zip' && row.sha256 === sha256Of(bytesZip)),
    `file_refs=${JSON.stringify(rowsViewOf(rows))}`);
  checks.check('s5-manifest-injects-unknown-formats-with-extension', manifest2.length === 2 && manifest2.some((entry) => entry.name === '季度报告.pdf') && manifest2.some((entry) => entry.name === '打包资料.zip'),
    `第 2 回合清单=${JSON.stringify(manifest2)}`);

  observations.push({
    name: 's5-observation-followup-or-force-is-model-behavior',
    detail: '「追问还是硬算」是模型行为：本脚本按验收口径脚本化、不调模型，不可观察，标 UNDEFINED；'
      + '真实行为归 R2 真模型批次（step-3.7-flash）观察。机械事实已断言：登记/激活/清单注入无格式门'
      + '（file-store 安全扩展名规则只影响落盘扩展名，file-store.ts:105-110；清单照常给出 .pdf/.zip 条目），'
      + '即模型在第 2 回合**会**在清单里看到这两个文件并可能尝试处理——追问/硬算由模型与技能面决定，'
      + '宿主机械层两者都不拦、也不提示「该格式不受支持」。',
  });

  return {
    scenario: 's5',
    title: '⑤ 不认识的格式（.zip/.pdf）→ 记录是追问还是硬算（UNDEFINED）',
    status: checks.allPassed ? 'undefined' : 'fail',
    checks: checks.list,
    observations,
    notes: [],
    undefinedReason: '「模型对清单里不认识的格式是追问还是硬算」是模型行为，脚本化验收不可观察；'
      + '设计稿也未对该行为定义判据（v8 §9 明确不做 PDF/Word 处理能力，但未写清单呈现后的模型行为口径）。'
      + '机械层事实已如实断言（无格式门、照常注入清单）。不发明判据，仅登记。',
    evidence: {
      replies: handlerCalls,
      logs: harness.logs,
      driverRuns: harness.sink.runs,
      fileRefs: rowsViewOf(rows),
      manifestTurn2: manifest2,
    },
  };
}

// ── S6 跨 principal 同 session 号（不串、同码 FILE_REF_UNAVAILABLE） ─────────

async function runScenarioS6(): Promise<ScenarioOutcome> {
  const checks = new Checks();
  const observations: Observation[] = [];
  const bytesA = fixtureBytes('s6 A 的共享数据（B 不得解析到）');
  const state: { fileId?: string } = {};
  const harness = await makeHarness(
    's6',
    async (ctx) => {
      if (ctx.lastUserText.startsWith('把刚发的')) {
        // B 的回合（createDrivers 按会话各建驱动实例；这里按消息文本判别身份分支）：
        // 先引用 A 的 fileId（越权），再引用一个不存在的 fileId（同码对照）。
        if (state.fileId === undefined) throw new Error('（r6 S6）B 回合缺少 A 登记的 fileId');
        try {
          await ctx.exec('run_js', { code: "console.log('should-not-run')", inputs: [state.fileId] });
        } catch {
          // 预期被拒：错误面已在 sink.calls 里记录，模型据此回话。
        }
        try {
          await ctx.exec('run_js', { code: "console.log('should-not-run')", inputs: ['file_00000000000000000000000000000000'] });
        } catch {
          // 预期被拒：同码对照。
        }
        return '这两个文件都引用不到，请确认文件是否已发到本会话。';
      }
      if (ctx.turnNo === 1) return '好的，共享文件已登记，等你下一步指示。';
      // A 的第 2 回合：同一 fileId、本人引用——应成功（拒的是越权，不是文件）。
      if (state.fileId === undefined) throw new Error('（r6 S6）A 第 2 回合缺少已登记的 fileId');
      await ctx.exec('run_js', {
        code: "const fs = require('fs'); console.log(fs.readdirSync('in').join(','));",
        inputs: [state.fileId],
      });
      return '文件引用成功。';
    },
    [USER_A, USER_B],
  );
  const scopeA = { principalId: `${CHANNEL}:${USER_A}`, sessionId: `${CHANNEL}:${CONVERSATION_SHARED}` };
  const scopeB = { principalId: `${CHANNEL}:${USER_B}`, sessionId: `${CHANNEL}:${CONVERSATION_SHARED}` };
  let handlerA1: HandlerCall;
  let handlerB1: HandlerCall;
  let handlerA2: HandlerCall;
  try {
    const attachment = stagedAttachment(harness.dir, '共享数据.xlsx', bytesA);
    handlerA1 = await callHandler(harness, incomingMessage({
      userId: USER_A, conversationId: CONVERSATION_SHARED, messageId: 'r6-s6-a1',
      text: '上传共享文件，等下要用。', attachments: [attachment],
    }));
    state.fileId = registeredFileIdsOf(harness.logs, scopeA.principalId)[0];
    handlerB1 = await callHandler(harness, incomingMessage({
      userId: USER_B, conversationId: CONVERSATION_SHARED, messageId: 'r6-s6-b1',
      text: '把刚发的共享文件按月汇总一下。',
    }));
    handlerA2 = await callHandler(harness, incomingMessage({
      userId: USER_A, conversationId: CONVERSATION_SHARED, messageId: 'r6-s6-a2',
      text: '现在把我的共享文件按月汇总一下。',
    }));
  } finally {
    await harness.server.close();
  }

  const fileId = state.fileId ?? '(未登记)';
  checks.check('s6-all-turns-completed', handlerA1.error === undefined && handlerB1.error === undefined && handlerA2.error === undefined,
    handlerA1.error !== undefined ? `A 第 1 回合失败：${handlerA1.error}` : handlerB1.error !== undefined ? `B 回合失败：${handlerB1.error}` : handlerA2.error !== undefined ? `A 第 2 回合失败：${handlerA2.error}` : '三个回合都正常完成');

  // 前提核验：两个 principal 的 sessionId 字符串相同（同 session 号），principalId 不同。
  const doneLogs = harness.logs.filter((line) => line['event'] === 'message_done') as Array<Record<string, unknown>>;
  const sessionIds = [...new Set(doneLogs.map((line) => line['sessionId']))];
  const principalIds = [...new Set(doneLogs.map((line) => line['principalId']))];
  checks.check('s6-same-session-number-two-principals', sessionIds.length === 1 && sessionIds[0] === `${CHANNEL}:${CONVERSATION_SHARED}` && principalIds.length === 2,
    `message_done 的 sessionId=${JSON.stringify(sessionIds)}（期望同为 "${CHANNEL}:${CONVERSATION_SHARED}"）；principalId=${JSON.stringify(principalIds)}`);

  // ① B 的越权引用被拒；对照的不存在引用也被拒。
  // run_js 调用序：B 回合两笔（越权 → 不存在）在前，A 第 2 回合的成功引用在后。
  const bRun = harness.sink.runs.find((run) => run.lastUserText.startsWith('把刚发的'));
  const allRunJsCalls = harness.sink.calls.filter((call) => call.tool === 'run_js');
  const foreignCall = allRunJsCalls[0];
  const missingCall = allRunJsCalls[1];
  checks.check('s6-b-cross-principal-reference-rejected', bRun !== undefined && foreignCall !== undefined && foreignCall.isError === true && foreignCall.args['inputs']?.[0] === fileId,
    `B 的 run_js 调用=${JSON.stringify(allRunJsCalls.map((call) => ({ args: call.args, isError: call.isError })))}；A 的 fileId=${fileId}`);

  // ② 同码：越权引用与不存在引用的用户可见错误文本逐字节相同（防存在性 oracle）。
  checks.check('s6-same-code-uniform-message', foreignCall?.errorMessage === EXPECTED_FILE_INPUT_UNAVAILABLE_MESSAGE && missingCall?.errorMessage === EXPECTED_FILE_INPUT_UNAVAILABLE_MESSAGE,
    `越权引用错误=${JSON.stringify(foreignCall?.errorMessage)}；不存在引用错误=${JSON.stringify(missingCall?.errorMessage)}；期望统一话术=${JSON.stringify(EXPECTED_FILE_INPUT_UNAVAILABLE_MESSAGE)}`);

  // ③ 底账隔离：B scope 0 行、A scope 1 行；B 的清单注入不含 A 的 fileId。
  const rowsA = readFileRows(harness.dbPath, scopeA);
  const rowsB = readFileRows(harness.dbPath, scopeB);
  const bManifest = manifestEntriesOf(bRun?.injections ?? []);
  checks.check('s6-ledger-scope-isolated', rowsA.length === 1 && rowsA[0]?.fileId === fileId && rowsB.length === 0,
    `A scope 行=${JSON.stringify(rowsViewOf(rowsA))}；B scope 行=${JSON.stringify(rowsViewOf(rowsB))}`);
  checks.check('s6-b-manifest-has-no-foreign-fileid', !bManifest.some((entry) => entry.fileId === fileId),
    `B 回合清单注入=${JSON.stringify(bManifest)}（B 无文件 → 无清单注入，更不含 A 的 fileId）`);

  // ④ A 自己引用同一 fileId 成功（拒的是越权，不是文件本身）。
  const aRunJsCall = allRunJsCalls[2];
  const aResult = aRunJsCall?.result as { exitCode?: number; inputs?: Array<{ fileId: string }> } | undefined;
  checks.check('s6-a-self-reference-succeeds', aRunJsCall !== undefined && aRunJsCall.isError === false && aResult?.exitCode === 0 && aResult?.inputs?.[0]?.fileId === fileId,
    `A 的 run_js=${JSON.stringify({ isError: aRunJsCall?.isError ?? 'missing', exitCode: aResult?.exitCode, inputs: aResult?.inputs })}`);

  // 底账层同码：同一 FileRefUnavailableError（code=FILE_REF_UNAVAILABLE）盖越权与不存在。
  const roRegistry = createSqliteTaskRegistry(harness.dbPath, { readOnly: true });
  let foreignReason = '';
  let missingReason = '';
  let foreignCode = '';
  let missingCode = '';
  try {
    const roFileStore = createFileStore({ store: roRegistry.store, workspaceRoot: harness.workspaceRoot });
    const runDir = path.join(harness.dir, 'ro-materialize');
    try {
      roFileStore.materializeInputs({ runDir, scope: scopeB, fileIds: [fileId], resolution: { side: 'main' } });
    } catch (error) {
      if (error instanceof FileRefUnavailableError) {
        foreignCode = error.code;
        foreignReason = error.reason;
      } else {
        foreignReason = `非预期错误类型：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    try {
      roFileStore.materializeInputs({ runDir, scope: scopeB, fileIds: ['file_00000000000000000000000000000000'], resolution: { side: 'main' } });
    } catch (error) {
      if (error instanceof FileRefUnavailableError) {
        missingCode = error.code;
        missingReason = error.reason;
      } else {
        missingReason = `非预期错误类型：${error instanceof Error ? error.message : String(error)}`;
      }
    }
  } finally {
    roRegistry.close();
  }
  checks.check('s6-store-level-file-ref-unavailable-code', foreignCode === 'FILE_REF_UNAVAILABLE' && missingCode === 'FILE_REF_UNAVAILABLE',
    `越权 reason=${JSON.stringify(foreignReason)} code=${foreignCode}；不存在 reason=${JSON.stringify(missingReason)} code=${missingCode}（file-store.ts FileRefUnavailableError.code）`);
  observations.push({
    name: 's6-observation-store-mechanical-reasons',
    detail: `底账层机械 reason（只进日志、不进用户话术，v8 §4）：越权=${JSON.stringify(foreignReason)}；不存在=${JSON.stringify(missingReason)}——`
      + '两者同为 missing_or_foreign 形状（解析侧查询 principal/session/task 绑定行，越权与不存在在 task-store.ts getFileRef 同为 undefined）。',
  });

  return {
    scenario: 's6',
    title: '⑥ 跨 principal 同 session 号 → 不串（同码 FILE_REF_UNAVAILABLE）',
    status: checks.allPassed ? 'pass' : 'fail',
    checks: checks.list,
    observations,
    notes: [],
    evidence: {
      replies: [handlerA1, handlerB1, handlerA2],
      logs: harness.logs,
      driverRuns: harness.sink.runs,
      toolCalls: harness.sink.calls,
      fileRefsA: rowsViewOf(rowsA),
      fileRefsB: rowsViewOf(rowsB),
    },
  };
}

// ── 入口 ────────────────────────────────────────────────────────────────────

interface CliOptions {
  scenarios: ScenarioId[];
  outDir: string;
}

const ALL_SCENARIOS: ScenarioId[] = ['s1', 's2', 's3', 's4', 's5', 's6'];

function parseCli(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    scenarios: [...ALL_SCENARIOS],
    outDir: path.join(REPO_ROOT, '.runtime', 'eval-cap01-r6-lifecycle', new Date().toISOString().replace(/[:.]/g, '-')),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--scenario') {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error('--scenario 需要值（s1..s6，逗号分隔）');
      const picked = value.split(',').map((item) => item.trim()).filter((item) => item !== '') as ScenarioId[];
      const valid = picked.filter((item) => ALL_SCENARIOS.includes(item));
      if (valid.length !== picked.length || valid.length === 0) throw new Error(`--scenario 只认 ${ALL_SCENARIOS.join('/')}：${value}`);
      options.scenarios = valid;
    } else if (arg === '--out-dir') {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error('--out-dir 需要值');
      options.outDir = path.resolve(value);
    } else {
      throw new Error(`未知参数：${arg}（支持 --scenario / --out-dir）`);
    }
  }
  return options;
}

const SCENARIO_RUNNERS: Record<ScenarioId, () => Promise<ScenarioOutcome>> = {
  s1: runScenarioS1,
  s2: runScenarioS2,
  s3: runScenarioS3,
  s4: runScenarioS4,
  s5: runScenarioS5,
  s6: runScenarioS6,
};

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  mkdirSync(cli.outDir, { recursive: true });
  console.log(`[cap01-r6] mode=scripted（零模型调用）scenarios=${cli.scenarios.join(',')} outDir=${cli.outDir}`);

  const outcomes: ScenarioOutcome[] = [];
  for (const scenario of cli.scenarios) {
    console.log(`[cap01-r6] ── 场景 ${scenario.toUpperCase()} 开始 ──`);
    const started = Date.now();
    let outcome: ScenarioOutcome;
    try {
      outcome = await SCENARIO_RUNNERS[scenario]();
    } catch (error) {
      outcome = {
        scenario,
        title: '（场景级异常）',
        status: 'fail',
        checks: [{ name: `${scenario}-harness`, pass: false, detail: `场景抛错：${error instanceof Error ? (error.stack ?? error.message) : String(error)}` }],
        observations: [],
        notes: ['场景级异常（装配/渠道层），证据缺失即 FAIL'],
        evidence: {},
      };
    }
    outcome.evidence = { ...outcome.evidence, durationMs: Date.now() - started, mode: 'scripted' };
    const evidencePath = path.join(cli.outDir, `${outcome.scenario}-evidence.json`);
    writeFileSync(evidencePath, JSON.stringify(outcome.evidence, null, 2) + '\n');
    for (const check of outcome.checks) {
      console.log(`[cap01-r6] ${outcome.scenario} ${check.pass ? 'PASS' : 'FAIL'} ${check.name} — ${check.detail}`);
    }
    for (const observation of outcome.observations) {
      console.log(`[cap01-r6] ${outcome.scenario} OBSERVE ${observation.name} — ${observation.detail}`);
    }
    if (outcome.undefinedReason !== undefined) {
      console.log(`[cap01-r6] ${outcome.scenario} UNDEFINED — ${outcome.undefinedReason}`);
    }
    console.log(`[cap01-r6] ── 场景 ${outcome.scenario.toUpperCase()} ${outcome.status.toUpperCase()}（${Date.now() - started}ms，证据=${evidencePath}）──`);
    outcomes.push(outcome);
  }

  const failed = outcomes.filter((outcome) => outcome.status === 'fail');
  const undefinedScenarios = outcomes.filter((outcome) => outcome.status === 'undefined');
  const summary = {
    mode: 'scripted' as const,
    model: 'scripted（零模型调用；R6 生命周期为脚本化验收）',
    scenarios: Object.fromEntries(outcomes.map((outcome) => [
      outcome.scenario,
      {
        title: outcome.title,
        status: outcome.status,
        checks: outcome.checks,
        observations: outcome.observations,
        ...(outcome.undefinedReason !== undefined ? { undefinedReason: outcome.undefinedReason } : {}),
      },
    ])),
    undefinedScenarios: undefinedScenarios.map((outcome) => outcome.scenario),
    failScenarios: failed.map((outcome) => outcome.scenario),
    allPass: failed.length === 0,
  };
  const summaryPath = path.join(cli.outDir, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  for (const outcome of outcomes) {
    console.log(`[cap01-r6] ${outcome.scenario}=${outcome.status.toUpperCase()}（asserts=${outcome.checks.filter((check) => check.pass).length}/${outcome.checks.length}）`);
  }
  if (undefinedScenarios.length > 0) {
    console.log(`[cap01-r6] UNDEFINED（记录不判定）= ${undefinedScenarios.map((outcome) => outcome.scenario).join(',')} — 明细见 summary.json`);
  }
  console.log(`[cap01-r6] 汇总=${summaryPath}`);
  if (failed.length > 0) process.exitCode = 1;
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error('[cap01-r6] 入口失败：', error);
    process.exitCode = 1;
  });
}
