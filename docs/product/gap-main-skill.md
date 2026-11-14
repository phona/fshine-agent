# 缺口 2 设计：Main 业务 Skill 投递（两实验臂）

> 状态：**批准细化，未实施**（owner 裁决 2026-11-14）。本文档只做设计与最小 diff 文本，产品代码零改动。
> 基线核验（arch/r4-gaps，HEAD=eac6b6b）：`.agents/skills` 确不存在（tracked 的只有 `.agents/agents/fshine-main/agent.md`）；skills.ts 库代码完整在仓。

## 0. 一句话

Main 的 `agent.md` 保持最小（AGENTS.md「Skills First」），但 Main 侧没有任何业务 Skill 装载链路——`loadWorkerSkills`（`packages/agent/src/worker-skills.ts`）只喂 Worker 委派提示，`FileSkillRegistry`/`READ_SKILL_TOOL`（`packages/agent/src/skills.ts:11,76,131`）在 Main 面零消费。业务人员的「怎么说清一件 recurring 的事」没有投递通道。本设计给两个实验臂，**不预设胜负**。

## 1. 最小复现

前置：profile 声明 `skillRoots: [skills]`，目录 `<profile.root>/skills/<name>/SKILL.md` 放一份业务技能（如「每周例会纪要口径」）。

- 复现 A（Main 拿不到技能）：`npm run ask -- "按例会纪要口径帮我起草"`。装配链 `scripts/ask-runtime.ts:377` `loadWorkerSkills(input.profile.root, input.profile.skillRoots)` 只把技能正文嵌进 **Worker** 委派提示（worker-skills.ts:13-24）；Main 的 mainSystemPrompt = agent.md + MAIN_PROTOCOL_NOTE（ask-runtime.ts:381、apps/server/server.ts:100），不含任何技能。若模型不把它当 run_task 交办，Main 只能凭通用知识作答——业务口径丢失；若交办，Worker 拿到的 task 文本里也没有用户没说出口的口径细节（用户以为「按那个口径」Agent 就知道）。
- 复现 B（库代码死置）：`grep -rn 'READ_SKILL_TOOL' packages apps scripts --include='*.ts'` → 只在 `skills.ts:11` 定义与 skills 自身测试出现，Main 工具面（execution-runtime.ts:426）不含它。

## 2. 代码证据

| # | 证据 | 位置 |
|---|------|------|
| 1 | Main 工具面仅 run_task | `packages/agent/src/execution-runtime.ts:426-430` |
| 2 | Main 系统提示组装点（角色+协议，无技能） | `scripts/ask-runtime.ts:381`、`apps/server/server.ts:100` |
| 3 | Worker 直嵌机制（已验证） | `packages/agent/src/worker-skills.ts:13-24`（loadWorkerSkills：skillRoots→SKILL.md 正文→WorkerSkill[]；「读取失败向上抛，不静默降级」头注释 :6）；调用 `ask-runtime.ts:377` |
| 4 | WorkerSkill 注入委派提示 | `execution-runtime.ts:105-108`（WorkerSkill 接口）、TaskExecutorOptions.workerSkills（:494） |
| 5 | 技能库代码（发现+按需读取） | `packages/agent/src/skills.ts`：READ_SKILL_TOOL:11、DEFAULT_SKILL_ROOT_RELATIVE='.agents/skills':25、SKILL_CONTENT_LIMIT_BYTES=32KiB:36、FileSkillRegistry:76、createSkillRegistry:131、discoverSkills:136、listSkills:146、renderSkillCatalog:158（后两者无生产消费者，臂 B 即接线点） |
| 6 | `.agents/skills` 不存在 | worktree `ls .agents` → 仅 `agents/fshine-main/agent.md` |
| 7 | 读取失败不静默降级 | worker-skills.ts:10（「技能面坏了不静默降级」）；skills.ts:70-73（重复名 fail、坏文件忽略的既有边界） |

## 3. 两臂设计与最小 diff

### 臂 A：正文直嵌（复用 Worker 侧已验证机制，对称接到 Main）

做法：装配层把 **Main 专用** skillRoots（新配置 `mainSkillRoots`，缺省空）里的 SKILL.md 正文，按 worker 同款方式拼进 mainSystemPrompt。逐字节复用 `loadWorkerSkills`。

```diff
--- a/scripts/ask-runtime.ts
@@ :377 附近
-    const workerSkills = input.workerSkills ?? await loadWorkerSkills(input.profile.root, input.profile.skillRoots);
+    const workerSkills = input.workerSkills ?? await loadWorkerSkills(input.profile.root, input.profile.skillRoots);
+    const mainSkills = await loadWorkerSkills(input.profile.root, input.profile.mainSkillRoots ?? []);
     let mainSystemPrompt = input.mainSystemPrompt;
     if (mainSystemPrompt === undefined) {
       const profileMd = await loadAgentProfile();
-      mainSystemPrompt = `${applyExecutorLabel(profileMd.instructions, input.profile.executorLabel)}\n\n${MAIN_PROTOCOL_NOTE}`;
+      mainSystemPrompt = `${applyExecutorLabel(profileMd.instructions, input.profile.executorLabel)}`
+        + (mainSkills.length === 0 ? '' : `\n\n${mainSkills.map((s) => `【技能：${s.name}】\n${s.content}`).join('\n\n')}`)
+        + `\n\n${MAIN_PROTOCOL_NOTE}`;
```
说明：`loadWorkerSkills` 与空数组——循环零次、返回 []，零技能时提示逐字节不变（金样锚点）。apps/server/server.ts:98-100 同款三行。类型面给 loadWorkerSkills 起别名 `loadSkills` 或直接复用（其签名本就 root+skillRoots，无 Worker 专用语义）。配置键 `mainSkillRoots` 加进 profile 类型与 config 校验（缺省 `[]`）。

- 装配点：ask-runtime.ts:375-381、server.ts:98-100，共两处（P0 装配同源纪律）。
- 可观测性：机械证据行（ask.ts:248 `===== 机械证据 =====` 之后）追加一行 `main_skills: <name>[,<name>]`（装配期事实，非模型行为）；不进提示词、不进对话历史。Shadow/eval 侧读取同款装配（scripts/shadow/double-source-harness.ts 同源装配点）自动带上。

### 臂 B：目录 + 按需读取（接线 skills.ts 既有库代码到 Main 工具面）

做法：Main 工具面加 `read_skill`（skills.ts:11 已有工具名），系统提示只拼技能**摘要清单**（SkillSummary：name+description，skills.ts:48-51），模型按需读正文。

```diff
--- a/packages/agent/src/execution-runtime.ts
@@ RuntimeOptions
+  /** Main 技能登记表（发现结果：name+description+可读正文）；不传则无 read_skill 工具。 */
+  mainSkillRegistry?: SkillRegistry;
@@ send()
-        tools: [runTaskTool()],
+        tools: [runTaskTool(), ...(options.mainSkillRegistry === undefined ? [] : [readSkillTool()])],
@@ exec 分派
+          else if (tool === READ_SKILL_TOOL) {
+            const skill = await options.mainSkillRegistry!.read(String((args as {name?:unknown}).name ?? ''));
+            return { name: skill.name, content: skill.content }; // 32KiB 上限由 registry.read 既有钳制（skills.ts:36）
+          }
@@ 摘要清单注入——复用 skills.ts 既有渲染（不另写格式）
+  const summaries = await listSkills(path.join(profile.root, rel));   // skills.ts:146，name+description
+  const catalog = renderSkillCatalog(summaries);                      // skills.ts:158：空表→空串（零技能不增长提示）
+  // mainSystemPrompt 追加 `${catalog}`（非空时）；renderSkillCatalog 自带 READ_SKILL_TOOL 提示语
```
说明：摘要清单**复用既有 `listSkills`（skills.ts:146）+ `renderSkillCatalog`（skills.ts:158）**——后者正是为宿主渲染设计的「names + descriptions only, never bodies」块（含「需要时用 read_skill 按名称读取正文」提示语与空表返回空串的零增长保证），二者当前无生产消费者（仅 skills.test.ts 引用），本臂即其接线点，不自造格式。read 的名字校验、路径逃逸防护（name 只作登记表内查找，非文件系统拼接——FileSkillRegistry.read 按 discovered metadata 匹配）与 32KiB 钳制全部是 skills.ts 既有行为，diff 零新增边界逻辑。装配点同臂 A 两处 + registry 构造 `createSkillRegistry({ rootDir: path.join(profile.root, rel) })`（worker-skills.ts:17 先例）。

`read_skill` 工具的 inputSchema 基线只有常量名（skills.ts:11）无 schema，需随工具声明新增（与 RUN_TASK_TOOL_SCHEMA 同款式）：

```ts
const READ_SKILL_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string', description: '技能清单里的技能名。' } },
  required: ['name'],
  additionalProperties: false,
};
```

- 可观测性：`read_skill` 每次调用本就走 Main 回合 onStep（progress 数组，execution-runtime.ts:428），证据=回合机械证据里的工具调用行天然带出读取计数与技能名；另在 ask 证据行加 `skill_reads: <n>`（从 progress 过滤 READ_SKILL_TOOL 计数，纯机械）。

### 两臂共同的实验设计

- 同一批业务技能、同一 eval 集（`npm run eval:user`，用户级黑盒，全样本保留）分臂跑；判据：完成率、无谓追问、口径错误率、token/耗时。
- **历史证据**（decision-log §八）：正文直嵌有初步正向；目录+按需读取 0/39（39 样本零读取）。
- **样本局限声明**：§八的直嵌「初步正向」样本量小、任务分布未分层；0/39 只证明「当轮任务不需要技能正文时模型不读」这一弱命题，不能证明「需要时也不会读」——摘要质量、任务-技能相关度都是未控变量。故两臂都实施为可切换（配置键选臂），不拍死。

## 4. 边界安全分析

- **越权**：read_skill 的 name 只在 discovered 登记表内匹配（skills.ts:76-73 注释：坏文件忽略、重名 fail），不存在按名字拼路径的逃逸面；正文上限 32KiB（:36 注释给出了窗口占用论证）。臂 A 无模型可动面（纯装配期拼接）。
- **重放/资源**：read_skill 幂等只读；重复读只耗 token，32KiB×技能数封顶提示注入上限。臂 A 的正文常驻每回合 token 成本是**主要资源代价**，由实验臂直接计量。
- **失败面**：技能目录读不到 → loadWorkerSkills 上抛启动失败（worker-skills.ts:10 先例，臂 A 同款 fail-fast）；臂 B discover 为空 → 摘要清单为空、read_skill 仍可上（读不存在名 → registry 报错 → 模型收错误原文）。
- **不改动的边界**：Worker 技能链路（skillRoots）零变化；`.agents/skills`（Main 协作技能根，skills.ts:25）与执行层技能根是「不同事实源，不得合并」（skills.ts:19-21 原注释），两臂均不合并。

## 5. 回归测试清单（含反向绊线）

1. `mainSkillRoots=[]`（缺省）：mainSystemPrompt 与现行逐字节相同——**金样绊线**（快照断言，防缺省漂移）。
2. 臂 A：配置后提示含 `【技能：name】` 与正文；技能目录缺失 → 装配抛错（不静默）。
3. 臂 B：`read_skill` 返回正文与 32KiB 钳制（超限截断/报错按 skills.ts 现行测试语义）；未传 registry → 工具不在面、调用抛 `Main 工具面之外的调用`——**面收窄绊线**。
4. 臂 B 摘要清单只含 name/description，不含 path/正文——**泄露绊线**（断言提示里无绝对路径）。
5. 证据行：`main_skills`/`skill_reads` 出现在机械证据、不进对话历史。
6. 反向绊线：把臂 B 的 read 分派改拼文件路径（故意破坏）→ 4 必须红。
7. eval：两臂 + 基线三臂对照，样本全保留登记（不筛绿）；判据与局限按 §3 实验设计写入 eval 报告。

---
未实施；两臂 diff 均为文本形式，实施前需按 owner 再裁决选臂或并行实验。
