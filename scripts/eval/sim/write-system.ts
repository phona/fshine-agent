/**
 * SimCase 用例套件 · 写操作确定性假系统（SIM-09 / SIM-10；零真实模型、零真实写）。
 *
 * 为什么需要它：ask 装配当前只有**读切片**（`scripts/ask-runtime.ts` 的
 * `allowedOperations` 只含 `access=read` 的 operation），真实跑批无法到达 `dummy.commit`。
 * 写场景因此用这个确定性假系统做被测面——它是**夹具**，不是产品行为；报告必须按
 * `SIM_WRITE_CASES` 单列，不得冒充「产品已支持写」。
 *
 * 注入思路直接复用 `.runtime/pi152-u3fix2/`（U3 B2 回执丢失 / B3 同 key 并发）的判据：
 *   · 执行账按 **dispatchKey** 归属：同一身份已 completed → 回放，**不再调用执行层**；
 *   · 已执行但回执丢失 → 账行 unknown；同身份再来 → 待核对，不执行；
 *   · `dedupeByDispatchKey=false` 是反向绊线开关：故意让同一身份重复执行（必须判负）。
 *
 * 假系统只产出 `SimSystemTurn`：用户可见回复 + 机械执行事实（operation/status/dispatchKey）。
 */

import type { InjectionDirective } from './injection';
import type { SimSystemTurn, SimSystemUnderTest } from './run';
import { isWriteAsk } from './cases/scenario-oracles';

export interface WriteSystemOptions {
  /** 写 operation 名（缺省 `dummy.commit`，与 dummy 夹具一致）。 */
  readonly operation?: string;
  /**
   * 同身份是否走回放（true = U3 正确行为；false = 反向绊线：同一 dispatchKey 重复执行）。
   */
  readonly dedupeByDispatchKey?: boolean;
  /** 首次写已生效但回执丢失（SIM-10 B2 场景）。 */
  readonly loseReceipt?: boolean;
  /**
   * 反向绊线：同一逻辑身份被重复执行（`dedupeByDispatchKey=false` 时生效）。
   * 默认 false = 每次新身份（两笔合法操作，不得被判成重复副作用）。
   */
  readonly reexecuteSameKey?: boolean;
}

export interface WriteSystem extends SimSystemUnderTest {
  /** 真实副作用次数（completed 写执行数；仅测试/证据用）。 */
  effects(): number;
}

const ALPHA_READ_REPLY = '**alpha 批次**\n\n- 条数：2 条\n- 明细：1200、800\n- 合计：2000';
/** 产品固定话术（与 `packages/agent/src/execution-runtime.ts` 的 RESULT_UNKNOWN_MESSAGE 同义）。 */
const UNKNOWN_REPLY =
  '结果待核对：无法确认这次操作是否已经发生，已停止自动重试，需要人工核对后再决定是否重办。';

/**
 * 建一个写操作假系统。`send` 按用户消息决定读/写：
 *   · 读（alpha）→ 固定交付条数与合计；
 *   · 写 → 按 dispatchKey 认领：回放 / 待核对 / 执行。
 */
export function createWriteSystem(options: WriteSystemOptions = {}): WriteSystem {
  const operation = options.operation ?? 'dummy.commit';
  const dedupe = options.dedupeByDispatchKey ?? true;
  const reexecuteSameKey = options.reexecuteSameKey === true;
  const ledger = new Map<string, 'completed' | 'unknown'>();
  let identitySeq = 0;
  let effects = 0;
  let requestSeq = 0;

  /**
   * 身份键：回放/绊线模式固定一个身份（同一逻辑操作）；否则每次新身份（两笔合法操作）。
   * U3 语义：身份 = 逻辑操作，不随 requestId 换号。
   */
  const nextKey = (): string => {
    if (dedupe || reexecuteSameKey) return 'dk_alpha_commit_1';
    identitySeq += 1;
    return `dk_alpha_commit_${identitySeq}`;
  };

  return {
    effects(): number {
      return effects;
    },
    async send(text: string, ctx: { readonly injection: InjectionDirective | null }): Promise<SimSystemTurn> {
      if (!isWriteAsk(text)) {
        const alpha = text.toLowerCase().includes('alpha');
        return {
          visibleReply: alpha ? ALPHA_READ_REPLY : '好，收到。',
          toolCalls: alpha ? 1 : 0,
          events: 0,
          executions: alpha ? [{ operation: 'dummy.query', status: 'completed' }] : [],
          ...(alpha ? {} : { injectionApplied: false, injectionReason: '本条不是写请求，无需注入' }),
        };
      }

      // 身份：回放/绊线模式固定同一 key（模拟 U3 的重放窗口）；否则每次新 key。
      const key = nextKey();
      const state = ledger.get(key);

      // 回放只在 dedupe 模式生效；绊线模式故意重复执行同一身份。
      if (dedupe && state === 'completed') {
        return {
          visibleReply: `这笔之前已经入账过，累计 ${effects} 条；本次没有重复执行。`,
          toolCalls: 0,
          events: 0,
          executions: [],
          injectionApplied: false,
          injectionReason: '回放：未调用执行层',
        };
      }
      if (dedupe && state === 'unknown') {
        return {
          visibleReply: '这笔操作结果待核对，已停止自动重试；本次没有重复执行。',
          toolCalls: 0,
          events: 0,
          executions: [],
          injectionApplied: false,
          injectionReason: '待核对：未调用执行层',
        };
      }

      requestSeq += 1;
      const requestId = `req_${requestSeq}`;

      if (options.loseReceipt === true) {
        // 已写入，但宿主拿不到回执 → 账行 unknown，用户可见回复为「待核对」。
        effects += 1;
        ledger.set(key, 'unknown');
        return {
          visibleReply: UNKNOWN_REPLY,
          toolCalls: 1,
          events: 0,
          executions: [{ operation, status: 'failed', object: requestId, dispatchKey: key }],
          injectionApplied: ctx.injection !== null && ctx.injection.kind === 'receipt-lost',
          injectionReason: '写入已发生、回执丢失（夹具注入）',
        };
      }

      effects += 1;
      ledger.set(key, 'completed');
      return {
        visibleReply: `已入账 alpha 这批 W1：本次新增 1 条，累计 ${effects} 条。`,
        toolCalls: 1,
        events: 0,
        executions: [{ operation, status: 'completed', object: requestId, dispatchKey: key }],
      };
    },
  };
}
