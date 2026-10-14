import { type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject, useId, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { type ColumnDatum, niceTicks } from './shape';

/** The width an element has, kept current as it changes. */
function useWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(120, Math.round(element.getBoundingClientRect().width) || fallback));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, fallback]);
  return width;
}

const PLOT = 150;
const AXIS = 22;
const TOP = 10;
const LEFT = 46;

/** A column with a 4 px round on its data end and a square foot on the baseline. */
function columnPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

export interface ColumnChartProps {
  data: readonly ColumnDatum[];
  /** Names what is plotted ("Tokens per day"); the chart's accessible name. */
  title: string;
  format: (value: number) => string;
  /** The read-out line for a column: its figures in words. */
  describe: (datum: ColumnDatum) => string;
}

/**
 * One series of columns over time, drawn in SVG: thin columns from a single
 * baseline, a recessive grid, round axis steps. A column that has no figure
 * (its cost is unknown) is marked, never drawn as zero; the current bucket,
 * still growing, is drawn lighter. Pointer, touch and the arrow keys pick a
 * column, and its figures are read out above the chart; the table beneath
 * holds every figure without either.
 */
export function ColumnChart({ data, title, format, describe }: ColumnChartProps) {
  const t = useT();
  const frame = useRef<HTMLDivElement>(null);
  const width = useWidth(frame, 600);
  const titleId = useId();
  const [picked, setPicked] = useState<number | null>(null);
  const count = data.length;
  const plotWidth = Math.max(1, width - LEFT - 4);
  const band = count > 0 ? plotWidth / count : plotWidth;
  const barWidth = Math.max(2, Math.min(24, band - 2));
  const max = Math.max(0, ...data.map((datum) => datum.value));
  const ticks = niceTicks(max, 4);
  const top = ticks[ticks.length - 1] || 1;
  const y = (value: number) => TOP + PLOT - (value / top) * PLOT;
  const labelEvery = Math.max(1, Math.ceil(44 / band));
  const latest = count - 1;
  const shown = picked ?? latest;
  const active = shown >= 0 ? data[shown] : undefined;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = Math.max(0, shown - 1);
    else if (event.key === 'ArrowRight') next = Math.min(latest, shown + 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = latest;
    if (next === null) return;
    event.preventDefault();
    setPicked(next);
  };

  const peak = data.reduce<ColumnDatum | null>((best, datum) => (datum.value > 0 && (best === null || datum.value > best.value) ? datum : best), null);
  const summary = peak ? t('usage.chart.summary', { title, from: data[0]?.longLabel ?? '', to: data[latest]?.longLabel ?? '', peak: peak.longLabel, value: format(peak.value) }) : t('usage.chart.empty', { title });

  return (
    <figure className="use-chart">
      <figcaption className="use-chart__title" id={titleId}>
        {title}
      </figcaption>
      <p className="use-chart__readout" aria-live="polite">
        {active ? describe(active) : ''}
      </p>
      <div
        ref={frame}
        className="use-chart__frame"
        tabIndex={0}
        role="group"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-hint`}
        onKeyDown={onKeyDown}
        onPointerLeave={() => setPicked(null)}
      >
        <svg width={width} height={TOP + PLOT + AXIS} viewBox={`0 0 ${width} ${TOP + PLOT + AXIS}`} role="img" aria-label={summary}>
          {ticks.map((tick) => (
            <g key={tick} className="use-chart__tick">
              <line x1={LEFT} x2={width - 2} y1={y(tick)} y2={y(tick)} />
              <text x={LEFT - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                {format(tick)}
              </text>
            </g>
          ))}
          {data.map((datum, index) => {
            const x = LEFT + index * band + (band - barWidth) / 2;
            const height = datum.value > 0 ? Math.max(2, (datum.value / top) * PLOT) : 0;
            const selected = index === picked;
            return (
              <g key={datum.key} className="use-chart__column" data-state={datum.state} data-current={datum.current || undefined} data-picked={selected || undefined}>
                {selected && <rect className="use-chart__band" x={LEFT + index * band} y={TOP} width={band} height={PLOT} rx={4} />}
                {height > 0 && <path className="use-chart__bar" d={columnPath(x, TOP + PLOT - height, barWidth, height)} />}
                {datum.state === 'partial' && height > 0 && <line className="use-chart__floor" x1={x} x2={x + barWidth} y1={TOP + PLOT - height - 3} y2={TOP + PLOT - height - 3} />}
                {datum.state === 'unknown' && (
                  <g className="use-chart__unknown">
                    <circle cx={x + barWidth / 2} cy={TOP + PLOT - 8} r={Math.min(7, Math.max(4, barWidth / 2))} />
                    {barWidth >= 9 && (
                      <text x={x + barWidth / 2} y={TOP + PLOT - 8} dy="0.34em" textAnchor="middle">
                        ?
                      </text>
                    )}
                  </g>
                )}
                {(index % labelEvery === 0 || index === latest) && (index === latest || latest - index >= labelEvery) && (
                  <text className="use-chart__label" x={LEFT + index * band + band / 2} y={TOP + PLOT + 15} textAnchor="middle">
                    {datum.label}
                  </text>
                )}
                <rect
                  className="use-chart__hit"
                  x={LEFT + index * band}
                  y={0}
                  width={band}
                  height={TOP + PLOT + AXIS}
                  onPointerEnter={() => setPicked(index)}
                  onPointerMove={() => setPicked(index)}
                  onClick={() => setPicked(index)}
                />
              </g>
            );
          })}
          <line className="use-chart__baseline" x1={LEFT} x2={width - 2} y1={TOP + PLOT} y2={TOP + PLOT} />
        </svg>
      </div>
      <p className="visually-hidden" id={`${titleId}-hint`}>
        {t('usage.chart.keys')}
      </p>
    </figure>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  /** A second, quieter line under the label. */
  detail?: ReactNode;
  value: number;
  valueText: string;
  /** A second figure column (cost). */
  extra?: ReactNode;
}

/**
 * A breakdown as a table whose first figure carries a bar: the figures are
 * the table, the bars let the eye compare them. One colour for every row —
 * the rows are categories, not a scale.
 */
export function BarTable({ rows, caption, labelHeader, valueHeader, extraHeader }: { rows: readonly BarRow[]; caption: string; labelHeader: string; valueHeader: string; extraHeader?: string }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <table className="use-bars">
      <caption className="visually-hidden">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{labelHeader}</th>
          <th scope="col" className="use-bars__num">
            {valueHeader}
          </th>
          {extraHeader && (
            <th scope="col" className="use-bars__num">
              {extraHeader}
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <th scope="row">
              <span className="use-bars__label">{row.label}</span>
              {row.detail && <span className="use-bars__detail">{row.detail}</span>}
              <span className="use-bars__track" aria-hidden="true">
                <span className="use-bars__fill" style={{ '--share': row.value / max } as CSSProperties} />
              </span>
            </th>
            <td className="use-bars__num">{row.valueText}</td>
            {extraHeader && <td className="use-bars__num">{row.extra}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A single ratio against a limit. The fill says how much; its colour says
 * how worried to be — accent, then warning from 80 %, danger from 100 %.
 */
export function Meter({ fraction, label, valueText }: { fraction: number | null; label: string; valueText: string }) {
  const clamped = fraction === null ? 0 : Math.max(0, Math.min(1, fraction));
  const tone = fraction === null ? 'unknown' : fraction >= 1 ? 'danger' : fraction >= 0.8 ? 'warning' : 'normal';
  return (
    <div
      className="use-meter"
      data-tone={tone}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(fraction === null ? {} : { 'aria-valuenow': Math.round(clamped * 100) })}
      aria-valuetext={valueText}
    >
      <span className="use-meter__fill" style={{ '--fraction': clamped } as CSSProperties} />
    </div>
  );
}
