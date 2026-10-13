import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastViewport, toast, toastDuration } from './Toast';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  act(() => toast.clear());
  vi.useRealTimers();
});

describe('toasts', () => {
  it('stay on screen for a time that depends on what they carry', () => {
    expect(toastDuration({ title: 'Copied' })).toBe(3_000);
    expect(toastDuration({ title: 'Archived', action: { label: 'Undo', onSelect: () => {} } })).toBe(6_000);
    expect(toastDuration({ title: 'Saved', detail: 'On every device.' })).toBe(6_000);
    expect(toastDuration({ title: 'Slow', kind: 'warning' })).toBe(7_000);
    expect(toastDuration({ title: 'Failed', kind: 'error' })).toBe(7_000);
    expect(toastDuration({ title: 'Updated', duration: 'persistent' })).toBeNull();
    expect(toastDuration({ title: 'Custom', duration: 1_234 })).toBe(1_234);
  });

  it('appear, announce themselves, and leave by themselves', () => {
    render(<ToastViewport />);
    act(() => void toast.success('Project created'));
    expect(screen.getByRole('status')).toHaveTextContent('Project created');
    act(() => void vi.advanceTimersByTime(3_300));
    expect(screen.queryByText('Project created')).not.toBeInTheDocument();

    act(() => void toast.error('Could not save'));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save');
  });

  it('carry an action that runs once and dismisses the toast', () => {
    const undo = vi.fn();
    render(<ToastViewport />);
    act(() => void toast.show({ title: 'Session archived', action: { label: 'Undo', onSelect: undo } }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(300));
    expect(screen.queryByText('Session archived')).not.toBeInTheDocument();
  });

  it('keep a persistent toast until it is acted on, one instance per id', () => {
    render(<ToastViewport />);
    act(() => void toast.show({ id: 'update', title: 'Updated', duration: 'persistent', action: { label: 'Refresh', onSelect: () => {} } }));
    act(() => void toast.show({ id: 'update', title: 'Updated', duration: 'persistent', action: { label: 'Refresh', onSelect: () => {} } }));
    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.getAllByText('Updated')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });
});
