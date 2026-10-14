import type { TerminalEndReason, TerminalLocalUrl, TerminalSession } from '@agent-studio/protocol';
import { FitAddon } from '@xterm/addon-fit';
import { type ITheme, Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { ArrowBigUp, ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste, Copy, ExternalLink, X } from 'lucide-react';
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { isApiError } from '@/data/api';
import { endSession } from '@/data/auth';
import { requestReauth } from '@/data/reauth';
import { type MessageKey, useT } from '@/i18n';
import { copyText } from '@/platform/clipboard';
import { useTheme } from '@/platform/theme';
import { Button, Sheet, Spinner, TextArea, toast } from '@/ui';
import { socketUrl, terminalApi } from './api';
import { TerminalClient, type TerminalPhase, type TerminalSocket } from './client';
import { type ArrowKey, KEYS, type Modifiers, NO_MODIFIERS, applyModifiers, arrowSequence, clampFontSize, distinctUrls, wordAt } from './keys';
import './terminal.css';

const NOTHING = new Uint8Array(0);

export interface TerminalViewHandle {
  /** Resolves true once the shell has printed something on a live connection — the moment text can be typed into it. */
  whenReady(timeoutMs: number): Promise<boolean>;
  focus(): void;
}

export interface TerminalViewProps {
  sessionId: string;
  /** On show and laid out. A hidden terminal keeps its connection but does not measure itself. */
  visible: boolean;
  /** Draw the helper keys a soft keyboard lacks. */
  keyBar: boolean;
  fontSize: number;
  onFontSize: (size: number) => void;
  onSession?: (session: TerminalSession) => void;
  /** Start a new terminal in place of one that is over. */
  onReplace?: (() => void) | undefined;
  /** The server says terminals cannot be used: the capability should be read again. */
  onUnavailable?: () => void;
  ref?: Ref<TerminalViewHandle>;
}

const token = (name: string): string => window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** The terminal's colours, read from the Studio's tokens so it follows the theme. */
function readTheme(dark: boolean): ITheme {
  const text = token('--code-text');
  const background = token('--code-bg');
  const palette = {
    red: token('--code-deletion'),
    green: token('--code-string'),
    yellow: token('--code-number'),
    blue: token('--code-title'),
    magenta: token('--code-keyword'),
    cyan: token('--code-attr'),
  };
  return {
    background,
    foreground: text,
    cursor: token('--color-accent'),
    cursorAccent: background,
    selectionBackground: token('--color-selection'),
    black: dark ? token('--color-surface-alt') : text,
    white: dark ? text : token('--color-text-secondary'),
    brightBlack: token('--code-comment'),
    brightWhite: dark ? text : token('--color-text'),
    ...palette,
    brightRed: palette.red,
    brightGreen: palette.green,
    brightYellow: palette.yellow,
    brightBlue: palette.blue,
    brightMagenta: palette.magenta,
    brightCyan: palette.cyan,
  };
}

const END_REASON: Record<TerminalEndReason, MessageKey> = {
  exited: 'terminal.ended.exited',
  closed: 'terminal.ended.closed',
  idle: 'terminal.ended.idle',
  lifetime: 'terminal.ended.lifetime',
  shutdown: 'terminal.ended.shutdown',
  revoked: 'terminal.ended.revoked',
  project_removed: 'terminal.ended.project_removed',
  failed: 'terminal.ended.failed',
};

/** Each way a connection can come to rest, as a sentence. */
const REST_COPY: Partial<Record<TerminalPhase, MessageKey>> = {
  'needs-identity': 'terminal.rest.needsIdentity',
  'signed-out': 'terminal.rest.signedOut',
  gone: 'terminal.rest.gone',
  crowded: 'terminal.rest.crowded',
  unavailable: 'terminal.rest.unavailable',
  failed: 'terminal.rest.failed',
};

/**
 * One terminal session on screen: xterm.js fed by the protocol client. It
 * owns the widget and the socket and disposes of both when it goes; the
 * session itself lives on the server and is found again by its id.
 */
export function TerminalView({ sessionId, visible, keyBar, fontSize, onFontSize, onSession, onReplace, onUnavailable, ref }: TerminalViewProps) {
  const t = useT();
  const theme = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const client = useRef<TerminalClient | null>(null);
  const modifiers = useRef<Modifiers>(NO_MODIFIERS);
  const callbacks = useRef({ onSession, onFontSize });
  useEffect(() => {
    callbacks.current = { onSession, onFontSize };
  });

  const [phase, setPhase] = useState<TerminalPhase>('connecting');
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [urls, setUrls] = useState<TerminalLocalUrl[]>([]);
  const [exit, setExit] = useState<{ code: number | null; reason: TerminalEndReason } | null>(null);
  const [selected, setSelected] = useState(false);
  const [mods, setMods] = useState<Modifiers>(NO_MODIFIERS);
  const [notice, setNotice] = useState<'reconnected' | 'truncated' | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [confirming, setConfirming] = useState(false);

  const setModifiers = useCallback((next: Modifiers) => {
    modifiers.current = next;
    setMods(next);
  }, []);

  /** Set while a replay is drawn at the size its output was made at; the widget returns to its own size once that is done. */
  const replaySize = useRef(false);

  const refit = useCallback(() => {
    const element = host.current;
    if (replaySize.current || !element || element.clientWidth < 20 || element.clientHeight < 20) return;
    try {
      fit.current?.fit();
    } catch {
      /* not laid out yet; the next resize measures again */
    }
  }, []);

  // ---- the widget and its connection -----------------------------------------------------

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const widget = new Terminal({
      fontFamily: token('--font-mono') || 'monospace',
      fontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10_000,
      macOptionIsMeta: true,
      minimumContrastRatio: 4.5,
      allowProposedApi: false,
      theme: readTheme(document.documentElement.dataset.theme === 'dark'),
    });
    const fitter = new FitAddon();
    widget.loadAddon(fitter);
    widget.open(element);
    terminal.current = widget;
    fit.current = fitter;
    refit();

    const connection = new TerminalClient({
      sessionId,
      // The one WebSocket this feature opens itself: the terminal's own channel, which the shared live connection does not carry.
      createSocket: (path) => new WebSocket(socketUrl(path)) as unknown as TerminalSocket,
      size: () => ({ cols: widget.cols, rows: widget.rows }),
      probe: () =>
        terminalApi.session(sessionId).then(
          () => 'ok' as const,
          (error: unknown) => (isApiError(error) && error.gone ? 'gone' : isApiError(error) && error.status === 403 ? 'unavailable' : 'unreachable'),
        ),
      events: {
        onPhase: (next, detail) => {
          setPhase(next);
          setAttempt(detail.attempt);
          if (next === 'live' && replaySize.current) {
            // Once everything replayed has been drawn, the widget takes its own size again and the lines reflow to it.
            widget.write(NOTHING, () => {
              replaySize.current = false;
              refit();
            });
          } else if (next !== 'replaying' && replaySize.current) {
            // The connection went away mid-replay: the next attach must announce this browser's own size.
            replaySize.current = false;
            refit();
          }
          // The browser session is over: the same thing every refused request does.
          if (next === 'signed-out') endSession('expired');
        },
        onData: (bytes) => widget.write(bytes),
        onReset: ({ truncated }) => {
          widget.reset();
          if (truncated) setNotice('truncated');
        },
        onAttached: ({ first, replay, session: attached }) => {
          if (!first && replay.mode === 'delta') setNotice('reconnected');
          // What is replayed was drawn at the size the terminal had then. Written at another width, a shell's own line
          // editing lands on the wrong lines; written at that size and then resized, the widget reflows it correctly.
          const { cols, rows } = attached;
          if (replay.to > replay.from && cols >= 2 && rows >= 1 && (cols !== widget.cols || rows !== widget.rows)) {
            replaySize.current = true;
            widget.resize(cols, rows);
          }
        },
        onSession: (next) => {
          setSession(next);
          setUrls(next.urls);
          callbacks.current.onSession?.(next);
        },
        onUrl: (url) => setUrls((current) => (current.some((entry) => entry.url === url.url) ? current : [...current, url])),
        onExit: (frame) => setExit({ code: frame.exitCode, reason: frame.reason }),
      },
    });
    client.current = connection;

    const send = (data: string) => {
      const active = modifiers.current;
      const out = applyModifiers(data, active);
      // A sticky modifier is spent by the one key it changed.
      if ((active.ctrl || active.alt) && [...data].length === 1) setModifiers(NO_MODIFIERS);
      connection.send(out);
    };
    const subscriptions = [
      widget.onData(send),
      widget.onBinary((data) => connection.send(Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff))),
      // A size taken only to draw a replay is not this browser's size: the server is not told.
      widget.onResize(({ cols, rows }) => {
        if (!replaySize.current) connection.resize(cols, rows);
      }),
      widget.onSelectionChange(() => setSelected(widget.hasSelection())),
    ];
    widget.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return true;
      const key = event.key.toLowerCase();
      // Ctrl+C copies when something is selected and interrupts otherwise; Ctrl+V is the browser's paste, not ^V.
      if (key === 'c' && !event.shiftKey && widget.hasSelection()) {
        void copyText(widget.getSelection());
        widget.clearSelection();
        return false;
      }
      if (key === 'v') return false;
      return true;
    });
    connection.connect();

    const wake = () => {
      if (document.visibilityState === 'visible') connection.wake();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);

    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('pageshow', wake);
      for (const subscription of subscriptions) subscription.dispose();
      connection.dispose();
      client.current = null;
      terminal.current = null;
      fit.current = null;
      widget.dispose();
    };
    // One widget and one connection per mounted session; size and theme are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // The widget follows its container: rotation, the inspector's edge, the soft keyboard.
  useEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let timer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(refit, 50);
    });
    observer.observe(element);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [refit]);

  useEffect(() => {
    if (!visible) return;
    const frame = window.requestAnimationFrame(() => {
      refit();
      client.current?.wake();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visible, refit]);

  useEffect(() => {
    const widget = terminal.current;
    if (!widget || widget.options.fontSize === fontSize) return;
    widget.options.fontSize = fontSize;
    refit();
  }, [fontSize, refit]);

  useEffect(() => {
    const widget = terminal.current;
    if (widget) widget.options.theme = readTheme(theme === 'dark');
  }, [theme]);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useImperativeHandle(
    ref,
    (): TerminalViewHandle => ({
      whenReady: (timeoutMs) =>
        new Promise<boolean>((resolve) => {
          const started = Date.now();
          const check = () => {
            const connection = client.current;
            if (connection && connection.phase === 'live' && (connection.seq ?? 0) > 0) return resolve(true);
            if (!connection || Date.now() - started > timeoutMs) return resolve(false);
            window.setTimeout(check, 120);
          };
          check();
        }),
      focus: () => terminal.current?.focus(),
    }),
    [],
  );

  // ---- touch: press and hold a word to select it, pinch to resize the text ------------------

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let hold: { timer: number; x: number; y: number } | null = null;
    let pinch: { distance: number; size: number } | null = null;
    const cancelHold = () => {
      if (hold) window.clearTimeout(hold.timer);
      hold = null;
    };
    const spread = (touches: TouchList) => Math.hypot(touches[0]!.clientX - touches[1]!.clientX, touches[0]!.clientY - touches[1]!.clientY);

    const selectWordAt = (x: number, y: number) => {
      const widget = terminal.current;
      const screen = element.querySelector<HTMLElement>('.xterm-screen');
      if (!widget || !screen) return;
      const box = screen.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      const column = Math.floor((x - box.left) / (box.width / widget.cols));
      const row = Math.floor((y - box.top) / (box.height / widget.rows));
      const lineIndex = widget.buffer.active.viewportY + row;
      const text = widget.buffer.active.getLine(lineIndex)?.translateToString(false) ?? '';
      const word = wordAt(text, column);
      if (!word) return;
      widget.select(word.start, lineIndex, word.length);
      navigator.vibrate?.(8);
    };

    const onStart = (event: TouchEvent) => {
      cancelHold();
      if (event.touches.length === 2) {
        pinch = { distance: spread(event.touches), size: terminal.current?.options.fontSize ?? fontSize };
        return;
      }
      if (event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      hold = { x: touch.clientX, y: touch.clientY, timer: window.setTimeout(() => hold && selectWordAt(hold.x, hold.y), 520) };
    };
    const onMove = (event: TouchEvent) => {
      if (pinch && event.touches.length === 2) {
        event.preventDefault();
        const next = clampFontSize(pinch.size * (spread(event.touches) / Math.max(1, pinch.distance)));
        if (next !== terminal.current?.options.fontSize) callbacks.current.onFontSize(next);
        return;
      }
      const touch = event.touches[0];
      if (hold && touch && Math.hypot(touch.clientX - hold.x, touch.clientY - hold.y) > 9) cancelHold();
    };
    const onEnd = () => {
      cancelHold();
      pinch = null;
    };
    element.addEventListener('touchstart', onStart, { passive: true });
    element.addEventListener('touchmove', onMove, { passive: false });
    element.addEventListener('touchend', onEnd);
    element.addEventListener('touchcancel', onEnd);
    return () => {
      cancelHold();
      element.removeEventListener('touchstart', onStart);
      element.removeEventListener('touchmove', onMove);
      element.removeEventListener('touchend', onEnd);
      element.removeEventListener('touchcancel', onEnd);
    };
    // The handlers read the current size from the widget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- the helper keys ---------------------------------------------------------------------

  const press = (data: string) => {
    client.current?.send(modifiers.current.alt ? `${KEYS.escape}${data}` : data);
    if (modifiers.current.ctrl || modifiers.current.alt) setModifiers(NO_MODIFIERS);
  };
  const arrow = (key: ArrowKey) => {
    client.current?.send(arrowSequence(key, modifiers.current, terminal.current?.modes.applicationCursorKeysMode ?? false));
    if (modifiers.current.ctrl || modifiers.current.alt) setModifiers(NO_MODIFIERS);
  };
  const paste = async () => {
    // A phone only hands over the clipboard in answer to a tap, and only on a secure address; otherwise a field takes its place.
    try {
      if (navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText();
        if (text !== '') terminal.current?.paste(text);
        return;
      }
    } catch {
      /* refused: fall through to the field */
    }
    setPasteText('');
    setPasting(true);
  };
  const copySelection = () => {
    const widget = terminal.current;
    if (!widget) return;
    void copyText(widget.getSelection()).then((copied) => {
      if (copied) toast.success(t('terminal.copied'));
      widget.clearSelection();
    });
  };

  const confirmIdentity = async () => {
    setConfirming(true);
    try {
      if (await requestReauth()) client.current?.connect();
    } finally {
      setConfirming(false);
    }
  };

  const live = phase === 'live' || phase === 'replaying';
  // Pressing a helper key must not take the focus — and with it the soft keyboard — away from the terminal.
  const keep = { tabIndex: -1, onPointerDown: (event: { preventDefault: () => void }) => event.preventDefault() };
  const restKey = REST_COPY[phase];
  const ended = phase === 'ended';
  const endedReason = exit?.reason ?? session?.endReason ?? 'exited';
  const endedCode = exit?.code ?? session?.exitCode ?? null;

  return (
    <div className="term" data-phase={phase} data-keys="own">
      {urls.length > 0 && (
        <div className="term__urls" role="group" aria-label={t('terminal.urls.label')}>
          {distinctUrls(urls, window.location.hostname).map(({ url, href, label, substituted }) => (
            <a key={href} className="term__url" href={href} target="_blank" rel="noopener noreferrer" title={substituted ? t('terminal.urls.substituted', { printed: url.url }) : url.url}>
              <ExternalLink size={14} aria-hidden="true" />
              <span className="u-truncate">{label}</span>
            </a>
          ))}
        </div>
      )}

      <div className="term__screen">
        <div ref={host} className="term__host" />
        {selected && (
          <div className="term__selection">
            <button type="button" className="term__chip" onClick={copySelection} {...keep}>
              <Copy size={15} aria-hidden="true" />
              {t('common.copy')}
            </button>
            <button type="button" className="term__chip term__chip--icon" onClick={() => terminal.current?.clearSelection()} aria-label={t('terminal.clearSelection')} {...keep}>
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        )}
        {(phase === 'connecting' || phase === 'reconnecting' || notice !== null) && !selected && (
          <p className="term__status" role="status">
            {phase === 'connecting' || phase === 'reconnecting' ? <Spinner size={13} /> : null}
            {phase === 'connecting'
              ? t('terminal.connecting')
              : phase === 'reconnecting'
                ? attempt > 2
                  ? t('terminal.reconnectingStill')
                  : t('terminal.reconnecting')
                : notice === 'truncated'
                  ? t('terminal.replayTruncated')
                  : t('terminal.reconnected')}
          </p>
        )}
        {(restKey || ended) && (
          <div className="term__rest" role="alert">
            <p>{ended ? `${t(END_REASON[endedReason])}${endedCode !== null && endedReason === 'exited' ? ` ${t('terminal.ended.code', { code: endedCode })}` : ''}` : t(restKey!)}</p>
            <div className="term__rest-actions">
              {phase === 'needs-identity' && (
                <Button size="sm" variant="primary" loading={confirming} onClick={() => void confirmIdentity()}>
                  {t('terminal.rest.confirm')}
                </Button>
              )}
              {(phase === 'crowded' || phase === 'failed') && (
                <Button size="sm" variant="primary" onClick={() => client.current?.reattachFresh()}>
                  {t('terminal.rest.attachAgain')}
                </Button>
              )}
              {phase === 'unavailable' && onUnavailable && (
                <Button size="sm" variant="primary" onClick={onUnavailable}>
                  {t('terminal.rest.checkAgain')}
                </Button>
              )}
              {(ended || phase === 'gone') && onReplace && (
                <Button size="sm" variant="primary" onClick={onReplace}>
                  {t('terminal.rest.startNew')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {keyBar && (
        <div className="term__keys" role="toolbar" aria-label={t('terminal.keys.label')} data-disabled={!live || undefined}>
          <button type="button" className="term__key" disabled={!live} onClick={() => press(KEYS.escape)} {...keep}>
            Esc
          </button>
          <button type="button" className="term__key" disabled={!live} onClick={() => press(KEYS.tab)} {...keep}>
            Tab
          </button>
          <button type="button" className="term__key" disabled={!live} aria-pressed={mods.ctrl} onClick={() => setModifiers({ ...modifiers.current, ctrl: !modifiers.current.ctrl })} aria-label={t('terminal.keys.ctrl')} {...keep}>
            Ctrl
          </button>
          <button type="button" className="term__key" disabled={!live} aria-pressed={mods.alt} onClick={() => setModifiers({ ...modifiers.current, alt: !modifiers.current.alt })} aria-label={t('terminal.keys.alt')} {...keep}>
            Alt
          </button>
          <button type="button" className="term__key" disabled={!live} onClick={() => arrow('left')} aria-label={t('terminal.keys.left')} {...keep}>
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
          <button type="button" className="term__key" disabled={!live} onClick={() => arrow('down')} aria-label={t('terminal.keys.down')} {...keep}>
            <ArrowDown size={18} aria-hidden="true" />
          </button>
          <button type="button" className="term__key" disabled={!live} onClick={() => arrow('up')} aria-label={t('terminal.keys.up')} {...keep}>
            <ArrowUp size={18} aria-hidden="true" />
          </button>
          <button type="button" className="term__key" disabled={!live} onClick={() => arrow('right')} aria-label={t('terminal.keys.right')} {...keep}>
            <ArrowRight size={18} aria-hidden="true" />
          </button>
          <button type="button" className="term__key term__key--wide" disabled={!live} onClick={() => press(KEYS.interrupt)} aria-label={t('terminal.keys.interrupt')} {...keep}>
            ^C
          </button>
          <button type="button" className="term__key" disabled={!live} onClick={() => press(KEYS.shiftTab)} aria-label={t('terminal.keys.shiftTab')} {...keep}>
            <ArrowBigUp size={16} aria-hidden="true" />
            Tab
          </button>
          <button type="button" className="term__key" disabled={!live} onClick={() => void paste()} aria-label={t('terminal.keys.paste')} {...keep}>
            <ClipboardPaste size={18} aria-hidden="true" />
          </button>
          <button type="button" className="term__key" onClick={() => terminal.current?.scrollToBottom()} aria-label={t('terminal.keys.end')} {...keep}>
            <ArrowDownToLine size={18} aria-hidden="true" />
          </button>
        </div>
      )}

      <Sheet
        open={pasting}
        onClose={() => setPasting(false)}
        title={t('terminal.paste.title')}
        footer={
          <Button
            variant="primary"
            block
            disabled={pasteText === ''}
            onClick={() => {
              terminal.current?.paste(pasteText);
              setPasting(false);
              terminal.current?.focus();
            }}
          >
            {t('terminal.paste.send')}
          </Button>
        }
      >
        <TextArea label={t('terminal.paste.label')} hint={t('terminal.paste.hint')} value={pasteText} onChange={setPasteText} rows={4} autoGrow maxRows={10} mono data-autofocus="" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </Sheet>
    </div>
  );
}
