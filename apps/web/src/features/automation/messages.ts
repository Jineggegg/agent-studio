export const reminderMessagesEn = {
  'reminder.proposals': 'Reminders awaiting your approval',
  'reminder.help':
    'Ask an assistant in this project to create, pause or resume a reminder. Its structured proposal appears here. Nothing changes until you approve it.',
  'reminder.approve': 'Approve reminder change',
  'reminder.dismiss': 'Dismiss proposal',
  'reminder.confirm': 'Apply this reminder proposal?',
  'reminder.create': 'Create reminder',
  'reminder.pause': 'Pause reminder',
  'reminder.resume': 'Resume reminder',
  'reminder.noNext': 'No upcoming time to show. Expired schedules must be revised before approval.',
  'reminder.applied': 'Reminder updated',
} as const;
export const reminderMessagesZh: Record<keyof typeof reminderMessagesEn, string> = {
  'reminder.proposals': '等待你确认的提醒',
  'reminder.help':
    '在本项目会话中让助手创建、暂停或恢复提醒，结构化提议会显示在这里。只有你确认后才会生效。',
  'reminder.approve': '确认提醒变更',
  'reminder.dismiss': '忽略提议',
  'reminder.confirm': '应用此提醒提议？',
  'reminder.create': '创建提醒',
  'reminder.pause': '暂停提醒',
  'reminder.resume': '恢复提醒',
  'reminder.noNext': '暂无下一次执行时间。过期计划需要修改后再确认。',
  'reminder.applied': '提醒已更新',
};
