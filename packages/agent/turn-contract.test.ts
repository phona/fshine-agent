import { describe, expect, it } from 'vitest';
import { validatePlanEntities } from './src/turn-contract';

/**
 * 删除记录（2026-11-12，e2e 迁移/删除批）：原 `describe('申报契约：route_current_turn 三字段')`
 * 整块（16 用例）随申报层移除删除——`parseTurnDeclaration` / `reviewRouteDeclaration` /
 * `isSelfContradictoryDeclaration` / `ROUTE_CURRENT_TURN_TOOL` 在直连改造后已无任何生产
 * 消费者（全仓仅 index.ts 的再导出与这些用例），该块断言的"申报契约形状"不再对应运行时
 * 行为。解析器本体与再导出的正式删除归后续删除批（不属于测试面）。
 */


/**
 * 计划实体来源校验（架构 §2 第 9 条，领域无关）：Phase 3 落地，与申报契约瘦身无关，
 * 契约字段消失后它靠宿主持有的三个来源独立存活。原申报层证据校验（C1/C2）已整体取消，
 * 实体范围守卫完全由这一层承担。
 */
describe('计划实体来源校验：三来源逐字包含', () => {
  it('实体逐字来自当前消息即放行', () => {
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202608'] }],
      { currentMessage: '查一下幻辰财税账套 202608 的应收' },
    )).toBeNull();
  });

  it('以 - 开头的是 flag 不是实体，跳过；非字符串参数不参与判定', () => {
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--customer'] }],
      { currentMessage: '查一下幻辰财税账套' },
    )).toBeNull();
    expect(validatePlanEntities(
      [{ operation: 'any.operation', args: [10, true, null, { nested: 'object' }] }],
      { currentMessage: '查一下' },
    )).toBeNull();
  });

  it('检索证据里的实体放行（指代消解的产物就是合法实体）', () => {
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻东'] }],
      {
        currentMessage: '这个账套 202608 呢？',
        referenceEvidence: '【宿主主动回溯】tool_result：幻东 202609 余额 51 元',
      },
    )).toBeNull();
  });

  it('search→query：候选名逐字来自本轮平台响应时放行', () => {
    // roadmap 点名场景：执行层先目录查询拿到唯一候选、再用候选名查。候选名不在用户
    // 消息里，但逐字来自本轮平台响应——宿主不懂业务也必须放行。
    const searchCall = { operation: 'finance.search-account-sets', args: ['--query', '胜利'] };
    expect(validatePlanEntities([searchCall], { currentMessage: '只查有没有胜利这个帐套' })).toBeNull();
    const candidateResponse = 'RESULT {"op":"finance.search-account-sets","status":"completed","data":{"accountSets":[{"id":"as_1","name":"胜利五金有限责任公司"}]}}';
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '胜利五金有限责任公司'] }],
      { currentMessage: '只查有没有胜利这个帐套', platformResponses: [candidateResponse] },
    )).toBeNull();
    // 换一个响应里没有的写法照样拒——只有逐字来自响应才放行
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '胜利五金集团'] }],
      { currentMessage: '只查有没有胜利这个帐套', platformResponses: [candidateResponse] },
    )).toContain('未在当前请求、检索证据、平台响应或本会话已确立实体中出现的参数');
  });

  it('越权实体（三个来源里都没有）被拒，错误消息领域无关', () => {
    const error = validatePlanEntities(
      [
        { operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--customer', '猫一杯'] },
        { operation: 'finance.query-receivables', args: ['--query', '新兴五金'] },
      ],
      { currentMessage: '查一下幻辰财税账套的应收' },
    );
    expect(error).toContain('猫一杯');
    expect(error).toContain('未在当前请求、检索证据、平台响应或本会话已确立实体中出现的参数');
    // 报第一个越权值即可：worker 修正后重新提交完整 calls，逐次暴露
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] },
        { operation: 'finance.query-receivables', args: ['--query', '新兴五金'] }],
      { currentMessage: '查一下幻辰财税账套的应收' },
    )).toContain('新兴五金');
  });

  it('来源并集为空时 fail-closed：任何实体都不放行', () => {
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }],
      { currentMessage: '' },
    )).toContain('未在当前请求、检索证据、平台响应或本会话已确立实体中出现的参数');
  });

  it('计划校验只看实体来源，与申报契约的字段无关', () => {
    // 契约瘦身后宿主不再从申报字段推导任何范围：同样的 calls 与来源，判定只由三个来源决定。
    const calls = [
      { operation: 'voucher.query-saved', args: ['幻辰财税', '202608'] },
      { operation: 'finance.search-account-sets', args: ['--query', '幻辰财税'] },
    ];
    expect(validatePlanEntities(calls, { currentMessage: '查一下幻辰财税 202608' })).toBeNull();
    // 目录查询与后续查询混排也不再被强制"只能一次 search 调用"
    expect(validatePlanEntities(
      [
        { operation: 'finance.search-account-sets', args: ['--query', '幻辰财税'] },
        { operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] },
      ],
      { currentMessage: '查一下幻辰财税账套' },
    )).toBeNull();
  });

  it('多个平台响应全部纳入来源，最近的响应也能放行新候选', () => {
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻东'] }],
      {
        currentMessage: '这个呢？',
        platformResponses: ['更早的响应：提到了新兴五金', '更近的响应：幻东 202609 余额 51 元'],
      },
    )).toBeNull();
  });

  it('quotedEvidence 是独立来源，只放行本轮实际收到的引用文字', () => {
    const calls = [{ operation: 'finance.query-receivables', args: ['--query', '幻东账套'] }];
    expect(validatePlanEntities(calls, {
      currentMessage: '查这个',
      quotedEvidence: '我想问幻东账套 202609 的结果',
    })).toBeNull();
    expect(validatePlanEntities(calls, {
      currentMessage: '查这个',
      quotedEvidence: '我想问另一个对象',
    })).toContain('幻东账套');
  });

  // ── 第四来源：本会话确立过的实体（任务 1 标定修复，2026-09-27 连续会话事故）────────
  //
  // 事故形状：用户"查完某个对象"之后只补一个范围编码（本轮消息里没有对象名）——三个来源
  // 全空，查询被门禁判死。第四来源把标定从"单轮"修正为"本会话用户亲自确立过的"。

  it('sessionEntities 里的实体放行：事故形状（本轮只有范围编码，对象在早前回合执行过）', () => {
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202609'] }],
      { currentMessage: '202609', sessionEntities: ['幻辰财税', '202606'] },
    )).toBeNull();
  });

  it('防幻觉功能不变：sessionEntities 之外的实体照样被拒（幻觉名进不了任何来源）', () => {
    // 模型幻觉出一个用户从未操作过的对象名：即使本会话确立过别的实体，也一律拒绝
    const error = validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻觉出来的对象', '--period', '202609'] }],
      { currentMessage: '202609', sessionEntities: ['幻辰财税'] },
    );
    expect(error).toContain('未在当前请求、检索证据、平台响应或本会话已确立实体中出现的参数');
    expect(error).toContain('幻觉出来的对象');
  });

  it('sessionEntities 为空/未传时判定与从前一字不差（老路径不受影响）', () => {
    const calls = [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }];
    expect(validatePlanEntities(calls, { currentMessage: '查幻辰财税', sessionEntities: [] })).toBeNull();
    expect(validatePlanEntities(calls, { currentMessage: '202609' })).toContain('未在当前请求');
    expect(validatePlanEntities(calls, { currentMessage: '202609', sessionEntities: [] })).toContain('未在当前请求');
  });

  it('第四来源纳入条数上限：只保留最近确立的（haystack 是判定材料不是仓库）', () => {
    const many = Array.from({ length: 45 }, (_, index) => `对象${index}`);
    // 最后一个在截断窗口外 → 拒（上限 40，保留最近 40 个）
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '对象0'] }],
      { currentMessage: '202609', sessionEntities: many },
    )).toContain('未在当前请求');
    // 最近的确立 → 放行
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '对象44'] }],
      { currentMessage: '202609', sessionEntities: many },
    )).toBeNull();
  });

  it('platformEntities 里的实体值放行（信封 data 的结构化投影，附加来源）', () => {
    const calls = [{ operation: 'finance.query-receivables', args: ['--query', '胜利五金有限责任公司'] }];
    expect(validatePlanEntities(
      calls,
      { currentMessage: '查一下', platformResponses: ['RESULT {"op":"x","data":{"candidates":[]}}'], platformEntities: ['胜利五金有限责任公司'] },
    )).toBeNull();
  });

  it('platformEntities 未传/为空时判定与从前一字不差（附加来源可缺席）', () => {
    const calls = [{ operation: 'finance.query-receivables', args: ['--query', '胜利五金有限责任公司'] }];
    expect(validatePlanEntities(calls, { currentMessage: '查一下', platformResponses: [], platformEntities: [] }))
      .toContain('未在当前请求');
    expect(validatePlanEntities(calls, { currentMessage: '查一下', platformResponses: [] }))
      .toContain('未在当前请求');
  });

  it('平台响应条数不再设上限：第 21 条仍计入来源', () => {
    // 覆盖判据 = 本任务迄今全部。42 个历史验收库里单请求 tool_call 数 9…87，
    // "最后 N 条"会把早期响应里确立的实体静默掉出判定材料。
    const many = Array.from({ length: 21 }, (_, index) => `第 ${index} 条响应`);
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '最早那条里的名字'] }],
      { currentMessage: '查一下', platformResponses: ['最早那条里的名字', ...many.slice(1)] },
    )).toBeNull();
  });

  it('单条平台响应按保尾截断：末尾的内容不因长度被切掉', () => {
    const noise = `${'噪声\n'.repeat(30_000)}`;
    const tail = '末行的规范名：胜利五金有限责任公司';
    // 保尾：截断后仍在 haystack 里 → 放行
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '胜利五金有限责任公司'] }],
      { currentMessage: '查一下', platformResponses: [noise + tail] },
    )).toBeNull();
    // 保头则会把它切掉 → 这条断言钉住"不是保头"（把常量改成 slice(0, …) 即红）
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '只活在响应最前面的名字'] }],
      { currentMessage: '查一下', platformResponses: ['只活在响应最前面的名字' + noise] },
    )).toContain('未在当前请求');
  });
});
