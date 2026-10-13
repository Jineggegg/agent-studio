import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { Sheet, type SheetProps } from './Sheet';
import { TextField } from './TextField';
import { __resetOverlaysForTests, isAnyOverlayOpen } from './overlay';

function Harness({ sheet, onClose }: { sheet?: Partial<SheetProps>; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  return (
    <div id="app-content">
      <button type="button" onClick={() => setOpen(true)}>
        Open sheet
      </button>
      <button type="button">Elsewhere</button>
      <Sheet
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        title="Rename"
        footer={<Button onClick={() => setOpen(false)}>Save</Button>}
        {...sheet}
      >
        <TextField label="Name" value={value} onChange={setValue} />
        <a href="#help">Help</a>
      </Sheet>
    </div>
  );
}

afterEach(() => __resetOverlaysForTests());

describe('Sheet', () => {
  it('moves focus inside when it opens and names itself', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('Name')).toHaveFocus();
    expect(isAnyOverlayOpen()).toBe(true);
  });

  it('keeps Tab inside, in both directions', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Close' });
    const name = screen.getByLabelText('Name');
    const save = screen.getByRole('button', { name: 'Save' });

    // forwards: field → link → Save → wraps to the first control
    await user.tab();
    expect(screen.getByRole('link', { name: 'Help' })).toHaveFocus();
    await user.tab();
    expect(save).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    // backwards from the first control wraps to the last
    await user.tab({ shift: true });
    expect(save).toHaveFocus();
    // focus never reached the page behind
    for (let index = 0; index < 8; index += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    expect(name).toBeInTheDocument();
  });

  it('pulls focus back if something moves it to the page behind', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
  });

  it('makes the page behind inert while open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const content = document.getElementById('app-content')!;
    expect(content.inert).toBeFalsy();
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    expect(content.inert).toBe(true);
    await user.keyboard('{Escape}');
    expect(content.inert).toBe(false);
  });

  it('closes on Escape and returns focus to what opened it', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open sheet' });
    await user.click(opener);
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(opener).toHaveFocus();
    expect(isAnyOverlayOpen()).toBe(false);
    // it plays its exit, taking no input meanwhile, and then leaves the document
    expect(document.querySelector('.ui-sheet-layer')).toHaveAttribute('data-state', 'closing');
    await waitFor(() => expect(document.querySelector('.ui-sheet-layer')).not.toBeInTheDocument());
  });

  it('closes on a backdrop tap and by its close control', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    await user.click(document.querySelector('.ui-sheet__scrim')!);
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('cannot be dismissed while something is in flight', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} sheet={{ dismissible: false }} />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    await user.keyboard('{Escape}');
    await user.click(document.querySelector('.ui-sheet__scrim')!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('adds no history entry', async () => {
    const user = userEvent.setup();
    const before = window.history.length;
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    await user.keyboard('{Escape}');
    expect(window.history.length).toBe(before);
  });

  it('lets only the topmost of two layers answer Escape, and returns focus layer by layer', async () => {
    const user = userEvent.setup();
    function Stacked() {
      const [sheet, setSheet] = useState(false);
      const [confirming, setConfirming] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setSheet(true)}>
            Open
          </button>
          <Sheet open={sheet} onClose={() => setSheet(false)} title="Project">
            <button type="button" onClick={() => setConfirming(true)}>
              Remove project
            </button>
          </Sheet>
          <ConfirmDialog open={confirming} title="Remove it?" confirmLabel="Remove" tone="danger" onCancel={() => setConfirming(false)} onConfirm={() => setConfirming(false)} />
        </>
      );
    }
    render(<Stacked />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Remove project' }));
    const alert = screen.getByRole('alertdialog', { name: 'Remove it?' });
    // a destructive question starts on the safe answer
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(alert).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove project' })).toHaveFocus();
    expect(isAnyOverlayOpen()).toBe(true);

    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
    expect(isAnyOverlayOpen()).toBe(false);
  });
});
