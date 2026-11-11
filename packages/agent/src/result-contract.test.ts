/**
 * T10 段1：声明 N，验到 N（结果对账，不是请求校验）。
 *
 * 判据全部机械可判：
 *   ① 写步的 N 来自执行层**计划声明**（ResultContractDeclaration），不来自 worker 文本；
 *   ② 实际落盘数来自宿主对执行层状态的**独立读**（ResultObservation），不来自 worker 文本；
 *   ③ 不足 N 判 shortfall，声明了写却读不出指标判 shape_defect，读回不可用判 inconclusive
 *      —— 三者都**不是** verified，调用方不得记完成；
 *   ④ 只读步（claimsWrite=false）不参与对账，永远不是失败来源。
 *
 * 真实语料（必须被这套判据抓住）：域命令简写走 query 模式、--save 漏传不报错、
 * 空跑 10 分钟退出码仍 0、一张票没存——worker 自述成功，但执行层状态里零落盘。
 */
import { describe, expect, it } from 'vitest';
import {
  reconcileResultContract,
  renderResultContractReply,
  type ResultContractDeclaration,
  type ResultObservation,
} from './result-contract';

const WRITE_TWO: ResultContractDeclaration = {
  claimsWrite: true,
  metrics: [{ metric: 'objects', expected: 2 }],
};

describe('T10-1 结果对账：声明 N vs 宿主独立读到的实际数', () => {
  it('只读步（计划没声称写/上传）不参与对账，永远不是失败来源', () => {
    const result = reconcileResultContract({
      declaration: { claimsWrite: false, metrics: [] },
      observations: null,
    });
    expect(result.verdict).toBe('verified');
    expect(result.reason).toBe('read_only');
    expect(result.shortfalls).toEqual([]);
  });

  it('没有执行层声明（端口未接线/计划未声明）时不做无根据的判定', () => {
    const result = reconcileResultContract({ declaration: null, observations: null });
    expect(result.verdict).toBe('verified');
    expect(result.reason).toBe('read_only');
  });

  it('语料形状：声明写 2 个对象、实际零落盘（--save 漏传/query 模式空跑）→ shortfall，不是完成', () => {
    const result = reconcileResultContract({
      declaration: WRITE_TWO,
      observations: [{ metric: 'objects', actual: 0 }],
    });
    expect(result.verdict).toBe('shortfall');
    expect(result.reason).toBe('below_declared');
    expect(result.shortfalls).toEqual([{ metric: 'objects', expected: 2, actual: 0, missing: 2 }]);
    // 对账依据必须逐项留痕：声明值来自执行层计划，实际值来自宿主独立读
    expect(result.declarations).toEqual([{ metric: 'objects', expected: 2 }]);
    expect(result.observations).toEqual([{ metric: 'objects', actual: 0 }]);
  });

  it('声明 2、实际 1 → shortfall（差额 1），判据是 actual < expected 而不是 actual === 0', () => {
    const result = reconcileResultContract({
      declaration: WRITE_TWO,
      observations: [{ metric: 'objects', actual: 1 }],
    });
    expect(result.verdict).toBe('shortfall');
    expect(result.shortfalls).toEqual([{ metric: 'objects', expected: 2, actual: 1, missing: 1 }]);
  });

  it('声明 2、实际 2 → verified', () => {
    const result = reconcileResultContract({
      declaration: WRITE_TWO,
      observations: [{ metric: 'objects', actual: 2 }],
    });
    expect(result.verdict).toBe('verified');
    expect(result.reason).toBe('verified');
    expect(result.shortfalls).toEqual([]);
  });

  it('声明写但**一个可读指标都没声明** → shape_defect（禁止用 worker 的话凑）', () => {
    const result = reconcileResultContract({
      declaration: { claimsWrite: true, metrics: [] },
      observations: [{ metric: 'objects', actual: 2 }],
    });
    expect(result.verdict).toBe('shape_defect');
    expect(result.reason).toBe('no_readable_metric');
    expect(result.unreadable).toEqual([]);
  });

  it('声明了指标但读回里没有这一项 → shape_defect 并点名读不出的指标', () => {
    const result = reconcileResultContract({
      declaration: { claimsWrite: true, metrics: [{ metric: 'objects', expected: 2 }, { metric: 'files', expected: 3 }] },
      observations: [{ metric: 'objects', actual: 2 }],
    });
    expect(result.verdict).toBe('shape_defect');
    expect(result.reason).toBe('unreadable_metric');
    expect(result.unreadable).toEqual(['files']);
  });

  it('读回整体不可用（null）→ inconclusive，绝不写成 verified/清白', () => {
    const result = reconcileResultContract({ declaration: WRITE_TWO, observations: null });
    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toBe('probe_unavailable');
    expect(result.shortfalls).toEqual([]);
  });

  it('多指标各自对账：任一不足即 shortfall，其余足额不掩盖它', () => {
    const result = reconcileResultContract({
      declaration: { claimsWrite: true, metrics: [{ metric: 'objects', expected: 2 }, { metric: 'files', expected: 3 }] },
      observations: [{ metric: 'objects', actual: 2 }, { metric: 'files', actual: 1 }],
    });
    expect(result.verdict).toBe('shortfall');
    expect(result.shortfalls).toEqual([{ metric: 'files', expected: 3, actual: 1, missing: 2 }]);
  });

  it('用户可见话术陈述声明值与独立读回值，不引用 worker 文本、不含执行层实现细节', () => {
    const result = reconcileResultContract({
      declaration: WRITE_TWO,
      observations: [{ metric: 'objects', actual: 0 }],
    });
    const reply = renderResultContractReply(result);
    expect(reply).toContain('2');
    expect(reply).toContain('0');
    expect(reply).not.toContain('fill');
    expect(reply).not.toContain('.js');
    expect(reply).not.toContain('--save');
    expect(reply).not.toMatch(/[A-Z][A-Z_]{3,}/);
    // 不许把不足说成完成
    expect(reply).not.toMatch(/已完成|成功/);
  });

  it('shape_defect 的用户话术说清"没法核实"，不下"已保存"结论', () => {
    const reply = renderResultContractReply(reconcileResultContract({
      declaration: { claimsWrite: true, metrics: [] },
      observations: [{ metric: 'objects', actual: 0 }],
    }));
    expect(reply).toContain('无法核实');
    expect(reply).not.toMatch(/已完成|成功保存/);
  });
});
