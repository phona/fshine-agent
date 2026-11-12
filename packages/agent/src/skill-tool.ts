/**
 * `read_skill`: the minimal bridge that puts the existing FileSkillRegistry behind a
 * native Main-agent tool.
 *
 * Why a bridge: the Main driver runs on `@earendil-works/pi-agent-core`, which has no
 * native skill loading; the native skill machine lives in `pi-coding-agent`, and moving
 * the Main driver there would collide with the known extension-system incompatibility
 * (issue #10386).  So this module does exactly one thing: list first (`discover`), then
 * read by name (`read`).  It accepts no paths, does no keyword routing and never guesses
 * what the model meant.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { ToolUserError } from './driver';
import {
  FileSkillRegistry,
  READ_SKILL_TOOL,
  type FileSkillRegistryOptions,
  type LoadedSkill,
  type SkillMetadata,
  type SkillRegistry,
} from './skills';

const skillParameters = Type.Object({
  name: Type.String({ description: '已发现技能清单中的技能名' }),
});

export type ReadSkillToolOptions = FileSkillRegistryOptions;

export function createReadSkillTool(options: ReadSkillToolOptions = {}): AgentTool<typeof skillParameters> {
  const registry: SkillRegistry = new FileSkillRegistry(options);
  return {
    name: READ_SKILL_TOOL,
    label: READ_SKILL_TOOL,
    description: '按名称读取一份可用技能的完整正文。只接受已发现技能清单中的名称；路径或其他定位形式一律拒绝。',
    parameters: skillParameters,
    execute: async (_toolCallId, params) => {
      const name = typeof params.name === 'string' ? params.name.trim() : '';
      const skills = await discoverForTool(registry);
      const available = skills.map((skill) => skill.name).sort();
      if (!name || !available.includes(name)) {
        throw new ToolUserError(unknownSkillMessage(name, available));
      }
      const loaded = await readForTool(registry, name);
      return {
        content: [{ type: 'text', text: loaded.content }],
        details: { name: loaded.name },
      };
    },
  };
}

async function discoverForTool(registry: SkillRegistry): Promise<readonly SkillMetadata[]> {
  try {
    return await registry.discover();
  } catch (error) {
    // Observable on the host side (duplicate names / unreadable tree), while the model
    // gets an actionable message without internal paths.
    console.error(JSON.stringify({ event: 'skill_discovery_failed', error: errorText(error) }));
    throw new Error('技能清单不可用（技能名重复或文件不可读），本次没有读取任何技能。');
  }
}

async function readForTool(registry: SkillRegistry, name: string): Promise<LoadedSkill> {
  try {
    return await registry.read(name);
  } catch (error) {
    // Observable failure: never fake success, never leak internal paths or raw system
    // errors into the model-visible text.
    console.error(JSON.stringify({ event: 'skill_read_failed', name, error: errorText(error) }));
    throw new Error(`技能「${name}」读取失败（文件不可读、未通过校验或超出上限），未返回正文。`);
  }
}

function unknownSkillMessage(name: string, available: readonly string[]): string {
  const asked = name || '（空名称）';
  const list = available.length > 0 ? available.join('、') : '（当前没有可用技能）';
  return `未找到技能「${asked}」。可用技能：${list}。请从可用技能清单中选一个名称重新调用 ${READ_SKILL_TOOL}。`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : String(error);
}
