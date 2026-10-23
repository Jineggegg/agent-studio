export const usageGateMessagesEn = {
  'usage.gate.label': 'Stop new requests at this amount',
  'usage.gate.hint':
    'Off by default. When recorded monthly usage reaches this amount, new runs and API model requests stop until the month resets or you change this budget.',
  'usage.gate.costHint':
    'This is not an exact spending cap. Missing model prices and unreported costs are excluded. Concurrent or already running requests may spend beyond the amount.',
  'usage.gate.tokenHint':
    'Only reported tokens count. Concurrent or already running requests may exceed the amount; CLI requests inside an active run cannot be stopped by this gate.',
  'usage.gate.enabled': 'New requests stop at the recorded limit.',
  'usage.gate.blocked': 'Recorded limit reached: new requests in this scope are blocked.',
  'usage.gate.advisory': 'Notifications only; requests continue.',
  'usage.gate.empty':
    'Choose your own monthly token or cost amount. Notifications are on; stopping new requests is optional.',
  'usage.gate.footer':
    'Notifications arrive at 80% and 100%. Request gates are optional and use recorded usage, not reserved spending. Unknown prices are excluded and running requests may exceed the amount.',
  'errors.budget_exhausted':
    'Your recorded monthly usage has reached an enabled limit. Review your budgets in Usage before starting another request.',
} as const;

export const usageGateMessagesZh = {
  'usage.gate.label': '达到此额度后停止新请求',
  'usage.gate.hint':
    '默认关闭。当本月已记录用量达到此额度后，会停止新的运行和 API 模型请求，直到下月重置或你调整预算。',
  'usage.gate.costHint':
    '这不是精确的消费上限。缺少价格或尚未上报的费用不计入统计，并发或正在进行的请求仍可能超过额度。',
  'usage.gate.tokenHint':
    '仅计算已上报的 Token。并发或正在进行的请求仍可能超过额度；此限制无法中断正在运行的 CLI 内部请求。',
  'usage.gate.enabled': '达到已记录额度后停止新请求。',
  'usage.gate.blocked': '已达到记录额度：此范围内的新请求已停止。',
  'usage.gate.advisory': '仅通知，继续接受请求。',
  'usage.gate.empty': '自行设置每月 Token 或费用额度。达到阈值时会通知，也可选择停止新请求。',
  'usage.gate.footer':
    '在 80% 和 100% 时通知。停止新请求为可选功能，依据已记录用量，不会预留费用。未知价格不计入，正在进行的请求仍可能超过额度。',
  'errors.budget_exhausted':
    '本月已记录用量达到启用的额度。请在「用量」中查看并调整预算后再开始新请求。',
} satisfies Record<keyof typeof usageGateMessagesEn, string>;
