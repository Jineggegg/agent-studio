import { fireEvent, render, screen } from '@testing-library/react';
import { FolderTree } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastViewport, toast } from '@/ui';
import { __resetDeviceMemoryForTests, useDeviceMemory } from '../device';
import { type InspectorContext, __resetInspectorForTests, registerInspectorPanel, useInspectorState } from '../inspector/registry';
import { InspectorScope } from '../inspector/scope';
import { Prose } from './Prose';

const clipboard = vi.hoisted(() => ({ copyText: vi.fn(async (_text: string) => true) }));
vi.mock('@/platform/clipboard', () => clipboard);
vi.mock('../api', () => ({ workbenchApi: {}, SEND_TIMEOUT_MS: 20_000 }));

const inProject: InspectorContext = { project: { id: 'p' } as never, sessionId: null, role: 'member' };
const TEXT = 'See [the route](src/app.ts#L12), [the docs](https://example.com/docs) and [below](#notes).';

/** What the inspector was last asked for. */
function Pending() {
  const { pending, open, panel } = useInspectorState();
  return <output>{pending ? `${open ? 'open' : 'closed'}:${panel}:${JSON.stringify(pending.request)}` : 'nothing'}</output>;
}

afterEach(() => {
  __resetInspectorForTests();
  __resetDeviceMemoryForTests();
  clipboard.copyText.mockClear();
  toast.clear();
});

describe('links in what an agent wrote', () => {
  it('opens a file link in the project tools when a panel for files is installed', () => {
    registerInspectorPanel({ id: 'files', title: 'workbench.inspector.sample', icon: FolderTree, load: async () => ({ default: () => null }), handles: ['open-file'] });
    render(
      <InspectorScope value={inProject}>
        <Prose>{TEXT}</Prose>
        <Pending />
      </InspectorScope>,
    );
    const followed = fireEvent.click(screen.getByRole('link', { name: 'the route' }));
    expect(followed).toBe(false);
    expect(screen.getByRole('status')).toHaveTextContent('open:files:{"type":"open-file","path":"src/app.ts","line":12}');
    expect(useDeviceMemory.getState().inspector).toMatchObject({ open: true, panel: 'files' });
    expect(clipboard.copyText).not.toHaveBeenCalled();
  });

  it('copies the path, and goes nowhere, when no panel can open files', async () => {
    render(
      <InspectorScope value={inProject}>
        <Prose>{TEXT}</Prose>
        <ToastViewport />
      </InspectorScope>,
    );
    expect(fireEvent.click(screen.getByRole('link', { name: 'the route' }))).toBe(false);
    expect(clipboard.copyText).toHaveBeenCalledWith('src/app.ts');
    expect(await screen.findByText('Copied the path src/app.ts')).toBeInTheDocument();
  });

  it('leaves web addresses and same-page links to the browser', () => {
    render(<Prose>{TEXT}</Prose>);
    expect(fireEvent.click(screen.getByRole('link', { name: 'the docs' }))).toBe(true);
    expect(fireEvent.click(screen.getByRole('link', { name: 'below' }))).toBe(true);
    expect(clipboard.copyText).not.toHaveBeenCalled();
  });
});
