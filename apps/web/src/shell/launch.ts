/**
 * The hand-over from the launch screen (drawn by index.html, owned by
 * /boot.js) to the app.
 */

interface StudioBoot {
  ready(): void;
  fail(kind: 'crash' | 'download'): void;
  isReady(): boolean;
}

function boot(): StudioBoot | undefined {
  return (window as unknown as { __studioBoot?: StudioBoot }).__studioBoot;
}

let announced = false;

/**
 * The first real screen is in the document. Wait until it has actually been
 * painted (two frames), then let the launch screen go. In a hidden tab frames
 * do not run, so it goes at once.
 */
export function announceFirstPaint(): void {
  if (announced) return;
  announced = true;
  const done = () => boot()?.ready();
  if (document.visibilityState === 'hidden') {
    done();
    return;
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };
  window.requestAnimationFrame(() => window.requestAnimationFrame(finish));
  // Frames can stall (a background tab that became visible mid-start); never leave the launch screen up for that.
  window.setTimeout(finish, 600);
}

/** Start-up cannot continue: show the launch error screen instead of the app. */
export function failLaunch(kind: 'crash' | 'download'): void {
  boot()?.fail(kind);
}

/** Whether the app has taken over from the launch screen. */
export function hasLaunched(): boolean {
  return boot()?.isReady() ?? announced;
}

/** True when an error looks like a script or stylesheet that would not download. */
export function isChunkLoadError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /dynamically imported module|Importing a module script failed|error loading dynamically|Unable to preload CSS|ChunkLoadError|Failed to fetch/i.test(text);
}
