import { describe, expect, it } from 'vitest';
import { SERVER_PATH_PATTERN, stripServerPaths } from './src/server-paths';


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

