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
      return `正在检索目录:${query}…`;
    }
    case 'get_current_accounting_period':
      return name ? `已定位「${name}」,查询当前时间范围…` : '查询当前时间范围…';
    case 'list_vouchers': {
      const period = typeof args['period'] === 'string' ? args['period'] : '';
      return name ? `拉取记录:「${name}」${period}…` : '拉取记录中…';
    }
    case 'inspect_account_set':
      return name ? `正在做「${name}」摸底…` : '正在摸底…';
    case 'search_references': {
      const query = typeof args['query'] === 'string' ? args['query'].slice(0, 30) : '';
      return name ? `在「${name}」中检索「${query}」的档案…` : `正在检索档案:${query}…`;
    }
    case 'get_login_status':
      return '检查平台登录状态…';
    default:
      return `正在调用 ${toolName}…`;
  }
}
