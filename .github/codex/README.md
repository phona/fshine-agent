# 流水线 PR 审查（grok）

`.github/workflows/pr-review.yml` 在指向 `main` 的 pull request 上做只读审查。审查器是 `.github/codex/llm-review.mjs`：读 `.github/codex/build-prompt.mjs` 产出的提示词（含 PR 上下文、diff、历史 review），调 OpenAI 兼容端点，拿到模型回答后交给 `.github/codex/render-review.mjs` 做 schema 校验与渲染。

- 目录名 `.github/codex/` 是历史遗留（2026-11-21 前用 Codex CLI）；里面的脚本与提示词是**与供应商无关**的，现在默认模型是 `grok/grok-4.7`（仓库变量 `PR_REVIEW_MODEL` 可换）。
- 审查结果发到 PR review：有 `blocking` 时 `REQUEST_CHANGES` 并把检查标红；否则 `COMMENT`。没有发现项也是 `COMMENT`，**不会自动 APPROVE**。绿灯只表示审查跑完且没有 blocking。
- 检查名是 `PR review (grok) / pr-review`。本仓库不在这里改分支保护。

## 启用（两道开关）

1. **仓库变量** `PR_REVIEW_ENABLED=true`。没设 = job 不运行，check 不出现（不会排队、不会永远红）。
2. **模型通道**，二选一：
   - **自托管 runner（局域网端点）**：默认 `runs-on` 是 `["self-hosted","fshine"]`；在能访问端点（如 `http://192.168.100.1:3425/v1`）的机器上装 GitHub self-hosted runner 并打 `fshine` 标签。安装步骤见 GitHub 文档「self-hosted runners」，本仓不代装。
   - **云端端点**：把 `PR_REVIEW_RUNNER` 设为 `["ubuntu-latest"]`，`LLM_API_BASE_URL=https://api.x.ai/v1`，secret `LLM_API_KEY=<xAI API key>`。不需要 runner。

其它变量：`PR_REVIEW_MODEL`（缺省 `grok/grok-4.7`）、`PR_REVIEW_EFFORT`（可选思考档，透传 `reasoning_effort`）。

## 密钥

`LLM_API_KEY` 只进 Actions secret，**不要**贴进对话、日志或仓库文件。写入时从文件读，避免 shell 历史留值：

```bash
# 在可信机器上把 key 写进一个 600 文件，然后用 gh 直接读文件上传；不要 echo。
gh secret set LLM_API_KEY --repo <owner>/fshine-agent < ~/.tmp/llm-key
```

job 里审查步骤先 `unset GITHUB_TOKEN GH_TOKEN` 再调模型——审查者拿不到仓库凭证；`llm-review.mjs` 从不打印 key。

## 修复端政策

上一节行为保持不变：有 `blocking` 就 `REQUEST_CHANGES` 并把检查标红，没有 `blocking` 就 `COMMENT`，不自动 `APPROVE`。不要为了少刷审查去改触发器、concurrency、失败条件或 `render-review.mjs` 的严重级别映射。

编码代理接到审查后怎么改，见 `AGENTS.md`「回应流水线审查的铁律」和 `.github/prompts/review-fix.md`。只自动修 `blocking`（当作 P0/P1）。同一模块上的异步交错、竞态或过期响应不加版本计数器：要么把状态机重做一次，要么在 PR 上留言升级给人。同一主题的 `REQUEST_CHANGES` 计满 3 轮之后，该主题只由人处理。审查者是探测器，不是裁决者。

## 自测

```bash
node --test .github/codex/*.test.mjs
```

覆盖：schema/render 契约、工作流形态（self-hosted 默认与开关、fork 拒绝、密钥隔离、永不 APPROVE）、以及 `llm-review.mjs` 的 stub 端点行为（直给 JSON / 先前言后重试 / 两次非 JSON / 4xx），并断言密钥不进输出。
