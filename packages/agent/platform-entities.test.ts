import { describe, expect, it } from 'vitest';
import type { TranscriptMessageLike } from './src/platform-contract';
import {
  createTaskPlatformRecorder,
  mergeTaskPlatformSources,
  transcriptPlatformSources,
} from './src/platform-entities';

/**
 * 平台证据的两个通道（D-085）。
 *
 * 覆盖判据从"最后 N 条 tool_result"改成"本任务迄今全部"，物化成两个通道：
 *   · 转录通道——会话里现存的 tool_result；
 *   · 账本通道——宿主在 afterToolCall 上记下的执行完的工具结果。
 * 账本通道存在的理由是 SDK 的**自动压缩**：阈值 = contextWindow − reserveTokens，一到就把
 * `agent.state.messages` 换成 `[压缩摘要] + [保留尾段]`，早期 tool_result 整条消失。长任务
 * （42 个历史验收库里单请求 tool_call 数 9…87）必然触发，只读转录等于把"本任务迄今"偷偷
 * 换成"压缩后还剩多少"。
 */

/**
 * 造一条转录消息。`isError` 与压缩摘要的 `summary` 都不在 `TranscriptMessageLike` 里——
 * 生产判据刻意不读它们（不按 isError 过滤、压缩摘要整条跳过），只有测试需要把它们造出来。
 */
function message(fields: Record<string, unknown>): TranscriptMessageLike {
  return fields as TranscriptMessageLike;
}

const ENVELOPE = 'RESULT {"v":1,"op":"finance.search-references","status":"completed","data":{"candidates":[{"id":"c_1","name":"胜利五金有限责任公司"}]}}';
/**
 * `data` 里**所有**字符串叶都收，包括 `id`：宿主是领域无关的，它没有办法知道哪个字段是
 * "名字"、哪个是平台内部编号——按字段名挑一份出来就要在编排层维护一份业务词表。收全部
 * 叶值只会让 haystack 多几个"平台确实返回过"的字符串，不会放行任何平台没说过的东西。
 */

describe('平台证据：信封 data 的字符串叶', () => {
  it('嵌套对象与数组都递归，全部叶值成为实体值', () => {
    const sources = transcriptPlatformSources([message({
      role: 'toolResult',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: ENVELOPE }],
    })]);
    expect(sources.entities).toEqual(['c_1', '胜利五金有限责任公司']);
  });

  it('没有 RESULT 信封的响应不贡献任何实体值（宁缺勿猜）', () => {
    const sources = transcriptPlatformSources([message({
      role: 'toolResult',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: '更早的响应：提到了新兴五金' }],
    })]);
    expect(sources.entities).toEqual([]);
    // 原文通道照旧收：非信封原文同样是平台说过的话
    expect(sources.responses).toEqual(['更早的响应：提到了新兴五金']);
  });

  it('只取 data：error 的消息文案与 correctForm 不进实体值', () => {
    const sources = transcriptPlatformSources([message({
      role: 'toolResult',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'RESULT {"v":1,"op":"x","status":"failed","data":{"candidates":[]},"error":{"code":"NOT_FOUND","message":"猫一杯 未登记","correctForm":"请改用规范名"}}' }],
    })]);
    expect(sources.entities).toEqual([]);
  });

  it('超长值（> ENTITY_VALUE_MAX_CHARS）与非字符串叶不收', () => {
    const sources = transcriptPlatformSources([message({
      role: 'toolResult',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'RESULT {"v":1,"op":"x","status":"completed","data":{"long":"' + 'x'.repeat(60) + '","count":7,"ok":true,"nil":null,"list":["猫一杯"]}}' }],
    })]);
    expect(sources.entities).toEqual(['猫一杯']);
  });

  it('去重保序：同一值多处出现只收一次', () => {
    const sources = transcriptPlatformSources([message({
      role: 'toolResult',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'RESULT {"v":1,"op":"x","status":"completed","data":{"a":"猫一杯","b":"猫一杯","c":"胜利五金有限责任公司"}}' }],
    })]);
    expect(sources.entities).toEqual(['猫一杯', '胜利五金有限责任公司']);
  });

  it('JSON 转义叶值：原文子串匹配不到、叶值匹配得到（附加来源不是空壳）', () => {
    // 引号在原文里是 \"，在叶值里是 "。逐字包含判据在原文上找不到这个值，
    // 只有结构化投影能把它带进 haystack——这是 ③′ 唯一可证的新增形状。
    const sources = transcriptPlatformSources([message({
      role: 'toolResult',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'RESULT {"v":1,"op":"x","status":"completed","data":{"note":"他说\\"猫一杯\\"是规范名"}}' }],
    })]);
    expect(sources.entities).toEqual(['他说"猫一杯"是规范名']);
    expect(sources.responses[0]).not.toContain('他说"猫一杯"是规范名');
  });
});

describe('平台证据：按身份排除宿主自己拦下的那一跳', () => {
  it('被拦下的 toolResult 按 toolCallId 整条排除（原文与叶值都不进）', () => {
    const sources = transcriptPlatformSources([message({
      role: 'toolResult',
      toolCallId: 'call_blocked',
      content: [{ type: 'text', text: 'PLAN DECLINED：ENTITY_OUT_OF_SCOPE: 实际 计划包含未在…中出现的参数：猫一杯' }],
    })], new Set(['call_blocked']));
    expect(sources.responses).toEqual([]);
    expect(sources.entities).toEqual([]);
  });

  it('toolCallId 不在拦下集合、且 isError 为真时照旧收（不按 isError 过滤）', () => {
    const sources = transcriptPlatformSources([message({
      role: 'toolResult',
      toolCallId: 'call_failed',
      isError: true,
      content: [{ type: 'text', text: 'Command exited with code 3\nRESULT {"v":1,"op":"x","status":"failed","error":{"code":"NOT_FOUND","message":"猫一杯 未登记"}}' }],
    })]);
    expect(sources.responses).toHaveLength(1);
  });

  it('空 toolCallId 的 toolResult 不会被误判成"被拦下的"', () => {
    const sources = transcriptPlatformSources([message({
      role: 'toolResult',
      content: [{ type: 'text', text: ENVELOPE }],
    })], new Set(['call_blocked']));
    expect(sources.responses).toEqual([ENVELOPE]);
  });
});

describe('平台证据：原文通道不取最后 N 条', () => {
  it('本任务全部 toolResult 都收', () => {
    const messages = Array.from({ length: 25 }, (_unused, index) => ({
      role: 'toolResult',
      toolCallId: `call_${index}`,
      content: [{ type: 'text', text: `RESULT {"v":1,"op":"x","status":"completed","data":{"n":${index}}}` }],
    }));
    const sources = transcriptPlatformSources(messages);
    expect(sources.responses).toHaveLength(25);
    expect(sources.entities).toHaveLength(0); // data.n 是数字，不是字符串叶
  });

  it('非 toolResult 角色与空正文都不收', () => {
    const sources = transcriptPlatformSources([
      message({ role: 'assistant', toolCallId: 'call_1', content: [{ type: 'text', text: ENVELOPE }] }),
      message({ role: 'toolResult', toolCallId: 'call_2', content: [{ type: 'text', text: '   ' }] }),
      message({ role: 'toolResult', toolCallId: 'call_3', content: [] }),
      message({ role: 'compactionSummary', summary: 'x' }),
    ]);
    expect(sources.responses).toEqual([]);
  });
});

describe('平台证据：账本通道（压缩免疫）', () => {
  it('record 之后 snapshot 取回原文与实体值；空/非文本内容不收', () => {
    const recorder = createTaskPlatformRecorder();
    recorder.record([{ type: 'text', text: ENVELOPE }]);
    recorder.record('');
    recorder.record([]);
    recorder.record({ not: 'content' });
    const snapshot = recorder.snapshot();
    expect(snapshot.responses).toEqual([ENVELOPE]);
    expect(snapshot.entities).toEqual(['c_1', '胜利五金有限责任公司']);
  });

  it('snapshot 是副本：后续 record 不改变已取回的快照', () => {
    const recorder = createTaskPlatformRecorder();
    recorder.record([{ type: 'text', text: ENVELOPE }]);
    const first = recorder.snapshot();
    recorder.record([{ type: 'text', text: 'RESULT {"v":1,"op":"x","status":"completed","data":{"n":"猫一杯"}}' }]);
    expect(first.responses).toHaveLength(1);
    expect(first.entities).toEqual(['c_1', '胜利五金有限责任公司']);
    expect(recorder.snapshot().responses).toHaveLength(2);
  });
});

describe('平台证据：两通道合并', () => {
  it('同一份响应在两个通道各出现一次时只判一次', () => {
    const merged = mergeTaskPlatformSources(
      { responses: [ENVELOPE], entities: ['c_1', '胜利五金有限责任公司'] },
      { responses: [ENVELOPE], entities: ['c_1', '胜利五金有限责任公司'] },
    );
    expect(merged.responses).toEqual([ENVELOPE]);
    expect(merged.entities).toEqual(['c_1', '胜利五金有限责任公司']);
  });

  it('并集去重保序；空组不占地', () => {
    const merged = mergeTaskPlatformSources(
      { responses: [], entities: [] },
      { responses: ['a', 'b'], entities: ['x'] },
      { responses: ['b', 'c'], entities: ['x', 'y'] },
    );
    expect(merged.responses).toEqual(['a', 'b', 'c']);
    expect(merged.entities).toEqual(['x', 'y']);
  });
});
