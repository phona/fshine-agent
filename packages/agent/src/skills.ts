/**
 * Small, backend-neutral adapter for Pi-style SKILL.md files.
 *
 * The full pi coding-agent harness owns skill discovery in the interactive
 * application.  The service uses pi-agent-core directly, so this module
 * keeps only the discovery/read part that is useful at the runtime boundary.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const READ_SKILL_TOOL = 'read_skill';

/**
 * Main-side skill root, relative to the process working directory.
 *
 * This is the collaboration-skill surface.  The runtime worker surface
 * `.agents/skills-serve` is a different fact source (execution-layer skills) and
 * must never be merged into this discovery root.
 */
const DEFAULT_SKILL_ROOT_RELATIVE = '.agents/skills';

function defaultSkillRoot(): string {
  return path.join(process.cwd(), DEFAULT_SKILL_ROOT_RELATIVE);
}

/**
 * Cap for reading one skill body, in UTF-8 bytes.
 *
 * A skill body is spliced into the model context when read; without a cap a single
 * oversized file could consume the whole window.  The model context window default
 * is 128k tokens (`DEFAULT_CONTEXT_WINDOW`); 32 KiB bounds the worst case (dense
 * CJK text, ~3 bytes per character → ~11k characters → well under a tenth of that
 * window) while staying several times larger than a typical skill document
 * (the repo's own `docs/business-skill.md` is ~8.5 KB).
 */
export const SKILL_CONTENT_LIMIT_BYTES = 32 * 1024;

export interface SkillMetadata {
  /** The name exposed in SKILL.md frontmatter and to the model. */
  name: string;
  /** Short frontmatter description shown in the system prompt. */
  description: string;
  /** Absolute path to SKILL.md; never exposed to the model. */
  path: string;
}

/** Prompt-facing subset of SkillMetadata: names and descriptions only, no paths or bodies. */
export interface SkillSummary {
  name: string;
  description: string;
}

export interface LoadedSkill extends SkillMetadata {
  /** The complete SKILL.md text, including its frontmatter. */
  content: string;
}

export interface SkillRegistry {
  discover(): Promise<readonly SkillMetadata[]>;
  read(name: string): Promise<LoadedSkill>;
}

export interface FileSkillRegistryOptions {
  /** Directory containing skill subdirectories (normally `.agents/skills`). */
  rootDir?: string;
}

/**
 * Discover a Pi-compatible skill-directory tree containing SKILL.md files.
 *
 * Invalid files are ignored, matching the useful property of a service
 * process not failing to start because an unrelated local skill is malformed.
 * A duplicate frontmatter name fails discovery with an observable error
 * rather than silently letting one skill shadow the other.
 */
export class FileSkillRegistry implements SkillRegistry {
  readonly rootDir: string;

  constructor(options: FileSkillRegistryOptions = {}) {
    this.rootDir = path.resolve(options.rootDir ?? defaultSkillRoot());
  }

  async discover(): Promise<readonly SkillMetadata[]> {
    const files: string[] = [];
    await collectSkillFiles(this.rootDir, files);
    const discovered: SkillMetadata[] = [];
    const seen = new Map<string, string>();
    for (const file of files.sort()) {
      const parsed = await parseSkillFile(file);
      if (!parsed) continue;
      const existing = seen.get(parsed.name);
      if (existing !== undefined) {
        // Duplicate names make the list ambiguous; fail closed and visibly
        // instead of letting sort order decide which skill wins.
        throw new Error(`技能名称重复:${parsed.name}（${existing} 与 ${file}）`);
      }
      seen.set(parsed.name, file);
      discovered.push({ ...parsed, path: file });
    }
    return discovered.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(name: string): Promise<LoadedSkill> {
    if (!isSkillName(name)) throw new Error('技能名称无效。');
    const skills = await this.discover();
    const matches = skills.filter((skill) => skill.name === name);
    if (matches.length === 0) throw new Error(`未找到技能:${name}`);
    // discover() already rejects duplicates; this is the last line of defense.
    if (matches.length > 1) throw new Error(`技能名称重复:${name}`);

    const metadata = matches[0]!;
    const root = await realPathOrNull(this.rootDir);
    const file = await realPathOrNull(metadata.path);
    if (!root || !file || !isInside(root, file)) throw new Error('技能文件路径未通过安全校验。');
    const stats = await fs.stat(file);
    if (stats.size > SKILL_CONTENT_LIMIT_BYTES) {
      throw new Error(`技能正文超出上限:${name}（${stats.size} 字节，上限 ${SKILL_CONTENT_LIMIT_BYTES}）`);
    }
    const content = await fs.readFile(file, 'utf8');
    // Re-check after the read: the file may have grown between stat and read.
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > SKILL_CONTENT_LIMIT_BYTES) {
      throw new Error(`技能正文超出上限:${name}（读取后 ${bytes} 字节，上限 ${SKILL_CONTENT_LIMIT_BYTES}）`);
    }
    const reparsed = parseFrontmatter(content);
    if (!reparsed || reparsed.name !== name) throw new Error(`技能文件已变化:${name}`);
    return { ...metadata, path: file, content };
  }
}

export function createSkillRegistry(options: FileSkillRegistryOptions = {}): SkillRegistry {
  return new FileSkillRegistry(options);
}

/** Convenience API for callers that do not need a long-lived registry. */
export async function discoverSkills(rootDir = defaultSkillRoot()): Promise<readonly SkillMetadata[]> {
  return new FileSkillRegistry({ rootDir }).discover();
}

/**
 * Prompt-facing skill list: names + descriptions only.
 *
 * Paths and bodies stay behind the registry boundary — the model context must not
 * carry filesystem locations.
 */
export async function listSkills(rootDir = defaultSkillRoot()): Promise<readonly SkillSummary[]> {
  const skills = await new FileSkillRegistry({ rootDir }).discover();
  return skills.map(({ name, description }) => ({ name, description }));
}

/** Convenience API with the same containment checks as the registry. */
export async function readSkill(name: string, rootDir = defaultSkillRoot()): Promise<LoadedSkill> {
  return new FileSkillRegistry({ rootDir }).read(name);
}

async function collectSkillFiles(directory: string, output: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  for (const entry of entries) {
    // Do not follow symlinks during discovery.  read() still performs a
    // realpath containment check in case a file changes after discovery.
    if (entry.isSymbolicLink()) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectSkillFiles(candidate, output);
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      output.push(candidate);
    }
  }
}

async function parseSkillFile(file: string): Promise<{ name: string; description: string } | undefined> {
  try {
    return parseFrontmatter(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

/** Parse the YAML-like frontmatter subset used by Pi skills. */
export function parseFrontmatter(content: string): { name: string; description: string } | undefined {
  const normalized = content.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) return undefined;
  const lines = normalized.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return undefined;
  const values = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^(name|description)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2]!.trim();
    // Frontmatter descriptions are intentionally single-line in the Pi
    // format.  Strip matching quotes, but do not interpret arbitrary YAML.
    values.set(match[1]!, stripQuotes(value));
  }
  const name = values.get('name');
  const description = values.get('description');
  if (!name || !description || !isSkillName(name)) return undefined;
  return { name, description };
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function isSkillName(value: string): boolean {
  return value.trim() !== '' && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..';
}

async function realPathOrNull(file: string): Promise<string | undefined> {
  try {
    return await fs.realpath(file);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isMissingPath(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}
