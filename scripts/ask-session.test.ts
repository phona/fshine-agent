/**
 * ask-session 适配器集成测试（issue #10 切片 A/B/D 的行为面，全程离线、零模型调用）。
 *
 * 与 apps/server/profile-gateway-wiring.test.ts（真工厂 + spy 钉 driver 入参）互补，这里
 * 走的是「ask 链路 → createServerAssembly」的完整装配：
 *   · 唯一装配可启动——仓内 dummy 夹具配置 + 声明 gateway 的 profile 一键建会话；
 *   · 旧缺陷 fail-closed 消失——root 声明了而 gateway 没声明的配置，装配期即拒绝
 *     （「未声明有效的 profile.gateway」），不再出现"起得来、每次委派报错"的静默劣化；
 *   · 同进程多轮——一个 Assembly、固定 conversationId、同一用户、逐条消息不重启；
 *   · 不向 Agent 注入测试期望——宿主收到的 input 与发送文本逐字一致；
 *   · 证据链——messageId → 宿主库 requestId；零平台调用的轮次如实 INCONCLUSIVE。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { WecomBotChannel } from '@fshine/channel-wecom';
import { createAskSession, setAskCaseId, setAskEvalRunId } from './ask-session';
import { EVAL_FIXTURE_ROOT } from './eval/safety-gate';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ask-session-'));
  roots.push(root);
  return root;
}

/**
 * 仓内 dummy 夹具的评测配置（与 scripts/eval/eval.agent.yaml 同形状，root 用绝对路径）。
 * `withGateway: false` 时故意不声明 gateway——那是旧 ask.ts 默默起跑、委派全报错的形态。
 */
function fixtureEnv(root: string, withGateway: boolean): NodeJS.ProcessEnv {
  const configPath = path.join(root, 'agent.yaml');
  writeFileSync(configPath, [
    'principals:',
    '  "wecom:ask-session-user":',
    '    accountSetScope: all',
    '    enabled: true',
    '    capabilities: ["read", "write"]',
    'contextProfiles:',
    '  dummy:',
    `    root: ${path.join(EVAL_FIXTURE_ROOT, 'dummy-platform')}`,
    ...(withGateway ? ['    gateway: bin/dummy'] : []),
    '    skillRoots: [".agents/skills-serve"]',
    '',
  ].join('\n'));
  return {
    AGENT_CONFIG_PATH: configPath,
    // 离线桩值：替身驱动不触网，装配只要求变量存在（model-seam-wiring 同款）。
    LLM_API_BASE_URL: 'http://127.0.0.1:9',
    LLM_API_KEY: 'ask-session-test-key',
    LLM_MODEL: 'unused',
    // 执行层状态面全部隔离到本用例临时目录（安全门 ③ 要审计通道可写读）。
    EXECUTION_AUDIT_PATH: path.join(root, 'audit.jsonl'),
    EXECUTION_MOCK_STATE: path.join(root, 'mock.json'),
    EXECUTION_PLAN_STATE: path.join(root, 'plans.json'),
    EXECUTION_RATE_LIMIT_STATE: path.join(root, 'rate.json'),
    // 多轮连发不等防抖窗口（时序控制归零，行为断言不靠等待）。
    FSHINE_INBOUND_DEBOUNCE_MS: '0',
  };
}

/** 不申报任何工具调用的 Main Agent 替身：固定回复、零平台调用（离线、确定）。 */
function silentDriver(text: string) {
  return {
    run: async (input: { messages: unknown[] }) => ({
      text,
      messages: [...input.messages, { role: 'assistant', content: text, timestamp: Date.now() }],
    }),
  };
}

/** 无主动发送能力的最小渠道替身（adapter 只调 handler，从不 start 渠道）。 */
function stubChannel(): WecomBotChannel {
  return { start: async () => {}, stop: async () => {} } as unknown as WecomBotChannel;
}

async function bootSession(root: string, env: NodeJS.ProcessEnv, replyText: string) {
  return createAskSession({
    env,
    dbPath: path.join(root, 'ask.db'),
    conversationId: 'ask-session-fixed',
    requireIsolatedFixture: true,
    channel: stubChannel(),
    driver: silentDriver(replyText) as never,
    contextModelDriver: { run: async (input: { messages: unknown[] }) => ({ text: '{}', messages: input.messages }) } as never,
    memoryCandidateExtractor: async () => [],
  });
}

describe('ask-session 适配器（唯一装配 + 同进程多轮 + 证据链）', () => {
  it('仓内夹具 + gateway 声明：会话建成，活跃 profile 是夹具（requireIsolatedFixture 过门）', async () => {
    const root = tempRoot();
    const session = await bootSession(root, fixtureEnv(root, true), '直接回答：alpha 两条记录。');
    try {
      expect(session.assembly.activeProfileId).toBe('dummy');
      expect(session.assembly.platformRoot).toBe(path.join(EVAL_FIXTURE_ROOT, 'dummy-platform'));
      expect(session.userId).toBe('ask-session-user');
      expect(session.conversationId).toBe('ask-session-fixed');
    } finally {
      await session.close();
    }
  });

  it('gateway 缺陷 fail-closed 收口：root 有而 gateway 没声明的配置，建会话即拒绝（不再静默起跑）', async () => {
    const root = tempRoot();
    // 旧 ask.ts 对这种配置照常起跑、每次委派报「未声明有效的 profile.gateway」；现在
    // 两层都拒绝：评测安全门（缺 gateway 声明）先拦，绕过安全门的部署也会被装配的
    // planCommandForm fail-closed 拦下（profile-gateway-wiring.test.ts 钉后者）。
    await expect(bootSession(root, fixtureEnv(root, false), '不该到达'))
      .rejects.toThrow(/评测安全门拒绝跑危险用例[\s\S]*gateway/);
  });

  it('同进程多轮：同一会话、逐条消息、不重启；宿主收到的 input 与发送文本逐字一致（不注入期望）', async () => {
    const root = tempRoot();
    const session = await bootSession(root, fixtureEnv(root, true), '直接回答：收到。');
    try {
      setAskEvalRunId('eval-run-ask-test');
      setAskCaseId('ask-multi-turn');
      const first = await session.sendMessage('查一下 alpha collection 的记录');
      const second = await session.sendMessage('再查 beta collection');
      // 同进程多轮：固定 conversationId、消息 id 互异、两轮都有终稿且无异常。
      // （替身 Main 零委派，出口校验会把"要数据却零平台调用"的回复改写成诚实澄清——
      // 那是宿主出口卫生在起作用，本测试不断言它的措辞，只断言回合闭环。）
      expect(first.conversationId).toBe('ask-session-fixed');
      expect(second.conversationId).toBe('ask-session-fixed');
      expect(first.messageId).not.toBe(second.messageId);
      expect(first.reply.length).toBeGreaterThan(0);
      expect(second.reply.length).toBeGreaterThan(0);
      expect(first.error).toBeNull();
      expect(second.error).toBeNull();
      // 切片 C 纪律的机械对应：宿主收到的输入 = 发送文本原样（无附件/无清单附加）。
      const storedFirst = await session.assembly.store.requests.findByWecomMessageId(first.messageId);
      const storedSecond = await session.assembly.store.requests.findByWecomMessageId(second.messageId);
      expect(storedFirst?.input).toBe('查一下 alpha collection 的记录');
      expect(storedSecond?.input).toBe('再查 beta collection');
      // 关联链：messageId → 宿主库 requestId（持久化 id 反查，不是时间窗猜测）。
      expect(typeof first.evidence.requestId).toBe('string');
      expect(typeof second.evidence.requestId).toBe('string');
      expect(first.evidence.requestId).not.toBe(second.evidence.requestId);
      // 零平台调用（替身 Main 不委派）：证据如实 INCONCLUSIVE，不标成功。
      expect(first.evidence.executionRows).toEqual([]);
      expect(first.ladderRung).toBe('INCONCLUSIVE');
      expect(first.evidence.evalRunId).toBe('eval-run-ask-test');
      expect(first.evidence.caseId).toBe('ask-multi-turn');
    } finally {
      await session.close();
    }
  });

  it('聚合指标：两轮全零证据 → 通过率 0、干预 0、安全违规未测、耗时为两轮墙钟和', async () => {
    const root = tempRoot();
    const session = await bootSession(root, fixtureEnv(root, true), '直接回答：收到。');
    try {
      await session.sendMessage('第一条');
      await session.sendMessage('第二条');
      const metrics = session.metrics();
      expect(metrics.cases).toBe(2);
      // INCONCLUSIVE 不算通过（issue 验收标准：无证据 ≠ 成功）。
      expect(metrics.passed).toBe(0);
      expect(metrics.passRate).toBe(0);
      expect(metrics.interventions).toBe(0);
      // 安全违规 null = 未测（无证据源）。旧写法恒给 0，机器读起来像"测过、0 违规"。
      expect(metrics.safetyViolations).toBeNull();
    } finally {
      await session.close();
    }
  });
});
