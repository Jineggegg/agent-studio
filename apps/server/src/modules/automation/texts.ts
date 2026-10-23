import type { Language } from '../inbox/texts.js';

/**
 * The sentences the automation module writes: the one-paragraph summary of
 * each execution, the reason a deferred message failed, and the wording of
 * its notifications. Written when the thing happens, in the language of the
 * automation's creator.
 */

type Vars = Readonly<Record<string, string | number>>;

const en = {
  // summaries: notify
  'notified.external': 'Delivered through {count} configured notification channels.',
  'notified.app': 'Sent “{message}” to the notification list in the app.',
  'notified.devices.one': 'Sent “{message}” to 1 device.',
  'notified.devices.other': 'Sent “{message}” to {count} devices.',
  'notified.both.one': 'Sent “{message}” to the app and 1 device.',
  'notified.both.other': 'Sent “{message}” to the app and {count} devices.',
  'quiet.eventOff':
    'Not sent: notifications about automations are switched off in the creator’s settings.',
  'quiet.channelsOff':
    'Not sent: every notification channel is switched off in the creator’s settings.',
  'failed.notDelivered':
    'Not delivered: no device’s push service accepted the message, and the list in the app is switched off.',
  // summaries: agent runs
  started: '{agent} is working in “{session}” ({mode}).',
  completed: '{agent} finished in “{session}”.',
  'denied.approval.one':
    '{agent} finished in “{session}”, but 1 action needed approval and was denied because nobody was there to give it.',
  'denied.approval.other':
    '{agent} finished in “{session}”, but {count} actions needed approval and were denied because nobody was there to give it.',
  'failed.run': '{agent} failed in “{session}”: {error}',
  'failed.stopped': 'The run in “{session}” was stopped before it finished.',
  'failed.interrupted':
    'The server restarted while this was running. Nothing was run again; open the session to see how far it got.',
  'failed.interruptedBeforeStart':
    'The server stopped before this could start. It was not run again.',
  'failed.error': 'It could not be started: {error}',
  // summaries: guard rails
  'denied.automationOff': 'Not run: automations are switched off for this project.',
  'denied.projectArchived': 'Not run: the project is archived.',
  'denied.creatorDisabled':
    'Not run: the account of {creator}, who created this automation, is disabled or gone.',
  'denied.accessLost':
    'Not run: {creator}, who created this automation, no longer has write access to this project.',
  'denied.accessLostRead':
    'Not sent: {creator}, who created this automation, can no longer see this project.',
  'denied.agentUnavailable': 'Not run: {agent} is not available on this Studio.',
  'denied.agentNotEnabled': 'Not run: {agent} is not offered in this project any more.',
  'denied.modeNotAllowed':
    'Not run: the mode “{mode}” needs auto mode, which the project’s owner has not enabled.',
  'denied.modeNotSupported': 'Not run: {agent} does not have the mode “{mode}”.',
  'denied.sessionGone':
    'Not run: the session it was to continue no longer exists or is not the creator’s own.',
  // summaries: skipped, missed
  'skipped.stillRunning': 'Skipped: the previous run of this automation was still going.',
  'skipped.sessionBusy': 'Skipped: the session “{session}” was busy with another turn.',
  'missed.one': 'Missed the run of {when}: the server was not running.',
  'missed.other': 'Missed the run of {when} and {count} before it: the server was not running.',
  'missed.earlier.one':
    'Missed 1 earlier run (of {when}): the server was not running. The most recent one is made up now.',
  'missed.earlier.other':
    'Missed {count} earlier runs (since {when}): the server was not running. The most recent one is made up now.',
  'event.runFailed': 'A run failed',
  // notifications
  'notify.reminder': 'Reminder from “{name}”',
  'notify.finished': '“{name}” finished',
  'notify.denied': '“{name}” finished, but some actions were denied',
  'notify.failed': '“{name}” failed',
  'notify.notRun': '“{name}” did not run',
  'notify.deferredNotSent': 'A scheduled message could not be sent',
  // deferred
  'deferred.sessionGone': 'The session no longer exists.',
  'deferred.accountDisabled': 'The account is disabled.',
  'deferred.accessLost': 'You no longer have write access to the project.',
  'deferred.automationOff': 'Scheduled work is switched off for this project.',
  'deferred.agentUnavailable': 'The agent of this session is not available.',
  'deferred.queueFull': 'The session was busy and its queue was full.',
  'deferred.missed': 'The server was not running at the time, and came back too late.',
  'deferred.runStopped': 'The turn was stopped before it finished.',
  'deferred.interrupted': 'The server restarted during execution — review before continuing.',
  'deferred.interruptedBeforeSend':
    'The server stopped before this message could be sent. It was not sent.',
  'deferred.withdrawn': 'The message was removed from the session’s queue.',
} as const;

export type AutomationTextKey = keyof typeof en;

const zhCN: Record<AutomationTextKey, string> = {
  'notified.external': '已通过 {count} 个已配置的通知渠道送达。',
  'notified.app': '已把“{message}”发到应用内的通知列表。',
  'notified.devices.one': '已把“{message}”发到 1 台设备。',
  'notified.devices.other': '已把“{message}”发到 {count} 台设备。',
  'notified.both.one': '已把“{message}”发到应用内和 1 台设备。',
  'notified.both.other': '已把“{message}”发到应用内和 {count} 台设备。',
  'quiet.eventOff': '未发送：创建者在设置里关闭了自动化提醒。',
  'quiet.channelsOff': '未发送：创建者在设置里关闭了所有通知渠道。',
  'failed.notDelivered': '未送达：没有设备的推送服务接受这条消息，应用内列表也已关闭。',
  started: '{agent} 正在“{session}”中工作（{mode}）。',
  completed: '{agent} 已在“{session}”中完成。',
  'denied.approval.one':
    '{agent} 已在“{session}”中完成，但有 1 项操作需要审批，当时无人在场，已被拒绝。',
  'denied.approval.other':
    '{agent} 已在“{session}”中完成，但有 {count} 项操作需要审批，当时无人在场，已被拒绝。',
  'failed.run': '{agent} 在“{session}”中失败：{error}',
  'failed.stopped': '“{session}”中的任务在完成前被停止。',
  'failed.interrupted': '执行期间服务重启。没有重新运行；请打开会话查看进度。',
  'failed.interruptedBeforeStart': '服务在它开始前停止了，没有重新运行。',
  'failed.error': '无法启动：{error}',
  'denied.automationOff': '未运行：此项目已关闭自动化。',
  'denied.projectArchived': '未运行：项目已归档。',
  'denied.creatorDisabled': '未运行：创建这条自动化的 {creator} 的账号已停用或不存在。',
  'denied.accessLost': '未运行：创建这条自动化的 {creator} 已没有此项目的写入权限。',
  'denied.accessLostRead': '未发送：创建这条自动化的 {creator} 已看不到此项目。',
  'denied.agentUnavailable': '未运行：此 Studio 上没有可用的 {agent}。',
  'denied.agentNotEnabled': '未运行：此项目已不再提供 {agent}。',
  'denied.modeNotAllowed': '未运行：模式“{mode}”需要自动模式，而项目所有者没有开启。',
  'denied.modeNotSupported': '未运行：{agent} 没有“{mode}”模式。',
  'denied.sessionGone': '未运行：要继续的会话已不存在，或不属于创建者本人。',
  'skipped.stillRunning': '已跳过：这条自动化的上一次运行还没有结束。',
  'skipped.sessionBusy': '已跳过：会话“{session}”正在处理另一轮对话。',
  'missed.one': '错过了 {when} 的运行：当时服务没有运行。',
  'missed.other': '错过了 {when} 以及之前 {count} 次运行：当时服务没有运行。',
  'missed.earlier.one': '错过了更早的 1 次运行（{when}）：当时服务没有运行。现在补跑最近的一次。',
  'missed.earlier.other':
    '错过了更早的 {count} 次运行（自 {when} 起）：当时服务没有运行。现在补跑最近的一次。',
  'event.runFailed': '有任务失败',
  'notify.reminder': '来自“{name}”的提醒',
  'notify.finished': '“{name}”已完成',
  'notify.denied': '“{name}”已完成，但有操作被拒绝',
  'notify.failed': '“{name}”失败了',
  'notify.notRun': '“{name}”没有运行',
  'notify.deferredNotSent': '有一条定时消息没能发出',
  'deferred.sessionGone': '会话已不存在。',
  'deferred.accountDisabled': '账号已停用。',
  'deferred.accessLost': '你已没有此项目的写入权限。',
  'deferred.automationOff': '此项目已关闭定时任务。',
  'deferred.agentUnavailable': '此会话的助手不可用。',
  'deferred.queueFull': '会话正忙，且排队已满。',
  'deferred.missed': '当时服务没有运行，恢复得太晚。',
  'deferred.runStopped': '这一轮在完成前被停止。',
  'deferred.interrupted': '执行期间服务重启——继续之前请先检查。',
  'deferred.interruptedBeforeSend': '服务在这条消息发出前停止了，消息没有发出。',
  'deferred.withdrawn': '这条消息已从会话的队列中移除。',
};

const dictionaries: Record<Language, Record<AutomationTextKey, string>> = { en, 'zh-CN': zhCN };

export function say(language: Language, key: AutomationTextKey, vars: Vars = {}): string {
  return dictionaries[language][key].replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

type Counted = {
  [K in AutomationTextKey]: K extends `${infer Base}.other` ? Base : never;
}[AutomationTextKey];

/** A counted sentence: `key.one` for exactly one, `key.other` otherwise. */
export function sayCounted(
  language: Language,
  key: Counted,
  count: number,
  vars: Vars = {},
): string {
  return say(language, `${key}.${count === 1 ? 'one' : 'other'}` as AutomationTextKey, {
    count,
    ...vars,
  });
}
