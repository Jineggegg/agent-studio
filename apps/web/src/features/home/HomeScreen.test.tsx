import { act, fireEvent, screen, within } from '@testing-library/react';
import { Inbox, MessagesSquare } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPreferencesForTests, beginPreferences, getPreference, setPreference, usePreferences } from '@/data/preferences';
import { resetSessionStore, useSession } from '@/data/session';
import { __resetTilesForTests, registerSystemTile } from '@/registry';
import { jsonResponse, renderInApp } from '@/test/render';
import HomeScreen from './HomeScreen';
import { HOME_LAYOUT_KEY, parseLayout } from './layout';

const PROJECT = { id: '01jabcdefghjkmnpqrstvwxyz1', name: 'Shop', description: '', rootDir: '/w/shop', icon: { symbol: 'cart', color: 'green' }, access: 'write', archived: false, createdAt: 1, updatedAt: 1, links: [], agents: null, features: { assistant: true, automation: false, instructions: true, agentCredentials: false }, scratch: false, pinned: false, lastOpenedAt: null };

function serve() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://studio.test');
    switch (url.pathname) {
      case '/api/projects':
        return Promise.resolve(jsonResponse({ projects: [PROJECT] }));
      case '/api/plugins/contributions':
        return Promise.resolve(jsonResponse({ homeTiles: [], projectTabs: [], settingsPages: [], linkTiles: [] }));
      case '/api/work/running':
        return Promise.resolve(jsonResponse({ runs: [], tasks: [], counts: { runs: 0, waiting: 0, background: 0, tasks: 0 }, truncated: false, checkedAt: 1 }));
      case '/api/inbox/summary':
        return Promise.resolve(jsonResponse({ counts: { approvals: 1, needsHandling: 0, results: 2, running: 0 }, waiting: 1, status: { code: 'waiting', count: 1 }, line: '1 waiting', unreadNotifications: 0, truncated: false, checkedAt: 1 }));
      case '/api/usage/summary':
        return Promise.resolve(jsonResponse({ timeZone: 'UTC', agents: [], budgetsAtRisk: [], generatedAt: 1 }));
      default:
        return Promise.resolve(jsonResponse({ error: { code: 'not_found', message: 'Not found.' } }, 404));
    }
  });
}

const layout = () => parseLayout(getPreference(HOME_LAYOUT_KEY)).layout;

async function renderHome() {
  const result = renderInApp(<HomeScreen />);
  await screen.findByRole('button', { name: 'Shop' });
  return result;
}

describe('the launcher', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', serve());
    __resetTilesForTests();
    registerSystemTile(
      { id: 'workbench', title: 'workbench.title', icon: MessagesSquare, tint: 'blue', to: '/workbench', order: 10 },
      { id: 'inbox', title: 'inbox.title', icon: Inbox, tint: 'red', to: '/inbox', order: 20 },
    );
    useSession.setState({ status: 'ready', authenticated: true, user: { id: '0000000000000000000000user', username: 'ada', displayName: 'Ada', role: 'owner', disabled: false, createdAt: 0 } });
    __resetPreferencesForTests();
    beginPreferences('0000000000000000000000user');
    usePreferences.setState({ loaded: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetTilesForTests();
    __resetPreferencesForTests();
    resetSessionStore();
  });

  it('shows the apps, the projects and "New project", each once', async () => {
    await renderHome();
    const pages = screen.getByRole('group', { name: 'Apps and projects' });
    expect(within(pages).getByTitle('Workbench')).toBeInTheDocument();
    expect(within(pages).getAllByRole('button', { name: 'Shop' })).toHaveLength(1);
    expect(within(pages).getByRole('button', { name: 'New project' })).toBeInTheDocument();
  });

  it('enters edit mode from its action, hides a tile into the library and brings it back', async () => {
    await renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'Edit home screen' }));
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    // In edit mode a tile opens nothing, and "New project" steps aside.
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide Shop' }));
    expect(layout().hidden).toEqual([`project:${PROJECT.id}`]);
    expect(screen.queryByRole('group', { name: 'Shop' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hidden tiles: 1' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Shop to the home screen' }));
    expect(layout().hidden).toEqual([]);
    expect(screen.getByRole('group', { name: 'Shop' })).toBeInTheDocument();
  });

  it('moves a tile with its buttons and says where it went', async () => {
    await renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'Edit home screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Workbench later' }));
    expect(layout().order.slice(0, 2)).toEqual(['system:inbox', 'system:workbench']);
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(screen.getByRole('status', { hidden: true }).textContent ?? '').toMatch(/Workbench moved to position 2 of \d+, page 1/);
  });

  it('renames a tile in place; an empty name gives it its own name back', async () => {
    await renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'Edit home screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename Shop' }));
    const field = screen.getByRole('textbox', { name: 'Name of the tile' });
    fireEvent.change(field, { target: { value: 'My shop, the one with the long name' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(layout().names[`project:${PROJECT.id}`]).toBe('My shop, the one with th');
    fireEvent.click(screen.getByRole('button', { name: 'Rename My shop, the one with th' }));
    const again = screen.getByRole('textbox', { name: 'Name of the tile' });
    fireEvent.change(again, { target: { value: '' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    expect(layout().names).toEqual({});
  });

  it('shows the default arrangement over a value it cannot read — and leaves that value alone', async () => {
    setPreference(HOME_LAYOUT_KEY, { version: 99, anything: true });
    await renderHome();
    expect(screen.getByText('The saved arrangement could not be read')).toBeInTheDocument();
    expect(getPreference(HOME_LAYOUT_KEY)).toEqual({ version: 99, anything: true });
    expect(screen.getAllByRole('button', { name: 'Shop' })).toHaveLength(1);
  });

  it('follows an arrangement that arrives from another device', async () => {
    await renderHome();
    act(() => setPreference(HOME_LAYOUT_KEY, { version: 1, order: [`project:${PROJECT.id}`, 'system:inbox', 'system:workbench'], pageStarts: [], folders: {}, hidden: [], names: {}, widgets: [] }));
    const pages = screen.getByRole('group', { name: 'Apps and projects' });
    const names = within(pages)
      .getAllByRole('button')
      .map((button) => button.getAttribute('title'))
      .filter(Boolean);
    expect(names.slice(0, 3)).toEqual(['Shop', 'Inbox', 'Workbench']);
  });
});
