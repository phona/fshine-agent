/** Freeze the host-selected attachment set; queued tasks never reread a mutable session pool. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingAttachment } from '@fshine/contracts';
import { isScratchDirName } from './scratch-cleanup';
import { MAX_WRITE_BYTES } from './serve-gate';

export interface FrozenTaskInput {
  sourcePath: string;
  path: string;
  filename: string;
  size: number;
  sha256: string;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function directory(parent: string, name: string): string {
  const child = path.join(parent, name);
  if (!existsSync(child)) mkdirSync(child);
  const stat = lstatSync(child);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(parent, realpathSync(child))) {
    throw new Error('任务输入目录不可用，请重新提交附件。');
  }
  return child;
}

/** Materialize once after dispatch-key deduplication and before exposing the acceptance receipt. */
export async function materializeTaskInputs(input: {
  platformRoot: string;
  workspaceDir: string;
  runId: string;
  files: readonly IncomingAttachment[];
}): Promise<FrozenTaskInput[]> {
  const segments = input.workspaceDir.replace(/\\/g, '/').split('/');
  if (segments.length !== 2 || segments[0] !== 'tmp' || !isScratchDirName(segments[1]!)
    || !/^[A-Za-z0-9_-]+$/.test(input.runId)) {
    throw new Error('任务输入工作区无效。');
  }
  if (input.files.length === 0) return [];
  const root = realpathSync(input.platformRoot);
  const staging = directory(directory(directory(directory(root, 'tmp'), segments[1]!), '.inputs'), input.runId);
  const frozen: FrozenTaskInput[] = [];

  for (const [index, file] of input.files.entries()) {
    const originalPath = realpathSync(file.path);
    const sourceStat = lstatSync(originalPath);
    if (!inside(root, originalPath) || !sourceStat.isFile()) {
      throw new Error('任务输入不在当前执行层的可读位置，请重新上传。');
    }
    // 输入体积上限（D-130）：与 write 门同一把尺（serve-gate MAX_WRITE_BYTES，256KB）——
    // worker 单次写封顶 256KB，输入侧没有理由更宽。读取前按 stat 判体积，fail-closed：
    // 既不把超大文件整读进内存，也不复制进冻结区。
    if (sourceStat.size > MAX_WRITE_BYTES) {
      throw new Error(`任务输入超过单文件上限（${sourceStat.size} 字节 > ${MAX_WRITE_BYTES} 字节），请压缩或拆分后重新上传。`);
    }
    const data = readFileSync(originalPath);
    if (data.length !== file.bytes) throw new Error('任务输入在受理前已改变，请重新上传。');
    const filename = path.posix.basename(file.filename.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '_');
    if (!filename || filename === '.' || filename === '..') throw new Error('任务输入文件名无效。');
    const target = path.join(staging, `${index + 1}_${filename}`);
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()
        || createHash('sha256').update(readFileSync(target)).digest('hex') !== sha256) {
        throw new Error('同一次任务的输入与已冻结内容不同，请发起新的任务。');
      }
    } else {
      writeFileSync(target, data, { flag: 'wx', mode: 0o400 });
    }
    frozen.push({ sourcePath: file.path, path: target, filename, size: data.length, sha256 });
  }
  return frozen;
}

/** Replace only host-selected literal paths, then append the authoritative read-only input list. */
export function requestWithFrozenInputs(request: string, files: readonly FrozenTaskInput[]): string {
  if (files.length === 0) return request;
  let updated = request;
  for (const file of [...files].sort((a, b) => b.sourcePath.length - a.sourcePath.length)) {
    updated = updated.split(file.sourcePath).join(file.path);
  }
  return `${updated}\n【本次任务输入清单；路径由宿主固定】\n${JSON.stringify(files.map(({ path: inputPath, filename, size, sha256 }) => ({ path: inputPath, filename, size, sha256 })))}`;
}
