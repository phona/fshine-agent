/**
 * CAP-01 R2c 产物与失败面验收（r2-functional.ts 的姊妹篇；可重复执行，不靠人工点）。
 *
 * 口径（CAP-01 设计 v8 §2/§3/§7/§10-3，文档 2026-11-18 删除、git 历史可考 + R2c 验收指令）：
 * 只验用户可见结果与安全不变量；全样本保留，不筛绿；失败样本连证据一起落盘。
 * 装配与 r2-functional 同源：apps/server/server.ts 生产装配缺省链（fileStore / run_js
 * 受限执行器 / 清单注入 / 主动投递 B），假渠道 = 直调 server.handler，执行层 = 仓内 dummy 面。
 *
 * 九个场景（s1..s9，对应验收指令 ①..⑨）：
 *   s1 多输入（①）：一条消息带 5 个附件 + 文字 → 断言**至少一次** run_js 调用的 inputs 覆盖
 *      全部 5 个入站 fileId（「5 个文件同时」面；调用次数本身不判红——模型首次脚本失败后
 *      自纠重试属正常 Agent 行为，观测面记各次 exitCode）、该批调用结果 inputs 五条全部
 *      物化（materializedName 齐全）、5 个标记词全部可读（scripted 夹具：标记词经产物
 *      「读回清单」回读；真模型：按指令写进回复）。
 *   s2 三产物（②）：一次产出 3 个产物 → 全登记（file_refs 三行）、全交付（端口收 3 个）、
 *      顺序稳定（交付序 == 名称字典序——host 走查按 relPath 全排序，file-store.ts
 *      collectCandidates；scripted 夹具故意按 c→a→b 乱序写盘，交付仍必须是 a→b→c）。
 *   s3 空 out/（③）：脚本不产出任何文件 → 不交付（端口 0 调用、无 file_delivery 事件）、
 *      话术不许出现发送/附件类断言（不许说「已发送」）。
 *   s4 非零退出（④）：脚本 process.exit(2) → 前提 = run_js 结果 exitCode=2；用户看到失败
 *      话术，且不得出现成功类断言（不许说成功）；失败回合不得有产物交付。
 *   s5 超时（⑤）：脚本先写 out/ 再死循环 → 前提 = exitCode null + exitSignal SIGKILL +
 *      回合耗时 ≥ 115s（宿主常量 120s，run-js-executor.ts RUN_JS_TIMEOUT_MS，只会晚不会早）；
 *      用户看到「超时」话术；**产物仍收取**（v8 §10-3：宿主对失败也扫 out/——超时前写的那份
 *      产物必须登记进 file_refs 并照常交付、字节一致）。
 *   s6 语法错误（⑥）：代码 `const x = ;` → 前提 = exitCode≠0 且 stderr 含 SyntaxError
 *      （并含 run.cjs 绝对路径 = 泄漏向量真实存在）；用户看到可读报错，且回复**不泄漏宿主
 *      绝对路径**（生产同源探针 hasServerPath + 字面 run.cjs 路径 + tmpdir 根三查——用户可见
 *      回复在 runtime 出口过 stripServerPaths，v8 §7 出口清理）。
 *   s7 40MB 产物（⑦）[UNDEFINED 记录]：写 40MB 文件（> 渠道 32MB 上限、< 宿主单产物上限
 *      50MiB）→ 记录宿主实际行为：登记（字节精确）+ 端口收到全量字节（宿主面无 32MB 门）。
 *      设计稿未定义超渠道上限产物行为 → 标 UNDEFINED，不做产品级判红。
 *   s8 out/ 子目录（⑧）[UNDEFINED 记录]：out/ 顶层 + 子目录各一份 → 记录宿主是只扫顶层
 *      还是递归（当前实现递归走查、relPath 连同子目录名进交付文件名）。设计稿 v8 §2 只写
 *      「里面每个文件都登记并本轮交付」，未写明层级口径 → 标 UNDEFINED。
 *   s9 两产物同名（⑨）[UNDEFINED 记录]：同一回合两次 run_js 各写一份同名文件 → 记录覆盖/
 *      拒收/加后缀哪一种发生（当前实现：各自新 fileId、同名双行登记、同名双双交付）。
 *      设计稿未定义产物同名行为 → 标 UNDEFINED。
 *
 * 模型口径：**话术面场景（s3/s4/s5/s6）缺省用真实模型 step-3.7-flash**（与历史批次同源：
 * config/agent.fixture.yaml + LLM_* env），其余场景（s1/s2/s7/s8/s9）缺省脚本化——它们是
 * 机械面/记录面，被测行为不在模型，预算（≤24 calls）留给话术面。calls 计法 = 真实模式下
 * 转录 assistant 消息条数（与 r2-functional/convergence-r1 同源；scripted 场景计 0）。
 * --scripted 全部降级脚本化（同一段断言原样跑，报告写 mode=scripted）；--real s1,s2 可把
 * 机械面场景也跑真模型。真实回合中途失败一律如实记 FAIL，不静默降级、不重试换样本。
 * s7/s8/s9 是 UNDEFINED 记录面：断言只覆盖机械管线事实（登记/交付发生且与观察一致），
 * 观察本身（递归/同名双投/无 32MB 门）进 notes 与 summary.undefinedObservations，不判产品红。
 *
 * 运行：
 *   node --env-file=<含 LLM_API_KEY 的 env> --import tsx scripts/eval/cap01/r2c-artifacts.ts \
 *     [--scripted] [--real s1,s2] [--scripted-only s5] [--scenario s1..s9 子集] [--out-dir <dir>]
 * 缺省 out-dir = .runtime/eval-cap01-r2c/<时间戳>（.runtime 不进 git）。
 * 退出码：0 = 全部场景过（UNDEFINED 记录面按其管线事实计）；1 = 任一 FAIL。
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
import { hasServerPath } from '../../../packages/agent/src/server-paths';
import { createSqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import { contextWindowFrom, compactionSettingsFrom } from '../../ask-runtime';
import { materializeEvalConfig } from '../../resolve-config-path';
import { createServer, type FileDeliveryPort } from '../../../apps/server/server';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');

const PRINCIPAL_ID = 'wecom:fixture-user';
const CONVERSATION_ID = 'conv-cap01-r2c';

// ── s1 夹具：5 个附件，首行标记词互异（「全部可读」的 Oracle） ────────────────
const S1_MARKERS = ['标记甲', '标记乙', '标记丙', '标记丁', '标记戊'] as const;
const S1_ATTACHMENT_NAMES = ['数据-01.csv', '数据-02.csv', '数据-03.csv', '数据-04.csv', '数据-05.csv'] as const;

function buildS1FixtureBytes(index: number): Buffer {
  const marker = S1_MARKERS[index]!;
  return Buffer.from(`${[marker, `数据行 ${index}-A`, `数据行 ${index}-B`].join('\n')}\n`, 'utf8');
}

// ── s5 夹具：先写产物再死循环（宿主 120s 超时杀进程组；产物必须被 §10-3 兜底收取） ──
const S5_ARTIFACT_NAME = '部分产物.txt';
const S5_ARTIFACT_TEXT = '超时前已写入';
const S5_TIMEOUT_CODE = [
  "const fs = require('fs');",
  `fs.writeFileSync('out/${S5_ARTIFACT_NAME}', ${JSON.stringify(S5_ARTIFACT_TEXT)});`,
  'while (true) {}',
].join('\n');
/** 宿主超时常量 120s（run-js-executor.ts:44 RUN_JS_TIMEOUT_MS）；handler 侧耗时只会更大。 */
const S5_MIN_ELAPSED_MS = 115_000;

// ── s7 夹具：40MB（渠道上限 32MB = 33554432 < 41943040 < 宿主单产物上限 50MiB） ──
const S7_BYTES = 40 * 1024 * 1024;
const S7_NAME = 'big-40mb.bin';
const S7_CHANNEL_LIMIT_BYTES = 32 * 1024 * 1024;
const S7_CODE = `const fs = require('fs');\nfs.writeFileSync('out/${S7_NAME}', Buffer.alloc(${S7_BYTES}, 65));`;

// ── s8 夹具：out/ 顶层 + 子目录各一份（记录顶层/递归口径） ────────────────────
const S8_TOP_NAME = '顶层文件.txt';
const S8_NESTED_NAME = '子目录/内层文件.txt';
const S8_CODE = [
  "const fs = require('fs');",
  `fs.writeFileSync('out/${S8_TOP_NAME}', '顶层');`,
  "fs.mkdirSync('out/子目录', { recursive: true });",
  `fs.writeFileSync('out/${S8_NESTED_NAME}', '内层');`,
].join('\n');

// ── s9 夹具：同一回合两次 run_js 各写一份同名文件（记录覆盖/拒收/加后缀） ──────
const S9_NAME = '同名产物.txt';
const S9_CODE_A = `const fs = require('fs');\nfs.writeFileSync('out/${S9_NAME}', '第一份内容');`;
const S9_CODE_B = `const fs = require('fs');\nfs.writeFileSync('out/${S9_NAME}', '第二份内容');`;

// ── s2 夹具：三个产物；scripted 夹具故意按 c→a→b 乱序写盘，交付序必须仍是字典序 ──
const S2_CODE_SCRAMBLED = [
  "const fs = require('fs');",
  `fs.writeFileSync('out/c-说明.txt', '说明内容');`,
  `fs.writeFileSync('out/a-总览.csv', '总览内容');`,
  `fs.writeFileSync('out/b-明细.csv', '明细内容');`,
].join('\n');

// ── s3/s4/s6 夹具代码 ────────────────────────────────────────────────────────
const S3_CODE = "console.log('没有产物');";
const S4_CODE = 'process.exit(2);';
const S6_CODE = 'const x = ;';

// ── 记录包装器（与 r2-functional 同形；透传不改语义） ────────────────────────

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

// ── 交付端口（live 捕获；顺序敏感——交付序就是 sendToConversation 收到的文件序） ──

interface DeliveredFile {
  filename: string;
  bytes: number;
  sha256: string;
  data: Buffer;
}

interface PortCapture {
  deliveryMode: 'live';
  calls: Array<{ route: ChannelRoute; files: DeliveredFile[] }>;
}

function capturePort(): PortCapture & FileDeliveryPort {
  const capture: PortCapture = { deliveryMode: 'live', calls: [] };
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

// ── 场景夹具：server 生产装配（缺省执行器/文件区/清单注入/投递 B） ────────────

interface ScenarioHarness {
  dir: string;
  dbPath: string;
  server: Awaited<ReturnType<typeof createServer>>;
  logs: Array<Record<string, unknown>>;
  sink: ScenarioSink;
  port: PortCapture & FileDeliveryPort;
  startedAt: number;
}

async function makeHarness(options: {
  port: PortCapture & FileDeliveryPort;
  mode: 'real' | 'scripted';
  scriptedMain: () => TurnDriver;
  label: string;
}): Promise<ScenarioHarness> {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cap01-r2c-${options.label}-`));
  const dbPath = path.join(dir, 'state.db');
  // 配置：仓内 dummy 面同源物化（与 ask/eval 同一份 fixture 配置），dbPath 指入本场景。
  const configCopy = path.join(dir, 'agent-config.yaml');
  materializeEvalConfig(FIXTURE_CONFIG, configCopy);
  const configDoc = parseYaml(readFileSync(configCopy, 'utf8')) as Record<string, unknown>;
  configDoc['store'] = { dbPath };
  writeFileSync(configCopy, stringifyYaml(configDoc));
  const config: AppConfig = loadConfig({ yamlPath: configCopy });
  const env = effectiveDeploymentEnv(config, process.env);

  const sink: ScenarioSink = { calls: [], runs: [] };
  const createDrivers =
    options.mode === 'scripted'
      ? (): { mainDriver: TurnDriver; workerDriver: TurnDriver } => ({
          mainDriver: recordingDriver(options.scriptedMain(), 'main', sink),
          workerDriver: recordingDriver(scriptedWorkerDriver(), 'worker', sink),
        })
      : (driverEnv: NodeJS.ProcessEnv): { mainDriver: TurnDriver; workerDriver: TurnDriver } => {
          // 与 server 缺省装配同一构造（ask-runtime.ts 的缺省分支），只多一层记录包装。
          const make = (reuseConversation: boolean): TurnDriver =>
            recordingDriver(
              createPiTurnDriver({ env: driverEnv, ...contextWindowFrom(driverEnv), ...compactionSettingsFrom(driverEnv), ...(reuseConversation ? { reuseConversation: true } : {}) }),
              reuseConversation ? 'main' : 'worker',
              sink,
            );
          return { mainDriver: make(true), workerDriver: make(false) };
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
  return { dir, dbPath, server, logs, sink, port: options.port, startedAt: Date.now() };
}

/** 实际模型名（转录 assistant.model.id；与 r2-functional 同源面）。 */
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

// ── 脚本化驱动（mode=scripted 用；同一段断言原样跑，报告写 mode=scripted） ────

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

interface RunJsToolResult {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outputs: Array<{ fileId: string; name: string; bytes: number }>;
  inputs: Array<{ fileId: string; name: string; materializedName: string }>;
}

function asRunJsResult(value: unknown): RunJsToolResult {
  return value as RunJsToolResult;
}

/** 本脚本不涉及 Worker 委派；Worker 面被触发即异常（防御性）。 */
function scriptedWorkerDriver(): TurnDriver {
  return {
    async run() {
      throw new Error('r2c 不涉及 Worker 委派——Worker 面被意外触发。');
    },
  };
}

/** 文件清单注入里的全部 fileId（manifest 行形状见 execution-runtime.ts renderFileManifest）。 */
function allFileIdsFrom(injections: readonly string[]): string[] {
  const ids: string[] = [];
  for (const text of injections) {
    for (const match of text.matchAll(/fileId:\s*(file_[0-9a-f]{32})/g)) {
      if (!ids.includes(match[1]!)) ids.push(match[1]!);
    }
  }
  return ids;
}

function makeScriptedMain(kind: 's1' | 's2' | 's3' | 's4' | 's5' | 's6' | 's7' | 's8' | 's9'): TurnDriver {
  return {
    async run(input) {
      const fileIds = allFileIdsFrom(input.injections ?? []);
      const finish = (text: string): { text: string; messages: DriverMessage[] } => ({
        text,
        messages: [scriptedAssistant(text)],
      });
      if (kind === 's1') {
        // 一次调用带全部 5 个输入；产物 = 每个物化文件首行标记词的读回清单。
        const code = [
          "const fs = require('fs');",
          "const path = require('path');",
          'const lines = [];',
          "for (const entry of fs.readdirSync('in').sort()) {",
          "  const first = fs.readFileSync(path.join('in', entry), 'utf8').split('\\n')[0].trim();",
          "  lines.push(entry + '=' + first);",
          '}',
          "fs.writeFileSync('out/读回清单.txt', lines.join('\\n'));",
        ].join('\n');
        await input.exec('run_js', { code, ...(fileIds.length > 0 ? { inputs: fileIds } : {}) });
        return finish(`已读取 ${fileIds.length} 个附件：${S1_MARKERS.join('、')}。`);
      }
      if (kind === 's2') {
        await input.exec('run_js', { code: S2_CODE_SCRAMBLED });
        return finish('已生成 3 个文件（a-总览.csv、b-明细.csv、c-说明.txt），见附件。');
      }
      if (kind === 's3') {
        const result = asRunJsResult(await input.exec('run_js', { code: S3_CODE }));
        return finish(`脚本运行结束（exitCode=${result.exitCode}），没有产出任何文件。`);
      }
      if (kind === 's4') {
        const result = asRunJsResult(await input.exec('run_js', { code: S4_CODE }));
        return finish(`脚本执行失败：退出码 ${result.exitCode}（非零），没有产出文件。`);
      }
      if (kind === 's5') {
        // exec 会阻塞到宿主超时（120s）杀进程组；产物按 §10-3 兜底收取。
        const result = asRunJsResult(await input.exec('run_js', { code: S5_TIMEOUT_CODE }));
        const collected = result.outputs.map((file) => file.name).join('、') || '（无）';
        return finish(`脚本超时，被宿主强制终止；超时前写出的产物已收取：${collected}。`);
      }
      if (kind === 's6') {
        // 故意原样回贴 stderr（模拟会转贴报错的模型）——用户可见回复必须被出口清理剥掉宿主路径。
        const result = asRunJsResult(await input.exec('run_js', { code: S6_CODE }));
        return finish(`脚本报错了：${result.stderr}`);
      }
      if (kind === 's7') {
        await input.exec('run_js', { code: S7_CODE });
        return finish('已生成 40MB 文件。');
      }
      if (kind === 's8') {
        await input.exec('run_js', { code: S8_CODE });
        return finish('已生成顶层与子目录文件。');
      }
      // s9：同一回合两次 run_js，各写一份同名文件（code 不同 → 幂等键不同 → 各自执行）。
      const first = asRunJsResult(await input.exec('run_js', { code: S9_CODE_A }));
      const second = asRunJsResult(await input.exec('run_js', { code: S9_CODE_B }));
      return finish(`两次运行各登记了 ${first.outputs.length}+${second.outputs.length} 份同名产物。`);
    },
  };
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

function stagedAttachment(root: string, filename: string, bytes: Buffer): IncomingAttachment {
  const dir = path.join(root, 'attachments');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, bytes);
  return { filename, path: filePath, bytes: bytes.length };
}

function incomingMessage(messageId: string, text: string, attachments: readonly IncomingAttachment[]): IncomingChannelMessage {
  return {
    wecomUserId: 'fixture-user',
    channel: 'wecom',
    conversationId: CONVERSATION_ID,
    messageId,
    chatType: 'single',
    text,
    ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
    receivedAt: new Date().toISOString(),
  };
}

function deliveredFiles(port: PortCapture): DeliveredFile[] {
  return port.calls.flatMap((call) => call.files);
}

/** handler 回执的用户可见正文（string 直用；RichChannelReply 取 text）。 */
function textOf(reply: ChannelReply): string {
  return typeof reply === 'string' ? reply : reply.text ?? '';
}

/** run_js 工具调用记录（agent=main，非报错）。 */
function runJsCalls(sink: ScenarioSink): ToolCallRecord[] {
  return sink.calls.filter((call) => call.agent === 'main' && call.tool === 'run_js' && !call.isError);
}

/** 只读开底账取 file_refs 行（进程结束后开，同 r2-functional 口径）。 */
function readFileRefs(dbPath: string): Array<{ fileId: string; taskId?: string; name: string; sha256: string; bytes: number }> {
  const registry = createSqliteTaskRegistry(dbPath, { readOnly: true });
  try {
    return registry
      .store.listFileRefs({ principalId: PRINCIPAL_ID, sessionId: `wecom:${CONVERSATION_ID}` })
      .map((row) => ({
        fileId: row.fileId,
        ...(row.taskId !== undefined ? { taskId: row.taskId } : {}),
        name: row.name,
        sha256: row.sha256,
        bytes: row.bytes,
      }));
  } finally {
    registry.close();
  }
}

/** calls 口径 = 真实模型 assistant 消息数（预算面）；scripted 场景计 0（见文件头）。 */
function callsOf(mode: 'real' | 'scripted', runs: readonly DriverRunRecord[]): number {
  if (mode !== 'real') return 0;
  return runs.reduce((sum, run) => sum + assistantCount(run.resultMessages), 0);
}

// ── 话术判据（验收指令原话的机械形状；实际回复全文进证据供人工复核） ──────────

/** 发送/附件类断言（s3 不许出现——out/ 空时用户不该被告知文件已发）。 */
const SEND_CLAIM_PATTERN = /已发送|已送达|已发出|已上传|已投递|已生成|已发到|发给你了|见附件|附件里/;
/** 成功类断言（s4 不许出现——非零退出不是成功；「没/未/不」+词的否定用法不算）。 */
const SUCCESS_CLAIM_PATTERN = /(?<![没未不])成功|(?<![没未不])完成|搞定|办好|已生成|已发送|已送达/;
/** 失败类话术（s4 用户必须能看到失败）。 */
const FAIL_WORDING_PATTERN = /失败|错误|出错|异常|退出码|exit.?code|非零|没跑成|未能|中断|终止/;

// ── 场景公共执行面 ──────────────────────────────────────────────────────────

interface ScenarioOutcome {
  scenario: string;
  status: 'pass' | 'fail';
  mode: 'real' | 'scripted';
  checks: Check[];
  notes: string[];
  undefinedObservations: string[];
  calls: number;
  error?: string;
  evidence: Record<string, unknown>;
}

interface CommonRun {
  harness: ScenarioHarness;
  reply: ChannelReply;
  handlerError?: string;
}

async function runWithHarness(options: {
  mode: 'real' | 'scripted';
  scenario: string;
  instruction: string;
  attachments?: readonly { filename: string; bytes: Buffer }[];
  scriptedMain: () => TurnDriver;
}): Promise<CommonRun> {
  const port = capturePort();
  const harness = await makeHarness({ port, mode: options.mode, scriptedMain: options.scriptedMain, label: options.scenario });
  let reply: ChannelReply = '';
  let handlerError: string | undefined;
  try {
    const attachments = (options.attachments ?? []).map((entry) => stagedAttachment(harness.dir, entry.filename, entry.bytes));
    try {
      reply = await harness.server.handler(incomingMessage(`r2c-${options.scenario}-1`, options.instruction, attachments));
    } catch (error) {
      handlerError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    await harness.server.close();
  }
  return { harness, reply, ...(handlerError === undefined ? {} : { handlerError }) };
}

function outcomeOf(outcome: ScenarioOutcome): ScenarioOutcome {
  return outcome;
}

// ── s1 多输入（①）：5 个附件同一条消息 → 全部物化、全部可读 ──────────────────

const S1_INSTRUCTION =
  '我刚发了 5 个附件（数据-01.csv 到 数据-05.csv）。请用 run_js 一次性（一次调用、inputs 带上全部 5 个文件）'
  + '读取这 5 个附件，把每个文件第一行的标记词原样告诉我，不要遗漏任何一个。';

async function runS1(mode: 'real' | 'scripted'): Promise<ScenarioOutcome> {
  const scenario = 's1';
  const checks = new Checks();
  const notes: string[] = [];
  const { harness, reply, handlerError } = await runWithHarness({
    mode,
    scenario,
    instruction: S1_INSTRUCTION,
    attachments: S1_ATTACHMENT_NAMES.map((filename, index) => ({ filename, bytes: buildS1FixtureBytes(index) })),
    scriptedMain: () => makeScriptedMain('s1'),
  });
  const delivered = deliveredFiles(harness.port);
  const inboundLog = harness.logs.find((line) => line['event'] === 'inbound_files_registered') as Record<string, unknown> | undefined;
  const inboundIds = Array.isArray(inboundLog?.['fileIds']) ? (inboundLog['fileIds'] as string[]) : [];
  const calls = runJsCalls(harness.sink);

  // ① 一条消息登记了 5 个入站文件。
  checks.check(
    's1-five-inbound-registered',
    handlerError === undefined && inboundIds.length === 5,
    handlerError !== undefined ? `回合失败：${handlerError}` : `inbound_files_registered.fileIds=${inboundIds.length} 个`,
  );

  // ②「5 个文件同时」：至少一次 run_js 调用的 inputs 覆盖全部 5 个入站 fileId。
  //   判据 = 验收指令「5 个文件同时」：一次调用同时带 5 个输入即算同时面成立；
  //   调用次数本身不判红（模型首次脚本失败后自纠重试属正常 Agent 行为，见观测面 NOTE）。
  const callInputs = calls.map((call) => {
    const args = call.args as { inputs?: unknown };
    return Array.isArray(args.inputs) ? (args.inputs as string[]) : [];
  });
  const multiCall = calls.find((_, index) => callInputs[index]!.length === 5 && inboundIds.every((id) => callInputs[index]!.includes(id)));
  checks.check(
    's1-multi-input-call-covers-all-five',
    calls.length >= 1 && multiCall !== undefined,
    `run_js 调用=${calls.length}（各次 inputs 数=${JSON.stringify(callInputs.map((inputs) => inputs.length))}，各次 exitCode=${JSON.stringify(calls.map((call) => asRunJsResult(call.result).exitCode))}）；存在单次带全 5 个=${multiCall !== undefined}`,
  );

  // ③ 全部物化：上述同时面调用（每一批 5 个输入）的工具结果 inputs 五条齐全、materializedName 全非空。
  const multiResults = calls
    .map((call) => asRunJsResult(call.result))
    .filter((result, index) => callInputs[index]!.length === 5);
  const allMaterialized = multiResults.length >= 1 && multiResults.every((result) =>
    (result.inputs ?? []).length === 5
    && (result.inputs ?? []).every((entry) => typeof entry.materializedName === 'string' && entry.materializedName !== '')
    && inboundIds.every((id) => (result.inputs ?? []).some((entry) => entry.fileId === id)),
  );
  checks.check(
    's1-all-materialized',
    allMaterialized,
    `带 5 输入的调用结果=${multiResults.length} 个：${JSON.stringify(multiResults.map((result) => result.inputs?.map((entry) => entry.materializedName)))}`,
  );

  // ④ 全部可读：scripted 夹具把每个文件首行写进产物「读回清单」（机械回读面）；
  //    用户可见面（回复）必须含全部 5 个标记词。真模型没有夹具产物 → 只查回复面。
  const manifestFile = delivered.find((file) => file.filename === '读回清单.txt');
  const manifestText = manifestFile?.data.toString('utf8') ?? '';
  const missingInArtifact = S1_MARKERS.filter((marker) => !manifestText.includes(marker));
  const missingInReply = S1_MARKERS.filter((marker) => !textOf(reply).includes(marker));
  checks.check(
    's1-all-five-readable-in-reply',
    handlerError === undefined && missingInReply.length === 0,
    handlerError !== undefined
      ? `回合失败：${handlerError}`
      : `回复缺 ${missingInReply.length} 个标记（${missingInReply.join('、') || '无'}）；回复=${JSON.stringify(textOf(reply).slice(0, 300))}`,
  );
  if (mode === 'scripted') {
    checks.check(
      's1-artifact-manifest-readable',
      delivered.length >= 1 && manifestFile !== undefined && missingInArtifact.length === 0,
      `交付=${delivered.length} 个（读回清单=${manifestFile === undefined ? '无' : `${manifestFile.bytes}B，缺 ${missingInArtifact.length} 个标记`}）`,
    );
  }

  const fileRefs = readFileRefs(harness.dbPath);
  checks.check('s1-file-refs-registered', fileRefs.length >= 5, `file_refs 行数=${fileRefs.length}`);
  if (handlerError !== undefined) notes.push(`handler 抛错：${handlerError}`);
  notes.push(`交付面：${delivered.map((file) => `${file.filename}:${file.bytes}B`).join('、') || '（无）'}`);

  return outcomeOf({
    scenario,
    status: checks.allPassed ? 'pass' : 'fail',
    mode,
    checks: checks.list,
    notes,
    undefinedObservations: [],
    calls: callsOf(mode, harness.sink.runs),
    ...(handlerError !== undefined ? { error: handlerError } : {}),
    evidence: {
      reply,
      logs: harness.logs,
      toolCalls: harness.sink.calls,
      driverRuns: harness.sink.runs,
      deliveredFiles: delivered.map((file) => ({ filename: file.filename, bytes: file.bytes, sha256: file.sha256 })),
      fileRefs,
    },
  });
}

// ── s2 三产物（②）：全登记、全交付、顺序稳定 ────────────────────────────────

const S2_INSTRUCTION =
  '请用 run_js 生成 3 个文件并把它们都发给我：a-总览.csv、b-明细.csv、c-说明.txt，每个文件里写一行不同的文字。';

async function runS2(mode: 'real' | 'scripted'): Promise<ScenarioOutcome> {
  const scenario = 's2';
  const checks = new Checks();
  const notes: string[] = [];
  const { harness, reply, handlerError } = await runWithHarness({
    mode,
    scenario,
    instruction: S2_INSTRUCTION,
    scriptedMain: () => makeScriptedMain('s2'),
  });
  const delivered = deliveredFiles(harness.port);
  const calls = runJsCalls(harness.sink);
  const outputs = calls.flatMap((call) => asRunJsResult(call.result).outputs ?? []);

  // ① 前提：run_js 产出 3 个产物（scripted = 一次调用产出 3；真模型按指令产出）。
  checks.check(
    's2-three-outputs-produced',
    handlerError === undefined && calls.length >= 1 && outputs.length === 3,
    handlerError !== undefined ? `回合失败：${handlerError}` : `run_js 调用=${calls.length}；outputs=${outputs.length}（${JSON.stringify(outputs.map((file) => file.name))}）`,
  );

  // ② 全登记：file_refs 三行、交付 sha 与登记行一一对应。
  const fileRefs = readFileRefs(harness.dbPath);
  const deliveredShas = new Set(delivered.map((file) => file.sha256));
  const registeredDelivered = fileRefs.filter((row) => deliveredShas.has(row.sha256));
  checks.check(
    's2-all-registered',
    outputs.length === 3 && registeredDelivered.length === 3,
    `file_refs=${JSON.stringify(fileRefs.map((row) => ({ name: row.name, bytes: row.bytes })))}；交付 sha 命中=${registeredDelivered.length}/3；outputs=${outputs.length}`,
  );

  // ③ 全交付：端口恰好收到 3 个文件，message_done 记 sent。
  const doneLog = harness.logs.find((line) => line['event'] === 'message_done') as Record<string, unknown> | undefined;
  const deliveryFact = (doneLog?.['fileDelivery'] ?? undefined) as { status?: unknown; files?: unknown } | undefined;
  checks.check(
    's2-all-delivered',
    delivered.length === 3 && deliveryFact?.['status'] === 'sent',
    `端口收到=${delivered.length} 个（${delivered.map((file) => file.filename).join('、')}）；message_done.fileDelivery=${JSON.stringify(deliveryFact)}`,
  );

  // ④ 顺序稳定：交付序 == 文件名字典序（host 走查按 relPath 全排序；scripted 夹具按 c→a→b
  //    乱序写盘，交付序与写盘序不同才证明排序来自宿主而非巧合）。
  const names = delivered.map((file) => file.filename);
  const sortedNames = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const orderStable = names.length === 3 && names.every((name, index) => name === sortedNames[index]);
  checks.check(
    's2-delivery-order-stable',
    orderStable,
    `交付序=${JSON.stringify(names)}；字典序=${JSON.stringify(sortedNames)}；一致=${orderStable}`,
  );

  if (handlerError !== undefined) notes.push(`handler 抛错：${handlerError}`);
  notes.push(`回复=${JSON.stringify(textOf(reply).slice(0, 200))}`);

  return outcomeOf({
    scenario,
    status: checks.allPassed ? 'pass' : 'fail',
    mode,
    checks: checks.list,
    notes,
    undefinedObservations: [],
    calls: callsOf(mode, harness.sink.runs),
    ...(handlerError !== undefined ? { error: handlerError } : {}),
    evidence: {
      reply,
      logs: harness.logs,
      toolCalls: harness.sink.calls,
      driverRuns: harness.sink.runs,
      deliveredFiles: delivered.map((file) => ({ filename: file.filename, bytes: file.bytes, sha256: file.sha256 })),
      fileRefs,
    },
  });
}

// ── s3 空 out/（③）：不交付、话术不许说「已发送」 ────────────────────────────

const S3_INSTRUCTION =
  '请用 run_js 原样运行下面这段代码（不要修改、不要往 out/ 写任何东西）：\n'
  + `${S3_CODE}\n`
  + '跑完后把用户能看到的结果如实告诉我。';

async function runS3(mode: 'real' | 'scripted'): Promise<ScenarioOutcome> {
  const scenario = 's3';
  const checks = new Checks();
  const notes: string[] = [];
  const { harness, reply, handlerError } = await runWithHarness({
    mode,
    scenario,
    instruction: S3_INSTRUCTION,
    scriptedMain: () => makeScriptedMain('s3'),
  });
  const delivered = deliveredFiles(harness.port);
  const calls = runJsCalls(harness.sink);

  // 前提：run_js 确实跑过且 outputs 为空（没跑 = 空交付路径未触发）。
  const outputs = calls.flatMap((call) => asRunJsResult(call.result).outputs ?? []);
  checks.check(
    's3-premise-run-js-empty-out',
    handlerError === undefined && calls.length >= 1 && outputs.length === 0,
    handlerError !== undefined ? `回合失败：${handlerError}` : `run_js 调用=${calls.length}；outputs=${outputs.length}（前提：脚本确实跑了且 out/ 为空）`,
  );

  // ① 不交付：端口零调用、无 file_delivery 事件、message_done 无 fileDelivery 字段。
  const deliveryEvents = harness.logs.filter((line) => line['event'] === 'file_delivery');
  const doneLog = harness.logs.find((line) => line['event'] === 'message_done') as Record<string, unknown> | undefined;
  checks.check(
    's3-no-delivery',
    handlerError === undefined && harness.port.calls.length === 0 && deliveryEvents.length === 0 && doneLog?.['fileDelivery'] === undefined,
    `端口调用=${harness.port.calls.length}；file_delivery 事件=${deliveryEvents.length}；message_done.fileDelivery=${JSON.stringify(doneLog?.['fileDelivery'] ?? null)}`,
  );

  // ② 话术：不许出现发送/附件类断言（不许说「已发送」）；回复非空。
  const replyText = textOf(reply);
  const sendClaim = SEND_CLAIM_PATTERN.exec(replyText);
  checks.check(
    's3-reply-no-send-claim',
    handlerError === undefined && replyText.trim() !== '' && sendClaim === null,
    sendClaim === null
      ? `回复无发送类断言；回复=${JSON.stringify(replyText.slice(0, 300))}`
      : `回复出现发送类断言「${sendClaim[0]}」；回复=${JSON.stringify(replyText.slice(0, 300))}`,
  );

  if (handlerError !== undefined) notes.push(`handler 抛错：${handlerError}`);
  notes.push(`回复全文=${JSON.stringify(replyText)}`);
  return outcomeOf({
    scenario,
    status: checks.allPassed ? 'pass' : 'fail',
    mode,
    checks: checks.list,
    notes,
    undefinedObservations: [],
    calls: callsOf(mode, harness.sink.runs),
    ...(handlerError !== undefined ? { error: handlerError } : {}),
    evidence: {
      reply,
      logs: harness.logs,
      toolCalls: harness.sink.calls,
      driverRuns: harness.sink.runs,
      deliveredFiles: delivered.map((file) => ({ filename: file.filename, bytes: file.bytes, sha256: file.sha256 })),
    },
  });
}

// ── s4 非零退出（④）：用户看到失败、不许说成功 ──────────────────────────────

const S4_INSTRUCTION =
  '请用 run_js 原样运行下面这段代码（不要修改）：\n'
  + `${S4_CODE}\n`
  + '跑完后把用户能看到的结果如实告诉我。';

async function runS4(mode: 'real' | 'scripted'): Promise<ScenarioOutcome> {
  const scenario = 's4';
  const checks = new Checks();
  const notes: string[] = [];
  const { harness, reply, handlerError } = await runWithHarness({
    mode,
    scenario,
    instruction: S4_INSTRUCTION,
    scriptedMain: () => makeScriptedMain('s4'),
  });
  const calls = runJsCalls(harness.sink);

  // 前提：run_js 结果 exitCode = 2（非零）。
  const exitCode = calls.length >= 1 ? asRunJsResult(calls[0]!.result).exitCode : undefined;
  checks.check(
    's4-premise-exitcode-nonzero',
    handlerError === undefined && calls.length >= 1 && exitCode === 2,
    handlerError !== undefined ? `回合失败：${handlerError}` : `run_js 调用=${calls.length}；exitCode=${String(exitCode)}`,
  );

  // ① 用户看到失败话术。
  const replyText = textOf(reply);
  const failWording = FAIL_WORDING_PATTERN.exec(replyText);
  checks.check(
    's4-user-sees-failure',
    failWording !== null,
    failWording === null
      ? `回复没有任何失败话术；回复=${JSON.stringify(replyText.slice(0, 300))}`
      : `回复含失败话术「${failWording[0]}」`,
  );

  // ② 不许说成功。
  const successClaim = SUCCESS_CLAIM_PATTERN.exec(replyText);
  checks.check(
    's4-no-success-claim',
    successClaim === null,
    successClaim === null
      ? '回复无成功类断言'
      : `回复出现成功类断言「${successClaim[0]}」；回复=${JSON.stringify(replyText.slice(0, 300))}`,
  );

  // ③ 失败回合不该交付产物（脚本没写 out/；若交付了说明 out/ 收取面出了问题）。
  const delivered = deliveredFiles(harness.port);
  checks.check(
    's4-no-artifact-delivered',
    delivered.length === 0,
    `交付=${delivered.length} 个（${delivered.map((file) => file.filename).join('、') || '无'}）`,
  );

  if (handlerError !== undefined) notes.push(`handler 抛错：${handlerError}`);
  notes.push(`回复全文=${JSON.stringify(replyText)}`);
  return outcomeOf({
    scenario,
    status: checks.allPassed ? 'pass' : 'fail',
    mode,
    checks: checks.list,
    notes,
    undefinedObservations: [],
    calls: callsOf(mode, harness.sink.runs),
    ...(handlerError !== undefined ? { error: handlerError } : {}),
    evidence: {
      reply,
      logs: harness.logs,
      toolCalls: harness.sink.calls,
      driverRuns: harness.sink.runs,
      deliveredFiles: delivered.map((file) => ({ filename: file.filename, bytes: file.bytes, sha256: file.sha256 })),
    },
  });
}

// ── s5 超时（⑤）：用户看到超时；产物仍按 v8 §10-3 收取 ──────────────────────

const S5_INSTRUCTION =
  '帮我验证宿主对脚本超时的处理。请用 run_js 原样运行下面这段代码（不要修改，它不会自己结束，宿主会按自己的超时机制处理）：\n'
  + `${S5_TIMEOUT_CODE}\n`
  + '跑完后把用户能看到的结果如实告诉我（包括宿主有没有把超时前写出的产物收走）。';

async function runS5(mode: 'real' | 'scripted'): Promise<ScenarioOutcome> {
  const scenario = 's5';
  const checks = new Checks();
  const notes: string[] = [];
  const { harness, reply, handlerError } = await runWithHarness({
    mode,
    scenario,
    instruction: S5_INSTRUCTION,
    scriptedMain: () => makeScriptedMain('s5'),
  });
  const elapsedMs = Date.now() - harness.startedAt;
  const delivered = deliveredFiles(harness.port);
  const calls = runJsCalls(harness.sink);

  // 前提：宿主 120s 常量杀进程组——exitCode null + SIGKILL + 耗时 ≥ 115s（setTimeout 只会晚不会早）。
  const result = calls.length >= 1 ? asRunJsResult(calls[0]!.result) : undefined;
  checks.check(
    's5-premise-host-timeout-kill',
    handlerError === undefined && calls.length >= 1 && result?.exitCode === null && result?.exitSignal === 'SIGKILL' && elapsedMs >= S5_MIN_ELAPSED_MS,
    handlerError !== undefined
      ? `回合失败：${handlerError}`
      : `run_js 调用=${calls.length}；exitCode=${String(result?.exitCode)}；exitSignal=${String(result?.exitSignal)}；回合耗时=${elapsedMs}ms（阈值 ${S5_MIN_ELAPSED_MS}）`,
  );

  // ① 用户看到「超时」话术。
  const replyText = textOf(reply);
  checks.check(
    's5-user-sees-timeout',
    replyText.includes('超时'),
    replyText.includes('超时')
      ? '回复含「超时」'
      : `回复不含「超时」；回复=${JSON.stringify(replyText.slice(0, 300))}`,
  );

  // ② 产物仍收取（v8 §10-3）：超时前写出的产物登记进 file_refs 且照常交付、字节一致。
  const fileRefs = readFileRefs(harness.dbPath);
  const artifactRow = fileRefs.find((row) => row.name === S5_ARTIFACT_NAME);
  const deliveredArtifact = delivered.find((file) => file.filename === S5_ARTIFACT_NAME);
  const bytesMatch = deliveredArtifact !== undefined && deliveredArtifact.data.toString('utf8') === S5_ARTIFACT_TEXT;
  checks.check(
    's5-artifact-collected-despite-timeout',
    artifactRow !== undefined && deliveredArtifact !== undefined && bytesMatch,
    `file_refs 含「${S5_ARTIFACT_NAME}」=${artifactRow !== undefined}（file_refs=${JSON.stringify(fileRefs.map((row) => ({ name: row.name, bytes: row.bytes })))}）；交付含=${deliveredArtifact !== undefined}；内容一致=${bytesMatch}；交付=${delivered.map((file) => `${file.filename}:${file.bytes}B`).join('、') || '（无）'}`,
  );

  // ③ 交付事实记 sent（收取成功是机械事实；超时不改变交付面语义）。
  const doneLog = harness.logs.find((line) => line['event'] === 'message_done') as Record<string, unknown> | undefined;
  const deliveryFact = (doneLog?.['fileDelivery'] ?? undefined) as { status?: unknown } | undefined;
  checks.check(
    's5-delivery-recorded-sent',
    deliveryFact?.['status'] === 'sent',
    `message_done.fileDelivery=${JSON.stringify(deliveryFact)}`,
  );

  if (handlerError !== undefined) notes.push(`handler 抛错：${handlerError}`);
  notes.push(`回复全文=${JSON.stringify(replyText)}`);
  notes.push(`宿主超时常量=120s（run-js-executor.ts:44 RUN_JS_TIMEOUT_MS）；回合耗时=${elapsedMs}ms`);
  return outcomeOf({
    scenario,
    status: checks.allPassed ? 'pass' : 'fail',
    mode,
    checks: checks.list,
    notes,
    undefinedObservations: [],
    calls: callsOf(mode, harness.sink.runs),
    ...(handlerError !== undefined ? { error: handlerError } : {}),
    evidence: {
      reply,
      logs: harness.logs,
      toolCalls: harness.sink.calls,
      driverRuns: harness.sink.runs,
      deliveredFiles: delivered.map((file) => ({ filename: file.filename, bytes: file.bytes, sha256: file.sha256 })),
      fileRefs,
      elapsedMs,
    },
  });
}

// ── s6 语法错误（⑥）：报错可读、不泄漏宿主绝对路径 ──────────────────────────

const S6_INSTRUCTION =
  '请用 run_js 原样运行下面这段代码（不要修改，这段代码有语法错误）：\n'
  + `${S6_CODE}\n`
  + '跑完后把报错情况如实告诉我（报错原文可以转贴）。';

async function runS6(mode: 'real' | 'scripted'): Promise<ScenarioOutcome> {
  const scenario = 's6';
  const checks = new Checks();
  const notes: string[] = [];
  const { harness, reply, handlerError } = await runWithHarness({
    mode,
    scenario,
    instruction: S6_INSTRUCTION,
    scriptedMain: () => makeScriptedMain('s6'),
  });
  const calls = runJsCalls(harness.sink);

  // 前提：exitCode ≠ 0，stderr 含 SyntaxError，且 stderr 本身含 run.cjs 绝对路径（= 泄漏向量真实存在）。
  const result = calls.length >= 1 ? asRunJsResult(calls[0]!.result) : undefined;
  const stderr = result?.stderr ?? '';
  const runCjsPathInStderr = /([^\s'`]+\.cjs):\d+/.exec(stderr)?.[1];
  checks.check(
    's6-premise-syntax-error-with-path-in-stderr',
    handlerError === undefined && calls.length >= 1 && (result?.exitCode ?? 0) !== 0 && stderr.includes('SyntaxError') && runCjsPathInStderr !== undefined,
    handlerError !== undefined
      ? `回合失败：${handlerError}`
      : `exitCode=${String(result?.exitCode)}；stderr 含 SyntaxError=${stderr.includes('SyntaxError')}；stderr 含 .cjs 绝对路径=${runCjsPathInStderr ?? '无'}（stderr 前 200 字：${JSON.stringify(stderr.slice(0, 200))}）`,
  );

  // ① 报错可读：用户能从回复看出出错了。
  const replyText = textOf(reply);
  const errorWording = /语法|错误|报错|异常|失败|Error/i.exec(replyText);
  checks.check(
    's6-error-readable',
    replyText.trim() !== '' && errorWording !== null,
    errorWording === null
      ? `回复没有任何报错话术；回复=${JSON.stringify(replyText.slice(0, 300))}`
      : `回复含报错话术「${errorWording[0]}」`,
  );

  // ② 不泄漏宿主绝对路径：回复无宿主路径形状（生产同源探针 hasServerPath），
  //    且无 stderr 里那条 run.cjs 绝对路径、无 tmpdir 根子串。
  const tmpRoot = os.tmpdir();
  const leakedProbe = hasServerPath(replyText);
  const leakedRunDir = runCjsPathInStderr !== undefined && replyText.includes(runCjsPathInStderr);
  const leakedTmpRoot = replyText.includes(tmpRoot);
  checks.check(
    's6-no-host-path-in-reply',
    !leakedProbe && !leakedRunDir && !leakedTmpRoot,
    `hasServerPath=${leakedProbe}；含 run.cjs 绝对路径=${leakedRunDir}；含 tmpdir 根（${tmpRoot}）=${leakedTmpRoot}；回复=${JSON.stringify(replyText.slice(0, 400))}`,
  );

  if (handlerError !== undefined) notes.push(`handler 抛错：${handlerError}`);
  notes.push(`回复全文=${JSON.stringify(replyText)}`);
  return outcomeOf({
    scenario,
    status: checks.allPassed ? 'pass' : 'fail',
    mode,
    checks: checks.list,
    notes,
    undefinedObservations: [],
    calls: callsOf(mode, harness.sink.runs),
    ...(handlerError !== undefined ? { error: handlerError } : {}),
    evidence: {
      reply,
      logs: harness.logs,
      toolCalls: harness.sink.calls,
      driverRuns: harness.sink.runs,
      deliveredFiles: deliveredFiles(harness.port).map((file) => ({ filename: file.filename, bytes: file.bytes, sha256: file.sha256 })),
      stderrHead: stderr.slice(0, 500),
    },
  });
}

// ── s7 40MB 产物（⑦）[UNDEFINED 记录] ────────────────────────────────────────

async function runS7(mode: 'real' | 'scripted'): Promise<ScenarioOutcome> {
  const scenario = 's7';
  const checks = new Checks();
  const notes: string[] = [];
  const undefinedObservations: string[] = [];
  const { harness, handlerError } = await runWithHarness({
    mode,
    scenario,
    instruction: '（s7 为记录面场景：宿主对超渠道上限产物的行为记录。请用 run_js 原样运行：\n'
      + `${S7_CODE}\n跑完后如实告诉我结果。）`,
    scriptedMain: () => makeScriptedMain('s7'),
  });
  const delivered = deliveredFiles(harness.port);
  const fileRefs = readFileRefs(harness.dbPath);
  const deliveredFile = delivered.find((file) => file.filename === S7_NAME);
  const row = fileRefs.find((entry) => entry.name === S7_NAME);

  // 机械管线事实：40MB < 宿主单产物上限 50MiB → 登记且字节精确；端口收到全量字节。
  checks.check(
    's7-fixture-registered-with-exact-bytes',
    handlerError === undefined && row !== undefined && row.bytes === S7_BYTES,
    handlerError !== undefined ? `回合失败：${handlerError}` : `file_refs=${JSON.stringify(fileRefs.map((entry) => ({ name: entry.name, bytes: entry.bytes })))}；期望 ${S7_BYTES}B`,
  );
  checks.check(
    's7-delivered-full-bytes',
    deliveredFile !== undefined && deliveredFile.bytes === S7_BYTES && deliveredFile.sha256 === row?.sha256,
    `交付=${delivered.map((file) => `${file.filename}:${file.bytes}B`).join('、') || '（无）'}；期望 ${S7_BYTES}B`,
  );

  notes.push(`观察：宿主登记并交付了 ${S7_BYTES}B（40MB）产物——40MB > 渠道 32MB（${S7_CHANNEL_LIMIT_BYTES}B），宿主面（server.deliverTurnFiles → 端口）没有任何尺寸门。`);
  notes.push('宿主单产物上限 = RUN_JS_MAX_OUTPUT_FILE_BYTES 50MiB（run-js-executor.ts:48）；渠道 32MB 上限是真实渠道适配面的事实，本验收不接真实企微、不测渠道适配。');
  undefinedObservations.push('s7: 超渠道 32MB 上限的产物，宿主当前行为 = 照常登记 + 照常交端口（无尺寸门）；设计稿（v8）未定义超渠道上限产物行为 → UNDEFINED。');
  if (handlerError !== undefined) notes.push(`handler 抛错：${handlerError}`);

  return outcomeOf({
    scenario,
    status: checks.allPassed ? 'pass' : 'fail',
    mode,
    checks: checks.list,
    notes,
    undefinedObservations,
    calls: callsOf(mode, harness.sink.runs),
    ...(handlerError !== undefined ? { error: handlerError } : {}),
    evidence: {
      logs: harness.logs,
      toolCalls: harness.sink.calls,
      deliveredFiles: delivered.map((file) => ({ filename: file.filename, bytes: file.bytes, sha256: file.sha256 })),
      fileRefs,
    },
  });
}

// ── s8 out/ 子目录（⑧）[UNDEFINED 记录] ─────────────────────────────────────

async function runS8(mode: 'real' | 'scripted'): Promise<ScenarioOutcome> {
  const scenario = 's8';
  const checks = new Checks();
  const notes: string[] = [];
  const undefinedObservations: string[] = [];
  const { harness, handlerError } = await runWithHarness({
    mode,
    scenario,
    instruction: '（s8 为记录面场景：out/ 子目录的收取口径记录。请用 run_js 原样运行：\n'
      + `${S8_CODE}\n跑完后如实告诉我结果。）`,
    scriptedMain: () => makeScriptedMain('s8'),
  });
  const delivered = deliveredFiles(harness.port);
  const fileRefs = readFileRefs(harness.dbPath);
  const topLevel = fileRefs.find((entry) => entry.name === S8_TOP_NAME);
  const nested = fileRefs.find((entry) => entry.name === S8_NESTED_NAME);

  // 记录面：登记事实本身（顶层是否收到、子目录是否收到）。
  checks.check(
    's8-fixture-both-registered',
    handlerError === undefined && topLevel !== undefined && nested !== undefined,
    handlerError !== undefined ? `回合失败：${handlerError}` : `file_refs=${JSON.stringify(fileRefs.map((entry) => entry.name))}`,
  );
  const deliveredNames = delivered.map((file) => file.filename);
  const expectedDelivered = fileRefs.filter((entry) => entry.name === S8_TOP_NAME || entry.name === S8_NESTED_NAME).length;
  checks.check(
    's8-delivery-fact-recorded',
    deliveredNames.length === expectedDelivered && expectedDelivered > 0,
    `交付=${JSON.stringify(deliveredNames)}；登记的夹具产物=${expectedDelivered} 份`,
  );

  notes.push(`观察：${topLevel !== undefined ? '顶层文件已登记' : '顶层文件未登记'}；${nested !== undefined ? `子目录内文件已登记（name=「${S8_NESTED_NAME}」，relPath 连同子目录名进入交付文件名）` : '子目录内文件未登记'}——当前实现是**递归走查**（file-store.ts collectCandidates walk）。`);
  notes.push(`交付名=${JSON.stringify(deliveredNames)}`);
  undefinedObservations.push('s8: out/ 子目录——设计稿 v8 §2 只写「<run>/out/ 就是交付箱：里面每个文件都登记并本轮交付」，未写明只扫顶层还是递归；当前行为 = 递归（子目录内文件照常登记交付，子目录名进文件名）→ UNDEFINED。');
  if (handlerError !== undefined) notes.push(`handler 抛错：${handlerError}`);

  return outcomeOf({
    scenario,
    status: checks.allPassed ? 'pass' : 'fail',
    mode,
    checks: checks.list,
    notes,
    undefinedObservations,
    calls: callsOf(mode, harness.sink.runs),
    ...(handlerError !== undefined ? { error: handlerError } : {}),
    evidence: {
      logs: harness.logs,
      toolCalls: harness.sink.calls,
      deliveredFiles: delivered.map((file) => ({ filename: file.filename, bytes: file.bytes, sha256: file.sha256 })),
      fileRefs,
    },
  });
}

// ── s9 两产物同名（⑨）[UNDEFINED 记录] ──────────────────────────────────────

async function runS9(mode: 'real' | 'scripted'): Promise<ScenarioOutcome> {
  const scenario = 's9';
  const checks = new Checks();
  const notes: string[] = [];
  const undefinedObservations: string[] = [];
  const { harness, handlerError } = await runWithHarness({
    mode,
    scenario,
    instruction: '（s9 为记录面场景：产物同名的处理行为记录。请用 run_js 原样运行下面两段代码各一次（两次分开调用）：\n'
      + `第一段：${S9_CODE_A}\n第二段：${S9_CODE_B}\n跑完后如实告诉我结果。）`,
    scriptedMain: () => makeScriptedMain('s9'),
  });
  const delivered = deliveredFiles(harness.port);
  const fileRefs = readFileRefs(harness.dbPath);
  const sameNameRows = fileRefs.filter((entry) => entry.name === S9_NAME);
  const sameNameDelivered = delivered.filter((file) => file.filename === S9_NAME);

  // 记录面前提：两段代码各跑了一次。
  const jsCalls = runJsCalls(harness.sink);
  checks.check(
    's9-fixture-two-calls-ran',
    handlerError === undefined && jsCalls.length === 2,
    handlerError !== undefined ? `回合失败：${handlerError}` : `run_js 调用=${jsCalls.length}`,
  );
  // 记录面事实：同名产物各自登记（不同 fileId、不同 sha）且双双交付。
  checks.check(
    's9-observation-facts-recorded',
    sameNameRows.length === 2
      && new Set(sameNameRows.map((row) => row.fileId)).size === 2
      && new Set(sameNameRows.map((row) => row.sha256)).size === 2
      && sameNameDelivered.length === 2,
    `同名行=${sameNameRows.length}（fileId=${JSON.stringify(sameNameRows.map((row) => row.fileId))}，sha 互异=${new Set(sameNameRows.map((row) => row.sha256)).size === 2}）；同名交付=${sameNameDelivered.length}；全部 file_refs=${JSON.stringify(fileRefs.map((entry) => entry.name))}`,
  );

  notes.push('观察：同名产物「覆盖 / 拒收 / 加后缀」都没有发生——两次运行各自拿新 fileId、同名双行登记、同名双份进交付端口（主面登记不按 name 去重；fileStoragePathOf 按 fileId 落盘不互相覆盖；交付面按 fileId 逐份送出）。');
  undefinedObservations.push('s9: 两个产物同名——设计稿（v8）未定义同名行为；当前行为 = 各自登记新 fileId + 同名双双交付（无覆盖/拒收/加后缀）→ UNDEFINED。真实渠道上同名两份附件的表现不在本验收范围（不接真实企微）。');
  if (handlerError !== undefined) notes.push(`handler 抛错：${handlerError}`);

  return outcomeOf({
    scenario,
    status: checks.allPassed ? 'pass' : 'fail',
    mode,
    checks: checks.list,
    notes,
    undefinedObservations,
    calls: callsOf(mode, harness.sink.runs),
    ...(handlerError !== undefined ? { error: handlerError } : {}),
    evidence: {
      logs: harness.logs,
      toolCalls: harness.sink.calls,
      deliveredFiles: delivered.map((file) => ({ filename: file.filename, bytes: file.bytes, sha256: file.sha256 })),
      fileRefs,
    },
  });
}

// ── 入口 ────────────────────────────────────────────────────────────────────

type ScenarioId = 's1' | 's2' | 's3' | 's4' | 's5' | 's6' | 's7' | 's8' | 's9';
const ALL_SCENARIOS: readonly ScenarioId[] = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'];
/** 话术面场景：缺省真模型（预算口径见文件头）。 */
const WORDING_SCENARIOS: readonly ScenarioId[] = ['s3', 's4', 's5', 's6'];

interface CliOptions {
  scenarios: readonly ScenarioId[];
  forcedScripted: ReadonlySet<ScenarioId>;
  forcedReal: ReadonlySet<ScenarioId>;
  allScripted: boolean;
  outDir: string;
}

function parseScenarioList(value: string): ScenarioId[] {
  const picked = value.split(',').map((item) => item.trim()).filter((item) => item !== '');
  const valid = picked.filter((item): item is ScenarioId => (ALL_SCENARIOS as readonly string[]).includes(item));
  if (valid.length !== picked.length || valid.length === 0) throw new Error(`场景只认 ${ALL_SCENARIOS.join('/')}：${value}`);
  return valid;
}

function parseCli(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    scenarios: ALL_SCENARIOS,
    forcedScripted: new Set(),
    forcedReal: new Set(),
    allScripted: false,
    outDir: path.join(REPO_ROOT, '.runtime', 'eval-cap01-r2c', new Date().toISOString().replace(/[:.]/g, '-')),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error(`${arg} 需要值`);
      return value;
    };
    if (arg === '--scripted') options.allScripted = true;
    else if (arg === '--real') options.forcedReal = new Set(parseScenarioList(next()));
    else if (arg === '--scripted-only') options.forcedScripted = new Set(parseScenarioList(next()));
    else if (arg === '--scenario') options.scenarios = parseScenarioList(next());
    else if (arg === '--out-dir') options.outDir = path.resolve(next());
    else throw new Error(`未知参数：${arg}（支持 --scripted / --real s1,s2 / --scripted-only s5 / --scenario / --out-dir）`);
  }
  return options;
}

function modeOf(id: ScenarioId, cli: CliOptions, hasKey: boolean): 'real' | 'scripted' {
  if (cli.allScripted || cli.forcedScripted.has(id)) return 'scripted';
  if (cli.forcedReal.has(id)) return hasKey ? 'real' : 'scripted';
  // 缺省：话术面 real（无 key 降级），机械/记录面 scripted。
  return WORDING_SCENARIOS.includes(id) && hasKey ? 'real' : 'scripted';
}

function runScenario(scenario: ScenarioId, mode: 'real' | 'scripted'): Promise<ScenarioOutcome> {
  if (scenario === 's1') return runS1(mode);
  if (scenario === 's2') return runS2(mode);
  if (scenario === 's3') return runS3(mode);
  if (scenario === 's4') return runS4(mode);
  if (scenario === 's5') return runS5(mode);
  if (scenario === 's6') return runS6(mode);
  if (scenario === 's7') return runS7(mode);
  if (scenario === 's8') return runS8(mode);
  return runS9(mode);
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const requestedModel = process.env['LLM_MODEL'] ?? '';
  const hasKey = (process.env['LLM_API_KEY'] ?? '').trim() !== '';
  if (!hasKey) console.log('[cap01-r2c] 未检测到 LLM_API_KEY——话术面场景按口径降级脚本化，报告写 mode=scripted。');
  mkdirSync(cli.outDir, { recursive: true });
  console.log(`[cap01-r2c] requestedModel=${requestedModel || '(env 未设置)'} scenarios=${cli.scenarios.join(',')} outDir=${cli.outDir}`);

  const outcomes: ScenarioOutcome[] = [];
  for (const scenario of cli.scenarios) {
    const mode = modeOf(scenario, cli, hasKey);
    console.log(`[cap01-r2c] ── 场景 ${scenario} 开始（mode=${mode}）──`);
    const started = Date.now();
    let outcome: ScenarioOutcome;
    try {
      outcome = await runScenario(scenario, mode);
    } catch (error) {
      outcome = {
        scenario,
        status: 'fail',
        mode,
        checks: [{ name: `${scenario}-harness`, pass: false, detail: `场景抛错：${error instanceof Error ? (error.stack ?? error.message) : String(error)}` }],
        notes: ['场景级异常（装配/渠道/驱动层），证据缺失即 FAIL'],
        undefinedObservations: [],
        calls: 0,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        evidence: {},
      };
    }
    outcome.evidence = { ...outcome.evidence, durationMs: Date.now() - started, mode };
    const evidencePath = path.join(cli.outDir, `${outcome.scenario}-evidence.json`);
    writeFileSync(evidencePath, JSON.stringify(outcome.evidence, null, 2) + '\n');
    for (const check of outcome.checks) {
      console.log(`[cap01-r2c] ${outcome.scenario} ${check.pass ? 'PASS' : 'FAIL'} ${check.name} — ${check.detail}`);
    }
    for (const note of outcome.notes) console.log(`[cap01-r2c] ${outcome.scenario} NOTE ${note}`);
    for (const observation of outcome.undefinedObservations) console.log(`[cap01-r2c] ${outcome.scenario} UNDEFINED ${observation}`);
    console.log(`[cap01-r2c] ── 场景 ${outcome.scenario} ${outcome.status.toUpperCase()}（mode=${mode}，calls=${outcome.calls}，${Date.now() - started}ms，证据=${evidencePath}）──`);
    outcomes.push(outcome);
  }

  const totalCalls = outcomes.reduce((sum, outcome) => sum + outcome.calls, 0);
  const observedModels = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.mode !== 'real') continue;
    const runs = (outcome.evidence as { driverRuns?: DriverRunRecord[] }).driverRuns;
    if (runs !== undefined) {
      const model = observedModelOf(runs);
      if (model !== undefined) observedModels.add(model);
    }
  }
  const allScripted = outcomes.every((outcome) => outcome.mode === 'scripted');
  const modelField = allScripted ? 'scripted' : observedModels.size === 1 ? [...observedModels][0]! : observedModels.size === 0 ? requestedModel : `mixed:${[...observedModels].join('|')}`;
  const allPass = outcomes.every((outcome) => outcome.status === 'pass');
  const summary = {
    model: modelField,
    requestedModel,
    perScenarioMode: Object.fromEntries(outcomes.map((outcome) => [outcome.scenario, outcome.mode])),
    observedModels: [...observedModels],
    /** calls 口径 = 真实模型 assistant 消息数（scripted 场景计 0）；与 r2-functional 的 calls 同源。 */
    totalRealCalls: totalCalls,
    callBudgetMax: 24,
    budgetRespected: totalCalls <= 24,
    undefinedObservations: outcomes.flatMap((outcome) => outcome.undefinedObservations),
    scenarios: Object.fromEntries(outcomes.map((outcome) => [
      outcome.scenario,
      {
        status: outcome.status,
        mode: outcome.mode,
        calls: outcome.calls,
        checks: outcome.checks,
        notes: outcome.notes,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      },
    ])),
  };
  const summaryPath = path.join(cli.outDir, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  for (const outcome of outcomes) {
    console.log(`[cap01-r2c] ${outcome.scenario}=${outcome.status.toUpperCase()} mode=${outcome.mode} calls=${outcome.calls}`);
  }
  console.log(`[cap01-r2c] model=${modelField}（请求面=${requestedModel || '(env 未设置)'}）`);
  console.log(`[cap01-r2c] real_calls=${totalCalls}/24 汇总=${summaryPath}`);
  if (!allPass) process.exitCode = 1;
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error('[cap01-r2c] 入口失败：', error);
    process.exitCode = 1;
  });
}
