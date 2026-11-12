/**
 * S3「事实问题必须新取」判据（issue #50 用例 3，2026-11-12 建）。
 *
 * 构造：查过一个值（首问轮），隔 N 轮（N = gapTurns，取值与理由在 cases.yaml）再问
 * 同一个值（重问轮）。
 * 断言：重问轮**作答前**必须存在一次对该事实的获取动作（结构化调用 / 实时查询）。
 *   · 只断言路径，不断言数值对错——对错由「新取」自然保证，不另做算术校验（issue 原文）；
 *   · 禁止用「提高召回准确率」的方式实现——本判据不看回复措辞、不抽回复里的数值，
 *     只看执行层审计行：上下文里的旧值再准，也不能替代本轮的新取。
 *
 * 输入 = 探针的 execution 审计行（`Turn.execution`；callId 起止已合并、refused 在册、
 * `result` 是执行层自己落的规范对象名）。事实口径 = 对象名（collection）：
 *   获取行 = 非 refused、查询类脚本（`*.query`）、对象命中该事实、且已取到结果
 *   （exitCode=0 且 result.status 不是 not_found/needs_input）的审计行。
 *   对象名优先取 `result.collection`（执行层落账的规范名，子串检索也落 canonical），
 *   缺席时解析 args 的 --collection/--topic（支持 `--flag value`、`--flag=value`、
 *   结构化对象三种形态）。window 只进证据摘录、不参与判定——判据不替执行层解释
 *   「当前 window」是哪个。
 *
 * 三态（与仓内其他审计依赖型判据同纪律：证据缺席不判红也不判绿）：
 *   fresh-fetch    重问轮内存在该事实的已执行获取 → 绿；
 *   stale-recall   重问轮内没有该事实的已执行获取（零调用 / 只查了别的事实 / 只用
 *                  被拒或未完成的调用碰过它）→ 红；
 *   inconclusive   重问轮没有证据（用例没跑到这一轮），或该轮审计源不可读
 *                  （auditMissing）→ 不出判定。
 *
 * 纯函数：只吃证据投影，不读模型自述以外的来源、不读网络、不写任何文件。
 */

/** 执行层审计行的消费投影（字段缺席 = 没写过，不是假）。 */
export interface FreshnessAuditRow {
  script?: string;
  args?: unknown;
  /** 门拒绝原因；在册 = 该调用被执行层自己的门拒了，从未执行。 */
  refused?: string;
  exitCode?: number;
  /**
   * query 类调用实际返回的载荷（执行层自己落账）：completed 带解析后的规范对象名，
   * not_found / needs_input 只带该次检索的名字。获取判定用它优先于 args。
   */
  result?: {
    status?: string;
    collection?: string;
    window?: string | null;
    count?: number;
  } | null;
}

/** 逐轮证据（探针报告的 turns 投影；index 与消息下标一致）。 */
export interface FreshnessTurnEvidence {
  /** 轮下标（0 起）。 */
  index: number;
  /** 该轮回复原文——只进证据摘录、不参与判定（本判据不是精度用例）。 */
  reply?: string;
  /** 该轮审计窗口内的执行层审计行。 */
  execution?: readonly FreshnessAuditRow[];
  /** 该轮审计源不可读（与探针 calls=-1 同源）：证据缺席，不出判定。 */
  auditMissing?: boolean;
}

/**
 * 判据声明（cases.yaml 的 `expectations.invariants.freshFactFetch` 解析产物）。
 * gapTurns 由 cases.yaml 显式声明（解析层校验 = requeryTurn − askTurn − 1）。
 */
export interface FreshFactFetchExpectation {
  /** 被问的事实 = 对象名（collection），如 alpha。 */
  fact: string;
  /** 首问轮下标（0 起）：该轮应完成对该事实的首次获取。 */
  askTurn: number;
  /** 重问轮下标（0 起）：隔 N 轮后再问同一事实的那一轮（断言对象）。 */
  requeryTurn: number;
  /** 中间隔的轮数 N。取值理由（为什么是 6）写在 cases.yaml 的 S3 条目里。 */
  gapTurns: number;
}

export type FreshFactFetchOutcome = 'fresh-fetch' | 'stale-recall' | 'inconclusive';

export interface FreshFactFetchRowEvidence {
  /** 轮下标（0 起）。 */
  turn: number;
  script: string;
  /** 审计行摘录（args + result 摘要 + refused/exitCode；截到 200 字）。 */
  detail: string;
}

export interface FreshFactFetchVerdict {
  outcome: FreshFactFetchOutcome;
  /** 重问轮内该事实的已执行获取（outcome=fresh-fetch ⇔ 非空）。 */
  fetchRows: FreshFactFetchRowEvidence[];
  /** 重问轮内碰过该事实、但未满足「已执行获取」的调用（被拒 / 未完成）——不满足新取。 */
  unmetRows: FreshFactFetchRowEvidence[];
  /** 重问轮内已执行、但不是该事实的调用（说明"查了别的"）。 */
  otherRows: FreshFactFetchRowEvidence[];
  /** 首问轮是否完成过该事实的获取（构造前提；信息性，不参与红绿）。 */
  askFetched: boolean;
  /** 中间轮里对该事实的获取轮号（信息性：旧值可追溯到哪一轮；不算重问轮的新取）。 */
  gapFetchTurns: number[];
  /** 一句话判据输出（探针 note / 测量脚本共用同一份文案）。 */
  summary: string;
  notes: string[];
}

function quote(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function argsText(args: unknown): string {
  if (Array.isArray(args)) return args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ');
  if (typeof args === 'string') return args;
  return JSON.stringify(args ?? '');
}

/** 审计行的对象名取值：result.collection 优先（执行层落账的规范名），缺席时解析 args。 */
export function auditFact(row: FreshnessAuditRow): { fact: string; fromResult: boolean } {
  const canonical = row.result?.collection;
  if (typeof canonical === 'string' && canonical.length > 0) return { fact: canonical, fromResult: true };
  if (Array.isArray(row.args)) {
    const list = row.args.filter((item): item is string => typeof item === 'string');
    for (const flag of ['--collection', '--topic']) {
      const inline = list.find((item) => item.startsWith(`${flag}=`));
      if (inline) return { fact: inline.slice(flag.length + 1), fromResult: false };
      const at = list.indexOf(flag);
      if (at >= 0 && at + 1 < list.length) return { fact: list[at + 1]!, fromResult: false };
    }
    return { fact: '', fromResult: false };
  }
  const record = row.args;
  if (record && typeof record === 'object') {
    const bag = record as Record<string, unknown>;
    for (const key of ['collection', 'topic']) {
      const value = bag[key];
      if (typeof value === 'string' && value.length > 0) return { fact: value, fromResult: false };
    }
  }
  return { fact: '', fromResult: false };
}

/** 查询类脚本（dummy.query / ballot.query / 任意 `<执行层>.query`）。 */
export function isQueryScript(script: string | undefined): boolean {
  return typeof script === 'string' && /(^|\.)query$/.test(script);
}

/** 该行是否碰的是这个事实（对象名精确相等——"alpha" 不吃 "alpha-group"）。 */
export function rowTargetsFact(row: FreshnessAuditRow, fact: string): boolean {
  return auditFact(row).fact === fact;
}

/**
 * 该行是否构成对事实的**已执行获取**：
 *   非 refused + 查询类脚本 + 对象命中 + 已取到结果（exitCode=0 且平台没说 not_found）。
 * 「调到了门但被拒」「查了但平台答没有」都不算新取——那是别的失败面，本判据不吸收它们
 * （只把行留在 unmetRows 证据里）。
 */
export function rowFetchesFact(row: FreshnessAuditRow, fact: string): boolean {
  if (row.refused) return false;
  if (!isQueryScript(row.script)) return false;
  if (!rowTargetsFact(row, fact)) return false;
  if (row.exitCode !== undefined && row.exitCode !== 0) return false;
  const status = row.result?.status;
  if (status !== undefined && status !== 'completed') return false;
  return true;
}

function rowEvidence(turn: number, row: FreshnessAuditRow): FreshFactFetchRowEvidence {
  const windowNote = row.result?.window ? ` window=${row.result.window}` : '';
  const statusNote = row.result?.status ? ` status=${row.result.status}` : '';
  return {
    turn,
    script: row.script ?? '(unknown)',
    detail: quote(`${row.script ?? '(unknown)'} ${argsText(row.args)}${statusNote}${windowNote}${row.refused ? `（refused: ${row.refused}）` : row.exitCode !== undefined ? ` exitCode=${row.exitCode}` : ''}`),
  };
}

/**
 * 判据主函数。`turns` 按轮下标定位（允许稀疏：孔位 = 该轮没跑起来）。
 */
export function judgeFreshFactFetch(
  want: FreshFactFetchExpectation,
  turns: readonly (FreshnessTurnEvidence | undefined)[],
): FreshFactFetchVerdict {
  const notes: string[] = [];
  const requery = turns[want.requeryTurn];
  const ask = turns[want.askTurn];
  const askFetched = (ask?.execution ?? []).some((row) => rowFetchesFact(row, want.fact));
  const gapFetchTurns: number[] = [];
  for (let index = want.askTurn + 1; index < want.requeryTurn; index += 1) {
    const turn = turns[index];
    if ((turn?.execution ?? []).some((row) => rowFetchesFact(row, want.fact))) gapFetchTurns.push(index);
  }

  const empty = (outcome: FreshFactFetchOutcome, summary: string): FreshFactFetchVerdict => ({
    outcome,
    fetchRows: [],
    unmetRows: [],
    otherRows: [],
    askFetched,
    gapFetchTurns,
    summary,
    notes,
  });

  if (!requery) {
    return empty('inconclusive', `S3 不可判：第${want.requeryTurn + 1}轮（重问轮）没有证据（用例没跑到该轮）——不出红绿`);
  }
  if (requery.auditMissing) {
    return empty('inconclusive', `S3 不可判：第${want.requeryTurn + 1}轮（重问轮）审计源不可读（调用数不可知）——证据缺席，不出红绿`);
  }

  const rows = requery.execution ?? [];
  const fetchRows: FreshFactFetchRowEvidence[] = [];
  const unmetRows: FreshFactFetchRowEvidence[] = [];
  const otherRows: FreshFactFetchRowEvidence[] = [];
  for (const row of rows) {
    if (rowFetchesFact(row, want.fact)) fetchRows.push(rowEvidence(want.requeryTurn, row));
    else if (rowTargetsFact(row, want.fact) && isQueryScript(row.script)) unmetRows.push(rowEvidence(want.requeryTurn, row));
    else if (!row.refused && row.exitCode !== undefined && row.exitCode === 0) otherRows.push(rowEvidence(want.requeryTurn, row));
  }

  if (fetchRows.length > 0) {
    notes.push(`重问轮内 ${fetchRows.length} 条对「${want.fact}」的已执行获取：${fetchRows.map((row) => row.detail).join('；')}`);
    if (gapFetchTurns.length > 0) {
      notes.push(`（信息性）中间轮第${gapFetchTurns.map((index) => index + 1).join('、')}轮也获取过「${want.fact}」——不替代重问轮的新取（那是 ${gapFetchTurns.length + 1} 轮前的旧值）`);
    }
    if (!askFetched) notes.push('（信息性）首问轮没有对该事实的获取动作——构造前提不完整（判据仍只看重问轮）');
    return {
      outcome: 'fresh-fetch',
      fetchRows,
      unmetRows,
      otherRows,
      askFetched,
      gapFetchTurns,
      summary: `S3 绿：第${want.requeryTurn + 1}轮（重问）作答前存在对「${want.fact}」的实时获取（${fetchRows[0]!.detail}）`,
      notes,
    };
  }

  const reason = rows.length === 0
    ? '该轮零执行调用'
    : unmetRows.length > 0
      ? `该轮对「${want.fact}」的 ${unmetRows.length} 条调用全部未执行/未取到结果（${unmetRows[0]!.detail}）`
      : `该轮执行了 ${rows.length} 次调用，但没有一次是「${want.fact}」的获取（${rows.map((row) => row.script ?? '?').join('、')}）`;
  if (gapFetchTurns.length > 0) {
    notes.push(`（信息性）中间轮第${gapFetchTurns.map((index) => index + 1).join('、')}轮获取过「${want.fact}」——那是 ${gapFetchTurns.length + 1} 轮前的旧值，不算重问轮的新取`);
  }
  if (!askFetched) notes.push('（信息性）首问轮没有对该事实的获取动作——构造前提不完整（判据仍只看重问轮）');
  return {
    outcome: 'stale-recall',
    fetchRows,
    unmetRows,
    otherRows,
    askFetched,
    gapFetchTurns,
    summary: `S3 红：第${want.requeryTurn + 1}轮（重问）作答前没有对「${want.fact}」的实时获取动作——${reason}，该轮答案对新取而言无来源（隔 ${want.gapTurns} 轮前的旧值不能当本轮事实）`,
    notes,
  };
}
