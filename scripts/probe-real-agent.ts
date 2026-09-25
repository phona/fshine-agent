/**
 * 真实模型探针：把消息直接注入生产装配，跑真实 LLM + 真实 17dz 计划门禁 + mock 执行器。
 *
 * 与 tests/e2e/turn-loop.acceptance.test.ts 的差别只有一点：那里的 Main Agent 和
 * 17dz 子 Agent 是脚本化驱动，这里用真实 pi driver。企微仍由假 SDK 替代（不起长连接）。
 *
 * 用法：
 *   node --env-file=.env --import tsx scripts/probe-real-agent.ts [--only A1,B2]
 *
 * 关注四件事：会不会说胡话（重放历史/范围渗入）、每次是否稳定、长会话是否漂移、长任务是否收口。
 * 结果写 .runtime/probe-<runId>.json，同时在终端打可读摘要。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { SdkClientLike } from '@fshine/channel-wecom';
import { createServerAssembly, type ServerAssembly } from '../apps/server/assembly';

const PRINCIPAL_USER = 'REPLACE_WITH_YOUR_WECOM_USERID';

interface Turn {
  text: string;
  reply: string;
  ms: number;
  notices: string[];
  group?: boolean;
}

interface CaseResult {
  id: string;
  group: string;
  intent: string;
  turns: Turn[];
  ledgerCalls: number;
  notes: string[];
  ok: boolean;
}

class RecordingSdk implements SdkClientLike {
  readonly frames: Array<{ content: string; finish: boolean }> = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(listener);
    this.listeners.set(event, handlers);
    return this;
  }
  connect(): unknown { return this; }
  disconnect(): void {}
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  async replyStream(_f: unknown, _s: string, content: string, finish: boolean): Promise<unknown> {
    this.frames.push({ content, finish });
    return {};
  }
  async uploadMedia(): Promise<{ media_id: string }> { return { media_id: 'unused' }; }
  async replyMedia(): Promise<unknown> { return {}; }
}

function wecomText(userid: string, content: string): { headers: { req_id: string }; body: Record<string, unknown> } {
  const messageId = `msg_${Math.random().toString(36).slice(2, 10)}`;
  return {
    headers: { req_id: `req_${messageId}` },
    body: { msgtype: 'text', from: { userid }, msgid: messageId, chattype: 'single', text: { content } },
  };
}

let stateDir: string;
let savedEnv: NodeJS.ProcessEnv;
let counter = 0;

const PLATFORM_STATE_KEYS = ['DZ_PLAN_STATE', 'DZ_RATE_LIMIT_STATE', 'DZ_MOCK_STATE', 'DZ_AUDIT_PATH'] as const;
let platformStateBackup: Record<string, string | undefined> = {};

function isolatePlatformState(): void {
  platformStateBackup = Object.fromEntries(PLATFORM_STATE_KEYS.map((key) => [key, process.env[key]]));
  counter += 1;
  Object.assign(process.env, {
    DZ_PLAN_STATE: path.join(stateDir, `plans-${counter}.json`),
    DZ_RATE_LIMIT_STATE: path.join(stateDir, `rate-${counter}.json`),
    DZ_MOCK_STATE: path.join(stateDir, `mock-${counter}.json`),
    DZ_AUDIT_PATH: path.join(stateDir, `audit-${counter}.jsonl`),
    // 网关限流有 17dz 专项测试；探针要跑长任务，放宽 burst 以免被限流挡住主线
    DZ_RATE_LIMIT: JSON.stringify({ read: { burst: 200, perMs: 0 }, global: { burst: 400, perMs: 0 } }),
  });
}

function restorePlatformState(): void {
  for (const key of PLATFORM_STATE_KEYS) {
    const value = platformStateBackup[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function ledgerCalls(): number {
  const file = process.env['DZ_PLAN_STATE'];
  if (!file || !existsSync(file)) return 0;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as { tasks?: Record<string, { actual?: { calls?: number } }> };
    return Object.values(state.tasks ?? {}).reduce((sum, task) => sum + (task.actual?.calls ?? 0), 0);
  } catch { return 0; }
}

async function boot(): Promise<{ send: (text: string) => Promise<Turn>; assembly: ServerAssembly; sdk: RecordingSdk }> {
  isolatePlatformState();
  const sdk = new RecordingSdk();
  const assembly = await createServerAssembly({
    env: process.env,
    dbPath: path.join(stateDir, `agent-${counter}.db`),
    channelClientFactory: () => sdk,
  });
  const starting = assembly.channel.start(assembly.replyHandler);
  sdk.emit('authenticated');
  await starting;
  return {
    sdk,
    assembly,
    send: async (text: string): Promise<Turn> => {
      const before = sdk.frames.filter((frame) => frame.finish).length;
      const startedAt = Date.now();
      sdk.emit('message.text', wecomText(PRINCIPAL_USER, text));
      const deadline = Date.now() + 600_000;
      while (Date.now() < deadline) {
        const finals = sdk.frames.filter((frame) => frame.finish);
        if (finals.length > before) {
          return {
            text,
            reply: finals.at(-1)!.content,
            ms: Date.now() - startedAt,
            notices: sdk.frames.filter((frame) => !frame.finish && frame.content.startsWith('计划通知：')).map((frame) => frame.content),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`等待回复超时(10min)：${text}`);
    },
  };
}

interface Case {
  id: string;
  group: string;
  intent: string;
  run: () => Promise<{ turns: Turn[]; notes?: string[] }>;
}

const CASES: Case[] = [
  {
    id: 'A1', group: 'A 说胡话', intent: '同一实时问题重问，必须重新查询而不是复述旧答案',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [];
      turns.push(await send('查一下幻辰财税账套本期的应收账款'));
      const first = turns[0]!.reply;
      turns.push(await send('再帮我查一下幻辰财税账套本期的应收账款'));
      const second = turns[1]!.reply;
      await assembly.close();
      const notes: string[] = [];
      if (first === second) notes.push('两轮回复完全一致——需确认是真查了还是复述');
      return { turns, notes };
    },
  },
  {
    id: 'A2', group: 'A 说胡话', intent: '新问题不带账套时先追问，不把旧账套带进来',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [];
      turns.push(await send('查一下幻辰财税账套本期的应收账款'));
      turns.push(await send('帮我查一下猫一杯的应收账款还有多少'));
      await assembly.close();
      const notes: string[] = [];
      if (turns[1]!.reply.includes('幻辰')) notes.push('第二轮回复带上了旧账套"幻辰"——范围渗入');
      return { turns, notes };
    },
  },
  {
    id: 'A3', group: 'A 说胡话', intent: '歧义账套先澄清，不猜也不自动遍历多个账套',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [await send('查一下幻辰的应收账款')];
      await assembly.close();
      return { turns };
    },
  },
  {
    id: 'A4', group: 'A 说胡话', intent: '不存在的账套只走目录搜索，不用余额/凭证接口探测',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [await send('只查账套目录，看看有没有胜利这个帐套')];
      await assembly.close();
      return { turns };
    },
  },
  {
    id: 'A5', group: 'A 说胡话', intent: '闲聊不委派平台',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [await send('现在几月份了？')];
      await assembly.close();
      const notes: string[] = [];
      if (ledgerCalls() > 0) notes.push('闲聊也产生了平台调用');
      return { turns, notes };
    },
  },
  {
    id: 'B1', group: 'B 稳定性', intent: '同一查询连发 5 次，每次都真查且口径一致',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [];
      for (let i = 0; i < 5; i += 1) turns.push(await send('查一下新兴五金账套 202609 的应收账款'));
      await assembly.close();
      const notes: string[] = [];
      const calls = ledgerCalls();
      if (calls < 5) notes.push(`5 轮只产生 ${calls} 次平台调用——有轮次没真查`);
      // 比数据口径，不比措辞：抽取所有数字，5 轮必须一致（开场白本来就会变）
      const numbers = turns.map((turn) => (turn.reply.match(/[\d,]+\.?\d*/g) ?? []).join('|'));
      if (new Set(numbers).size > 1) notes.push(`5 轮数据口径不一致：${JSON.stringify(numbers)}`);
      return { turns, notes };
    },
  },
  {
    id: 'B2', group: 'B 稳定性', intent: '期间口径必须体现在回复里',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [await send('查一下新兴建材账套 202607 的应收账款余额')];
      await assembly.close();
      const notes: string[] = [];
      if (!turns[0]!.reply.includes('202607') && !turns[0]!.reply.includes('2026年07月')) notes.push('回复未体现请求的期间');
      return { turns, notes };
    },
  },
  {
    id: 'C1', group: 'C 长会话', intent: '20 轮混合对话，观察漂移、变慢与旧范围渗入',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [];
      const script = [
        '你好，你能做什么？',
        '查一下新兴五金账套 202609 的应收账款',
        '这个账套 202608 呢？',
        '那把 202607 也看一下',
        '辛苦了，先聊点别的：现在几月份？',
        '刚才我让你查的那三个期间，哪个余额最高？',
        '帮我查一下猫一杯的应收账款还有多少',
        '算了，不问余额了。只查账套目录，有没有新兴建材这个帐套',
        '有的话它的 202609 应收是多少？',
        '下一页',
        '刚才查的是哪个账套？',
        '把新兴五金的凭证也列一下',
        '只列 202609 的',
        '谢谢你',
        '再帮我查一次新兴五金 202609 的应收账款',
        '和刚才的结果一样吗？',
        '如果不一样以哪次为准？',
        '帮我查一下幻辰财税的应收账款',
        '这个账套 202609 的凭证有多少张？',
        '总结一下我们今天查了些什么',
      ];
      for (const text of script) turns.push(await send(text));
      await assembly.close();
      const notes: string[] = [];
      const slow = turns.filter((turn) => turn.ms > 120_000);
      if (slow.length) notes.push(`${slow.length} 轮超过 2 分钟：${slow.map((t) => `${t.ms}ms`).join(', ')}`);
      // 内部协议泄漏：用户不该看到宿主/申报/主 Agent 这类字样
      const leaked = turns.filter((turn) => /主 Agent|route_current_turn|已按要求先申报|宿主|PLAN (ACTIVE|DECLINED|NEEDS)/.test(turn.reply));
      if (leaked.length) notes.push(`${leaked.length} 轮回复泄漏内部协议：${leaked.map((t) => t.text).join(' / ')}`);
      // 只在"回复把某个账套当成本轮已查结果"时才算漂移；在澄清问句里点名账套是正确行为
      const drift = turns.filter((turn) => /新兴五金/.test(turn.text) === false && /新兴五金/.test(turn.reply)
        && /已查|查到|余额为|凭证\s*\d|结果如下/.test(turn.reply));
      if (drift.length) notes.push(`${drift.length} 轮把用户没问的账套当成本轮结果`);
      return { turns, notes };
    },
  },
  {
    id: 'D1', group: 'D 长任务', intent: '跨 9 个月查询：先通知，送达后才执行',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [await send('查一下新兴五金账套 2026 年 1 到 9 月的应收账款')];
      await assembly.close();
      const notes: string[] = [];
      if (!turns[0]!.notices.length) notes.push('跨月查询没有先通知用户');
      return { turns, notes };
    },
  },
  {
    id: 'D2', group: 'D 长任务', intent: '更高重量任务应停在确认门，等用户真实回复',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [];
      turns.push(await send('把所有账套 2026 年 1 到 9 月的应收账款都查一遍'));
      const asked = turns[0]!.reply;
      if (/确认继续/.test(asked)) turns.push(await send('确认继续'));
      await assembly.close();
      return { turns };
    },
  },
];

async function main(): Promise<void> {
  const only = process.argv.includes('--only')
    ? new Set(process.argv[process.argv.indexOf('--only') + 1]!.split(','))
    : null;
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'fshine-probe-'));
  savedEnv = { ...process.env };

  const results: CaseResult[] = [];
  for (const item of (only ? CASES.filter((c) => only.has(c.id)) : CASES)) {
    console.log(`\n=== ${item.id} ${item.intent} ===`);
    const before = ledgerCalls();
    try {
      const { turns, notes = [] } = await item.run();
      const after = ledgerCalls();
      const ok = notes.length === 0;
      results.push({ id: item.id, group: item.group, intent: item.intent, turns, ledgerCalls: after - before, notes, ok });
      for (const turn of turns) {
        console.log(`  [${(turn.ms / 1000).toFixed(1)}s] 用户: ${turn.text}`);
        console.log(`         回复: ${turn.reply.replace(/\n/g, '\n              ')}`);
        if (turn.notices.length) console.log(`         通知: ${turn.notices.join(' | ')}`);
      }
      console.log(`  平台调用: ${after - before}${ok ? '' : `  ⚠ ${notes.join('; ')}`}`);
    } catch (error) {
      results.push({
        id: item.id, group: item.group, intent: item.intent, turns: [],
        ledgerCalls: 0, notes: [error instanceof Error ? error.message : String(error)], ok: false,
      });
      console.log(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
    }
    restorePlatformState();
  }

  const report = path.join(process.cwd(), '.runtime', `probe-${path.basename(stateDir)}.json`);
  await import('node:fs').then((fs) => fs.mkdirSync(path.dirname(report), { recursive: true }));
  await import('node:fs').then((fs) => fs.writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), results }, null, 2)));

  console.log('\n\n================ 汇总 ================');
  const byGroup = new Map<string, CaseResult[]>();
  for (const result of results) {
    const list = byGroup.get(result.group) ?? [];
    list.push(result);
    byGroup.set(result.group, list);
  }
  for (const [group, list] of byGroup) {
    console.log(`\n${group}`);
    for (const result of list) {
      const total = result.turns.reduce((sum, turn) => sum + turn.ms, 0);
      console.log(`  ${result.ok ? '✓' : '⚠'} ${result.id} ${(total / 1000).toFixed(1)}s 平台调用 ${result.ledgerCalls} ${result.notes.length ? '— ' + result.notes.join('; ') : ''}`);
    }
  }
  const bad = results.filter((result) => !result.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 无异常；明细 ${report}`);
  process.env = savedEnv;
  rmSync(stateDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error('探针失败:', error);
  process.exit(1);
});
