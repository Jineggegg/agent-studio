import type { UsageBucket, UsageCost, UsagePeriod } from '@agent-studio/protocol';
import type { Translator } from '@/i18n';

/**
 * Turning usage figures into what a chart draws — kept apart from the
 * drawing so the rules can be tested: every bucket of the range is a column
 * (none is dropped), and a cost nobody knows is never drawn as zero.
 */

export type Metric = 'tokens' | 'cost';

/**
 * `value`    a figure to draw
 * `zero`     known, and nothing (a priced run that cost nothing)
 * `partial`  some runs have a cost and some do not: the figure is a lower bound
 * `unknown`  runs happened but none has a cost: there is no figure — not zero
 * `none`     no runs at all
 */
export type DatumState = 'value' | 'zero' | 'partial' | 'unknown' | 'none';

export interface ColumnDatum {
  key: string;
  /** Under the column. */
  label: string;
  /** In the read-out and the table. */
  longLabel: string;
  /** The column's height in the chosen metric; 0 when there is nothing to draw. */
  value: number;
  state: DatumState;
  /** The bucket that contains now: its figures are still growing. */
  current: boolean;
  bucket: UsageBucket;
}

const parseDay = (key: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12) : null;
};
const parseMonth = (key: string): number | null => {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, 15, 12) : null;
};
const format = (instant: number, language: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(language, { ...options, timeZone: 'UTC' }).format(instant);

/**
 * A bucket's name. The key is a calendar date (or month) in the report's own
 * zone, so it is read as one — never converted through this device's zone,
 * which could move it to the day before.
 */
export function bucketLabel(key: string, period: UsagePeriod, t: Translator, long = false): string {
  const language = t.language;
  if (period === 'month') {
    const instant = parseMonth(key);
    if (instant === null) return key;
    return format(instant, language, long ? { month: 'long', year: 'numeric' } : { month: 'short' });
  }
  const instant = parseDay(key);
  if (instant === null) return key;
  if (period === 'week') {
    const day = format(instant, language, long ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
    return long ? t('usage.bucket.week', { day }) : day;
  }
  return format(instant, language, long ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' } : { month: 'numeric', day: 'numeric' });
}

export function costState(cost: UsageCost): DatumState {
  switch (cost.coverage) {
    case 'none':
      return 'none';
    case 'unknown':
      return 'unknown';
    case 'partial':
      return 'partial';
    case 'complete':
      return (cost.usd ?? 0) === 0 ? 'zero' : 'value';
  }
}

export function shapeBuckets(buckets: readonly UsageBucket[], period: UsagePeriod, metric: Metric, t: Translator): ColumnDatum[] {
  return buckets.map((bucket) => {
    let state: DatumState;
    let value: number;
    if (metric === 'tokens') {
      state = bucket.runs === 0 && bucket.totalTokens === 0 ? 'none' : bucket.totalTokens === 0 ? 'zero' : 'value';
      value = bucket.totalTokens;
    } else {
      state = costState(bucket.cost);
      value = state === 'value' || state === 'partial' ? (bucket.cost.usd ?? 0) : 0;
    }
    return { key: bucket.key, label: bucketLabel(bucket.key, period, t), longLabel: bucketLabel(bucket.key, period, t, true), value, state, current: bucket.current, bucket };
  });
}

/** Round axis steps (1, 2, 2.5, 5 × a power of ten) from zero to at least `max`. */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10) * magnitude;
  const ticks: number[] = [];
  for (let value = 0; value < max + step / 2; value += step) ticks.push(Number(value.toPrecision(12)));
  if (ticks[ticks.length - 1]! < max) ticks.push(Number((ticks[ticks.length - 1]! + step).toPrecision(12)));
  return ticks;
}

/** 1.2K, 3.4M — for axes, tiles and tight rows. */
export function compactNumber(value: number, t: Translator): string {
  return t.number(value, { notation: 'compact', maximumFractionDigits: value >= 1000 ? 1 : 0 });
}

/** US dollars, with cents — or a little more precision for amounts below a dollar. */
export function usd(value: number, t: Translator): string {
  return t.number(value, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 1 ? 4 : 2 });
}

/** What runs cost, in words that keep "unknown" apart from zero and mark a lower bound as one. */
export function costText(cost: UsageCost, t: Translator): string {
  switch (cost.coverage) {
    case 'none':
      return t('usage.cost.none');
    case 'unknown':
      return t('usage.cost.unknown');
    case 'partial':
      return t('usage.cost.atLeast', { amount: usd(cost.usd ?? 0, t) });
    case 'complete':
      return usd(cost.usd ?? 0, t);
  }
}

/** One sentence on how far a cost can be trusted, or null when it is complete or there is none. */
export function costCaveat(cost: UsageCost, t: Translator): string | null {
  if (cost.coverage === 'unknown') return t.plural('usage.cost.unknownCaveat', cost.unpricedRuns);
  if (cost.coverage === 'partial') return t.plural('usage.cost.partialCaveat', cost.unpricedRuns);
  return null;
}

/** The largest figure to scale columns against: at least 1, so an empty range still has an axis. */
export function columnMax(data: readonly ColumnDatum[]): number {
  return Math.max(1e-9, ...data.map((datum) => datum.value));
}
