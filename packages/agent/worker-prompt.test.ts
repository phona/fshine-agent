/**
 * R5 Worker 提示词装配测试（确定性，零真实模型调用）。
 *
 * 钉住的最小改动面：Worker 系统提示在装配层注入「可信工作目录」与工作目录约束——
 *   ① renderWorkerSystemPrompt('/trusted/root') 包含实际路径与全部约束语义关键句；
 *   ② 不传参时与现行 WORKER_SYSTEM_PROMPT 逐字节相等（缺省装配路径零回归）；
 *   ③ 经 createSession 装配后，workerDriver 收到的 systemPrompt 含注入路径（假驱动捕获）；
 *   ④ 生产装配链（scripts/ask-runtime.ts 两处消费点）把 profile.root 作为可信来源传入；
 *   ⑤ 反向绊线：去掉注入（undefined / 不传字段）时约束文本必须不存在——
 *     若有人删除注入实现，①③ 的存在性断言即红。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createSession,
  renderWorkerSystemPrompt,
  WORKER_SYSTEM_PROMPT,
} from './src/execution-runtime';
import type { DriverMessage, TurnDriver, TurnDriverResult } from './src/driver-contract';
import type { ExecutionClient } from '@fshine/contracts/execution-contract';
import type { CapabilityManifest, ExecutionOutcome } from '@fshine/contracts/execution-contract';

const TRUSTED_ROOT = '/trusted/root';

/** 约束语义关键句（钉死语义，防措辞漂移丢义）。 */
const CONSTRAINT_PHRASES = [
  `你的可信工作目录是：${TRUSTED_ROOT}`,
  '不要主动访问该目录之外的文件',
  '不要读取宿主配置、凭据、其他项目或用户主目录',
  '该约束同样适用于你启动的任何子进程',
] as const;

/** 现行 Worker 提示的内联锚（逐字节防漂移用，与 ② 的全量比对互补）。 */
const BASE_PROMPT_ANCHOR = '你是 fshine 的办事 Worker：宿主把一项平台任务委派给你，你在一个受信工作区里工作。';

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

describe('renderWorkerSystemPrompt：可信工作目录注入', () => {
  it('传入可信路径时包含该路径与全部约束语义关键句', () => {
    const rendered = renderWorkerSystemPrompt(TRUSTED_ROOT);
    for (const phrase of CONSTRAINT_PHRASES) {
      expect(rendered).toContain(phrase);
    }
  });

  it('不传参时与现行 WORKER_SYSTEM_PROMPT 逐字节相等（缺省零回归）', () => {
    expect(renderWorkerSystemPrompt()).toBe(WORKER_SYSTEM_PROMPT);
    expect(renderWorkerSystemPrompt(undefined)).toBe(WORKER_SYSTEM_PROMPT);
  });

  it('现行基线提示含内联锚（防整段被悄悄改写）', () => {
    expect(WORKER_SYSTEM_PROMPT).toContain(BASE_PROMPT_ANCHOR);
    expect(WORKER_SYSTEM_PROMPT).not.toContain('可信工作目录是');
  });

  it('反向绊线：去掉注入（undefined）时约束文本不存在', () => {
    const rendered = renderWorkerSystemPrompt(undefined);
    for (const phrase of CONSTRAINT_PHRASES) {
      expect(rendered).not.toContain(phrase);
    }
  });
});

describe('createSession：workerWorkspaceRoot 传到 Worker 提示', () => {
  it('注入 workerWorkspaceRoot 后 workerDriver 收到含该路径的 systemPrompt', async () => {
    const worker = capturingDriver();
    const session = await createSession({
      principalId: 'wecom:test-user',
      sessionId: 'sess_wp',
      client: new FakeClient(),
      allowedOperations: ['dummy.query'],
      mainDriver: delegatingMainDriver(),
      workerDriver: worker.driver,
      mainSystemPrompt: '你是测试主 Agent。',
      workerWorkspaceRoot: TRUSTED_ROOT,
    });
    await session.send('查一下');
    expect(worker.prompts().length).toBeGreaterThan(0);
    for (const prompt of worker.prompts()) {
      expect(prompt).toContain(TRUSTED_ROOT);
      expect(prompt).toContain('不要主动访问该目录之外的文件');
    }
  });

  it('不传 workerWorkspaceRoot 时提示与现行常量逐字节相等（既有路径不回归）', async () => {
    const worker = capturingDriver();
    const session = await createSession({
      principalId: 'wecom:test-user',
      sessionId: 'sess_wp2',
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
  it('scripts/ask-runtime.ts 的两个消费点均传 workerWorkspaceRoot: input.profile.root', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../scripts/ask-runtime.ts', import.meta.url)),
      'utf8',
    );
    expect(source.match(/workerWorkspaceRoot: input\.profile\.root/g)?.length ?? 0).toBe(2);
  });
});
