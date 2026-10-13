import type { ProviderModel } from '@agent-studio/protocol';
import type { ProviderRecord } from './providers.store.js';

/** The models a picker offers. */
export function visibleModels(record: Pick<ProviderRecord, 'models'>): ProviderModel[] {
  return record.models.filter((model) => !model.hidden);
}

/**
 * The model a new session starts with: the one the owner chose, as long as
 * it is still in the catalogue and offered; otherwise the first one offered.
 * Null when nothing is offered.
 */
export function defaultModelOf(record: Pick<ProviderRecord, 'models' | 'defaultModel'>): string | null {
  const visible = visibleModels(record);
  if (record.defaultModel !== null && visible.some((model) => model.id === record.defaultModel)) return record.defaultModel;
  return visible[0]?.id ?? null;
}

/**
 * The model a run uses. A session keeps the model it was started with even
 * after the owner hid it; a model that is no longer in the catalogue at all
 * is replaced by the default, and the caller says so in the transcript.
 */
export function resolveModel(record: Pick<ProviderRecord, 'models' | 'defaultModel'>, requested: string | null): { model: ProviderModel | null; replaced: string | null } {
  if (requested !== null) {
    const exact = record.models.find((model) => model.id === requested);
    if (exact) return { model: exact, replaced: null };
  }
  const fallback = defaultModelOf(record);
  const model = fallback === null ? null : (record.models.find((entry) => entry.id === fallback) ?? null);
  return { model, replaced: requested !== null && model !== null ? requested : null };
}
