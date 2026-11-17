/**
 * CAP-01 修复轮（R2-S1 / R2-S2）· 工具描述的接口事实 · 静态常量 + 真实工具面双面验证。
 *
 * 背景（验收查出的两个真模型红）：
 *   · R2-S1：run_js 描述没写可用模块 → 模型首调 require("xlsx")（该包未安装）→ 首调失败
 *     → 模型转去 run_task 兜底并建了 Task。修法 = 描述声明模块面：**可用模块只有
 *     exceljs（require("exceljs") 读写 xlsx）；没有 xlsx/xlsx-style/csv-parse 等包**。
 *   · R2-S2：run_task 描述没写 inputFiles → 模型交办不带 inputFiles → 交办复制零发生
 *     → Worker 无文件 → 任务 unexecuted → Main 自己兜底。修法 = 注入复制面时描述声明：
 *     **把要处理的本会话 fileId 放进 inputFiles；不带则 Worker 拿不到任何文件**。
 *
 * 纪律：这是**接口事实声明**（能力边界与参数后果），不是提示词补丁——描述里不得出现
 * 业务流程话术（负例断言钉住）；不做跨工具流程诱导（run_js 描述不提 run_task，反之亦然）。
 * 缺省装配（未注入复制面）的 run_task 描述逐字节不变，也不宣传不存在的 inputFiles 参数。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
} from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from './src/driver-contract';
import { createFileStore } from './src/file-store';
import type { RunJsExecutor } from './src/run-js-executor';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import {
  RUN_JS_TOOL,
  RUN_JS_TOOL_DESCRIPTION,
  RUN_TASK_TOOL,
  RUN_TASK_TOOL_DESCRIPTION,
  RUN_TASK_TOOL_DESCRIPTION_WITH_INPUT_FILES,
  createSession,
  type Session,
} from './src/execution-runtime';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

class FaceClient implements ExecutionClient {
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(): Promise<ExecutionOutcome> {
    return { status: 'completed', data: {} };
  }
}

const workerNeverCalled: TurnDriver = {
  async run() {
    throw new Error('（测试）worker 不应被调用');
  },
};

/** 静态面验证不执行任何脚本：执行器只用于让 run_js 上工具面（调用即抛，不会被调到）。 */
const neverRunJsExecutor: RunJsExecutor = {
  async runJs() {
    throw new Error('（测试）静态面验证不执行脚本');
  },
};

interface ToolFace {
  name: string;
  description: string;
}

/**
 * 真实工具面夹具：开一个真会话跑一回合，按模型实际收到的样子捕获工具面（name/description）。
 * withCopier=false 时模拟缺省装配（无交办复制面 → run_task 不带 inputFiles 属性）。
 */
async function captureToolFaces(input: { withCopier?: boolean } = {}): Promise<ToolFace[]> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tool-description-facts-'));
  tempDirs.push(dir);
  const registry = createSqliteTaskRegistry(path.join(dir, 'state.db'));
  const fileStore = createFileStore({ store: registry.store, workspaceRoot: path.join(dir, 'workspace') });
  const faces: ToolFace[][] = [];
  const session: Session = await createSession({
    principalId: 'wecom:test-user',
    sessionId: 'sess_1',
    client: new FaceClient(),
    allowedOperations: ['dummy.query'],
    mainDriver: {
      async run(runInput) {
        faces.push(runInput.tools.map((tool) => ({ name: tool.name, description: tool.description })));
        return { text: '已确认工具面。', messages: [] as unknown as DriverMessage[] };
      },
    },
    workerDriver: workerNeverCalled,
    mainSystemPrompt: '你是测试主 Agent。',
    taskRegistry: registry,
    ...(input.withCopier === false ? {} : { taskInputCopier: fileStore }),
    runJsExecutor: neverRunJsExecutor,
  });
  try {
    await session.send('确认一下你有哪些工具。');
  } finally {
    registry.close();
  }
  return faces[0]!;
}

/**
 * 业务流程话术负例（接口事实纪律）：描述只声明能力边界与参数后果，不做流程编排、
 * 补救诱导、用户面叙事——这些属于提示词补丁（A 类，默认删除）。
 */
const BUSINESS_FLOW_NEGATIVES = [
  '请重试', // 补救诱导（R7-F3 同款问题面）
  '兜底',
  '话术',
  '告诉用户',
  '汇报给用户',
  '如果失败',
  '失败就',
] as const;

describe('run_js 描述：模块面接口事实（R2-S1）', () => {
  it('静态常量：声明可用模块只有 exceljs（require("exceljs") 读写 xlsx），点名没有的包', () => {
    expect(RUN_JS_TOOL_DESCRIPTION).toContain('exceljs');
    expect(RUN_JS_TOOL_DESCRIPTION).toContain('require("exceljs")');
    expect(RUN_JS_TOOL_DESCRIPTION).toContain('xlsx');
    // 缺失包逐一点名（验收口径：xlsx/xlsx-style/csv-parse 等）。
    expect(RUN_JS_TOOL_DESCRIPTION).toContain('xlsx-style');
    expect(RUN_JS_TOOL_DESCRIPTION).toContain('csv-parse');
    expect(RUN_JS_TOOL_DESCRIPTION).toContain('可用模块');
  });

  it('负例：不含业务流程话术，也不做跨工具流程诱导（不提 run_task）', () => {
    for (const phrase of BUSINESS_FLOW_NEGATIVES) {
      expect(RUN_JS_TOOL_DESCRIPTION).not.toContain(phrase);
    }
    expect(RUN_JS_TOOL_DESCRIPTION).not.toContain('run_task');
  });

  it('真实工具面：模型收到的 run_js description 就是该常量（逐字节一致）', async () => {
    const faces = await captureToolFaces();
    const face = faces.find((tool) => tool.name === RUN_JS_TOOL);
    expect(face).toBeDefined();
    expect(face!.description).toBe(RUN_JS_TOOL_DESCRIPTION);
  });
});

describe('run_js 描述：脚本内路径约定（修复轮 ⑤）', () => {
  it('静态常量：声明 in/<fileId><安全扩展名> 与「脚本内路径」字段，路径不由原始文件名拼出', () => {
    // 与清单渲染的「脚本内路径」字段同一条约定（file-manifest-script-paths.test.ts 钉渲染面）。
    expect(RUN_JS_TOOL_DESCRIPTION).toContain('脚本内路径');
    expect(RUN_JS_TOOL_DESCRIPTION).toContain('in/<fileId><安全扩展名>');
    expect(RUN_JS_TOOL_DESCRIPTION).toContain('路径只由 fileId 和安全扩展名派生');
    expect(RUN_JS_TOOL_DESCRIPTION).toContain('不由原始文件名拼出');
  });

  it('负例：不含业务流程话术', () => {
    for (const phrase of BUSINESS_FLOW_NEGATIVES) {
      expect(RUN_JS_TOOL_DESCRIPTION).not.toContain(phrase);
    }
  });
});

describe('run_task 描述：inputFiles 接口事实（R2-S2）', () => {
  it('注入复制面时：描述写清「把要处理的本会话 fileId 放进 inputFiles；不带则 Worker 拿不到任何文件」', async () => {
    expect(RUN_TASK_TOOL_DESCRIPTION_WITH_INPUT_FILES).toContain('inputFiles');
    expect(RUN_TASK_TOOL_DESCRIPTION_WITH_INPUT_FILES).toContain('fileId');
    expect(RUN_TASK_TOOL_DESCRIPTION_WITH_INPUT_FILES).toContain('Worker 拿不到任何文件');
    // 真实工具面（注入复制面 = server 同款装配）：模型收到的就是带 inputFiles 事实的描述。
    const faces = await captureToolFaces();
    const face = faces.find((tool) => tool.name === RUN_TASK_TOOL);
    expect(face).toBeDefined();
    expect(face!.description).toBe(RUN_TASK_TOOL_DESCRIPTION_WITH_INPUT_FILES);
  });

  it('缺省装配（未注入复制面）：描述逐字节不变，且不宣传不存在的 inputFiles 参数', async () => {
    const faces = await captureToolFaces({ withCopier: false });
    const face = faces.find((tool) => tool.name === RUN_TASK_TOOL);
    expect(face).toBeDefined();
    expect(face!.description).toBe(RUN_TASK_TOOL_DESCRIPTION);
    expect(RUN_TASK_TOOL_DESCRIPTION).not.toContain('inputFiles');
  });

  it('负例：不含业务流程话术，也不做跨工具流程诱导（不提 run_js）', () => {
    for (const phrase of BUSINESS_FLOW_NEGATIVES) {
      expect(RUN_TASK_TOOL_DESCRIPTION_WITH_INPUT_FILES).not.toContain(phrase);
    }
    expect(RUN_TASK_TOOL_DESCRIPTION_WITH_INPUT_FILES).not.toContain('run_js');
  });
});
