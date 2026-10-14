import type { Page } from '@playwright/test';

/**
 * Finds the interactive elements a person can see and reach on the current
 * screen, and measures how large an area a tap on each lands on.
 *
 * The hit area is measured, not read from the box: many controls are drawn
 * small and widened by a transparent pseudo-element (`::after { inset: -8px }`),
 * and some are partly covered by their neighbours. From the centre of each
 * control the scan walks outwards one CSS pixel at a time, left, right, up and
 * down, for as long as `elementFromPoint` still lands on the control (or on
 * something inside it). Width and height are the lengths of those two runs
 * (at most 121 px: the scan stops 60 px from the centre).
 */

export interface Control {
  /** Set on the element as `data-e2e-control`, so a locator can find it again. */
  readonly id: string;
  readonly description: string;
  readonly box: { readonly width: number; readonly height: number };
  readonly hit: { readonly width: number; readonly height: number };
  /** The allow-list entry it matched, if any. */
  readonly exemption: Exemption | null;
}

export interface Exemption {
  /** A CSS selector the element matches. */
  readonly selector: string;
  readonly reason: string;
  /** The size it must still reach, in CSS px; absent: none. */
  readonly minimum?: number;
}

const INTERACTIVE = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  ...[
    'button',
    'link',
    'tab',
    'radio',
    'checkbox',
    'switch',
    'menuitem',
    'menuitemradio',
    'menuitemcheckbox',
    'option',
    'treeitem',
    'slider',
    'searchbox',
    'textbox',
    'combobox',
    'separator',
  ].map((role) => `[role="${role}"]`),
].join(', ');

export async function visibleControls(
  page: Page,
  exemptions: readonly Exemption[] = [],
): Promise<Control[]> {
  return page.evaluate(
    ({ selector, exemptions: rules }) => {
      const reach = 60;
      const found: Control[] = [];
      document
        .querySelectorAll('[data-e2e-control]')
        .forEach((element) => element.removeAttribute('data-e2e-control'));
      const candidates = [...document.querySelectorAll<HTMLElement>(selector)];
      candidates.forEach((element, index) => {
        // A separator is interactive only when it can be focused (the inspector's resize handle).
        if (element.getAttribute('role') === 'separator' && element.tabIndex < 0) return;
        if (element.closest('[inert], [aria-hidden="true"], [hidden]')) return;
        if (
          !element.checkVisibility({
            opacityProperty: true,
            visibilityProperty: true,
            checkOpacity: true,
            checkVisibilityCSS: true,
          } as CheckVisibilityOptions)
        )
          return;
        const rect = element.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return; // visually hidden (1 × 1, clipped): reached by a visible proxy
        if (
          rect.bottom <= 0 ||
          rect.right <= 0 ||
          rect.top >= window.innerHeight ||
          rect.left >= window.innerWidth
        )
          return;
        // Sample the middle of each CSS pixel of the element's own grid, so a 44 px control measures 44, not 43.
        const columns = Math.max(1, Math.round(rect.width));
        const rows = Math.max(1, Math.round(rect.height));
        const xAt = (column: number) => rect.left + (column + 0.5) * (rect.width / columns);
        const yAt = (row: number) => rect.top + (row + 0.5) * (rect.height / rows);
        const middleColumn = Math.floor(columns / 2);
        const middleRow = Math.floor(rows / 2);
        const lands = (x: number, y: number) => {
          if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
          const target = document.elementFromPoint(x, y);
          return target !== null && (target === element || element.contains(target));
        };
        // Covered at its centre (scrolled under a bar, behind a sheet): not something a tap can reach right now.
        if (!lands(xAt(middleColumn), yAt(middleRow))) return;
        const extent = (at: (step: number) => boolean, middle: number) => {
          let low = middle;
          while (middle - low < reach && at(low - 1)) low -= 1;
          let high = middle;
          while (high - middle < reach && at(high + 1)) high += 1;
          return high - low + 1;
        };
        const hitWidth = extent((column) => lands(xAt(column), yAt(middleRow)), middleColumn);
        const hitHeight = extent((row) => lands(xAt(middleColumn), yAt(row)), middleRow);
        const id = String(index);
        element.setAttribute('data-e2e-control', id);
        const name =
          element.getAttribute('aria-label') ??
          element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60) ??
          '';
        const classes = [...element.classList].slice(0, 3).join('.');
        const exemption = rules.find((rule) => element.matches(rule.selector));
        found.push({
          id,
          description: `<${element.tagName.toLowerCase()}${element.getAttribute('role') ? ` role="${element.getAttribute('role')}"` : ''}${classes ? ` class="${classes}"` : ''}> "${name}"`,
          box: { width: Math.round(rect.width), height: Math.round(rect.height) },
          hit: { width: hitWidth, height: hitHeight },
          exemption: exemption ?? null,
        });
      });
      return found;
    },
    { selector: INTERACTIVE, exemptions },
  );
}
