/**
 * 计划草案教学的单一来源锁（L2 / D-011）。
 *
 * 背景：宿主侧曾有 6 处散文副本教 plan 草案形状，其中 5 处教带 goal 形、1 处教不带
 * goal 形——而平台 `plan.js` evaluate 只读 calls 与 requestId，goal 字段在平台侧根本
 * 不存在。同一张错误码表给出两种互相矛盾的形状，正是「模型静默选一份信」的机制。
 * 平台随后用 `src/execution/plan-schema.json` 声明了唯一形状（calls 必填，goal /
 * requestId 是声明过的可选元数据，additionalProperties:false）。
 *
 * 本测试钉三件事（都是机械判据，不是人眼比对）：
 *   ① 宿主教学形态（planDraftExample()）与平台 schema 声明一致——顶字段全在声明内、
 *      calls 必填、goal 是声明过的可选字段（不是幻影字段）；
 *   ② 宿主自己的解析器（parsePlanCallsCommand）认这个形状——教学与解析不互相打架；
 *   ③ 6 处副本确已收敛为 1 处：两个源文件里除 planDraftExample 外零第二种形状字面量，
 *      worker 提示词那处由同一个函数派生。
 *
 * 跨仓读平台文件是可接受的（L2 单一来源就在平台侧）：这里读 17dz 的 plan-schema.json
 * 与 plan.js 的字段读取面，**不在 fshine 仓里抄一份平台事实**——抄了就又是第二份真相。
 * （2026-10-23 C4 起 `bin/17dz plan --schema` 已是真实可用的元数据出口——driver 的
 * 计划解析认出旗标形态返回 null，门的 SERVE_METADATA_COMMANDS 白名单放行它到平台
 * CLI 逐字打印 plan-schema.json，e2e A6 spawn 实证 exit 0。本测试仍走读文件核验：
 * 教学形态与平台声明的逐字一致是 L2 判据，与 CLI 出口是否可用是两个事实。）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messageFor, planDraftExample } from './src/error-codes';
import { parsePlanCallsCommand } from './src/plan-runtime';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PLATFORM_ROOT = process.env['DZ_PLATFORM_ROOT'] ?? path.resolve(REPO_ROOT, '..', '17dz-platform');

/**
 * 平台计划草案 schema。
 * 同仓在场时读 17dz 的 plan-schema.json（L2 跨仓单一来源，fshine 不镜像）。
 * 同仓不在场时（单仓 GitHub CI：只检出 fshine-agent），回落到仓内通用
 * mock 执行层的 plan --schema 输出——那是 dummy 平台自己的 schema，
 * 不是财税 schema 的副本，校验的只是协议顶层形状（calls 必填、
 * goal/requestId 为声明过的可选元数据、additionalProperties:false）。
 * 回落不是静默放水：dummy 输出缺失或解析失败时测试直接失败。
 */
function planSchema(): { required?: unknown; additionalProperties?: unknown; properties?: Record<string, unknown> } {
  const siblingSchema = path.join(PLATFORM_ROOT, 'src', 'execution', 'plan-schema.json');
  if (existsSync(siblingSchema)) {
    return JSON.parse(readFileSync(siblingSchema, 'utf8'));
  }
  const dummyBin = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform', 'bin', 'dummy');
  const r = spawnSync(dummyBin, ['plan', '--schema'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) {
    throw new Error(`同仓 plan-schema.json 不在场，且 dummy plan --schema 失败（status=${r.status}）：单仓 CI 无法校验教学形状`);
  }
  return JSON.parse(r.stdout);
}

/** 教学示例里的占位符（…）→ 具体合法值，得到一条可解析的真草案命令。 */
function concreteDraftCommand(): string {
  return planDraftExample()
    .replace('"goal":"…"', '"goal":"查询某公司本期的应收余额"')
    .replace('"operation":"…"', '"operation":"finance.query-receivables"')
    .replace('"args":[…]', '"args":["--query","某公司","--period","202609"]');
}

describe('计划草案教学：单一来源与平台 schema 一致（D-011）', () => {
  it('教学形态合法：顶字段全在平台声明内，calls 必填，goal 是声明过的可选元数据', () => {
    const schema = planSchema();
    const properties = schema.properties ?? {};
    const payload = concreteDraftCommand().slice(concreteDraftCommand().indexOf(' plan ') + ' plan '.length);
    const draft = JSON.parse(payload) as Record<string, unknown>;

    // additionalProperties:false 的镜像断言——未声明字段平台以 PLAN_UNKNOWN_FIELD 拒绝
    expect(schema.additionalProperties).toBe(false);
    for (const key of Object.keys(draft)) {
      expect(Object.keys(properties), `教学形态里的顶字段 ${key} 必须在平台 schema 声明内`).toContain(key);
    }
    // required 纪律：calls 必填，且教学示例确实教了它
    expect(schema.required).toEqual(['calls']);
    expect(Array.isArray(draft['calls'])).toBe(true);
    expect((draft['calls'] as unknown[]).length).toBeGreaterThan(0);
    for (const call of draft['calls'] as Array<Record<string, unknown>>) {
      expect(typeof call['operation']).toBe('string');
      expect(Array.isArray(call['args'])).toBe(true);
    }
    // goal 是**声明过的**可选元数据（不是宿主发明的幻影字段）：平台 schema 里有它一名
    expect(Object.keys(properties)).toContain('goal');
    expect(typeof draft['goal']).toBe('string');
  });

  it('宿主解析器认这个形状：教学 → 解析 → 同一批 calls（教学与解析不打架）', () => {
    const parsed = parsePlanCallsCommand(concreteDraftCommand());
    expect(parsed).toEqual({
      kind: 'inline',
      calls: [{ operation: 'finance.query-receivables', args: ['--query', '某公司', '--period', '202609'] }],
    });
    // 形状类错误的 correctForm 就是从同一份教学派生（消息文本不得另写一种形状）
    expect(messageFor('PLAN_SHAPE_PREFIX', '```json')).toContain(planDraftExample());
    expect(messageFor('PLAN_CALLS_NOT_ARRAY', 0)).toContain(planDraftExample());
  });

  it('6 处副本收敛为 1 处：源文件里除 planDraftExample 外零第二种形状字面量', () => {
    const errorCodes = readFileSync(path.join(REPO_ROOT, 'packages/agent/src/error-codes.ts'), 'utf8');
    const workerPrompt = readFileSync(path.join(REPO_ROOT, 'packages/agent/src/context.ts'), 'utf8');
    // 宿主 src 里 `plan {` 形状的教学字面量只允许出现在 planDraftExample 函数体内一处
    expect(errorCodes.split('plan {"').length - 1, 'error-codes.ts 只许有一处草案形状字面量（planDraftExample 函数体）').toBe(1);
    expect(workerPrompt.split('plan {"').length - 1, 'context.ts 的 worker 提示词不许再手写草案形状').toBe(0);
    // 那一处必须真的是函数体，且 worker 提示词确实引用了同一个函数
    expect(errorCodes).toContain('export function planDraftExample()');
    expect(workerPrompt).toContain('planDraftExample()');
  });
});
