# Grok PR 审查

`.github/workflows/grok-pr-review.yml` 在指向 `main` 的 pull request 上用 Grok Build CLI（可执行文件 `grok`）做只读审查。机制与提示词自 bontop-design-log 整机移植（2026-11-21；两仓都因 Codex 订阅到期弃用 Codex 路径）。身份是浏览器 OAuth 登录得到的 `auth.json`，放在 Actions secret `GROK_AUTH_JSON` 里。这里不走 API key，走登录账号的 SuperGrok / X Premium+ 订阅。

审查结果发到 PR review 上：有 `blocking` 时用 `REQUEST_CHANGES`，并把检查标红；否则用 `COMMENT`。没有发现项也是 `COMMENT`，**不会自动 APPROVE**。绿灯只表示审查跑完且没有 blocking。

检查名是 `Grok PR review / grok-pr-review`。本仓库不在这里改分支保护。

## 修复端政策

上一节的行为保持不变：有 `blocking` 就 `REQUEST_CHANGES` 并把检查标红，没有 `blocking` 就 `COMMENT`，不自动 `APPROVE`。不要为了少刷审查去改触发器、concurrency、失败条件或 `render-review.mjs` 的严重级别映射。

编码代理接到审查后怎么改，见 `AGENTS.md`「回应 Grok 审查的铁律」和 `.github/prompts/grok-fix.md`。只自动修 `blocking`（当作 P0/P1）。同一模块上的异步交错、竞态或过期响应不加版本计数器：要么把状态机重做一次，要么在 PR 上留言升级给人。同一主题的 `REQUEST_CHANGES` 计满 3 轮之后，该主题只由人处理。Grok 仍是探测器。

## 写入 secret

在一台能打开浏览器的可信机器上安装 CLI 并登录（登录账号须有 SuperGrok 或 X Premium+ 订阅）：

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login
```

无头机器改用 device 码（在自己浏览器里打开给出的链接确认）：

```bash
grok login --device-auth
```

登录后检查凭证形状，不要把令牌打出来：

```bash
jq -r 'to_entries[] | [.key, .value.auth_mode, ((.value.key // "") != ""), ((.value.refresh_token // "") != ""), .value.expires_at] | @tsv' ~/.grok/auth.json
```

`auth_mode` 必须是 `oidc`，key 与 refresh token 两栏必须是 `true`。secret 还没建好时，job 会在读到空值后失败，不会发审查。然后在本仓库目录执行（需要仓库 admin，JSON 走 stdin，不要贴进命令行）：

```bash
gh secret set GROK_AUTH_JSON < ~/.grok/auth.json
```

不要把 `auth.json` 提交进 git，不要贴进 issue、聊天或日志。workflow 也只打印有没有令牌，不打印令牌本身。

## OAuth 过期后怎么更新

GitHub 托管 runner 每次都是新磁盘。job 从 secret 恢复 `auth.json`，Grok 如果在 job 里刷新了令牌，新文件会随 runner 一起丢掉，**不会写回 secret**。写回需要能改 secret 的高权限令牌，而这个 workflow 跑的是 PR 头上的文件，不适合再放一把这样的钥匙。

实测：access token 有效期约 6 小时（`expires_at` = 创建时间 + 6 小时），CLI 会用 refresh token 在后台自己换。换过之后，secret 里的旧副本可能作废。出现下面任一情况就在可信机器上重新 `grok login`，再用上面的 `gh secret set` 覆盖 secret：

- 审查 job 开始返回 401，或日志写 refresh 失败
- 距离上次登录已经很久、refresh token 也换过
- 换过机器、撤销过登录，或两个 job 同时用过同一份文件

覆盖 secret 不会改已经在跑的 job。等它结束，或手动取消后重跑失败的审查。

同一份 `auth.json` 不要并行用。workflow 用 concurrency 把全仓库的审查串成一条队列，新的 push 不会取消正在跑的那次。

## 私有仓库

本仓库保持私有，按 OAuth 方式接（走订阅登录而不是 API key）。

- fork PR 在读 secret 之前就失败；GitHub 也不会把 secret 交给 fork 的 workflow。
- 能往本仓库推分支的人可以改 workflow 并把 secret 读走。写权限只给可以接触这个 Grok 账号的人。
- 不要把触发器改成 `pull_request_target`。

可选的 repository variable（Settings → Secrets and variables → Actions → Variables）。留空就不传，用 CLI 默认：

- `GROK_MODEL` 传给 `grok -m`。留空用 CLI 默认（1.0.89 实测默认是 `grok-4.6-build`）。
- `GROK_EFFORT` 传给 `grok --reasoning-effort`。留空用默认；某个模型不支持的档位会在审查启动后失败，不会静默改成别的档。
- `GROK_REVIEW_ISSUES` 显式指定关联 issue（逗号分隔），优先于从 PR 正文解析。

Grok CLI 目前钉在 `1.0.89`（bontop 2026-11-19 实测，本仓 2026-11-21 移植时一并固定）。升级时改 workflow 安装行的版本号，并重新核对 `--prompt-file` / `--json-schema` / `--permission-mode` 仍在。两个实测过的坑：`--json-schema` 吃**内联 JSON**不是文件路径，传路径会报 `invalid JSON: expected value at line 1 column 1`；`--output-format plain` 的 stdout 仍是 JSON 信封 `{ text, structuredOutput, usage, ... }`，审查对象在 `structuredOutput` 里，由 `extract-review.mjs` 抽出来。

第三个实测坑（2026-11-19 首跑，两次都撞上）：模型调用正常跑完 8 分钟，信封里却既无 `structuredOutput`，`text` 也不是 JSON——`extract-review.mjs` 直接失败，审查发不出去。修复：失败时把 `stopReason` / 轮数 / `text` 开头打印进日志（只凭「没有 structuredOutput」定位不了），workflow 对同一次审查只重试一次；两次都失败就 loud fail，不编一个假审查。

本地核对审查脚本：

```bash
node --test .github/grok/*.test.mjs
```
