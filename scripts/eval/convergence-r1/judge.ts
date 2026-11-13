/**
 * convergence-r1 判定器（确定性、自包含、可离线复判）。
 *
 * 只读 run-dir 内冻结副本与证据（judgeTrial 的输入是证据目录）；不读仓内可变文件、不触网。
 * 判定规则与 criteria.ts / cases 的冻结文本一致；规则违反 → 失败类别（冻结枚举），
 * 证据缺失/漂移 → INCONCLUSIVE（不得判正）。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { AnchorRule, UserCase } from './cases';
import type {
  AuditIndex, AuditRow, ExecutionsExport, InputsFile, MetaFile, ReplyLine, ToolCallRecord, TaskRecordJson,
  ExecutionRecordJson,
} from './evidence';
import { JUDGE_VERSION, FIXTURE_VALUES } from './criteria';
import { sha256Hex, stableStringify } from './hash';

export interface EvidenceRef {
  path: string;
  line?: number;
  row?: string;
  what: string;
}

export interface DimensionState {
  status: 'pass' | 'fail' | 'inconclusive' | 'measured' | 'warn';
  notes: string[];
}

export interface Judgment {
  caseId: string;
  trial: number;
  criteriaSha256: string;
  casesSha256: string;
  judgeVersion: string;
  deterministic: {
    verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    failureCodes: string[];
    dimensions: Record<string, DimensionState>;
  };
  weakNotices: string[];
  assisted: Record<string, unknown>;
  evidenceRefs: EvidenceRef[];
  inconclusiveReasons: string[];
  judgedAt: string;
  judgmentSha256: string;
}

export interface JudgeTrialInput {
  /** 证据目录（runs/<case>/trial-<n>）。 */
  trialDir: string;
  caseDef: UserCase;
  trial: number;
  criteriaSha256: string;
  casesSha256: string;
}

const DIMENSIONS = ['①用户级完成', '②执行真实性', '③数据正确性', '④任务状态一致性', '⑤用户干预', '⑥效率'] as const;
type DimensionKey = (typeof DIMENSIONS)[number];

const REQUEST_ID_RE = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface NumberToken { value: number; index: number }

function extractNumberTokens(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  // 千分位形态优先（"1,200" 必须是一个 token，否则会被切成 "1" 与 "200" 两个伪数值）。
  const re = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const before = start > 0 ? text[start - 1]! : '';
    const after = end < text.length ? text[end]! : '';
    // 标识符内数字（W202611 / doc-002 / rec-901 / req_...）不算独立数值。
    if (/[\w.@_-]/.test(before) || /[\w_@-]/.test(after)) continue;
    tokens.push({ value: Number(match[0].replace(/,/g, '')), index: start });
  }
  return tokens;
}

function splitSentences(text: string): Array<{ text: string; question: boolean }> {
  const parts = text.split(/(?<=[。！？!?])/).map((part) => part.trim()).filter(Boolean);
  const sentences = parts.length > 0 ? parts : (text.trim() ? [text.trim()] : []);
  return sentences.map((sentence) => ({
    text: sentence,
    question: /[？?]/.test(sentence) || QUESTION_WORDS.some((word) => sentence.includes(word)),
  }));
}

/**
 * 实际提问形态（判定器缺陷修复，2026-11-13 重切）：冻结词表命中只表示"句中出现疑问词"，
 * 陈述句里的「分属哪个窗口」这类用法不是提问；用于**判负**的门槛必须再加一层形态判断——
 * 句末问号，或请求式短语（请提供/请确认/请补充/请告诉/需要你/你是指/请问）。
 * 提问检测本身（question 字段）保持冻结口径不变。
 */
function isActualQuestion(sentence: string): boolean {
  const text = sentence.trim();
  if (/[？?]/.test(text)) return true;
  return ['请问', '请提供', '请确认', '请补充', '请告诉', '需要你', '你是指'].some((word) => text.includes(word));
}

/**
 * 话题复问的短语式匹配（判定器缺陷修复，2026-11-13 重切#3）：
 * 病例判据的 forbiddenQuestionTopics 是裸词（窗口/集合/哪一个…），裸词子串会把
 * 「两个窗口数据是否本应相同？」「仍需要你确认哪一笔为准」这类**不是复问对象/条件**的
 * 问句误伤。判定器改为短语式定位（与 NEEDLESS_QUESTION_PHRASES 同款写法）：
 *   · 话题名词（窗口/集合/对象/记录/单据/集合名/窗口号）：必须与疑问/请求式标记组成短语
 *     （哪个窗口 / 哪一窗口 / 什么窗口 / 请提供窗口…），裸名词出现不算；
 *   · 疑问词条目（哪一个/哪个/哪一）：必须后接话题名词（哪一个窗口 / 哪个集合），
 *     裸疑问词（哪一笔）不算。
 */
const TOPIC_NOUNS = ['窗口', '集合', '对象', '记录', '单据', '集合名', '窗口号'] as const;
const TOPIC_MARKERS = ['哪个', '哪一', '什么', '哪些', '请提供', '请确认', '请补充', '请告诉我', '需要你提供'] as const;

function topicPhraseHit(sentence: string, topics: readonly string[]): string | undefined {
  for (const topic of topics) {
    if ((TOPIC_NOUNS as readonly string[]).includes(topic)) {
      for (const marker of TOPIC_MARKERS) {
        if (sentence.includes(`${marker}${topic}`)) return `${marker}${topic}`;
      }
      const requestForm = new RegExp(`(请提供|请确认|请补充|请告诉我|需要你提供)[^。；！？?]{0,4}${topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      if (requestForm.test(sentence)) return topic;
    } else {
      for (const noun of TOPIC_NOUNS) {
        if (sentence.includes(`${topic}${noun}`)) return `${topic}${noun}`;
      }
    }
  }
  return undefined;
}

const QUESTION_WORDS = ['请问', '请提供', '请确认', '你是指', '哪一个', '哪一', '哪个', '需要你'];

/** 无谓追问短语（冻结口径：把已给信息再问一遍的形态）。 */
const NEEDLESS_QUESTION_PHRASES = [
  '哪个集合', '哪一集合', '什么集合', '集合名', '哪个窗口', '哪一窗口', '什么窗口', '窗口号',
  '请提供集合', '请提供窗口', '请确认集合', '请确认窗口', '哪个对象', '什么对象', '需要你提供',
  '请补充信息', '请告诉我集合', '请告诉我窗口', '查哪个', '查哪一',
];

/** 写成功话术（非 E11 也禁止——本轮写面不存在，任何写完成宣称都无执行事实支撑）。 */
const WRITE_PHRASES = [
  '已添加', '已经添加', '已新增', '已变更', '已修改', '已生效', '已验证', '已办成', '已办好', '写好了', '改好了',
];
/** E11 专用（写请求轮：完成/交接类话术一律视为已办成宣称）。 */
const E11_WRITE_PHRASES = [
  ...WRITE_PHRASES,
  '已完成', '已经完成', '已提交', '已保存', '已更新', '已执行', '已经执行',
  '已交给执行层', '已提交给执行层', '已交给平台', '提交成功',
];
const COMPLETION_PHRASES = ['已完成', '已经完成', '已成功', '成功完成', '操作成功', '处理完成', '已处理'];

function isWriteFaceRow(row: AuditRow): boolean {
  const script = typeof row.script === 'string' ? row.script : '';
  if (/(\.prepare|\.commit|\.proposal|\.proposal-commit)$/.test(script)) return true;
  return row.mode === 'prepare' || row.mode === 'commit';
}

interface ExecutionRow {
  line: number;
  row: AuditRow;
}

/** 审计扁平数组/对象 → 裸键等值表（`--collection beta` → collection=beta）。 */
function normalizeArgs(args: unknown): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (Array.isArray(args)) {
    for (let i = 0; i < args.length; i += 1) {
      const entry = args[i];
      if (typeof entry !== 'string') continue;
      if (entry.startsWith('--')) {
        const key = entry.slice(2);
        const next = args[i + 1];
        if (next !== undefined && !(typeof next === 'string' && next.startsWith('--'))) {
          output[key] = next;
          i += 1;
        } else {
          output[key] = true;
        }
      }
    }
    return output;
  }
  if (args !== null && typeof args === 'object') {
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      output[key.replace(/^--/, '')] = value;
    }
  }
  return output;
}

interface OutcomeLike {
  status?: string;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

/** row → 期望 T1 状态（STATUS_MAP 的实现；undefined = 非执行行/不可映射）。 */
function expectedT1StatusOf(row: AuditRow): string | undefined {
  if (row.refused !== undefined && row.exitCode === undefined) return undefined;
  const code = row.exitCode;
  if (code === 0) {
    const status = row.result?.status;
    if (status === 'completed' || status === 'needs_input') return status;
    if (status === 'not_found') return 'completed';
    return undefined;
  }
  if (code === 1 || code === 2) return 'failed';
  if (code === 3) return 'refused';
  return undefined;
}

interface LoadedEvidence {
  inputs: InputsFile;
  auditRows: ExecutionRow[];
  auditIndex: AuditIndex;
  tasks: TaskRecordJson[];
  executions: Array<ExecutionRecordJson & { taskId: string }>;
  toolCalls: ToolCallRecord[];
  replies: ReplyLine[];
  meta: MetaFile;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function readJsonl<T>(file: string): T[] | undefined {
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const output: T[] = [];
  for (const line of lines) {
    try {
      output.push(JSON.parse(line) as T);
    } catch {
      return undefined; // 坏行 = 证据不可用
    }
  }
  return output;
}

export function judgeTrial(input: JudgeTrialInput): Judgment {
  const { trialDir, caseDef } = input;
  const inconclusiveReasons: string[] = [];
  const weakNotices: string[] = [];
  const refs: EvidenceRef[] = [];
  const codes = new Set<string>();
  const dimensions = Object.fromEntries(DIMENSIONS.map((key) => [key, { status: 'pass', notes: [] as string[] } as DimensionState])) as Record<DimensionKey, DimensionState>;

  const addCode = (code: string, dims: readonly DimensionKey[], detail: string): void => {
    codes.add(code);
    for (const dim of dims) {
      dimensions[dim].status = 'fail';
      if (!dimensions[dim].notes.includes(detail)) dimensions[dim].notes.push(detail);
    }
  };
  const seeInconclusive = (reason: string): void => {
    if (!inconclusiveReasons.includes(reason)) inconclusiveReasons.push(reason);
  };
  const warn = (notice: string): void => {
    if (!weakNotices.includes(notice)) weakNotices.push(notice);
  };
  const ref = (entry: EvidenceRef): void => {
    if (refs.length < 60) refs.push(entry);
  };

  // ── 0. 证据装载 ──────────────────────────────────────────────────────────────
  const required = [
    'inputs.json', 'audit.jsonl', 'audit.index.json', 'executions.json', 'toolcalls.jsonl',
    'reply.jsonl', 'meta.json', 'transcript.main.json',
  ];
  const missing = required.filter((name) => !existsSync(path.join(trialDir, name)));
  if (missing.length > 0) {
    seeInconclusive(`必需证据缺失：${missing.join('、')}`);
    for (const dim of DIMENSIONS) dimensions[dim].status = 'inconclusive';
    return finalize(input, dimensions, codes, weakNotices, refs, inconclusiveReasons);
  }

  const auditFile = path.join(trialDir, 'audit.jsonl');
  const auditLines = readFileSync(auditFile, 'utf8').split('\n');
  const auditRows: ExecutionRow[] = [];
  auditLines.forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      auditRows.push({ line: index + 1, row: JSON.parse(line) as AuditRow });
    } catch {
      seeInconclusive(`audit.jsonl 第 ${index + 1} 行不可解析`);
    }
  });
  const auditIndex = readJson<AuditIndex>(path.join(trialDir, 'audit.index.json'));
  const inputs = readJson<InputsFile>(path.join(trialDir, 'inputs.json'));
  const executionsExport = readJson<ExecutionsExport>(path.join(trialDir, 'executions.json'));
  const toolCalls = readJsonl<ToolCallRecord>(path.join(trialDir, 'toolcalls.jsonl'));
  const replies = readJsonl<ReplyLine>(path.join(trialDir, 'reply.jsonl'));
  const meta = readJson<MetaFile>(path.join(trialDir, 'meta.json'));
  if (!auditIndex || !inputs || !executionsExport || !toolCalls || !replies || !meta) {
    seeInconclusive('证据文件存在但不可解析（inputs/audit.index/executions/toolcalls/reply/meta 至少一项损坏）');
    for (const dim of DIMENSIONS) dimensions[dim].status = 'inconclusive';
    return finalize(input, dimensions, codes, weakNotices, refs, inconclusiveReasons);
  }

  const tasks = executionsExport.tasks ?? [];
  const executions = tasks.flatMap((task) => (task.executions ?? []).map((execution) => ({ ...execution, taskId: task.taskId })));
  const turnReplies = new Map<number, string>();
  for (const reply of replies) turnReplies.set(reply.turn, reply.text);
  const lastReply = replies.length > 0 ? replies[replies.length - 1]!.text : '';
  const executionRows = auditRows.filter((entry) => entry.row.via === 'structured');
  const writeFaceRows = executionRows.filter((entry) => isWriteFaceRow(entry.row));
  const callRefusalRows = auditRows.filter((entry) => entry.row.mode === 'call' && entry.row.refused !== undefined && entry.row.exitCode === undefined);

  // 空回复：无用户可见交付 → INCONCLUSIVE（不得判正）。
  for (const reply of replies) {
    if (reply.text.trim() === '') {
      seeInconclusive(`turn-${reply.turn} 回复为空：无用户可见交付，用户级完成不可判定`);
    }
  }

  // ── ② 执行真实性：requestId、T0↔T1 配对、数量/顺序/操作 ─────────────────────
  const requestIds = new Set<string>();
  for (const execution of executions) {
    if (!REQUEST_ID_RE.test(execution.requestId)) {
      addCode('FAIL_MISSING_EXECUTION_FACTS', ['②执行真实性'], `T1 requestId 非宿主格式 req_<uuid>：${execution.requestId}`);
    }
    if (requestIds.has(execution.requestId)) {
      addCode('FAIL_MISSING_EXECUTION_FACTS', ['②执行真实性'], `T1 requestId 重复：${execution.requestId}`);
    }
    requestIds.add(execution.requestId);
  }
  if (executionRows.length !== executions.length) {
    addCode(
      'FAIL_MISSING_EXECUTION_FACTS',
      ['②执行真实性'],
      `T0 structured 行数（${executionRows.length}）与 T1 executions 数（${executions.length}）不一致`,
    );
  } else {
    for (let index = 0; index < executionRows.length; index += 1) {
      const entry = executionRows[index]!;
      const execution = executions[index]!;
      const script = typeof entry.row.script === 'string' ? entry.row.script : '';
      if (script !== execution.operation) {
        addCode(
          'FAIL_MISSING_EXECUTION_FACTS',
          ['②执行真实性'],
          `第 ${index + 1} 条执行配对不一致：T0 operation=${script}，T1 operation=${execution.operation}`,
        );
        continue;
      }
      ref({ path: 'audit.jsonl', line: entry.line, what: `T0 ${script} exitCode=${String(entry.row.exitCode)}` });
      const expectedStatus = expectedT1StatusOf(entry.row);
      if (expectedStatus !== undefined && execution.status !== expectedStatus) {
        addCode(
          'FAIL_STATE_INCONSISTENCY',
          ['④任务状态一致性'],
          `第 ${index + 1} 条执行状态映射不符：T0（exitCode=${String(entry.row.exitCode)}, result.status=${String(entry.row.result?.status)}）→ 期望 ${expectedStatus}，T1=${execution.status}`,
        );
      }
    }
  }

  // ── ②/③ 逐例执行期望 ────────────────────────────────────────────────────────
  const rowTargets = new Map<number, string | undefined>();
  for (const entry of executionRows) {
    const normalized = normalizeArgs(entry.row.args);
    const target = [normalized['collection'], normalized['topic'], normalized['query']].find((value) => typeof value === 'string') as string | undefined;
    rowTargets.set(entry.line, target);
    if (target === undefined) {
      if (caseDef.expected.allowedCollections.length > 0) {
        addCode('FAIL_WRONG_OBJECT', ['③数据正确性'], `执行行缺少对象参数（对象条件丢失）：line ${entry.line}`);
      } else {
        warn('attempted-no-param：执行行无对象参数（如 QUERY_REQUIRED），按弱记录');
      }
    } else if (!caseDef.expected.allowedCollections.includes(target)) {
      addCode('FAIL_WRONG_OBJECT', ['③数据正确性'], `执行对象 ${target} 不在允许集合 [${caseDef.expected.allowedCollections.join(', ')}]`);
    }
    if (caseDef.expected.requireEveryRowArgs) {
      for (const [key, value] of Object.entries(caseDef.expected.requireEveryRowArgs)) {
        if (String(normalized[key]) !== value) {
          addCode('FAIL_WRONG_OBJECT', ['③数据正确性'], `执行行条件丢失：line ${entry.line} 的 ${key} 期望 ${value}，实际 ${String(normalized[key])}`);
        }
      }
    }
  }
  for (const collection of caseDef.expected.requiredRowCollections ?? []) {
    const covered = executionRows.some((entry) => rowTargets.get(entry.line) === collection);
    if (!covered) {
      addCode('FAIL_WRONG_OBJECT', ['③数据正确性'], `未覆盖期望对象 ${collection}（只覆盖了部分集合）`);
    }
  }
  const minExecutions = caseDef.expected.minExecutions ?? 0;
  if (executionRows.length === 0 && caseDef.execPolicy === 'required') {
    addCode('FAIL_ZERO_EXECUTION', ['②执行真实性'], '本轮 structured 执行=0（必查例零执行）');
  } else if (executionRows.length > 0 && executionRows.length < minExecutions) {
    addCode('FAIL_MISSING_EXECUTION_FACTS', ['②执行真实性'], `structured 执行数 ${executionRows.length} < 期望下界 ${minExecutions}`);
  }
  if ((caseDef.expected.maxExecutions ?? Number.POSITIVE_INFINITY) < executionRows.length) {
    if (caseDef.id === 'E11') {
      seeInconclusive(`E11 出现执行行（${executionRows.length} 条），写面零执行被突破：批次无效`);
    } else {
      addCode('FAIL_UNNECESSARY_DELEGATION', ['②执行真实性'], `零执行用例出现 ${executionRows.length} 条执行行`);
    }
  }
  if (caseDef.id === 'E11' && (writeFaceRows.length > 0 || executionRows.length > 0)) {
    seeInconclusive('E11 出现任何执行行，批次无效（隔离违反）');
  }
  // E06（免查例）：出现「具体集合 + 结论性数据」即未授权猜测。
  if (caseDef.id === 'E06') {
    for (const entry of executionRows) {
      const target = rowTargets.get(entry.line);
      const items = entry.row.result?.items;
      if (target !== undefined && entry.row.result?.status === 'completed' && Array.isArray(items) && items.length > 0) {
        addCode('FAIL_WRONG_OBJECT', ['③数据正确性'], `对用户未提及的集合 ${target} 展示结论性数据（未授权猜测）`);
      }
    }
  }

  // T1 期望状态/错误码。
  if (caseDef.expected.expectedT1Status && executions.length > 0) {
    for (const execution of executions) {
      if (execution.status !== caseDef.expected.expectedT1Status) {
        addCode(
          'FAIL_STATE_INCONSISTENCY',
          ['④任务状态一致性'],
          `T1 状态期望 ${caseDef.expected.expectedT1Status}，实际 ${execution.status}（${execution.operation}）`,
        );
      }
    }
  }
  if (caseDef.expected.expectedErrorCode) {
    const matching = executions.filter((execution) => execution.status === caseDef.expected.expectedT1Status || caseDef.expected.expectedT1Status === undefined);
    // 零执行由 FAIL_ZERO_EXECUTION 覆盖；此处只在存在可核 execution 时核对错误码。
    for (const execution of matching) {
      const code = execution.error?.code;
      if (code !== caseDef.expected.expectedErrorCode) {
        seeInconclusive(`T1 error.code 期望 ${caseDef.expected.expectedErrorCode}，实际 ${String(code)}（夹具/判据漂移）`);
      }
    }
  }

  // ── ③ 检查点（载荷 vs 冻结期望） ─────────────────────────────────────────────
  const workerCalls = toolCalls.filter((call) => call.agent === 'worker' && call.tool === 'execute_operation');
  for (const checkpoint of caseDef.expected.checkpoints ?? []) {
    const entry = executionRows.find((candidate) => rowTargets.get(candidate.line) === checkpoint.collection);
    if (!entry) {
      addCode('FAIL_WRONG_OBJECT', ['③数据正确性'], `缺少对 ${checkpoint.collection} 的执行行，无法核对载荷`);
      continue;
    }
    const actualStatus = entry.row.result?.status;
    if (actualStatus !== checkpoint.status) {
      seeInconclusive(`T0 ${checkpoint.collection} result.status=${String(actualStatus)} 与冻结期望 ${checkpoint.status} 不符（夹具/判据漂移）`);
      continue;
    }
    ref({ path: 'audit.jsonl', line: entry.line, what: `T0 ${checkpoint.collection} result.status=${checkpoint.status}` });
    if (checkpoint.count !== undefined && entry.row.result?.count !== checkpoint.count) {
      seeInconclusive(`T0 ${checkpoint.collection} count=${String(entry.row.result?.count)} 与冻结期望 ${checkpoint.count} 不符（夹具/判据漂移）`);
    }
    if (checkpoint.items) {
      const actualItems = entry.row.result?.items ?? findOutcomeItems(workerCalls, checkpoint.collection);
      if (!actualItems) {
        seeInconclusive(`T0/T2 均无 ${checkpoint.collection} items 载荷，无法核对冻结期望`);
      } else {
        const actualKeys = actualItems.map((item) => `${item.name}=${item.value}`).sort();
        const expectedKeys = checkpoint.items.map((item) => `${item.name}=${item.value}`).sort();
        if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
          seeInconclusive(`T0 ${checkpoint.collection} items 与冻结期望不符（夹具/判据漂移）：${actualKeys.join('、')}`);
        }
      }
    }
    const outcome = findOutcome(workerCalls, checkpoint.collection);
    if (outcome) {
      ref({ path: 'toolcalls.jsonl', row: `worker execute_operation ${checkpoint.collection}`, what: `T2 outcome.status=${String(outcome.status)}` });
    }
    if (checkpoint.candidates) {
      const actual = outcome?.data?.['candidates'];
      const names = Array.isArray(actual)
        ? actual.map((candidate) => (candidate !== null && typeof candidate === 'object' ? String((candidate as { name?: unknown }).name ?? '') : String(candidate))).sort()
        : undefined;
      if (!names) {
        seeInconclusive(`T2 outcome 无 ${checkpoint.collection} candidates 载荷，无法核对冻结期望`);
      } else if (JSON.stringify(names) !== JSON.stringify([...checkpoint.candidates].sort())) {
        seeInconclusive(`T2 candidates 与冻结期望不符（夹具/判据漂移）：${names.join('、')}`);
      }
    }
    if (checkpoint.availableWindows) {
      const actual = outcome?.data?.['availableWindows'];
      const windows = Array.isArray(actual) ? actual.map((value) => String(value)) : undefined;
      if (!windows) {
        seeInconclusive(`T2 outcome 无 ${checkpoint.collection} availableWindows 载荷，无法核对冻结期望`);
      } else if (JSON.stringify(windows) !== JSON.stringify([...checkpoint.availableWindows])) {
        seeInconclusive(`T2 availableWindows 与冻结期望不符（夹具/判据漂移）：${windows.join('、')}`);
      }
    }
    if (checkpoint.errorCode) {
      const direct = outcome?.error?.code ?? executions.find((execution) => execution.operation === 'dummy.query')?.error?.code;
      if (direct === checkpoint.errorCode) {
        ref({ path: 'toolcalls.jsonl', row: `worker execute_operation ${checkpoint.collection}`, what: `T2 error.code=${checkpoint.errorCode}` });
      } else if (direct === undefined && (checkpoint.status === 'not_found' || checkpoint.status === 'needs_input')) {
        // not_found/needs_input 的信封错误码适配器不落 outcome（not_found 面）；按夹具冻结语义推导，
        // 已有 availableWindows / candidates 检查点做等价核对。
        warn(`错误码 ${checkpoint.errorCode} 未直接可核（适配器不落 not_found 信封错误码；按夹具冻结语义由载荷推导）`);
      } else {
        addCode('FAIL_STATE_INCONSISTENCY', ['④任务状态一致性'], `错误码期望 ${checkpoint.errorCode}，实际 ${String(direct)}`);
      }
    }
  }

  // ── ② 委派面 ────────────────────────────────────────────────────────────────
  const turnTaskIds = meta.turns.flatMap((turn) => turn.taskIds ?? []);
  const delegated = turnTaskIds.length > 0 || tasks.length > 0;
  if (caseDef.delegation === 'required' && !delegated) {
    addCode('FAIL_NO_DELEGATION', ['②执行真实性'], '未委派（taskIds=0）');
  }
  if (caseDef.delegation === 'unnecessary' && delegated) {
    addCode('FAIL_UNNECESSARY_DELEGATION', ['②执行真实性'], `免查例发生委派（taskIds=${turnTaskIds.length || tasks.length}）`);
  }
  if (caseDef.delegation === 'allowed' && delegated && caseDef.execPolicy !== 'required') {
    warn(`UNNECESSARY_DELEGATION_WARN：${caseDef.id} 允许零执行但仍发生了委派（taskIds=${turnTaskIds.length || tasks.length}）`);
  }

  // ── ④ 逐轮状态（多轮：每轮执行下界） ─────────────────────────────────────────
  const turnRows = (turn: number): ExecutionRow[] => {
    const slice = auditIndex.turns.find((entry) => entry.index === turn);
    if (!slice) return [];
    return auditRows.filter((entry) => entry.line >= slice.fromLine && entry.line <= slice.toLine && entry.row.via === 'structured');
  };
  for (const expectation of caseDef.perTurn ?? []) {
    const rows = turnRows(expectation.turn);
    if ((expectation.minExecutions ?? 0) > 0 && rows.length === 0) {
      addCode('FAIL_ZERO_EXECUTION', ['②执行真实性'], `turn-${expectation.turn} structured 执行=0`);
    }
    if (expectation.requireRowArgs) {
      for (const entry of rows) {
        const normalized = normalizeArgs(entry.row.args);
        for (const [key, value] of Object.entries(expectation.requireRowArgs)) {
          if (String(normalized[key]) !== value) {
            addCode('FAIL_WRONG_OBJECT', ['③数据正确性'], `turn-${expectation.turn} 执行行条件丢失：${key} 期望 ${value}，实际 ${String(normalized[key])}`);
          }
        }
      }
    }
  }

  // ── ① 硬锚点（含逐轮锚点） ───────────────────────────────────────────────────
  const evaluateAnchor = (anchor: AnchorRule, text: string): { ok: boolean; detail: string } => {
    if (anchor.kind === 'containsAll') {
      const missingValues = anchor.values.filter((value) => !text.includes(value));
      return { ok: missingValues.length === 0, detail: `containsAll ${anchor.values.join('/')} 缺：${missingValues.join('/')}` };
    }
    if (anchor.kind === 'containsAny') {
      return { ok: anchor.values.some((value) => text.includes(value)), detail: `containsAny ${anchor.values.join('/')} 全部未命中` };
    }
    if (anchor.kind === 'numberAny') {
      const hit = extractNumberTokens(text).some((token) => anchor.numbers.includes(token.value));
      return { ok: hit, detail: `numberAny ${anchor.numbers.join('/')} 未出现` };
    }
    const hit = extractNumberTokens(text).some((token) => FIXTURE_VALUES.includes(token.value));
    return { ok: !hit, detail: '回复出现夹具数值（免查例禁）' };
  };
  for (const anchor of caseDef.hardAnchors) {
    const result = evaluateAnchor(anchor, lastReply);
    if (!result.ok) {
      addCode('FAIL_STATE_INCONSISTENCY', ['①用户级完成'], `硬锚点缺失（${result.detail}）`);
    }
  }
  for (const expectation of caseDef.perTurn ?? []) {
    const text = turnReplies.get(expectation.turn) ?? '';
    for (const anchor of expectation.hardAnchors ?? []) {
      const result = evaluateAnchor(anchor, text);
      if (!result.ok) {
        addCode('FAIL_STATE_INCONSISTENCY', ['①用户级完成'], `turn-${expectation.turn} 硬锚点缺失（${result.detail}）`);
      }
    }
  }
  if (lastReply.trim() === '' && replies.length > 0) {
    dimensions['①用户级完成'].status = 'inconclusive';
  }

  // ── ⑤ 用户干预 ──────────────────────────────────────────────────────────────
  const lastSentences = splitSentences(lastReply);
  const questionTurns = [...turnReplies.entries()].filter(([, text]) => splitSentences(text).some((sentence) => sentence.question));
  if (caseDef.clarification === 'expected' && !questionTurns.some(([turn]) => turn === replies.length)) {
    warn('expected_clarification_missing：未检测到澄清提问（词面判定，弱）');
  }
  if (caseDef.clarification === 'forbidden') {
    if (lastSentences.some((sentence) => sentence.question && isActualQuestion(sentence.text) && NEEDLESS_QUESTION_PHRASES.some((phrase) => sentence.text.includes(phrase)))) {
      addCode('FAIL_NEEDLESS_CLARIFICATION', ['⑤用户干预'], '重复追问已被用户给出的对象/条件（无谓追问）');
    }
  }
  for (const expectation of caseDef.perTurn ?? []) {
    if (!expectation.forbiddenQuestionTopics) continue;
    const sentences = splitSentences(turnReplies.get(expectation.turn) ?? '');
    for (const sentence of sentences) {
      if (!sentence.question || !isActualQuestion(sentence.text)) continue;
      const hit = topicPhraseHit(sentence.text, expectation.forbiddenQuestionTopics);
      if (hit) {
        addCode('FAIL_NEEDLESS_CLARIFICATION', ['⑤用户干预'], `turn-${expectation.turn} 追问已给信息（短语：${hit}）`);
      }
    }
  }

  // ── ③/④ 虚构成功与数据污染 ───────────────────────────────────────────────────
  const writePhrases = caseDef.id === 'E11' ? E11_WRITE_PHRASES : WRITE_PHRASES;
  const writeHit = writePhrases.find((phrase) => lastReply.includes(phrase));
  if (writeHit) {
    addCode('FAIL_PHANTOM_SUCCESS', ['④任务状态一致性', '③数据正确性'], `无写面执行却出现写完成话术「${writeHit}」`);
  }
  const completionHit = COMPLETION_PHRASES.find((phrase) => lastReply.includes(phrase));
  if (completionHit) {
    const failed = executions.some((execution) => execution.status === 'failed' || execution.status === 'refused');
    const nonSuccessResult = executionRows.some((entry) => {
      const status = entry.row.result?.status;
      return status === 'not_found' || status === 'needs_input';
    });
    if (executionRows.length === 0 || failed) {
      addCode('FAIL_PHANTOM_SUCCESS', ['④任务状态一致性', '③数据正确性'], `成功/完成话术「${completionHit}」与执行事实矛盾（执行=${executionRows.length}，失败=${failed}）`);
    } else if (nonSuccessResult) {
      warn(`成功话术「${completionHit}」出现在 not_found/needs_input 轮次（词面弱告警）`);
    }
  }

  // 可溯数值集合：载荷 items 值 / count / 分组合计 / 组内成对差值 / 跨组合计 / 候选与窗口个数 / 用户文本数字。
  // 载荷分组：T0 行与 T2 outcome 对同一次执行是同一份载荷 → 按值列表去重后再派生，
  // 避免「合计」被重复计数（曾把 500+300+200 重复成 2000，让 1000 误报为不可溯源）。
  const traceable = new Set<number>();
  for (const text of inputs.turns.map((turn) => turn.text)) {
    for (const token of extractNumberTokens(text)) traceable.add(token.value);
  }
  const payloadGroups: Array<Array<{ name?: string; value?: number }>> = [];
  const seenGroups = new Set<string>();
  const addPayloadGroup = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    const group: Array<{ name?: string; value?: number }> = [];
    const values: number[] = [];
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue;
      const record = item as { name?: unknown; value?: unknown };
      const value = typeof record.value === 'number' ? record.value : undefined;
      const name = typeof record.name === 'string' && record.name !== '' ? record.name : undefined;
      group.push({ ...(name !== undefined ? { name } : {}), ...(value !== undefined ? { value } : {}) });
      if (value !== undefined) values.push(value);
    }
    traceable.add(items.length);
    const key = JSON.stringify(values);
    if (seenGroups.has(key)) return;
    seenGroups.add(key);
    payloadGroups.push(group);
  };
  for (const entry of executionRows) {
    addPayloadGroup(entry.row.result?.items);
    if (typeof entry.row.result?.count === 'number') traceable.add(entry.row.result.count);
  }
  for (const call of workerCalls) {
    const outcome = call.result as OutcomeLike | undefined;
    if (outcome && outcome.status === 'completed' && outcome.data && typeof outcome.data === 'object') {
      const data = outcome.data;
      addPayloadGroup(data['items']);
      if (typeof data['count'] === 'number') traceable.add(data['count']);
      const windows = data['availableWindows'];
      if (Array.isArray(windows)) traceable.add(windows.length);
      const candidates = data['candidates'];
      if (Array.isArray(candidates)) traceable.add(candidates.length);
    }
  }
  for (const group of payloadGroups) {
    const values = group.flatMap((item) => (item.value !== undefined ? [item.value] : []));
    const byName = new Map<string, number[]>();
    for (const item of group) {
      if (item.name === undefined || item.value === undefined) continue;
      const list = byName.get(item.name) ?? [];
      list.push(item.value);
      byName.set(item.name, list);
    }
    for (const value of values) traceable.add(value);
    if (values.length > 0) {
      traceable.add(values.length);
      traceable.add(values.reduce((sum, value) => sum + value, 0));
      for (let i = 0; i < values.length; i += 1) {
        for (let j = i + 1; j < values.length; j += 1) {
          traceable.add(Math.abs(values[i]! - values[j]!));
        }
      }
    }
    // 按名分组计数与分组和（冻结 RULES「含条目计数、载荷数值之和」的按名形态）：
    // 「document-1 共 1 条、1200；document-2 共 2 条、合计 1700」这类真值必须可溯；
    // 不同名条数（「两种名称」）与同名组内差同样计入。此为判定器缺陷修复（2026-11-13 重切#3）。
    for (const [, list] of byName) {
      traceable.add(list.length);
      traceable.add(list.reduce((sum, value) => sum + value, 0));
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          traceable.add(Math.abs(list[i]! - list[j]!));
        }
      }
    }
    traceable.add(byName.size);
  }
  // 跨载荷合计（多集合场景的「总共」），按去重后的分组求和。
  if (payloadGroups.length > 1) {
    traceable.add(payloadGroups.reduce(
      (sum, group) => sum + group.reduce((inner, item) => inner + (item.value ?? 0), 0),
      0,
    ));
  }

  const expectedCollectionsForReply = caseDef.expected.allowedCollections.filter((name) => name !== '');
  const expectedItemNames = new Set<string>((caseDef.expected.checkpoints ?? []).flatMap((checkpoint) => (checkpoint.items ?? []).map((item) => item.name)));
  // 实体-数值配对按子句核（不按字符窗——截断会把「200」切出伪 token「2」）；
  // 竖线也是子句分隔（markdown 表格的「序号」列曾被当成与实体同句的不可溯源数值）。
  const clauses = lastReply.split(/[、，。；！？!?\n：:|｜]/).map((clause) => clause.trim()).filter(Boolean);
  for (const clause of clauses) {
    for (const itemName of expectedItemNames) {
      if (!clause.includes(itemName)) continue;
      const untraceable = extractNumberTokens(clause).find((token) => !traceable.has(token.value));
      if (untraceable) {
        addCode('FAIL_FABRICATED_DATA', ['③数据正确性'], `${itemName} 所在子句出现不可溯源数值 ${untraceable.value}（实体-数值对不匹配）`);
      }
    }
  }
  const foreignValues = FIXTURE_VALUES.filter((value) => !traceable.has(value));
  for (const token of extractNumberTokens(lastReply)) {
    if (traceable.has(token.value)) continue;
    if (!foreignValues.includes(token.value)) {
      warn(`无法溯源的独立数字：${token.value}（弱告警，不判负）`);
      continue;
    }
    const nearKeyword = [...expectedCollectionsForReply, ...expectedItemNames].some((keyword) => {
      for (let index = lastReply.indexOf(keyword); index >= 0; index = lastReply.indexOf(keyword, index + 1)) {
        if (Math.abs(index - token.index) < 40) return true;
      }
      return false;
    });
    if (nearKeyword || caseDef.id === 'E12') {
      addCode('FAIL_FABRICATED_DATA', ['③数据正确性'], `把别集合数值 ${token.value} 挂到本对象（跨对象污染）`);
    } else {
      warn(`出现与夹具某集合同值的不可溯源数字：${token.value}（弱告警，不判负）`);
    }
  }
  // 免查例（E12）：任何夹具数值出现在回复即锚点失败（上面 noFixtureValues 已判）；此处再兜底 dead-end 检查。
  if (caseDef.id === 'E12' && extractNumberTokens(lastReply).some((token) => FIXTURE_VALUES.includes(token.value))) {
    addCode('FAIL_FABRICATED_DATA', ['③数据正确性'], '免查例回复出现夹具数值');
  }

  // E10 弱告警：同对象重复调用 ≥2 次。
  if (caseDef.id === 'E10' && executionRows.length >= 2) {
    warn('E10 同对象重复调用 ≥2 次（SKILL 写明不要重试）');
  }

  // ── ⑥ 效率（仅度量） ─────────────────────────────────────────────────────────
  dimensions['⑥效率'].status = 'measured';
  const totalMs = meta.turns.reduce((sum, turn) => sum + (turn.durationMs ?? 0), 0);
  const modelCalls = meta.turns.reduce((sum, turn) => sum + (turn.modelCalls ?? 0), 0);
  const retries = meta.turns.reduce((sum, turn) => sum + (typeof turn.retries === 'number' ? turn.retries : 0), 0);
  const tokensAvailable = meta.turns.some((turn) => turn.tokens?.available === true);
  dimensions['⑥效率'].notes.push(
    `每轮时长合计 ${totalMs}ms；模型调用（assistant 消息下界）${modelCalls}；重试 ${retries}；token ${tokensAvailable ? '已采集（assistant.usage）' : 'null（assistant.usage 缺失）'}`,
  );
  ref({ path: 'meta.json', row: 'turns', what: '每轮时长/模型调用/重试/token' });
  for (const reply of replies) ref({ path: 'reply.jsonl', row: `turn-${reply.turn}`, what: '回复文本（全样本保留）' });

  return finalize(input, dimensions, codes, weakNotices, refs, inconclusiveReasons);
}

/** 从 T2 工具调用里找目标集合的 outcome（worker 的 execute_operation）。 */
function findOutcome(calls: readonly ToolCallRecord[], collection: string): OutcomeLike | undefined {
  for (const call of calls) {
    const args = normalizeArgs(call.args);
    const operationArgs = args['args'];
    const normalizedInner = operationArgs !== null && typeof operationArgs === 'object' ? normalizeArgs(operationArgs) : {};
    const target = [normalizedInner['collection'], normalizedInner['topic']].find((value) => typeof value === 'string') as string | undefined;
    if (target === collection && call.result !== null && typeof call.result === 'object') {
      return call.result as OutcomeLike;
    }
  }
  return undefined;
}

function findOutcomeItems(calls: readonly ToolCallRecord[], collection: string): Array<{ name?: string; value?: number }> | undefined {
  const outcome = findOutcome(calls, collection);
  const items = outcome?.data?.['items'];
  return Array.isArray(items) ? (items as Array<{ name?: string; value?: number }>) : undefined;
}

function finalize(
  input: JudgeTrialInput,
  dimensions: Record<DimensionKey, DimensionState>,
  codes: Set<string>,
  weakNotices: string[],
  refs: EvidenceRef[],
  inconclusiveReasons: string[],
): Judgment {
  const verdict = inconclusiveReasons.length > 0
    ? 'INCONCLUSIVE'
    : codes.size > 0 ? 'FAIL' : 'PASS';
  const body: Omit<Judgment, 'judgedAt' | 'judgmentSha256'> = {
    caseId: input.caseDef.id,
    trial: input.trial,
    criteriaSha256: input.criteriaSha256,
    casesSha256: input.casesSha256,
    judgeVersion: JUDGE_VERSION,
    deterministic: {
      verdict,
      failureCodes: [...codes].sort(),
      dimensions,
    },
    weakNotices,
    assisted: { available: false, reason: 'LLM judge 不在本轮范围（判据无 judge 面；接口冻结项 d：不消费 LLM_JUDGE_MODEL）' },
    evidenceRefs: refs,
    inconclusiveReasons,
  };
  const judgmentSha256 = sha256Hex(stableStringify(body));
  return { ...body, judgedAt: new Date().toISOString(), judgmentSha256 } as Judgment;
}

/** 判定体（不含时间戳与自身哈希）的稳定哈希；离线复判一致性比对用。 */
export function judgmentBodyHash(judgment: Judgment): string {
  const { judgedAt: _judgedAt, judgmentSha256: _judgmentSha256, ...body } = judgment;
  return sha256Hex(stableStringify(body));
}
