import { PLUGIN_PANEL_SANDBOX, type PanelContext, type PluginPanelGrant, type PluginPanelSlot } from '@agent-studio/protocol';
import { RefreshCw } from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { useUser } from '@/data/session';
import { useLanguage, useT } from '@/i18n';
import { useTheme } from '@/platform/theme';
import { Button, ErrorState, Spinner } from '@/ui';
import { pluginsApi } from './api';
import { PanelRelay } from './relay';

export interface PanelFrameProps {
  pluginId: string;
  panelId: string;
  slot: PluginPanelSlot;
  /** The project a project tab is for. */
  project: { id: string; name: string } | null;
  /** Names the frame for assistive technology. */
  title: string;
  /** `fill`: the frame fills its container. `content`: it is as tall as the panel asks, within bounds. */
  sizing: 'fill' | 'content';
}

/** How long a panel may take to say it is ready before the page stops waiting for it. */
const READY_TIMEOUT_MS = 12_000;
const MIN_CONTENT_HEIGHT = 160;
const MAX_CONTENT_HEIGHT = 4_000;

type Phase = { kind: 'opening' } | { kind: 'failed'; error: unknown } | { kind: 'open'; grant: PluginPanelGrant };

/**
 * A plugin's panel: its page in a sandboxed frame with an opaque origin, and
 * the relay that is its only way to the Studio. The grant is obtained here and
 * never leaves this component; when the server says it has expired, the panel
 * is opened again, with a new grant in a new frame.
 */
export function PanelFrame({ pluginId, panelId, slot, project, title, sizing }: PanelFrameProps) {
  const t = useT();
  const theme = useTheme();
  const locale = useLanguage();
  const user = useUser();
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'opening' });
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const [height, setHeight] = useState(360);
  const frame = useRef<HTMLIFrameElement>(null);
  const relay = useRef<PanelRelay | null>(null);
  const translator = useRef(t);
  translator.current = t;
  const projectId = project?.id ?? null;

  // What a panel is told: what it needs to look right and to greet the user — nothing else of the user's.
  const context = useRef<PanelContext | null>(null);
  context.current = {
    pluginId,
    panelId,
    slot,
    theme,
    locale,
    project: project ? { id: project.id, name: project.name } : null,
    user: { displayName: user?.displayName || user?.username || '' },
  };

  // ---- opening: a grant, then a frame ------------------------------------------------
  useEffect(() => {
    const controller = new AbortController();
    setPhase({ kind: 'opening' });
    setReady(false);
    setSlow(false);
    pluginsApi.openPanel(pluginId, panelId, { slot, ...(projectId ? { projectId } : {}) }, controller.signal).then(
      (grant) => {
        if (controller.signal.aborted) return;
        // The server decides the sandbox; a grant with any other, or an address elsewhere, is not shown at all.
        if (grant.sandbox !== PLUGIN_PANEL_SANDBOX || !grant.url.startsWith('/api/plugins/panel/')) {
          setPhase({ kind: 'failed', error: new Error('unexpected grant') });
          return;
        }
        setPhase({ kind: 'open', grant });
      },
      (error: unknown) => {
        if (controller.signal.aborted || (isApiError(error) && error.code === 'aborted')) return;
        setPhase({ kind: 'failed', error });
      },
    );
    return () => controller.abort();
  }, [pluginId, panelId, slot, projectId, attempt]);

  const grant = phase.kind === 'open' ? phase.grant : null;
  const reopen = useCallback(() => setAttempt((value) => value + 1), []);

  // ---- the relay, for as long as this frame lives ------------------------------------
  useEffect(() => {
    if (!grant) return;
    const instance = new PanelRelay({
      frameWindow: () => frame.current?.contentWindow ?? null,
      context: () => context.current!,
      call: async (method, params) => {
        try {
          return await pluginsApi.rpc(pluginId, grant.panel, method, params);
        } catch (error) {
          // The panel shows the reason in the user's language; only its code and that sentence go in.
          if (isApiError(error)) throw { code: error.code, message: describeError(error, translator.current) };
          throw error;
        }
      },
      onExpired: reopen,
      onReady: () => setReady(true),
      onResize: (requested) => setHeight(Math.min(MAX_CONTENT_HEIGHT, Math.max(MIN_CONTENT_HEIGHT, requested))),
    });
    relay.current = instance;
    const listener = (event: MessageEvent) => instance.handle(event);
    window.addEventListener('message', listener);
    const timer = window.setTimeout(() => setSlow(true), READY_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', listener);
      instance.dispose();
      if (relay.current === instance) relay.current = null;
    };
  }, [grant, pluginId, reopen]);

  // Theme, language or the project's name changed: the panel is told.
  const projectName = project?.name ?? null;
  useEffect(() => {
    relay.current?.sendContext();
  }, [theme, locale, projectName]);

  if (phase.kind === 'failed') {
    const gone = isApiError(phase.error) && (phase.error.code === 'plugin_not_found' || phase.error.code === 'panel_not_found');
    return (
      <div className="pl-frame__state">
        <ErrorState
          compact
          error={phase.error}
          {...(gone ? { kind: 'gone' as const, title: t('plugins.panel.gone'), description: t('plugins.panel.goneText') } : { title: t('plugins.panel.failed') })}
          onRetry={reopen}
        />
      </div>
    );
  }

  const style: CSSProperties | undefined = sizing === 'content' ? { height } : undefined;
  return (
    <div className="pl-frame" data-sizing={sizing} data-ready={ready || slow || undefined} aria-busy={!ready || undefined}>
      {grant && (
        <iframe
          key={grant.panel}
          ref={frame}
          className="pl-frame__frame"
          title={title}
          src={grant.url}
          sandbox={grant.sandbox}
          referrerPolicy="no-referrer"
          style={style}
        />
      )}
      {!ready && !slow && (
        <div className="pl-frame__loading" role="status">
          <Spinner size={22} />
          <span>{t('plugins.panel.loading')}</span>
        </div>
      )}
      {!ready && slow && (
        <div className="pl-frame__note" role="status">
          <span>{t('plugins.panel.silent')}</span>
          <Button size="sm" variant="plain" icon={<RefreshCw size={16} />} onClick={reopen}>
            {t('plugins.panel.reload')}
          </Button>
        </div>
      )}
    </div>
  );
}
