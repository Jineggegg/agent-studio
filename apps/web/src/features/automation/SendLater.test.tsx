import type { DeferredMessage, Project } from '@agent-studio/protocol';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushDraft, getDraft, sessionDraftKey, setDraft } from '@/features/workbench/composer/drafts';
import { renderInApp } from '@/test/render';
import { SendLater } from './SendLater';

const deferred = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), cancel: vi.fn(), dismiss: vi.fn() }));
vi.mock('./api', async (original) => ({ ...(await original<Record<string, unknown>>()), deferredApi: deferred }));
const workbench = vi.hoisted(() => ({ saveDraft: vi.fn(async (sessionId: string, text: string) => ({ sessionId, text, updatedAt: Date.now() })) }));
vi.mock('@/features/workbench/api', async (original) => {
  const actual = await original<{ workbenchApi: Record<string, unknown> }>();
  return { ...actual, workbenchApi: { ...actual.workbenchApi, saveDraft: workbench.saveDraft } };
});

const SESSION = 'session'.padEnd(26, '0');
const project = { id: 'project'.padEnd(26, '0'), features: { automation: true } } as unknown as Project;

function scheduled(text: string, sendAt: number): DeferredMessage {
  return {
    id: 'deferred'.padEnd(26, '0'),
    sessionId: SESSION,
    projectId: project.id,
    text,
    sendAt,
    state: 'pending',
    queued: false,
    reason: null,
    detail: null,
    options: { model: null, effort: null, permissionMode: 'ask' },
    runId: null,
    dismissed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('send later', () => {
  afterEach(() => {
    deferred.create.mockReset();
    workbench.saveDraft.mockClear();
  });

  it('schedules the text in the field and empties the draft the server keeps, so it does not come back', async () => {
    const key = sessionDraftKey(SESSION);
    setDraft(key, 'Check the nightly build');
    // The draft has reached the server, as it does a moment after typing.
    await flushDraft(key);
    expect(workbench.saveDraft).toHaveBeenLastCalledWith(SESSION, 'Check the nightly build', false);
    deferred.create.mockImplementation(async (body: { text: string; sendAt: number }) => scheduled(body.text, body.sendAt));

    renderInApp(<SendLater sessionId={SESSION} draftKey={key} project={project} options={{ model: null, effort: null, permissionMode: 'ask' }} hasQuote={false} blocked={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send later' }));
    fireEvent.click(await screen.findByRole('button', { name: /^In 15 minutes/ }));

    await waitFor(() => expect(deferred.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION, text: 'Check the nightly build', permissionMode: 'ask' })));
    const { sendAt } = deferred.create.mock.calls[0]![0] as { sendAt: number };
    expect(sendAt - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(sendAt - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    // A scheduled message leaves the server's copy alone (unlike one sent now): the field is emptied from here.
    await waitFor(() => expect(workbench.saveDraft).toHaveBeenLastCalledWith(SESSION, '', false));
    expect(getDraft(key)).toBe('');
  });

  it('cannot be opened with nothing written, and explains where the project does not allow it', async () => {
    const key = sessionDraftKey('other'.padEnd(26, '0'));
    const first = renderInApp(<SendLater sessionId={SESSION} draftKey={key} project={project} options={{ model: null, effort: null, permissionMode: 'ask' }} hasQuote={false} blocked={false} />);
    expect(screen.getByRole('button', { name: 'Send later' })).toBeDisabled();
    first.unmount();

    const off = { ...project, features: { automation: false } } as unknown as Project;
    renderInApp(<SendLater sessionId={SESSION} draftKey={key} project={off} options={{ model: null, effort: null, permissionMode: 'ask' }} hasQuote={false} blocked={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send later' }));
    expect(await screen.findByText(/only where automations are switched on for the project/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^In 15 minutes/ })).toBeDisabled();
    expect(deferred.create).not.toHaveBeenCalled();
  });
});
