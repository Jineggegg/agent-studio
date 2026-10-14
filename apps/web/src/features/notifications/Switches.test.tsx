import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationSettings } from '@agent-studio/protocol';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useQuery } from '@tanstack/react-query';
import { errorResponse, jsonResponse, renderInApp } from '@/test/render';
import { notificationKeys } from './api';
import { NotificationSwitches, SwitchProblem, patchFor, readSwitch, usePreferenceSwitches } from './Switches';

function settingsWith(patch: Partial<NotificationSettings['preferences']['events']> = {}, showDetails = false): NotificationSettings {
  return {
    preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, events: { ...DEFAULT_NOTIFICATION_PREFERENCES.events, ...patch }, showDetails },
    push: { publicKey: 'BKey', enabled: false, active: false, devices: [], maxDevices: 10 },
    channels: [
      { id: 'inApp', configured: true, enabled: true },
      { id: 'webPush', configured: false, enabled: false },
    ],
  };
}

/** The page's arrangement: the switches read the settings from the cache their saves write to. */
function Harness({ settings }: { settings: NotificationSettings }) {
  const query = useQuery({ queryKey: notificationKeys.settings(null), queryFn: () => settings, initialData: settings, staleTime: Number.POSITIVE_INFINITY });
  const switches = usePreferenceSwitches(query.data, null);
  return (
    <>
      <SwitchProblem switches={switches} />
      <NotificationSwitches switches={switches} />
    </>
  );
}

const switchNamed = (name: string) => screen.getByRole('switch', { name: new RegExp(name) });

describe('notification switches', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('build a patch that names one switch and nothing else', () => {
    expect(patchFor('events.replyFinished', false)).toEqual({ events: { replyFinished: false } });
    expect(patchFor('channels.webPush', true)).toEqual({ channels: { webPush: true } });
    expect(patchFor('showDetails', true)).toEqual({ showDetails: true });
    const preferences = settingsWith({ failure: false }, true).preferences;
    expect(readSwitch(preferences, 'events.failure')).toBe(false);
    expect(readSwitch(preferences, 'events.needsYou')).toBe(true);
    expect(readSwitch(preferences, 'showDetails')).toBe(true);
    expect(readSwitch(preferences, 'channels.inApp')).toBe(true);
  });

  it('send only the switch that was flipped, and leave every other switch where it was', async () => {
    let answer = settingsWith({ replyFinished: false });
    fetchMock.mockImplementation(async () => jsonResponse(answer));
    renderInApp(<Harness settings={settingsWith()} />);

    fireEvent.click(switchNamed('Reply finished'));
    expect(switchNamed('Reply finished')).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/notifications/preferences');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ events: { replyFinished: false } });
    for (const other of ['Needs you', 'Background work finished', 'Failed or interrupted', 'Automation reminders', 'Plugins']) {
      expect(switchNamed(other)).toHaveAttribute('aria-checked', 'true');
    }
    expect(switchNamed('Show details on the lock screen')).toHaveAttribute('aria-checked', 'false');

    answer = settingsWith({ replyFinished: false }, true);
    fireEvent.click(switchNamed('Show details on the lock screen'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({ showDetails: true });
  });

  it('put back only the switch whose save failed, say which, and keep a switch flipped meanwhile', async () => {
    let release: (response: Response) => void = () => {};
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)))
      .mockImplementationOnce(async () => jsonResponse(settingsWith({ plugin: false })));
    renderInApp(<Harness settings={settingsWith()} />);

    fireEvent.click(switchNamed('Failed or interrupted'));
    fireEvent.click(switchNamed('Plugins'));
    expect(switchNamed('Failed or interrupted')).toHaveAttribute('aria-checked', 'false');
    expect(switchNamed('Plugins')).toHaveAttribute('aria-checked', 'false');

    // The second save waits for the first: one at a time, so an older answer never overtakes a newer choice.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => release(errorResponse(400, 'invalid_request', 'Refused.')));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // The failed one is back as it was; the other one keeps its new position; the reason names the failed one.
    await waitFor(() => expect(switchNamed('Failed or interrupted')).toHaveAttribute('aria-checked', 'true'));
    expect(switchNamed('Plugins')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('alert')).toHaveTextContent('“Failed or interrupted” was not saved');
  });
});
