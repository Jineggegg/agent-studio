import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  NOTIFICATION_PREFERENCE_KEYS as KEYS,
  type NotificationChannel,
  type NotificationPreferences,
  type UpdateNotificationPreferencesRequest,
} from '@agent-studio/protocol';
import type { PreferencesService } from '../preferences/preferences.module.js';
import { type Language, isLanguage, languageFromHeader } from './texts.js';

/** The account preference the web client keeps the chosen language in. Absent: "same as the device". */
const LANGUAGE_PREFERENCE = 'appearance.language';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Only booleans under known names survive: the preference store holds whatever a client wrote. */
function switchesOf<K extends string>(value: unknown, names: readonly K[]): Partial<Record<K, boolean>> {
  const result: Partial<Record<K, boolean>> = {};
  if (!isRecord(value)) return result;
  for (const name of names) {
    const entry = value[name];
    if (typeof entry === 'boolean') result[name] = entry;
  }
  return result;
}

/**
 * Notification switches, kept in the account's preferences under the keys of
 * {@link KEYS} so that they follow the user to every device and other open
 * pages are told when they change. Only what the user has set is stored;
 * everything else comes from the defaults, which is how `backgroundFinished`
 * can follow `replyFinished` until it is set.
 */
export class NotificationSwitches {
  readonly #preferences: PreferencesService;

  constructor(preferences: PreferencesService) {
    this.#preferences = preferences;
  }

  read(userId: string): NotificationPreferences {
    const all = this.#preferences.all(userId);
    const events = switchesOf(all[KEYS.events], NOTIFICATION_EVENTS);
    const channels = switchesOf(all[KEYS.channels], NOTIFICATION_CHANNELS);
    const defaults = DEFAULT_NOTIFICATION_PREFERENCES;
    const replyFinished = events.replyFinished ?? defaults.events.replyFinished;
    return {
      events: {
        needsYou: events.needsYou ?? defaults.events.needsYou,
        replyFinished,
        backgroundFinished: events.backgroundFinished ?? replyFinished,
        failure: events.failure ?? defaults.events.failure,
        automation: events.automation ?? defaults.events.automation,
        plugin: events.plugin ?? defaults.events.plugin,
      },
      channels: {
        inApp: channels.inApp ?? defaults.channels.inApp,
        webPush: channels.webPush ?? defaults.channels.webPush,
      },
      showDetails: typeof all[KEYS.showDetails] === 'boolean' ? (all[KEYS.showDetails] as boolean) : defaults.showDetails,
    };
  }

  /** Changes only the switches named. Returns what is in force afterwards. */
  update(userId: string, patch: UpdateNotificationPreferencesRequest): NotificationPreferences {
    const all = this.#preferences.all(userId);
    const values: Record<string, unknown> = {};
    if (patch.events !== undefined) values[KEYS.events] = { ...switchesOf(all[KEYS.events], NOTIFICATION_EVENTS), ...definedOnly(patch.events) };
    if (patch.channels !== undefined) values[KEYS.channels] = { ...switchesOf(all[KEYS.channels], NOTIFICATION_CHANNELS), ...definedOnly(patch.channels) };
    if (patch.showDetails !== undefined) values[KEYS.showDetails] = patch.showDetails;
    if (Object.keys(values).length > 0) this.#preferences.patch(userId, values);
    return this.read(userId);
  }

  setChannel(userId: string, channel: NotificationChannel, enabled: boolean): void {
    if (this.read(userId).channels[channel] === enabled) return;
    this.update(userId, { channels: channel === 'inApp' ? { inApp: enabled } : { webPush: enabled } });
  }

  /**
   * The language to write a notification in: the one the user chose in the
   * app; failing that the language of the browser that last set up
   * notifications; failing that English.
   */
  language(userId: string): Language {
    const chosen = this.#preferences.get<unknown>(userId, LANGUAGE_PREFERENCE);
    if (isLanguage(chosen)) return chosen;
    const noted = this.#preferences.get<unknown>(userId, KEYS.language);
    return isLanguage(noted) ? noted : 'en';
  }

  /** Remembers the browser's language, for accounts that left the app's language on "same as the device". */
  noteBrowserLanguage(userId: string, acceptLanguage: string | undefined): void {
    const language = languageFromHeader(acceptLanguage);
    if (language === null || this.#preferences.get<unknown>(userId, KEYS.language) === language) return;
    this.#preferences.patch(userId, { [KEYS.language]: language });
  }
}

function definedOnly<T extends object>(value: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) (result as Record<string, unknown>)[key] = entry;
  }
  return result;
}
