import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// A few tests run in plain Node (`// @vitest-environment node`): nothing below applies to them.
const inBrowser = typeof window !== 'undefined';

// jsdom has no layout engine and lacks a few browser APIs the components touch.
if (inBrowser && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
if (inBrowser) {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
}

afterEach(() => {
  if (!inBrowser) return;
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
