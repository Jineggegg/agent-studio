/**
 * The sentences the server writes itself: notification titles and bodies, and
 * the inbox tile's status line. They are written when the notification is
 * raised, in the language of the account it is for, because a push message
 * is displayed by the operating system with no app running to translate it.
 */

export type Language = 'en' | 'zh-CN';

export const PRODUCT_NAME = 'Cloud Harness';

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'zh-CN';
}

/** The best supported language for an `Accept-Language` header. Null when none of its languages is supported. */
export function languageFromHeader(header: string | undefined): Language | null {
  if (!header) return null;
  const tags = header
    .split(',')
    .slice(0, 12)
    .map((part) => {
      const [tag, ...parameters] = part.trim().split(';');
      const quality = parameters
        .map((parameter) => /^\s*q=([0-9.]+)\s*$/.exec(parameter)?.[1])
        .find((value) => value !== undefined);
      return { tag: (tag ?? '').toLowerCase(), q: quality === undefined ? 1 : Number(quality) };
    })
    .filter((entry) => entry.tag !== '' && Number.isFinite(entry.q) && entry.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of tags) {
    if (tag.startsWith('zh')) return 'zh-CN';
    if (tag.startsWith('en')) return 'en';
  }
  return null;
}

type Vars = Readonly<Record<string, string | number>>;

const en = {
  'needsYou.tool': '{agent} needs your approval to use {tool}',
  'needsYou.toolUnnamed': '{agent} needs your approval for a tool action',
  'needsYou.plan': '{agent} has a plan waiting for you to confirm',
  'needsYou.question': '{agent} has a question for you',
  'needsYou.owner.tool': "{agent} needs an owner's approval to use {tool} (run by {person})",
  'needsYou.owner.toolUnnamed':
    "{agent} needs an owner's approval for a tool action (run by {person})",
  replyFinished: '{agent} finished its reply',
  backgroundFinished: '{agent} finished its background work',
  runFailed: "{agent}'s run failed",
  runInterrupted: "{agent}'s run was cut short by a restart. Open the session to continue.",
  'deviceAdded.title': 'Notifications are on',
  'deviceAdded.body': '{device} will now receive notifications.',
  'test.title': 'Test notification',
  'test.body': 'Notifications from Cloud Harness reach this device.',
  'plugin.discreet': '{plugin} sent a notification',
  'summary.waiting.one': '1 waiting',
  'summary.waiting.other': '{count} waiting',
  'summary.results.one': '1 new result',
  'summary.results.other': '{count} new results',
  'summary.running.one': '1 in progress',
  'summary.running.other': '{count} in progress',
  'summary.clear': 'Nothing waiting',
  'device.app': 'Home-screen app',
  'device.browserOn': '{browser} on {system}',
  'device.unknown': 'Browser',
} as const;

export type TextKey = keyof typeof en;

const zhCN: Record<TextKey, string> = {
  'needsYou.tool': '{agent} 需要你批准使用 {tool}',
  'needsYou.toolUnnamed': '{agent} 需要你批准一项工具操作',
  'needsYou.plan': '{agent} 的计划等待你确认',
  'needsYou.question': '{agent} 有问题等你回答',
  'needsYou.owner.tool': '{agent} 需要所有者批准使用 {tool}（{person} 的任务）',
  'needsYou.owner.toolUnnamed': '{agent} 需要所有者批准一项工具操作（{person} 的任务）',
  replyFinished: '{agent} 已完成回复',
  backgroundFinished: '{agent} 的后台任务已完成',
  runFailed: '{agent} 的任务失败了',
  runInterrupted: '{agent} 的任务因服务重启而中断，打开会话即可继续。',
  'deviceAdded.title': '通知已开启',
  'deviceAdded.body': '{device} 现在会收到通知。',
  'test.title': '测试通知',
  'test.body': '这台设备可以收到 Cloud Harness 的通知。',
  'plugin.discreet': '{plugin} 发来一条通知',
  'summary.waiting.one': '1 项待处理',
  'summary.waiting.other': '{count} 项待处理',
  'summary.results.one': '1 个新结果',
  'summary.results.other': '{count} 个新结果',
  'summary.running.one': '1 个进行中',
  'summary.running.other': '{count} 个进行中',
  'summary.clear': '没有待办',
  'device.app': '主屏幕应用',
  'device.browserOn': '{system} 上的 {browser}',
  'device.unknown': '浏览器',
};

const dictionaries: Record<Language, Record<TextKey, string>> = { en, 'zh-CN': zhCN };

export function text(language: Language, key: TextKey, vars: Vars = {}): string {
  return dictionaries[language][key].replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** A counted sentence: `key.one` for exactly one, `key.other` otherwise. */
export function counted(
  language: Language,
  key: 'summary.waiting' | 'summary.results' | 'summary.running',
  count: number,
): string {
  return text(language, `${key}.${count === 1 ? 'one' : 'other'}`, { count });
}
