import { useEffect } from 'react';
import { useScreen } from './ScreenStack';
import { setEntryTitle } from './history';

export const APP_NAME = 'Cloud Harness';

interface TitleEntry {
  depth: number;
  order: number;
  title: string;
}

const titles = new Set<TitleEntry>();
let order = 0;

function apply(): void {
  let top: TitleEntry | null = null;
  for (const entry of titles) {
    if (!top || entry.depth > top.depth || (entry.depth === top.depth && entry.order > top.order))
      top = entry;
  }
  document.title = top && top.title ? `${top.title} · ${APP_NAME}` : APP_NAME;
}

/**
 * Names the current context in the tab title ("Settings · Cloud Harness") and
 * remembers it for the back control of whatever screen comes next. Pass an
 * empty string for the root (the title is then just the product name).
 */
export function useDocumentTitle(title: string): void {
  const screen = useScreen();
  const { active, depth } = screen;
  const key = screen.location.key;
  useEffect(() => {
    if (!active) return;
    const entry: TitleEntry = { depth, order: (order += 1), title };
    titles.add(entry);
    apply();
    return () => {
      titles.delete(entry);
      apply();
    };
  }, [active, depth, title]);
  useEffect(() => {
    if (title) setEntryTitle(key, title);
  }, [key, title]);
}
