/**
 * business-skill 加载链（loader）+ 业务 skill 的执行默认词表守卫。
 *
 * 两组各自守住一件事：
 *
 * A. 加载链：`BUSINESS_SKILL_PATH` > `AGENT_CONFIG_PATH` 指向的 yaml `config.businessSkillPath`
 *    > 默认 `docs/business-skill.md`，只此一条路径。文件缺失 / 内容纯空白 / yaml 不可读 / 无该键
 *    一律**降级不抛错**——启动不能被一份静态知识拖垮，这是 loader 的契约而不是宽容度。
 *
 * B. 守卫：`docs/business-skill.md` 里不得出现执行默认口径词。**这一组现在是红的，且是有意
 *    红的**——编排层不得替执行层定"缺省时用哪个值"（"未指定期间查哪个期间""余额默认哪个科目"
 *    归执行层），md 里出现这些词就是执行口径回流。它与 platform-leak-lint.test.ts 的业务词
 *    预算是同一种文化：只减不增，新增即现形。红着交回，等清理落地后自然转绿——**不为绿灯改
 *    md**，那会让守卫失去它唯一的作用。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BUSINESS_SKILL_PATH,
  MAX_BUSINESS_SKILL_CHARS,
  loadBusinessSkill,
  resolveBusinessSkillPath,
} from './business-skill';

/** 仓库根：与 business-skill.ts 自身的 repoRoot 同源，守卫组要读真实的 docs/business-skill.md。 */
const repoRoot = path.resolve(__dirname, '../..');

describe('business skill 加载链', () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });
  const scratch = () => {
    directory = mkdtempSync(path.join(tmpdir(), 'fshine-business-skill-'));
    return directory;
  };
  /**
   * 干净 env。环境变量优先级最高，所以测 yaml 与默认路径的用例必须先把 BUSINESS_SKILL_PATH /
   * AGENT_CONFIG_PATH 抹掉——否则跑者环境里泄漏的一个值就能让用例测的不是它声称的那条分支。
   */
  const baseEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    BUSINESS_SKILL_PATH: undefined,
    AGENT_CONFIG_PATH: undefined,
    ...overrides,
  });

  it('BUSINESS_SKILL_PATH 指向存在的文件：返回 path 与 trim 后的 text', async () => {
    const file = path.join(scratch(), 'skill.md');
    writeFileSync(file, '\n  只用于路由判定与范围锚定。\n  第二行。  \n');
    await expect(loadBusinessSkill(baseEnv({ BUSINESS_SKILL_PATH: file }))).resolves.toEqual({
      path: file,
      // trim 只剥首尾：行内缩进是原文排版，注入提示词时要保留
      text: '只用于路由判定与范围锚定。\n  第二行。',
    });
  });

  it('BUSINESS_SKILL_PATH 指向不存在的文件：返回 path、text 为 undefined，且不抛错', async () => {
    const missing = path.join(scratch(), 'not-here.md');
    const loaded = await loadBusinessSkill(baseEnv({ BUSINESS_SKILL_PATH: missing }));
    // 降级是设计：静态知识缺失不该让服务起不来，调用方只看到"没有 text"
    expect(loaded).toEqual({ path: missing });
    expect(loaded.text).toBeUndefined();
  });

  it('文件存在但内容只有空白：text 为 undefined（空串注入提示词等于注入一行噪音）', async () => {
    const file = path.join(scratch(), 'blank.md');
    writeFileSync(file, '   \n\t\n  \n');
    const loaded = await loadBusinessSkill(baseEnv({ BUSINESS_SKILL_PATH: file }));
    expect(loaded.path).toBe(file);
    expect(loaded.text).toBeUndefined();
  });

  it('超长内容截到 MAX_BUSINESS_SKILL_CHARS，且保留开头而不是结尾', async () => {
    const file = path.join(scratch(), 'long.md');
    writeFileSync(file, `# 超长夹具\n${'业务口径填充行。'.repeat(MAX_BUSINESS_SKILL_CHARS * 3)}\n`);
    const loaded = await loadBusinessSkill(baseEnv({ BUSINESS_SKILL_PATH: file }));
    expect(loaded.text?.length).toBe(MAX_BUSINESS_SKILL_CHARS);
    // slice(0, N) 取头：提示词里先读到的是标题与路由判据，砍掉尾部比砍掉头部损失小
    expect(loaded.text?.startsWith('# 超长夹具')).toBe(true);
  });

  it('无 BUSINESS_SKILL_PATH 时读 AGENT_CONFIG_PATH 指向的 yaml 的 config.businessSkillPath', async () => {
    const dir = scratch();
    const target = path.join(dir, 'from-yaml.md');
    writeFileSync(target, '来自 yaml 的业务 skill。');
    const yamlPath = path.join(dir, 'agent.yaml');
    writeFileSync(yamlPath, `config:\n  businessSkillPath: "${target}"\n`);
    await expect(loadBusinessSkill(baseEnv({ AGENT_CONFIG_PATH: yamlPath }))).resolves.toEqual({
      path: target,
      text: '来自 yaml 的业务 skill。',
    });
  });

  it('yaml 里没有 businessSkillPath：回落到默认路径', () => {
    const yamlPath = path.join(scratch(), 'agent.yaml');
    writeFileSync(yamlPath, 'config:\n  somethingElse: 1\n');
    const resolved = resolveBusinessSkillPath(baseEnv({ AGENT_CONFIG_PATH: yamlPath }));
    expect(resolved.endsWith(DEFAULT_BUSINESS_SKILL_PATH)).toBe(true);
  });

  it('yaml 不可读（路径不存在）：回落到默认路径，不抛错', () => {
    const resolved = resolveBusinessSkillPath(baseEnv({ AGENT_CONFIG_PATH: path.join(scratch(), 'absent.yaml') }));
    expect(resolved.endsWith(DEFAULT_BUSINESS_SKILL_PATH)).toBe(true);
  });

  it('两个环境变量都没有时：走仓库自己的 config/agent.yaml，最终落在默认路径且读得到', async () => {
    const loaded = await loadBusinessSkill(baseEnv());
    expect(loaded.path.endsWith(DEFAULT_BUSINESS_SKILL_PATH)).toBe(true);
    // 仓库自带的业务 skill 是可读的：缺文件只是降级路径，不是这里的预期形态
    expect(loaded.text).toBeTruthy();
  });

  it('resolveBusinessSkillPath 把相对的环境变量路径 resolve 成绝对路径', () => {
    const resolved = resolveBusinessSkillPath(baseEnv({ BUSINESS_SKILL_PATH: 'docs/business-skill.md' }));
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(DEFAULT_BUSINESS_SKILL_PATH)).toBe(true);
  });
});

describe('业务 skill 执行默认词表守卫', () => {
  /**
   * 执行默认口径：编排层写下"缺省时用哪个值"，就是在替执行层定规则。
   *
   * 为什么归执行层：'未指定期间查哪个期间''余额默认哪个科目'是执行层的能力与口径——
   * 它可能随版本、账套、模板而变。编排层抄一份就成了第二份真相，执行层改了这里不改，
   * 用户拿到的是编排层想象出来的期间/科目。与 platform-leak-lint.test.ts 的业务词预算同族：
   * 扫出当前命中集 → 冻结为基线 → 只减不增（新增即红，清理直接转绿）。
   */
  const EXEC_DEFAULT_RE = /默认应收|默认当前|默认科目|可缺省/;

  it('docs/business-skill.md 不出现执行默认口径词', () => {
    const skillPath = path.resolve(repoRoot, DEFAULT_BUSINESS_SKILL_PATH);
    // 命中行带行号打出来：词表守卫的用途是定位，不是只报一个"有违例"
    const hits = readFileSync(skillPath, 'utf8')
      .split('\n')
      .map((text, index) => ({ line: index + 1, text }))
      .filter(({ text }) => EXEC_DEFAULT_RE.test(text))
      .map(({ line, text }) => `  L${line}: ${text.trim()}`);
    expect(hits, [
      '业务 skill 里出现了执行默认口径（编排层不得替执行层定"缺省时用哪个值"）：',
      ...hits,
      '清理方向：把"必需 / 可缺省"整表交给执行层声明（能力清单或域 SOP），编排层只负责发现缺什么、向用户要什么；',
      '即使用户确实需要一个缺省值，也由执行层在调用处决定，不由编排层写死在这里。',
    ].join('\n')).toEqual([]);
  });
});
