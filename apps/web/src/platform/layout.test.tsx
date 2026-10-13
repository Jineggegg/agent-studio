import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { layoutClassForWidth, useLayoutClass } from './layout';

function resizeTo(width: number): void {
  act(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    window.dispatchEvent(new Event('resize'));
  });
}

function Probe() {
  return <output>{useLayoutClass()}</output>;
}

describe('layout classes', () => {
  it('depend on the viewport width alone, with boundaries at 699/700 and 1023/1024', () => {
    expect(layoutClassForWidth(320)).toBe('phone');
    expect(layoutClassForWidth(699)).toBe('phone');
    expect(layoutClassForWidth(700)).toBe('tablet');
    expect(layoutClassForWidth(1023)).toBe('tablet');
    expect(layoutClassForWidth(1024)).toBe('wide');
    expect(layoutClassForWidth(2560)).toBe('wide');
  });

  it('follow the window as it is resized, rotated or put in split view', () => {
    resizeTo(390);
    render(<Probe />);
    expect(screen.getByRole('status')).toHaveTextContent('phone');
    expect(document.documentElement.dataset.layout).toBe('phone');

    resizeTo(820);
    expect(screen.getByRole('status')).toHaveTextContent('tablet');
    expect(document.documentElement.dataset.layout).toBe('tablet');

    resizeTo(1440);
    expect(screen.getByRole('status')).toHaveTextContent('wide');

    // a tablet in a 500 px split view is a phone
    resizeTo(500);
    expect(screen.getByRole('status')).toHaveTextContent('phone');
    expect(document.documentElement.dataset.layout).toBe('phone');
  });

  it('gives every component the same answer', () => {
    resizeTo(1024);
    render(
      <>
        <Probe />
        <Probe />
      </>,
    );
    expect(screen.getAllByRole('status').map((node) => node.textContent)).toEqual(['wide', 'wide']);
    resizeTo(699);
    expect(screen.getAllByRole('status').map((node) => node.textContent)).toEqual(['phone', 'phone']);
  });
});
