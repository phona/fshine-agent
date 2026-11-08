/**
 * ask CLI 回归测试（issue #10 切片 A 的两条验收钉子）：
 *   ① ask.ts 不再存在第二份生产 Agent 装配代码——手搭接线的四个工厂名
 *     （createPiTurnDriver / createPiCodingTurnDriver / createContextTaskRunner /
 *     createMessageHandler）在 scripts/ask.ts 与 scripts/ask-session.ts 里必须零命中，
 *     唯一装配入口 = apps/server/assembly.ts#createServerAssembly()。
 *   ② CLI 参数仍被解析、用法不退化——单条消息、--conversation、--db、--config= 的
 *     解析语义与旧版逐条一致（含「flag 的值不进 question」「空 question = 用法错误」）。
 *
 * gateway 缺陷（旧 ask.ts 漏传 profile.gateway → 每次委派报「未声明有效的 profile.gateway」）
 * 的回归锁拆两半：a) 本文件钉「ask.ts/ask-session.ts 零 driver 构造 + 装配侧穿线行仍在」；
 * b) apps/server/profile-gateway-wiring.test.ts 用真工厂 + spy 钉「装配真的把 gateway 传进
 * worker 驱动」。两半合起来：删掉装配的穿线行 b) 红；ask 侧重新手搭 driver a) 红。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAskCliArgs } from './ask';

const thisDir = path.dirname(fileURLToPath(import.meta.url));

/** ① 的机械判据（grep 同款，逐文件断言零命中）。 */
const HAND_WIRED_FACTORIES = [
  'createPiTurnDriver',
  'createPiCodingTurnDriver',
  'createContextTaskRunner',
  'createMessageHandler',
] as const;

/** 装配复刻的其他关键件（新设计不应让这份名单再增长）。 */
const ASSEMBLY_REPLICA_PIECES = [
  'createTaxAgentRuntime',
  'createProposalCommitRunner',
  'createPlanConfirmationWiring',
  'loadBusinessSkill',
  'newGateSecret',
  'loadOperationArgSpecs',
] as const;

function sourceOf(rel: string): string {
  return readFileSync(path.join(thisDir, rel), 'utf8');
}

describe('切片 A：ask 走生产装配，无第二份装配代码', () => {
  for (const rel of ['ask.ts', 'ask-session.ts']) {
    it(`${rel} 里不出现手搭接线（${HAND_WIRED_FACTORIES.join(' / ')} 零命中）`, () => {
      const source = sourceOf(rel);
      const hits = HAND_WIRED_FACTORIES.filter((name) => source.includes(name));
      expect(hits, [
        `${rel} 里出现了手搭接线的工厂名：${hits.join('、')}。`,
        '装配唯一来源是 apps/server/assembly.ts#createServerAssembly()——在 ask 侧重新拼',
        'driver/runtime/platformTask/handler 就是「CLI 绿、生产红」漂移的起点（issue #10 目标 1）。',
      ].join('\n')).toEqual([]);
    });

    it(`${rel} 里不出现装配关键件的复刻（${ASSEMBLY_REPLICA_PIECES.join(' / ')} 零命中）`, () => {
      const source = sourceOf(rel);
      const hits = ASSEMBLY_REPLICA_PIECES.filter((name) => source.includes(name));
      expect(hits, `${rel} 复刻了装配件：${hits.join('、')}——接线归 assembly，ask 侧只解析参数与采集证据`).toEqual([]);
    });
  }

  it('ask.ts 是 createServerAssembly 的调用方（唯一装配入口在调用链上）', () => {
    const askSource = sourceOf('ask.ts');
    expect(askSource).toContain('createAskSession(');
    const sessionSource = sourceOf('ask-session.ts');
    expect(sessionSource).toContain('createServerAssembly(');
  });

  it('gateway 穿线回归锁：装配侧仍是唯一把 profile.gateway 传进 worker 驱动的地方', () => {
    const assemblySource = sourceOf(path.join('..', 'apps', 'server', 'assembly.ts'));
    // 这一行就是旧缺陷的修法本体（C7b 穿线）；删除它 profile-gateway-wiring.test.ts 会红，
    // 这里钉「ask 链路上没有第二处 driver 构造」的另一面：穿线行仍在装配里。
    expect(assemblySource).toMatch(/activeProfile\?\.gateway \? \{ gateway: activeProfile\.gateway \}/);
  });
});

describe('切片 A：CLI 参数仍被解析，用法不退化', () => {
  it('单条消息：位置参数按空格拼成 question', () => {
    const { args, usageError } = parseAskCliArgs(['查一下', '幻辰财税', '本期的凭证']);
    expect(usageError).toBe(false);
    expect(args).toMatchObject({ question: '查一下 幻辰财税 本期的凭证' });
    expect(args.conversationId).toBeUndefined();
    expect(args.dbPath).toBeUndefined();
  });

  it('--conversation <id>：吃后随值且值不进 question', () => {
    const { args, usageError } = parseAskCliArgs(['--conversation', 'ask-fixed', '查一下', '余额']);
    expect(usageError).toBe(false);
    expect(args.conversationId).toBe('ask-fixed');
    expect(args.question).toBe('查一下 余额');
  });

  it('--db <path>：吃后随值且值不进 question', () => {
    const { args } = parseAskCliArgs(['--db', '/tmp/ask-session.db', '问题']);
    expect(args.dbPath).toBe('/tmp/ask-session.db');
    expect(args.question).toBe('问题');
  });

  it('--conversation 与 --db 同用 + question 在前：三个值各归各位', () => {
    const { args } = parseAskCliArgs(['多轮问题', '--conversation', 'conv-42', '--db', 'data/ask-fixed.db']);
    expect(args).toMatchObject({ question: '多轮问题', conversationId: 'conv-42', dbPath: 'data/ask-fixed.db' });
  });

  it('--config=<path>：等号形式（与 probe 同入口），值不进 question', () => {
    const { args } = parseAskCliArgs(['--config=.runtime/eval-agent-config.yaml', '查一下', 'alpha']);
    expect(args.configPath).toBe('.runtime/eval-agent-config.yaml');
    expect(args.question).toBe('查一下 alpha');
  });

  it('空 question = 用法错误（exit 2 路径），flag-only 的 argv 同样算用法错误', () => {
    expect(parseAskCliArgs([]).usageError).toBe(true);
    expect(parseAskCliArgs(['--conversation', 'conv-1']).usageError).toBe(true);
    // flag 值本身不冒充 question
    expect(parseAskCliArgs(['--db', 'x.db']).usageError).toBe(true);
  });

  it('值缺失的 --conversation 不吞后面的真问题：值为空但 question 在', () => {
    // 旧实现语义：--conversation 的后随参数就是它的值（哪怕是下一个 flag 前的任何 token）。
    // 这里钉住同一语义，防止解析器"聪明地"跳过空值导致行为漂移。
    const { args } = parseAskCliArgs(['--conversation', '问题']);
    expect(args.conversationId).toBe('问题');
    expect(args.question).toBe('');
  });
});
