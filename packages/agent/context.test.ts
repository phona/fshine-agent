import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextProfileConfig, PlatformTaskRecord, PlatformTaskRepo, TrustedContext } from '@fshine/contracts';
import type { TurnDeclaration } from './src/turn-contract';
import { ScriptedTurnDriver, ToolUserError, type TurnDriver, type TurnDriverInput } from './src/driver';
import {
  DELEGATION_AUTH_FAILURE,
  DELEGATION_CANCELLED,
  DELEGATION_EXECUTOR_FAILURE,
  DELEGATION_TIMEOUT_FAILURE,
  createContextTaskRunner,
  type ContextTaskRunner,
} from './src/context';import { createTaxAgentRuntime } from './src/runtime';
import { validatePlanEntities } from './src/turn-contract';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class MemoryTasks implements PlatformTaskRepo {
  readonly records = new Map<string, PlatformTaskRecord>();
  async get(taskId: string) { return this.records.get(taskId) ?? null; }
  async upsert(record: PlatformTaskRecord) { this.records.set(record.taskId, structuredClone(record)); }
  async listBySession(principalId: string, sessionId: string) {
    return [...this.records.values()]
      .filter((record) => record.principalId === principalId && record.parentSessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

class MemorySessions {
  private readonly records = new Map<string, { sessionId: string; principalId: string; channelConversationId: string; updatedAt: string; state?: unknown }>();
  async get(sessionId: string) { return this.records.get(sessionId) ?? null; }
  async upsert(record: { sessionId: string; principalId: string; channelConversationId: string; updatedAt: string; state?: unknown }) {
    this.records.set(record.sessionId, { ...record });
  }
}

function trusted(sessionId = 'session-1', principalId = 'wecom:user-1'): TrustedContext {
  return { requestId: 'req-1', principalId, allowedAccountSetIds: [], sessionId };
}

async function profileRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-subagent-'));
  roots.push(root);
  await mkdir(path.join(root, '.agents', 'skills', '17dz'), { recursive: true });
  await writeFile(path.join(root, '.agents', 'skills', '17dz', 'SKILL.md'), '---\nname: 17dz\ndescription: 幻账平台工作规范\n---\n使用领域脚本并返回可复核证据。\n');
  return root;
}

function runner(root: string, tasks: MemoryTasks, driver: TurnDriver) {
  const profiles: Record<string, ContextProfileConfig> = {
    '17dz': { root, skillRoots: ['.agents/skills'] },
  };
  return createContextTaskRunner({ profiles, tasks, workerDriver: driver });
}

describe('17dz Pi subagent adapter', () => {
  it('固定 cwd/skillRoots 并原样返回自然语言', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    let observed: TurnDriverInput | undefined;
    const scripted = ScriptedTurnDriver([{ text: '已查询完成。\n来源：17dz 领域脚本。' }]);
    const subagent = runner(root, tasks, {
      run: async (input) => {
        observed = input;
        return scripted.run(input);
      },
    });

    const result = await subagent.run({ request: '查询幻辰余额' }, { trusted: trusted() });

    expect(result.text).toBe('已查询完成。\n来源：17dz 领域脚本。');
    expect(result.taskId).toMatch(/^task_/);
    expect(observed?.cwd).toBe(root);
    expect(observed?.skillRoots).toEqual([path.join(root, '.agents', 'skills')]);
    expect(observed?.sessionId).toBe(result.taskId);
    expect((await tasks.get(result.taskId))?.workerMessages).toHaveLength(2);
  });

  it('账套存在性任务要求只用专用目录搜索 operation', async () => {
    // Phase 3 起宿主不再做领域判别：操作与任务类型的匹配归执行层 SKILL 与平台门禁
    // （17dz src/execution/plan.js 的 PLAN_CALL_MISMATCH + 17dz-query SKILL.md）。
    // 宿主只保留领域无关的实体来源校验——这里断言新语义：目录检索计划放行，
    // 且越权实体仍被拒。
    // 单次目录检索：实体来自当前消息 → 放行
    expect(validatePlanEntities(
      [{ operation: 'finance.search-account-sets', args: ['--query', '胜利'] }],
      { currentMessage: '只查有没有胜利这个帐套' },
    )).toBeNull();
    // 混入本轮请求里没有的实体 → 仍然拒（实体来源校验不弱于原来）
    expect(validatePlanEntities(
      [{ operation: 'finance.search-account-sets', args: ['--query', '胜利'] },
        { operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }],
      { currentMessage: '只查有没有胜利这个帐套' },
    )).toContain('未在当前请求、检索证据、平台响应或本会话已确立实体中出现的参数');
  });

  it('将宿主核验后的申报契约与实体来源传给子 Agent', async () => {
    const root = await profileRoot();
    let prompt = '';
    let observed: TurnDriverInput | undefined;
    const subagent = runner(root, new MemoryTasks(), {
      run: async (input) => {
        prompt = input.systemPrompt;
        observed = input;
        return { text: '已按当前范围查询。', messages: input.messages };
      },
    });

    await subagent.run({
      request: '查幻辰财税账套里猫一杯的应收账款',
      turnDeclaration: { kind: 'delegate', request: '查幻辰财税账套里猫一杯的应收账款' },
      entitySources: { currentMessage: '查幻辰财税账套里猫一杯的应收账款', referenceEvidence: '【宿主主动回溯】幻东 202609 余额 51 元' },
    }, { trusted: trusted() });

    expect(prompt).toContain('宿主已核验本轮请求');
    // 加工后的 request 随申报一起进 worker 提示词（宿主不再做领域判别，只透传请求本身）
    expect(prompt).toContain('查幻辰财税账套里猫一杯的应收账款');
    // 领域无关的实体来源原样透传到 worker 驱动（宿主不懂业务，只做字符串包含）
    expect(observed?.entitySources).toEqual({
      currentMessage: '查幻辰财税账套里猫一杯的应收账款',
      referenceEvidence: '【宿主主动回溯】幻东 202609 余额 51 元',
    });
    // 申报契约三字段原样透传，宿主不加工不补字段
    expect(observed?.turnDeclaration).toEqual({ kind: 'delegate', request: '查幻辰财税账套里猫一杯的应收账款' });
    // 纠错环规程（Phase 5）：执行不了时报"缺什么/为什么/建议用户提供什么"，
    // 与既有总结原则同一份表述，不新增场景枚举
    expect(prompt).toContain('缺什么、为什么、建议提供什么');
  });

  // ── fail-loud 规程（2026-10-08 实测补漏）：同一障碍撞两次就停，别留到第三次 ──────
  // 上面那条只覆盖"缺信息"（缺什么/为什么/建议提供什么），覆盖不了实测里的"越挫越试"：
  // 同一个拒绝理由连着出现五次，每次只换个姿势再试，预算烧光后超时且主产出没回到用户
  // 手上。这一组断言钉住阈值判据、交付顺序与位置（与"缺信息"条目相邻）。

  it('fail-loud 规程进 worker 提示词：同类错误第二次即停 + 先交付已确定部分', async () => {
    const root = await profileRoot();
    let prompt = '';
    const subagent = runner(root, new MemoryTasks(), {
      run: async (input) => {
        prompt = input.systemPrompt;
        return { text: '完成。', messages: input.messages };
      },
    });

    await subagent.run({ request: '查询一下' }, { trusted: trusted() });

    // 阈值判据：同类错误第二次出现就停（不是"再试一次看看"）
    expect(prompt).toContain('同一障碍最多撞两次');
    expect(prompt).toContain('第二次出现时就停止重试');
    // 换姿势绕过不算新尝试：被拒后改写法/换路径/换参数形态仍是同一次障碍
    expect(prompt).toContain('换写法、换路径、换参数形态再试不算新尝试');
    // 交付顺序：先交付已确定的部分，存疑项一次列全，不为次要产出阻塞主产出
    expect(prompt).toContain('先交付已经确定的部分');
    expect(prompt).toContain('不要为次要产出阻塞主产出');
    // 位置：与其它判断类原则同属「工作原则」一节。重构后提示词按"身份/原则/硬边界/
    // 输出纪律"四类分节，这一条是**行为判据**（阈值+交付顺序）而不是某个场景的
    // annex——断言它没被踢出原则节，仍与"拿不到就说缺什么"相邻。
    const principles = prompt.slice(prompt.indexOf('## 工作原则'), prompt.indexOf('## 硬边界'));
    expect(principles).toContain('同一障碍最多撞两次');
    expect(principles).toContain('拿不到就说缺什么');
    expect(principles).toContain('先交付已经确定的部分');

    // 领域无关：只取这一条本身，断言它零业务词——编排层通用规则不该带任何域知识，
    // 换域一个字都不用改（重构后整份提示词零业务词，见下方"四类结构"那条的全局断言）
    const start = prompt.indexOf('同一障碍最多撞两次');
    const rule = prompt.slice(start, prompt.indexOf('\n\n', start));
    expect(rule).toContain('先交付已经确定的部分');
    expect(rule).not.toMatch(/应收|凭证|科目|账套|期间|目录|税号|财务|借贷|余额|往来|时间范围|记录|档案|摸底/u);
  });

  // ── worker 系统提示词四类结构（2026-10-08 重构）：身份 / 原则 / 硬边界 / 输出纪律 ──
  // 每条断言对应一次事故补丁或一条通用约束；删句即红（措辞可压缩，语义不许消失）。
  // 反向断言同时钉住"平台实现细节与文件格式名不进通用提示词"（律法 L2：协议事实
  // 平台拥有，宿主读 operation list --json 不抄写）。

  /** 取一次委派的 worker 系统提示词（读关闭 + 有 scratchDir + 有宿主申报的标准形态）。 */
  async function capturePrompt(request = '查一下余额', turnDeclaration?: Extract<TurnDeclaration, { kind: 'delegate' }>): Promise<string> {
    const root = await profileRoot();
    let prompt = '';
    const subagent = runner(root, new MemoryTasks(), {
      run: async (input) => {
        prompt = input.systemPrompt;
        return { text: '完成。', messages: input.messages };
      },
    });
    await subagent.run({ request, ...(turnDeclaration ? { turnDeclaration } : {}) }, { trusted: trusted() });
    return prompt;
  }

  it('四类分节：身份与职责 / 工作原则 / 硬边界 / 输出纪律，按此顺序', async () => {
    const prompt = await capturePrompt();
    const headings = ['## 身份与职责', '## 工作原则', '## 硬边界', '## 输出纪律'];
    const at = headings.map((heading) => prompt.indexOf(heading));
    for (const index of at) expect(index).toBeGreaterThanOrEqual(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // 判断类规则（原则）与机械类规则（硬边界）分开：混在一处时模型分不清哪条能通融
    expect(prompt.slice(at[1]!, at[2]!)).not.toContain('可写位置');
    expect(prompt.slice(at[2]!, at[3]!)).toContain('可写位置');
  });

  it('工作原则：优先复用平台确定性子过程，不要自己实现', async () => {
    const prompt = await capturePrompt();
    // 治"自己写渲染器/自己洗数据"：平台有确定性子过程（校验、渲染、格式转换）而 worker
    // 重造一份——重造那份与平台口径漂移，产出不可复核
    expect(prompt).toContain('优先复用');
    expect(prompt).toContain('必须调用，不要自己实现');
    // 自写代码的唯一合法位置是上游吸收：格式不稳定、需要判断的那一步
    expect(prompt).toContain('自写代码只用于上游吸收');
  });

  it('工作原则：交付前自检，不过校验就停下报告', async () => {
    const prompt = await capturePrompt();
    // 治"不过校验直接交付"：域提供的校验入口被跳过，错数据直达用户
    expect(prompt).toContain('交付前自检');
    expect(prompt).toContain('必须过一遍再交付');
    expect(prompt).toContain('不改不跳过');
  });

  it('工作原则：只做被要求的事，范围外发现要报告', async () => {
    const prompt = await capturePrompt();
    // 治"自作主张扩大产出"：用户只要一件事，worker 顺手多做一件没人要的
    expect(prompt).toContain('只做被要求的事');
    expect(prompt).toContain('发现范围外的产出或前置动作，报告，不要自作主张');
  });

  it('工作原则：经济性——一次调用能拿到的不要写脚本绕', async () => {
    const prompt = await capturePrompt();
    // 治"为绕一次调用写整套脚本"：脚本比调用更贵、更容易错，且绕过平台的口径校验
    expect(prompt).toContain('经济性');
    expect(prompt).toContain('一次调用能拿到的不要写脚本绕');
  });

  it('输出纪律：内部语言不上屏 + 来源标注中性表述', async () => {
    const prompt = await capturePrompt();
    // Stage 3 事故根治包：脚本路径/错误码/JSON/门的规则引述不得进最终回复
    expect(prompt).toContain('内部语言不上屏');
    expect(prompt).toContain('脚本路径、错误码、JSON、协议状态、接口名、门的规则');
    // 2026-09-27 第三波：来源标注只能说"平台实时查询"，不许出现接口标识符
    expect(prompt).toContain('平台实时查询');
    expect(prompt).toContain('不出现 operation 名、接口名或脚本名');
  });

  it('输出纪律：内部控制不上屏 + 不主动交代表能力边界', async () => {
    const prompt = await capturePrompt();
    // 同波补漏：计划额度/拒绝次数/熔断/计划门/重试上限是内部控制状态，不是"说明"
    expect(prompt).toContain('内部控制不上屏');
    expect(prompt).toContain('计划额度、拒绝次数、熔断、计划门、重试上限');
    // 诚实不等于全说：用户没问到的口径，接口不支持就不是他需要知道的事
    expect(prompt).toContain('不主动交代表能力边界');
  });

  it('输出纪律：名称类请求先经平台检索 + 已取结果必须呈现', async () => {
    const prompt = await capturePrompt();
    // D-072：会话已确立实体只回答"只给参数的续问"，新名称一律重新检索（防张冠李戴）
    expect(prompt).toContain('名称类请求仍须先经平台检索确认规范名称');
    expect(prompt).toContain('即使用户本会话已经用过某个对象');
    // D-073：数据在手时把用户推回重新发起 = 球踢回给用户
    expect(prompt).toContain('本轮已经取到的执行结果必须呈现在终稿里');
    expect(prompt).toContain('明示缺席原因');
  });

  it('硬边界：知识面含技能指向的程序文档，实现源码不可读', async () => {
    const prompt = await capturePrompt();
    // 门禁：知识只经 read 读固定知识面。"技能指向的程序文档"是本次重构新加入知识面的
    // 一项——SOP 类文档（WORKFLOW.md 一类）此前被排除在外，worker 于是从不读 SOP。
    expect(prompt).toContain('知识只经 read');
    expect(prompt).toContain('及技能指向的程序文档');
    expect(prompt).toContain('实现源码不可读');
    // 先读知识面再调平台能力，数据必须来自平台返回（治编造数据）
    expect(prompt).toContain('先读知识面再调用平台能力');
    expect(prompt).toContain('不得编造');
  });

  it('硬边界：计划门协议保留状态字，草案形状由单一来源派生', async () => {
    const prompt = await capturePrompt();
    // 执行前先提交方案（宿主协议）：状态字是宿主协议的一部分，压缩措辞但五个状态都在
    expect(prompt).toContain('执行前先提交方案');
    for (const state of ['PLAN ACTIVE', 'PLAN DECLINED', 'PLAN NEEDS_USER_CONFIRM', 'PLAN PAUSED', 'PLAN STOP']) {
      expect(prompt, `计划门状态字 ${state} 必须留在提示词里`).toContain(state);
    }
    // 范围扩大时重新提交完整 calls（防止"计划外执行"）
    expect(prompt).toContain('范围变化时重提完整 calls');
  });

  it('硬边界：可写位置与读不到上游内容时的自写脚本边界', async () => {
    const prompt = await capturePrompt();
    // 机械边界：只有 scratchDir 写得进去，不说 worker 只能猜，猜错就白跑一轮
    expect(prompt).toContain('可写位置：tmp/req-1');
    expect(prompt).toContain('其他路径不可写');
    // D-083（用户明确批准）：读不到上游内容时可自写解析脚本，但必须落在可写目录内
    expect(prompt).toContain('读不到上游内容时');
    expect(prompt).toContain('自写解析脚本');
    expect(prompt).toContain('经统一入口本地执行');
  });

  it('平台调用形状以清单为准：不手抄网关形状、不限定单一模式', async () => {
    const prompt = await capturePrompt();
    // 律法 L2：协议事实平台拥有，宿主读数据（operation list --json）不抄写——手抄那份
    // 随平台演进过期，而模型会照着手抄那份去撞门
    expect(prompt).toContain('平台调用走统一入口');
    expect(prompt).toContain('operation list --json');
    // 反向：网关调用形状（脚本路径/flag 纪律/等号变形）与"只教 query 一种模式"都不在
    expect(prompt).not.toContain('--<flag>');
    expect(prompt).not.toContain('kebab-case');
    expect(prompt).not.toContain('--flag=值');
    expect(prompt).not.toContain('bin/17dz query');
  });

  it('反向：提示词不含文件格式名与具体 operation 名', async () => {
    const prompt = await capturePrompt();
    // 文件格式名是域知识：Excel/xlsx 一类只该出现在技能文档里，通用提示词不提
    expect(prompt).not.toMatch(/Excel|xlsx|csv|pdf|docx/i);
    // 具体 operation 名同理：出现即把平台实现细节带进编排层（泄漏 lint 的 FORBIDDEN 家族）
    expect(prompt).not.toContain('finance.query-receivables');
    expect(prompt).not.toMatch(/query-receivables|search-account-sets|query-saved|subject-list/);
    // 平台脚本文件名与脚本目录路径同样不上屏
    expect(prompt).not.toMatch(/\.js\b/);
    expect(prompt).not.toContain('src/finance/scripts');
  });

  it('反向：整份提示词零业务词（编排层通用规则不带域知识）', async () => {
    const prompt = await capturePrompt();
    // 插值的 request 是用户原话（夹具里就带"余额"），不算宿主措辞，先剥掉再查
    const host = prompt.split('\n').filter((line) => !line.startsWith('宿主已核验本轮请求')).join('\n');
    expect(host).not.toMatch(/应收|凭证|科目|账套|期间|税号|财务|借贷|余额|往来|时间范围|记录|档案|摸底/u);
    // "目录"是泄漏 lint 允许集里 context.ts 的遗留待清项（理想形态应收敛为平台 SKILL
    // 指针）：提示词只把它用在文件系统意义上（工作目录），不用它指任何领域检索动作
    expect(host.replace(/工作目录/g, '')).not.toContain('目录');
  });

  it('宿主未注入实体来源时不向 worker 驱动传该字段（老路径不做实体校验）', async () => {
    const root = await profileRoot();
    let observed: TurnDriverInput | undefined;
    const subagent = runner(root, new MemoryTasks(), {
      run: async (input) => {
        observed = input;
        return { text: '完成。', messages: input.messages };
      },
    });

    await subagent.run({ request: '查询余额' }, { trusted: trusted() });

    expect(observed?.entitySources).toBeUndefined();
    expect(observed?.turnDeclaration).toBeUndefined();
  });

  // ── 能力信封（D-075 软层）：worker 系统提示词里的当前能力声明 ─────────────────
  // 第 1 层（计划扫描）是机械兜底，但 T7 形态里模型的计划可能全程只含只读的"录入准备"
  // 调用——机械扫描无事可做，能否披露全靠 worker 自己知道写权限是关闭的。这一层把能力
  // 声明作为框架事实注入提示词。**诚实报告：没有机械锁**，与 D-072 的技能条同性质。

  it('写关闭（capabilities 不含 write）时 worker 提示词含能力信封句与必须告知的义务', async () => {
    const root = await profileRoot();
    let prompt = '';
    const subagent = runner(root, new MemoryTasks(), {
      run: async (input) => {
        prompt = input.systemPrompt;
        return { text: '完成。', messages: input.messages };
      },
    });

    // capabilities 缺省同样视为只读（与契约层同语义）：信封句照常注入
    await subagent.run({ request: '查一下余额' }, { trusted: trusted() });
    expect(prompt).toContain('能力信封：本部署未开放写入能力（只读）');
    expect(prompt).toContain('当前未开放写入权限，如有需要请联系管理员开通。');
    expect(prompt).toContain('不得承诺可以完成写入');

    await subagent.run({ request: '查一下余额' }, { trusted: { ...trusted(), capabilities: ['read'] } });
    expect(prompt).toContain('能力信封：本部署未开放写入能力（只读）');
  });

  it('写开放时 worker 提示词含已开放能力信封句，且不出现未开放措辞', async () => {
    const root = await profileRoot();
    let prompt = '';
    let observed: TurnDriverInput | undefined;
    const subagent = runner(root, new MemoryTasks(), {
      run: async (input) => {
        prompt = input.systemPrompt;
        observed = input;
        return { text: '完成。', messages: input.messages };
      },
    });

    await subagent.run({ request: '查一下余额' }, { trusted: { ...trusted(), capabilities: ['read', 'write'] } });

    expect(prompt).toContain('能力信封：本部署已开放写入能力');
    expect(prompt).not.toContain('本部署未开放写入能力');
    // 能力声明同时透传到 worker 驱动（写关闭判据 D-075 的宿主持有输入）
    expect(observed?.capabilities).toEqual(['read', 'write']);
  });

  it('计划模式的步骤标签透传给子 Agent 驱动，用户通知带「第 N/M 步」前缀', async () => {
    const root = await profileRoot();
    let observed: TurnDriverInput | undefined;
    const notices: string[] = [];
    const subagent = runner(root, new MemoryTasks(), {
      run: async (input) => {
        observed = input;
        // 复刻平台计划门的通知：固定标记在前，宿主在这一层加步骤前缀
        await input.onNotice?.('计划通知：本次需新增 3 次查询，预计约 1 分钟。通知送达后将继续执行。');
        return { text: '已完成。', messages: input.messages };
      },
    });
    const ctx = trusted();
    ctx.onNotice = async (text) => { notices.push(text); };

    await subagent.run({ request: '查某个对象 202609', stepLabel: '第 1/3 步' }, { trusted: ctx });

    // 前缀插在固定标记之后：渠道与测试替身仍能识别这是计划通知帧
    expect(notices).toEqual(['计划通知：【第 1/3 步】本次需新增 3 次查询，预计约 1 分钟。通知送达后将继续执行。']);
    // 步骤标签只走通知链路，不进 worker 驱动输入
    expect(observed?.onNotice).toBeTypeOf('function');
  });

  it('没有步骤标签（单步模式）时通知原样交付，不加前缀', async () => {
    const root = await profileRoot();
    const notices: string[] = [];
    const subagent = runner(root, new MemoryTasks(), {
      run: async (input) => {
        await input.onNotice?.('计划通知：本次需新增 3 次查询。');
        return { text: '已完成。', messages: input.messages };
      },
    });
    const ctx = trusted();
    ctx.onNotice = async (text) => { notices.push(text); };

    await subagent.run({ request: '查某个对象 202609' }, { trusted: ctx });

    expect(notices).toEqual(['计划通知：本次需新增 3 次查询。']);
  });

  it('worker 回报"缺什么"时结构化线索原样上交，任务记录保持可续', async () => {    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const subagent = runner(root, tasks, {
      run: async (input) => ({
        text: '平台要求必须显式给出期间。',
        messages: input.messages,
        needs: { missing: ['期间'], reason: '平台要求必须显式给出期间', suggestion: '请给出要查的期间' },
      }),
    });

    const result = await subagent.run({ request: '查余额' }, { trusted: trusted() });

    expect(result.needs).toEqual({ missing: ['期间'], reason: '平台要求必须显式给出期间', suggestion: '请给出要查的期间' });
    // 没有执行凭证（这一轮零执行），线索本身就是给宿主的信号
    expect(result.execution).toBeUndefined();
    // taskId 已知会宿主侧，且 worker 转录已落库：用户补充后经 continueTaskId 从断点续跑
    expect(result.taskId).toMatch(/^task_/);
    expect((await tasks.get(result.taskId))?.workerMessages).toHaveLength(1);
  });

  it('应收余额任务失败后禁止用历史凭证跨期间兜底', () => {
    // Phase 3 起宿主不再做领域判别（"只能调某个操作""不得带未申报期间"归执行层 SKILL
    // 与平台门禁）。保留的是实体来源校验：本轮请求里没有的实体一律拒——
    // 拿历史实体兜底在这里被挡下，与旧分支的越权判定等价。
    const sources = { currentMessage: '查一下幻辰财税账套本期的应收' };
    // 越权实体（历史里出现过、本轮请求里没有）→ 拒
    expect(validatePlanEntities(
      [{ operation: 'voucher.query-saved', args: ['幻辰财税', '202601'] }],
      sources,
    )).toContain('未在当前请求、检索证据、平台响应或本会话已确立实体中出现的参数');
    // 平台自己返回的候选/期间 → 放行（search→query 场景，宿主不懂业务）
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202601'] }],
      { ...sources, platformResponses: ['当前期间为 202601'] },
    )).toBeNull();
    // 本轮请求里逐字出现的实体 → 放行，不管 operation 是什么
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }],
      sources,
    )).toBeNull();
  });

  // ── worker 自产物路径豁免（2026-10-13 实测假拒修复）────────────────────────────
  //
  // 事故形状（真模型 + mock 平台 + 写开放）：worker 把提案 payload 写进自己的草稿位置后，
  // 按 `tmp/<requestId>/proposal.json` 排进 plan_submit。该路径不在①-④任何来源里——它是
  // worker 刚落盘的工作区产物，不是用户给过、平台返回过的名称——被 ENTITY_OUT_OF_SCOPE 拒；
  // 重提再拒，撞 DECLINED_PLAN_LIMIT 后终局 block，worker 只能告诉用户"操作申请已用尽"。
  // 开关关着时同一条命令走直接 bash 反而能成（绕过实体校验）：新网关路径比旧路径更易被挡。
  // 修复：路径判据复用 write 门 / 提案 payload 边界检查同一把尺（workspaceRelPath +
  // isInsideScratch），只有本轮 scratch 内的产物路径免检。

  /** 造一个真实工作区根（路径判据要 realpath，根必须存在）。 */
  async function artifactWorkspace(requestId: string): Promise<{ workspaceRoot: string; scratchDir: string }> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-agent-ws-'));
    roots.push(root);
    await mkdir(path.join(root, 'tmp', requestId), { recursive: true });
    return { workspaceRoot: root, scratchDir: `tmp/${requestId}` };
  }

  it('本轮 scratch 内的产物路径放行（worker 自己写下的 payload 不是领域实体）', async () => {
    const requestId = 'req_31776cfb-3bdd-4ec7-8389-d5d40ac4b4ea';
    const boundary = await artifactWorkspace(requestId);
    const sources = { currentMessage: '把幻辰财税 202606 的应收做成提案' };
    // 事故原形：草稿位置里的 payload 路径，当前消息里没有它
    expect(validatePlanEntities(
      [{ operation: 'voucher.proposal', args: [`tmp/${requestId}/proposal.json`] }],
      sources,
      boundary,
    )).toBeNull();
    // 子目录里的中间产物同样放行（worker 的草稿不限于顶层）
    expect(validatePlanEntities(
      [{ operation: 'voucher.proposal', args: [`tmp/${requestId}/draft/payload.json`] }],
      sources,
      boundary,
    )).toBeNull();
    // 同一条计划里的领域实体仍逐字校验：豁免只免路径，不免实体
    expect(validatePlanEntities(
      [{ operation: 'voucher.proposal', args: [`tmp/${requestId}/proposal.json`, '--period', '202606'] }],
      sources,
      boundary,
    )).toBeNull();
    // 不给边界判据（requestId 缺失 / 老路径 / 测试替身）→ 豁免整支不出现，判定与从前一字不差
    expect(validatePlanEntities(
      [{ operation: 'voucher.proposal', args: [`tmp/${requestId}/proposal.json`] }],
      sources,
    )).toContain('未在当前请求、检索证据、平台响应或本会话已确立实体中出现的参数');
  });

  it('对抗：伪装成路径的越权实体仍被拒（判据是解析结果，不是字符串长相）', async () => {
    const requestId = 'req_31776cfb-3bdd-4ec7-8389-d5d40ac4b4ea';
    const boundary = await artifactWorkspace(requestId);
    const scope = '未在当前请求、检索证据、平台响应或本会话已确立实体中出现的参数';
    // 别轮次的草稿位置：同在 tmp/ 下但不是本任务私产
    expect(validatePlanEntities(
      [{ operation: 'voucher.proposal', args: ['tmp/req_别的任务/proposal.json'] }],
      { currentMessage: '把幻辰财税 202606 的应收做成提案' },
      boundary,
    )).toContain(scope);
    // 词法穿越：先逃出本轮 scratch 再绕回来，归一化后落点是别处
    expect(validatePlanEntities(
      [{ operation: 'voucher.proposal', args: [`tmp/${requestId}/../req_别的任务/proposal.json`] }],
      { currentMessage: '把幻辰财税 202606 的应收做成提案' },
      boundary,
    )).toContain(scope);
    // 工作区里别的位置（根下的普通文件）：worker 可读不可写成"实体"
    expect(validatePlanEntities(
      [{ operation: 'any.operation', args: ['docs/名单.md'] }],
      { currentMessage: '查一下' },
      boundary,
    )).toContain(scope);
    // 绝对路径越界与 ../ 穿越：workspaceRelPath 直接返回 null，回到逐字校验
    for (const token of ['/etc/passwd', `../${requestId}/proposal.json`, '../../etc/shadow']) {
      expect(validatePlanEntities(
        [{ operation: 'any.operation', args: [token] }],
        { currentMessage: '查一下' },
        boundary,
      )).toContain(scope);
    }
    // 豁免按参数逐个判定，不是整支计划免检：同一 call 里的幻觉实体照样被拒
    expect(validatePlanEntities(
      [{ operation: 'voucher.proposal', args: [`tmp/${requestId}/proposal.json`, '幻觉出来的对象'] }],
      { currentMessage: '把幻辰财税 202606 的应收做成提案' },
      boundary,
    )).toContain('幻觉出来的对象');
    // 豁免也不把领域实体的校验放松：消息里没有的名字带边界判据也照样拒
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }],
      { currentMessage: '查一下胜利这个帐套' },
      boundary,
    )).toContain(scope);
  });

  it.each([
    '找到两个客户，请选择一个。',
    '请确认是否继续执行。',
    '当前权限不足，无法继续。',
  ])('不分析子 Agent 文本状态：%s', async (text) => {
    const root = await profileRoot();
    const result = await runner(root, new MemoryTasks(), ScriptedTurnDriver([{ text }]))
      .run({ request: '执行任务' }, { trusted: trusted() });
    expect(result.text).toBe(text);
  });

  it('通过 taskId 恢复子 Agent 转录，最新补充作为普通用户消息追加', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const first = await runner(root, tasks, ScriptedTurnDriver([{ text: '找到两个客户，请用户选择。' }]))
      .run({ request: '查询幻东余额' }, { trusted: trusted() });

    let resumedMessages: TurnDriverInput['messages'] = [];
    const second = await runner(root, tasks, {
      run: async (input) => {
        resumedMessages = input.messages;
        return ScriptedTurnDriver([{ text: '已按用户选择查询完成。' }]).run(input);
      },
    }).run({ taskId: first.taskId, request: '用户选择幻州幻东机械有限公司' }, { trusted: trusted() });

    expect(second.taskId).toBe(first.taskId);
    expect(second.text).toBe('已按用户选择查询完成。');
    expect(resumedMessages).toHaveLength(3);
    expect(resumedMessages.at(-1)).toMatchObject({ role: 'user', content: '用户选择幻州幻东机械有限公司' });
  });

  it('不同 principal 或主会话不能接管已有子 Agent session', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const subagent = runner(root, tasks, ScriptedTurnDriver([{ text: '第一次完成。' }]));
    const first = await subagent.run({ request: '第一次' }, { trusted: trusted() });

    await expect(subagent.run({ request: '越权', taskId: first.taskId }, { trusted: trusted('session-1', 'wecom:other') }))
      .rejects.toThrow('TASK_FORBIDDEN');
    await expect(subagent.run({ request: '跨会话', taskId: first.taskId }, { trusted: trusted('session-2') }))
      .rejects.toThrow('TASK_FORBIDDEN');
  });

  it('未知 taskId 和越界 skillRoots 在运行 Worker 前被拒绝', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    let called = false;
    const driver: TurnDriver = { run: async () => { called = true; throw new Error('不应执行'); } };
    const subagent = runner(root, tasks, driver);
    await expect(subagent.run({ request: '继续', taskId: 'missing' }, { trusted: trusted() })).rejects.toBeInstanceOf(ToolUserError);

    const invalid = createContextTaskRunner({
      profiles: { '17dz': { root, skillRoots: ['../outside'] } },
      tasks,
      workerDriver: driver,
    });
    await expect(invalid.run({ request: '读取越界目录' }, { trusted: trusted() })).rejects.toThrow('路径安全校验');
    expect(called).toBe(false);
  });

  // ── continueTaskId 查不到：冒泡，不猜绑定 ────────────────────────────────
  // 真实平台战斗测试实测：模型会编一个不存在的任务编号填进 continueTaskId。宿主只保证
  // 两件事——错误永远诚实可行动、爆炸永远有界。"这个会话里有几个开放任务"宿主知道，
  // 但"模型想续的是哪一个"只有模型知道；替它猜（哪怕恰一个时猜对）就是把重试的职责
  // 从模型手里拿回来，猜错时用户的问题会被静默送进别的子任务。因此一律抛 ToolUserError，
  // 消息说清编号无效 + 下一步动作（三要素措辞收口在 error-codes.ts 的 TASK_NOT_FOUND），
  // 让模型下一轮自己改。
  describe('continueTaskId 查不到时：抛"未找到可继续"，不静默按新任务放行', () => {
    it('幻觉编号：直接抛"未找到可继续"，worker 一次都不叫', async () => {
      const root = await profileRoot();
      const tasks = new MemoryTasks();
      let called = false;
      const subagent = runner(root, tasks, { run: async () => { called = true; throw new Error('不应执行'); } });
      await expect(subagent.run({ request: '继续', taskId: 'task_hallucinated_404' }, { trusted: trusted() }))
        .rejects.toThrow('TASK_NOT_FOUND');
      expect(called).toBe(false);
    });

    it('会话里已经有多个任务也不猜：编号对不上就报错（多任务歧义交给用户）', async () => {
      const root = await profileRoot();
      const tasks = new MemoryTasks();
      const subagent = runner(root, tasks, ScriptedTurnDriver([{ text: '第一个任务。' }, { text: '第二个任务。' }]));
      await subagent.run({ request: '查 A' }, { trusted: trusted() });
      await subagent.run({ request: '查 B' }, { trusted: trusted() });
      expect(tasks.records.size).toBe(2);

      // 两个候选一个都不绑：猜哪一个都是把用户的问题派到别的子任务上
      await expect(subagent.run({ request: '继续', taskId: 'task_hallucinated_404' }, { trusted: trusted() }))
        .rejects.toThrow('TASK_NOT_FOUND');
    });

    it('合法 taskId 精确命中：照常续跑同一个子任务', async () => {
      const root = await profileRoot();
      const tasks = new MemoryTasks();
      const first = await runner(root, tasks, ScriptedTurnDriver([{ text: '找到两个客户，请用户选择。' }]))
        .run({ request: '查询幻东余额' }, { trusted: trusted() });
      // 同一个会话再开一个任务：有两个候选在，合法编号仍必须精确命中
      await runner(root, tasks, ScriptedTurnDriver([{ text: '另一个任务。' }])).run({ request: '查 B' }, { trusted: trusted() });

      const second = await runner(root, tasks, ScriptedTurnDriver([{ text: '已按用户选择查询完成。' }]))
        .run({ taskId: first.taskId, request: '用户选择幻州幻东机械有限公司' }, { trusted: trusted() });
      expect(second.taskId).toBe(first.taskId);
    });
  });

  it('把外层 AbortSignal 和 profile deadline 传给子 Agent', async () => {
    const root = await profileRoot();
    const controller = new AbortController();
    let observed: TurnDriverInput | undefined;
    const started = Date.now();
    const subagent = createContextTaskRunner({
      profiles: { '17dz': { root, skillRoots: ['.agents/skills'], workerTimeoutMs: 1234 } },
      tasks: new MemoryTasks(),
      workerDriver: {
        run: async (input) => {
          observed = input;
          return { text: '完成。', messages: input.messages };
        },
      },
    });
    await subagent.run({ request: '测试预算' }, { trusted: trusted() }, controller.signal);
    expect(observed?.signal).toBe(controller.signal);
    expect((observed?.deadline ?? 0) - started).toBeGreaterThan(900);
    expect((observed?.deadline ?? 0) - started).toBeLessThan(3000);
  });

  it('将 confirm pending 绑定到可信 principal/session 并先持久化再返回', async () => {
    const root = await profileRoot();
    const pending = { planId: 'plan_1', version: 3, taskId: 'task_1', decision: 'confirm' as const, userText: '需要确认', evaluation: {} as never };
    let saved: unknown;
    const subagent = createContextTaskRunner({
      profiles: { '17dz': { root, skillRoots: ['.agents/skills'] } },
      tasks: new MemoryTasks(),
      workerDriver: { run: async (input) => ({ text: '需要确认', messages: input.messages, pendingPlan: pending }) },
    });
    const ctx = trusted();
    ctx.onPlanPending = async (record) => { saved = record; };
    const result = await subagent.run({ request: '执行较大查询' }, { trusted: ctx });
    expect(saved).toMatchObject({ planId: 'plan_1', taskId: result.taskId, principalId: 'wecom:user-1', sessionId: 'session-1', requestId: 'req-1' });
    expect(result.pendingPlan).toMatchObject({ planId: 'plan_1', taskId: result.taskId });
  });

  it('pending plan 持久化失败时不把确认请求当作正常完成结果返回', async () => {
    const root = await profileRoot();
    const subagent = createContextTaskRunner({
      profiles: { '17dz': { root, skillRoots: ['.agents/skills'] } },
      tasks: new MemoryTasks(),
      workerDriver: { run: async (input) => ({
        text: '需要确认', messages: input.messages,
        pendingPlan: { planId: 'plan_1', version: 3, taskId: 'task_1', decision: 'confirm', userText: '需要确认', evaluation: {} as never },
      }) },
    });
    const ctx = trusted();
    ctx.onPlanPending = async () => { throw new Error('pending store down'); };
    await expect(subagent.run({ request: '执行较大查询' }, { trusted: ctx })).rejects.toThrow('17dz 子任务执行失败');
  });

  it('③-3 宿主未配置 onPlanPending：用户话术指向管理员，不说"执行失败请稍后再试"', async () => {
    const root = await profileRoot();
    const subagent = createContextTaskRunner({
      profiles: { '17dz': { root, skillRoots: ['.agents/skills'] } },
      tasks: new MemoryTasks(),
      workerDriver: { run: async (input) => ({
        text: '需要确认', messages: input.messages,
        pendingPlan: { planId: 'plan_1', version: 3, taskId: 'task_1', decision: 'confirm', userText: '需要确认', evaluation: {} as never },
      }) },
    });
    // trusted() 默认不带 onPlanPending：计划停在确认门却没人接盘——这是部署漏配，
    // 不是用户能重试好的事。旧实现落进 C5 catch 说"17dz 子任务执行失败，请稍后再试"，
    // 把配置故障伪装成平台抖动（③-3：宿主不猜但也没对齐用户）。
    const failure = await subagent.run({ request: '执行较大查询' }, { trusted: trusted() }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolUserError);
    expect((failure as Error).message).toBe('平台计划待确认，但宿主未配置安全持久化回调，请联系管理员。');
    expect((failure as Error).message).not.toContain('稍后');
    expect((failure as Error).message).not.toContain('执行失败');
  });

  it('子 Agent 内部错误不会透传路径或秘密', async () => {
    const root = await profileRoot();
    const subagent = runner(root, new MemoryTasks(), {
      run: async () => { throw new Error('secret=/private/credentials'); },
    });
    await expect(subagent.run({ request: '执行任务' }, { trusted: trusted() }))
      .rejects.toThrow('17dz 子任务执行失败，请稍后再试。');
  });

  it('Main Agent 只申报本轮动作，宿主据申报委派并采用子 Agent 自然语言结果', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const scripted = runner(root, tasks, ScriptedTurnDriver([{ text: '找到两个客户，请让用户选择。' }]));
    // 脚本化 worker 不经计划门，所以由替身补上执行凭证——否则宿主按"零执行"失败关闭。
    const subagent: ContextTaskRunner = {
      tool: scripted.tool,
      run: async (args, ctx, signal) => ({
        ...(await scripted.run(args, ctx, signal)),
        execution: { planId: 'plan_test', version: 1, calls: 1 },
      }),
    };
    let exposed: string[] = [];
    const mainDriver: TurnDriver = {
      run: async (input) => {
        exposed = input.tools.map((tool) => tool.name);
        try {
          await input.exec('route_current_turn', { kind: 'delegate', request: '查幻东的应收账款余额' });
        } catch (error) {
          if (error instanceof ToolUserError) return { text: error.message, messages: input.messages };
          throw error;
        }
        return {
          text: '这条文本不应外发',
          messages: [...input.messages, { role: 'assistant', content: '这条文本不应外发', timestamp: Date.now() } as never],
        };
      },
    };
    const runtime = createTaxAgentRuntime({ driver: mainDriver, sessions: new MemorySessions(), platformTask: subagent });
    const reply = await runtime.handleTurn(trusted(), '查幻东余额');

    expect(exposed).toEqual(['route_current_turn']);
    expect(reply.text).toBe('找到两个客户，请让用户选择。');
  });
});

describe('下游平台保护：委派并发闸', () => {
  /** 记录并发进出：driver 执行期间 Active 数 > 1 即说明闸门失效。 */
  function concurrencyProbe(delayMs: number) {
    let active = 0;
    let maxActive = 0;
    const driver: TurnDriver = {
      run: async (input: TurnDriverInput) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        active -= 1;
        return { text: '查完了', messages: input.messages };
      },
    };
    return { driver, peak: () => maxActive };
  }

  it('默认全局串行：两个委派不会同时进入下游平台', async () => {
    const root = await profileRoot();
    const probe = concurrencyProbe(80);
    const task = runner(root, new MemoryTasks(), probe.driver);
    const [a, b] = await Promise.all([
      task.run({ request: '查A' }, { trusted: trusted() }),
      task.run({ request: '查B' }, { trusted: trusted() }),
    ]);
    expect(a.text).toBe('查完了');
    expect(b.text).toBe('查完了');
    expect(probe.peak()).toBe(1);
  });

  it('FSHINE_PLATFORM_CONCURRENCY=2 时允许两个并行', async () => {
    const previous = process.env.FSHINE_PLATFORM_CONCURRENCY;
    process.env.FSHINE_PLATFORM_CONCURRENCY = '2';
    try {
      const root = await profileRoot();
      const probe = concurrencyProbe(80);
      const task = runner(root, new MemoryTasks(), probe.driver);
      await Promise.all([
        task.run({ request: '查A' }, { trusted: trusted() }),
        task.run({ request: '查B' }, { trusted: trusted() }),
      ]);
      expect(probe.peak()).toBe(2);
    } finally {
      if (previous === undefined) delete process.env.FSHINE_PLATFORM_CONCURRENCY;
      else process.env.FSHINE_PLATFORM_CONCURRENCY = previous;
    }
  });

  it('worker 抛错也释放闸门：后续委派不被卡死', async () => {
    const root = await profileRoot();
    let calls = 0;
    const flaky: TurnDriver = {
      run: async (input: TurnDriverInput) => {
        calls += 1;
        if (calls === 1) throw new Error('平台侧抽风');
        return { text: '恢复后查完了', messages: input.messages };
      },
    };
    const task = runner(root, new MemoryTasks(), flaky);
    // worker 原始错误被 runner 转成面向用户的安全话术（既有行为）；关键是它reject了
    await expect(task.run({ request: '查A' }, { trusted: trusted() })).rejects.toThrow('17dz 子任务执行失败');
    // 闸门已释放：第二次委派照常进行，没有被第一次的异常卡死
    const second = await task.run({ request: '查B' }, { trusted: trusted() });
    expect(second.text).toBe('恢复后查完了');
  });
});

/**
 * 委派失败分类话术（F7）：failureClass 原来只进日志，用户统一收到"执行失败请稍后再试"，
 * 于是唯一需要用户动手的一类（登录态过期）被埋掉。这里按类钉住话术。
 */
describe('委派失败分类的用户话术', () => {
  function failingRunner(root: string, message: string, workerTimeoutMs?: number) {
    const profiles: Record<string, ContextProfileConfig> = {
      '17dz': { root, skillRoots: ['.agents/skills'], ...(workerTimeoutMs === undefined ? {} : { workerTimeoutMs }) },
    };
    return createContextTaskRunner({
      profiles,
      tasks: new MemoryTasks(),
      workerDriver: { run: async () => { throw new Error(message); } },
    });
  }

  it('登录态过期：给出需要用户动手的话术，而不是"稍后再试"', async () => {
    const task = failingRunner(await profileRoot(), '平台登录已过期，请重新登录');
    await expect(task.run({ request: '查A' }, { trusted: trusted() }))
      .rejects.toThrow(DELEGATION_AUTH_FAILURE);
    // 错指令比没有指令更糟：这类失败绝不能伴随"稍后重试"
    await expect(task.run({ request: '查A' }, { trusted: trusted() }))
      .rejects.not.toThrow(/稍后/u);
  });

  it('平台响应超时：与执行器错误区分开，话术是"稍后重试"', async () => {
    // workerTimeoutMs=0 → 截止时间即起点，任何耗时都算超时
    const task = failingRunner(await profileRoot(), 'whatever', 0);
    await expect(task.run({ request: '查A' }, { trusted: trusted() }))
      .rejects.toThrow(DELEGATION_TIMEOUT_FAILURE);
  });

  it('执行器错误：维持原话术，原始错误内容不得透出', async () => {
    const task = failingRunner(await profileRoot(), 'secret=/private/credentials');
    await expect(task.run({ request: '查A' }, { trusted: trusted() }))
      .rejects.toThrow(DELEGATION_EXECUTOR_FAILURE);
    await expect(task.run({ request: '查A' }, { trusted: trusted() }))
      .rejects.not.toThrow(/secret/u);
  });

  it('取消：维持原话术，且优先于超时判定', async () => {
    const task = failingRunner(await profileRoot(), 'boom', 0);
    const controller = new AbortController();
    controller.abort();
    await expect(task.run({ request: '查A' }, { trusted: trusted() }, controller.signal))
      .rejects.toThrow(DELEGATION_CANCELLED);
  });
});
/**
 * 任务3（2026-09 第二波）：auth 判定去嗅探——以码判定，不依赖中文文案。
 *
 * 旧判据是 `/平台登录已过期/` 正则嗅探错误原文：平台改文案即退化成 executor_error，
 * 而"请稍后再试"对 auth 是错指令（重试多少次都没用）。现在信封/挂码/码前缀先行
 * （platform-contract.ts 的 auth 码集合），正则只作过渡兜底。
 */
describe('委派失败分类：登录态按错误码判定（不嗅探文案）', () => {
  function codeFailingRunner(root: string, error: Error) {
    const profiles: Record<string, ContextProfileConfig> = {
      '17dz': { root, skillRoots: ['.agents/skills'] },
    };
    return createContextTaskRunner({
      profiles,
      tasks: new MemoryTasks(),
      workerDriver: { run: async () => { throw error; } },
    });
  }

  it('挂码 / 消息码前缀的 auth 码 → auth 话术（AUTH_EXPIRED 等，与中文措辞无关）', async () => {
    const root = await profileRoot();
    const authErrors = [
      // 17dz errorFor 挂码的载体
      Object.assign(new Error('平台会话已失效'), { code: 'AUTH_EXPIRED' }),
      // 17dz messageFor 渲染：消息以码开头（契约的一部分，不是文案嗅探）
      new Error('AUTH_REDIRECTED_TO_LOGIN: 期望 导航后仍留在平台页面；实际 被重定向到登录页，会话已过期；正确形态 用户完成登录后重试'),
      // 领域脚本对 AuthExpiredError 的归一码
      Object.assign(new Error('需要登录'), { code: 'NEEDS_LOGIN' }),
      Object.assign(new Error('工作台未就绪'), { code: 'AUTH_WORKBENCH_NOT_READY' }),
      Object.assign(new Error('无会话 cookie'), { code: 'AUTH_UNKNOWN' }),
    ];
    for (const error of authErrors) {
      const task = codeFailingRunner(root, error);
      // 消息里没有任何"平台登录已过期"字样——判定全部来自码
      expect(error.message).not.toContain('平台登录已过期');
      await expect(task.run({ request: '查A' }, { trusted: trusted() }))
        .rejects.toThrow(DELEGATION_AUTH_FAILURE);
    }
  });

  it('非 auth 码不误判：SUBJECT_NOT_FOUND 等仍是 executor_error', async () => {
    const root = await profileRoot();
    const task = codeFailingRunner(root, Object.assign(new Error('科目编码不存在'), { code: 'SUBJECT_NOT_FOUND' }));
    await expect(task.run({ request: '查A' }, { trusted: trusted() }))
      .rejects.toThrow(DELEGATION_EXECUTOR_FAILURE);
  });

  it('过渡正则仍兜底：auth.js 自动重登录失败消息（暂无码）不退化', async () => {
    const root = await profileRoot();
    const task = codeFailingRunner(root, new Error('平台登录已过期，自动登录失败——login.sh 退出码 1'));
    await expect(task.run({ request: '查A' }, { trusted: trusted() }))
      .rejects.toThrow(DELEGATION_AUTH_FAILURE);
  });
});
