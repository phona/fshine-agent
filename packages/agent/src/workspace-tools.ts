import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ContextToolProvider } from './context';
import type { DiscoveredTool } from '@fshine/contracts';

const DEFAULT_MAX_OUTPUT = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT = 30_000;
const DEFAULT_MAX_RESULTS = 100;

/**
 * Generic tools for a trusted context worker.  The root is bound when the
 * provider is created; it is deliberately absent from every model-facing
 * schema and cannot be overridden by tool arguments.
 */
export function createWorkspaceToolProvider(
  root: string,
  options: { commandTimeoutMs?: number; maxOutputBytes?: number; maxResults?: number } = {},
): ContextToolProvider {
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const resolvedRoot = path.resolve(root);

  const tools: readonly DiscoveredTool[] = [
    {
      name: 'read_file',
      description: '读取受信工作目录中的文本文件。path 必须是相对工作目录的路径。',
      inputSchema: {
        type: 'object', required: ['path'], additionalProperties: false,
        properties: { path: { type: 'string', minLength: 1 }, maxBytes: { type: 'integer', minimum: 1, maximum: maxOutputBytes } },
      },
    },
    {
      name: 'list_files',
      description: '列出受信工作目录中的文件或目录。path 必须是相对工作目录的路径。',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string' }, recursive: { type: 'boolean' }, maxResults: { type: 'integer', minimum: 1, maximum: maxResults } },
      },
    },
    {
      name: 'search_text',
      description: '在受信工作目录中搜索文本。path 必须是相对工作目录的路径。',
      inputSchema: {
        type: 'object', required: ['query'], additionalProperties: false,
        properties: { query: { type: 'string', minLength: 1 }, path: { type: 'string' }, maxResults: { type: 'integer', minimum: 1, maximum: maxResults } },
      },
    },
    {
      name: 'run_command',
      description: '在受信工作目录中运行受控命令。命令 cwd 固定为工作目录，不能通过参数改变。',
      inputSchema: {
        type: 'object', required: ['command'], additionalProperties: false,
        properties: { command: { type: 'string', minLength: 1 }, timeoutMs: { type: 'integer', minimum: 1, maximum: commandTimeoutMs } },
      },
    },
  ];

  return {
    tools: () => tools,
    call: async (name, args, signal) => {
      switch (name) {
        case 'read_file': return readFile(resolvedRoot, args, maxOutputBytes);
        case 'list_files': return listFiles(resolvedRoot, args, maxResults);
        case 'search_text': return searchText(resolvedRoot, args, maxResults);
        case 'run_command': return runCommand(resolvedRoot, args, signal, commandTimeoutMs, maxOutputBytes);
        default: throw new Error(`工作区不支持工具:${name}`);
      }
    },
  };
}

function relativePath(args: Record<string, unknown>, key = 'path'): string {
  const value = args[key];
  if (value === undefined) return '.';
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} 必须是非空相对路径。`);
  if (path.isAbsolute(value)) throw new Error(`${key} 必须是相对工作目录的路径。`);
  return value;
}

async function safePath(root: string, relative: string, allowMissing = false): Promise<string> {
  const candidate = path.resolve(root, relative);
  if (!inside(root, candidate)) throw new Error('路径不能越出受信工作目录。');
  const real = await fs.realpath(candidate).catch(async (error: unknown) => {
    if (!allowMissing) throw error;
    const parent = await fs.realpath(path.dirname(candidate));
    if (!inside(root, parent, true)) throw new Error('路径不能越出受信工作目录。');
    return candidate;
  });
  if (!inside(root, real, true)) throw new Error('路径不能越出受信工作目录。');
  return real;
}

function inside(root: string, candidate: string, allowRoot = false): boolean {
  const relative = path.relative(root, candidate);
  return (allowRoot && relative === '') || (relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readFile(root: string, args: Record<string, unknown>, maxOutputBytes: number): Promise<unknown> {
  const target = await safePath(root, relativePath(args));
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('目标不是文件。');
  const limit = typeof args['maxBytes'] === 'number' ? Math.min(Math.max(1, args['maxBytes']), maxOutputBytes) : maxOutputBytes;
  const data = await fs.readFile(target);
  return { path: path.relative(root, target), content: data.subarray(0, limit).toString('utf8'), truncated: data.byteLength > limit, bytes: Math.min(data.byteLength, limit) };
}

async function listFiles(root: string, args: Record<string, unknown>, maxResults: number): Promise<unknown> {
  const target = await safePath(root, relativePath(args));
  const recursive = args['recursive'] === true;
  const limit = boundedNumber(args['maxResults'], maxResults);
  const entries: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entries.length >= limit) return;
      const full = path.join(dir, entry.name);
      const safe = await safePath(root, path.relative(root, full));
      entries.push(path.relative(root, safe) || '.');
      if (recursive && (await fs.stat(safe)).isDirectory()) await visit(safe);
    }
  }
  const stat = await fs.stat(target);
  if (stat.isDirectory()) await visit(target);
  else entries.push(path.relative(root, target));
  return { path: path.relative(root, target) || '.', entries, truncated: entries.length >= limit };
}

async function searchText(root: string, args: Record<string, unknown>, maxResults: number): Promise<unknown> {
  const queryValue = args['query'];
  if (typeof queryValue !== 'string' || queryValue.length === 0) throw new Error('query 必须是非空字符串。');
  const query = queryValue;
  const start = await safePath(root, relativePath(args));
  const limit = boundedNumber(args['maxResults'], maxResults);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  async function visit(target: string): Promise<void> {
    if (matches.length >= limit) return;
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(target, { withFileTypes: true })) {
        const child = await safePath(root, path.relative(root, path.join(target, entry.name)));
        await visit(child);
      }
      return;
    }
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return;
    const content = await fs.readFile(target, 'utf8').catch(() => '');
    content.split(/\r?\n/).forEach((line, index) => {
      if (matches.length < limit && line.includes(query)) matches.push({ path: path.relative(root, target), line: index + 1, text: line.slice(0, 1000) });
    });
  }
  await visit(start);
  return { query, matches, truncated: matches.length >= limit };
}

function boundedNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(Math.max(1, value), fallback) : fallback;
}

async function runCommand(root: string, args: Record<string, unknown>, signal: AbortSignal | undefined, defaultTimeout: number, maxOutputBytes: number): Promise<unknown> {
  const command = args['command'];
  if (typeof command !== 'string' || command.trim() === '') throw new Error('command 必须是非空字符串。');
  const timeoutMs = boundedNumber(args['timeoutMs'], defaultTimeout);
  return await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const remaining = maxOutputBytes - Buffer.byteLength(stdout) - Buffer.byteLength(stderr);
      if (remaining <= 0) { truncated = true; return; }
      const text = chunk.subarray(0, remaining).toString('utf8');
      if (target === 'stdout') stdout += text; else stderr += text;
      if (text.length < chunk.length) truncated = true;
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', (code, signalName) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolve({ command, cwd: root, exitCode: code, signal: signalName, stdout, stderr, timedOut, aborted: signal?.aborted === true, truncated });
    });
  });
}
