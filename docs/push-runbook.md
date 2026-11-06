# Push Runbook · 公开到 GitHub

> 落地状态（2026-11-07）：**私有仓已建并推 main**（https://github.com/phona/fshine-agent，private），
> Actions 首轮红（fetch-depth 浅克隆，已修，2c40687）后第二轮 success；fresh clone 复证
> K1/K3/K4/K5/K6 全过。**公开翻转未执行**——待 owner 第二声点头（路径 A 第 4 步）。
> 本文件此后作为公开推送与回滚的操作记录。

---

## 前置条件

- 波次 5 全部门禁绿：`npm run ci` 退出码 0 + `npx vitest run packages/agent/migration-gate.test.ts` 全绿 + 门①零命中（`NEEDLE='1''7dz'; git grep -il "$NEEDLE" | grep -v -E '^(docs/debt-ledger.md|docs/change-safety.md|AGENTS.md)$' | wc -l` = 0）。
- `gh` CLI 已登录且对目标账号有 `repo` 写权限。
- 本仓已 force-push 干净历史到 gitee（D-158 已登记，gitee 保留陈旧 PR ref）。

---

## 路径 A：先私有后公开（推荐）

适用场景：想先跑一轮私有 CI 验证 runners 与云备份，再切公开。

> **远端命名（2026-11-07 私有仓落地实测）**：本仓 `origin` = gitee（`git@gitee.com:phona/fshine-agent.git`），
> GitHub 侧另起 remote 名 `github`（`https://github.com/phona/fshine-agent.git`）。
> **clean 线是 `migration/public-release`，不是本地 `main`**——本地 `main`（179ffe0）是 gitee 老线，
> 与 clean 线分叉；`git push github main` 会被 non-fast-forward 拒（实测差点推错，已拒）。
> 推 GitHub 一律显式 refspec：`git push github migration/public-release:main`。

```bash
# 1. 在 GitHub 创建私有仓（不改远端，只建目标仓）
gh repo create fshine-agent --private --description "可复用的编排与控制层：身份/会话/上下文/任务拆解/预算/通知确认/审计/进度"

# 2. 挂 remote 并推 clean 历史为 main（只推这一条线；波次分支留 gitee，不公开）
git remote add github https://github.com/<owner>/fshine-agent.git
git push github migration/public-release:main

# 3. 盯盘：确认 Actions 第一轮全绿
#    https://github.com/<owner>/fshine-agent/actions
#    预期：typecheck + unit + generic-mock 三门全绿。
#    注意 checkout 必须 fetch-depth: 0（history-hygiene 四类零命中判据要全量历史，
#    浅克隆下该守卫显式失败——2026-11-07 首轮 CI 踩中，见 commit 2c40687）。

# 4. 切公开
gh repo edit --visibility public

# 5. 首跑盯盘：公开库 Actions 第一轮
#    https://github.com/<owner>/fshine-agent/actions
#    预期：同私有期，三门全绿 + badge 可用。

# 6. fresh clone 复证（沙箱或另一台机器）
git clone https://github.com/<owner>/fshine-agent.git /tmp/fshine-public
cd /tmp/fshine-public
npm ci
npm run ci
# 预期：unit 基线 ≥ 105 文件 / 1725 passed + 1 skipped；CI deterministic gates: PASS。
# 2026-11-07 实测：私有仓 clone 后 K1=0 / K3=0 / K6 3/3 全绿，Actions 轮次 success。

# 7. 回滚（若公开后发现泄密或缺陷）
#    a) 立即切私有：
gh repo edit --visibility private
#    b) 从 backup bundle 恢复（假设 bundle 在 ~/fshine-agent-backup-20261105.bundle）：
git clone --mirror git@gitee.com:phona/fshine-agent.git fshine-mirror.git
cd fshine-mirror.git
git bundle verify ~/fshine-agent-backup-20261105.bundle
git reset --hard 44a84a6   # 或 bundle 里的干净锚点
#    c) force-push 回 GitHub（同样显式 refspec，别推本地 main）：
git push --force github migration/public-release:main
#    d) 视泄露严重度决定是否删除 GitHub 仓后重建：
gh repo delete <owner>/fshine-agent --confirm
```

---

## 路径 B：直接公开

适用场景：本地门禁已全绿、无需私有 CI 预跑。

```bash
# 1. 在 GitHub 创建公开仓
gh repo create fshine-agent --public --source=. --remote=origin --push

# 2. 盯盘：确认 Actions 第一轮全绿
#    https://github.com/<owner>/fshine-agent/actions

# 3. fresh clone 复证（同路径 A 第 6 步）
git clone https://github.com/<owner>/fshine-agent.git /tmp/fshine-public
cd /tmp/fshine-public
npm ci
npm run ci

# 4. 回滚（同路径 A 第 7 步）
```

---

## 复证清单（fresh clone 后必跑）

| 编号 | 命令 | 预期 |
|------|------|------|
| K1 | `NEEDLE='1''7dz'; git grep -il "$NEEDLE" \| grep -v -E '^(docs/debt-ledger.md\|docs/change-safety.md\|AGENTS.md)$' \| wc -l` | 0 |
| K2 | `git log --all -p \| grep -F "<principal-id-placeholder>" \| wc -l` | 0 |
| K3 | `git for-each-ref \| grep -E 'refs/original\|pr1-merge-tmp' \| wc -l` | 0 |
| K4 | `git bundle verify ~/fshine-agent-backup-20261105.bundle` | exit 0 |
| K5 | `npm run ci` | 退出码 0，末行 `CI deterministic gates: PASS` |
| K6 | `npx vitest run packages/agent/migration-gate.test.ts` | 3/3 全绿 |

---

## 已知限制

- gitee 私有仓保留未重写历史（D-158 已登记，26 个 refs/pull/* 残留）。
- 回滚会丢失公开后收到的 star / issue / PR（路径 A 切私有可保留）。
- `~/fshine-agent-backup-20261105.bundle` 须在 push 前准备好（波次 2 产物；2026-11-07 实测 verify exit 0）。
- GitHub 侧只推 `migration/public-release:main` 一条线；波次分支（w5-tail / facade / sweep / wave5-prep 等）留在 gitee——它们的树含中性化前的 17dz 引用，不公开。
- 本地 `main`（179ffe0，gitee 老线）与 clean 线分叉，任何 push/force-push 都必须显式写 refspec。
