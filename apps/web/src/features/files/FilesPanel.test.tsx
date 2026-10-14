import type { FileEntry, Project } from '@agent-studio/protocol';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderInApp } from '@/test/render';
import { ConfirmHost, ToastViewport, toast } from '@/ui';
import FilesPanel from './FilesPanel';
import { __resetDraftsForTests } from './drafts';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  searchNames: vi.fn(),
  searchContent: vi.fn(),
  content: vi.fn(),
  save: vi.fn(),
  create: vi.fn(),
  move: vi.fn(),
  remove: vi.fn(),
  limits: vi.fn(),
  upload: vi.fn(),
  rawUrl: (_project: string, path: string) => `/raw/${path}`,
  archiveUrl: (_project: string, path: string) => `/zip/${path}`,
}));
vi.mock('./api', () => ({ filesApi: api, filesKeys: { limits: ['files', 'limits'], names: (p: string, q: string) => ['files', p, 'names', q], content: (p: string, q: string) => ['files', p, 'grep', q] } }));
vi.mock('@/data/realtime', () => ({ useRealtimeTopic: () => {}, useOnReconnect: () => {} }));

const entry = (path: string, kind: FileEntry['kind'] = 'file', extra: Partial<FileEntry> = {}): FileEntry => ({ name: path.split('/').pop()!, path, kind, size: 10, modifiedAt: 1, mode: 420, ignored: false, ...extra });
const project = (access: Project['access'] = 'write'): Project =>
  ({ id: '01pppppppppppppppppppppppp', name: 'Demo', description: '', rootDir: '/srv/demo', icon: { symbol: 'folder', color: 'blue' }, access, archived: false, createdAt: 1, updatedAt: 1, links: [], agents: null, features: { assistant: true, automation: false, instructions: true, agentCredentials: false }, scratch: false, pinned: false, lastOpenedAt: null }) as Project;

const LISTINGS: Record<string, FileEntry[]> = {
  '': [entry('src', 'directory'), entry('.env', 'file', { ignored: true }), entry('README.md')],
  src: [entry('src/app.ts'), entry('src/util.ts')],
};

function open(access: Project['access'] = 'write') {
  api.list.mockImplementation(async (_project: string, path: string) => ({ path, entries: LISTINGS[path] ?? [], truncated: false }));
  api.limits.mockResolvedValue({ maxUploadFiles: 100, maxUploadFileBytes: 1000, maxUploadTotalBytes: 5000 });
  return renderInApp(
    <>
      <FilesPanel project={project(access)} sessionId={null} active presentation="docked" request={null} onRequestHandled={() => {}} close={() => {}} />
      <ConfirmHost />
      <ToastViewport />
    </>,
  );
}

afterEach(() => {
  for (const mock of Object.values(api)) if (typeof mock === 'function' && 'mockReset' in mock) mock.mockReset();
  __resetDraftsForTests();
  toast.clear();
});

describe('the files panel', () => {
  it('reads the project folder, then each folder only when it is opened — and only once', async () => {
    open();
    const tree = await screen.findByRole('tree');
    expect(await within(tree).findByRole('treeitem', { name: 'src, folder' })).toHaveAttribute('aria-expanded', 'false');
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledWith(expect.any(String), '');

    fireEvent.click(within(tree).getByRole('treeitem', { name: 'src, folder' }));
    expect(await within(tree).findByRole('treeitem', { name: 'app.ts' })).toHaveAttribute('aria-level', '2');
    expect(api.list).toHaveBeenCalledTimes(2);

    // Closing and opening again asks the server nothing.
    fireEvent.click(within(tree).getByRole('treeitem', { name: 'src, folder' }));
    expect(within(tree).queryByRole('treeitem', { name: 'app.ts' })).toBeNull();
    fireEvent.click(within(tree).getByRole('treeitem', { name: 'src, folder' }));
    expect(within(tree).getByRole('treeitem', { name: 'app.ts' })).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('lists ignored entries, marked as such', async () => {
    open();
    expect(await screen.findByRole('treeitem', { name: '.env, left out by the project’s ignore rules' })).toBeInTheDocument();
  });

  it('filters by name through the server\'s search and shows the branches that lead to a match', async () => {
    api.searchNames.mockResolvedValue({ query: 'app', results: [{ path: 'src/app.ts', name: 'app.ts', kind: 'file' }], truncated: false });
    open();
    await screen.findByRole('tree');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a file by name' }), { target: { value: 'app' } });
    expect(await screen.findByRole('button', { name: 'app.ts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'src, folder' })).toBeInTheDocument();
    expect(api.searchNames).toHaveBeenCalledWith(expect.any(String), 'app', 200, expect.anything());
    expect(screen.queryByRole('treeitem', { name: 'README.md' })).toBeNull();
  });

  it('keeps a refused name in its field and says which rule it broke — without asking the server', async () => {
    open();
    await screen.findByRole('tree');
    fireEvent.click(screen.getByRole('button', { name: 'New file' }));
    const field = screen.getByRole('textbox', { name: 'Name of the new file' });
    fireEvent.change(field, { target: { value: 'a/b.txt' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('A name cannot contain');
    expect(api.create).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Name of the new file' })).toBeInTheDocument();
  });

  it('shows the server\'s refusal of a name in the same place', async () => {
    const { ApiError } = await import('@/data/http');
    api.create.mockRejectedValue(new ApiError(409, 'already_exists', 'Something with that name already exists there.'));
    open();
    await screen.findByRole('tree');
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    const field = screen.getByRole('textbox', { name: 'Name of the new folder' });
    fireEvent.change(field, { target: { value: 'src' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something with that name already exists there.');
    expect(api.create).toHaveBeenCalledWith(expect.any(String), { parent: '', name: 'src', kind: 'directory' });
  });

  it('deletes only after the question that says it is permanent', async () => {
    api.remove.mockResolvedValue(undefined);
    open();
    await screen.findByRole('treeitem', { name: 'README.md' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for README.md' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(await screen.findByRole('alertdialog', { name: 'Delete “README.md”?' })).toBeInTheDocument();
    expect(screen.getByText(/There is no bin to restore it from/)).toBeInTheDocument();
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(expect.any(String), 'README.md', false));
  });

  it('offers nothing that changes files to someone who may only look', async () => {
    open('read');
    await screen.findByRole('tree');
    expect(screen.queryByRole('button', { name: 'New file' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Upload files/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for README.md' }));
    expect(await screen.findByRole('menuitem', { name: 'Download' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
  });
});
