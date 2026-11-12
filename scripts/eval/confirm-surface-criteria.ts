/**
 * S2 判据量具：确认面「业务可评估」的机械判定（issue #50 用例2）。
 *
 * 判据原文（逐条照抄，不许放宽）：
 *   构造：任意需要用户确认的计划。
 *   断言：确认文本不含执行层词汇；必含业务范围、业务后果、可选项。
 *   机械判据：executionLanguageFingerprints 五类指纹（脚本路径/错误码/JSON 片段/operation 名/
 *   内部控制词）零命中 + 三个必填字段在场。
 *   已裁定的设计要点：范围块由宿主渲染（计划是结构化事实），模型只能写后果叙述，不能改范围块
 *   ——否则模型可以用措辞把范围说宽。
 *
 * 「三个必填字段在场」怎么机械化（字段是设计的一部分，判据是它的机械影子）：
 *   · 业务范围 = 确认面上有一个**范围段**（字段标记见 DEFAULT_FIELD_MARKERS.scope），段里
 *     只有平台数据：平台清单第 5 列给这次 operation 的业务名（+ 宿主从结构化事实里抽出的
 *     声明值）。段里**不许出现模型叙述**——叙述进了范围段就是把措辞混进范围。
 *   · 业务后果 = 有一个**后果段**，段里带着本回合的模型叙述（宿主不能用自己的话顶掉它；
 *     按删除集整理过算带上——判据要的是叙述里 ≥12 字的连续片段原样在场，见 carriesNarrative）。
 *   · 可选项   = 继续与取消**两条**答复都在文本里，且文本里给用户的回复指令都落在宿主
 *     接受的答复词表内（见 HOST_ACCEPTED_REPLIES）。这一条刻意不要求字段标记：可选项的
 *     实质是"用户有路可走"，不是"有个小标题"。
 * 另两条判据来自同两条裁定的机械影子：
 *   · 范围不随措辞改变（scopeInvariance）：同一份计划换不同后果叙述，**范围段逐字节相同**
 *     （≥2 条不同的叙述且都带上才算判过；范围段不在时记「前提缺席」，不计通过）。
 *   · 业务措辞出处（businessWordingSource）：宿主渲染的那部分（删掉模型叙述后的骨架）里的
 *     业务词只能来自平台数据（第 5 列名 / 结构化取值），宿主模板自带业务词即违例；也不许
 *     拿同一份清单里**别的** operation 的名字凑。模型叙述自己的业务措辞不算宿主模板的账。
 *
 * 为什么范围/后果用字段标记而不是自由文本里找词：裁定要防的是「模型用措辞把范围说宽」。
 * 没有段边界，"叙述被塞进范围里"与"叙述另起一段"在文本上不可分——迁就自由文本的判据会
 * 放走这个形态（标定测试里 narrativeAppendedToScope 突变就是它）。标记由用例声明
 * （DEFAULT_FIELD_MARKERS 是缺省形态），判据输出会写明命中的是哪个标记。
 *
 * 尺子出处（刻意各自持有、不共享实现，与 execution-language-eval 同一条纪律：
 * 宿主检测器有假阴性时评测继承同一个假阴性，永远发现不了）：
 *   · 执行语言五类指纹 —— 复用 scripts/eval/execution-language-eval.ts（判据原文点名）；
 *     本模块不复制第二份实现。
 *   · 业务词词表 —— 与 packages/agent/platform-leak-lint.test.ts:152 的 BUSINESS_WORD_RE
 *     同义（应收/凭证/科目/账套/期间/目录/税号/财务/借贷/余额/往来/时间范围/记录/档案/摸底）；
 *     本模块持有一份**判定用**副本（只判"文本里的业务词有没有平台出处"，不做源码预算），
 *     漂移由 confirm-surface-criteria.test.ts 的漂移锁逐词比对，不靠人记。
 *   · 宿主接受的答复词表 —— 出处 packages/agent/src/plan-confirmation.ts 的 classifyAnswer
 *     （确认臂/取消臂两行）；同样由漂移锁比对。
 *
 * 本模块是**纯函数量具**：不 spawn、不读文件、不连网；输入是「一次确认渲染出来的文本 +
 * 这次渲染的输入事实」，输出是逐条判据。谁来渲染（生产路径还是对照组）不在本模块里决定。
 */
import { executionLanguageFingerprints } from './execution-language-eval';

/**
 * 宿主接受的「确认继续」答复（plan-confirmation.ts 的 classifyAnswer 确认臂）。
 * 大小写/空白/标点由 classifyAnswer 自行归一，这里只持词形。
 */
export const HOST_ACCEPTED_REPLIES: { readonly confirm: readonly string[]; readonly cancel: readonly string[] } = {
  confirm: ['确认继续', '确认', '同意', '继续', '可以继续', '按这个方案'],
  cancel: ['取消', '不继续', '停止', '先不做'],
};

/**
 * 业务词词表（判定用副本；出处 platform-leak-lint.test.ts:152 的 BUSINESS_WORD_RE）。
 * 收词纪律与那份一致：按「领域概念」收，不按"最显而易见的词"——伪装形（时间范围→期间、
 * 记录/档案→凭证）也在表内。命中即要求它有平台出处（第 5 列 label / 结构化取值），否则违例。
 */
export const CONFIRM_SURFACE_BUSINESS_WORDS: readonly string[] = [
  '应收', '凭证', '科目', '账套', '期间', '目录', '税号', '财务', '借贷', '余额', '往来',
  '时间范围', '记录', '档案', '摸底',
];

/** 命中的业务词（按词表顺序去重）。 */
export function businessWordHits(text: string): string[] {
  return CONFIRM_SURFACE_BUSINESS_WORDS.filter((word) => text.includes(word));
}

/** 三个必填字段的标记形态（范围/后果由用例声明；可选项不要求标记，见文件头注释）。 */
export interface ConfirmSurfaceFieldMarkers {
  scope: RegExp;
  consequence: RegExp;
}

/**
 * 缺省标记形态。容忍度是刻意给的：前缀修饰（业务/本次/执行）与中英文冒号都收，
 * 但不收"没有段标记"的自由文本——段边界是判据的前提，不是措辞偏好。
 */
export const DEFAULT_FIELD_MARKERS: ConfirmSurfaceFieldMarkers = {
  scope: /(?:业务|本次|执行|计划)?范围\s*[:：]/g,
  consequence: /(?:业务)?(?:后果|影响)\s*[:：]/g,
};

/** 这次渲染的输入事实（宿主机械事实 + 本回合的模型叙述）。 */
export interface ConfirmSurfaceFacts {
  /**
   * 计划里被调用的 operation 的平台清单第 5 列名（业务措辞的**唯一**合法来源）。
   * 平台没起名（label 缺失）时可以为空数组——那是安全缺省，不是违例。
   */
  labels: readonly string[];
  /**
   * 同一份清单里**别的** operation 的名字：出现在宿主渲染部分即「拿邻居名字凑」的回退，
   * 与"业务措辞只能由第 5 列提供"冲突（第 5 列是**这次** operation 的那一行）。
   */
  otherLabels: readonly string[];
  /** 宿主从结构化事实里抽出的声明值（planCallFacts 的 scopeValues；没有就是空）。 */
  values: readonly string[];
}

/** 一次渲染：宿主交到用户手上的那一整条确认文本 + 这次渲染注入的模型后果叙述。 */
export interface ConfirmSurfaceRendering {
  /** 本回合模型给出的后果叙述（空串 = 本回合没有模型叙述）。 */
  narrative: string;
  /** 用户会看到的确认文本（宿主渲染的完整帧）。 */
  text: string;
}

export interface ConfirmSurfaceScenario {
  facts: ConfirmSurfaceFacts;
  /** 同一份计划、不同后果叙述的多次渲染（≥2 条才能判「措辞不改范围」）。 */
  renderings: readonly ConfirmSurfaceRendering[];
  /** 字段标记（缺省 DEFAULT_FIELD_MARKERS）。 */
  markers?: ConfirmSurfaceFieldMarkers;
}

export type ConfirmSurfaceCriterion =
  | 'executionLanguage'
  | 'businessScope'
  | 'businessConsequence'
  | 'options'
  | 'scopeInvariance'
  | 'businessWordingSource';

export interface ConfirmSurfaceCriterionResult {
  ok: boolean;
  /**
   * 判据真的判过没有。false = 前提缺席（例如叙述根本没进确认面，无法检验措辞能否改范围）
   * ——此时 ok 恒假、不计通过：**绿必须是判出来的**。
   */
  checked: boolean;
  /** 可行动的一句话：缺什么、在哪条渲染上缺。 */
  detail: string;
}

export interface ConfirmSurfaceVerdict {
  /** 全部判据 ok 且 checked 才为 true。 */
  ok: boolean;
  criteria: Record<ConfirmSurfaceCriterion, ConfirmSurfaceCriterionResult>;
  /** 人可读逐条输出（红就是这几行）。 */
  findings: string[];
}

/** 判据表序（findings 与报告的稳定顺序）。 */
export const CONFIRM_SURFACE_CRITERIA: readonly ConfirmSurfaceCriterion[] = [
  'executionLanguage',
  'businessScope',
  'businessConsequence',
  'options',
  'scopeInvariance',
  'businessWordingSource',
];

/** 判据标签（人读措辞，与判据原文的字段名对齐）。 */
export const CONFIRM_SURFACE_CRITERION_LABELS: Readonly<Record<ConfirmSurfaceCriterion, string>> = {
  executionLanguage: '不含执行层词汇（五类指纹零命中）',
  businessScope: '必含业务范围（宿主渲染的范围段）',
  businessConsequence: '必含业务后果（模型叙述进后果段）',
  options: '必含可选项（继续与取消两条答复都在）',
  scopeInvariance: '范围段不随模型措辞改变',
  businessWordingSource: '业务措辞只来自平台清单第 5 列',
};

/** 一次切段的结果：字段名 → 该字段的段文本（含标记）。 */
type Segments = Map<string, string>;

function markersOf(scenario: ConfirmSurfaceScenario): Required<ConfirmSurfaceFieldMarkers> {
  return {
    scope: scenario.markers?.scope ?? DEFAULT_FIELD_MARKERS.scope,
    consequence: scenario.markers?.consequence ?? DEFAULT_FIELD_MARKERS.consequence,
  };
}

/**
 * 按声明标记切段：标记起点到下一个标记起点（或文本末）之间就是该字段。
 * 同一字段多次出现只收第一段（多段=实现细节，不是判据要管的事）。
 */
function segmentsOf(text: string, markers: Required<ConfirmSurfaceFieldMarkers>): Segments {
  const found: Array<{ field: string; start: number; end: number }> = [];
  for (const [field, pattern] of Object.entries(markers)) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      if (match.index === undefined) continue;
      found.push({ field, start: match.index, end: match.index + match[0].length });
      break;
    }
  }
  found.sort((a, b) => a.start - b.start);
  const segments: Segments = new Map();
  for (const [index, boundary] of found.entries()) {
    const next = found[index + 1];
    const segment = text.slice(boundary.start, next ? next.start : text.length).trim();
    if (!segments.has(boundary.field)) segments.set(boundary.field, segment);
  }
  return segments;
}

/**
 * 宿主骨架：把模型叙述整段从确认文本里删掉之后剩下的部分（业务措辞出处的判定面）。
 * 范围段/后果段的判定不用它——那两处用段边界（见文件头注释）。
 */
export function hostSkeleton(rendering: ConfirmSurfaceRendering): string {
  if (!rendering.narrative) return rendering.text;
  return rendering.text.split(rendering.narrative).join('');
}

function judgeExecutionLanguage(scenario: ConfirmSurfaceScenario): ConfirmSurfaceCriterionResult {
  // 判据判的是**用户会看到的那条文本**（断言原文："确认文本不含执行层词汇"）。
  // 模型叙述自己的执行语言单列成附注：它离上屏只有一次拼接的距离，宿主必须把它删干净；
  // 删干净了就不算确认面的账（否则这条判据会把模型的坏习惯记到宿主头上，下一轮改不动）。
  const hits = new Set<string>();
  const narrativeNotes = new Set<string>();
  for (const rendering of scenario.renderings) {
    for (const label of executionLanguageFingerprints(rendering.text)) hits.add(`文本:${label}`);
    for (const label of executionLanguageFingerprints(rendering.narrative)) narrativeNotes.add(label);
  }
  const note = narrativeNotes.size > 0 ? `（另注：模型叙述自带 ${[...narrativeNotes].sort().join('、')}——宿主已删干净才没有上屏）` : '';
  if (hits.size === 0) {
    return { ok: true, checked: true, detail: `五类指纹（脚本路径/错误码/JSON 片段/operation 名/内部控制词）零命中${note}` };
  }
  return { ok: false, checked: true, detail: `执行语言上屏：${[...hits].sort().join('、')}${note}` };
}

/**
 * 后果段的实质判据：模型叙述里有 CONSEQUENCE_MIN_RUN 个字的连续片段原样上了屏。
 *
 * 为什么不要求逐字节相同：宿主完全可能按删除集整理叙述（删掉一个错误码/脚本路径），
 * 那正是出口整理该做的事——逐字节相同会把"整理过"判成"改写"，变成假红。
 * 为什么仍要求连续片段：这条判据要挡的是"宿主用自己的固定一句话把模型后果顶掉"
 * （用户看不到这次操作到底会带来什么），而不是删了几个字符。中文 12 字是一句子句的量级：
 * 换一句话替代 = 没有一个 12 字窗口能对上。
 */
const CONSEQUENCE_MIN_RUN = 12;

function carriesNarrative(segment: string, narrative: string): boolean {
  const text = narrative.trim();
  if (text === '') return false;
  if (segment.includes(text)) return true;
  const run = Math.min(CONSEQUENCE_MIN_RUN, text.length);
  for (let start = 0; start + run <= text.length; start += 1) {
    if (segment.includes(text.slice(start, start + run))) return true;
  }
  return false;
}

function judgeBusinessScope(scenario: ConfirmSurfaceScenario): ConfirmSurfaceCriterionResult {
  const { labels, values } = scenario.facts;
  if (labels.length === 0 && values.length === 0) {
    return {
      ok: false,
      checked: false,
      detail: '前提缺席：平台清单没有给这次 operation 第 5 列名，也没有声明取值——范围无从判（安全缺省不等于范围在场）',
    };
  }
  const markers = markersOf(scenario);
  const problems: string[] = [];
  for (const [index, rendering] of scenario.renderings.entries()) {
    const segments = segmentsOf(rendering.text, markers);
    const scope = segments.get('scope');
    if (!scope) {
      problems.push(`渲染${index + 1} 没有范围段（要有一个形如「范围：…」的字段，标记形态 ${describeMarker(markers.scope)}；段里由宿主写平台业务名）`);
      continue;
    }
    for (const label of labels) {
      if (!scope.includes(label)) problems.push(`渲染${index + 1} 范围段缺平台业务名「${label}」（段原文「${truncate(scope)}」）`);
    }
    for (const value of values) {
      if (!scope.includes(value)) problems.push(`渲染${index + 1} 范围段缺结构化取值「${value}」`);
    }
    if (rendering.narrative && scope.includes(rendering.narrative)) {
      problems.push(`渲染${index + 1} 范围段里出现模型叙述——措辞混进范围（段原文「${truncate(scope)}」）`);
    }
  }
  if (problems.length === 0) {
    const named = [...labels, ...values].map((item) => `「${item}」`).join('、');
    return { ok: true, checked: true, detail: `范围段由宿主渲染：段内含业务范围事实 ${named}，无模型叙述` };
  }
  return { ok: false, checked: true, detail: problems.join('；') };
}

function judgeBusinessConsequence(scenario: ConfirmSurfaceScenario): ConfirmSurfaceCriterionResult {
  const spoken = scenario.renderings.filter((rendering) => rendering.narrative.trim() !== '');
  if (spoken.length === 0) {
    return { ok: false, checked: false, detail: '前提缺席：本场景没有模型后果叙述可判' };
  }
  const markers = markersOf(scenario);
  const problems: string[] = [];
  for (const [index, rendering] of scenario.renderings.entries()) {
    if (rendering.narrative.trim() === '') continue;
    const segments = segmentsOf(rendering.text, markers);
    const consequence = segments.get('consequence');
    if (!consequence) {
      problems.push(`渲染${index + 1} 没有后果段（要有一个形如「后果：…」的字段，标记形态 ${describeMarker(markers.consequence)}；段里原样带模型叙述）`);
      continue;
    }
    if (!carriesNarrative(consequence, rendering.narrative)) {
      problems.push(`渲染${index + 1} 后果段没有带上模型叙述（宿主用自己的话顶掉了，或整段吞掉了；判据要的是叙述里 ≥${CONSEQUENCE_MIN_RUN} 字的连续片段原样在场）：「${truncate(rendering.narrative)}」`);
    }
  }
  if (problems.length === 0) {
    return { ok: true, checked: true, detail: `模型后果叙述在后果段原样上屏（${spoken.length} 条渲染逐条核过）` };
  }
  return { ok: false, checked: true, detail: problems.join('；') };
}

/** 文本里给用户的回复指令（「回复“X”」形态）：指令必须落在宿主接受的答复词表内。 */
function quotedReplyInstructions(text: string): string[] {
  const instructions: string[] = [];
  for (const match of text.matchAll(/回复\s*[“"「『]\s*([^”"」』]{1,20}?)\s*[”"」』]/g)) {
    const token = match[1];
    if (token) instructions.push(token.trim());
  }
  return instructions;
}

function judgeOptions(scenario: ConfirmSurfaceScenario): ConfirmSurfaceCriterionResult {
  const confirmCue = HOST_ACCEPTED_REPLIES.confirm.find((reply) =>
    scenario.renderings.some((rendering) => rendering.text.includes(reply)));
  const cancelCue = HOST_ACCEPTED_REPLIES.cancel.find((reply) =>
    scenario.renderings.some((rendering) => rendering.text.includes(reply)));
  const badInstructions = new Set<string>();
  const accepted = new Set([...HOST_ACCEPTED_REPLIES.confirm, ...HOST_ACCEPTED_REPLIES.cancel]);
  for (const rendering of scenario.renderings) {
    for (const instruction of quotedReplyInstructions(rendering.text)) {
      if (!accepted.has(instruction)) badInstructions.add(instruction);
    }
  }
  const problems: string[] = [];
  if (!confirmCue) problems.push(`没有继续路径（宿主接受的答复：${HOST_ACCEPTED_REPLIES.confirm.join('/')}）`);
  if (!cancelCue) problems.push(`没有取消路径（宿主接受的答复：${HOST_ACCEPTED_REPLIES.cancel.join('/')}）`);
  if (badInstructions.size > 0) problems.push(`给了宿主不接受的答复指令：${[...badInstructions].map((item) => `“${item}”`).join('、')}（死路指令）`);
  if (problems.length === 0) {
    return { ok: true, checked: true, detail: `可选项在场：继续「${confirmCue}」/ 取消「${cancelCue}」，回复指令全在宿主答复词表内` };
  }
  return { ok: false, checked: true, detail: problems.join('；') };
}

function judgeScopeInvariance(scenario: ConfirmSurfaceScenario): ConfirmSurfaceCriterionResult {
  const spoken = scenario.renderings.filter((rendering) => rendering.narrative.trim() !== '');
  const distinct = new Set(spoken.map((rendering) => rendering.narrative));
  if (spoken.length < 2 || distinct.size < 2) {
    return { ok: false, checked: false, detail: '前提缺席：不足两条不同的后果叙述，无法检验措辞能否改范围' };
  }
  const markers = markersOf(scenario);
  const uncarried = spoken.filter((rendering) => !carriesNarrative(rendering.text, rendering.narrative));
  if (uncarried.length > 0) {
    return {
      ok: false,
      checked: false,
      detail: '前提缺席：后果叙述没进确认面（叙述不在文本里，措辞与范围段的关系无从检验）——先让后果字段在场',
    };
  }
  const scopes = spoken.map((rendering) => segmentsOf(rendering.text, markers).get('scope') ?? null);
  if (scopes.some((scope) => scope === null)) {
    return {
      ok: false,
      checked: false,
      detail: '前提缺席：范围段不在确认面上（业务范围判据已红）——"段不变"无从谈起',
    };
  }
  const first = scopes[0] ?? '';
  const differing = scopes.filter((scope) => scope !== first).length;
  if (differing === 0) {
    return { ok: true, checked: true, detail: `换 ${distinct.size} 条后果叙述，范围段逐字节相同（措辞改不了范围）` };
  }
  return {
    ok: false,
    checked: true,
    detail: `换叙述之后范围段变了 ${differing} 次——模型措辞能进范围段（正是裁定要防的"用措辞把范围说宽"）；首段「${truncate(first)}」`,
  };
}

function judgeBusinessWordingSource(scenario: ConfirmSurfaceScenario): ConfirmSurfaceCriterionResult {
  const allowed = new Set([...scenario.facts.labels, ...scenario.facts.values]);
  const problems = new Set<string>();
  for (const [index, rendering] of scenario.renderings.entries()) {
    const skeleton = hostSkeleton(rendering);
    for (const hit of businessWordHits(skeleton)) {
      if ([...allowed].some((item) => item.includes(hit))) continue;
      problems.add(`渲染${index + 1} 宿主渲染部分出现平台数据之外的业务词「${hit}」（模板自带的业务措辞）`);
    }
    for (const neighbour of scenario.facts.otherLabels) {
      if (!neighbour) continue;
      if (skeleton.includes(neighbour)) problems.add(`渲染${index + 1} 宿主渲染部分出现别的 operation 的平台名「${neighbour}」`);
    }
  }
  if (problems.size === 0) {
    return {
      ok: true,
      checked: true,
      detail: `宿主渲染部分的业务词都有平台出处（第 5 列名：${scenario.facts.labels.length > 0 ? scenario.facts.labels.map((item) => `「${item}」`).join('、') : '无'}）`,
    };
  }
  return { ok: false, checked: true, detail: [...problems].join('；') };
}

function truncate(text: string, max = 32): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 标记形态的人读描述（失败消息里给"要长成什么样"）。 */
function describeMarker(pattern: RegExp): string {
  return `/${pattern.source}/`;
}

/**
 * 判一条确认面场景。纯函数；所有判据都从渲染出来的文本 + 输入事实机械推出，
 * 不读生产代码、不猜实现。
 */
export function judgeConfirmSurface(scenario: ConfirmSurfaceScenario): ConfirmSurfaceVerdict {
  const criteria: Record<ConfirmSurfaceCriterion, ConfirmSurfaceCriterionResult> = {
    executionLanguage: judgeExecutionLanguage(scenario),
    businessScope: judgeBusinessScope(scenario),
    businessConsequence: judgeBusinessConsequence(scenario),
    options: judgeOptions(scenario),
    scopeInvariance: judgeScopeInvariance(scenario),
    businessWordingSource: judgeBusinessWordingSource(scenario),
  };
  const findings = CONFIRM_SURFACE_CRITERIA.map((criterion) => {
    const result = criteria[criterion];
    const mark = result.ok ? 'PASS' : result.checked ? 'FAIL' : 'NOT-JUDGED';
    return `[${mark}] ${CONFIRM_SURFACE_CRITERION_LABELS[criterion]} —— ${result.detail}`;
  });
  const ok = CONFIRM_SURFACE_CRITERIA.every((criterion) => criteria[criterion].ok && criteria[criterion].checked);
  return { ok, criteria, findings };
}

/**
 * 判据输出的稳定文本（红/绿两种都原样可读；用例与独立 runner 共用同一份格式化，
 * 不各自拼一份）。
 */
export function formatConfirmSurfaceVerdict(verdict: ConfirmSurfaceVerdict): string {
  return [`确认面判据：${verdict.ok ? 'PASS' : 'FAIL'}`, ...verdict.findings].join('\n');
}
