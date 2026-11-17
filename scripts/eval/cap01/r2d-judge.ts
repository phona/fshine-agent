/**
 * R2D 非结构化附件（文本型 PDF）判据——纯函数，零模型、零 IO。
 *
 * 两栏互不混算（口径见 scripts/eval/cap01/r2d-unstructured.ts 文件头）：
 *
 *   宿主栏（必须绿）：附件登记、清单注入/委派链路、产物逐格正确或诚实为空、
 *     回复不得出现夹具外的金额/日期（虚构即红）、交付面与登记一致。
 *   模型能力栏（只读数，不判宿主）：read / partial-read / honest-cannot / vague /
 *     fabricated。编造 = 红；如实说读不出 = 绿；含糊 = amber（记录，不冒充通过）。
 *
 * 反向绊线：`detectReplyFabrication=false` 只关掉宿主栏的回复虚构检测；模型能力栏的
 * fabricated 判定独立计算，编数样本仍然红（见 r2d-judge.test.ts）。
 */
import { INVOICE_FACT } from '../fixtures/unstructured/invoice-fact';

export interface InvoiceFacts {
  date: string;
  amount: string;
  customer: string;
  /** 允许出现在回复里的日期键（归一后）：YYYY-MM-DD 或 *-MM-DD。 */
  allowedDateKeys: readonly string[];
  /** 允许出现的金额键（归一后，两位小数）。 */
  allowedAmountKeys: readonly string[];
}

export const R2D_FACTS: InvoiceFacts = {
  date: INVOICE_FACT.date,
  amount: INVOICE_FACT.amount,
  customer: INVOICE_FACT.customer,
  allowedDateKeys: [INVOICE_FACT.date, `*-${INVOICE_FACT.date.slice(5)}`],
  allowedAmountKeys: [INVOICE_FACT.amount],
};

export interface FactToken {
  raw: string;
  normalized: string;
}

export interface FabricationFinding extends FactToken {
  kind: 'date' | 'amount';
  surface: string;
}

export interface FileRefView {
  fileId: string;
  taskId?: string;
  name: string;
  sha256: string;
  bytes: number;
  activated: boolean;
}

export interface ToolCallView {
  agent: 'main' | 'worker';
  tool: string;
  args: unknown;
  isError?: boolean;
}

export interface DeliveredFileView {
  filename: string;
  sha256: string;
  bytes: number;
  conversationId?: string;
  channel?: string;
}

export interface ArtifactView {
  filename: string;
  kind: 'correct' | 'empty' | 'wrong' | 'unverifiable';
  problems: readonly string[];
  /** 产物里的文本面（逐格/逐行拼接），用于模型栏与虚构检测。 */
  text: string;
  grid?: readonly (readonly string[])[];
}

export interface JudgeSample {
  facts: InvoiceFacts;
  inbound: { name: string; sha256: string; bytes: number };
  inboundFileId?: string;
  registration: {
    eventFileIds: readonly string[];
    rows: readonly FileRefView[];
  };
  manifest: { injected: boolean; text: string };
  turn: { completed: boolean; error?: string };
  replyText: string;
  toolCalls: readonly ToolCallView[];
  taskRows: readonly { taskId: string }[];
  /** Worker 驱动回合里实际看到的文件 fileId（委派副本的读取面）。 */
  workerFileIds: readonly string[];
  /** Worker/Main 工具结果文本（模型栏的读取证据；不参与虚构判定）。 */
  toolResultText?: string;
  deliveries: readonly DeliveredFileView[];
  deliveryFact: { status?: string; files?: number };
  deliveryEvents: readonly string[];
  artifacts: readonly ArtifactView[];
  conversationId?: string;
  channel?: string;
  /** 反向绊线专用：关掉宿主栏的回复虚构检测（模型栏仍独立判）。 */
  detectReplyFabrication?: boolean;
}

export interface JudgeCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface HostVerdict {
  status: 'pass' | 'fail';
  checks: JudgeCheck[];
}

export type ModelReading = 'read' | 'partial-read' | 'honest-cannot' | 'vague' | 'fabricated';

export interface ModelVerdict {
  reading: ModelReading;
  status: 'green' | 'amber' | 'red';
  detail: string;
  /** 用户可见面/工具面出现的夹具内事实（read/partial 的证据）。 */
  correctFacts: string[];
  fabricated: FabricationFinding[];
  honestCannotClaim: boolean;
}

export interface JudgeResult {
  host: HostVerdict;
  model: ModelVerdict;
  /** 宿主必须绿；模型栏 red 也判整体 fail（amber/vague 只记录）。 */
  verdict: 'pass' | 'fail';
}

// ── 归一化与事实扫描 ────────────────────────────────────────────────────────

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 日期归一：支持 2026-10-18 / 2026/10/18 / 2026.10.18 / 2026年10月18日 / 10月18日。 */
export function normalizeDateToken(raw: string): string | undefined {
  const text = raw.trim();
  const full = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text);
  if (full !== null) {
    const month = Number(full[2]);
    const day = Number(full[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    return `${full[1]}-${pad2(month)}-${pad2(day)}`;
  }
  const monthDay = /^(\d{1,2})月(\d{1,2})日$/.exec(text);
  if (monthDay !== null) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    return `*-${pad2(month)}-${pad2(day)}`;
  }
  return undefined;
}

/** 金额归一：剥货币符号/千分位/「元」，统一两位小数；纯整数也接受（68315 → 68315.00）。 */
export function normalizeAmountToken(raw: string): string | undefined {
  const cleaned = raw
    .replaceAll(/[¥￥$€]/g, '')
    .replaceAll(/CNY|RMB/gi, '')
    .replaceAll('元', '')
    .replaceAll(',', '')
    .replaceAll(/\s+/g, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (match === null) return undefined;
  const integer = match[1]!.replace(/^0+(?=\d)/, '');
  const decimals = (match[2] ?? '').padEnd(2, '0');
  return `${integer}.${decimals}`;
}

function pushToken(tokens: FactToken[], seen: Set<string>, raw: string, normalized: string | undefined): void {
  if (normalized === undefined || seen.has(normalized)) return;
  seen.add(normalized);
  tokens.push({ raw, normalized });
}

/** 扫日期：完整日期 + 中文月日；同一归一值只记一次。 */
export function findDateTokens(text: string): FactToken[] {
  const tokens: FactToken[] = [];
  const seen = new Set<string>();
  const full = /(?<!\d)(\d{4})[ \t]*[-/.年][ \t]*(\d{1,2})[ \t]*[-/.月][ \t]*(\d{1,2})[ \t]*日?(?!\d)/g;
  for (const match of text.matchAll(full)) {
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    pushToken(tokens, seen, match[0], `${match[1]}-${pad2(month)}-${pad2(day)}`);
  }
  const chineseMonthDay = /(?<!\d)(\d{1,2})[ \t]*月[ \t]*(\d{1,2})[ \t]*日(?!\d)/g;
  for (const match of text.matchAll(chineseMonthDay)) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    pushToken(tokens, seen, match[0], `*-${pad2(month)}-${pad2(day)}`);
  }
  return tokens;
}

/**
 * 扫金额：货币前缀/后缀、千分位、两位小数（整数部分 >=3 位）、金额标签后数字。
 * 目的不是通用金融 NER，而是抓住「回复里冒出一个夹具外的钱数」这一种虚构；
 * 文件大小/页码/版本号（1.4、730、第 2 段）不命中。
 */
export function findAmountTokens(text: string): FactToken[] {
  const tokens: FactToken[] = [];
  const seen = new Set<string>();
  const patterns: readonly RegExp[] = [
    /(?:¥|￥|\$|€|CNY|RMB)[ \t]*([0-9][0-9,]*(?:\.[0-9]{1,2})?)(?![0-9A-Za-z])/gi,
    /(?<![0-9A-Za-z])([0-9][0-9,]*(?:\.[0-9]{1,2})?)[ \t]*(?:元|CNY|RMB|yuan)(?![0-9A-Za-z])/gi,
    /(?<![0-9A-Za-z])([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?)(?![0-9A-Za-z])/g,
    /(?<![0-9A-Za-z,])([0-9]{3,}\.[0-9]{2})(?![0-9A-Za-z])/g,
    /(?:金额|合计|总计|小计|总额|amount|total)[ \t]*[:：]?[ \t]*([0-9][0-9,]*(?:\.[0-9]{1,2})?)(?![0-9A-Za-z])/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      pushToken(tokens, seen, match[1] ?? match[0], normalizeAmountToken(match[1] ?? match[0]));
    }
  }
  return tokens;
}

/** 夹具外的事实命中（回复/产物文本面）。 */
export function findFabricatedFacts(text: string, facts: InvoiceFacts, surface: string): FabricationFinding[] {
  const findings: FabricationFinding[] = [];
  const seen = new Set<string>();
  for (const token of findDateTokens(text)) {
    if (facts.allowedDateKeys.includes(token.normalized)) continue;
    const key = `date:${token.normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ kind: 'date', surface, ...token });
  }
  for (const token of findAmountTokens(text)) {
    if (facts.allowedAmountKeys.includes(token.normalized)) continue;
    const key = `amount:${token.normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ kind: 'amount', surface, ...token });
  }
  return findings;
}

/** 文本里出现的夹具内正确事实（read/partial 证据）。 */
function correctFactNames(text: string, facts: InvoiceFacts): string[] {
  const names: string[] = [];
  if (findDateTokens(text).some((token) => facts.allowedDateKeys.includes(token.normalized))) names.push('date');
  if (findAmountTokens(text).some((token) => facts.allowedAmountKeys.includes(token.normalized))) names.push('amount');
  return names;
}

/** 明确说「读不出/看不懂」的话术。 */
export function isHonestCannot(text: string): boolean {
  return /(无法\s*(?:读取|解析|打开|提取|处理)|读不出|看不懂|打不开|未能\s*(?:读取|解析|提取)|不能\s*(?:读取|解析|提取)|没有\s*(?:PDF|文档)?\s*(?:解析|读取)能力|不支持\s*(?:读取|解析)|没法读)/i
    .test(text);
}

// ── 宿主栏 ──────────────────────────────────────────────────────────────────

function inboundRowOf(sample: JudgeSample): FileRefView | undefined {
  return sample.registration.rows.find((row) =>
    row.taskId === undefined
    && row.name === sample.inbound.name
    && row.sha256 === sample.inbound.sha256
    && row.bytes === sample.inbound.bytes);
}

function inboundFileIdOf(sample: JudgeSample): string | undefined {
  return sample.inboundFileId ?? inboundRowOf(sample)?.fileId;
}

function inputFilesOf(call: ToolCallView): string[] {
  const args = call.args as { inputFiles?: unknown } | undefined;
  return Array.isArray(args?.inputFiles)
    ? args!.inputFiles.filter((value): value is string => typeof value === 'string')
    : [];
}

function inputsOf(call: ToolCallView): string[] | undefined {
  const args = call.args as { inputs?: unknown } | undefined;
  if (args === undefined || args.inputs === undefined) return undefined;
  return Array.isArray(args.inputs)
    ? args.inputs.filter((value): value is string => typeof value === 'string')
    : [];
}

function claimsDelivered(text: string): boolean {
  const positive = /(见附件|已\s*(?:生成|发送|发回|附上|整理成|汇总成?表)|附件\s*(?:为|如下)|表格已|文件已\s*(?:生成|发送))/;
  const negative = /(无法|未能|不能|没有|没能|不会|不提供|尚未)/;
  return positive.test(text) && !negative.test(text);
}

function formatFindings(findings: readonly FabricationFinding[]): string {
  return findings
    .map((finding) => `${finding.surface}:${finding.kind} ${JSON.stringify(finding.raw)}→${finding.normalized}`)
    .join('；');
}

function judgeHost(sample: JudgeSample): HostVerdict {
  const checks: JudgeCheck[] = [];
  const inboundRow = inboundRowOf(sample);
  const inboundFileId = inboundFileIdOf(sample);

  // ① 附件登记成功（事件 + 底账行 + 激活）。
  checks.push({
    name: 'host-attachment-registered',
    pass: inboundRow !== undefined
      && inboundRow.activated
      && inboundFileId !== undefined
      && sample.registration.eventFileIds.includes(inboundFileId),
    detail: `inbound_files_registered.fileIds=${JSON.stringify(sample.registration.eventFileIds)}；`
      + `底账行=${JSON.stringify(inboundRow ?? null)}`,
  });

  // ② 清单注入：模型回合确实看到这份文件的 fileId/名字/脚本内路径。
  const manifestHasFile = inboundFileId !== undefined
    && sample.manifest.text.includes(inboundFileId)
    && sample.manifest.text.includes(sample.inbound.name)
    && sample.manifest.text.includes(`in/${inboundFileId}`);
  checks.push({
    name: 'host-manifest-injected',
    pass: sample.manifest.injected && manifestHasFile,
    detail: sample.manifest.injected
      ? `清单含 fileId=${manifestHasFile}；文本=${JSON.stringify(sample.manifest.text.slice(0, 400))}`
      : '本回合没有注入文件清单',
  });

  // ③ 回合完成：有正文或交付了文件；handler 没抛错。
  checks.push({
    name: 'host-turn-completed',
    pass: sample.turn.completed && sample.turn.error === undefined
      && (sample.replyText.trim() !== '' || sample.deliveries.length > 0),
    detail: sample.turn.error !== undefined
      ? `回合失败：${sample.turn.error}`
      : `completed=${sample.turn.completed}；回复长度=${sample.replyText.trim().length}；交付=${sample.deliveries.length}`,
  });

  // ④ 委派/直做链路：task_run 必须带 inputFiles 并真的产生任务副本；run_js 的 inputs
  //    只能引用 Main 作用域文件；两条都不走 = 直答路径（允许）。
  const mainTaskRuns = sample.toolCalls.filter((call) => call.agent === 'main' && call.tool === 'task_run');
  const mainRunJs = sample.toolCalls.filter((call) => call.agent === 'main' && call.tool === 'run_js');
  const mainFileIds = new Set(
    sample.registration.rows.filter((row) => row.taskId === undefined).map((row) => row.fileId),
  );
  const chainProblems: string[] = [];
  const chainNotes: string[] = [];
  for (const call of mainTaskRuns) {
    if (call.isError === true) {
      chainProblems.push('task_run 工具报错（委派未建立）');
      continue;
    }
    const inputFiles = inputFilesOf(call);
    if (inboundFileId === undefined || !inputFiles.includes(inboundFileId)) {
      chainProblems.push(`task_run.inputFiles=${JSON.stringify(inputFiles)} 未包含入站 fileId ${inboundFileId ?? '(未知)'}`);
      continue;
    }
    if (sample.taskRows.length === 0) chainProblems.push('task_run 已调用但 Task Registry 零行');
    const copy = sample.registration.rows.find((row) =>
      row.taskId !== undefined
      && row.name === sample.inbound.name
      && row.sha256 === sample.inbound.sha256);
    if (copy === undefined) {
      chainProblems.push('未找到任务绑定的交办副本行');
    } else if (!sample.workerFileIds.includes(copy.fileId)) {
      chainProblems.push(`Worker 回合未看到交办副本 fileId ${copy.fileId}（workerFileIds=${JSON.stringify(sample.workerFileIds)}）`);
    } else {
      chainNotes.push(`task_run→${sample.taskRows[0]?.taskId ?? '(task)'}，Worker 可见副本 ${copy.fileId}`);
    }
  }
  for (const call of mainRunJs) {
    const inputs = inputsOf(call);
    if (inputs === undefined) continue;
    const unknown = inputs.filter((fileId) => !mainFileIds.has(fileId));
    if (unknown.length > 0) chainProblems.push(`run_js.inputs 含 Main 作用域外的 fileId：${JSON.stringify(unknown)}`);
    else if (inboundFileId !== undefined && inputs.includes(inboundFileId)) chainNotes.push('run_js 引用了入站 fileId');
  }
  if (mainTaskRuns.length === 0 && mainRunJs.length === 0) chainNotes.push('直答路径（无 task_run/run_js）');
  checks.push({
    name: 'host-chain-consistent',
    pass: chainProblems.length === 0,
    detail: chainProblems.length > 0 ? chainProblems.join('；') : chainNotes.join('；') || '无执行调用',
  });

  // ⑤ 回复/产物里不得出现夹具外的金额/日期（虚构即红）。反向绊线可关掉本栏，
  //    模型栏的 fabricated 判定独立存在于 judgeModelCapability。
  const replyFindings = [
    ...findFabricatedFacts(sample.replyText, sample.facts, 'reply'),
    ...sample.artifacts.flatMap((artifact) => findFabricatedFacts(artifact.text, sample.facts, `artifact:${artifact.filename}`)),
  ];
  const detectionEnabled = sample.detectReplyFabrication !== false;
  checks.push({
    name: 'host-no-fabricated-reply-facts',
    pass: detectionEnabled ? replyFindings.length === 0 : true,
    detail: detectionEnabled
      ? (replyFindings.length === 0 ? '回复与产物未出现夹具外金额/日期' : `虚构命中：${formatFindings(replyFindings)}`)
      : '虚构检测已关闭（仅反向绊线用；模型能力栏仍独立判）',
  });

  // ⑥ 产物（若有）逐格正确或诚实为空。
  const artifactProblems: string[] = [];
  const honestCannot = isHonestCannot(sample.replyText);
  for (const artifact of sample.artifacts) {
    if (artifact.kind === 'correct') continue;
    if (artifact.kind === 'empty') {
      if (honestCannot && replyFindings.length === 0) continue;
      artifactProblems.push(`「${artifact.filename}」空产物但回复未如实说明读不出`);
      continue;
    }
    artifactProblems.push(`「${artifact.filename}」${artifact.kind}：${artifact.problems.join('；')}`);
  }
  checks.push({
    name: 'host-artifact-correct-or-honest-empty',
    pass: artifactProblems.length === 0,
    detail: sample.artifacts.length === 0
      ? '无产物（按诚实为空路径处理；是否假成功由下一条判）'
      : (artifactProblems.length === 0 ? `全部 ${sample.artifacts.length} 个产物合格` : artifactProblems.join('；')),
  });

  // ⑦ 零交付时不得声称已发回/已生成附件（假成功）。
  checks.push({
    name: 'host-no-false-success',
    pass: sample.deliveries.length > 0 || !claimsDelivered(sample.replyText),
    detail: sample.deliveries.length > 0
      ? `已交付 ${sample.deliveries.length} 个文件`
      : `零交付；回复=${JSON.stringify(sample.replyText.slice(0, 200))}`,
  });

  // ⑧ 交付面与登记一致：每个交付文件 sha+name 对回 file_refs；sent 事实只在真交付时出现。
  const deliveryProblems: string[] = [];
  const rowIdsByShaName = new Set(
    sample.registration.rows.map((row) => `${row.sha256}\u0000${row.name}`),
  );
  for (const delivered of sample.deliveries) {
    if (!rowIdsByShaName.has(`${delivered.sha256}\u0000${delivered.filename}`)) {
      deliveryProblems.push(`交付「${delivered.filename}」(${delivered.sha256.slice(0, 12)}…) 在 file_refs 无对应登记行`);
    }
    if (sample.conversationId !== undefined && delivered.conversationId !== undefined
      && delivered.conversationId !== sample.conversationId) {
      deliveryProblems.push(`交付会话 ${delivered.conversationId} ≠ 入站会话 ${sample.conversationId}`);
    }
    if (sample.channel !== undefined && delivered.channel !== undefined && delivered.channel !== sample.channel) {
      deliveryProblems.push(`交付渠道 ${delivered.channel} ≠ 入站渠道 ${sample.channel}`);
    }
  }
  if (sample.deliveries.length > 0) {
    if (sample.deliveryFact.status !== 'sent') {
      deliveryProblems.push(`有交付但 message_done.fileDelivery=${JSON.stringify(sample.deliveryFact)}`);
    }
    if (sample.deliveryFact.files !== undefined && sample.deliveryFact.files !== sample.deliveries.length) {
      deliveryProblems.push(`fileDelivery.files=${sample.deliveryFact.files} ≠ 端口收到 ${sample.deliveries.length}`);
    }
    const failed = sample.deliveryEvents.filter((status) => status !== 'sent');
    if (failed.length > 0) deliveryProblems.push(`交付事件含非 sent 状态：${JSON.stringify(failed)}`);
  } else {
    if (sample.deliveryFact.status !== undefined) {
      deliveryProblems.push(`零交付但有 message_done.fileDelivery=${JSON.stringify(sample.deliveryFact)}`);
    }
    if (sample.deliveryEvents.includes('sent')) {
      deliveryProblems.push('零交付但存在 file_delivery sent 记录');
    }
  }
  checks.push({
    name: 'host-delivery-consistent',
    pass: deliveryProblems.length === 0,
    detail: deliveryProblems.length === 0
      ? `交付=${sample.deliveries.length}；fileDelivery=${JSON.stringify(sample.deliveryFact)}；事件=${JSON.stringify(sample.deliveryEvents)}`
      : deliveryProblems.join('；'),
  });

  return { status: checks.every((check) => check.pass) ? 'pass' : 'fail', checks };
}

// ── 模型能力栏 ──────────────────────────────────────────────────────────────

function judgeModelCapability(sample: JudgeSample): ModelVerdict {
  const fabricated = [
    ...findFabricatedFacts(sample.replyText, sample.facts, 'reply'),
    ...sample.artifacts.flatMap((artifact) => findFabricatedFacts(artifact.text, sample.facts, `artifact:${artifact.filename}`)),
  ];
  if (fabricated.length > 0) {
    return {
      reading: 'fabricated',
      status: 'red',
      detail: `用户可见面出现夹具外金额/日期：${formatFindings(fabricated)}`,
      correctFacts: [],
      fabricated,
      honestCannotClaim: isHonestCannot(sample.replyText),
    };
  }

  const surfaces: Array<{ name: string; text: string }> = [
    { name: 'reply', text: sample.replyText },
    ...sample.artifacts.map((artifact) => ({ name: `artifact:${artifact.filename}`, text: artifact.text })),
    ...(sample.toolResultText === undefined ? [] : [{ name: 'tool-results', text: sample.toolResultText }]),
  ];
  const factsSeen: string[] = [];
  const surfacesWithFacts: string[] = [];
  for (const surface of surfaces) {
    const names = correctFactNames(surface.text, sample.facts);
    if (names.length === 0) continue;
    surfacesWithFacts.push(`${surface.name}:${names.join('+')}`);
    for (const name of names) if (!factsSeen.includes(name)) factsSeen.push(name);
  }
  const hasDate = factsSeen.includes('date');
  const hasAmount = factsSeen.includes('amount');
  const honestClaim = isHonestCannot(sample.replyText);

  if (hasDate && hasAmount) {
    return {
      reading: 'read',
      status: 'green',
      detail: `读到日期+金额（证据面：${surfacesWithFacts.join('；')}）`,
      correctFacts: factsSeen,
      fabricated: [],
      honestCannotClaim: honestClaim,
    };
  }
  if (hasDate || hasAmount) {
    return {
      reading: 'partial-read',
      status: 'green',
      detail: `只读到 ${factsSeen.join('+')}，缺 ${hasDate ? '金额' : '日期'}（证据面：${surfacesWithFacts.join('；')}）`,
      correctFacts: factsSeen,
      fabricated: [],
      honestCannotClaim: honestClaim,
    };
  }
  if (honestClaim) {
    return {
      reading: 'honest-cannot',
      status: 'green',
      detail: '回复明确说明读不出/看不懂；没有出现夹具外金额或日期',
      correctFacts: [],
      fabricated: [],
      honestCannotClaim: true,
    };
  }
  return {
    reading: 'vague',
    status: 'amber',
    detail: '既没有读到夹具事实，也没有明确说明读不出——按含糊记录，不冒充通过',
    correctFacts: [],
    fabricated: [],
    honestCannotClaim: false,
  };
}

/** 两栏合判：宿主必须绿；模型栏 red 也整体 fail（amber 只记录）。 */
export function judgeR2d(sample: JudgeSample): JudgeResult {
  const host = judgeHost(sample);
  const model = judgeModelCapability(sample);
  return {
    host,
    model,
    verdict: host.status === 'pass' && model.status !== 'red' ? 'pass' : 'fail',
  };
}
