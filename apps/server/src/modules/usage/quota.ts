import type { AgentQuota, QuotaFreshness, QuotaWindow } from '@agent-studio/protocol';

/**
 * What an agent's own program says about the limits of its account, reduced
 * to the few things the Studio can stand behind. Pure functions.
 *
 * The input is the `info` of a `rate-limit.observed` event on
 * `internal:usage`, as the two adapters document it:
 *
 * - Claude Code passes on the CLI's `rate_limit_info`:
 *   `{ status, rateLimitType, resetsAt, isUsingOverage, unifiedWindows: { <id>: { utilization, resetsAt } } }`
 *   — utilisation is a fraction 0–1, times are **seconds** since the epoch.
 * - Codex passes on `{ limitId, limitName, planType, primary, secondary, credits, reached }` with
 *   `primary`/`secondary` = `{ usedPercent, windowMinutes, resetsAt }` — percent 0–100, times in
 *   **milliseconds**. A report is sparse: a window that is null was not mentioned.
 *
 * Which reading applies is decided by the shape, not by the agent's name, so
 * another adapter that reports in one of the two shapes is understood too.
 * Everything else is left out: an unknown field is never guessed at, a value
 * of the wrong type or outside what is plausible becomes null, and a report
 * in which nothing is recognised yields nothing at all.
 */

export interface StoredWindow {
  readonly id: string;
  readonly usedFraction: number | null;
  readonly resetsAt: number | null;
  readonly windowMinutes: number | null;
  readonly observedAt: number;
}

export interface StoredQuota {
  readonly windows: StoredWindow[];
  readonly status: 'allowed' | 'warning' | 'limited' | null;
  readonly limitingWindow: string | null;
  readonly plan: string | null;
  readonly usingOverage: boolean | null;
  readonly credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
}

const MAX_WINDOWS = 12;
/** A window nobody has mentioned for longer than this is forgotten: no window is longer than a week. */
const WINDOW_MEMORY_MS = 8 * 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

// Instants between 2020 and 2100, in each unit. A value outside is not a time in that unit.
const SECONDS_RANGE = [1_577_836_800, 4_102_444_800] as const;
const MILLIS_RANGE = [SECONDS_RANGE[0] * 1000, SECONDS_RANGE[1] * 1000] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const windowId = (value: unknown): string | null => (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(value) ? value : null);

function fraction(value: unknown, scale: number): number | null {
  const number = finite(value);
  if (number === null || number < 0) return null;
  // A window can be over-used; "full" is all there is to say about it.
  return Math.min(1, number / scale);
}

function instantFromSeconds(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= SECONDS_RANGE[0] && number <= SECONDS_RANGE[1] ? Math.round(number * 1000) : null;
}

function instantFromMillis(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= MILLIS_RANGE[0] && number <= MILLIS_RANGE[1] ? Math.round(number) : null;
}

function minutes(value: unknown): number | null {
  const number = finite(value);
  return number !== null && Number.isInteger(number) && number > 0 && number <= 366 * 24 * 60 ? number : null;
}

/** The length a window's own name states: `five_hour`, `seven_day`, `seven_day_opus`. */
function minutesFromName(id: string): number | null {
  if (/^five_hour(_|$)/.test(id)) return 300;
  if (/^seven_day(_|$)/.test(id)) return 10_080;
  return null;
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text !== '' && text.length <= max && /^[\p{L}\p{N} ._+-]+$/u.test(text) ? text : null;
}

/** The two readings. Each returns the windows it recognised; `null` when the shape is not its own. */
function fromClaudeShape(info: Record<string, unknown>, observedAt: number): Omit<StoredQuota, 'plan' | 'credits'> | null {
  const unified = isRecord(info.unifiedWindows) ? info.unifiedWindows : null;
  const deciding = windowId(info.rateLimitType);
  if (!unified && deciding === null && typeof info.status !== 'string') return null;
  const windows: StoredWindow[] = [];
  for (const [key, raw] of Object.entries(unified ?? {})) {
    const id = windowId(key);
    if (id === null || !isRecord(raw) || windows.length >= MAX_WINDOWS) continue;
    const usedFraction = fraction(raw.utilization, 1);
    const resetsAt = instantFromSeconds(raw.resetsAt);
    if (usedFraction === null && resetsAt === null) continue;
    windows.push({ id, usedFraction, resetsAt, windowMinutes: minutesFromName(id), observedAt });
  }
  // The window that decided the status may be named without being among the unified ones.
  if (deciding !== null && !windows.some((window) => window.id === deciding)) {
    const resetsAt = instantFromSeconds(info.resetsAt);
    if (resetsAt !== null && windows.length < MAX_WINDOWS) windows.push({ id: deciding, usedFraction: null, resetsAt, windowMinutes: minutesFromName(deciding), observedAt });
  }
  const status = info.status === 'allowed' ? 'allowed' : info.status === 'allowed_warning' ? 'warning' : info.status === 'rejected' ? 'limited' : null;
  if (windows.length === 0 && status === null) return null;
  return {
    windows,
    status,
    limitingWindow: deciding !== null && windows.some((window) => window.id === deciding) ? deciding : null,
    usingOverage: typeof info.isUsingOverage === 'boolean' ? info.isUsingOverage : null,
  };
}

function fromCodexShape(info: Record<string, unknown>, observedAt: number): StoredQuota | null {
  if (!('primary' in info) && !('secondary' in info) && !('credits' in info) && !('reached' in info)) return null;
  const windows: StoredWindow[] = [];
  for (const id of ['primary', 'secondary'] as const) {
    const raw = info[id];
    if (!isRecord(raw)) continue;
    const usedFraction = fraction(raw.usedPercent, 100);
    const resetsAt = instantFromMillis(raw.resetsAt);
    if (usedFraction === null && resetsAt === null) continue;
    windows.push({ id, usedFraction, resetsAt, windowMinutes: minutes(raw.windowMinutes), observedAt });
  }
  const rawCredits = isRecord(info.credits) ? info.credits : null;
  const credits =
    rawCredits && typeof rawCredits.hasCredits === 'boolean' && typeof rawCredits.unlimited === 'boolean'
      ? {
          hasCredits: rawCredits.hasCredits,
          unlimited: rawCredits.unlimited,
          balance: typeof rawCredits.balance === 'string' && /^-?\d{1,12}(\.\d{1,6})?$/.test(rawCredits.balance) ? rawCredits.balance : null,
        }
      : null;
  const reached = typeof info.reached === 'string' && info.reached.trim() !== '';
  const plan = shortText(info.planType, 40);
  if (windows.length === 0 && credits === null && !reached && plan === null) return null;
  return { windows, status: reached ? 'limited' : null, limitingWindow: null, plan, usingOverage: null, credits };
}

/** One report, normalised. Null when nothing in it was recognised. */
export function normaliseRateLimitInfo(info: unknown, observedAt: number): StoredQuota | null {
  if (!isRecord(info)) return null;
  const claude = fromClaudeShape(info, observedAt);
  if (claude) return { ...claude, plan: null, credits: null };
  return fromCodexShape(info, observedAt);
}

/**
 * The newest report laid over what was known. A report replaces the windows
 * it mentions and says nothing about the others, so those are kept — each
 * with the time it was itself reported — until nobody has mentioned them for
 * {@link WINDOW_MEMORY_MS}. What the program says about its status is never
 * carried over from an older report.
 */
export function mergeQuota(previous: StoredQuota | null, next: StoredQuota, observedAt: number): StoredQuota {
  const mentioned = new Set(next.windows.map((window) => window.id));
  const kept = (previous?.windows ?? []).filter((window) => !mentioned.has(window.id) && observedAt - window.observedAt <= WINDOW_MEMORY_MS);
  return {
    windows: [...next.windows, ...kept].slice(0, MAX_WINDOWS),
    status: next.status,
    limitingWindow: next.limitingWindow,
    plan: next.plan ?? previous?.plan ?? null,
    usingOverage: next.usingOverage,
    credits: next.credits ?? previous?.credits ?? null,
  };
}

/** Reads back what {@link mergeQuota} produced and was stored as JSON; anything else is treated as nothing. */
export function parseStoredQuota(json: string): StoredQuota | null {
  try {
    const value = JSON.parse(json) as unknown;
    if (!isRecord(value) || !Array.isArray(value.windows)) return null;
    return value as unknown as StoredQuota;
  } catch {
    return null;
  }
}

// ---- words -------------------------------------------------------------------

/** A plain English name for a window, from its length when that is known and from its id otherwise. */
export function windowLabel(id: string, windowMinutes: number | null): string {
  const qualifier = /^(?:five_hour|seven_day)_(.+)$/.exec(id)?.[1]?.replace(/_/g, ' ');
  const suffix = qualifier ? ` (${qualifier})` : '';
  if (windowMinutes === 300) return `5-hour window${suffix}`;
  if (windowMinutes === 10_080) return `Weekly window${suffix}`;
  if (windowMinutes === 1440) return `Daily window${suffix}`;
  if (windowMinutes !== null) {
    const amount = windowMinutes % 1440 === 0 ? `${windowMinutes / 1440}-day` : windowMinutes % 60 === 0 ? `${windowMinutes / 60}-hour` : `${windowMinutes}-minute`;
    return `${amount} window`;
  }
  const words = id.replace(/[_-]+/g, ' ').trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} window`;
}

/** "42 minutes", "3 hours", "2 days": how long ago, in the largest unit that fits. */
export function ago(ms: number): string {
  const count = (value: number, unit: string): string => `${value} ${unit}${value === 1 ? '' : 's'}`;
  if (ms < MINUTE) return 'less than a minute';
  if (ms < 60 * MINUTE) return count(Math.floor(ms / MINUTE), 'minute');
  if (ms < 48 * 60 * MINUTE) return count(Math.floor(ms / (60 * MINUTE)), 'hour');
  return count(Math.floor(ms / (24 * 60 * MINUTE)), 'day');
}

const utcTime = (instant: number): string => `${new Date(instant).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export interface Freshness {
  readonly state: QuotaFreshness;
  readonly staleCode: 'old' | 'reset-passed' | null;
  readonly staleReason: string | null;
}

/**
 * Whether a reading can still be shown as current. A reset time that has
 * passed makes it stale whatever its age: the figure describes a window that
 * is over. Otherwise age decides.
 */
export function assessFreshness(input: { quota: StoredQuota | null; observedAt: number | null; now: number; staleAfterMs: number; agentName: string }): Freshness {
  const { quota, observedAt, now, staleAfterMs, agentName } = input;
  if (!quota || observedAt === null) {
    return { state: 'none', staleCode: null, staleReason: `${agentName} has not reported its limits yet. It does so while it runs.` };
  }
  const over = quota.windows.filter((window) => window.resetsAt !== null && window.resetsAt <= now).sort((a, b) => (a.resetsAt ?? 0) - (b.resetsAt ?? 0))[0];
  if (over) {
    return {
      state: 'stale',
      staleCode: 'reset-passed',
      staleReason: `The ${windowLabel(over.id, over.windowMinutes).toLowerCase()} this reading describes was due to start again at ${utcTime(over.resetsAt!)}, so the figure is out of date. It is renewed the next time ${agentName} runs.`,
    };
  }
  if (now - observedAt > staleAfterMs) {
    return {
      state: 'stale',
      staleCode: 'old',
      staleReason: `${agentName} reported this ${ago(now - observedAt)} ago, and the account may have been used since. It is renewed the next time ${agentName} runs.`,
    };
  }
  return { state: 'fresh', staleCode: null, staleReason: null };
}

export const REFRESH_HINT =
  'The Studio asks no usage service. These figures are what the agent itself reports while it runs, so they are renewed by its next run.';

/** A stored reading as a client gets it. */
export function presentQuota(input: {
  agentId: string;
  agentName: string;
  available: boolean;
  quota: StoredQuota | null;
  observedAt: number | null;
  now: number;
  staleAfterMs: number;
}): AgentQuota {
  const { quota, now } = input;
  const freshness = assessFreshness({ quota, observedAt: input.observedAt, now, staleAfterMs: input.staleAfterMs, agentName: input.agentName });
  const windows: QuotaWindow[] = (quota?.windows ?? []).map((window) => ({
    id: window.id,
    label: windowLabel(window.id, window.windowMinutes),
    usedFraction: window.usedFraction,
    remainingFraction: window.usedFraction === null ? null : Math.max(0, 1 - window.usedFraction),
    resetsAt: window.resetsAt,
    windowMinutes: window.windowMinutes,
    observedAt: window.observedAt,
    resetPassed: window.resetsAt !== null && window.resetsAt <= now,
  }));
  return {
    agentId: input.agentId,
    agentName: input.agentName,
    available: input.available,
    state: freshness.state,
    staleCode: freshness.staleCode,
    staleReason: freshness.staleReason,
    observedAt: quota ? input.observedAt : null,
    refreshable: false,
    refreshHint: REFRESH_HINT,
    windows,
    status: quota?.status ?? null,
    limitingWindow: quota?.limitingWindow ?? null,
    plan: quota?.plan ?? null,
    usingOverage: quota?.usingOverage ?? null,
    credits: quota?.credits ?? null,
  };
}

/** The window a one-line summary speaks of: the fullest one that has not started again. */
export function fullestWindow(quota: AgentQuota): QuotaWindow | null {
  let fullest: QuotaWindow | null = null;
  for (const window of quota.windows) {
    if (window.usedFraction === null || window.resetPassed) continue;
    if (fullest === null || window.usedFraction > (fullest.usedFraction ?? 0)) fullest = window;
  }
  return fullest;
}
