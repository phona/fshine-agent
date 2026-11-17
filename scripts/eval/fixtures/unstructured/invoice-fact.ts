/**
 * 模拟发票夹具的单一事实源（日期 / 金额 / 客户名 / 三行文本）。
 *
 * 数值选择：金额 68315.27、日期 2026-10-18——已用
 * `grep -rn "68315\|68,315\|2026-10-18" scripts/eval` 核对，除本目录外零命中
 * （r2-functional 的 24 个销售额原值都是 6 位整数，互不冲突）；夹具测试会再守一次。
 */
export const INVOICE_FACT = {
  /** 夹具目录里的文件名（也用作入站附件名）。 */
  pdfFilename: 'invoice-2026-10-18.pdf',
  date: '2026-10-18',
  /** 规范化金额（千分位/货币符号剥掉后的十进制串）。 */
  amount: '68315.27',
  /** PDF 文本里的金额写法（带货币与千分位）。 */
  amountDisplay: 'CNY 68,315.27',
  customer: 'Qinghe Trading (fictional)',
  /** PDF 页面上的三行文本；提取器的预期输出。 */
  lines: [
    'Date: 2026-10-18',
    'Amount: CNY 68,315.27',
    'Customer: Qinghe Trading (fictional)',
  ],
} as const;
