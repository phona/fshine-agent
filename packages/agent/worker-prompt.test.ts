/**
 * R5 Worker 提示词装配测试（确定性，零真实模型调用）。
 *
 * 2026-11-24 owner 裁定「宿主持业务侵入行为全干掉」后（O-6）：`renderWorkerSystemPrompt` 与
 * `workerWorkspaceRoot` 选项整份删除——Worker 系统提示**恒为** `WORKER_SYSTEM_PROMPT`，
 * 装配层不再往里注入工作目录（能访问什么由执行环境决定，不靠提示词补丁）。
 *
 * 本文件改钉新形状：
 *   ① Worker 系统提示常量本身：含内联锚、不含工作目录注入块（防整段被悄悄改写或注入复活）；
 *   ② 经 createSession 装配后，workerDriver 收到的**每条** systemPrompt 逐字节等于该常量
 *      （「恒为」= 无参数化注入；旧的「注入后含路径」断言随注入一起删除）；
 *   ③ 生产装配链（scripts/ask-runtime.ts）不再传 workerWorkspaceRoot（复活即红）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createSession,
  MAIN_PROTOCOL_NOTE,
  MAIN_PROTOCOL_NOTE_WITH_WRITES,
  renderWorkerDelegation,
  WORKER_SYSTEM_PROMPT,
} from './src/execution-runtime';
import type { DriverMessage, TurnDriver, TurnDriverResult } from './src/driver-contract';
import type { ExecutionClient } from '@fshine/contracts/execution-contract';
import type { CapabilityManifest, ExecutionOutcome } from '@fshine/contracts/execution-contract';

/** 工作目录注入块的关键句（O-6 已删；回来即红）。 */
const INJECTION_PHRASES = [
  '你的工作目录是：',
  '处理文件只在这个目录里进行',
  '不要去翻别人的配置、账号信息或别的目录',
  '这条对你调用的工具一样适用',
] as const;

/** 现行 Worker 提示的内联锚（逐字节防漂移用）。 */
const BASE_PROMPT_ANCHOR = '你接到一件要办的事，按给你的输入去做。';

/** 最小执行客户端假件：单只读 operation，execute 恒 completed。 */
class FakeClient implements ExecutionClient {
  async capabilities(): Promise<CapabilityManifest> {
    return {
      contractVersion: 1,
      operations: [{ name: 'dummy.query', args: [] }],
    };
  }

  async execute(): Promise<ExecutionOutcome> {
    return { status: 'completed', data: { ok: true } };
  }
}

/** 捕获 systemPrompt 的假 Worker 驱动（不调模型）。 */
function capturingDriver(): { driver: TurnDriver; prompts: () => string[] } {
  const prompts: string[] = [];
  const driver: TurnDriver = {
    async run(input): Promise<TurnDriverResult> {
      prompts.push(input.systemPrompt);
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: '已查询：1 条。' }],
        timestamp: Date.now(),
      } as unknown as DriverMessage;
      return { text: '已查询：1 条。', messages: [message] } as unknown as TurnDriverResult;
    },
  };
  return { driver, prompts: () => prompts };
}

/** 一次性 Main 驱动：经 exec 委派一个 task_run 后收汇报（不调模型）。 */
function delegatingMainDriver(): TurnDriver {
  return {
    async run(input): Promise<TurnDriverResult> {
      await input.exec('task_run', { task: '查询 dummy 数据' });
      const text = '已委派并收到汇报。';
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
      } as unknown as DriverMessage;
      return { text, messages: [...input.messages, message] } as unknown as TurnDriverResult;
    },
  };
}

describe('Worker 系统提示：恒为 WORKER_SYSTEM_PROMPT（O-6 删注入后的形状）', () => {
  it('现行基线提示含内联锚，且不含工作目录注入块（防整段被悄悄改写）', () => {
    expect(WORKER_SYSTEM_PROMPT).toContain(BASE_PROMPT_ANCHOR);
    expect(WORKER_SYSTEM_PROMPT).not.toContain('可信工作目录是');
    for (const phrase of INJECTION_PHRASES) {
      expect(WORKER_SYSTEM_PROMPT).not.toContain(phrase);
    }
  });

  it('createSession 装配后 workerDriver 收到的 systemPrompt 逐字节等于 WORKER_SYSTEM_PROMPT', async () => {
    const worker = capturingDriver();
    const session = await createSession({
      principalId: 'wecom:test-user',
      sessionId: 'sess_wp',
      client: new FakeClient(),
      allowedOperations: ['dummy.query'],
      mainDriver: delegatingMainDriver(),
      workerDriver: worker.driver,
      mainSystemPrompt: '你是测试主 Agent。',
    });
    await session.send('查一下');
    expect(worker.prompts().length).toBeGreaterThan(0);
    for (const prompt of worker.prompts()) {
      expect(prompt).toBe(WORKER_SYSTEM_PROMPT);
    }
  });
});

describe('生产装配链接线（结构断言，不跑装配）', () => {
  it('scripts/ask-runtime.ts 不再注入 workerWorkspaceRoot（O-6 已删；复活即红）', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../scripts/ask-runtime.ts', import.meta.url)),
      'utf8',
    );
    expect(source.match(/workerWorkspaceRoot/g)?.length ?? 0).toBe(0);
  });
});

/**
 * 2026-11-25 上下文工程收尾：两条经 Eval 验证的提示词规则守卫。
 *
 * 背景（D 轴 DS-1#1 / E15 基准率）：
 *   ① 范围随传：Worker 把用户点名的窗口丢了（`dummy.query {collection:'beta'}`，漏 `window`），
 *      因为 `--window` 声明为 optional、工具 schema 又无描述。规则加在委派文本里（不是阀门）。
 *      验证：DS-1 两样本调用参数都带上窗口；机械事实见 out/daxis-2026-11-25-fix2。
 *   ② 来源强制句式：E15 干净 HEAD 基准 5/8 红（回复给了合计但不说来源），原规则「说明来源」
 *      被模型忽略；改成「必须紧跟一句来源说明…没有就不给出这个数字」后降到 1/8。
 *      验证：out/e-e15-clean8（5/8 红）vs out/e-e15fix（1/8 红）。
 *
 * 这两条只做**防 silently 删除/漂移**的结构守卫；行为证据在 Eval（A 类去留由黑盒决定）。
 * 反向绊线即守卫本身：规则被删或被改写掉关键句式 → 本测试红。
 */
describe('上下文工程规则守卫（2026-11-25，D 轴 DS-1 + E15）', () => {
  it('① 委派文本含「范围条件按原值随参数传入」，且明确必填与否不影响', () => {
    const manifest: CapabilityManifest = {
      contractVersion: 1,
      operations: [
        {
          name: 'dummy.query',
          access: 'read',
          args: [
            { name: '--collection', required: true, type: 'name' },
            { name: '--window', required: false, type: 'code' },
          ],
        },
      ],
    };
    const text = renderWorkerDelegation({ task: '核对 beta 集合 W1 的记录', manifest });
    expect(text).toContain('范围条件');
    expect(text).toContain('按交办里的原值一并传入');
    // 关键句：optional 不构成省略理由（DS-1#1 正是拿「非必填」当理由漏传窗口）。
    expect(text).toContain('是否必填不影响');
  });

  it('③ MAIN_PROTOCOL_NOTE 含聚合数来源强制句式（没有来源说明就不给出数字）', () => {
    expect(MAIN_PROTOCOL_NOTE).toContain('必须紧跟一句来源说明');
    expect(MAIN_PROTOCOL_NOTE).toContain('没有来源说明，就不要给出这个数字');
  });

  it('写面协议文本保持同一条来源句式（两条协议文本不允许只改一条）', () => {
    expect(MAIN_PROTOCOL_NOTE_WITH_WRITES).toContain('必须紧跟一句来源说明');
    expect(MAIN_PROTOCOL_NOTE_WITH_WRITES).toContain('没有来源说明，就不要给出这个数字');
  });
});
