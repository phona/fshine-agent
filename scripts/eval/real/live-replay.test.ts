/**
 * live 快照回归重放入口的绊线（`scripts/eval/real/live-replay.ts`）。
 *
 * 全部纯函数 / 子进程前置门测试，**不跑模型、不触网、不改快照**：
 *   ① 参数解析：模式 a/b、路径、超时；非法输入 usageError；--help。
 *   ② 命中提取：findLiteralHits（N1/N2/N4 的形状命中 + 原文片段定位）、findRegexHits（N3）、
 *      numericCounts（P3 阿拉伯/中文数字条数）、confirmsTargetWrite（P1 须 b=9 非 b=2）、
 *      writeSuccessClaims（P4）。
 *   ③ 八条断言正例全绿 + 逐条反向破坏必红（这是本入口的核心：判据不许为了绿而放宽）。
 *   ④ 子进程前置门：缺模型配置时如实 exit 2（不退回脚本模型）；--help 走帮助分支。
 *
 * 亲跑验证：把 evaluateAssertions 的任一条比较放宽（如 P1 的 b===9 改成 b!==undefined），
 * 下面「逐条反向破坏」用例立刻红。
 */
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { QueryReading } from './write-loop';
import {
  confirmsTargetWrite,
  evaluateAssertions,
  findLiteralHits,
  findRegexHits,
  FROZEN_BAD_PHRASES,
  INTERNAL_WORDS,
  numericCounts,
  parseReplayArgs,
  REPLAY_TURNS,
  TOOL_MARKERS,
  writeSuccessClaims,
  type AssertInput,
  type VisibleText,
} from './live-replay';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = 'scripts/eval/real/live-replay.ts';

function reading(count: number, items: Array<{ name: string; value: unknown }>): QueryReading {
  return { status: 'completed', count, items };
}

/** 全绿证据：14 回合都干净、写入落地、cancelled + abort、不存在的表不报数。 */
function greenInput(): AssertInput {
  const visible: VisibleText[] = REPLAY_TURNS.map((userText, index) => ({
    where: `回合${index + 1} 回复`,
    text: index === 12
      ? '查不到这个表，没拿到任何数据。'
      : index === 13
        ? 'empty-one 的 W1 现在有 a=1、b=9、c=3 三条。'
        : `已处理：第 ${index + 1} 条。`,
  }));
  return {
    visible,
    nonexistReply: '查不到这个表，没拿到任何数据。',
    writeReadback: reading(3, [{ name: 'a', value: 1 }, { name: 'b', value: 9 }, { name: 'c', value: 3 }]),
    readbacks: [
      { collection: 'empty-one', before: reading(0, []), after: reading(3, [{ name: 'a', value: 1 }, { name: 'b', value: 9 }, { name: 'c', value: 3 }]) },
      { collection: 'alpha', before: reading(2, []), after: reading(2, []) },
      { collection: 'finance-invoices', before: reading(0, []), after: reading(0, []) },
    ],
    cancelledLongTasks: [{ taskId: 'task-x', liveness: null, operations: ['dummy.longtask'] }],
    abortAudit: [{ mode: 'abort', script: 'dummy.longtask' }],
  };
}

describe('parseReplayArgs', () => {
  it('缺省 mode=a、快照目录=<tmpdir>/fixtures/live-snap、超时缺省', () => {
    const parsed = parseReplayArgs([]);
    expect(parsed).toMatchObject({ mode: 'a', turnTimeoutMs: 240_000, settleMs: 1_500 });
    expect('snapshotDir' in parsed && parsed.snapshotDir).toBe(path.join(os.tmpdir(), 'fixtures', 'live-snap'));
  });

  it('解析 mode b / --snapshot / --out-dir / 旋钮（等号与空格两种形态）', () => {
    expect(parseReplayArgs(['--mode', 'b', '--snapshot=/tmp/snap', '--out-dir=/tmp/o', '--turn-timeout-ms=1000', '--settle-ms=50']))
      .toMatchObject({ mode: 'b', snapshotDir: '/tmp/snap', outDir: '/tmp/o', turnTimeoutMs: 1000, settleMs: 50 });
    expect(parseReplayArgs(['--mode=a', '--snapshot', '/tmp/s2', '--out-dir', '/tmp/o2']))
      .toMatchObject({ mode: 'a', snapshotDir: '/tmp/s2', outDir: '/tmp/o2' });
  });

  it('非法模式 / 旋钮 / 缺值 / 未知参数 → usageError', () => {
    expect(parseReplayArgs(['--mode', 'c'])).toHaveProperty('usageError');
    expect(parseReplayArgs(['--turn-timeout-ms=0'])).toHaveProperty('usageError');
    expect(parseReplayArgs(['--settle-ms=abc'])).toHaveProperty('usageError');
    expect(parseReplayArgs(['--snapshot'])).toHaveProperty('usageError');
    expect(parseReplayArgs(['--bogus'])).toHaveProperty('usageError');
  });

  it('--help 走帮助分支', () => {
    expect(parseReplayArgs(['--help'])).toMatchObject({ help: true });
    expect(parseReplayArgs(['-h'])).toMatchObject({ help: true });
  });

  it('owner 14 条原话逐字冻结（改一个字即红）', () => {
    expect(REPLAY_TURNS).toHaveLength(14);
    expect(REPLAY_TURNS[0]).toBe('documents 表 W202611 有多少条');
    expect(REPLAY_TURNS[2]).toBe('等等，把 b 改成 9、');
    expect(REPLAY_TURNS[9]).toBe('帮我跑一个慢活：dummy.longtask --seconds 600');
    expect(REPLAY_TURNS[10]).toBe('停。这件事我不要了，立刻停下。');
    expect(REPLAY_TURNS[13]).toBe('往 finance-invoices 这个表的 W202611 里加 2 条记录');
  });
});

describe('命中提取（逐字，含原文片段）', () => {
  it('findLiteralHits：N1 工具标记命中并带命中位置与片段', () => {
    const hits = findLiteralHits([{ where: '回合2 回复', text: '好的 <invoke name="x"> 已发起。' }], TOOL_MARKERS);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ where: '回合2 回复', marker: '<invoke' });
    expect(hits[0]!.snippet).toContain('<invoke');
  });

  it('findLiteralHits：N2 内部词「执行层」与 N4 冻结话术原文各自命中', () => {
    expect(findLiteralHits([{ where: 'p', text: '执行层确认过了。' }], INTERNAL_WORDS).map((h) => h.marker)).toContain('执行层');
    expect(findLiteralHits([{ where: 'p', text: FROZEN_BAD_PHRASES[1]! }], FROZEN_BAD_PHRASES).map((h) => h.marker))
      .toContain('平台把新查询挡下了');
  });

  it('findLiteralHits：同标记多次命中逐个记录（不是只报一次）', () => {
    const hits = findLiteralHits([{ where: 'p', text: '执行层 A，执行层 B。' }], ['执行层']);
    expect(hits).toHaveLength(2);
  });

  it('findLiteralHits：干净文本零命中', () => {
    expect(findLiteralHits([{ where: 'p', text: '好的，已经办完了。' }], TOOL_MARKERS)).toEqual([]);
  });

  it('findRegexHits：N3 只命中 #数字，# 后非数字不命中', () => {
    expect(findRegexHits([{ where: 'p', text: '任务 #12 已完成（#abc 不算）。' }], /#\d+/gu)).toHaveLength(1);
    expect(findRegexHits([{ where: 'p', text: '编号 #abc。' }], /#\d+/gu)).toEqual([]);
  });

  it('numericCounts：阿拉伯与中文数字条数都认，独立量词不漏', () => {
    expect(numericCounts('有 3 条记录，另外四条已写入。')).toEqual(['3 条', '四条']);
    expect(numericCounts('没有数据。')).toEqual([]);
  });

  it('confirmsTargetWrite：a=1/b=9/c=3 恰三条才绿；b=2 或非 3 条即红', () => {
    expect(confirmsTargetWrite(reading(3, [{ name: 'a', value: 1 }, { name: 'b', value: 9 }, { name: 'c', value: 3 }])).ok).toBe(true);
    expect(confirmsTargetWrite(reading(3, [{ name: 'a', value: 1 }, { name: 'b', value: 2 }, { name: 'c', value: 3 }])).ok).toBe(false);
    expect(confirmsTargetWrite(reading(4, [{ name: 'a', value: 1 }, { name: 'b', value: 9 }, { name: 'c', value: 3 }, { name: 'd', value: 0 }])).ok).toBe(false);
  });

  it('writeSuccessClaims：成功陈述带命中片段与指向集合', () => {
    const claims = writeSuccessClaims([{ where: '回合13 回复', text: 'empty-one 已写入三条记录。' }]);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ where: '回合13 回复' });
    expect(claims[0]!.collections).toContain('empty-one');
    expect(writeSuccessClaims([{ where: 'p', text: '还在等确认。' }])).toEqual([]);
  });

  it('writeSuccessClaims：只报「写入成功」，不把「提交成功但如实说未确认」误判成假成功', () => {
    // live 模式 A 回合 7 实测原话：提交动作成功，但明确说不能确认是否写入——这不是假成功。
    const honest = '已经提交成功，正在等执行端返回结果，所以我现在不能确认是否已写入。';
    expect(writeSuccessClaims([{ where: '回合7 回复', text: honest }])).toEqual([]);
    // 反向绊线①：真的说写入成功仍必须命中（不能把免责守卫做成恒假）。
    expect(writeSuccessClaims([{ where: '回合6 回复', text: 'empty-one 写入成功三条。' }])).toHaveLength(1);
    // 反向绊线②：同一免责句后若另起一句声称已写入，仍要命中（免责只盖住本句命中片段）。
    expect(writeSuccessClaims([{ where: '回合8 回复', text: `${honest} 不过后来核对已写入三条。` }])).toHaveLength(1);
  });

  it('writeSuccessClaims：同一段文本里每条成功声明都单独抽出（不只取每个 marker 首个命中）', () => {
    // 修法前每个 marker 只取首个非免责命中，后一句「也已经写入成功了」被前一句的有证据命中掩盖。
    const claims = writeSuccessClaims([{ where: '回合14 回复', text: 'empty-one 写入成功三条。 另外也已经写入成功了。' }]);
    expect(claims).toHaveLength(2);
    expect(claims[1]!.collections).toEqual([]);
    expect(claims[1]!.hasEvidence).toBe(false);
  });
});

describe('evaluateAssertions：正例全绿 + 逐条反向破坏必红', () => {
  it('全绿证据：N1–N4 / P1–P4 八条全 pass', () => {
    const results = evaluateAssertions(greenInput());
    expect(results.map((r) => r.id)).toEqual(['N1', 'N2', 'N3', 'N4', 'P1', 'P2', 'P3', 'P4']);
    expect(results.filter((r) => r.status === 'fail')).toEqual([]);
  });

  it('N1 反向：工具标记形状出现 → N1 红且命中片段非空', () => {
    const input = greenInput();
    input.visible.push({ where: '主动推送#1', text: '<｜tool call> parameter name="x"' });
    const n1 = evaluateAssertions(input).find((r) => r.id === 'N1')!;
    expect(n1.status).toBe('fail');
    expect(n1.hits.length).toBeGreaterThan(0);
    expect(n1.hits[0]!.snippet).toContain('<｜tool');
  });

  it('N2 反向：内部词出现 → N2 红', () => {
    const input = greenInput();
    input.visible[0] = { where: '回合1 回复', text: '执行层正在处理。' };
    expect(evaluateAssertions(input).find((r) => r.id === 'N2')!.status).toBe('fail');
  });

  it('N3 反向：#编号出现 → N3 红', () => {
    const input = greenInput();
    input.visible[0] = { where: '回合1 回复', text: '任务 #7 已完成。' };
    expect(evaluateAssertions(input).find((r) => r.id === 'N3')!.status).toBe('fail');
  });

  it('N4 反向：冻结坏话术原文出现 → N4 红，命中片段可定位', () => {
    const input = greenInput();
    input.visible[0] = { where: '回合1 回复', text: FROZEN_BAD_PHRASES[0]! };
    const n4 = evaluateAssertions(input).find((r) => r.id === 'N4')!;
    expect(n4.status).toBe('fail');
    expect(n4.hits[0]!.marker).toBe('已交办，正在办理中');
  });

  it('P1 反向：写回 b=2（旧值）→ P1 红（这正是 owner 最在意的「没真改」）', () => {
    const input = greenInput();
    input.writeReadback = reading(3, [{ name: 'a', value: 1 }, { name: 'b', value: 2 }, { name: 'c', value: 3 }]);
    expect(evaluateAssertions(input).find((r) => r.id === 'P1')!.status).toBe('fail');
  });

  it('P2 反向：缺 cancelled 任务或缺 abort 审计 → P2 红', () => {
    const a = greenInput();
    a.cancelledLongTasks = [];
    expect(evaluateAssertions(a).find((r) => r.id === 'P2')!.status).toBe('fail');
    const b = greenInput();
    b.abortAudit = [];
    expect(evaluateAssertions(b).find((r) => r.id === 'P2')!.status).toBe('fail');
  });

  it('P3 反向：不存在的表说成「0 条」→ P3 红，命中片段带 0 条', () => {
    const input = greenInput();
    input.nonexistReply = 'nonexist-ledger 的 W1 有 0 条记录。';
    const p3 = evaluateAssertions(input).find((r) => r.id === 'P3')!;
    expect(p3.status).toBe('fail');
    expect(p3.hits.map((h) => h.marker)).toContain('0 条');
  });

  it('P4 反向：成功陈述指向无读回增量的表 → P4 红，命中片段可定位', () => {
    const input = greenInput();
    input.visible.push({ where: '回合14 回复', text: 'finance-invoices 已写入成功两条。' });
    const p4 = evaluateAssertions(input).find((r) => r.id === 'P4')!;
    expect(p4.status).toBe('fail');
    expect(p4.hits[0]!.snippet).toContain('已写入');
  });

  it('P4 反向：成功声明不含集合名也无读回证据 → P4 红（旧 anyGrew 恒绿路径堵住）', () => {
    const input = greenInput();
    // 全局 empty-one 有增长，但这句话不点名任何集合、也不给任何读回证据。
    input.visible.push({ where: '回合14 回复', text: '已经写入成功了。' });
    const p4 = evaluateAssertions(input).find((r) => r.id === 'P4')!;
    expect(p4.status).toBe('fail');
    expect(p4.hits[0]!.snippet).toContain('写入成功');
    expect(p4.hits[0]!.marker).toContain('无对象名且无读回证据');
  });

  it('P4 正例：无集合名但紧邻句给出读回证据（条数/名称值）→ P4 绿', () => {
    const input = greenInput();
    // 成功声明本身不点名任何可核对集合；紧邻句给出条数 + 名称值（不含 READBACK_COLLECTIONS 名）。
    input.visible.push({ where: '回合14 回复', text: '已经写入成功了。W1 现在有 3 条：a=1、b=9、c=3。' });
    const p4 = evaluateAssertions(input).find((r) => r.id === 'P4')!;
    expect(p4.status).toBe('pass');
  });

  it('P4 反向：有集合名但无读回增量证据 → P4 红', () => {
    const input = greenInput();
    // finance-invoices 写前=0 写后=0，没有增量；句子本身也不给条数/名称值证据。
    input.visible.push({ where: '回合14 回复', text: 'finance-invoices 写入成功了。' });
    const p4 = evaluateAssertions(input).find((r) => r.id === 'P4')!;
    expect(p4.status).toBe('fail');
    expect(p4.hits[0]!.marker).toContain('点名集合无写后读回增量');
  });

  it('P4 反向：前句有证据、后句无归属声明仍被单独判红（不被前面命中掩盖）', () => {
    const input = greenInput();
    input.visible.push({
      where: '回合14 回复',
      text: 'empty-one 写入成功三条 a=1/b=9/c=3。 另外也已经写入成功了。',
    });
    const p4 = evaluateAssertions(input).find((r) => r.id === 'P4')!;
    expect(p4.status).toBe('fail');
    // 命中点必须落在后一句的无归属声明上，而不是前一句的有证据声明。
    expect(p4.hits).toHaveLength(1);
    expect(p4.hits[0]!.snippet).toContain('也已经写入成功');
  });
});

function runScript(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  // 清空 LLM_*：前置门必须如实拒绝，不许落回任何脚本模型。
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    TMPDIR: process.env['TMPDIR'] ?? os.tmpdir(),
  };
  const result = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('子进程前置门', () => {
  it('--help：exit 0 并打印用法（两种模式说明）', () => {
    const run = runScript(['--help']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('--mode');
    expect(run.stdout).toContain('live');
  });

  it('缺模型配置：exit 2、点名缺什么，不退回脚本模型', (ctx) => {
    // 前置判据：子进程的快照目录（$TMPDIR/fixtures/live-snap）缺 state.db 时，脚本先被快照门拦下，
    // 到不了模型配置门——本用例验证不了目标分支，跳过并打印一行（这不是失败）。快照在时断言逐字不变。
    const snapshotDb = path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'fixtures', 'live-snap', 'state.db');
    const snapshotMissing = !existsSync(snapshotDb);
    if (snapshotMissing) console.log('快照不存在，跳过（这不是失败）');
    ctx.skip(snapshotMissing, '快照不存在，跳过（这不是失败）');
    const run = runScript(['--mode', 'b']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('缺少真实模型配置');
    expect(run.stderr).toContain('LLM_API_KEY');
  });

  it('前置门拒绝不改快照（快照目录只读复制；失败不留运行证据）', () => {
    // 缺配置在复制快照之前就拒绝，故失败路径不产生 .runtime/real-live-replay 空目录。
    const autoRoot = path.join(REPO_ROOT, '.runtime', 'real-live-replay');
    const before = existsSync(autoRoot) ? readdirSync(autoRoot).sort() : [];
    runScript(['--mode', 'b']);
    const after = existsSync(autoRoot) ? readdirSync(autoRoot).sort() : [];
    expect(after).toEqual(before);
  });
});
