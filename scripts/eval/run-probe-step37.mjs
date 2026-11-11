#!/usr/bin/env node
/**
 * 探针环境 runner（被测模型固定 step-3.7-flash）。
 *
 * world.run 不做 shell 环境准备，所以由本脚本读 key 文件、拼好探针要求的进程环境，
 * 再 spawn 目标 worktree 里的 scripts/probe-real-agent.ts。**不打印、不落盘 key**：
 * key 只出现在子进程的 env 里；本脚本自己的日志只写命令与路径。
 *
 * 用法：
 *   node scripts/eval/run-probe-step37.mjs --root <worktree> [--only A1,B2] [--out <dir>]
 *
 * 环境（写死，别处不重复）：
 *   LLM_API_BASE_URL=https://api.stepfun.com/step_plan/v1
 *   LLM_MODEL=step-3.7-flash
 *   LLM_API_KEY 从 --key-file（或 LLM_CI_KEY_FILE 环境变量）读入进程环境；
 *     两者都没给而调用方已设 LLM_API_KEY 时，直接用继承值
 *   EXECUTION_EXECUTOR=mock；删除继承的 AGENT_CONFIG_PATH / LLM_THINKING_LEVEL
 *   WECOM_BOT_ID / WECOM_BOT_SECRET 从主仓 .env 取（探针的假 SDK 用不到，按纪律带上）
 *   TMPDIR 不覆盖——继承调用方环境（本机跑 npm/vitest 需要的临时目录由调用方 export）
 *
 * 观测钩子（默认开）：把探针 per-case 子进程的 stateDir 复制到 <out>/state/ 再删。
 * 这些 state 里有 plans.json（计划声明）、audit.jsonl（执行审计）、agent-*.db
 * （宿主 tool_calls / plan_confirmation_resolutions），是 T5/T6 机械判据的权威证据源。
 * 钩子只复制不阻止删除，不影响探针行为；只挂在 NODE_OPTIONS=--require 上。
 *
 * 输出：<out>/probe.log（stdout+stderr 原样）、<out>/state/*。退出码 = 探针退出码。
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_REPO = path.resolve(HERE, '../..');

function argValue(flag, argv = process.argv.slice(2)) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

const root = argValue('--root');
if (!root) {
  console.error('用法: node scripts/eval/run-probe-step37.mjs --root <worktree> [--only C1,C2,A2,D2] [--out <dir>]');
  process.exit(2);
}
const only = argValue('--only') ?? 'C1,C2,A2,D2';
// 被测模型缺省写死 step-3.7-flash；--model 只给「强模型归因复跑」用，结果单独报、不并入弱模型结论。
const model = argValue('--model') ?? 'step-3.7-flash';
const keyFile = argValue('--key-file') ?? process.env.LLM_CI_KEY_FILE;
const envFile = argValue('--env-file') ?? path.join(MAIN_REPO, '.env');
const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const outDir = path.resolve(argValue('--out') ?? path.join(MAIN_REPO, 'out', 'probe-step37', `${runId}-${path.basename(root)}`));

if (!process.argv.includes('--no-preserve')) mkdirSync(path.join(outDir, 'state'), { recursive: true });

// ── key：只进进程环境 ─────────────────────────────────────────────────────────
// 优先级：--key-file / LLM_CI_KEY_FILE 指定的文件 > 调用方已设的 LLM_API_KEY。
// 三者都没有就退出——不猜路径、不内置任何本机地址。
let apiKey;
if (keyFile) {
  try {
    apiKey = readFileSync(keyFile, 'utf8').trim();
  } catch (error) {
    console.error(`LLM key 文件读不到（${keyFile}）：${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  if (!apiKey) {
    console.error('LLM key 文件为空');
    process.exit(2);
  }
} else {
  apiKey = process.env.LLM_API_KEY?.trim() ?? '';
  if (!apiKey) {
    console.error('没有 key：传 --key-file <路径>、设 LLM_CI_KEY_FILE，或先在环境里设 LLM_API_KEY');
    process.exit(2);
  }
}

// ── WECOM 凭据：从主仓 .env 取，不进日志 ─────────────────────────────────────
const envFileVars = {};
try {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^\s*(WECOM_BOT_ID|WECOM_BOT_SECRET)\s*=\s*(.*)\s*$/.exec(line);
    if (match) envFileVars[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
} catch (error) {
  console.warn(`.env 读取失败（${envFile}）：${error instanceof Error ? error.message : String(error)}（继续，缺失项为空）`);
}

const childEnv = {
  ...process.env,
  LLM_API_BASE_URL: 'https://api.stepfun.com/step_plan/v1',
  LLM_API_KEY: apiKey,
  LLM_MODEL: model,
  EXECUTION_EXECUTOR: 'mock',
  WECOM_BOT_ID: envFileVars.WECOM_BOT_ID ?? process.env.WECOM_BOT_ID ?? '',
  WECOM_BOT_SECRET: envFileVars.WECOM_BOT_SECRET ?? process.env.WECOM_BOT_SECRET ?? '',
};
delete childEnv.AGENT_CONFIG_PATH;
delete childEnv.LLM_THINKING_LEVEL;

if (!process.argv.includes('--no-preserve')) {
  const hookPath = path.join(outDir, 'preserve-state.cjs');
  writeFileSync(hookPath, `'use strict';
// 评测观测钩子：探针 per-case 子进程删 stateDir 前先整目录复制到 preserve root。
// 只复制，不阻止删除；不改探针任何判定。由 runner 生成，不是被测仓的代码。
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FSHINE_EVAL_PRESERVE_ROOT;
if (root) {
  try { fs.mkdirSync(root, { recursive: true }); } catch {}
  const original = fs.rmSync;
  fs.rmSync = function rmSync(target, options) {
    try {
      const value = typeof target === 'string' ? target : String(target);
      if (value && path.basename(value).startsWith('fshine-probe-case-') && fs.existsSync(value)) {
        const dest = path.join(root, path.basename(value) + '-' + process.pid);
        fs.cpSync(value, dest, { recursive: true, force: true });
      }
    } catch (error) {
      try { process.stderr.write('[probe-state-preserve] ' + (error && error.message ? error.message : String(error)) + '\\n'); } catch {}
    }
    return original.call(fs, target, options);
  };
  if (typeof fs.SyncBuiltinESMExports === 'function') fs.SyncBuiltinESMExports();
}
`, 'utf8');
  childEnv.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --require ${hookPath}`.trim();
  childEnv.FSHINE_EVAL_PRESERVE_ROOT = path.join(outDir, 'state');
}

// ── spawn 探针（cwd = 目标 worktree） ────────────────────────────────────────
mkdirSync(outDir, { recursive: true });
const logPath = path.join(outDir, 'probe.log');
const log = createWriteStream(logPath, { flags: 'a' });
const args = ['--import', 'tsx', 'scripts/probe-real-agent.ts', '--only', only];
console.log(`[runner] root=${root}`);
console.log(`[runner] out=${outDir}`);
console.log(`[runner] only=${only} model=${model} executor=mock`);
console.log(`[runner] log=${logPath}`);

const child = spawn(process.execPath, args, { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (chunk) => { log.write(chunk); process.stdout.write(chunk); });
// stderr 同时进日志与父进程 stderr，便于监控立即看到限流信号
child.stderr.on('data', (chunk) => { log.write(chunk); process.stderr.write(chunk); });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  log.end();
  console.log(`[runner] probe exit code=${code} signal=${signal ?? ''}`);
  process.exit(code ?? 1);
});
