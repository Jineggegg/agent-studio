import { type KeyboardEvent, type ReactNode, useRef } from 'react';

export interface TabItem<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** A badge or activity mark after the label. */
  accessory?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  /** Accessible name of the tab list. */
  label: string;
  value: T;
  onChange: (value: T) => void;
  tabs: readonly TabItem<T>[];
  /** Share the width equally instead of hugging the labels. */
  stretch?: boolean;
  /**
   * Prefix for ids, so panels can point back at their tab:
   * tab id = `${idBase}-tab-${value}`, panel id = `${idBase}-panel-${value}`.
   */
  idBase?: string;
  className?: string;
}

/**
 * Sibling views of one thing. Arrow keys move between tabs; only the selected
 * tab is in the Tab order.
 *
 * Tabs that are routes are siblings in history too: change route with
 * `navigate(to, { replace: true })` so that Back leaves the whole set.
 */
export function Tabs<T extends string>({ label, value, onChange, tabs, stretch, idBase, className }: TabsProps<T>) {
  const list = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent) => {
    const enabled = tabs.filter((tab) => !tab.disabled);
    const index = enabled.findIndex((tab) => tab.value === value);
    let next: TabItem<T> | undefined;
    if (event.key === 'ArrowRight') next = enabled[(index + 1) % enabled.length];
    else if (event.key === 'ArrowLeft') next = enabled[(index - 1 + enabled.length) % enabled.length];
    else if (event.key === 'Home') next = enabled[0];
    else if (event.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    event.preventDefault();
    onChange(next.value);
    const button = list.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`);
    button?.focus();
    button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };

  return (
    <div ref={list} role="tablist" aria-label={label} className={className ? `ui-tabs ${className}` : 'ui-tabs'} data-stretch={stretch || undefined} onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={idBase ? `${idBase}-tab-${tab.value}` : undefined}
            aria-controls={idBase ? `${idBase}-panel-${tab.value}` : undefined}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            data-value={tab.value}
            className="ui-tab"
            onClick={() => {
              if (!selected) onChange(tab.value);
            }}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.accessory}
          </button>
        );
      })}
    </div>
  );
}

/** Props for the element that shows a tab's content. */
export function tabPanelProps(idBase: string, value: string): { role: 'tabpanel'; id: string; 'aria-labelledby': string; tabIndex: 0 } {
  return { role: 'tabpanel', id: `${idBase}-panel-${value}`, 'aria-labelledby': `${idBase}-tab-${value}`, tabIndex: 0 };
}
