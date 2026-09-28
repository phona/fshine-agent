/**
 * 会话实体（任务 1 标定修复）：来源 A 的规格机械提取 + 来源 B 的澄清事件绑定。
 *
 * 钉三件事：① 提取只认平台 args 规格声明（零硬编码参数名），只取**执行过**的任务的
 * calls 快照（不是搜索结果候选、不是结果原文），规格缺失降级为空数组；② 澄清事件
 * issued→resolved 的状态机与裸编号/名称绑定规则（纯数字 / 逐字名称 / 非编号不误绑 /
 * 插过回合失效）；③ 合并去重。
 */
import { describe, expect, it } from 'vitest';
import type { ConversationEventRecord, PlatformTaskRecord } from '@fshine/contracts';
import { parseOperationArgSpecs } from './src/operation-labels';
import {
  collectSessionEntities,
  mergeSessionEntities,
  sessionEntitiesFromRecords,
} from './src/session-entities';
import {
  clarificationIssuedRecord,
  clarificationResolvedRecord,
  matchClarificationBinding,
  parseClarificationEvent,
} from './src/clarification-events';

/** 与平台 `operation list --json` 同形的预置规格（节选：flag 全样式 + 两种位置参数形态）。 */
const SPECS = parseOperationArgSpecs(JSON.stringify([
  {
    name: 'finance.query-receivables', command: 'query-receivables',
    args: {
      positional: [],
      flags: [
        { flag: '--query', required: true, style: 'name' },
        { flag: '--customer', required: false, style: 'name' },
        { flag: '--subject-code', required: false, style: 'code' },
        { flag: '--period', required: false, style: 'code' },
        { flag: '--all', required: false, style: 'none' },
      ],
    },
  },
  {
    name: 'voucher.query-saved', command: 'query-saved',
    args: {
      positional: [
        { name: 'accountSet', required: true, style: 'name' },
        { name: 'period', required: true, style: 'code' },
      ],
      flags: [],
    },
  },
]));

function task(overrides: Partial<PlatformTaskRecord> & { taskId: string }): PlatformTaskRecord {
  return {
    parentSessionId: 'sess_1', principalId: 'wecom:user_a', workerMessages: [],
    createdAt: '2026-09-27T10:00:00.000Z', updatedAt: '2026-09-27T10:00:00.000Z',
    ...overrides,
  };
}

describe('来源 A：执行过的任务的实体提取（平台 args 规格查表）', () => {
  it('按规格提取：位置参数按声明名、flag 按登记样式；未声明的值不冒领', () => {
    const entities = sessionEntitiesFromRecords([
      task({
        taskId: 'task_1', outcome: 'done',
        calls: [
          { operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202609'] },
          { operation: 'voucher.query-saved', args: ['新兴五金', '202608'] },
        ],
      }),
    ], SPECS);
    // name/code 样式的实体承载参数全部进；布尔开关无取值可摘
    expect(entities).toEqual(['幻辰财税', '202609', '新兴五金', '202608']);
  });

  it('未在规格里登记的 flag：其取值不被当作实体，也不挤掉真正的位置参数', () => {
    const entities = sessionEntitiesFromRecords([
      task({
        taskId: 'task_1', outcome: 'done',
        // --made-up 不在规格里：它的取值 'x' 不是实体，且 '新兴五金' 仍是第一个位置参数
        calls: [{ operation: 'voucher.query-saved', args: ['--made-up', 'x', '新兴五金', '202608'] }],
      }),
    ], SPECS);
    expect(entities).toEqual(['新兴五金', '202608']);
  });

  it('规格查不到的 operation → 该调用不贡献（宁缺勿猜）', () => {
    const entities = sessionEntitiesFromRecords([
      task({
        taskId: 'task_1', outcome: 'done',
        calls: [{ operation: 'unknown.operation', args: ['幻觉对象', '202609'] }],
      }),
    ], SPECS);
    expect(entities).toEqual([]);
  });

  it('规格缺失 / 空表 → 空数组（安全缺省，与 label/argStyles 派生同一纪律）', () => {
    const records = [task({
      taskId: 'task_1', outcome: 'done',
      calls: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }],
    })];
    expect(sessionEntitiesFromRecords(records, undefined)).toEqual([]);
    expect(sessionEntitiesFromRecords(records, new Map())).toEqual([]);
  });

  it('只取执行过的任务：needs / failed / 无结局的 calls 快照不进（没执行过就没有用户授权）', () => {
    const entities = sessionEntitiesFromRecords([
      task({ taskId: 't_needs', outcome: 'needs', calls: [{ operation: 'finance.query-receivables', args: ['--query', '没执行成的对象'] }] }),
      task({ taskId: 't_failed', outcome: 'failed', calls: [{ operation: 'finance.query-receivables', args: ['--query', '失败的任务'] }] }),
      task({ taskId: 't_legacy', calls: [{ operation: 'finance.query-receivables', args: ['--query', '旧记录'] }] }),
      task({ taskId: 't_done', outcome: 'done', calls: [{ operation: 'finance.query-receivables', args: ['--query', '真执行过的对象'] }] }),
    ], SPECS);
    expect(entities).toEqual(['真执行过的对象']);
  });

  it('只取 calls 快照：结果原文/候选清单里提到的名字不进（"提过"不等于"执行过"）', () => {
    const entities = sessionEntitiesFromRecords([
      task({
        taskId: 't_done_no_calls', outcome: 'done',
        resultText: '幻辰财税 202606 应收账款余额为 61000 元。候选：幻辰实业有限公司。',
      }),
      task({
        taskId: 't_done', outcome: 'done',
        calls: [{ operation: 'finance.query-receivables', args: ['--query', '幻东'] }],
        resultText: '幻东 202609 余额 51 元。散文里还提到过新兴建材。',
      }),
    ], SPECS);
    expect(entities).toEqual(['幻东']);
  });

  it('取值卫生：剥引号、超长值丢弃、空串跳过', () => {
    const entities = sessionEntitiesFromRecords([
      task({
        taskId: 't_1', outcome: 'done',
        calls: [{ operation: 'finance.query-receivables', args: ['--query', '  "幻辰财税"  ', '--period', ''] }],
      }),
      task({
        taskId: 't_2', outcome: 'done',
        calls: [{ operation: 'finance.query-receivables', args: ['--query', 'x'.repeat(41)] }],
      }),
    ], SPECS);
    expect(entities).toEqual(['幻辰财税']);
  });

  it('同一实体多次执行只留一份；多个任务按时间正序合并', () => {
    const entities = sessionEntitiesFromRecords([
      task({ taskId: 't_1', outcome: 'done', createdAt: '2026-09-27T10:00:00.000Z', calls: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }] }),
      task({ taskId: 't_2', outcome: 'done', createdAt: '2026-09-27T11:00:00.000Z', calls: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }] }),
      task({ taskId: 't_3', outcome: 'done', createdAt: '2026-09-27T12:00:00.000Z', calls: [{ operation: 'finance.query-receivables', args: ['--query', '幻东'] }] }),
    ], SPECS);
    expect(entities).toEqual(['幻辰财税', '幻东']);
  });

  it('collectSessionEntities：按 principal/会话隔离读底账，存储抛错向上传播（调用方兜底）', async () => {
    const records = [
      task({ taskId: 'other_session', parentSessionId: 'sess_2', outcome: 'done', calls: [{ operation: 'finance.query-receivables', args: ['--query', '别会话的对象'] }] }),
      task({ taskId: 'mine', outcome: 'done', calls: [{ operation: 'finance.query-receivables', args: ['--query', '本会话的对象'] }] }),
    ];
    const entities = await collectSessionEntities({
      platformTasks: { listBySession: async (principalId, sessionId) => records.filter((r) => r.principalId === principalId && r.parentSessionId === sessionId) },
      operationArgSpecs: SPECS,
      principalId: 'wecom:user_a',
      sessionId: 'sess_1',
    });
    expect(entities).toEqual(['本会话的对象']);
    await expect(collectSessionEntities({
      platformTasks: { listBySession: async () => { throw new Error('disk unavailable'); } },
      principalId: 'wecom:user_a', sessionId: 'sess_1',
    })).rejects.toThrow('disk unavailable');
  });
});

describe('合并去重：来源 A（执行实体）∪ 来源 B（澄清选定）', () => {
  it('并集去重保序；空组不占地', () => {
    expect(mergeSessionEntities(['幻辰财税'], ['幻辰财税', '幻东'])).toEqual(['幻辰财税', '幻东']);
    expect(mergeSessionEntities([], ['幻东'])).toEqual(['幻东']);
    expect(mergeSessionEntities()).toEqual([]);
    // 空白值不入并集
    expect(mergeSessionEntities(['  '], ['幻东'])).toEqual(['幻东']);
  });
});

// ── 来源 B：clarification_event 事件族 ────────────────────────────────────

function ctx(requestId = 'req_clarify') {
  return { requestId, principalId: 'wecom:user_a', sessionId: 'sess_1', allowedAccountSetIds: [], capabilities: ['read'] };
}

function event(overrides: Partial<ConversationEventRecord> & { eventId: string; kind: ConversationEventRecord['kind'] }): ConversationEventRecord {
  return {
    principalId: 'wecom:user_a', sessionId: 'sess_1',
    createdAt: '2026-09-27T10:00:00.000Z',
    ...overrides,
  };
}

/** 一条"宿主发出澄清"的最小事件序列：issued + 同回合的 assistant 问题。 */
function issuedSequence(candidates: string[], requestId = 'req_clarify'): ConversationEventRecord[] {
  return [
    event({ eventId: `${requestId}:clarification_issued`, kind: 'clarification_event', content: JSON.stringify({ status: 'issued', code: 'ACCOUNT_SET_AMBIGUOUS', query: '幻辰', candidates, requestId }), requestId }),
    event({ eventId: `${requestId}:assistant`, kind: 'assistant_message', content: '没有找到唯一匹配“幻辰”的对象。你要查哪个？', requestId }),
  ];
}

describe('clarification_event：载荷解析', () => {
  it('issued / resolved 结构化载荷正常解析', () => {
    const issued = parseClarificationEvent(JSON.stringify({ status: 'issued', code: 'ACCOUNT_SET_AMBIGUOUS', query: '幻辰', candidates: ['幻辰财税'], requestId: 'req_1' }));
    expect(issued).toEqual({ status: 'issued', code: 'ACCOUNT_SET_AMBIGUOUS', query: '幻辰', candidates: ['幻辰财税'], requestId: 'req_1' });
    const resolved = parseClarificationEvent(JSON.stringify({ status: 'resolved', selected: '幻辰财税', requestId: 'req_1' }));
    expect(resolved).toEqual({ status: 'resolved', selected: '幻辰财税', requestId: 'req_1' });
  });

  it('坏 JSON / 非本族事件 / 字段不齐 → null（按"没有"处理，不猜）', () => {
    expect(parseClarificationEvent('不是 JSON')).toBeNull();
    expect(parseClarificationEvent(undefined)).toBeNull();
    expect(parseClarificationEvent(JSON.stringify({ status: 'issued', candidates: [], requestId: 'req_1' }))).toBeNull();
    expect(parseClarificationEvent(JSON.stringify({ status: 'issued', candidates: ['甲'], requestId: '' }))).toBeNull();
    expect(parseClarificationEvent(JSON.stringify({ status: 'resolved', requestId: 'req_1' }))).toBeNull();
    expect(parseClarificationEvent(JSON.stringify({ status: 'unknown' }))).toBeNull();
  });

  it('record 构造：issued 用发出回合的 requestId，resolved 用被 resolves 的 requestId 作关联键', () => {
    const issued = clarificationIssuedRecord(ctx('req_ask'), { code: 'ACCOUNT_SET_AMBIGUOUS', query: '幻辰', candidates: ['幻辰财税', '幻辰实业有限公司'] });
    expect(issued).toMatchObject({
      eventId: 'req_ask:clarification_issued', kind: 'clarification_event', requestId: 'req_ask',
    });
    expect(parseClarificationEvent(issued.content)).toMatchObject({ status: 'issued', candidates: ['幻辰财税', '幻辰实业有限公司'] });
    const resolved = clarificationResolvedRecord(ctx('req_answer'), { selected: '幻辰财税', requestId: 'req_ask' });
    expect(resolved).toMatchObject({ eventId: 'req_answer:clarification_resolved', requestId: 'req_answer' });
    expect(parseClarificationEvent(resolved.content)).toEqual({ status: 'resolved', selected: '幻辰财税', requestId: 'req_ask' });
  });
});

describe('裸编号/名称答复的宿主机械绑定', () => {
  const candidates = ['幻辰财税', '幻辰实业有限公司'];

  it('纯编号落在候选个数内 → 绑定到对应候选（“1”不再过模型解释）', () => {
    expect(matchClarificationBinding(issuedSequence(candidates), '1')).toEqual({ selected: '幻辰财税', requestId: 'req_clarify' });
    expect(matchClarificationBinding(issuedSequence(candidates), ' 2 ')).toEqual({ selected: '幻辰实业有限公司', requestId: 'req_clarify' });
  });

  it('与候选逐字相同的名称 → 绑定到该候选', () => {
    expect(matchClarificationBinding(issuedSequence(candidates), '幻辰财税')).toEqual({ selected: '幻辰财税', requestId: 'req_clarify' });
  });

  it('编号越界 / 非编号非名称 / 多句话 → 不绑（消息按普通回合进模型）', () => {
    expect(matchClarificationBinding(issuedSequence(candidates), '3')).toBeNull();
    expect(matchClarificationBinding(issuedSequence(candidates), '查一下幻辰财税 202609')).toBeNull();
    expect(matchClarificationBinding(issuedSequence(candidates), '幻辰财税 202609')).toBeNull();
    expect(matchClarificationBinding(issuedSequence(candidates), '你好')).toBeNull();
    expect(matchClarificationBinding(issuedSequence(candidates), '0')).toBeNull();
    expect(matchClarificationBinding(issuedSequence(candidates), '12')).toBeNull();
  });

  it('已 resolved 的澄清不重复绑；没有澄清事件更不绑', () => {
    const resolved = [
      ...issuedSequence(candidates),
      event({ eventId: 'req_answer:clarification_resolved', kind: 'clarification_event', content: JSON.stringify({ status: 'resolved', selected: '幻辰财税', requestId: 'req_clarify' }), requestId: 'req_answer' }),
    ];
    expect(matchClarificationBinding(resolved, '1')).toBeNull();
    expect(matchClarificationBinding([event({ eventId: 'e1', kind: 'user_message', content: '你好' })], '1')).toBeNull();
    expect(matchClarificationBinding([], '1')).toBeNull();
  });

  it('邻近性：中间插过任何回合（最后一条 assistant 不是那条澄清问题）即失效', () => {
    const interleaved = [
      ...issuedSequence(candidates),
      event({ eventId: 'req_other:user', kind: 'user_message', content: '那新兴五金呢', requestId: 'req_other' }),
      event({ eventId: 'req_other:assistant', kind: 'assistant_message', content: '新兴五金 202609 余额 0 元。', requestId: 'req_other' }),
    ];
    expect(matchClarificationBinding(interleaved, '1')).toBeNull();
  });

  it('issued 之后用户先问了别的（assistant 换了 requestId），再发编号也不绑', () => {
    const events = [
      ...issuedSequence(candidates, 'req_ask_1'),
      event({ eventId: 'req_ask_2:clarification_issued', kind: 'clarification_event', content: JSON.stringify({ status: 'issued', code: 'ACCOUNT_SET_AMBIGUOUS', query: '幻东', candidates: ['幻东汽配'], requestId: 'req_ask_2' }), requestId: 'req_ask_2' }),
      event({ eventId: 'req_ask_2:assistant', kind: 'assistant_message', content: '没有找到唯一匹配“幻东”的对象。', requestId: 'req_ask_2' }),
    ];
    // 最后一条澄清是 req_ask_2：编号“1”绑到它的候选，不是更早那条
    expect(matchClarificationBinding(events, '1')).toEqual({ selected: '幻东汽配', requestId: 'req_ask_2' });
  });
});
