import { type ReactNode, createContext, useContext, useEffect, useRef, useState } from 'react';
import { type Location, useLocation } from 'react-router';

/**
 * How one screen replaces another.
 *
 *  push   deeper into a hierarchy: the new screen slides in from the trailing edge
 *  pop    back out of it: the old screen slides away to the trailing edge
 *  open   an app opens over the home screen: it rises into place
 *  close  an app closes back to the home screen
 *  fade   siblings swap: a cross-fade
 *  none   an immediate swap (the system already animated it, e.g. an edge swipe in the browser)
 *
 * Under reduced motion every kind is a short cross-fade (see --motion-distance in tokens.css).
 */
export type TransitionKind = 'push' | 'pop' | 'open' | 'close' | 'fade' | 'none';

export interface ScreenContextValue {
  /** False while the screen is on its way out, or covered. Stop polling and decorative motion then. */
  active: boolean;
  /** The location this screen was shown for. It does not change while the screen animates away. */
  location: Location;
  /** How deeply stacks are nested here; inner screens outrank outer ones for "back". */
  depth: number;
}

const ScreenContext = createContext<ScreenContextValue | null>(null);

/** The screen a component belongs to. Outside any stack: active, at the router's location. */
export function useScreen(): ScreenContextValue {
  const context = useContext(ScreenContext);
  const location = useLocation();
  return context ?? { active: true, location, depth: 0 };
}

/** Whether this screen is the one on show. False while it leaves or is covered: pause polling and animation. */
export function useScreenActive(): boolean {
  return useScreen().active;
}

export function ScreenScope({ value, children }: { value: ScreenContextValue; children: ReactNode }) {
  return <ScreenContext.Provider value={value}>{children}</ScreenContext.Provider>;
}

interface Layer {
  key: string;
  node: ReactNode;
  location: Location;
}

export interface ScreenStackProps {
  /** Identifies the screen on show. Null shows nothing (whatever is under the stack is revealed). */
  screenKey: string | null;
  /** The transition to play when `screenKey` changes. */
  kind: TransitionKind;
  /** The screen for `screenKey`. */
  children: ReactNode;
  className?: string;
  /** Let touches through where no screen is showing (a stack that sits over other content). */
  passThrough?: boolean;
}

const SAFETY_MS = 520;

/**
 * Shows one screen at a time and animates between them, keeping the outgoing
 * screen alive (inert, and unaware that the route has changed) until its exit
 * has played. Compositor-only: transforms and opacity.
 */
export function ScreenStack({ screenKey, kind, children, className, passThrough }: ScreenStackProps) {
  const location = useLocation();
  const parent = useContext(ScreenContext);
  const depth = (parent?.depth ?? 0) + 1;
  const parentActive = parent?.active ?? true;

  const [state, setState] = useState<{ key: string | null; exiting: Layer | null; kind: TransitionKind; entering: boolean }>({
    key: screenKey,
    exiting: null,
    kind: 'none',
    entering: false,
  });
  /** What was last committed for the current key: the picture to keep while it leaves. */
  const committed = useRef<Layer | null>(null);

  if (state.key !== screenKey) {
    const previous = committed.current;
    setState({
      key: screenKey,
      kind,
      exiting: kind !== 'none' && previous && previous.key === state.key ? previous : null,
      entering: kind !== 'none' && screenKey !== null,
    });
  }

  useEffect(() => {
    committed.current = screenKey === null ? null : { key: screenKey, node: children, location };
  });

  // Never depend on an animation event alone to finish a transition.
  useEffect(() => {
    if (!state.exiting && !state.entering) return;
    const timer = window.setTimeout(() => setState((current) => ({ ...current, exiting: null, entering: false })), SAFETY_MS);
    return () => window.clearTimeout(timer);
  }, [state.exiting, state.entering]);

  return (
    <div className={className ? `stack ${className}` : 'stack'} data-pass-through={passThrough || undefined}>
      {state.exiting && (
        <div
          key={state.exiting.key}
          className="stack__layer"
          data-phase="exit"
          data-kind={state.kind}
          inert
          aria-hidden="true"
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) setState((value) => ({ ...value, exiting: null }));
          }}
        >
          <ScreenContext.Provider value={{ active: false, location: state.exiting.location, depth }}>{state.exiting.node}</ScreenContext.Provider>
        </div>
      )}
      {screenKey !== null && (
        <div
          key={screenKey}
          className="stack__layer"
          data-phase={state.entering ? 'enter' : 'rest'}
          data-kind={state.entering ? state.kind : undefined}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) setState((value) => ({ ...value, entering: false }));
          }}
        >
          <ScreenContext.Provider value={{ active: parentActive, location, depth }}>{children}</ScreenContext.Provider>
        </div>
      )}
    </div>
  );
}

/**
 * The transition for a stack whose screens follow the route: deeper is a
 * push, back is a pop, a replaced entry (a sibling) cross-fades. Give it the
 * same key you give the stack.
 */
export function useRouteTransition(screenKey: string | null, navigationType: 'PUSH' | 'POP' | 'REPLACE', systemGesture: () => boolean): TransitionKind {
  const previous = useRef(screenKey);
  let kind: TransitionKind = 'none';
  if (previous.current !== screenKey) {
    if (navigationType === 'POP') kind = systemGesture() ? 'none' : 'pop';
    else kind = navigationType === 'PUSH' ? 'push' : 'fade';
  }
  useEffect(() => {
    previous.current = screenKey;
  }, [screenKey]);
  return kind;
}
