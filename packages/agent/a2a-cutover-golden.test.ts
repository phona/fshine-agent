import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostGatewayEnv } from './src/context';
import { createPlanScopedWorkerEnv } from './src/plan-runtime';
import {
  gatewayExecPath,
  gatewayExecPathForProfile,
  isPlatformAuthError,
  resolveGatewayText,
  validateGatewayInvocation,
} from './src/platform-contract';
import { RESOURCE_EXHAUSTED_CLASS } from './src/resource-exhausted';
import { toolUserErrorFor } from './src/error-codes';
import { A2A_PROTOCOL_VERSION, type DelegationBlock } from '@fshine/contracts';

/**
 * W5 cutover 表征 golden（F1：先于一切改动的现行行为冻结）。
 *
 * 背景：本波要用结构化调用协议替代现行 env 级接线（网关 spawn 路径）。cutover 期间
 * 旧路径是 fallback——**必须先能证明它逐字不变**，否则 C3 之后任何一红都无法归因到
 * 新路径还是旧路径（F5 的 revert 决策会变成猜）。本文件把四组现状钉死：
 *
 *   ③ env 两把尺：context.ts 的 hostGatewayEnv（剥 EXECUTION_REQUIRE_PLAN、
 *      不声明法域 env——2026-11-10 声明面归零）与 plan-runtime.ts 的
 *      createPlanScopedWorkerEnv（EXECUTION_REQUIRE_PLAN=1 + EXECUTION_PLAN_ID
 *      注入，worker 子进程法域——D-081 的岔路，C6 新通道的法域选择以此为基线）；
 *   ④ 委派块当前文本形状（【委派】/范围/工作区/协议版本 + A2A_PROTOCOL_VERSION，
 *      entities/inputs 尚未进载荷）；
 *   ⑤ 委派失败五路链（cancelled / timeout / model_transient / auth /
 *      executor_error，含「过渡、平台挂码后即删」的 /平台登录已过期/ 正则兜底）
 *      与 error-codes 表五条话术的单一来源；
 *   ⑥ spawn 面盘点：全部消费点经 fail-closed 的 gatewayExecPath /
 *      gatewayExecPathForProfile，未声明/非法即抛；GATEWAY_INVOCATION 实例名缺省
 *      已不在（W1 C7b 达成，2026-11-06 实测）。
 *
 * **2026-11-08 退役的两组（原①②，整组删除）**：
 *   · 原① platform-mock.ts 的 isPlatformMock / isCommitEnabled 真值表；
 *   · 原② apps/server/runtime-mode.ts 的 runtimeModeOf / ALLOW_REAL_ENV。
 * 两者钉的都是"宿主读 EXECUTION_EXECUTOR / FSHINE_REAL_COMMIT 判这个部署允不允许写"，
 * 随架构裁定（写能不能真落地归执行层）把判据源整个删除——连同被测模块
 * （platform-mock.ts / runtime-mode.ts）一起退场，故没有可改写的替代断言。
 * 编号保留③起，避免后续条目大面积重排。
 *
 * **显式翻转点（全波只有两处，其余条目任何 commit 不得改断）**：
 *   · 第④组在 C5（委派块按 DelegationBlock 五字段落地）显式翻转——entities/inputs
 *     进载荷后本组「尚未进载荷」断言改为五字段在场断言；
 *   · 第⑥组在 C7（spawn 收尾：platform-contract.ts 失真注释修正 +
 *     mock-commit-smoke.ts:57 单参数缺陷修复）显式盘点——fail-closed 主体已由
 *     W1 C7b 提前达成，本组钉的是 W1 之后的现状，C7 只许修缺陷不许回退属性。
 *
 * 纪律：只跑 mock 不碰真实平台（D-076）——本文件零 spawn、零网络，全是纯函数与
 * 源码文本断言；产品面零执行层实例名（夹具网关名用哑值）。
 */

const SRC_DIR = join(__dirname, 'src');
const APPS_DIR = join(__dirname, '..', '..', 'apps');
const SCRIPTS_DIR = join(__dirname, '..', '..', 'scripts');

function srcOf(...segments: string[]): string {
  return readFileSync(join(...segments), 'utf8');
}

describe('③ env 两把尺（hostGatewayEnv / createPlanScopedWorkerEnv）', () => {
  it('hostGatewayEnv：剥 EXECUTION_REQUIRE_PLAN、不设 EXECUTION_SERVE、不动原 env', () => {
    const saved = { ...process.env };
    try {
      process.env.EXECUTION_REQUIRE_PLAN = '1';
      delete process.env.EXECUTION_SERVE;
      process.env.GOLDEN_SENTINEL_KEY = 'keep-me';
      const env = hostGatewayEnv();
      expect('EXECUTION_REQUIRE_PLAN' in env).toBe(false);
      // 宿主不声明法域：返回的 env 与进程 env 都不带这个键。
      expect(env.EXECUTION_SERVE).toBeUndefined();
      expect(process.env.EXECUTION_SERVE).toBeUndefined();
      // 其余键原样继承（哨兵不被误删）。
      expect(env.GOLDEN_SENTINEL_KEY).toBe('keep-me');
      // 函数内部 copy，调用方 env 不被污染。
      expect(process.env.EXECUTION_REQUIRE_PLAN).toBe('1');
    } finally {
      delete process.env.EXECUTION_REQUIRE_PLAN;
      delete process.env.EXECUTION_SERVE;
      delete process.env.GOLDEN_SENTINEL_KEY;
      void saved;
    }
  });

  it('createPlanScopedWorkerEnv：REQUIRE_PLAN=1 + PLAN_ID 注入，激活密钥剥掉', () => {
    const inherited: NodeJS.ProcessEnv = {
      EXECUTION_REQUIRE_PLAN: '',
      EXECUTION_PLAN_ID: 'stale-plan',
      EXECUTION_PLAN_ACTIVATION_SECRET: 'secret',
      GOLDEN_SENTINEL_KEY: 'keep-me',
    };
    const scoped = createPlanScopedWorkerEnv(inherited, 'plan_abc');
    expect(scoped.EXECUTION_REQUIRE_PLAN).toBe('1');
    expect(scoped.EXECUTION_PLAN_ID).toBe('plan_abc');
    expect('EXECUTION_PLAN_ACTIVATION_SECRET' in scoped).toBe(false);
    expect(scoped.GOLDEN_SENTINEL_KEY).toBe('keep-me');

    // 无活动计划：REQUIRE_PLAN 仍在，PLAN_ID 缺席（不注入 stale 值）。
    const noPlan = createPlanScopedWorkerEnv(inherited, null);
    expect(noPlan.EXECUTION_REQUIRE_PLAN).toBe('1');
    expect('EXECUTION_PLAN_ID' in noPlan).toBe(false);

    // 纯函数：不改入参。
    expect(inherited.EXECUTION_PLAN_ID).toBe('stale-plan');
    expect(inherited.EXECUTION_REQUIRE_PLAN).toBe('');
  });
});

describe('④ 委派块当前文本形状（翻转点：C5）', () => {
  const contextSrc = srcOf(SRC_DIR, 'context.ts');

  it('A2A_PROTOCOL_VERSION 随块下行', () => {
    expect(A2A_PROTOCOL_VERSION).toBe('1.0');
  });

  it('委派块五字段在场（C5 结构化载荷）', () => {
    const blockStart = contextSrc.indexOf('const delegationBlock:');
    expect(blockStart).toBeGreaterThan(-1);
    const blockSegment = contextSrc.slice(blockStart, blockStart + 500);
    expect(blockSegment).toContain('request: guardedScope.text');
    expect(blockSegment).toContain('entities,');
    expect(blockSegment).toContain('workspace: scratchDir,');
    expect(blockSegment).toContain('inputs: frozenInputs.map(f => f.path),');
    expect(blockSegment).toContain('protocolVersion: A2A_PROTOCOL_VERSION,');
  });

  it('workerRequest 走结构化块合并', () => {
    expect(contextSrc).toContain('JSON.stringify(delegationBlock)');
    expect(contextSrc).toContain('guardedRequest.text');
  });

  it('契约侧 DelegationBlock 五字段已定义（C5 落地对象的形状基准）', () => {
    const contractsSrc = srcOf(SRC_DIR, '..', '..', 'contracts', 'src', 'a2a-protocol.ts');
    for (const field of ['request', 'entities', 'workspace', 'inputs', 'protocolVersion']) {
      expect(contractsSrc).toContain(field);
    }
    // 形状基准本身可构造（类型即断言）。
    const block: DelegationBlock = {
      request: 'r',
      entities: ['e'],
      workspace: 'w',
      inputs: ['i'],
      protocolVersion: A2A_PROTOCOL_VERSION,
    };
    expect(block.protocolVersion).toBe('1.0');
  });
});

describe('⑤ 委派失败五路链与话术单一来源', () => {
  const contextSrc = srcOf(SRC_DIR, 'context.ts');
  const failureSrc = srcOf(SRC_DIR, 'delegation-failure.ts');

  it('五路链表达式在位（C3 抽纯函数后位于 delegation-failure.ts），判定顺序 = 取消 > 超时 > model_transient > auth > executor_error', () => {
    const cancelled = failureSrc.indexOf("if (aborted) return 'cancelled'");
    const timeout = failureSrc.indexOf("if (deadlinePassed) return 'timeout'");
    const transient = failureSrc.indexOf("if (modelError) return 'model_transient'");
    const auth = failureSrc.indexOf("if (isPlatformAuthError(error)) return 'auth'");
    const fallback = failureSrc.indexOf("return 'executor_error'");
    expect(cancelled).toBeGreaterThan(-1);
    expect(timeout).toBeGreaterThan(-1);
    expect(transient).toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(-1);
    // 同一时刻多条件成立时取最贴近用户动作的那个：源码顺序即优先级。
    expect(cancelled).toBeLessThan(timeout);
    expect(timeout).toBeLessThan(transient);
    expect(transient).toBeLessThan(auth);
    expect(auth).toBeLessThan(fallback);
  });

  it('/平台登录已过期/ 正则兜底在位且带「平台挂码后即删」的过渡标记', () => {
    expect(failureSrc).toContain('/平台登录已过期/.test(');
    expect(failureSrc).toContain('平台侧该消息一带码');
    // 兜底只可能把该形态补判为 auth，不改其他四路。
    const regexIdx = failureSrc.indexOf('/平台登录已过期/.test(');
    const executorIdx = failureSrc.indexOf("return 'executor_error'");
    expect(regexIdx).toBeGreaterThan(-1);
    expect(regexIdx).toBeLessThan(executorIdx);
  });

  it('isPlatformAuthError 是码级判据：消息兜底不在其中（兜底存在的理由）', () => {
    expect(isPlatformAuthError({ code: 'AUTH_EXPIRED' })).toBe(true);
    expect(isPlatformAuthError(new Error('AUTH_EXPIRED: 期望 …'))).toBe(true);
    expect(isPlatformAuthError(new Error('NEEDS_LOGIN: …'))).toBe(true);
    // 不带码前缀的中文消息 isPlatformAuthError 判不了——这正是 context.ts 留正则兜底的原因。
    expect(isPlatformAuthError(new Error('平台登录已过期，自动登录失败——…'))).toBe(false);
    expect(isPlatformAuthError(new Error('boom'))).toBe(false);
    expect(isPlatformAuthError(null)).toBe(false);
  });

  it('话术选择分支在位：C4 收口后统一在 failure-delivery.ts，context.ts 接线 deliverFailure', () => {
    const failureSrc = srcOf(SRC_DIR, 'failure-delivery.ts');
    expect(failureSrc).toContain("toolUserErrorFor('DELEGATION_AUTH_FAILURE')");
    expect(failureSrc).toContain('DELEGATION_CANCELLED');
    expect(failureSrc).toContain('DELEGATION_TIMEOUT_FAILURE');
    expect(failureSrc).toContain('DELEGATION_MODEL_TRANSIENT_FAILURE');
    expect(failureSrc).toContain('DELEGATION_EXECUTOR_FAILURE');
    // context.ts 不再内联五路，改走 deliverFailure。
    expect(contextSrc).toContain('deliverFailure');
  });

  it('五条话术逐字取自 error-codes 表（唯一来源，C3/C4 不得新建第二份）', () => {
    expect(toolUserErrorFor('DELEGATION_CANCELLED').message).toBe('子任务已取消。');
    expect(toolUserErrorFor('DELEGATION_TIMEOUT_FAILURE').message).toBe('平台响应超时，请稍后重试。');
    expect(toolUserErrorFor('DELEGATION_MODEL_TRANSIENT_FAILURE').message)
      .toBe('模型服务瞬时中断，已自动重试仍未成功，请稍后再试。');
    expect(toolUserErrorFor('DELEGATION_EXECUTOR_FAILURE').message).toBe('子任务执行失败，请稍后再试。');
    expect(toolUserErrorFor('DELEGATION_AUTH_FAILURE').message)
      .toBe('平台登录态过期，需要重新登录后才能继续查询。');
  });

  it('RESOURCE_EXHAUSTED 分类常量与协议五类同源', () => {
    expect(RESOURCE_EXHAUSTED_CLASS).toBe('RESOURCE_EXHAUSTED');
    const contractsSrc = srcOf(SRC_DIR, '..', '..', 'contracts', 'src', 'a2a-protocol.ts');
    expect(contractsSrc).toContain("'RESOURCE_EXHAUSTED'");
  });
});

describe('⑥ spawn 面盘点（翻转点：C7 收尾——W1 C7b 已达成 fail-closed 主体）', () => {
  const contractSrc = srcOf(SRC_DIR, 'platform-contract.ts');

  it('gatewayExecPath：声明即派生，未声明/非法即抛（fail-closed）', () => {
    expect(gatewayExecPath('/opt/platform', 'bin/dummy')).toBe('/opt/platform/bin/dummy');
    expect(() => gatewayExecPath('/opt/platform', '../escape')).toThrow();
    expect(() => gatewayExecPath('/opt/platform', '/abs/path')).toThrow();
    expect(() => gatewayExecPath('/opt/platform', '')).toThrow();
    expect(() => gatewayExecPath('/opt/platform', 'bin/x;y')).toThrow();
  });

  it('gatewayExecPathForProfile：profile 未声明 gateway 即抛，不回退任何实例名', () => {
    expect(gatewayExecPathForProfile('/opt/platform', { gateway: 'bin/dummy' }))
      .toBe('/opt/platform/bin/dummy');
    expect(() => gatewayExecPathForProfile('/opt/platform', {})).toThrow(/gateway/);
    expect(() => gatewayExecPathForProfile('/opt/platform', { gateway: '../escape' })).toThrow(/gateway/);
  });

  it('resolveGatewayText 与 validateGatewayInvocation 的 fail-closed 边界', () => {
    expect(resolveGatewayText('bin/dummy')).toBe('bin/dummy');
    expect(() => resolveGatewayText()).toThrow();
    expect(() => resolveGatewayText('bin/../x')).toThrow();
    expect(validateGatewayInvocation('bin/dummy')).toBe(true);
    expect(validateGatewayInvocation('bin/dummy;rm')).toBe(false);
    expect(validateGatewayInvocation('bin//x')).toBe(true);
  });

  it('GATEWAY_INVOCATION 实例名缺省已不在契约适配层（W1 C7b 退役）', () => {
    expect(contractSrc).not.toContain('GATEWAY_INVOCATION');
  });

  it('spawn 消费点盘点：ForProfile 5 处 + gatewayExecPath 7 处 = 12，全部 fail-closed', () => {
    // profile 驱动（fail-closed）：宿主办调两处 + 计划 CLI 一处 + 结构化调用一处 + 冒烟脚本一处。
    for (const file of [
      join(SRC_DIR, 'context.ts'),
      join(SRC_DIR, 'plan-runtime.ts'),
      join(APPS_DIR, 'server', 'proposal-commit.ts'),
      join(SRC_DIR, 'pi-coding-driver.ts'),
      join(SCRIPTS_DIR, 'mock-commit-smoke.ts'),
    ]) {
      expect(srcOf(file)).toContain('gatewayExecPathForProfile(');
    }
    // gatewayExecPath（内部同样 fail-closed）：operation-labels 七处 + 冒烟脚本零处。
    // 'gatewayExecPath(' 作为子串不匹配 'gatewayExecPathForProfile('（其后是 F 不是括号）。
    expect(srcOf(SRC_DIR, 'operation-labels.ts').split('gatewayExecPath(').length - 1).toBe(7);
    expect(srcOf(SCRIPTS_DIR, 'mock-commit-smoke.ts').split('gatewayExecPath(').length - 1).toBe(0);
    // operation-labels 七处的前置是显式降级（未声明 gateway → 空表），不是静默默认。
    const labelsSrc = srcOf(SRC_DIR, 'operation-labels.ts');
    expect(labelsSrc).toContain('validateGatewayInvocation(gateway)');
    expect(labelsSrc).toContain('绝不回退遗留网关名');
  });

  it('mock-commit-smoke.ts 已修复（C7 收尾：gatewayExecPathForProfile + gateway 入参）', () => {
    // 修复：单参数调用 → profile 驱动 + gateway 入参。修完本断言的字面形态随之更新。
    const smokeSrc = srcOf(SCRIPTS_DIR, 'mock-commit-smoke.ts');
    expect(smokeSrc).toContain('gatewayExecPathForProfile(');
    expect(smokeSrc).toContain('gateway');
    expect(smokeSrc).not.toContain('gatewayExecPath(platformRoot)');
  });
});
