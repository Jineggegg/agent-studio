import { Component, type ErrorInfo, type ReactNode, useEffect } from 'react';
import { useNavigate, useRouteError } from 'react-router';
import { useT } from '@/i18n';
import { Button, ErrorState } from '@/ui';
import { announceFirstPaint, failLaunch, hasLaunched, isChunkLoadError } from './launch';

function CrashMessage({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const download = isChunkLoadError(error);
  useEffect(() => announceFirstPaint(), []);
  return (
    <div className="screen-status">
      <ErrorState
        kind={download ? 'unreachable' : 'failed'}
        title={download ? t('shell.chunk.title') : t('shell.crash.title')}
        description={download ? t('shell.chunk.description') : t('shell.crash.description')}
        onRetry={onRetry}
        actions={
          <Button
            variant="plain"
            onClick={() => {
              onRetry();
              void navigate('/', { replace: true });
            }}
          >
            {t('shell.goHome')}
          </Button>
        }
      />
    </div>
  );
}

interface BoundaryProps {
  /** Changing this clears the error (navigating away from the broken screen). */
  resetKey: string;
  children: ReactNode;
}

/**
 * One per screen. A screen that throws is replaced, in place, by a message
 * with "Try again" and "Go to Home"; the shell around it — navigation, other
 * screens, toasts — keeps working.
 */
export class ScreenBoundary extends Component<BoundaryProps, { error: unknown; resetKey: string }> {
  override state = { error: null as unknown, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown) {
    return { error: error ?? new Error('unknown error') };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: { error: unknown; resetKey: string }) {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The one place the client logs: a crash that would otherwise be invisible.
    // eslint-disable-next-line no-console
    console.error('A screen crashed.', error, info.componentStack);
  }

  override render() {
    if (this.state.error !== null) return <CrashMessage error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}

/**
 * The router's last resort, for an error outside every screen. Before the
 * first screen has painted that means start-up failed: the launch error
 * screen (plain HTML, needs no stylesheet) takes over.
 */
export function RootError() {
  const error = useRouteError();
  const t = useT();
  const launched = hasLaunched();
  useEffect(() => {
    if (!launched) failLaunch(isChunkLoadError(error) ? 'download' : 'crash');
  }, [error, launched]);
  if (!launched) return null;
  const download = isChunkLoadError(error);
  return (
    <div className="app">
      <div className="screen-status">
        <ErrorState
          kind={download ? 'unreachable' : 'failed'}
          title={download ? t('shell.chunk.title') : t('shell.crash.title')}
          description={download ? t('shell.chunk.description') : t('shell.crash.description')}
          actions={
            <>
              <Button variant="tinted" onClick={() => window.location.reload()}>
                {t('shell.reload')}
              </Button>
              <Button variant="plain" onClick={() => window.location.assign('/')}>
                {t('shell.goHome')}
              </Button>
            </>
          }
        />
      </div>
    </div>
  );
}
