# F6 基线重定 · 前置条件核查报告（2026-11-07，第二版）

> **结论（第四版）：探针路径的前置是「本地检出落后 origin/main 10 个 commit」——一次 pull 即解（owner 无需决策）；解后按保守协议试跑，预期 ③（跨仓 seed 改名）打红查询类用例。**
> 口径：e2e 与生产探针两条路径的 env 契约分开陈述；执行层状态全部固定到 SHA；不拿 e2e 的兼容能力当探针就绪的证据。
> 第一版据「env 族未对齐」判定阻塞；复核 D-181 全文与建线时间后确认：**env 族兼容早已补齐且实测未解除阻塞**（126887b），首阻塞点是 `profile.gateway` 未穿透（本仓可修，与 D-192 同族）；另有旧基线执行环境**不可考**（建线时间早于所有现存配置/夹具）与跨仓 seed 改名失配（D-154）两项。逐项见下。

---

## 0.1 旧基线的执行环境：类别可证、模型未记录（第一版「整体不可考」已撤回）

第一版据「现行 `scripts/eval/eval.agent.yaml` 指向 stock 夹具」断言旧基线（2026-10-16）使用 stock 夹具——**该推断不成立**，材料时间线全部晚于建线日：

| 材料 | 引入时间（git log --diff-filter=A） | 与基线（2026-10-16）的关系 |
|---|---|---|
| `scripts/eval/eval.agent.yaml` | 2026-11-07（b1ee457） | 晚 22 天 |
| `scripts/eval/fixtures/stock-platform` | 2026-11-04（0f4cfc1） | 晚 19 天 |
| `scripts/eval/.env.example`（第一版引用） | HEAD 不存在该文件 | 无此材料 |

**结论（第二版复核后收紧）**：旧基线的**执行层类别可从建线提交证实**——6074dd5（score.ts + 基线 + eval 入口）、9f06985（标定批 v2）、7b782cb（基线 v3，8/8 全绿）三连提交里，7b782cb 的 `probe-real-agent.ts` 文件头明确写着「真实 LLM + 真实执行层计划门禁 + mock 执行器」；D-060 另记三轮实测与日志位置。**未记录的是具体模型 ID、judge 模型与部署配置**——即可比性是「同执行层类别、同 mock 执行器、模型未知」，不是整体不可考。保守协议因此仍可执行，但「漂移在 cap 内」的结论要按「模型未知」折价读。

---

## 0.2 执行层检出（有效，维持）

| 检查项 | 命令 | 输出 | 结论 |
|---|---|---|---|
| agent.yaml 存在 | `ls -la <主仓>/config/agent.yaml` | `-rw-r--r-- 1 … 2645 Oct 14 15:43 …` | ✅ 存在 |
| 执行层 root 可达 | `ls -la <执行层仓检出>` | `total 940 … 36 项`（含 src/、bin/、.git 等） | ✅ 检出存在 |

agent.yaml 指向 `<执行层仓检出>`（`config/agent.yaml:24`）。

---

## 0.3 env 族核查（事实维持，结论改写）

### 3.1 fshine harness 侧

harness 写/读 `EXECUTION_*`（platform-mock.ts:25 / runtime-mode.ts:25 / context.ts:558 / assembly.ts:209）。
**两条路径的 env 契约不同，不能混用**（第三版据此被 review 抓住）：
- **e2e 脚本化路径**（`tests/e2e/harness.ts`）：126887b 起双套名兼容（`DZ_*` 也认）；
- **生产探针/验收路径**（`createServerAssembly` + `pi-coding-driver`）：**只注入 `EXECUTION_*`**——126887b 只改了 e2e harness 与文档，没动 assembly/context/probe。基线重定走的是后者。

### 3.2 执行层检出：固定 SHA 后的实际状态（第三版补）

| 引用 | SHA | env 族 | 与探针路径（EXECUTION_*）的关系 |
|---|---|---|---|
| 本地检出 HEAD | `b3870e9` | **DZ_***（`src/lib/dz-env.js` 存在） | ❌ 不匹配 |
| 兄弟仓 origin/main | `de41ae3`（merge PR#3 接口层改动） | **EXECUTION_***（`dz-env.js` 已不在 `src/lib/`） | ✅ 匹配 |

本地检出**落后 origin/main 10 个 commit**（`rev-list --count b3870e9..origin/main` = 10）。D-194② 早已记录「平台 origin/main 已改回 EXECUTION_*」——即不匹配的根源是**本地检出旧**，不是平台主线旧。

### 3.2b 执行层 main 分支（上述两个 SHA 各自的状态）

main 只认 `DZ_*`（dz-env.js:49/59/74/84、real-execution.js:52；文件头声明 FSHINE_* 回退已删除）。

### 3.3 执行层 a2a-structured-call 分支

已对齐 `EXECUTION_*`（gateway.js），含 DZ_*→EXECUTION_* 重命名提交 dab58b4；**未合入 main**（仅 a2a-structured-call 与 w4-budget-protocol 含该提交）。

### 3.4 关键相反证据（第一版漏载，已补）

D-181（debt-ledger.md:1755-1762）的**完整记录**而非其早期段落：

- **双套 env 兼容已补且实测未解除阻塞**：「126887b 补双套 env 后，write-chain 首阻塞点仍为 profile.gateway 未声明」——即 env 族对齐**不是**当前首阻塞点，把它当解锁条件是无效路径。
- **首阻塞点**：`parseProposalCommand('bin/<gateway> prepare voucher.proposal tmp/req_1/proposal.json', protocols)` 两参形态 → `resolveGatewayText(undefined)`（platform-contract.ts:52）——**harness 侧一行可修**（补 gateway 入参），与 D-192（mock-commit-smoke.ts:86 单参 loadOperationProtocols）同族。
- 状态行原文：「env 兼容已补但未解阻塞，profile.gateway 为首阻塞点，不堵 W5 放行」。

---

## 0.4 判定：阻塞，阻塞点逐项列

| # | 阻塞项 | 性质 | 证据 |
|---|---|---|---|
| ① | 旧基线执行环境不可考 | 方法论 | 0.1 节时间线；缺建线当次运行记录 |
| ② | `profile.gateway` 未穿透 | **本仓可修，但范围仅限 e2e 脚本化写链** | D-181 首阻塞点；两参调用在 `tests/e2e/harness.ts`，生产路径 `pi-coding-driver.ts:1720` 三参已带 gateway——**探针/验收走 createServerAssembly + pi driver，不经该故障**（第二版据调用链核实） |
| ③ | 跨仓 seed 改名失配 | 跨仓，需 owner 协调 | D-154：fshine 侧夹具已按映射表改名，兄弟仓 seed 未同批 |
| — | env 族对齐 | **本地操作可解，非 owner 决策** | origin/main（de41ae3）已回 EXECUTION_*、与探针路径匹配；本地检出（b3870e9）落后 10 commit 且带 dz-env.js——pull 一下即对齐 |
| ④ | e2e 路径的 env 兼容不能推广到探针 | 已界定 | 126887b 只改 `tests/e2e/harness.ts` 与文档；assembly/context/probe 仍只注入 EXECUTION_*——不得拿 e2e 的兼容当探针就绪的证据 |

**①不补，「与旧基线逐条比对」的可比性要按「模型未知」折价**（执行层类别已知，见 0.1）；**②不阻塞探针跑分**（调用链见上），它阻塞的是 e2e 脚本化写链——属 D-181 自己的范围，修它值得，但不是基线重定的前置；**③会直接打红查询类用例**（探针按改名后夹具提问，兄弟仓 seed 仍是旧名，返回数据对不上）。

---

## 解锁路径（按代价排序，需 owner 拍板）

1. **可以直接试跑（推荐先做）**：探针路径不经 ② 的故障（调用链已核实），前置基本就绪。按保守协议跑齐语料 + 逐条比对，**预期 ③ 会打红查询类用例**——若失败集中在 ③ 相关用例、其余条目漂移在 cap 内，结论就是「基线重定卡 D-154，不卡模型」，比空等更有信息量。
2. **② 照修但不当前置**（本仓一行，与 D-192 同族）：修的是 e2e 脚本化写链（D-181 范围），修完 write-chain 的红才能继续往「跨仓配对全绿」走。
3. **① 的披露**：跑分报告里注明「旧基线模型未记录，比对按同执行层类别折价」；若要严格可比，找回建线当次的模型 ID（D-060 的实测日志位置）或接受重新建线（须 owner 显式批准并登记）。
4. **③ 跨仓协调**：兄弟仓 seed 按同一张映射表同步改名（D-154 原闭环判据）。
5. **先把本地检出对齐 origin/main**（本地 git 操作，非 owner 决策）：`git -C <执行层仓检出> fetch origin && git checkout origin/main`（或 merge）——对齐后探针路径的 env 族即匹配（de41ae3 已是 EXECUTION_*）。执行前先 `git status` 确认无未推送改动。
6. **a2a-structured-call 合流降级为可选项**：结构化调用协议的干净解，与基线重定不是同一条前置。

---

*本报告由前置条件核查生成：未执行 npm ci、未跑 eval、未消耗 judge 模型时间。第四版修订：固定执行层双 SHA（本地 b3870e9 = DZ_* / origin/main de41ae3 = EXECUTION_*）、把 e2e 与探针的 env 契约分开、env 阻塞改判为「本地 pull 可解」。*
