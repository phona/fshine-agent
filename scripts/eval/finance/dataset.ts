/**
 * S3/S4/S5 · 财务数据集（eval-only，产品装配不得 import）。
 *
 * 为什么是 JSON（而非 TS 常量 + JSON 镜像）：这份东西是**数据**，不是逻辑——金额/日期/
 * 客户名需要人来读、来对账、来手算。JSON 单一来源可被 diff、可被非 TS 消费者（S4 Oracle
 * 草稿、SimCase 目标文本、人工复核）直接读取；若再存一份 TS 常量，两处必然漂移，只能靠
 * 额外的镜像守卫兜住，属于用机制补本可避免的问题。形状安全由本文件的类型注解 + `tsc`
 * （`resolveJsonModule`）与 `./integrity` 的 8 条校验在 typecheck/test 时保证。
 *
 * 口径（v5 §2，as-of 快照）：
 *   · 应收纳入 = `issuedOn <= asOfDate`（含当日）；未来应收**整笔排除**；
 *   · 核销纳入 = `effectiveOn <= asOfDate`（含当日）；跨期核销**不计入**；
 *   · `period` 只是发生月标识，**不作为过滤条件**（恒 = issuedOn 前 7 位）；
 *   · 未结清 = 应收 − 已核销（按单笔应收累计）；
 *   · 逾期 = `dueOn < asOfDate`（**严格小于**）且未结清 > 0；
 *   · 只含有效核销（数据集不建作废/冲销/反核销的模拟）；
 *   · 未分配收款（无任何核销行引用）**不得直接抵扣**应收。
 *
 * 金额单位：元，整数（真值必须能手算，避免浮点尾差）。
 * 日期格式：`YYYY-MM-DD`（ISO，可安全字典序比较）；`period`：`YYYY-MM`。
 */
import invoicesJson from './invoices.json';
import receiptsJson from './receipts.json';
import writeoffsJson from './writeoffs.json';

/** 固定快照日（S3/S4/S5 共用；真值口径见文件头）。 */
export const AS_OF_DATE = '2026-10-31';

/** 应收单（发票/账单）。 */
export interface Invoice {
  readonly id: string;
  /** 应收金额（元，整数）。 */
  readonly amount: number;
  readonly customer: string;
  /** 开票日；as-of 纳入判据 `issuedOn <= asOfDate`。 */
  readonly issuedOn: string;
  /** 到期日；逾期判据 `dueOn < asOfDate`（严格）。 */
  readonly dueOn: string;
  /** 发生月标识（`YYYY-MM`）。**只是标识，不参与过滤**。 */
  readonly period: string;
}

/** 收款单。schema 只有这三个字段：收款本身不带客户，归属只能经核销行（`arId`）建立。 */
export interface Receipt {
  readonly id: string;
  /** 收款金额（元，整数）。 */
  readonly amount: number;
  readonly receivedOn: string;
}

/** 核销行（应收 ↔ 收款 的分配）。 */
export interface Writeoff {
  /** 被核销的应收单 id。 */
  readonly arId: string;
  /** 用于核销的收款单 id。 */
  readonly receiptId: string;
  /** 本次核销金额（元，整数，必须 > 0）。 */
  readonly amount: number;
  /** 生效日；as-of 纳入判据 `effectiveOn <= asOfDate`，且必须 `>= 收款.receivedOn`。 */
  readonly effectiveOn: string;
}

/** 数据集三段；`./integrity` 与 `./truth` 的输入。 */
export interface FinanceDataset {
  readonly invoices: readonly Invoice[];
  readonly receipts: readonly Receipt[];
  readonly writeoffs: readonly Writeoff[];
}

/** 客户名（显式登记，保证真值表行序稳定；每个客户至少 1 笔应收）。 */
export const CUSTOMERS = ['华远贸易', '明达物流', '新程科技'] as const;

export type Customer = (typeof CUSTOMERS)[number];

// 形状由这里的注解在 typecheck 时兜住（JSON 缺字段/错类型即红）。
export const INVOICES: readonly Invoice[] = invoicesJson;
export const RECEIPTS: readonly Receipt[] = receiptsJson;
export const WRITEOFFS: readonly Writeoff[] = writeoffsJson;

/** 固定数据集（只读；消费者不得就地改写）。 */
export const FINANCE_DATASET: FinanceDataset = {
  invoices: INVOICES,
  receipts: RECEIPTS,
  writeoffs: WRITEOFFS,
};
