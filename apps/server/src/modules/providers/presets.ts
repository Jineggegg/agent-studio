import type { ProviderModel, ProviderPreset } from '@agent-studio/protocol';

/**
 * Starting values for the "add a provider" form.
 *
 * They were written from the providers' public documentation as it was known
 * when this file was written and have **not** been checked against the live
 * services — the Studio never calls a provider on its own account. Addresses,
 * model ids, context windows and prices change; everything here is editable
 * in the form, and "discover models" replaces guesswork with the provider's
 * current list. No prices are preset: a wrong price is worse than none, since
 * it would show a confident, wrong cost.
 */

const model = (id: string, name: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({
  id,
  name,
  contextWindow: null,
  images: false,
  tools: false,
  prices: null,
  hidden: false,
  ...extra,
});

const UNVERIFIED = 'Defaults from public documentation, not checked against the provider. Edit them, or use "discover models" once a key is saved.';

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    allowPrivateNetwork: false,
    keyRequired: true,
    balance: 'deepseek',
    models: [
      model('deepseek-v4-flash', 'DeepSeek V4 Flash', { contextWindow: 1_000_000, tools: true }),
      model('deepseek-v4-pro', 'DeepSeek V4 Pro', { contextWindow: 1_000_000, tools: true }),
      // The names DeepSeek used before; kept out of the picker in case the provider has retired them.
      model('deepseek-chat', 'DeepSeek Chat (earlier name)', { contextWindow: 128_000, tools: true, hidden: true }),
      model('deepseek-reasoner', 'DeepSeek Reasoner (earlier name)', { contextWindow: 128_000, tools: true, hidden: true }),
    ],
    defaultModel: 'deepseek-v4-flash',
    verified: false,
    note: UNVERIFIED,
    docsUrl: 'https://api-docs.deepseek.com',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    allowPrivateNetwork: false,
    keyRequired: true,
    balance: 'none',
    models: [
      model('gpt-5.5', 'GPT-5.5', { contextWindow: 1_000_000, images: true, tools: true }),
      model('gpt-5.4-mini', 'GPT-5.4 mini', { contextWindow: 400_000, images: true, tools: true }),
    ],
    defaultModel: 'gpt-5.5',
    verified: false,
    note: UNVERIFIED,
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
  },
  {
    id: 'custom',
    name: 'Custom / self-hosted',
    kind: 'openai-compatible',
    baseUrl: '',
    allowPrivateNetwork: false,
    keyRequired: false,
    balance: 'none',
    models: [],
    defaultModel: null,
    verified: false,
    note: 'Any server that speaks the OpenAI-compatible chat-completions protocol. For one on this machine or your own network (for example http://127.0.0.1:11434/v1), switch on "allow private network". Then use "discover models" and mark which models can call tools or read images.',
    docsUrl: null,
  },
];

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}
