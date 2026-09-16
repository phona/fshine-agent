/** 工具调用阶段的进度模板:埋点事实渲染,开发者为每个工具维护一条。 */

export function defaultStepText(
  toolName: string,
  args: Record<string, unknown>,
  names: Map<string, string>,
): string {
  const accountSetId = typeof args['accountSetId'] === 'string' ? args['accountSetId'] : '';
  const name = accountSetId !== '' ? names.get(accountSetId) ?? accountSetId : '';
  switch (toolName) {
    case 'search_account_sets': {
      const query = typeof args['query'] === 'string' ? args['query'].slice(0, 30) : '';
      return `正在检索账套:${query}…`;
    }
    case 'get_current_accounting_period':
      return name ? `已定位账套「${name}」,查询当前会计期间…` : '查询当前会计期间…';
    case 'list_vouchers': {
      const period = typeof args['period'] === 'string' ? args['period'] : '';
      return name ? `拉取凭证:「${name}」${period}…` : '拉取凭证中…';
    }
    case 'inspect_account_set':
      return name ? `正在做账套「${name}」摸底…` : '正在做账套摸底…';
    case 'get_login_status':
      return '检查平台登录状态…';
    default:
      return `正在调用 ${toolName}…`;
  }
}
