/**
 * S4 用例：执行细节不外泄到用户面（issue #50 用例4 落地为独立用例，2026-11-12）。
 *
 * 用例形状（判据本体在 execution-leak-criteria.ts）：
 *   构造 —— 任意任务执行（含失败路径：错误码/堆栈最容易泄；通知面单独覆盖）；
 *   断言 —— 出厂之后用户真正看到的两版文本里，没有调用参数、错误堆栈、内部 id、
 *           工具调用协议标记；机械判据 = 删除集幸存者 + 五类指纹 + 四类断言检测器。
 *
 * 本文件同时是这道用例的**回归锁与有牙证明**：
 *   · 主判与对抗面跑生产管道（红 = 机制有洞，成果不是失败）；
 *   · 语料自证跑直通桩（证明 81 条变形不是无害字符串、判据不是恒绿）；
 *   · 干净对照 + 钉住的 JSON 引用面（证明判据不是恒红、soft 例外不许扩）；
 *   · 删除集纪律与可读内容保留（不许为了绿吞正文——那是把防线拆了换绿灯）。
 *
 * 纪律（与 U1 同族）：判据只吃用户可见文本，不读模型自述、不碰网络；跑法
 * `TMPDIR=... npx vitest run --project unit scripts/eval/execution-leak-criteria.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import {
  judgeUserVisibleText,
  PASSTHROUGH_EXIT_PIPELINE,
  PRODUCTION_EXIT_PIPELINE,
  renderExecutionLeakReport,
  runExecutionLeakCase,
  type LeakClass,
} from './execution-leak-criteria';
import {
  adversarialScenarios,
  CLEAN_SURFACE_SAMPLES,
  deriveVariants,
  DIMENSION_LABELS,
  LEAK_VARIANTS,
  PINNED_JSON_CITATION_SAMPLE,
  S4_SCENARIOS,
  type AdversarialDimension,
} from './execution-leak-samples';

/** 四类断言（issue #50 用例4 原文）——桩变异面逐类必须有证据，缺一类即说明判据没接上。 */
const ASK_CLASSES: readonly LeakClass[] = ['call-param', 'error-stack', 'internal-id', 'protocol-marker'];

describe('S4 执行细节不外泄到用户面', () => {
  it('主判（任意任务执行，含失败路径）：出厂后回复面与通知面零 hard 泄漏', () => {
    const result = runExecutionLeakCase(S4_SCENARIOS, PRODUCTION_EXIT_PIPELINE);
    // 失败信息 = 判据输出原文（含用户面原文与逐条命中），不另写摘要。
    expect(result.verdict.passed, renderExecutionLeakReport(result.verdict)).toBe(true);
  });

  it('对抗面：同义改写 / 拆分跨行 / 编码变形的泄漏同样不许活到用户面', () => {
    const result = runExecutionLeakCase(adversarialScenarios(), PRODUCTION_EXIT_PIPELINE);
    expect(result.verdict.passed, renderExecutionLeakReport(result.verdict)).toBe(true);
  });

  it('语料自证（有牙）：三维各自在册，且每条变形在直通面上都被判据认出来', () => {
    const variants = deriveVariants();
    expect(variants.length, '语料被砍空').toBeGreaterThan(0);
    // 三维覆盖自校验：缺一维 = 本轮点名的对抗面没建起来（同 privacy-samples 的范围自校验纪律）。
    const byDimension = new Map<AdversarialDimension, number>();
    for (const variant of variants) {
      byDimension.set(variant.dimension, (byDimension.get(variant.dimension) ?? 0) + 1);
    }
    for (const dimension of Object.keys(DIMENSION_LABELS) as AdversarialDimension[]) {
      expect(byDimension.get(dimension) ?? 0, `对抗维度「${DIMENSION_LABELS[dimension]}」一条变形都没有`).toBeGreaterThan(0);
    }
    // 每条变形按自己的类必须被抓到（直通桩 = 机制什么都不删，判据必须自己看见）。
    const missed: string[] = [];
    for (const variant of variants) {
      const hard = judgeUserVisibleText(variant.text).filter((finding) => finding.severity === 'hard');
      if (!hard.some((finding) => finding.class === variant.klass)) {
        missed.push(`${variant.id}（期望类 ${variant.klass}，实际 hard=${JSON.stringify(hard.map((f) => `${f.class}:${f.token}`))}）`);
      }
    }
    expect(missed, `判据漏判 ${missed.length} 条变形（判据有假阴性 = 用例在这一点上没牙）`).toEqual([]);
  });

  it('假红守卫：正常业务叙述 / 夹具名 / 宿主码表词零 hard；钉住的 JSON 引用只许 soft', () => {
    for (const sample of CLEAN_SURFACE_SAMPLES) {
      const hard = judgeUserVisibleText(sample.text).filter((finding) => finding.severity === 'hard');
      expect(hard.map((finding) => `${finding.class}:${finding.token}`), `${sample.id}：${sample.note}`).toEqual([]);
    }
    // reply-exit.test.ts:112-123 钉住的「防误伤」形态：正文引用一小段 JSON 不许删、也不许翻红绿。
    const pinned = judgeUserVisibleText(PINNED_JSON_CITATION_SAMPLE);
    expect(pinned.filter((finding) => finding.severity === 'hard')).toEqual([]);
    expect(pinned.map((finding) => `${finding.severity}:${finding.class}`)).toEqual(['soft:json-fragment']);
    // 例外不许扩：带调用参数键的 JSON 与 `candidates:` 标签是 hard（前者是断言四类之一）。
    for (const leaky of ['{"collection":"contoso-trade","window":"2025-10"}', 'candidates: contoso-trade, contoso-logistics']) {
      const hard = judgeUserVisibleText(leaky).filter((finding) => finding.severity === 'hard');
      expect(hard.length, `${leaky} 必须判 hard`).toBeGreaterThan(0);
    }
  });

  it('桩变异（直通管道）：同一条用例在机制缺失时转红，且四类断言逐类有证据', () => {
    // 「换一个故意乱来的桩」：出厂管道改成直通（什么都不删）——若主判在这上面还是绿的，
    // 说明判据/构造至少有一头是空的（用例没牙）。四类逐类必须有 hard 命中。
    const result = runExecutionLeakCase(S4_SCENARIOS, PASSTHROUGH_EXIT_PIPELINE);
    expect(result.verdict.passed, '直通桩下用例仍是绿的——判据或场景构造是空壳').toBe(false);
    for (const klass of ASK_CLASSES) {
      expect(result.verdict.hardByClass[klass] ?? 0, `桩变异下「${klass}」一类都没命中`).toBeGreaterThan(0);
    }
    // 对照：同一份场景走生产管道时，上述 hard 只剩场景里机制确实盖不住的那几类
    // （差值本身就是本轮的红灯面，报告见主判用例的失败信息）。
    const production = runExecutionLeakCase(S4_SCENARIOS, PRODUCTION_EXIT_PIPELINE);
    expect(Object.values(production.verdict.hardByClass).reduce((a, b) => a + (b ?? 0), 0))
      .toBeLessThan(Object.values(result.verdict.hardByClass).reduce((a, b) => a + (b ?? 0), 0));
  });

  it('机制覆盖面非空：错误码 / 脚本路径 / 协议标签这几类真会被出厂链删掉（红不是管线没接上）', () => {
    // 与桩变异互补的另一半：生产管道必须**真的动手**（否则主判的红会是"整条链没跑"的假象）。
    const covered = [
      '平台返回 PERIOD_NO_DATA：该期间没有记录，请确认期间后重试。',
      '数据来自 src/dummy/scripts/query.js，共 2 条记录。',
      '（原因：计划门）本次需要先确认再执行。',
      '抱歉，我先把内部调用贴出来：<tool_call><function=delegate>查 alpha</function></tool_call>，结果是 2 条记录。',
    ];
    for (const raw of covered) {
      const result = runExecutionLeakCase([{ id: 'covered', executed: true, reply: raw }], PRODUCTION_EXIT_PIPELINE);
      const out = result.surfaces[0]!.text;
      expect(out, `出厂链没有改动这段文本：${raw}`).not.toBe(raw);
      expect(result.verdict.passed, renderExecutionLeakReport(result.verdict)).toBe(true);
    }
  });

  it('删除集纪律：可读正文逐字保留；裸 JSON 引用不许进删除集（不许为了绿吞内容）', () => {
    // 纪律原文（issue #50 用例4 落地指引）：删除集只收零信息损失形态；JSON 片段 / operation 名 /
    // 内部控制词由指纹表守，不许为了绿把指纹形态塞进删除集。
    // 这一条钉的是**方向**：把可读内容一起吞掉换绿灯的路是堵死的。
    const readable = '平台返回 PERIOD_NO_DATA：该期间没有记录，请确认期间后重试。';
    const out = runExecutionLeakCase([{ id: 'readable', executed: true, reply: readable }], PRODUCTION_EXIT_PIPELINE);
    expect(out.surfaces[0]!.text).toContain('该期间没有记录，请确认期间后重试。');
    // 裸 JSON 引用（钉住的既有行为）：生产删除集不许删它，也不许整段替换。
    const citation = runExecutionLeakCase(
      [{ id: 'citation', executed: true, reply: PINNED_JSON_CITATION_SAMPLE }],
      PRODUCTION_EXIT_PIPELINE,
    );
    expect(citation.surfaces[0]!.text).toBe(PINNED_JSON_CITATION_SAMPLE);
  });
});
