/**
 * `resend_artifact`：重发路由的直连工具形态（W4 的最小工具）。
 *
 * 为什么有它：重发曾经是 `route_current_turn` 申报的第三枝（kind='resend'）——申报层
 * 停用后，`turn.resendRefs` 读端还在、写端断了：产物清单每回合仍在注入（并写着「可随时
 * 要求重发」），用户说"把那个表再发一次"却没有模型可用的动作。本模块给那条链路一个
 * 模型可见工具名；**runtime 只记账（填 resendRefs），存在性/有效期/读回由 handler 依
 * 会话产物库确定性回答**（与旧 resend 申报同一分工，runtime 不 import 产物库）。
 *
 * 入参只接受「已暴露的产物引用」：refs = 本轮输入【本会话已保存的产物】清单里的 #编号
 * 字符串。宿主复检不信任 schema——trim → 允许一个前导 # → 必须纯十进制 → 去重保序 →
 * 上限；文件名、路径、URL、身份字段或任何额外 payload 一律拒，绝不猜测解析（文件名 →
 * ref 的模糊匹配会把"重发"变成一次猜测，违反"不做自然语言分类"的纪律）。
 *
 * 能力开关由装配注入（与 readSkillTool 同一模式）：只有 `store.sessionArtifacts` 在场
 * 的部署才注册本工具——缺库时注册它等于给模型一个"调了永远答没有交付过"的假工具。
 */
import type { DiscoveredTool } from '@fshine/contracts';

/** 模型可见协议名（缺省形态；当前不支持 profile toolName 声明，见交付说明的待裁项）。 */
export const RESEND_ARTIFACT_TOOL_NAME = 'resend_artifact';

/**
 * 一次最多重发的产物数：与交付收集的 MAX_OUT_FILES 同值同理由（拿到 4 个以上文件时，
 * 对话框里的文件清单已经超出一次交付的可读性；清单一页通常也放不下更多）。取值是政策线，
 * 不是自然常数。
 */
export const MAX_RESEND_REFS = 3;

/**
 * 工具描述（模型可见，不携带实例名）：三条缺一不可——
 *   ① 触发条件：只在"重发已保存/交付过的文件"时调用；
 *   ② 参数来源：只能取本轮输入清单里的 #编号（清单由 handler 每回合注入）；
 *   ③ 反面边界：要新数据/重新计算用委派工具，清单里没有的文件不要调（否则会编）。
 */
export const RESEND_ARTIFACT_DESCRIPTION = [
  '当用户要求重发本会话此前已保存或交付过的文件时调用本工具。',
  'refs 只能填本轮输入【本会话已保存的产物】清单里的 #编号（如 "3" 或 "#3"）；文件名、路径、链接或其他定位形式一律不接受。',
  '需要新数据或重新计算结果时不要调用本工具，应委派执行任务；清单里没有用户要的文件时也不要调用。',
].join('\n');

/** 入参 schema：refs 必填、非空、上限 MAX_RESEND_REFS，元素是编号字符串。 */
export const RESEND_ARTIFACT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['refs'],
  properties: {
    refs: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_RESEND_REFS,
      description: '要重发的产物编号列表；每项取本轮输入【本会话已保存的产物】清单里的 #编号（如 "3" 或 "#3"）。',
      items: { type: 'string', description: '产物 #编号（如 "3" 或 "#3"）' },
    },
  },
};

/** 工具面描述符（与 run_task / read_skill 同族，交给 runtime 的工具数组）。 */
export const RESEND_ARTIFACT_TOOL: DiscoveredTool = {
  name: RESEND_ARTIFACT_TOOL_NAME,
  description: RESEND_ARTIFACT_DESCRIPTION,
  inputSchema: RESEND_ARTIFACT_SCHEMA,
};

/** 形状错误的确定性话术（可恢复工具错误）：只教合法形态，不猜用户想发哪个文件。 */
export const RESEND_REF_SHAPE_ERROR = '重发只接受本会话产物清单里的 #编号（如 3 或 #3）：refs 必须是一个非空数组，元素只能是编号字符串。';

/** 超过上限的确定性话术（与形状错误分开：元素合法，只是给多了）。 */
export function resendRefCapError(count: number): string {
  return `一次最多重发 ${MAX_RESEND_REFS} 个产物（本次给了 ${count} 个）：refs 里只保留需要的编号（如 3 或 #3）。`;
}

export type ResendRefParseResult =
  | { ok: true; refs: string[] }
  | { ok: false; error: string };

/**
 * 宿主侧引用复检（纯函数，不信任 schema）：trim → 允许一个前导 `#` → 纯十进制 → 去重保序
 * → 上限。任何其他形状（含额外字段、非数组、空数组、非字符串元素）返回形状错误话术。
 */
export function parseResendRefs(args: unknown): ResendRefParseResult {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: RESEND_REF_SHAPE_ERROR };
  const record = args as Record<string, unknown>;
  // 额外字段（身份、路径、payload）一律拒：这个工具的入参只有 refs 一个事实源。
  if (Object.keys(record).some((key) => key !== 'refs')) return { ok: false, error: RESEND_REF_SHAPE_ERROR };
  const raw = record['refs'];
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: RESEND_REF_SHAPE_ERROR };
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: RESEND_REF_SHAPE_ERROR };
    const trimmed = item.trim();
    const normalized = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
    if (!/^[0-9]+$/.test(normalized)) return { ok: false, error: RESEND_REF_SHAPE_ERROR };
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    refs.push(normalized);
  }
  if (refs.length > MAX_RESEND_REFS) return { ok: false, error: resendRefCapError(refs.length) };
  return { ok: true, refs };
}
