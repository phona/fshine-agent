import { describe, expect, it } from 'vitest';
import { SERVER_PATH_PATTERN, hasServerPath, stripServerPaths } from './src/server-paths';

/** 本次实测漏进终稿的两个路径（2026-10-19，幻骥达工资表任务）。 */
const WORKSPACE_PATH = 'tmp/task_d42fffce-ce9a-4ff7-b648-b26e9131d9b1/';
const ABSOLUTE_PATH = '/home/fictional-user/fictional-projects/fictional-execution-layer/tmp/attachments/5b58ba31-19ce-428d-99a9-ef501836b04e-工资表2026-8月(1).xlsx';

describe('stripServerPaths', () => {
  it('删掉工作区相对路径，并清掉删完之后留下的空括号', () => {
    const out = stripServerPaths('已产出文件（tmp/task_d42fffce-ce9a-4ff7-b648-b26e9131d9b1/）：\n· 整理好的2026年08月工资表.xlsx');
    expect(out.removed).toBe(1);
    expect(out.text).toBe('已产出文件：\n· 整理好的2026年08月工资表.xlsx');
    expect(out.text).not.toContain('tmp/');
  });

  it('删掉绝对路径，文件名本身保留（用户至少还知道是哪个文件）', () => {
    // 判据的字符类在中文处收住，所以路径前缀被删、中文文件名留下——这正是想要的结果：
    // 用户拿不到路径，但拿得到文件名。
    const out = stripServerPaths(`文件在 ${ABSOLUTE_PATH} 里。`);
    expect(out.removed).toBe(1);
    expect(out.text).toBe('文件在 工资表2026-8月(1).xlsx 里。');
  });

  it('反引号包裹的行内代码路径整块消失，只剩连接词的括号对一并清掉', () => {
    // 真实终稿形状：`**产出文件**（均在 \`tmp/task_<id>/\`）：`
    const out = stripServerPaths('**产出文件**（均在 `tmp/task_d42fffce-ce9a-4ff7-b648-b26e9131d9b1/`）：');
    expect(out.removed).toBe(1);
    expect(out.text).toBe('**产出文件**：');
  });

  it('带内容的括号对不动：`（1）`、`（A）`、`（含 3 人）` 都保留', () => {
    for (const text of ['已剔除实发为 0 的 3 人（1）。', '口径 A（A）与 B（B）', '115 人（含 3 人补报）']) {
      expect(stripServerPaths(text).text, text).toBe(text);
    }
  });

  it('多个路径逐条计数', () => {
    const out = stripServerPaths(`A: ${WORKSPACE_PATH}\nB: ${ABSOLUTE_PATH}\nC: /tmp/scratch/x.xlsx`);
    expect(out.removed).toBe(3);
    expect(out.text).not.toContain('tmp/');
    expect(out.text).not.toContain('/home/');
  });

  it('没有路径时原文原样返回（同一引用），调用方可走快路', () => {
    const clean = '应发合计 123,456.78；实发合计 120,000.00。12 人逐人零差异。';
    const out = stripServerPaths(clean);
    expect(out.removed).toBe(0);
    expect(out.text).toBe(clean);
  });

  it('不误伤：URL、中文和或、日期写法、普通点分名都不算路径', () => {
    // 误伤比漏报更糟——删掉用户结论里的字符，比留一个路径在原地严重得多。
    const cases = [
      '详见 https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=ABC',
      '和/或 两种口径都列一下',
      '2026/8 与 2026/9 两个月',
      'v1.2 版本；幻辰.财税 账套',
      'A/B 测试不做',
    ];
    for (const text of cases) {
      expect(stripServerPaths(text).removed, text).toBe(0);
    }
  });

  it('形状表可被测试直接钉住：两条判据都是全局匹配', () => {
    expect(SERVER_PATH_PATTERN.flags).toContain('g');
    expect(SERVER_PATH_PATTERN.test(WORKSPACE_PATH)).toBe(true);
    SERVER_PATH_PATTERN.lastIndex = 0;
    expect(SERVER_PATH_PATTERN.test(ABSOLUTE_PATH)).toBe(true);
  });
});

describe('hasServerPath（只判有没有，不删）', () => {
  it('命中两条判据的形状', () => {
    expect(hasServerPath(WORKSPACE_PATH)).toBe(true);
    expect(hasServerPath(ABSOLUTE_PATH)).toBe(true);
    expect(hasServerPath('/tmp/scratch/x.xlsx')).toBe(true);
    // 摘要截断到 24 字符的那种半截路径同样命中（前缀没被截掉）
    expect(hasServerPath('tmp/task_f695557e-f9b1-4')).toBe(true);
    expect(hasServerPath('`tmp/task_d42fffce-ce9a-4ff7-b648-b26e9131d9b1/`')).toBe(true);
  });

  it('干净文本、URL、日期、普通点分名都不算路径', () => {
    for (const text of [
      '应发合计 123,456.78；实发合计 120,000.00。',
      '详见 https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=ABC',
      '2026/8 与 2026/9 两个月',
      '和/或 两种口径都列一下',
      'A/B 测试不做',
    ]) {
      expect(hasServerPath(text), text).toBe(false);
    }
  });

  it('与 stripServerPaths 是同一把尺：判定永远一致，不存在"删得掉却探不到"', () => {
    // 两个出口（删 / 探）共用 SERVER_PATH_PATTERN 的形状。这条用例钉住它们不分叉：
    // 哪天有人改了形状却只改了一侧，这里立刻红。
    const corpus = [
      WORKSPACE_PATH,
      ABSOLUTE_PATH,
      '/tmp/scratch/x.xlsx',
      'tmp/task_f695557e-f9b1-4',
      '**产出文件**（均在 `tmp/task_d42fffce-ce9a-4ff7-b648-b26e9131d9b1/`）：',
      '文件在 /home/fictional-user/fictional-projects/fictional-execution-layer/tmp/attachments/工资表2026-8月(1).xlsx 里。',
      '应发合计 123,456.78；实发合计 120,000.00。12 人逐人零差异。',
      '详见 https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=ABC',
      '2026/8 与 2026/9 两个月',
      'v1.2 版本；幻辰.财税 账套',
    ];
    for (const text of corpus) {
      expect(hasServerPath(text), text).toBe(stripServerPaths(text).removed > 0);
    }
    // 反复调用不串状态：探针不是有状态的全局匹配（/g 的 lastIndex 陷阱）
    for (let i = 0; i < 3; i += 1) {
      expect(hasServerPath('干净文本')).toBe(false);
      expect(hasServerPath(WORKSPACE_PATH)).toBe(true);
    }
  });
});
