import type { Agent, ModelUsage } from '@agent-studio/protocol';
import { Gauge } from 'lucide-react';
import { type CSSProperties, useRef, useState } from 'react';
import { type Translator, useT } from '@/i18n';
import { findModel, modelLabel } from '../agents';
import { AdaptivePopover } from '../chat/parts';
import type { ContextReading } from '../transcript/model';

/** From here the ring warns; from the second figure it says the window is nearly full. */
export const CONTEXT_WARN = 0.8;
export const CONTEXT_FULL = 0.95;

export interface ContextLevel {
  /** 0–1, or null when the size of the window is not known. */
  fraction: number | null;
  window: number | null;
  tone: 'normal' | 'warning' | 'danger';
}

/**
 * How full the context window is. The window comes from the usage report
 * itself or, failing that, from what the agent says about the model — never
 * from a guess: with neither there is no percentage, only the token count.
 */
export function contextLevel(context: ContextReading | null, agent: Agent | undefined): ContextLevel {
  if (!context) return { fraction: null, window: null, tone: 'normal' };
  const window = context.window ?? findModel(agent, context.model)?.contextWindow ?? null;
  if (window === null || window <= 0) return { fraction: null, window: null, tone: 'normal' };
  const fraction = Math.min(1, Math.max(0, context.tokens / window));
  return { fraction, window, tone: fraction >= CONTEXT_FULL ? 'danger' : fraction >= CONTEXT_WARN ? 'warning' : 'normal' };
}

/** Whether there is anything at all to show about usage. */
export const hasUsage = (context: ContextReading | null, totals: readonly ModelUsage[]): boolean => context !== null || totals.length > 0;

const compact = (value: number, t: Translator): string => t.number(value, { notation: 'compact', maximumFractionDigits: 1 });

const RADIUS = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface ContextRingProps {
  context: ContextReading | null;
  totals: readonly ModelUsage[];
  agent: Agent | undefined;
}

/**
 * A small ring in the title bar: how full the session's context window is.
 * Its details open beside it — what is in the window, and what the session
 * has used in all. An agent that reports less gets less: no cost line without
 * a cost, no percentage without a window.
 */
export function ContextRing({ context, totals, agent }: ContextRingProps) {
  const t = useT();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!hasUsage(context, totals)) return null;

  const level = contextLevel(context, agent);
  const percent = level.fraction === null ? null : Math.round(level.fraction * 100);
  const label = percent === null ? t('workbench.usage.open') : t('workbench.usage.ringLabel', { percent: t.number(percent) });
  const total = totals.reduce(
    (sum, usage) => ({
      input: sum.input + usage.inputTokens,
      output: sum.output + usage.outputTokens,
      cacheRead: sum.cacheRead + usage.cacheReadTokens,
      cacheWrite: sum.cacheWrite + usage.cacheWriteTokens,
      cost: usage.costUsd === null ? sum.cost : (sum.cost ?? 0) + usage.costUsd,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null as number | null },
  );

  return (
    <>
      <button ref={anchor} type="button" className="wb-ring" data-tone={level.tone} aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        {level.fraction === null ? (
          <Gauge size={20} aria-hidden="true" />
        ) : (
          <>
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
              <circle className="wb-ring__track" cx="12" cy="12" r={RADIUS} />
              <circle className="wb-ring__value" cx="12" cy="12" r={RADIUS} style={{ strokeDasharray: `${CIRCUMFERENCE * level.fraction} ${CIRCUMFERENCE}` } as CSSProperties} />
            </svg>
            <span className="wb-ring__percent u-tabular">{t.number(percent!)}%</span>
          </>
        )}
      </button>
      <AdaptivePopover open={open} onClose={() => setOpen(false)} anchor={anchor} title={t('workbench.usage.title')} align="end" width={320}>
        <div className="wb-usage">
          {context && (
            <section>
              <h3>{t('workbench.usage.context')}</h3>
              {level.fraction !== null && level.window !== null ? (
                <>
                  <p className="wb-usage__headline u-tabular" data-tone={level.tone}>
                    {t('workbench.usage.percentFull', { percent: t.number(percent!) })}
                  </p>
                  <div className="wb-usage__meter" data-tone={level.tone} role="img" aria-label={t('workbench.usage.ringLabel', { percent: t.number(percent!) })}>
                    <span style={{ transform: `scaleX(${level.fraction})` }} />
                  </div>
                  <p className="wb-usage__line u-tabular">{t('workbench.usage.ofWindow', { used: compact(context.tokens, t), window: compact(level.window, t) })}</p>
                  {level.tone === 'danger' && <p className="wb-usage__hint">{t('workbench.usage.nearlyFull')}</p>}
                </>
              ) : (
                <>
                  <p className="wb-usage__headline u-tabular">{t('workbench.usage.tokensInContext', { count: compact(context.tokens, t) })}</p>
                  <p className="wb-usage__hint">{t('workbench.usage.windowUnknown')}</p>
                </>
              )}
              <p className="wb-usage__line">{modelLabel(agent, context.model) ?? context.model}</p>
            </section>
          )}
          {totals.length > 0 && (
            <section>
              <h3>{t('workbench.usage.session')}</h3>
              <dl className="wb-usage__figures u-tabular">
                <div>
                  <dt>{t('workbench.usage.input')}</dt>
                  <dd>{compact(total.input, t)}</dd>
                </div>
                <div>
                  <dt>{t('workbench.usage.output')}</dt>
                  <dd>{compact(total.output, t)}</dd>
                </div>
                {(total.cacheRead > 0 || total.cacheWrite > 0) && (
                  <div>
                    <dt>{t('workbench.usage.cached')}</dt>
                    <dd>{t('workbench.usage.cachedValue', { read: compact(total.cacheRead, t), written: compact(total.cacheWrite, t) })}</dd>
                  </div>
                )}
                {total.cost !== null && (
                  <div>
                    <dt>{t('workbench.usage.cost')}</dt>
                    <dd>{t.number(total.cost, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })}</dd>
                  </div>
                )}
              </dl>
              {totals.length > 1 && <p className="wb-usage__line">{t.list(totals.map((usage) => modelLabel(agent, usage.model) ?? usage.model))}</p>}
            </section>
          )}
        </div>
      </AdaptivePopover>
    </>
  );
}
