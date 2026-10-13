import { create } from 'zustand';
import { en } from './en';
import { zhCN } from './zh-CN';

/**
 * Interface strings. Every string a user can read goes through here.
 *
 *   const t = useT();
 *   t('home.newProject')
 *   t('settings.devices.lastSeen', { when: t.relative(session.lastSeenAt) })
 *   t.plural('home.projectCount', projects.length)   // picks ….one / ….other
 *
 * `en.ts` defines the keys; `zh-CN.ts` must define exactly the same ones (the
 * compiler and a test both check). To add a language: add a dictionary, add
 * it to `dictionaries` and `LANGUAGES`.
 */

export type MessageKey = keyof typeof en;
export type Language = 'en' | 'zh-CN';
export type LanguagePreference = Language | 'auto';
export type MessageVars = Record<string, string | number>;

/** Keys that have plural forms: "x.one" and "x.other" exist, and you ask for "x". */
export type PluralKey = {
  [K in MessageKey]: K extends `${infer Base}.other` ? Base : never;
}[MessageKey];

export const LANGUAGES: readonly { code: Language; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'zh-CN', name: '简体中文' },
];

export const dictionaries: Record<Language, Record<MessageKey, string>> = { en, 'zh-CN': zhCN };

/** Shared with public/boot.js. */
export const LANGUAGE_STORAGE_KEY = 'studio.language';
export const LANGUAGE_PREFERENCE_KEY = 'appearance.language';

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'zh-CN';
}

export function parseLanguagePreference(value: unknown): LanguagePreference {
  return isLanguage(value) ? value : 'auto';
}

/** The best supported language for a list of browser language tags, in the browser's order of preference. */
export function matchLanguage(tags: readonly string[]): Language {
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (lower.startsWith('zh')) return 'zh-CN';
    if (lower.startsWith('en')) return 'en';
  }
  return 'en';
}

export function browserLanguage(): Language {
  if (typeof navigator === 'undefined') return 'en';
  return matchLanguage(navigator.languages?.length ? navigator.languages : [navigator.language ?? 'en']);
}

function interpolate(template: string, vars: MessageVars | undefined): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

export function translate(language: Language, key: MessageKey, vars?: MessageVars): string {
  const template = dictionaries[language][key] ?? en[key] ?? key;
  return interpolate(template, vars);
}

/** True when `key` is a message. Lets callers look up keys built from server data (error codes, say). */
export function hasMessage(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

export type DateStyle = 'date' | 'time' | 'dateTime' | 'weekday' | 'monthDay' | 'short';

const DATE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  date: { year: 'numeric', month: 'long', day: 'numeric' },
  time: { hour: 'numeric', minute: '2-digit' },
  dateTime: { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  weekday: { weekday: 'long' },
  monthDay: { month: 'long', day: 'numeric' },
  short: { month: 'short', day: 'numeric' },
};

const RELATIVE_STEPS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

export interface Translator {
  (key: MessageKey, vars?: MessageVars): string;
  readonly language: Language;
  /** Chooses the plural form for `count` and fills `{count}` (formatted) plus any other variables. */
  plural(key: PluralKey, count: number, vars?: MessageVars): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /** Formats a timestamp (ms since the epoch) or Date. */
  date(value: number | Date, style?: DateStyle): string;
  /** "3 minutes ago", "in 2 hours", "just now". */
  relative(value: number | Date, now?: number): string;
  /** A duration in seconds as "45 seconds", "3 minutes", "2 hours". */
  duration(seconds: number): string;
  list(items: readonly string[], type?: 'conjunction' | 'disjunction'): string;
}

const translators = new Map<Language, Translator>();

export function getTranslator(language: Language): Translator {
  const cached = translators.get(language);
  if (cached) return cached;

  const pluralRules = new Intl.PluralRules(language);
  const numberFormats = new Map<string, Intl.NumberFormat>();
  const dateFormats = new Map<DateStyle, Intl.DateTimeFormat>();
  const relativeFormat = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });

  const number = (value: number, options?: Intl.NumberFormatOptions): string => {
    const cacheKey = options ? JSON.stringify(options) : '';
    let format = numberFormats.get(cacheKey);
    if (!format) numberFormats.set(cacheKey, (format = new Intl.NumberFormat(language, options)));
    return format.format(value);
  };

  const t = ((key: MessageKey, vars?: MessageVars) => translate(language, key, vars)) as Translator & { language: Language };
  Object.defineProperty(t, 'language', { value: language, enumerable: true });

  t.plural = (key, count, vars) => {
    const form = pluralRules.select(count);
    const exact = `${key}.${form}`;
    const chosen = (hasMessage(exact) ? exact : `${key}.other`) as MessageKey;
    return translate(language, chosen, { count: number(count), ...vars });
  };
  t.number = number;
  t.date = (value, style = 'date') => {
    let format = dateFormats.get(style);
    if (!format) dateFormats.set(style, (format = new Intl.DateTimeFormat(language, DATE_OPTIONS[style])));
    return format.format(value);
  };
  t.relative = (value, now = Date.now()) => {
    const seconds = Math.round(((typeof value === 'number' ? value : value.getTime()) - now) / 1000);
    const magnitude = Math.abs(seconds);
    if (magnitude < 45) return translate(language, 'common.justNow');
    for (const [unit, size] of RELATIVE_STEPS) {
      if (magnitude >= size) return relativeFormat.format(Math.trunc(seconds / size), unit);
    }
    return relativeFormat.format(Math.sign(seconds), 'minute');
  };
  t.duration = (seconds) => {
    const whole = Math.max(1, Math.round(seconds));
    const [value, unit]: [number, 'second' | 'minute' | 'hour'] =
      whole < 90 ? [whole, 'second'] : whole < 5400 ? [Math.round(whole / 60), 'minute'] : [Math.round(whole / 3600), 'hour'];
    return number(value, { style: 'unit', unit, unitDisplay: 'long' });
  };
  t.list = (items, type = 'conjunction') => new Intl.ListFormat(language, { style: 'long', type }).format(items);

  translators.set(language, t);
  return t;
}

interface LanguageState {
  preference: LanguagePreference;
  language: Language;
}

function storedLanguage(): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function initialLanguage(): LanguageState {
  const preference = parseLanguagePreference(storedLanguage());
  return { preference, language: preference === 'auto' ? browserLanguage() : preference };
}

export const useLanguageStore = create<LanguageState>(initialLanguage);

/** Switch language. Applies without a reload and is remembered on the device. */
export function applyLanguagePreference(preference: LanguagePreference): void {
  const language = preference === 'auto' ? browserLanguage() : preference;
  try {
    if (preference === 'auto') window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    else window.localStorage.setItem(LANGUAGE_STORAGE_KEY, preference);
  } catch {
    /* ignore */
  }
  if (typeof document !== 'undefined') document.documentElement.lang = language;
  const previous = useLanguageStore.getState();
  if (previous.language !== language || previous.preference !== preference) useLanguageStore.setState({ preference, language });
}

/** The translator for the current language. Its identity changes only when the language does. */
export function useT(): Translator {
  return getTranslator(useLanguageStore((state) => state.language));
}

/** For code outside React (toasts raised from a store, the document title). */
export function currentTranslator(): Translator {
  return getTranslator(useLanguageStore.getState().language);
}

export const useLanguage = (): Language => useLanguageStore((state) => state.language);
export const useLanguagePreference = (): LanguagePreference => useLanguageStore((state) => state.preference);
