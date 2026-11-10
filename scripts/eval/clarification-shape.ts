/**
 * 澄清问句判据（探针层与期望值层共用**同一份**）。
 *
 * 2026-11-10 评测判据校准：`probe-real-agent.ts` 的 `CLARIFICATION_QUESTION_RE` 与
 * `expectations.ts` 的 `QUESTION_RE` 曾是两份逐字相同的副本。两层"一致"不是独立确认，
 * 是同一把尺量了两次：词表漏掉的问法两层一起漏（Y2 实测第 2 轮回复
 * 「请补充以下信息之一：1 …；2. 或者说明是否连同 window 一起调整」被判"没有问句"），
 * 补词也必须改两处、漏一处就静默漂移。抽成一个模块后，判据只有一份，两层消费同一
 * 来源；回归也只钉一处。
 *
 * 判据要的是「用户收到能回答选哪个」，不是标点形态：模型（尤其中文系统提示词下）常用
 * 无疑号的请求句式发问——"需要你确认查哪一个" / "请补充以下信息之一" / "please confirm
 * which one"。因此判据分两路：
 *   ① 问号或问句/请求词形（中英）；
 *   ② 候选 ≥2 且**全列**在回复里 + 有请求用户做出选择的动作词（"请选择其中一个"这类
 *      完全不含问号、也不含疑问代词的形态）。
 */

/**
 * 问号 / 问句词形 / 请求确认词形（中英）。
 *
 * 词表补请求式（2026-11-10 校准）：`请补充|请告诉|请明确|或者说明是否|是否需要|
 * 请指出|麻烦给出|劳烦`——Y2 实测回复用的正是「请补充…」与「或者说明是否…」，旧词表
 * 只收了「请提供/请确认」，两层同时假红。
 */
export const CLARIFICATION_QUESTION_RE = /[?？]|告诉|请回复|需要你|请提供|请补充|请告诉|请明确|请确认|确认哪|哪个|哪些|哪一[家个条些]|哪一个|请问|请指出|或者说明是否|是否需要|麻烦给出|劳烦|which one|which\b|please confirm|confirm which|let me know|could you|would you|do you\b|please provide|please specify|tell me/i;

/**
 * 请求用户做出选择/补充信息的动作词（helper 第二路的判据）。
 *
 * 刻意比 `CLARIFICATION_QUESTION_RE` 宽：第二路已经用"候选 ≥2 全列"锁住语境，这里的
 * 动作词只回答"有没有请用户选/补充"；单独的「请」也有意义（"请在 A、B 中选一个"）。
 */
const SELECTION_REQUEST_RE = /请|麻烦|劳烦|告诉|回复|提供|补充|明确|指出|说明|确认|选择|选一个|指定|which|choose|select|pick|let me know|tell me|please/i;

/**
 * 回复是否构成一个用户可回答的澄清问句。
 *
 * `candidates` 是宿主/夹具给出的候选清单（探针的歧义轮有；期望值层没有候选清单时只走
 * 第一路）。第二路要求候选**全部**列出：只列一个候选时"选哪个"不成立，用户仍无法回答。
 */
export function hasClarificationQuestion(reply: string, candidates: readonly string[] = []): boolean {
  if (CLARIFICATION_QUESTION_RE.test(reply)) return true;
  return candidates.length >= 2
    && candidates.every((name) => reply.includes(name))
    && SELECTION_REQUEST_RE.test(reply);
}
