import type { Provider } from '@agent-studio/protocol';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderInApp } from '@/test/render';
import { keyOutcome, keyPatch, keyPlaceholder, keyProblemKey, keyStatus, keyWarning } from './keyField';
import { draftFromProvider, updateRequest } from './model';
import { ProviderSheet } from './ProviderSheet';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  presets: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  removeKey: vi.fn(),
  verify: vi.fn(),
  discover: vi.fn(),
  balance: vi.fn(),
}));
vi.mock('./api', async (original) => ({ ...(await original<Record<string, unknown>>()), providersApi: api }));
const usage = vi.hoisted(() => ({ providers: vi.fn(async () => ({ providers: [] })) }));
vi.mock('@/features/usage/api', async (original) => {
  const actual = await original<{ usageApi: Record<string, unknown> }>();
  return { ...actual, usageApi: { ...actual.usageApi, providers: usage.providers } };
});

function provider(overrides: { configured?: boolean; readable?: boolean; keyRequired?: boolean } = {}): Provider {
  const configured = overrides.configured ?? true;
  return {
    id: 'deepseek',
    agentId: 'api-deepseek',
    name: 'DeepSeek',
    kind: 'openai-compatible',
    enabled: true,
    configured,
    models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 64_000, images: false, tools: true }],
    defaultModel: 'deepseek-chat',
    settings: {
      baseUrl: 'https://api.deepseek.com',
      allowPrivateNetwork: false,
      keyRequired: overrides.keyRequired ?? true,
      balance: 'deepseek',
      key: { configured, hint: configured ? '••••' : null, updatedAt: configured ? Date.UTC(2026, 9, 3) : null, readable: overrides.readable ?? true },
      catalogue: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 64_000, images: false, tools: true, prices: null, hidden: false }],
      preset: 'deepseek',
      createdBy: null,
      createdAt: 0,
      updatedAt: 0,
      lastCheck: null,
    },
  };
}

describe('the API key field, as rules', () => {
  it('describes the saved key without any part of it', () => {
    expect(keyStatus(provider())).toBe('configured');
    expect(keyStatus(provider({ readable: false }))).toBe('unreadable');
    expect(keyStatus(provider({ configured: false }))).toBe('missing');
    expect(keyStatus(provider({ configured: false, keyRequired: false }))).toBe('not-needed');
    expect(keyPlaceholder('configured')).toBe('providers.key.placeholderKeep');
    expect(keyPlaceholder('unreadable')).toBe('providers.key.placeholderUnreadable');
  });

  it('keeps the saved key when the field is left blank, and sends a typed one as typed', () => {
    expect(keyPatch('')).toEqual({});
    expect(keyPatch('   ')).toEqual({});
    expect(keyPatch('sk-new-key-123')).toEqual({ apiKey: 'sk-new-key-123' });
    const original = provider();
    expect(draftFromProvider(original).key).toBe('');
    expect(updateRequest(original, { ...draftFromProvider(original), name: 'DeepSeek (work)' })).toEqual({ name: 'DeepSeek (work)' });
    expect(updateRequest(original, { ...draftFromProvider(original), key: 'sk-new-key-123' })).toEqual({ apiKey: 'sk-new-key-123' });
    expect(updateRequest(original, draftFromProvider(original))).toBeNull();
  });

  it('warns that a new address removes the saved key, and that a typed key replaces it', () => {
    expect(keyWarning({ originalBaseUrl: 'https://api.deepseek.com', baseUrl: 'https://api.deepseek.com/', keyConfigured: true, typed: '' })).toBeNull();
    expect(keyWarning({ originalBaseUrl: 'https://api.deepseek.com', baseUrl: 'https://proxy.example.com', keyConfigured: true, typed: '' })).toBe('will-clear');
    expect(keyWarning({ originalBaseUrl: 'https://api.deepseek.com', baseUrl: 'https://proxy.example.com', keyConfigured: true, typed: 'sk-x-12345678' })).toBe('will-replace');
    expect(keyWarning({ originalBaseUrl: 'https://api.deepseek.com', baseUrl: 'https://proxy.example.com', keyConfigured: false, typed: '' })).toBeNull();
    expect(keyOutcome({ keyCleared: true }, false)).toBe('key-cleared');
    expect(keyOutcome({ keyCleared: false }, true)).toBe('key-saved');
    expect(keyOutcome({ keyCleared: false }, false)).toBeNull();
  });

  it('says why a key was refused without repeating it', () => {
    expect(keyProblemKey({ reason: 'sign_in_token' })).toBe('providers.keyProblem.sign_in_token');
    expect(keyProblemKey({ reason: 'something-new' })).toBe('providers.keyProblem.other');
    expect(keyProblemKey(undefined)).toBe('providers.keyProblem.other');
  });
});

describe('the API key field, on screen', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
  });

  const keyInput = () => screen.getByLabelText('API key', { selector: 'input' }) as HTMLInputElement;

  it('is never filled from the server, and a save with it blank sends no key', async () => {
    const original = provider();
    api.update.mockResolvedValue({ provider: { ...original, name: 'DeepSeek (work)' }, keyCleared: false });
    renderInApp(<ProviderSheet open provider={original} presets={[]} onClose={() => {}} />);
    expect(keyInput().value).toBe('');
    expect(keyInput()).toHaveAttribute('placeholder', 'Saved — leave empty to keep');
    expect(screen.getByText(/Configured · saved/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'DeepSeek (work)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('deepseek', { name: 'DeepSeek (work)' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(keyInput().value).toBe('');
  });

  it('says before saving that a new address removes the key, and after, from the server’s answer, that it was removed', async () => {
    const original = provider();
    api.update.mockResolvedValue({ provider: provider({ configured: false }), keyCleared: true });
    renderInApp(<ProviderSheet open provider={original} presets={[]} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'https://proxy.example.com/v1' } });
    expect(screen.getByText(/Changing the address removes the saved key/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('deepseek', { baseUrl: 'https://proxy.example.com/v1' }));
    expect(await screen.findByText('The address changed, so the saved key was removed. Enter the key again.')).toBeInTheDocument();
    expect(keyInput()).toHaveAttribute('placeholder', 'Required');
  });

  it('sends a typed key with the save, says it replaces the saved one, and empties the field again', async () => {
    const original = provider();
    api.update.mockResolvedValue({ provider: original, keyCleared: false });
    renderInApp(<ProviderSheet open provider={original} presets={[]} onClose={() => {}} />);
    fireEvent.change(keyInput(), { target: { value: 'sk-0123456789abcdef' } });
    expect(screen.getByText('Saving replaces the saved key.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('deepseek', { apiKey: 'sk-0123456789abcdef' }));
    expect(await screen.findByText('Saved, with the new key.')).toBeInTheDocument();
    expect(keyInput().value).toBe('');
  });
});
