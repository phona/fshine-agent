/**
 * W1 执行层身份面 golden（C1 表征先行，F1）。
 *
 * 目的：动代码之前把当前身份面的每一个实例字样钉成 golden——后续每个 commit 只翻转
 * 本 commit 拥有的 describe 块，红了能归因到具体常量（F4），不整树查。
 *
 * 覆盖（按 W1 方案 C1 清单）：
 *   · C2 块：执行层称谓 DEFAULT_EXECUTOR_LABEL / SYSTEM_PROMPT（system-prompt.ts）
 *   · C3 块：委派工具名 RUN_EXECUTION_TASK_TOOL（context.ts:54）
 *   · C4 块：委派工具描述与 schema 两条 description（context.ts:81 / :467-468）
 *   · C5 块：profileId 缺省 '17dz'（context.ts:752）
 *   · C6 块：用户可见与运维文案（error-codes.ts:352-353、plan-confirmation-route.ts:87/94、
 *     context.ts resolveContextProfile 五条 + 1414/1455、plan-runtime.ts CLI 失败文案）
 *   · C7 块：网关名 GATEWAY_INVOCATION 与 resolveGatewayText 回退、planDraftExample/
 *     planFileExample 无参输出、CORRECT_PLAN_SHAPE（经 PLAN_SHAPE_PREFIX 渲染）
 *
 * 归属纪律（F4）：每个块的头部注释写明翻转它的 commit。改生产代码时只翻自己那块，
 * 其余断言一条不动；翻转清单写进各 commit message。
 *
 * SYSTEM_PROMPT 的**全文**逐字节冻结不在本文件复制第二份（L2 单一来源）：权威在
 * system-prompt.test.ts 的 D-122 frozen base64，本块只钉称谓常量与"称谓在提示词里
 * 恰好出现一次"的结构事实。
 *
 * 取值口径：全部为 C1 落地时（波次 2 之后 HEAD，merge 7ba775d）的实测当前值。注意
 * 波次 1 脱敏已把部分 "17dz 平台" 字样换成 "幻账平台"（如 RUN_EXECUTION_TASK_DESCRIPTION
 * 首行、plan-confirmation-route 的 fail-loud 文案）——golden 钉的是**当前树实况**，
 * 不是方案文本里的旧值。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextProfileConfig, PlatformTaskRecord, PlatformTaskRepo, TrustedContext } from '@fshine/contracts';
import {
  buildRunExecutionTaskDescription,
  buildRunExecutionTaskSchema,
  createContextTaskRunner,
  DELEGATION_CANCELLED,
  DELEGATION_EXECUTOR_FAILURE,
  RUN_EXECUTION_TASK_DESCRIPTION,
  RUN_EXECUTION_TASK_SCHEMA,
  RUN_EXECUTION_TASK_TOOL,
} from './src/context';
import { messageFor, planDraftExample, planFileExample } from './src/error-codes';
import { resolveActiveProfileId } from '@fshine/contracts';
import { resolveGatewayText } from './src/platform-contract';
import { DEFAULT_EXECUTOR_LABEL, SYSTEM_PROMPT, buildSystemPrompt } from './src/system-prompt';
import { evaluateAndActivatePlan, type PlanCliRunner } from './src/plan-runtime';
import { ToolUserError, type TurnDriver, type TurnDriverInput } from './src/driver';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class MemoryTasks implements PlatformTaskRepo {
  readonly records = new Map<string, PlatformTaskRecord>();
  async get(taskId: string) { return this.records.get(taskId) ?? null; }
  async upsert(record: PlatformTaskRecord) { this.records.set(record.taskId, structuredClone(record)); }
  async listBySession() { return []; }
}

function trusted(sessionId = 'session-1', principalId = 'wecom:user-1'): TrustedContext {
  return { requestId: 'req-1', principalId, sessionId };
}

async function profileRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-identity-'));
  roots.push(root);
  await mkdir(path.join(root, '.agents', 'skills'), { recursive: true });
  await writeFile(path.join(root, '.agents', 'skills', 'SKILL.md'), '---\nname: skill\ndescription: 工作规范\n---\n正文。\n');
  return root;
}

function scriptedDriver(text: string): TurnDriver {
  return { run: async (input: TurnDriverInput) => ({ text, messages: input.messages }) };
}

function readSrc(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('W1 执行层身份面 golden（C1 冻结）', () => {
  // ── C2 归属块：称谓参数化（DEFAULT_EXECUTOR_LABEL 中性缺省 + profile.executorLabel）──
  describe('C2 块：执行层称谓（system-prompt.ts）', () => {
    it('DEFAULT_EXECUTOR_LABEL 当前值（C2 起中性缺省）', () => {
      expect(DEFAULT_EXECUTOR_LABEL).toBe('执行层子 Agent');
      expect(DEFAULT_EXECUTOR_LABEL).not.toContain('17dz');
    });

    it('SYSTEM_PROMPT = buildSystemPrompt(缺省称谓)，且称谓恰好出现一次', () => {
      expect(SYSTEM_PROMPT).toBe(buildSystemPrompt(DEFAULT_EXECUTOR_LABEL));
      expect(SYSTEM_PROMPT.split(DEFAULT_EXECUTOR_LABEL)).toHaveLength(2);
      expect(SYSTEM_PROMPT).toContain(`申报 delegate 后由宿主把加工后的请求委派 ${DEFAULT_EXECUTOR_LABEL} 执行。`);
    });

    it('注入实例称谓时委派句随参数替换（财税部署经 profile.executorLabel 声明）', () => {
      expect(buildSystemPrompt('17dz 子 Agent')).toContain('委派 17dz 子 Agent 执行');
    });

    // 恢复回合整理提示词与 :149 同一模板块（runtime.ts）：C2 同commit翻转，避免 F4
    // 归因撕裂——两条 17dz 字面量随该块一起去实例名。
    it('恢复回合整理提示词两条话术已去实例名（runtime.ts，源码逐字）', () => {
      const src = readSrc('packages/agent/src/runtime.ts');
      expect(src).toContain('本轮子任务按用户确认重跑后没有产生任何平台执行。');
      expect(src).toContain('本轮子任务已由宿主根据用户确认的计划执行完毕。');
      expect(src).not.toContain('本轮 17dz 子任务');
    });
  });

  // ── C3 归属块：委派工具名参数化（RUN_EXECUTION_TASK_TOOL 中性缺省 + profile.toolName）──
  describe('C3 块：委派工具名（context.ts）', () => {
    it('RUN_EXECUTION_TASK_TOOL 当前值（C3 起中性缺省）', () => {
      expect(RUN_EXECUTION_TASK_TOOL).toBe('run_task');
      expect(RUN_EXECUTION_TASK_TOOL).not.toContain('17dz');
    });

    it('runner.tool.name 随 profile.toolName 声明；未声明走中性缺省', async () => {
      const root = await profileRoot();
      const declared = createContextTaskRunner({
        profiles: { '17dz': { root, skillRoots: ['.agents/skills'], toolName: 'run_17dz_task' } },
        tasks: new MemoryTasks(),
        workerDriver: scriptedDriver('完成。'),
      });
      expect(declared.tool.name).toBe('run_17dz_task');
      const neutral = createContextTaskRunner({
        profiles: { '17dz': { root, skillRoots: ['.agents/skills'] } },
        tasks: new MemoryTasks(),
        workerDriver: scriptedDriver('完成。'),
      });
      expect(neutral.tool.name).toBe('run_task');
    });
  });

  // ── C4 归属块：委派工具描述与 schema 中性化（业务语义出宿主，称谓槽注入）──
  describe('C4 块：委派工具描述与 schema（context.ts）', () => {
    it('RUN_EXECUTION_TASK_DESCRIPTION 缺省全文逐字（C4 起中性，称谓=中性缺省）', () => {
      expect(RUN_EXECUTION_TASK_DESCRIPTION).toBe([
        '当用户的问题需要访问或处理执行层平台的实时数据时，将任务委托给 执行层子 Agent。',
        '执行层子 Agent 在受信的工作目录中加载平台 Skill，并返回自然语言结果。',
        '你负责理解该结果：可以直接回答用户、把子 Agent 的问题转达给用户，或携带 taskId 继续同一个任务。',
        '涉及执行层实时数据时必须调用本工具，不得凭历史对话猜测平台标识或实时结果。',
        '继续同一任务时传入此前返回的 taskId，并把用户最新补充完整放入 request；新任务不要复用 taskId。',
      ].join('\n'));
      expect(RUN_EXECUTION_TASK_DESCRIPTION).not.toContain('17dz');
      expect(RUN_EXECUTION_TASK_DESCRIPTION).not.toContain('幻账');
      expect(RUN_EXECUTION_TASK_DESCRIPTION).not.toContain('财税');
    });

    it('RUN_EXECUTION_TASK_SCHEMA 两条 description 缺省逐字（C4 起中性）', () => {
      const properties = RUN_EXECUTION_TASK_SCHEMA.properties as Record<string, { description?: string }>;
      expect(properties.request?.description).toBe('交给 执行层子 Agent 的完整任务或用户最新补充');
      expect(properties.taskId?.description).toBe('仅在继续此前子任务时使用返回的 taskId');
      expect(JSON.stringify(RUN_EXECUTION_TASK_SCHEMA)).not.toContain('17dz');
    });

    it('注入实例称谓时描述与 schema 逐字节（称谓槽唯一可变点，F6 豁免论证的锚点）', () => {
      const label = '17dz 子 Agent';
      const description = buildRunExecutionTaskDescription(label);
      expect(description).toBe([
        '当用户的问题需要访问或处理执行层平台的实时数据时，将任务委托给 17dz 子 Agent。',
        '17dz 子 Agent 在受信的工作目录中加载平台 Skill，并返回自然语言结果。',
        '你负责理解该结果：可以直接回答用户、把子 Agent 的问题转达给用户，或携带 taskId 继续同一个任务。',
        '涉及执行层实时数据时必须调用本工具，不得凭历史对话猜测平台标识或实时结果。',
        '继续同一任务时传入此前返回的 taskId，并把用户最新补充完整放入 request；新任务不要复用 taskId。',
      ].join('\n'));
      const schema = buildRunExecutionTaskSchema(label);
      const properties = schema.properties as Record<string, { description?: string }>;
      expect(properties.request?.description).toBe('交给 17dz 子 Agent 的完整任务或用户最新补充');
      expect(properties.taskId?.description).toBe('仅在继续此前子任务时使用返回的 taskId');
    });

    it('runner.tool.description/inputSchema 随 profile.executorLabel 声明；未声明走中性缺省', async () => {
      const root = await profileRoot();
      const declared = createContextTaskRunner({
        profiles: { '17dz': { root, skillRoots: ['.agents/skills'], executorLabel: '17dz 子 Agent' } },
        tasks: new MemoryTasks(),
        workerDriver: scriptedDriver('完成。'),
      });
      expect(declared.tool.description).toContain('17dz 子 Agent');
      expect(declared.tool.description).not.toContain('幻账');
      expect((declared.tool.inputSchema as { properties: Record<string, { description?: string }> }).properties['request']?.description).toBe('交给 17dz 子 Agent 的完整任务或用户最新补充');
      const neutral = createContextTaskRunner({
        profiles: { '17dz': { root, skillRoots: ['.agents/skills'] } },
        tasks: new MemoryTasks(),
        workerDriver: scriptedDriver('完成。'),
      });
      expect(neutral.tool.description).toBe(RUN_EXECUTION_TASK_DESCRIPTION);
      expect(neutral.tool.inputSchema).toEqual(RUN_EXECUTION_TASK_SCHEMA);
    });
  });

  // ── C5 归属块：profileId 缺省去实例名（resolveActiveProfileId 派生）──
  describe('C5 块：profileId 缺省（context.ts + contracts）', () => {
    it('resolveActiveProfileId：显式优先；单 profile → 其键；零/多 → undefined', () => {
      const p = { root: '/tmp/x', skillRoots: [] };
      expect(resolveActiveProfileId({ generic: p }, 'explicit')).toBe('explicit');
      expect(resolveActiveProfileId({ generic: p })).toBe('generic');
      expect(resolveActiveProfileId({})).toBeUndefined();
      expect(resolveActiveProfileId({ a: p, b: p })).toBeUndefined();
      // 多 profile 时显式指定仍然生效（显式优先于 fail-closed）。
      expect(resolveActiveProfileId({ a: p, b: p }, 'b')).toBe('b');
    });

    it('单 profile 部署：不显式传 profileId → 派生其键，任务照常跑（键名无关）', async () => {
      const root = await profileRoot();
      let observedCwd: string | undefined;
      const subagent = createContextTaskRunner({
        profiles: { generic: { root, skillRoots: ['.agents/skills'] } },
        tasks: new MemoryTasks(),
        workerDriver: { run: async (input) => { observedCwd = input.cwd; return { text: '完成。', messages: input.messages }; } },
      });
      const result = await subagent.run({ request: '查询余额' }, { trusted: trusted() });
      expect(result.text).toBe('完成。');
      expect(observedCwd).toBe(root);
    });

    it('零 profile → 消费方 fail-closed（新中性拒绝文案，不点名任何实例）', async () => {
      const root = await profileRoot();
      const subagent = createContextTaskRunner({
        profiles: {},
        tasks: new MemoryTasks(),
        workerDriver: scriptedDriver('完成。'),
      });
      await expect(subagent.run({ request: '查询余额' }, { trusted: trusted() }))
        .rejects.toThrow('未指定执行层 profile：contextProfiles 为空或有多个时，必须显式指定 profileId。');
    });

    it('多 profile 且未显式指定 → 同样 fail-closed（不静默挑一个）', async () => {
      const root = await profileRoot();
      const subagent = createContextTaskRunner({
        profiles: {
          generic: { root, skillRoots: ['.agents/skills'] },
          other: { root, skillRoots: ['.agents/skills'] },
        },
        tasks: new MemoryTasks(),
        workerDriver: scriptedDriver('完成。'),
      });
      await expect(subagent.run({ request: '查询余额' }, { trusted: trusted() }))
        .rejects.toThrow('未指定执行层 profile');
    });

    it('多 profile 且显式指定 → 显式值生效', async () => {
      const root = await profileRoot();
      const subagent = createContextTaskRunner({
        profiles: {
          generic: { root, skillRoots: ['.agents/skills'] },
          other: { root, skillRoots: ['.agents/skills'] },
        },
        profileId: 'other',
        tasks: new MemoryTasks(),
        workerDriver: scriptedDriver('完成。'),
      });
      const result = await subagent.run({ request: '查询余额' }, { trusted: trusted() });
      expect(result.text).toBe('完成。');
    });

    it('单 profile 但显式传了未配置的 profileId → 未命中拒绝（显式不换校验；文案逐字归 C6 块）', async () => {
      const root = await profileRoot();
      const subagent = createContextTaskRunner({
        profiles: { generic: { root, skillRoots: ['.agents/skills'] } },
        profileId: 'missing',
        tasks: new MemoryTasks(),
        workerDriver: scriptedDriver('完成。'),
      });
      await expect(subagent.run({ request: '查询余额' }, { trusted: trusted() }))
        .rejects.toThrow();
    });
  });

  // ── C6 归属块：用户可见与运维文案去实例名（错误码/确认路由/CLI 失败/上下文 profile）──
  describe('C6 块：用户可见与运维文案', () => {
    it('委派失败两条用户话术（C6 起中性，error-codes.ts）', () => {
      expect(DELEGATION_EXECUTOR_FAILURE).toBe('子任务执行失败，请稍后再试。');
      expect(DELEGATION_CANCELLED).toBe('子任务已取消。');
      expect(DELEGATION_EXECUTOR_FAILURE).not.toContain('17dz');
      expect(DELEGATION_CANCELLED).not.toContain('17dz');
    });

    it('resolveContextProfile 四条拒绝文案逐字（C6 起中性，显式 profileId 路径）', async () => {
      const root = await profileRoot();
      const cases: Array<{ name: string; profileId: string; profiles: Record<string, ContextProfileConfig>; expected: string }> = [
        {
          name: 'profile 未配置',
          profileId: 'missing',
          profiles: {},
          expected: '未配置执行层上下文 profile:missing',
        },
        {
          name: '上下文目录不可用',
          profileId: '17dz',
          profiles: { '17dz': { root: path.join(os.tmpdir(), 'fshine-identity-missing-dir-xyz'), skillRoots: [] } },
          expected: '执行层上下文目录不可用:17dz',
        },
        {
          name: 'skillRoots 绝对路径',
          profileId: '17dz',
          profiles: { '17dz': { root, skillRoots: [path.join(os.tmpdir(), 'abs-skill-root')] } },
          expected: 'skillRoots 必须是相对 root 的路径。',
        },
        {
          name: 'skillRoots 逃逸 root',
          profileId: '17dz',
          profiles: { '17dz': { root, skillRoots: ['../escape-skill-root'] } },
          expected: 'skillRoots 未通过路径安全校验。',
        },
      ];
      for (const { name, profileId, profiles, expected } of cases) {
        const subagent = createContextTaskRunner({
          profileId,
          profiles,
          tasks: new MemoryTasks(),
          workerDriver: scriptedDriver('完成。'),
        });
        await expect(subagent.run({ request: '查询余额' }, { trusted: trusted() }), name).rejects.toThrow(expected);
      }
    });

    it('worker exec 拒绝与空文本两条内部话术（context.ts:1414/1455）', async () => {
      const root = await profileRoot();
      let execError: unknown;
      const subagent = createContextTaskRunner({
        profiles: { '17dz': { root, skillRoots: ['.agents/skills'] } },
        tasks: new MemoryTasks(),
        workerDriver: {
          run: async (input) => {
            try { await input.exec('read', { path: 'x' }); } catch (error) { execError = error; }
            return { text: '完成。', messages: input.messages };
          },
        },
      });
      await subagent.run({ request: '查询余额' }, { trusted: trusted() });
      expect(execError).toBeInstanceOf(ToolUserError);
      expect((execError as Error).message).toBe('子 Agent 只能使用其工作目录内配置的原生工具。');

      // 空文本检查抛的内部话术不进用户回复（用户拿到 DELEGATION_EXECUTOR_FAILURE），
      // 可观测面是 subagent_task_failed 事件的 error 字段（context.test.ts:1118 同形）。
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const emptyText = createContextTaskRunner({
          profiles: { '17dz': { root, skillRoots: ['.agents/skills'] } },
          tasks: new MemoryTasks(),
          workerDriver: scriptedDriver('   '),
        });
        await expect(emptyText.run({ request: '查询余额' }, { trusted: trusted() }))
          .rejects.toThrow('子任务执行失败，请稍后再试。');
        const failures = errorSpy.mock.calls.map((args) => JSON.parse(String(args[0]))).filter((e) => e.event === 'subagent_task_failed');
        expect(failures.at(-1)).toMatchObject({ error: '子 Agent 未返回可用结果。' });
      } finally {
        infoSpy.mockRestore();
        errorSpy.mockRestore();
      }
      // 同处 :1455 的中止分支话术与 DELEGATION_CANCELLED 是同一字符串（用户侧经错误码
      // 表送达），已由本块上方的话术断言逐字钉住。
    });

    it('plan CLI 失败/无效 JSON 两条运维文案（plan-runtime.ts:562/565）', async () => {
      const failing: PlanCliRunner = async () => ({ code: 1, stdout: '', stderr: 'boom' });
      await expect(evaluateAndActivatePlan({
        platformRoot: '/platform', taskId: 'task_1',
        calls: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }],
        runCli: failing,
      })).rejects.toThrow('plan CLI 失败（plan evaluate）：boom');
      const invalidJson: PlanCliRunner = async () => ({ code: 0, stdout: 'not-json', stderr: '' });
      await expect(evaluateAndActivatePlan({
        platformRoot: '/platform', taskId: 'task_1',
        calls: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }],
        runCli: invalidJson,
      })).rejects.toThrow('plan CLI 返回了无效 JSON。');
    });

    it('计划确认路由两条 fail-loud 文案（plan-confirmation-route.ts:87/94，源码逐字）', () => {
      const src = readSrc('apps/server/plan-confirmation-route.ts');
      expect(src).toContain("if (!options.platformRoot) throw new Error('平台根路径未配置');");
      expect(src.split("throw new Error('平台根路径未配置')")).toHaveLength(3);
      expect(src).not.toContain('幻账平台');
    });
  });

  // ── C7 归属块：网关名穿线 + GATEWAY_INVOCATION 退役（resolveGatewayText fail-closed）──
  describe('C7 块：网关名（platform-contract.ts / error-codes.ts）', () => {
    it('GATEWAY_INVOCATION 已退役：resolveGatewayText fail-closed（缺失/非法即抛，合法值原样）', () => {
      expect(() => resolveGatewayText()).toThrow('未声明有效的 profile.gateway');
      expect(() => resolveGatewayText('/abs/gateway')).toThrow('未声明有效的 profile.gateway');
      expect(resolveGatewayText('bin/other')).toBe('bin/other');
      expect(resolveGatewayText('bin/generic')).toBe('bin/generic');
    });

    it('planDraftExample/planFileExample：无参抛错（fail-closed）；显式注入即用注入值', () => {
      expect(() => planDraftExample()).toThrow('未声明有效的 profile.gateway');
      expect(() => planFileExample()).toThrow('未声明有效的 profile.gateway');
      expect(planDraftExample('bin/17dz')).toBe('bin/17dz plan {"goal":"…","calls":[{"operation":"…","args":[…]}]}');
      expect(planFileExample('bin/17dz')).toBe('bin/17dz plan --file <本轮工作区内的计划文件路径>');
      expect(planDraftExample('bin/generic')).toBe('bin/generic plan {"goal":"…","calls":[{"operation":"…","args":[…]}]}');
    });

    it('PLAN_SHAPE_PREFIX 整条渲染（expected 网关名 + correctForm；显式 gateway 注入）', () => {
      expect(messageFor('PLAN_SHAPE_PREFIX', '（围栏）', undefined, 'bin/17dz')).toBe(
        'PLAN_SHAPE_PREFIX: 期望 bin/17dz plan 之前只允许 bash/sh 与路径前缀（围栏、外层引号、客套话都算多出来的内容）；实际 （围栏）；正确形态 方案是单行原始命令：bin/17dz plan {"goal":"…","calls":[{"operation":"…","args":[…]}]}，JSON 原样放在这一行命令里——不要加外层引号、不要跟 2>&1 等后缀、不要拆成多行；或把同一份 JSON 写进本轮工作区文件后以 bin/17dz plan --file <本轮工作区内的计划文件路径> 提交',
      );
      // 渲染 PLAN_* 诊断而不注入 gateway = 部署未声明网关 → 响亮失败（fail-closed 语义）。
      expect(() => messageFor('PLAN_SHAPE_PREFIX', '（围栏）')).toThrow('未声明有效的 profile.gateway');
    });

    it('PLAN_SUBCOMMAND_RESERVED 整条渲染（correctForm 的 planDraftExample；显式注入）', () => {
      expect(messageFor('PLAN_SUBCOMMAND_RESERVED', 'evaluate', undefined, 'bin/17dz')).toBe(
        'PLAN_SUBCOMMAND_RESERVED: 期望 worker 只提交 JSON calls 方案；evaluate / activate / current / status 由宿主调用；实际 evaluate；正确形态 bin/17dz plan {"goal":"…","calls":[{"operation":"…","args":[…]}]}（单行原始命令）',
      );
    });
  });
});
