import type { CreateProviderInput, Provider, ProviderCheck, ProviderModel, ProviderPreset, UpdateProviderInput } from '@agent-studio/protocol';
import { type Translator, hasMessage } from '@/i18n';
import { keyPatch, sameBaseUrl } from './keyField';

/** What the provider form holds. The key is only what was typed here: it never comes from the server. */
export interface ProviderDraft {
  name: string;
  /** Chosen once, at creation; derived from the name when left empty. */
  id: string;
  baseUrl: string;
  allowPrivateNetwork: boolean;
  keyRequired: boolean;
  balance: 'none' | 'deepseek';
  enabled: boolean;
  defaultModel: string | null;
  models: ProviderModel[];
  key: string;
  preset: string | null;
}

export function draftFromPreset(preset: ProviderPreset | null): ProviderDraft {
  return {
    name: preset && preset.id !== 'custom' ? preset.name : '',
    id: '',
    baseUrl: preset?.baseUrl ?? '',
    allowPrivateNetwork: preset?.allowPrivateNetwork ?? false,
    keyRequired: preset?.keyRequired ?? true,
    balance: preset?.balance ?? 'none',
    enabled: true,
    defaultModel: preset?.defaultModel ?? null,
    models: preset ? preset.models.map((model) => ({ ...model })) : [],
    key: '',
    preset: preset?.id ?? null,
  };
}

export function draftFromProvider(provider: Provider): ProviderDraft {
  const settings = provider.settings;
  return {
    name: provider.name,
    id: provider.id,
    baseUrl: settings?.baseUrl ?? '',
    allowPrivateNetwork: settings?.allowPrivateNetwork ?? false,
    keyRequired: settings?.keyRequired ?? true,
    balance: settings?.balance ?? 'none',
    enabled: provider.enabled,
    defaultModel: provider.defaultModel,
    models: (settings?.catalogue ?? []).map((model) => ({ ...model })),
    key: '',
    preset: settings?.preset ?? null,
  };
}

const sameModels = (a: readonly ProviderModel[], b: readonly ProviderModel[]): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A new provider, as the server takes it. */
export function createRequest(draft: ProviderDraft): CreateProviderInput {
  return {
    ...(draft.id.trim() !== '' ? { id: draft.id.trim() } : {}),
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    allowPrivateNetwork: draft.allowPrivateNetwork,
    keyRequired: draft.keyRequired,
    balance: draft.balance,
    models: draft.models,
    defaultModel: draft.models.some((model) => model.id === draft.defaultModel) ? draft.defaultModel : null,
    enabled: draft.enabled,
    ...keyPatch(draft.key),
    ...(draft.preset ? { preset: draft.preset } : {}),
  };
}

/** An edit: only what changed, the key only when one was typed. Null when nothing did. */
export function updateRequest(original: Provider, draft: ProviderDraft): UpdateProviderInput | null {
  const before = draftFromProvider(original);
  const changes: UpdateProviderInput = {};
  if (draft.name.trim() !== before.name) changes.name = draft.name.trim();
  if (!sameBaseUrl(draft.baseUrl, before.baseUrl)) changes.baseUrl = draft.baseUrl.trim();
  if (draft.allowPrivateNetwork !== before.allowPrivateNetwork) changes.allowPrivateNetwork = draft.allowPrivateNetwork;
  if (draft.keyRequired !== before.keyRequired) changes.keyRequired = draft.keyRequired;
  if (draft.balance !== before.balance) changes.balance = draft.balance;
  if (draft.enabled !== before.enabled) changes.enabled = draft.enabled;
  if (!sameModels(draft.models, before.models)) changes.models = draft.models;
  const defaultModel = draft.models.some((model) => model.id === draft.defaultModel) ? draft.defaultModel : null;
  if (defaultModel !== before.defaultModel) changes.defaultModel = defaultModel;
  Object.assign(changes, keyPatch(draft.key));
  return Object.keys(changes).length > 0 ? changes : null;
}

/** A check's outcome in the reader's words where the app has them, else the server's own (always safe) sentence. */
export function checkText(check: Pick<ProviderCheck, 'code' | 'message'>, t: Translator): string {
  const key = `errors.${check.code}`;
  if (check.code !== 'ok' && hasMessage(key)) return t(key);
  return check.message;
}

/** "api.deepseek.com" from "https://api.deepseek.com/v1". */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A short line about a model's window: "128K tokens". */
export function windowText(tokens: number | null, t: Translator): string | null {
  if (tokens === null) return null;
  return t('providers.model.window', { tokens: t.number(tokens, { notation: 'compact', maximumFractionDigits: 1 }) });
}
