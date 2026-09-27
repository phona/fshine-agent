/**
 * 错误码表（error-codes.ts）的纪律测试（2026-09 第二波，镜像 17dz 侧同款测试位）。
 *
 * 钉住三件事：
 *   ① 错误类码渲染三要素（码 + 期望/实际/正确形态），actual 缺省给稳定形态；
 *   ② 消息模板类码逐字返回表内文本（收尾/兜底话术的既有文本一个字不动）；
 *   ③ 未知码与误用 fail-loud——绝不静默 fallback 到通用消息。
 * 另钉两条表级纪律：措辞零业务词（泄漏 lint 同款预算）、17dz 镜像的 auth 码集合。
 */
import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_ERROR_CODE,
  errorFor,
  has,
  messageFor,
  messageTextFor,
  toolUserErrorFor,
} from './src/error-codes';
import { ToolUserError } from './src/driver';
import {
  DELEGATION_AUTH_FAILURE,
  DELEGATION_CANCELLED,
  DELEGATION_EXECUTOR_FAILURE,
  DELEGATION_TIMEOUT_FAILURE,
} from './src/context';
import {
  ACTIVATED_PLAN_NOT_EXECUTED,
  FALLBACK_FAILURE,
  FALLBACK_TIMEOUT,
  NO_EXECUTION_CLARIFICATION,
  RESUMED_PLAN_NOT_EXECUTED,
} from './src/runtime';
describe('fshine 错误码表（错误即数据）', () => {
  it('错误类码渲染三要素：码 + 期望/实际/正确形态，动态 actual 由拒绝点填', () => {
    expect(messageFor('PLAN_SHAPE_PREFIX', '```json')).toBe('PLAN_SHAPE_PREFIX: 期望 bin/17dz plan 之前只允许 bash/sh 与路径前缀（围栏、外层引号、客套话都算多出来的内容）；实际 ```json；正确形态 方案是单行原始命令：bin/17dz plan {"goal":"…","calls":[…]}，JSON 原样放在这一行命令里。');
    // 索引类 actual 原样进消息（第几项出错要点得出来）
    expect(messageFor('PLAN_CALL_NOT_OBJECT', 2)).toContain('实际 2；');
    // 稳定实际形态的码不传 actual 也有"实际"段
    expect(messageFor('TASK_ID_INVALID')).toContain('实际 taskId 为空或不是字符串；');
  });

  it('消息模板类码逐字返回表内文本：收尾/兜底话术与既有文本一致', () => {
    expect(messageTextFor('NO_EXECUTION_CLARIFICATION')).toBe('我需要实际查询平台才能回答这个问题，但本轮没有产生任何平台查询。请告诉我要查询的对象和范围，我重新查一次。');
    expect(messageTextFor('ACTIVATED_PLAN_NOT_EXECUTED')).toBe('执行方案已获批准（通知已送达），但查询没有执行。请回复“继续”，我按已批准的计划重新执行；如想改查询范围，直接告诉我。');
    expect(messageTextFor('RESUMED_PLAN_NOT_EXECUTED')).toBe('按您刚才确认的操作没有产生任何平台执行。请回复“继续”重跑，或直接告诉我要调整的范围。');
    expect(messageTextFor('FALLBACK_TIMEOUT')).toBe('查询超时,请稍后再试');
    expect(messageTextFor('FALLBACK_FAILURE')).toBe('查询失败,请稍后再试或联系管理员');
    expect(messageTextFor('DELEGATION_AUTH_FAILURE')).toBe('平台登录态过期，需要重新登录后才能继续查询。');
    expect(messageTextFor('DELEGATION_TIMEOUT_FAILURE')).toBe('平台响应超时，请稍后重试。');
    expect(messageTextFor('DELEGATION_EXECUTOR_FAILURE')).toBe('17dz 子任务执行失败，请稍后再试。');
    expect(messageTextFor('DELEGATION_CANCELLED')).toBe('17dz 子任务已取消。');
    expect(messageTextFor('ROUTE_RETRY_NUDGE')).toContain('route_current_turn');
    expect(messageTextFor('PLAN_PENDING_PERSIST_MISSING')).toBe('平台计划待确认，但宿主未配置安全持久化回调，请联系管理员。');
    // runtime/context 的导出常量就是表值（同一份来源，测试与调用方继续认常量）
    expect(NO_EXECUTION_CLARIFICATION).toBe(messageTextFor('NO_EXECUTION_CLARIFICATION'));
    expect(ACTIVATED_PLAN_NOT_EXECUTED).toBe(messageTextFor('ACTIVATED_PLAN_NOT_EXECUTED'));
    expect(RESUMED_PLAN_NOT_EXECUTED).toBe(messageTextFor('RESUMED_PLAN_NOT_EXECUTED'));
    expect(FALLBACK_TIMEOUT).toBe(messageTextFor('FALLBACK_TIMEOUT'));
    expect(FALLBACK_FAILURE).toBe(messageTextFor('FALLBACK_FAILURE'));
    expect(DELEGATION_AUTH_FAILURE).toBe(messageTextFor('DELEGATION_AUTH_FAILURE'));
    expect(DELEGATION_TIMEOUT_FAILURE).toBe(messageTextFor('DELEGATION_TIMEOUT_FAILURE'));
    expect(DELEGATION_EXECUTOR_FAILURE).toBe(messageTextFor('DELEGATION_EXECUTOR_FAILURE'));
    expect(DELEGATION_CANCELLED).toBe(messageTextFor('DELEGATION_CANCELLED'));
  });

  it('未知码 fail-loud：抛 UNKNOWN_ERROR_CODE 并挂上未登记的码，不静默 fallback', () => {
    for (const call of [
      () => messageFor('TOTALLY_NEW_FAILURE'),
      () => messageTextFor('TOTALLY_NEW_FAILURE'),
      () => errorFor('TOTALLY_NEW_FAILURE'),
      () => toolUserErrorFor('TOTALLY_NEW_FAILURE'),
    ]) {
      expect(call).toThrow(UNKNOWN_ERROR_CODE);
      try { call(); } catch (error) {
        expect((error as { code?: string }).code).toBe(UNKNOWN_ERROR_CODE);
        expect((error as { unknownCode?: string }).unknownCode).toBe('TOTALLY_NEW_FAILURE');
      }
    }
    expect(has('PLAN_SHAPE_PREFIX')).toBe(true);
    expect(has('TOTALLY_NEW_FAILURE')).toBe(false);
  });

  it('误用 fail-loud：消息模板类码不接受 actual/correctForm（它不是错误）', () => {
    expect(() => messageFor('NO_EXECUTION_CLARIFICATION', '多余的实际值')).toThrow(UNKNOWN_ERROR_CODE);
    expect(() => messageFor('ACTIVATED_PLAN_NOT_EXECUTED', undefined, '多余的正确形态')).toThrow(UNKNOWN_ERROR_CODE);
  });

  it('throw 站点：errorFor / toolUserErrorFor 把原码挂回 error.code（调用方继续认码）', () => {
    const plain = errorFor('TASK_NOT_FOUND');
    expect(plain).toBeInstanceOf(Error);
    expect(plain.message).toContain('TASK_NOT_FOUND: 期望');
    expect((plain as { code?: string }).code).toBe('TASK_NOT_FOUND');

    const tool = toolUserErrorFor('TASK_FORBIDDEN');
    expect(tool).toBeInstanceOf(ToolUserError);
    expect(tool.message).toContain('TASK_FORBIDDEN: 期望');
    expect((tool as { code?: string }).code).toBe('TASK_FORBIDDEN');
  });

  it('表级纪律：全部条目措辞零业务词（泄漏 lint 同款预算）', () => {
    // 镜像 platform-leak-lint 的业务词集合：执行层持有领域词，编排层不替平台说话
    const business = /应收|凭证|科目|账套|期间|目录/u;
    for (const code of ['PLAN_SHAPE_PREFIX', 'PLAN_SHAPE_GATE_TEACHING', 'ENTITY_OUT_OF_SCOPE', 'DECLINED_PLAN_LIMIT', 'TASK_NOT_FOUND', 'RESUMED_PLAN_NOT_EXECUTED', 'PLAN_PENDING_PERSIST_MISSING']) {
      expect(messageFor(code), code).not.toMatch(business);
    }
  });
});
