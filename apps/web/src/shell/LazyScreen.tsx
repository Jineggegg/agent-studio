import { type ComponentType, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useT } from '@/i18n';
import { Button, ErrorState, Spinner, useDelayedFlag } from '@/ui';
import { announceFirstPaint } from './launch';

type Loader<P> = () => Promise<{ default: ComponentType<P> }>;

export interface LazyScreenOptions {
  /** What is loading, for the in-app loading screen ("Settings"). */
  name?: () => string;
}

export interface LazyComponent<P> {
  (props: P): React.ReactNode;
  /** Start the download now (on idle, on hover) so opening is instant later. */
  preload: () => Promise<void>;
}

/**
 * Turns `() => import('./Thing')` into a component that downloads its code on
 * first use. While that happens it shows a placeholder naming what is
 * loading; if the download fails it shows a message **in place** with Retry —
 * the rest of the app keeps working, and retrying needs no page reload.
 */
export function lazyScreen<P extends object>(load: Loader<P>, options: LazyScreenOptions = {}): LazyComponent<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<void> | null = null;

  const fetchModule = (): Promise<void> => {
    if (loaded) return Promise.resolve();
    pending ??= load()
      .then((module) => {
        loaded = module.default;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  function Lazy(props: P) {
    const t = useT();
    const navigate = useNavigate();
    const [, setTick] = useState(0);
    const [error, setError] = useState<unknown>(null);
    const [retrying, setRetrying] = useState(false);
    const showLoading = useDelayedFlag(!loaded && error === null);

    useEffect(() => {
      if (loaded) return;
      let cancelled = false;
      fetchModule().then(
        () => !cancelled && setTick((value) => value + 1),
        (reason: unknown) => !cancelled && setError(reason ?? new Error('load failed')),
      );
      return () => {
        cancelled = true;
      };
    }, []);

    // A failed download still counts as "the first screen is up": the message must be visible.
    useEffect(() => {
      if (error !== null) announceFirstPaint();
    }, [error]);

    if (loaded) {
      const Component = loaded;
      return <Component {...props} />;
    }

    if (error !== null) {
      const retry = () => {
        setRetrying(true);
        fetchModule().then(
          () => {
            setError(null);
            setRetrying(false);
          },
          (reason: unknown) => {
            setError(reason ?? new Error('load failed'));
            setRetrying(false);
          },
        );
      };
      return (
        <div className="screen-status">
          <ErrorState
            kind="unreachable"
            title={t('shell.chunk.title')}
            description={t('shell.chunk.description')}
            onRetry={retry}
            retrying={retrying}
            actions={
              <>
                <Button variant="plain" onClick={() => window.location.reload()}>
                  {t('shell.reload')}
                </Button>
                <Button variant="plain" onClick={() => void navigate('/', { replace: true })}>
                  {t('shell.goHome')}
                </Button>
              </>
            }
          />
        </div>
      );
    }

    return (
      <div className="screen-status" role="status" aria-busy="true">
        {showLoading && (
          <div className="screen-status__loading">
            <Spinner size={26} />
            <span>{options.name ? t('shell.loadingNamed', { name: options.name() }) : t('shell.loading')}</span>
          </div>
        )}
      </div>
    );
  }

  const component = Lazy as LazyComponent<P>;
  component.preload = () => fetchModule().catch(() => {});
  return component;
}

/** Download things while the browser is idle, so the heaviest surfaces open at once later. */
export function preloadWhenIdle(...components: { preload: () => Promise<void> }[]): void {
  const run = () => {
    for (const component of components) void component.preload();
  };
  const idle = (window as unknown as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(run, { timeout: 4_000 });
  else window.setTimeout(run, 1_500);
}
