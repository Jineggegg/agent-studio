import {
  browserCapabilitiesSchema,
  browserSessionSchema,
  browserSessionsSchema,
  browserSnapshotSchema,
  type BrowserAction,
  type BrowserSession,
} from '@agent-studio/protocol';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '@/data/api';
import { useProjects } from '@/data/projects';
import { useT } from '@/i18n';
import { Screen } from '@/shell/Screen';
import { Button, ErrorState, LoadingRow, confirm } from '@/ui';
import './browser.css';
export default function BrowserScreen() {
  const t = useT();
  const projects = useProjects();
  const capability = useQuery({
    queryKey: ['browser', 'capabilities'],
    queryFn: () => api.get('/api/browser/capabilities', { schema: browserCapabilitiesSchema }),
  });
  const sessions = useQuery({
    queryKey: ['browser', 'sessions'],
    queryFn: () => api.get('/api/browser', { schema: browserSessionsSchema }),
    refetchInterval: 30_000,
  });
  const [projectId, setProjectId] = useState('');
  const [selected, setSelected] = useState<BrowserSession | null>(null);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [pageText, setPageText] = useState('');
  const [point, setPoint] = useState({ x: 640, y: 400 });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const current =
    selected && sessions.data?.sessions.some((entry) => entry.id === selected.id)
      ? selected
      : (sessions.data?.sessions[0] ?? null);
  async function create() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post(
        '/api/browser',
        { projectId: projectId || null },
        { schema: browserSessionSchema, timeoutMs: 40_000 },
      );
      setSelected(result);
      await sessions.refetch();
    } catch (reason) {
      setError(reason);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function close() {
    if (!current || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await api.delete(`/api/browser/${current.id}`);
      setSelected(null);
      setPageText('');
      await sessions.refetch();
    } catch (reason) {
      setError(reason);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function action(input: BrowserAction) {
    if (!current || lock.current) return;
    lock.current = true;
    try {
      if (input.action !== 'screenshot') {
        const message =
          input.action === 'navigate'
            ? t('browser.confirmNavigate', { url: input.url })
            : input.action === 'click'
              ? t('browser.confirmClick', point)
              : `${t('browser.confirmType')}\n\n${input.text}`;
        if (
          !(await confirm({
            title: t('browser.review'),
            message,
            confirmLabel: t('browser.confirm'),
          }))
        )
          return;
      }
      setBusy(true);
      setError(null);
      const result = await api.post(`/api/browser/${current.id}/actions`, input, {
        schema: browserSnapshotSchema,
        timeoutMs: 60_000,
      });
      setSelected(result.session);
      setPageText(result.text);
      await sessions.refetch();
    } catch (reason) {
      setError(reason);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Screen title={t('browser.title')} width="wide">
      <div className="browser-screen">
        <p>{t('browser.help')}</p>
        <p className="text-secondary">{t('browser.expiry')}</p>
        {capability.isPending && <LoadingRow label={t('common.loading')} />}
        {capability.isError && (
          <ErrorState error={capability.error} onRetry={() => void capability.refetch()} />
        )}
        {capability.data && !capability.data.available && (
          <p role="status">
            {t(capability.data.reason === 'disabled' ? 'browser.disabled' : 'browser.sandbox')}
          </p>
        )}
        {sessions.isError && (
          <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
        )}
        {projects.isError && (
          <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
        )}
        {!current && (
          <>
            <p>{t('browser.empty')}</p>
            <label>
              {t('browser.project')}
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                <option value="">{t('browser.noProject')}</option>
                {projects.data
                  ?.filter((project) => project.access === 'write')
                  .map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
              </select>
            </label>
            <Button disabled={!capability.data?.available || busy} onClick={() => void create()}>
              {t('browser.create')}
            </Button>
          </>
        )}
        {current && (
          <>
            <div className="browser-actions">
              <strong>{current.title || current.url}</strong>
              <Button variant="neutral" disabled={busy} onClick={() => void close()}>
                {t('browser.close')}
              </Button>
            </div>
            <label>
              {t('browser.url')}
              <input
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com"
              />
            </label>
            <div className="browser-actions">
              <Button
                disabled={busy || !url.startsWith('https://')}
                onClick={() => void action({ action: 'navigate', url })}
              >
                {t('browser.navigate')}
              </Button>
              <Button
                variant="neutral"
                disabled={busy}
                onClick={() => void action({ action: 'screenshot' })}
              >
                {t('browser.refresh')}
              </Button>
            </div>
            {current.hasScreenshot && (
              <button
                type="button"
                className="browser-capture"
                aria-label={t('browser.screenshot')}
                onClick={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setPoint({
                    x: Math.max(
                      0,
                      Math.min(
                        1279,
                        Math.round(((event.clientX - bounds.left) / bounds.width) * 1280),
                      ),
                    ),
                    y: Math.max(
                      0,
                      Math.min(
                        799,
                        Math.round(((event.clientY - bounds.top) / bounds.height) * 800),
                      ),
                    ),
                  });
                }}
              >
                <img
                  src={`/api/browser/${current.id}/screenshot?v=${current.lastActiveAt}`}
                  alt={t('browser.screenshot')}
                />
                <span
                  className="browser-point"
                  style={{ left: `${(point.x / 1280) * 100}%`, top: `${(point.y / 800) * 100}%` }}
                />
              </button>
            )}
            <div className="browser-actions">
              <label>
                {t('browser.x')}
                <input
                  type="number"
                  min="0"
                  max="1279"
                  value={point.x}
                  onChange={(event) =>
                    setPoint({
                      ...point,
                      x: Math.max(0, Math.min(1279, Number(event.target.value))),
                    })
                  }
                />
              </label>
              <label>
                {t('browser.y')}
                <input
                  type="number"
                  min="0"
                  max="799"
                  value={point.y}
                  onChange={(event) =>
                    setPoint({
                      ...point,
                      y: Math.max(0, Math.min(799, Number(event.target.value))),
                    })
                  }
                />
              </label>
              <Button
                disabled={busy || !current.hasScreenshot}
                onClick={() => void action({ action: 'click', ...point })}
              >
                {t('browser.click')}
              </Button>
            </div>
            <label>
              {t('browser.text')}
              <textarea
                value={text}
                maxLength={4000}
                onChange={(event) => setText(event.target.value)}
              />
            </label>
            <Button disabled={busy || !text} onClick={() => void action({ action: 'type', text })}>
              {t('browser.type')}
            </Button>
            <details>
              <summary>{t('browser.pageText')}</summary>
              <pre className="browser-page-text">{pageText}</pre>
            </details>
          </>
        )}
        {error !== null && <ErrorState error={error} />}
      </div>
    </Screen>
  );
}
