export const notificationMessagesEn = {
  'notify.external.title': 'Email and Bark',
  'notify.external.help':
    'Each channel belongs to your sign-in. Saving never sends a test. Event switches and “show details” apply to these channels too. SMTP requires implicit TLS on port 465 and AUTH PLAIN.',
  'notify.external.kind': 'Channel',
  'notify.external.enabled': 'Enable automatic notifications',
  'notify.external.host': 'SMTP host',
  'notify.external.username': 'SMTP username',
  'notify.external.password': 'SMTP password',
  'notify.external.from': 'Sender email',
  'notify.external.to': 'Recipient email',
  'notify.external.endpoint': 'Bark HTTPS origin',
  'notify.external.key': 'Bark device key',
  'notify.external.secretHint':
    'Leave blank to keep the saved credential. Changing the destination requires a new credential.',
  'notify.external.saved': 'Channel saved',
  'notify.external.test': 'Send a test notification',
  'notify.external.confirm': 'Send a test to this saved destination?',
  'notify.external.confirmText':
    'This will send one test message to the saved recipient or device, even if automatic notifications are disabled.',
  'notify.external.accepted': 'The service accepted the test',
  'notify.external.remove': 'Remove channel',
} as const;
export const notificationMessagesZh: Record<keyof typeof notificationMessagesEn, string> = {
  'notify.external.title': '邮件与 Bark',
  'notify.external.help':
    '每个渠道只属于当前登录用户。保存不会发送测试消息。事件开关与“显示详情”同样适用于这些渠道。SMTP 使用 465 端口的隐式 TLS 及 AUTH PLAIN。',
  'notify.external.kind': '渠道',
  'notify.external.enabled': '启用自动通知',
  'notify.external.host': 'SMTP 主机',
  'notify.external.username': 'SMTP 用户名',
  'notify.external.password': 'SMTP 密码',
  'notify.external.from': '发件地址',
  'notify.external.to': '收件地址',
  'notify.external.endpoint': 'Bark HTTPS 服务根地址',
  'notify.external.key': 'Bark 设备密钥',
  'notify.external.secretHint': '留空保留已保存的凭据，更改目标地址时需要重新输入凭据。',
  'notify.external.saved': '渠道已保存',
  'notify.external.test': '发送测试通知',
  'notify.external.confirm': '向此已保存的目标发送测试通知？',
  'notify.external.confirmText': '将向已保存的收件人或设备发送一条测试通知，即使自动通知已关闭。',
  'notify.external.accepted': '服务已接受测试通知',
  'notify.external.remove': '移除渠道',
};
