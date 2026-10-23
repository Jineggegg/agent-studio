import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorResponse, jsonResponse, renderInApp } from '@/test/render';
import { copyText } from '@/platform/clipboard';
import { settingsPages, findSettingsPage } from '@/registry';
import '../index';
import DomainPage from './DomainPage';

vi.mock('@/platform/clipboard', () => ({ copyText: vi.fn(async () => true) }));

const systemInfo = (publicOrigins: string[] = []) => ({
  version: 'test',
  startedAt: 1,
  sandbox: { mode: 'bwrap' },
  terminalEnabled: true,
  publicOrigins,
});

describe('domain setup', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.mocked(copyText).mockClear();
    fetchMock = vi.fn(async () => jsonResponse(systemInfo()));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is an owner-only settings entry', () => {
    expect(findSettingsPage('domain')?.access).toBe('owner');
    expect(settingsPages('member').some((page) => page.id === 'domain')).toBe(false);
  });

  it('offers local configuration without sending a request to the entered domain or writing server state', async () => {
    renderInApp(<DomainPage />);
    await screen.findByText('No public address configured');
    fireEvent.change(screen.getByLabelText('Your domain'), {
      target: { value: 'harness.example.com' },
    });
    expect(screen.getByText('Address not yet listed in server configuration')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Caddyfile' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Caddyfile' }));
    await waitFor(() =>
      expect(copyText).toHaveBeenCalledWith(
        'harness.example.com {\n    reverse_proxy 127.0.0.1:7420\n}',
      ),
    );
    expect(screen.getByRole('link', { name: 'Open your address' })).toHaveAttribute(
      'href',
      'https://harness.example.com',
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Cloudflare Tunnel' }));
    expect(screen.getByRole('button', { name: 'Copy Service URL' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Service URL' }));
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith('http://127.0.0.1:7420'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/system/info');
    expect(init.method).toBe('GET');
    fireEvent.change(screen.getByLabelText('Your domain'), {
      target: { value: 'evil.example.com;id' },
    });
    expect(screen.queryByRole('link', { name: 'Open your address' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy Service URL' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a full DNS hostname');
  });

  it('only updates configured status after the server actually reports the new origin', async () => {
    renderInApp(<DomainPage />);
    await screen.findByText('No public address configured');
    fireEvent.change(screen.getByLabelText('Your domain'), {
      target: { value: 'harness.example.com' },
    });
    expect(screen.getByText('Address not yet listed in server configuration')).toBeInTheDocument();
    fetchMock.mockImplementation(async () =>
      jsonResponse(systemInfo(['https://harness.example.com'])),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() =>
      expect(screen.getByText('Address listed in server configuration')).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/DNS, certificates and outside connectivity must be checked separately/),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a failed status read instead of suggesting the address is unconfigured', async () => {
    fetchMock.mockImplementation(async () => errorResponse(503, 'unavailable'));
    renderInApp(<DomainPage />);
    await screen.findByRole('alert');
    expect(screen.queryByText('No public address configured')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your domain'), {
      target: { value: 'harness.example.com' },
    });
    expect(
      screen.queryByText('Address not yet listed in server configuration'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Caddyfile' })).toBeInTheDocument();
  });
});
