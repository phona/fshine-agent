import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'

const workflow = fs.readFileSync('.github/workflows/grok-pr-review.yml', 'utf8')

test('workflow is a same-repo Grok OAuth review on ubuntu-latest', () => {
  assert.match(workflow, /runs-on: ubuntu-latest/)
  assert.doesNotMatch(workflow, /self-hosted/)
  assert.match(workflow, /contents: read/)
  assert.match(workflow, /pull-requests: write/)
  assert.match(workflow, /fetch-depth: 0/)
  assert.match(workflow, /types: \[opened, synchronize, reopened\]/)
  assert.match(workflow, /branches: \[main\]/)
  assert.match(workflow, /grok-pr-review:/)
  assert.match(workflow, /chmod 700 "\$GROK_HOME"/)
  assert.match(workflow, /chmod 600 "\$GROK_HOME\/auth\.json"/)
  assert.equal(workflow.split('secrets.GROK_AUTH_JSON').length - 1, 1)
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|CODEX_API_KEY|XAI_API_KEY/)
  assert.doesNotMatch(workflow, /--approve|event: APPROVE|APPROVE'/)
})

test('secret use is guarded by the same-repo condition', () => {
  const secretAt = workflow.indexOf('secrets.GROK_AUTH_JSON')
  assert.ok(secretAt > 0)
  const stepStart = workflow.lastIndexOf('\n      - name:', secretAt)
  const next = workflow.indexOf('\n      - name:', secretAt)
  const step = workflow.slice(stepStart, next === -1 ? workflow.length : next)
  assert.match(step, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/)
  assert.match(step, /success\(\)/)
  assert.match(workflow, /HEAD_REPO" != "\$THIS_REPO"/)
  assert.match(workflow, /unset GROK_AUTH_JSON/)
  assert.match(workflow, /unset GITHUB_TOKEN GH_TOKEN/)
})

test('GROK_MODEL and GROK_EFFORT are optional and use the canonical flags', () => {
  assert.match(workflow, /GROK_MODEL: \$\{\{ vars\.GROK_MODEL \}\}/)
  assert.match(workflow, /GROK_EFFORT: \$\{\{ vars\.GROK_EFFORT \}\}/)
  assert.match(workflow, /if \[ -n "\$\{GROK_MODEL:-}" \]; then\s+cmd\+=\(-m "\$GROK_MODEL"\)/)
  assert.match(workflow, /if \[ -n "\$\{GROK_EFFORT:-}" \]; then/)
  assert.match(workflow, /cmd\+=\(--reasoning-effort "\$GROK_EFFORT"\)/)
  assert.doesNotMatch(workflow, /--effort\b/)
})

test('GROK_REVIEW_ISSUES is mapped from repository variables and split on commas', () => {
  // 仓库变量不会自动成为 shell 环境变量；不映射，覆盖分支就是死的。
  assert.match(workflow, /GROK_REVIEW_ISSUES: \$\{\{ vars\.GROK_REVIEW_ISSUES \}\}/)
  const overrideStart = workflow.indexOf('if [ -n "${GROK_REVIEW_ISSUES:-}" ]')
  assert.ok(overrideStart > 0)
  const overrideBranch = workflow.slice(overrideStart, workflow.indexOf('else', overrideStart))

  // **断言行为，不断言实现**：实测踩过——第一个版本钉了 `tr ',' ' '`，而另一条
  // 等价修法用 `grep -oE '[0-9]+'`，两条行为相同却互相打红。契约要的是
  // 「逗号/空白混写的列表被拆成逐项编号」，不是某一种写法。
  // 做法：把分支里的 shell 片段抽出来，用假输入真跑一遍。
  const refsLine = /refs=\$\((.*)\)\s*$/.exec(overrideBranch)
  assert.ok(refsLine, '覆盖分支里应有一行 refs=$(...)')
  const pipeline = refsLine[1].replace(/"\$\{GROK_REVIEW_ISSUES\}"/g, '"98, 99"')
  const out = execFileSync('bash', ['-c', pipeline], { encoding: 'utf8' })
  const numbers = out.trim().split(/\s+/).filter(Boolean)
  assert.deepEqual(numbers, ['98', '99'], '「98, 99」必须拆成两个编号，而不是一个')

  // 纯逗号、纯空白两种写法都要成立（覆盖入口的两种合法输入）。
  for (const input of ['98,99', '98 99', '98, 99']) {
    const p = refsLine[1].replace(/"\$\{GROK_REVIEW_ISSUES\}"/g, `"${input}"`)
    const o = execFileSync('bash', ['-c', p], { encoding: 'utf8' })
    assert.deepEqual(o.trim().split(/\s+/).filter(Boolean), ['98', '99'], `输入 ${input} 应拆成两个编号`)
  }
})

// 自动提取分支：从 workflow 里把 `else ... fi` 片段抽出来，用假 PR_BODY 真跑。
// **断言行为，不断言实现**——只要求「跑完分支后 refs 里是完整编号列表」，
// 不管它用 grep 正则、sed 后处理还是别的等价写法。Codex 74f476ba / 66cedd 报的
// 正是行为：#98/#99 只解析出 98。
function fetchIssueRefsBranch() {
  const overrideIf = workflow.indexOf('if [ -n "${GROK_REVIEW_ISSUES:-}" ]')
  assert.ok(overrideIf > 0, 'workflow 应有 GROK_REVIEW_ISSUES 覆盖分支')
  const elseAt = workflow.indexOf('\n          else\n', overrideIf)
  assert.ok(elseAt > 0, '覆盖分支应有 else 自动提取分支')
  const fiAt = workflow.indexOf('\n          fi\n', elseAt)
  assert.ok(fiAt > 0, '覆盖分支应有结束 fi')
  return workflow.slice(elseAt, fiAt).replace(/^\n\s*else\s*\n/, '')
}

function parseIssueRefs(body) {
  // 片段在 workflow 里跑在 `set -euo pipefail` 之下；测试必须同口径，
  // 否则「grep 无匹配 + pipefail」这类真实失败会被测试放过。
  const script = `set -euo pipefail\n${fetchIssueRefsBranch()}\nprintf '%s\\n' "\${refs:-}"\n`
  return execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PR_BODY: body },
  }).trim()
}

function refsOf(body) {
  return parseIssueRefs(body).split(/\s+/).filter(Boolean)
}

test('linked issue list in the PR body keeps every number', () => {
  const cases = [
    // 三种分隔写法（issue #98/#99 曾只拿到 98）。
    ['Fixes issues #98/#99.', ['98', '99']],
    ['Fixes issues #98, #99.', ['98', '99']],
    ['Fixes issues #98 #99.', ['98', '99']],
    // 同族变体：斜杠或逗号后不带 #、逗号后空格。
    ['Fixes issues #98/99.', ['98', '99']],
    ['Fixes issues #98,99.', ['98', '99']],
    // 单数、重复出现、GitHub URL 仍照旧。
    ['Fixes issue #98.', ['98']],
    ['Fixes issue #98 and issue #99.', ['98', '99']],
    ['Fixes https://github.com/acme/repo/issues/98.', ['98']],
    ['issues #98/#99, #98', ['98', '99']],
    // URL 与短语形态同时出现时合并、去重。
    ['https://github.com/team2/design3/issues/98 and issues #99', ['98', '99']],
    // URL 后的锚点/子路径不影响取号。
    ['https://github.com/team2/design3/issues/98#issuecomment-1', ['98']],
  ]
  for (const [body, expected] of cases) {
    assert.deepEqual(refsOf(body), expected, `PR 正文 ${JSON.stringify(body)} 应解析出完整编号列表`)
  }
})

test('bare # numbers in the PR body are still ignored', () => {
  // 保护：早期用裸 # 匹配，一次抓到 34 个历史 PR / 条目号把 prompt 撑爆。
  assert.deepEqual(refsOf('阶段表 PR #34、#12；pending-site-data 条目 #7。见 #98, #99'), [])
  // "issue #98" 后面跟一个不带 # 的日期，年份不能被续接逻辑当成编号。
  assert.deepEqual(refsOf('issue #98，2026-11-09 业主裁定'), ['98'])
})

test('issue URL yields only the number after /issues/', () => {
  // Codex 5088dc1b minor：旧实现先整段匹配 URL，再统一 grep -oE '[0-9]+'，
  // 组织名/仓库名里的数字也被当成编号——team2/design3/issues/98 得到 2、3、98，
  // 随后会去读当前仓库的 #2、#3。
  const cases = [
    ['https://github.com/team2/design3/issues/98', ['98']],
    ['https://github.com/r2d2/repo7/issues/5', ['5']],
    // 多个带数字的仓库地址各自只取 issue 号，并按数值排序。
    [
      'https://github.com/team2/design3/issues/98 and https://github.com/r2d2/repo7/issues/5',
      ['5', '98'],
    ],
    // 带数字的仓库、但不是 /issues/ 路径：不产号。
    ['https://github.com/team2/design3/pull/122', []],
  ]
  for (const [body, expected] of cases) {
    assert.deepEqual(refsOf(body), expected, `PR 正文 ${JSON.stringify(body)} 只应取 /issues/ 后的编号`)
  }
})

test('linked issue extraction keeps the five-number cap', () => {
  assert.deepEqual(refsOf('issues #1/#2/#3/#4/#5/#6/#7'), ['1', '2', '3', '4', '5'])
  // URL 里组织/仓库的数字不得挤占上限：旧实现这里会得到 2、3、90、91、92。
  assert.deepEqual(
    refsOf('issues #90/#91/#92/#93/#94 and https://github.com/team2/design3/issues/98'),
    ['90', '91', '92', '93', '94'],
  )
})
