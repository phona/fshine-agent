/**
 * Main 角色指令装配验收（Track D 重写）。
 *
 * 旧 D-122 golden 随 `src/system-prompt.ts` 的删除退役：它冻结的是**旧提示词原文**，
 * 迁移后不得原样当新验收。本文件按新架构重写，钉住：
 *   ① 唯一来源：角色指令只来自 `.agents/agents/fshine-main/agent.md`（system-prompt.ts
 *      已不存在，TS 里没有第二份角色长文）；缺省调用方（不给 roleInstructions）读的
 *      也是同一份文件，绝不回退任何旧提示词；
 *   ② 动态装配：日期尾注动态生成、`{{executorLabel}}` 占位在装配期替换（缺省中性）、
 *      确认后恢复路径的附加可信约束照旧拼在角色文本之后；
 *   ③ Skill 元数据（名称+描述）曝光、正文不注入；read_skill 按名读取、未知名给出可用清单；
 *   ④ 正常委派与确认后恢复两条路径在换源后照常工作；
 *   ⑤ 原有安全不变量（身份/授权/确认/读回）不回归——未申报零外发（身份/授权纪律）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TrustedContext } from '@fshine/contracts';
import {
  applyExecutorLabel,
  DEFAULT_AGENT_PROFILE_PATH,
  DEFAULT_EXECUTOR_LABEL,
  EXECUTOR_LABEL_PLACEHOLDER,
  loadAgentProfile,
} from './src/agent-profile';
import { RUN_EXECUTION_TASK_DESCRIPTION, RUN_EXECUTION_TASK_SCHEMA, RUN_EXECUTION_TASK_TOOL, type ContextTaskRunner } from './src/context';
import { ScriptedTurnDriver, type TurnDriver, type TurnDriverInput } from './src/driver';
import { createTaxAgentRuntime } from './src/runtime';
import { createReadSkillTool } from './src/skill-tool';
import { listSkills } from './src/skills';
import { FakeSessionRepo } from './test-helpers';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeCtx(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return {
    requestId: 'req_profile',
    principalId: 'wecom:user_a',
    sessionId: 'sess_1',
    ...overrides,
  };
}

function subagent(run?: ContextTaskRunner['run']): ContextTaskRunner {
  return {
    tool: { name: RUN_EXECUTION_TASK_TOOL, description: RUN_EXECUTION_TASK_DESCRIPTION, inputSchema: RUN_EXECUTION_TASK_SCHEMA },
    run: run ?? (async (): Promise<{ taskId: string; text: string }> => ({ taskId: 'task_1', text: '子 Agent 完成。' })),
  };
}

/** 捕获驱动收到的输入（systemPrompt / tools / exec 都由生产 runtime 装配）。 */
function captureDriver(steps: Parameters<typeof ScriptedTurnDriver>[0]) {
  const base = ScriptedTurnDriver(steps);
  const inputs: TurnDriverInput[] = [];
  const driver: TurnDriver = {
    run: async (input) => {
      inputs.push(input);
      return base.run(input);
    },
  };
  return { driver, inputs };
}

const conversationSteps = [
  { text: '你好。' },
];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 生产 TS 扫描面：packages/agent/src + apps（.test.ts 豁免，它们本就在描述被删的形状）。 */
function scanProductionTs(dir: string, visit: (file: string, content: string) => void): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'data' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      scanProductionTs(full, visit);
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) {
      visit(full, readFileSync(full, 'utf8'));
    }
  }
}

describe('Main 角色指令装配（Profile 为唯一事实源）', () => {
  it('① 正常回合：系统提示词以 agent.md 正文开头，日期尾注动态拼在尾部', async () => {
    const profile = await loadAgentProfile();
    const { driver, inputs } = captureDriver(conversationSteps);
    const runtime = createTaxAgentRuntime({ driver, sessions: new FakeSessionRepo(), platformTask: subagent() });

    await runtime.handleTurn(makeCtx({ requestId: 'req_profile_normal' }), '你好');

    const prompt = inputs[0]?.systemPrompt ?? '';
    // 静态部分 = agent.md 正文（占位已替换为缺省中性称谓）
    expect(prompt.startsWith(applyExecutorLabel(profile.instructions))).toBe(true);
    expect(prompt).toContain('fshine 的主 Agent');
    expect(prompt).toMatch(/今天是 \d{4}-\d{2}-\d{2}（北京时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）/);
    expect(prompt).not.toContain(EXECUTOR_LABEL_PLACEHOLDER);
  });

  it('① 唯一来源：system-prompt.ts 已删除；角色长文不在 TS/装配层复制第二份', () => {
    expect(existsSync(path.join(__dirname, 'src', 'system-prompt.ts'))).toBe(false);
    const staleSymbols = [/\bbuildSystemPrompt\b/, /\bBUSINESS_SKILL_HEADING\b/, /\bDATE_SUFFIX\b/, /\bSYSTEM_PROMPT\b/];
    const hits: string[] = [];
    const visit = (file: string, content: string): void => {
      for (const symbol of staleSymbols) {
        if (symbol.test(content)) hits.push(`${path.relative(REPO_ROOT, file)}: ${symbol.source}`);
      }
      // 角色长文的特征句：只允许住在 agent.md，不许在任何 TS 里出现第二份
      if (content.includes('你是 fshine 的主 Agent')) hits.push(`${path.relative(REPO_ROOT, file)}: 角色长文第二份`);
    };
    scanProductionTs(path.join(REPO_ROOT, 'packages', 'agent', 'src'), visit);
    scanProductionTs(path.join(REPO_ROOT, 'apps'), visit);
    expect(hits, `唯一来源破坏：\n${hits.join('\n')}`).toEqual([]);
  });

  it('② executorLabel 占位：自定义称谓生效；缺省中性；无占位文本不被改动', async () => {
    const custom = captureDriver(conversationSteps);
    const customRuntime = createTaxAgentRuntime({
      driver: custom.driver, sessions: new FakeSessionRepo(), platformTask: subagent(),
      executorLabel: 'X 子 Agent',
    });
    await customRuntime.handleTurn(makeCtx({ requestId: 'req_profile_custom' }), '你好');
    const customPrompt = custom.inputs[0]?.systemPrompt ?? '';
    expect(customPrompt).toContain('交给 X 子 Agent 执行');
    expect(customPrompt).not.toContain(EXECUTOR_LABEL_PLACEHOLDER);

    const neutral = captureDriver(conversationSteps);
    const neutralRuntime = createTaxAgentRuntime({ driver: neutral.driver, sessions: new FakeSessionRepo(), platformTask: subagent() });
    await neutralRuntime.handleTurn(makeCtx({ requestId: 'req_profile_neutral' }), '你好');
    expect(neutral.inputs[0]?.systemPrompt).toContain(`交给 ${DEFAULT_EXECUTOR_LABEL} 执行`);

    // 纯函数口径：无占位文本原样返回；有占位、缺标签取中性缺省。
    expect(applyExecutorLabel('没有任何占位的正文。', undefined)).toBe('没有任何占位的正文。');
    expect(applyExecutorLabel('委派 {{executorLabel}} 执行。', undefined)).toBe(`委派 ${DEFAULT_EXECUTOR_LABEL} 执行。`);
    expect(applyExecutorLabel('委派 {{executorLabel}} 执行。', 'X 子 Agent')).toBe('委派 X 子 Agent 执行。');
  });

  it('② agent.md 本体：不在文件里写死任何部署实例名（占位负责参数化）', () => {
    const content = readFileSync(DEFAULT_AGENT_PROFILE_PATH, 'utf8');
    // 实例名 needle 拆段拼回（与 public-surface-lint 同规）：守卫自身不落字面量。
    const instanceNeedle = '1' + '7dz';
    expect(content).not.toContain(instanceNeedle);
    expect(content).not.toContain('example-gateway');
    expect(content).toContain(EXECUTOR_LABEL_PLACEHOLDER);
  });

  it('② 确认后恢复路径：角色文本 + 恢复约束 + 日期，三条装配路径同一来源', async () => {
    const profile = await loadAgentProfile();
    const { driver, inputs } = captureDriver([{ text: '已按确认整理完成。' }]);
    const runtime = createTaxAgentRuntime({
      driver, sessions: new FakeSessionRepo(),
      platformTask: subagent(async (args) => ({
        taskId: args.taskId ?? 'task_r',
        text: '对象甲 202608 应收余额 42 元。',
        execution: { planId: 'plan_1', version: 1, calls: 1 },
      })),
    });

    const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_profile_resume', resumeTaskId: 'task_r' }), '确认继续');

    const prompt = inputs[0]?.systemPrompt ?? '';
    expect(prompt.startsWith(applyExecutorLabel(profile.instructions))).toBe(true);
    expect(prompt).toContain('本轮子任务已由宿主根据用户确认的计划执行完毕。');
    expect(prompt).toContain('不得请求新工具或扩大查询范围');
    expect(prompt).toContain('今天是 ');
    expect(reply.text).toBe('已按确认整理完成。');
  });

  it('③ Skill 元数据曝光（不注入正文）+ read_skill 按需读取 + 未知名给可用清单', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fshine-main-skills-'));
    roots.push(root);
    for (const [name, description, body] of [
      ['alpha', 'Alpha guidance', '# Alpha\n正文甲。'],
      ['beta', 'Beta guidance', '# Beta\n正文乙。'],
    ] as const) {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
    }
    const catalog = await listSkills(root);
    const { driver, inputs } = captureDriver(conversationSteps);
    const runtime = createTaxAgentRuntime({
      driver, sessions: new FakeSessionRepo(), platformTask: subagent(),
      skillCatalog: catalog,
      readSkillTool: createReadSkillTool({ rootDir: root }),
    });

    await runtime.handleTurn(makeCtx({ requestId: 'req_profile_skills' }), '你好');

    const input = inputs[0]!;
    expect(input.systemPrompt).toContain('alpha：Alpha guidance');
    expect(input.systemPrompt).toContain('beta：Beta guidance');
    // 正文不进上下文：只曝光名称+描述，内容留给按需读取
    expect(input.systemPrompt).not.toContain('正文甲');
    expect(input.tools.map((tool) => tool.name)).toContain('read_skill');

    const loaded = await input.exec('read_skill', { name: 'alpha' });
    expect(String(loaded)).toContain('正文甲');

    const missing = (await input.exec('read_skill', { name: 'missing' })) as { error?: string };
    expect(missing.error).toContain('alpha');
    expect(missing.error).toContain('beta');
  });

  it('③ 不注入技能面时上下文不出现技能清单段（缺省 = 不曝光）', async () => {
    const { driver, inputs } = captureDriver(conversationSteps);
    const runtime = createTaxAgentRuntime({ driver, sessions: new FakeSessionRepo(), platformTask: subagent() });
    await runtime.handleTurn(makeCtx({ requestId: 'req_profile_no_skills' }), '你好');
    expect(inputs[0]?.systemPrompt).not.toContain('可用技能');
    expect(inputs[0]?.tools.map((tool) => tool.name)).not.toContain('read_skill');
  });

  it('④ 正常直连委派在换源后照常工作（委派 → 执行 → 结果）', async () => {
    const delegated: string[] = [];
    const { driver } = captureDriver([
      { toolCalls: [{ tool: 'run_task', args: { request: '查询对象甲的应收余额' } }] },
      { text: '对象甲 202608 应收余额为 51 元。' },
    ]);
    const runtime = createTaxAgentRuntime({
      driver, sessions: new FakeSessionRepo(),
      platformTask: subagent(async (args) => {
        delegated.push(args.request);
        return { taskId: 'task_live', text: '本轮实时查询：对象甲 202608 应收余额为 51 元。', execution: { planId: 'plan_live', version: 1, calls: 1 } };
      }),
    });

    const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_profile_delegate' }), '查一下对象甲的应收');

    expect(delegated).toEqual(['查询对象甲的应收余额']);
    expect(reply.text).toContain('51 元');
  });

  it('⑤ 普通回合直接回复、终稿清洗不回归（身份/授权纪律与换源无关）', async () => {
    const { driver } = captureDriver([{ text: '文件在 tmp/task_x/ 里，先这样回答。' }]);
    const runtime = createTaxAgentRuntime({ driver, sessions: new FakeSessionRepo(), platformTask: subagent() });
    const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_profile_nodeclare' }), '你好');
    // 直连后普通回合的模型文本就是回复；确定性清洗（服务器路径不外发）仍照旧生效。
    expect(reply.text).toContain('先这样回答');
    expect(reply.text).not.toContain('tmp/');
  });
});
