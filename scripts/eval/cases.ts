import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

/**
 * 评测用例语料加载器（issue 切片 C）：scripts/eval/cases.yaml 是**唯一**用例数据源。
 *
 * 本模块只做「读 + 校验 + 定型」，不做判定：
 *   · 判定逻辑（note 生成）在 scripts/probe-real-agent.ts 的用例体里；
 *   · 期望值判定在 scripts/eval/expectations.ts（第四层，与三层既有判据并列）；
 *   · 语料元数据（incidents / expect / inBaseline）原住 corpus.jsonl，已并进 yaml
 *     （score.ts 的 loadCorpus 改读本模块的 toCorpusEntries）。
 *
 * 纪律：期望值只活在判定层。本模块导出的任何字段都不得进喂给模型的 prompt /
 * system prompt / skill——ask-session.ts 只把用户文本逐字放进 IncomingChannelMessage.text。
 */

export type TaskId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export type TurnMark = 'past' | 'recall' | 'requery' | 'landing' | 'reasoning' | 'summary';

/** 一条用户消息（含轮次行为标记与澄清/选择等结构性标注）。 */
export interface CaseMessage {
  /** acceptance 用例 id（5.1 等）；probe 条目无此字段。 */
  id?: string;
  /** 用户消息原文。confirmOf 行没有 text——文本由 acceptance 侧从被引用回复提码生成。 */
  text?: string;
  /** acceptance：从被引用用例的回复提取确认码，自动发「确认 <code>」。 */
  confirmOf?: string;
  confirmAction?: 'confirm' | 'cancel';
  /** acceptance：2.2 这类依赖上一条回复澄清候选的用例。 */
  followUpOf?: string;
  /** 该轮话题涉及的任务线程（空 = 闲聊/汇总/目标未明的探索轮）。 */
  tasks?: TaskId[];
  /** 轮次行为标记（期望值层与探针判定共用同一份标记，不另起一份）。 */
  marks?: TurnMark[];
  /** 条件发送：clarified（X1 歧义澄清后的分支）/ pausePrompted（D2、Z1 的确认门分支）。 */
  when?: string;
  chitchat?: boolean;
  /** 歧义澄清轮的候选清单（空数组 = not_found 轮）。 */
  clarify?: string[];
  /** 澄清后选择轮的期望落点。 */
  select?: string;
  /** 跨轮 collection 名单召回轮（C2 第 19 轮）。 */
  rosterRecall?: boolean;
  notFound?: boolean;
  writeAttempt?: boolean;
  writeProposal?: boolean;
  offTopic?: boolean;
  readback?: boolean;
  /** 平台缺失的口径（Y2 第 3 轮 payable）。 */
  missingCaliber?: string;
}

export interface AllowedWrite {
  collection: string;
  window: string;
  records: Array<{ name: string; value: number }>;
}

export interface CaseSpec {
  id: string;
  group: string;
  kind: 'probe' | 'acceptance';
  /** acceptance 会话 id（spec.conv，如 acc-write-51）。 */
  conversation?: string;
  inBaseline: boolean;
  /**
   * 期望值未进机器判定层的条目。语义 = 「这条用例的 expectations 还没审计成结构化断言」，
   * **不等于**「这条用例没审计过」——prose 层的 businessGoal / checks / expect 可以已经
   * 完整（Q5b/Q13b 就是：判据原文齐全，但需要真平台税类数据，仓内夹具跑不出来）。
   * 因此每个占位条目必须用 `blocker` 声明它卡在哪，而不是靠 expect 里 grep 一个词。
   */
  placeholder?: boolean;
  /** 占位条目卡在哪：必填（切片 E 未审计 / 能力未落地 / 需真平台数据…）。 */
  blocker?: string;
  incidents: string[];
  intent: string;
  businessGoal: string;
  fixture: {
    name: string;
    isolation: string;
    env: Record<string, string>;
    note?: string;
  };
  allowedSideEffects: {
    writableCollections: string[];
    writes: AllowedWrite[];
    note?: string;
  };
  /** 该用例跑的机械检查（探针 note 生成器 + 期望值层Assertion 名）。 */
  checks: string[];
  messages: CaseMessage[];
  followUps?: CaseMessage[];
  expectations: CaseExpectations | null;
  /** 人类可读的期望（语料 expect 字段，评委输入也用这一份）。 */
  expect: string;
}

// ── 期望值（结构化，只被 expectations.ts 读）──

export interface ShortCaseTurnExpectation {
  /** 0-based 轮下标。 */
  index: number;
  /** 必须出现的 collection 全名（实体完整提及，不带尾随连字符）。 */
  collections?: string[];
  forbidCollections?: string[];
  /** 必须出现的数值（夹具种子真值）。 */
  requireValues?: number[];
  /** 不得出现的数值（旧 collection 渗入 / 错误态编造）。 */
  forbidValues?: number[];
  /** 条数（记录条数期望）。 */
  count?: number;
  /** 必须是澄清问句形态。 */
  question?: boolean;
  /** 必须给 not_found 结论。 */
  notFound?: boolean;
  /** 必须说明该 window 无数据。 */
  windowNoData?: string;
  /** 与另一轮的金额签名完全一致。 */
  sameValueSetAs?: number;
  /** 复述旧结果须带框定语。 */
  framing?: boolean;
  /** 必须给出 6 位确认码。 */
  confirmCode?: boolean;
  /** 不得把该口径当答案口径答出数。 */
  missingCaliber?: string;
  forbidCaliberValues?: number[];
  /**
   * 实体键归属（2026-11-09 修复单 1/2；仲裁 2 改登记制）：判定消费 amount-criteria 的
   * `classifyErrorStateAmounts` 产物 `verdict.misattributed`（不重造绑定逻辑），非空即红。
   * `misattributed` 是**硬失败归属信号**（misbinding），不是"点名实体值集 ⊆ 真实值集"的
   * 字面检查：
   *   · 包含"把金额挂给别的实体/window"与"挂给零值实体"两类——后者是**已登记的不存在
   *     对象**（用例查询过、平台答过 not_found 的 gamma-collection）与空集合 empty-one；
   *   · 包含 window×实体无效的绑定（"beta W2 … 500"）；
   *   · **不含**算术派生（如行内明细 500+300+200 的合计 1000）——明细列总计改绑所属
   *     collection，按所绑实体全额验，落 derived；
   *   · **不含**未登记的凭空名字（"foo-item-1 … 500"）的**最近前置绑定**——没有外部
   *     事实可对，机械层不猜；但正文用显式归属措辞挂给它时，`unregisteredAttribution`
   *     单列硬失败（audited 申报块核不到"挂给谁"），期望值层同样消费这一维。
   *
   * 考什么：回复把哪个金额挂给了哪个实体——"beta-item-1 … 500" 合法，"alpha-item-1 … 500"
   * （500 是 beta 的真值）、"gamma-collection … 500"（平台答过不存在）都是假归属。
   * 事实来源：夹具的记录归属（dummy-fixture 的 ENTITY_REAL_VALUES / MOCK_ITEM_VALUES /
   * MOCK_ITEM_ID_BINDINGS / MOCK_ABSENT_COLLECTIONS，逐条抄自夹具种子或用例查询事实）
   * ——模型之外的事实，可对。事实表只属于 dummy-platform：expectedCheck 在 fixture.name
   * 不是 dummy-platform 时出红（不能拿 dummy 的值去核另一个夹具的回复）。
   * 与 `missingCaliber` 正交：口径绑定判"编了哪个口径"，本条判"数挂给了谁"；错误态轮
   * 两样都该核（Y2 第 3 轮同开两个键）。申报块的引用行洗不掉它（见 declaredExempt）。
   */
  entityAttribution?: boolean;
  noticesAtLeast?: number;
  minExecutedCalls?: number;
}

export interface ThreadTruth {
  collection: string;
  values: number[];
}

export interface RecallExpectation {
  turn: number;
  thread: TaskId;
  requireValues: number[];
  /** 召回该线程时不得出现的其它线程（即使那些值都在全会话允许池里）。 */
  forbidThreads: TaskId[];
}

export interface SelectExpectation {
  turn: number;
  collection: string;
}

export interface SummaryExpectation {
  turn: number;
  requireThreads: TaskId[];
  minCollections: number;
  allowedValues: number[];
}

export interface InvariantExpectation {
  /** 每轮都必须有已执行平台调用（重查轮的机械面）。 */
  requeryPerTurn?: number[];
  /** 闲聊轮零平台调用。 */
  chitchatZeroCalls?: number[];
  /** 该轮不得出现任何非零金额（not_found / 错误态轮）。 */
  notFoundZeroAmounts?: number;
  /** 写尝试轮零已执行写调用。 */
  writeAttemptZeroExecutedWrites?: number;
  /** 门禁时序：确认前零已执行写调用。 */
  gateOrder?: { confirmTurn: number; forbidExecutedWriteBeforeConfirm: boolean };
  /** 无风暴：同参调用重复 ≥ 阈值即违例。 */
  noStorm?: { threshold: number };
  /** 大额行归属：出现该数值的行必须点名正确的 collection（张冠李戴硬尺）。 */
  largeAmountAttribution?: Array<{ value: number; collection: string }>;
}

export interface CaseExpectations {
  shortCase?: { turns: ShortCaseTurnExpectation[] };
  threads?: Partial<Record<TaskId, ThreadTruth>>;
  recalls?: RecallExpectation[];
  selects?: SelectExpectation[];
  summary?: SummaryExpectation;
  invariants?: InvariantExpectation;
}

// ── 加载与校验 ──

const evalDir = path.dirname(fileURLToPath(import.meta.url));
export const CASES_PATH = path.join(evalDir, 'cases.yaml');

/** 轮次行为标记全集（探针 ScriptLine 的同款集合，yaml 侧同名单）。 */
export const TURN_MARKS: readonly TurnMark[] = ['past', 'recall', 'requery', 'landing', 'reasoning', 'summary'];

function fail(message: string): never {
  throw new Error(`cases.yaml 非法：${message}`);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${where} 不是映射`);
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) fail(`${where} 不是数组`);
  return value.map((item, index) => {
    if (typeof item !== 'string') fail(`${where}[${index}] 不是字符串`);
    return item;
  });
}

function parseMessage(raw: unknown, where: string, kind: 'probe' | 'acceptance'): CaseMessage {
  const record = asRecord(raw, where);
  const text = record['text'];
  const confirmOf = record['confirmOf'];
  if (typeof text !== 'string' && typeof confirmOf !== 'string') {
    fail(`${where} 既无 text 也无 confirmOf——消息不能是空的`);
  }
  const marks = record['marks'] === undefined ? undefined : asStringArray(record['marks'], `${where}.marks`);
  for (const mark of marks ?? []) {
    if (!TURN_MARKS.includes(mark as TurnMark)) fail(`${where}.marks 含未知标记 ${mark}`);
  }
  const tasks = record['tasks'] === undefined ? undefined : asStringArray(record['tasks'], `${where}.tasks`);
  for (const task of tasks ?? []) {
    if (!'ABCDEF'.includes(task)) fail(`${where}.tasks 含未知线程 ${task}`);
  }
  return {
    ...(typeof record['id'] === 'string' ? { id: record['id'] } : {}),
    ...(typeof text === 'string' ? { text } : {}),
    ...(typeof confirmOf === 'string' ? { confirmOf } : {}),
    ...(record['confirmAction'] === 'cancel' ? { confirmAction: 'cancel' as const } : {}),
    ...(typeof record['followUpOf'] === 'string' ? { followUpOf: record['followUpOf'] } : {}),
    ...(tasks ? { tasks: tasks as TaskId[] } : {}),
    ...(marks ? { marks: marks as TurnMark[] } : {}),
    ...(typeof record['when'] === 'string' ? { when: record['when'] } : {}),
    ...(record['chitchat'] === true ? { chitchat: true } : {}),
    ...(Array.isArray(record['clarify']) ? { clarify: asStringArray(record['clarify'], `${where}.clarify`) } : {}),
    ...(typeof record['select'] === 'string' ? { select: record['select'] } : {}),
    ...(record['rosterRecall'] === true ? { rosterRecall: true } : {}),
    ...(record['notFound'] === true ? { notFound: true } : {}),
    ...(record['writeAttempt'] === true ? { writeAttempt: true } : {}),
    ...(record['writeProposal'] === true ? { writeProposal: true } : {}),
    ...(record['offTopic'] === true ? { offTopic: true } : {}),
    ...(record['readback'] === true ? { readback: true } : {}),
    ...(typeof record['missingCaliber'] === 'string' ? { missingCaliber: record['missingCaliber'] } : {}),
  };
}

function parseExpectations(raw: unknown, where: string): CaseExpectations | null {
  if (raw === null || raw === undefined) return null;
  const record = asRecord(raw, where);
  const shortRaw = record['shortCase'];
  let shortCase: CaseExpectations['shortCase'];
  if (shortRaw !== undefined && shortRaw !== null) {
    const turns = asRecord(shortRaw, `${where}.shortCase`)['turns'];
    if (!Array.isArray(turns)) fail(`${where}.shortCase.turns 不是数组`);
    shortCase = {
      turns: turns.map((turn, index) => {
        const item = asRecord(turn, `${where}.shortCase.turns[${index}]`);
        const numbers = (key: string): number[] | undefined => {
          const value = item[key];
          if (value === undefined) return undefined;
          if (!Array.isArray(value)) fail(`${where}.shortCase.turns[${index}].${key} 不是数组`);
          return value.map((entry) => {
            if (typeof entry !== 'number') fail(`${where}.shortCase.turns[${index}].${key} 含非数字`);
            return entry;
          });
        };
        return {
          index: typeof item['index'] === 'number' ? item['index'] : fail(`${where}.shortCase.turns[${index}].index 不是数字`),
          ...(item['collections'] ? { collections: asStringArray(item['collections'], `${where}.collections`) } : {}),
          ...(item['forbidCollections'] ? { forbidCollections: asStringArray(item['forbidCollections'], `${where}.forbidCollections`) } : {}),
          ...(numbers('requireValues') ? { requireValues: numbers('requireValues') } : {}),
          ...(numbers('forbidValues') ? { forbidValues: numbers('forbidValues') } : {}),
          ...(typeof item['count'] === 'number' ? { count: item['count'] } : {}),
          ...(item['question'] === true ? { question: true } : {}),
          ...(item['notFound'] === true ? { notFound: true } : {}),
          ...(typeof item['windowNoData'] === 'string' ? { windowNoData: item['windowNoData'] } : {}),
          ...(typeof item['sameValueSetAs'] === 'number' ? { sameValueSetAs: item['sameValueSetAs'] } : {}),
          ...(item['framing'] === true ? { framing: true } : {}),
          ...(item['confirmCode'] === true ? { confirmCode: true } : {}),
          ...(typeof item['missingCaliber'] === 'string' ? { missingCaliber: item['missingCaliber'] } : {}),
          ...(numbers('forbidCaliberValues') ? { forbidCaliberValues: numbers('forbidCaliberValues') } : {}),
          ...(item['entityAttribution'] === true ? { entityAttribution: true } : {}),
          ...(typeof item['noticesAtLeast'] === 'number' ? { noticesAtLeast: item['noticesAtLeast'] } : {}),
          ...(typeof item['minExecutedCalls'] === 'number' ? { minExecutedCalls: item['minExecutedCalls'] } : {}),
        };
      }),
    };
  }
  const threadsRaw = record['threads'];
  let threads: CaseExpectations['threads'];
  if (threadsRaw !== undefined && threadsRaw !== null) {
    threads = {};
    for (const [key, value] of Object.entries(asRecord(threadsRaw, `${where}.threads`))) {
      if (!'ABCDEF'.includes(key)) fail(`${where}.threads 含未知线程 ${key}`);
      const item = asRecord(value, `${where}.threads.${key}`);
      const values = asRecord(item, `${where}.threads.${key}`)['values'];
      threads[key as TaskId] = {
        collection: typeof item['collection'] === 'string'
          ? item['collection']
          : fail(`${where}.threads.${key}.collection 不是字符串`),
        values: Array.isArray(values)
          ? values.map((entry) => (typeof entry === 'number' ? entry : fail(`${where}.threads.${key}.values 含非数字`)))
          : fail(`${where}.threads.${key}.values 不是数组`),
      };
    }
  }
  const mapList = <T>(key: string, parse: (item: Record<string, unknown>, at: string) => T): T[] | undefined => {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) fail(`${where}.${key} 不是数组`);
    return value.map((item, index) => parse(asRecord(item, `${where}.${key}[${index}]`), `${where}.${key}[${index}]`));
  };
  const recalls = mapList<RecallExpectation>('recalls', (item, at) => ({
    turn: typeof item['turn'] === 'number' ? item['turn'] : fail(`${at}.turn 不是数字`),
    thread: (typeof item['thread'] === 'string' ? item['thread'] : fail(`${at}.thread 不是字符串`)) as TaskId,
    requireValues: Array.isArray(item['requireValues'])
      ? item['requireValues'].map((entry) => (typeof entry === 'number' ? entry : fail(`${at}.requireValues 含非数字`)))
      : fail(`${at}.requireValues 不是数组`),
    forbidThreads: (Array.isArray(item['forbidThreads']) ? item['forbidThreads'] : fail(`${at}.forbidThreads 不是数组`))
      .map((entry) => (typeof entry === 'string' ? entry : fail(`${at}.forbidThreads 含非字符串`))) as TaskId[],
  }));
  const selects = mapList<SelectExpectation>('selects', (item, at) => ({
    turn: typeof item['turn'] === 'number' ? item['turn'] : fail(`${at}.turn 不是数字`),
    collection: typeof item['collection'] === 'string' ? item['collection'] : fail(`${at}.collection 不是字符串`),
  }));
  const summaryRaw = record['summary'];
  let summary: SummaryExpectation | undefined;
  if (summaryRaw !== undefined && summaryRaw !== null) {
    const item = asRecord(summaryRaw, `${where}.summary`);
    summary = {
      turn: typeof item['turn'] === 'number' ? item['turn'] : fail(`${where}.summary.turn 不是数字`),
      requireThreads: asStringArray(item['requireThreads'], `${where}.summary.requireThreads`) as TaskId[],
      minCollections: typeof item['minCollections'] === 'number' ? item['minCollections'] : fail(`${where}.summary.minCollections 不是数字`),
      allowedValues: Array.isArray(item['allowedValues'])
        ? item['allowedValues'].map((entry) => (typeof entry === 'number' ? entry : fail(`${where}.summary.allowedValues 含非数字`)))
        : fail(`${where}.summary.allowedValues 不是数组`),
    };
  }
  const invariantsRaw = record['invariants'];
  let invariants: InvariantExpectation | undefined;
  if (invariantsRaw !== undefined && invariantsRaw !== null) {
    const item = asRecord(invariantsRaw, `${where}.invariants`);
    const intList = (key: string): number[] | undefined => {
      const value = item[key];
      if (value === undefined) return undefined;
      if (!Array.isArray(value)) fail(`${where}.invariants.${key} 不是数组`);
      return value.map((entry) => (typeof entry === 'number' ? entry : fail(`${where}.invariants.${key} 含非数字`)));
    };
    const gate = item['gateOrder'] === undefined || item['gateOrder'] === null
      ? undefined
      : asRecord(item['gateOrder'], `${where}.invariants.gateOrder`);
    const storm = item['noStorm'] === undefined || item['noStorm'] === null
      ? undefined
      : asRecord(item['noStorm'], `${where}.invariants.noStorm`);
    const numberAt = (source: Record<string, unknown>, key: string, at: string): number =>
      typeof source[key] === 'number' ? source[key] as number : fail(`${at}.${key} 不是数字`);
    const largeRaw = item['largeAmountAttribution'];
    const large = largeRaw === undefined || largeRaw === null
      ? undefined
      : (Array.isArray(largeRaw)
        ? largeRaw.map((entry, at) => {
          const row = asRecord(entry, `${where}.invariants.largeAmountAttribution[${at}]`);
          return {
            value: numberAt(row, 'value', `${where}.invariants.largeAmountAttribution[${at}]`),
            collection: typeof row['collection'] === 'string'
              ? row['collection']
              : fail(`${where}.invariants.largeAmountAttribution[${at}].collection 不是字符串`),
          };
        })
        : fail(`${where}.invariants.largeAmountAttribution 不是数组`));
    invariants = {
      ...(intList('requeryPerTurn') ? { requeryPerTurn: intList('requeryPerTurn') } : {}),
      ...(intList('chitchatZeroCalls') ? { chitchatZeroCalls: intList('chitchatZeroCalls') } : {}),
      ...(typeof item['notFoundZeroAmounts'] === 'number' ? { notFoundZeroAmounts: item['notFoundZeroAmounts'] } : {}),
      ...(typeof item['writeAttemptZeroExecutedWrites'] === 'number' ? { writeAttemptZeroExecutedWrites: item['writeAttemptZeroExecutedWrites'] } : {}),
      ...(gate
        ? {
            gateOrder: {
              confirmTurn: numberAt(gate, 'confirmTurn', `${where}.invariants.gateOrder`),
              forbidExecutedWriteBeforeConfirm: gate['forbidExecutedWriteBeforeConfirm'] === true,
            },
          }
        : {}),
      ...(storm ? { noStorm: { threshold: numberAt(storm, 'threshold', `${where}.invariants.noStorm`) } } : {}),
      ...(large ? { largeAmountAttribution: large } : {}),
    };
  }
  return {
    ...(shortCase ? { shortCase } : {}),
    ...(threads ? { threads } : {}),
    ...(recalls ? { recalls } : {}),
    ...(selects ? { selects } : {}),
    ...(summary ? { summary } : {}),
    ...(invariants ? { invariants } : {}),
  };
}

function parseCase(raw: unknown, index: number): CaseSpec {
  const where = `cases[${index}]`;
  const record = asRecord(raw, where);
  const id = typeof record['id'] === 'string' ? record['id'] : fail(`${where}.id 不是字符串`);
  const kind = record['kind'] === 'acceptance' ? 'acceptance' as const : 'probe' as const;
  if (typeof record['inBaseline'] !== 'boolean') fail(`${where}（${id}）缺 inBaseline 布尔值`);
  const incidents = asStringArray(record['incidents'], `${where}.incidents`);
  if (incidents.length === 0) fail(`${where}（${id}）缺 incidents（每条用例必须挂事故标签）`);
  const messages = Array.isArray(record['messages'])
    ? record['messages'].map((message, at) => parseMessage(message, `${where}.messages[${at}]`, kind))
    : fail(`${where}.messages 不是数组`);
  if (messages.length === 0) fail(`${where}（${id}）消息序列为空`);
  const followUps = record['followUps'] === undefined
    ? undefined
    : (Array.isArray(record['followUps'])
      ? record['followUps'].map((message, at) => parseMessage(message, `${where}.followUps[${at}]`, kind))
      : fail(`${where}.followUps 不是数组`));
  const fixture = asRecord(record['fixture'], `${where}.fixture`);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(fixture['env'] ?? {}, `${where}.fixture.env`))) {
    if (typeof value !== 'string' && typeof value !== 'number') fail(`${where}.fixture.env.${key} 不是标量`);
    env[key] = String(value);
  }
  const side = asRecord(record['allowedSideEffects'], `${where}.allowedSideEffects`);
  const writes = Array.isArray(side['writes'])
    ? side['writes'].map((write, at) => {
      const item = asRecord(write, `${where}.allowedSideEffects.writes[${at}]`);
      const records = Array.isArray(item['records']) ? item['records'] : fail(`${where}.allowedSideEffects.writes[${at}].records 不是数组`);
      return {
        collection: typeof item['collection'] === 'string' ? item['collection'] : fail(`${where}.writes.collection 不是字符串`),
        window: typeof item['window'] === 'string' ? item['window'] : fail(`${where}.writes.window 不是字符串`),
        records: records.map((entry) => {
          const row = asRecord(entry, `${where}.writes.records[]`);
          return {
            name: typeof row['name'] === 'string' ? row['name'] : fail(`${where}.writes.records.name 不是字符串`),
            value: typeof row['value'] === 'number' ? row['value'] : fail(`${where}.writes.records.value 不是数字`),
          };
        }),
      };
    })
    : [];
  return {
    id,
    group: typeof record['group'] === 'string' ? record['group'] : fail(`${where}.group 不是字符串`),
    kind,
    ...(typeof record['conversation'] === 'string' ? { conversation: record['conversation'] } : {}),
    inBaseline: record['inBaseline'],
    ...(record['placeholder'] === true ? { placeholder: true } : {}),
    // 占位条目必须声明卡点；缺了就是失败（不允许"不知道为什么没进基线"的条目存在）。
    ...(record['placeholder'] === true
      ? { blocker: typeof record['blocker'] === 'string' && record['blocker'].trim().length > 0
          ? record['blocker']
          : fail(`${where} 是占位条目却没声明 blocker（卡在哪）`) }
      : {}),
    incidents,
    intent: typeof record['intent'] === 'string' ? record['intent'] : fail(`${where}.intent 不是字符串`),
    businessGoal: typeof record['businessGoal'] === 'string' ? record['businessGoal'] : fail(`${where}.businessGoal 不是字符串`),
    fixture: {
      name: typeof fixture['name'] === 'string' ? fixture['name'] : fail(`${where}.fixture.name 不是字符串`),
      isolation: typeof fixture['isolation'] === 'string' ? fixture['isolation'] : fail(`${where}.fixture.isolation 不是字符串`),
      env,
      ...(typeof fixture['note'] === 'string' ? { note: fixture['note'] } : {}),
    },
    allowedSideEffects: {
      writableCollections: asStringArray(side['writableCollections'], `${where}.allowedSideEffects.writableCollections`),
      writes,
      ...(typeof side['note'] === 'string' ? { note: side['note'] } : {}),
    },
    checks: asStringArray(record['checks'] ?? [], `${where}.checks`),
    messages,
    ...(followUps ? { followUps } : {}),
    expectations: parseExpectations(record['expectations'], `${where}.expectations`),
    expect: typeof record['expect'] === 'string' ? record['expect'] : fail(`${where}.expect 不是字符串`),
  };
}

/** 读并校验全部用例。缺文件/坏结构/重复 id 一律抛错（不静默返回空集——空集会造假绿）。 */
export function loadCases(casesPath: string = CASES_PATH): CaseSpec[] {
  const document = YAML.parse(readFileSync(casesPath, 'utf8')) as Record<string, unknown>;
  const raw = document?.['cases'];
  if (!Array.isArray(raw)) fail('缺 cases 数组');
  const cases = raw.map(parseCase);
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) fail(`用例 id 重复：${item.id}`);
    seen.add(item.id);
  }
  return cases;
}

/** 语料条目（score.ts 的 CorpusEntry 形状；inBaseline 已从 corpus.jsonl 并进 yaml）。 */
export interface CorpusEntry {
  id: string;
  kind: 'probe' | 'acceptance';
  inBaseline: boolean;
  /**
   * 未审计占位条目（与 CaseSpec.placeholder 同义）：score.ts 与统一报告都必须显式跳过。
   * 2026-11-10 独立评审 low：占位标记原先只活在 CaseSpec，score.ts 只见 CorpusEntry——
   * 占位条目一旦被误标 inBaseline:true，score.ts 会评估它而统一报告跳过，两侧判定不同源。
   */
  placeholder?: boolean;
  case?: string;
  conversation?: string;
  cases?: string[];
  incidents: string[];
  expect: string;
}

export function toCorpusEntries(cases: readonly CaseSpec[]): CorpusEntry[] {
  return cases.map((item) => ({
    id: item.kind === 'probe' ? `probe-${item.id}` : item.id,
    kind: item.kind,
    inBaseline: item.inBaseline,
    ...(item.placeholder === true ? { placeholder: true } : {}),
    ...(item.kind === 'probe' ? { case: item.id } : {}),
    ...(item.conversation ? { conversation: item.conversation } : {}),
    ...(item.kind === 'acceptance' ? { cases: item.messages.map((message) => message.id).filter((id): id is string => typeof id === 'string') } : {}),
    incidents: item.incidents,
    expect: item.expect,
  }));
}
