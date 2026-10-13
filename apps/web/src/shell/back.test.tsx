import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sheet } from '@/ui';
import { __resetOverlaysForTests } from '@/ui/overlay';
import { Screen } from './Screen';
import { __resetBackForTests, installBackGestures, performBack, useBack } from './back';
import { __resetHistoryForTests, recordNavigation } from './history';

/** Keeps the history tracker in step with the test router, as the app's router subscription does. */
function Tracker() {
  const location = useLocation();
  const action = useNavigationType();
  const [seen, setSeen] = useState<string | null>(null);
  if (seen !== location.key) {
    recordNavigation(seen === null ? 'INITIAL' : action, location);
    setSeen(location.key);
  }
  return <output data-testid="path">{location.pathname}</output>;
}

function Home() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate('/settings')}>
      Open settings
    </button>
  );
}

function Settings() {
  const navigate = useNavigate();
  const [sheet, setSheet] = useState(false);
  return (
    <Screen title="Settings">
      <button type="button" onClick={() => void navigate('/settings/about')}>
        About
      </button>
      <button type="button" onClick={() => setSheet(true)}>
        Open sheet
      </button>
      <input aria-label="Search" />
      <Sheet open={sheet} onClose={() => setSheet(false)} title="A sheet">
        content
      </Sheet>
    </Screen>
  );
}

function About() {
  return (
    <Screen title="About" parent={{ to: '/settings', label: 'Settings' }}>
      about
    </Screen>
  );
}

function Loading() {
  // What the shell mounts around a route whose code is still downloading.
  useBack({ to: '/', label: 'Home' }, { fallback: true });
  return <p>Loading…</p>;
}

function app(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Tracker />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/about" element={<About />} />
        <Route path="/loading" element={<Loading />} />
      </Routes>
    </MemoryRouter>,
  );
}

const path = () => screen.getByTestId('path').textContent;

beforeEach(() => {
  __resetBackForTests();
  __resetHistoryForTests();
  __resetOverlaysForTests();
  installBackGestures(() => '');
});
afterEach(() => __resetOverlaysForTests());

describe('back', () => {
  it('names where it goes and returns to where the user came from', async () => {
    const user = userEvent.setup();
    app('/');
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(path()).toBe('/settings');
    const home = screen.getByRole('button', { name: 'Back to Home' });
    expect(home).toHaveTextContent('Home');

    await user.click(screen.getByRole('button', { name: 'About' }));
    expect(path()).toBe('/settings/about');
    // the control names the screen it returns to
    await user.click(screen.getByRole('button', { name: 'Back to Settings' }));
    expect(path()).toBe('/settings');
    await user.click(screen.getByRole('button', { name: 'Back to Home' }));
    expect(path()).toBe('/');
  });

  it('goes to the parent on a cold start, where nothing is behind the screen', async () => {
    const user = userEvent.setup();
    app('/settings/about');
    await user.click(screen.getByRole('button', { name: 'Back to Settings' }));
    expect(path()).toBe('/settings');
    await user.click(screen.getByRole('button', { name: 'Back to Home' }));
    expect(path()).toBe('/');
  });

  it('is the same action for the control, Escape and the back chord', async () => {
    const user = userEvent.setup();
    app('/');
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    await user.keyboard('{Escape}');
    expect(path()).toBe('/');

    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.keyDown(document.body, { key: '[', ctrlKey: true });
    expect(path()).toBe('/');

    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    act(() => void performBack());
    expect(path()).toBe('/');
  });

  it('leaves Escape alone while typing, and while a sheet is open (the sheet takes it)', async () => {
    const user = userEvent.setup();
    app('/');
    await user.click(screen.getByRole('button', { name: 'Open settings' }));

    await user.click(screen.getByLabelText('Search'));
    await user.keyboard('{Escape}');
    expect(path()).toBe('/settings');

    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    await user.keyboard('{Escape}'); // closes the sheet
    expect(path()).toBe('/settings');
    expect(screen.getByRole('button', { name: 'Open sheet' })).toHaveFocus();
    await user.keyboard('{Escape}'); // now it is back
    expect(path()).toBe('/');
  });

  it('respects a screen that handles the key itself', async () => {
    const user = userEvent.setup();
    app('/');
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    const stopRun = (event: KeyboardEvent) => event.key === 'Escape' && event.preventDefault();
    document.addEventListener('keydown', stopRun);
    await user.keyboard('{Escape}');
    document.removeEventListener('keydown', stopRun);
    expect(path()).toBe('/settings');
  });

  it('still leads home while a route is only loading', async () => {
    const user = userEvent.setup();
    app('/loading');
    await user.keyboard('{Escape}');
    expect(path()).toBe('/');
  });

  it('does nothing on a root screen', async () => {
    const user = userEvent.setup();
    app('/');
    expect(performBack()).toBe(false);
    await user.keyboard('{Escape}');
    expect(path()).toBe('/');
  });
});
