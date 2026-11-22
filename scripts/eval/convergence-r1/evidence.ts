/** convergence-r1 证据文件形状（与审计 B【4】schema 对齐）。 */

export interface AuditRow {
  ts?: string;
  mode?: string;
  via?: string;
  script?: string;
  args?: unknown;
  serve?: boolean;
  exitCode?: number;
  refused?: string;
  planId?: string;
  result?: { status?: string; collection?: string; count?: number; items?: Array<{ id?: string; name?: string; value?: number }> } | null;
  [key: string]: unknown;
}

export interface AuditIndexTurn {
  index: number;
  /** 1-based 闭区间；空轮 toLine = fromLine - 1。 */
  fromLine: number;
  toLine: number;
  sha256: string;
  structuredRows: number;
  refusedRows: number;
}

export interface AuditIndex {
  turns: AuditIndexTurn[];
  totalLines: number;
}

export interface ToolCallRecord {
  turn: number;
  agent: 'main' | 'worker';
  seq: number;
  tool: string;
  args: unknown;
  result?: unknown;
  resultSummary?: string;
  isError?: boolean;
  startedAt: string;
  elapsedMs: number;
}

export interface ExecutionRecordJson {
  requestId: string;
  operation: string;
  status: string;
  error?: { code?: string; message?: string };
}

export interface TaskRecordJson {
  taskId: string;
  principalId: string;
  sessionId: string;
  request: string;
  /**
   * 旧状态**词投影**（taskStatusOf：机械事实 → 词），不是底账结论——S1 起底账没有 status
   * 字段，runner 导出 T1 时按 executed 行/结束事实/租约投影写入。判 outcome 只读 executions
   * 的逐条执行行（judge.outcomeFromTask），不读本字段。
   */
  status: string;
  resultText?: string;
  failureReason?: string;
  executions: ExecutionRecordJson[];
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionsExport {
  tasks: TaskRecordJson[];
}

export interface ReplyLine {
  turn: number;
  text: string;
  sha256: string;
}

export interface MetaTurn {
  index: number;
  durationMs: number;
  modelCalls: number;
  /** 本回合宿主返回的 taskIds（委派事实，逐轮）。 */
  taskIds: string[];
  tokens: {
    available: boolean;
    input?: number;
    output?: number;
    cacheRead?: number;
    total?: number;
    source: string;
  };
  retries: number;
  notes: string[];
}

export interface MetaFile {
  turns: MetaTurn[];
  driverEvents: Array<Record<string, unknown>>;
  notes: string[];
}

export interface InputsFile {
  caseId: string;
  trial: number;
  principalId: string;
  sessionId: string;
  turns: Array<{ index: number; text: string; sha256: string }>;
  configPath: string;
  profileRoot: string;
  gateway: string;
  dbPath: string;
}
