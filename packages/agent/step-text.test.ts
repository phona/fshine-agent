/**
 * 进度帧渲染层（F6）：内部工具不发帧、模型短语钳制。
 *
 * 这条线是"用户不该看见内部机制"的最后一道渲染关：系统提示词明令不许出现
 * route_current_turn 等字样，而默认模板的兜底分支恰恰会把工具名原样拼进帧文本
 * （"正在调用 route_current_turn…"）。这里把判定做成纯函数，测试直接钉住。
 *
 * L6 沉积清理后：直接平台工具（search_account_sets / get_login_status 等）已退役，
 * 其具名帧与 accountSetId→名称查找随之删除；剩余非内部工具一律回退通用工具名模板。
 */
import { describe, expect, it } from 'vitest';
import {
  PROGRESS_PHRASE_LIMIT,
  clampProgressPhrase,
  defaultStepText,
  renderToolStepText,
} from './src/step-text';

describe('进度帧渲染：内部工具与短语钳制', () => {
  it('宿主内部工具不发默认进度帧（工具名本身就是内部机制字样）', () => {
    for (const tool of ['route_current_turn', 'search_history', 'get_messages']) {
      expect(defaultStepText(tool)).toBeNull();
      // 模型自填短语同样不发：这些工具描述的是宿主编排机制，没有用户可见动作
      expect(renderToolStepText(tool, '正在检索历史对话')).toBeNull();
      expect(renderToolStepText(tool, '')).toBeNull();
    }
  });

  it('非内部工具回退到通用工具名模板（直接平台工具已退役，不再有具名帧）', () => {
    expect(defaultStepText('run_task')).toBe('正在调用 run_task…');
    expect(defaultStepText('some_future_tool')).toBe('正在调用 some_future_tool…');
  });

  it('模型短语超长被截断到上限', () => {
    const long = `正在把上一个季度的全部往来记录逐条核对一遍确保没有遗漏任何细节${'x'.repeat(40)}`;
    expect(long.length).toBeGreaterThan(PROGRESS_PHRASE_LIMIT);
    expect(clampProgressPhrase(long)).toBe(`${long.slice(0, PROGRESS_PHRASE_LIMIT)}…`);
    // 正好等于上限不截断（边界）
    const exact = '正'.repeat(PROGRESS_PHRASE_LIMIT);
    expect(clampProgressPhrase(exact)).toBe(exact);
  });

  it('命中内部协议特征的短语整条丢弃：宁可不出帧，也不外发协议材料', () => {
    const leaks = [
      '{"recorded":"delegate","step":"第 1/2 步"}',
      '继续子任务 task_9f2c1a，不要转述给用户',
      'plan_req_123 已激活',
      'worker_tool_execution_start',
      '把编号填进 continueTaskId 重派',
      '调用 route_current_turn 申报本轮动作',
      '第 2/3 步执行中',
      '{"taskId":"task_1","text":"结果"}',
    ];
    for (const phrase of leaks) {
      expect(clampProgressPhrase(phrase), phrase).toBe('');
    }
  });

  it('带服务器路径的短语整条丢弃：路径对用户零可行动性（判据与终稿出口同一把尺）', () => {
    // 带 task_ 的形状早被协议特征拦下（所以那条标记不能删）；这里补的是**不带 task_**
    // 的路径形状——附件暂存路径 tmp/attachments/<uuid>-文件名.xlsx 就不带，而它正是
    // 编排模型会从转录里原样抄出来的那种（2026-10-19 终稿泄漏同源）。
    // 与协议材料同一族处理：整条丢、回落默认帧，不"删掉路径留着话"——那只会给用户
    // 剩一句主语残缺的话。
    const paths = [
      '正在读 /home/fictional-user/fictional-projects/fictional-execution-layer/tmp/attachments/5b58ba31-19ce-428d-99a9-ef501836b04e-工资表2026-8月(1).xlsx',
      '契约写在 /home/fictional-user/fictional-projects/fictional-execution-layer/tmp/contract.json 里',
      '已读取 `tmp/attachments/5b58ba31-19ce-428d-99a9-ef501836b04e-工资表.xlsx`',
      '正在盘点薪酬数据源 + 契约草稿 tmp/task_f695557e-f9b1-4',
    ];
    for (const phrase of paths) {
      expect(clampProgressPhrase(phrase), phrase).toBe('');
    }
    // 丢短语之后照旧回落默认帧，不会因此不出帧
    expect(renderToolStepText('run_task', paths[0]!)).toBe('正在调用 run_task…');
  });

  it('正常短语原样通过（不被误判成泄漏）', () => {
    for (const phrase of ['正在核对往来记录', '读取余额中', '正在做摸底']) {
      expect(clampProgressPhrase(phrase)).toBe(phrase);
    }
  });

  it('短语被丢弃时回落默认帧；默认帧也没有（内部工具）时返回 null', () => {
    // 非内部工具 + 泄漏短语 → 回落到通用工具名帧
    expect(renderToolStepText('run_task', '{"recorded":"delegate"}')).toBe('正在调用 run_task…');
    // 非内部工具 + 空短语 → 通用帧
    expect(renderToolStepText('run_task', '   ')).toBe('正在调用 run_task…');
    // 非内部工具 + 可用短语 → 短语优先
    expect(renderToolStepText('run_task', '查询往来记录')).toBe('查询往来记录');
    // 内部工具 + 泄漏短语 → null（driver 侧必须因此跳过 onStep）
    expect(renderToolStepText('search_history', 'task_1 续跑')).toBeNull();
  });
});
