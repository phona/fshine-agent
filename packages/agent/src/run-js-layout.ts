/**
 * run_js 运行目录布局的不安全判定（CAP-01 symlink 收窄；docs/architecture/files.md §3）。
 *
 * 威胁：run 目录下的 `out`（或 `in`/`scratch` 等）可以是被预植的软链。`mkdirSync(..., {recursive:true})`
 * 对「软链 → 已存在目录」会静默通过，随后 `--allow-fs-read=<runDir>` 按路径放行、软链被跟随——
 * 脚本能读到 run 目录之外的文件，产物收集也会把外部文件当产物交付。
 *
 * 判据（最小可信边界，不依赖模型/提示词）：运行目录布局项**存在**时必须仍是真目录；
 * 是软链、普通文件或其它类型 → 拒跑（fail closed）。「不存在」是正常状态（随后由宿主创建）。
 *
 * 2026-11-17 补：`--allow-fs-read=<runDir>` 放行整个 run 目录，树内**任意条目**是软链都会
 * 被跟随（实测 `in/evil.txt → /etc/passwd` 可读）。因此布局项本身校验之后还要扫整棵树，
 * 发现软链即拒跑（`item: 'nested'`），条目数/深度超限同样拒跑。
 *
 * 本模块零 import：执行器（含 node:child_process）与 execution-runtime 都能安全以值边引用它——
 * import 图守卫要求通用运行时的值闭包不触及 spawn（见 import-boundary.test.ts）。
 */

/** 用户可见的确定性失败话术（本回合失败，零产物；不含路径/目录项等内部事实）。 */
export const RUN_JS_LAYOUT_UNSAFE_MESSAGE =
  '本次处理未执行：运行环境布局异常，已停止执行，未生成任何文件；请稍后重试。';

/** 机械错误码（结构化事件/日志面；不进用户话术）。 */
export const RUN_JS_LAYOUT_UNSAFE_CODE = 'RUN_JS_LAYOUT_UNSAFE';

/** 逐个校验的布局项：run 目录本身与子进程的读/写/HOME/TMP 面。 */
export type RunJsLayoutItem = 'runDir' | 'in' | 'out' | 'scratch' | 'home' | 'tmp' | 'nested';

/** lstat 观测到的实际类型（真目录以外的任何东西都拒跑）。 */
export type RunJsLayoutUnsafeKind = 'symlink' | 'file' | 'other';

/** 结构化事件（哪一项、实际是什么类型；只进日志/审计，不进用户话术）。 */
export interface RunJsLayoutUnsafeEvent {
  runId: string;
  item: RunJsLayoutItem;
  kind: RunJsLayoutUnsafeKind;
}

/**
 * 布局不安全（拒跑）：脚本未执行、run.cjs 未写、零产物、零 file_refs。
 * message 是用户可见话术；机械事实（item/kind/runId）只在 event 上。
 */
export class RunJsLayoutUnsafeError extends Error {
  readonly code = RUN_JS_LAYOUT_UNSAFE_CODE;

  constructor(readonly event: RunJsLayoutUnsafeEvent) {
    super(RUN_JS_LAYOUT_UNSAFE_MESSAGE);
    this.name = 'RunJsLayoutUnsafeError';
  }
}
