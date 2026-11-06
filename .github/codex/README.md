# Codex PR 审查

`.github/workflows/codex-pr-review.yml` 在指向 `main` 的 pull request 上用 Codex CLI 做只读审查。身份是本机 `codex login` 得到的 ChatGPT OAuth `auth.json`，放在 Actions secret `CODEX_AUTH_JSON` 里。这里不走 API key。

审查结果发到 PR review 上：有 `blocking` 时用 `REQUEST_CHANGES`，并把检查标红；否则用 `COMMENT`。没有发现项也是 `COMMENT`，**不会自动 APPROVE**。绿灯只表示审查跑完且没有 blocking。

检查名是 `Codex PR review / codex-pr-review`。本仓库不在这里改分支保护。

## 修复端政策

上一节的行为保持不变：有 `blocking` 就 `REQUEST_CHANGES` 并把检查标红，没有 `blocking` 就 `COMMENT`，不自动 `APPROVE`。不要为了少刷审查去改触发器、concurrency、失败条件或 `render-review.mjs` 的严重级别映射。

编码代理接到审查后怎么改，见 `AGENTS.md`「回应 Codex 审查的铁律」和 `.github/prompts/codex-fix.md`。只自动修 `blocking`（当作 P0/P1）。同一模块上的异步交错、竞态或过期响应不加版本计数器：要么把状态机重做一次，要么在 PR 上留言升级给人。同一主题的 `REQUEST_CHANGES` 计满 3 轮之后，该主题只由人处理。Codex 仍是探测器。

## 写入 secret

在一台能打开浏览器的可信机器上：

```bash
mkdir -p ~/.codex
chmod 700 ~/.codex
```

`~/.codex/config.toml` 里要有：

```toml
cli_auth_credentials_store = "file"
```

然后登录并检查，不要把令牌打出来：

```bash
codex login

jq '{
  auth_mode,
  has_refresh_token: ((.tokens.refresh_token // "") != ""),
  last_refresh
}' ~/.codex/auth.json
```

`auth_mode` 必须是 `chatgpt`，`has_refresh_token` 必须是 `true`。secret 还没建好时，job 会在读到空值后失败，不会发审查。然后在本仓库目录执行（需要仓库 admin，JSON 走 stdin，不要贴进命令行）：

```bash
gh secret set CODEX_AUTH_JSON < ~/.codex/auth.json
```

不要把 `auth.json` 提交进 git，不要贴进 issue、聊天或日志。workflow 也只打印 `auth_mode` 和有没有 refresh token。

## OAuth 过期后怎么更新

GitHub 托管 runner 每次都是新磁盘。job 从 secret 恢复 `auth.json`，Codex 如果在 job 里刷新了令牌，新文件会随 runner 一起丢掉，**不会写回 secret**。写回需要能改 secret 的高权限令牌，而这个 workflow 跑的是 PR 头上的文件，不适合再放一把这样的钥匙。

当前开源客户端大约 8 天把会话看成过期，然后用 refresh token 换新的一组令牌。换过之后，secret 里的旧副本可能作废。出现下面任一情况就在可信机器上重新 `codex login`，再用上面的 `gh secret set` 覆盖 secret：

- 审查 job 开始返回 401，或日志写 refresh 失败
- `last_refresh` 已经接近或超过 8 天
- 换过机器、撤销过登录，或两个 job 同时用过同一份文件

覆盖 secret 不会改已经在跑的 job。等它结束，或手动取消后重跑失败的审查。

同一份 `auth.json` 不要并行用。workflow 用 concurrency 把全仓库的审查串成一条队列，新的 push 不会取消正在跑的那次。

## 公开仓库

官方不建议在公开仓库使用 ChatGPT `auth.json`。这个仓库是公开的，仍然按这个方式接，是因为审查要走 ChatGPT 登录而不是 API key。

- fork PR 在读 secret 之前就失败，GitHub 也不会把 secret 交给 fork 的 workflow。
- 能往本仓库推分支的人可以改 workflow 并把 secret 读走。写权限只给可以接触这个 ChatGPT 账号的人。
- 不要把触发器改成 `pull_request_target`。

可选的 repository variable（Settings → Secrets and variables → Actions → Variables）。留空就不传，用账号或 CLI 的默认：

- `CODEX_MODEL` 传给 `codex exec -m`。
- `CODEX_EFFORT` 传给 `codex exec -c model_reasoning_effort="<值>"`。`@openai/codex@0.166.0` 没有 `--effort`，这个参数会被 CLI 直接拒绝。这版实测接受并写进启动横幅的值是 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`。某个模型不支持的档位会在审查启动后失败，不会静默改成别的档。

Codex CLI 目前钉在 `@openai/codex@0.166.0`。升级时先看 `npm view @openai/codex version`，再改 workflow 里的安装行，并重新核对思考力度参数还是不是 `-c model_reasoning_effort`。0.166 的 `-a never` 和 `-s read-only` 要写在 `exec` 子命令前面。

本地核对审查脚本：

```bash
node --test .github/codex/*.test.mjs
```
