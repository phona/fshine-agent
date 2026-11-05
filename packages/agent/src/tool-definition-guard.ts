/**
 * Tool-definition-removed guard (Phase 2, scripted-turn proof).
 *
 * Book experiment, restated as a host rule: removing tool definitions
 * does not make a model silent — it can still produce a formatted,
 * plausible-looking answer. The host must therefore never treat a
 * formatted answer as completion when there were no tools to execute
 * with and no execution happened. This module is that rule, in pure
 * form: it reads only whether tools were present and whether execution
 * occurred, never the model's prose, so it cannot be talked out of
 * blocking by a confident-sounding reply.
 *
 * This does not replace turn-exit (decideTurnExit), which already blocks
 * zero-execution delegate turns. It names the specific tool-definition
 * case so a scripted turn can prove it directly: tools removed +
 * execution false => blocked, whatever the text says.
 */
export interface ToolDefinitionGuardInput {
  /** Whether any tool definitions were present in this turn. */
  toolsPresent: boolean;
  /** Whether host-measured execution occurred (gateCalls > 0 / execution proof). */
  execution: boolean;
}

export interface ToolDefinitionGuardDecision {
  blocked: boolean;
  reason: string;
}

export function decideToolDefinitionGuard(input: ToolDefinitionGuardInput): ToolDefinitionGuardDecision {
  if (!input.toolsPresent && !input.execution) {
    return {
      blocked: true,
      reason: '工具定义已被移除且本轮零执行：模型文本不能作为完成结论外发，需重新提供工具定义并真实执行后才可确认。',
    };
  }
  return { blocked: false, reason: '' };
}
