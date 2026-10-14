import type { TerminalCapability } from '@agent-studio/protocol';
import { refreshInspectorPanels } from '@/features/workbench/inspector/registry';
import { terminalApi } from './api';

/**
 * Whether this server lets the owner run commands in a terminal at all. The
 * conversation asks before it draws "Run" on a shell block: a server with the
 * terminal switched off (or unable to start one) gets no such button, rather
 * than one that leads to a panel saying no. Asked once, when first needed;
 * until the answer is in, nothing is offered — a control that appears a
 * moment late is better than one that leads nowhere. The terminal panel
 * passes on every newer answer it reads.
 */
let usable: boolean | null = null;
let asking = false;
const RETRY_AFTER_MS = 60_000;

function settle(next: boolean | null): void {
  const changed = next !== usable;
  usable = next;
  if (changed) refreshInspectorPanels();
}

export function terminalUsable(): boolean {
  if (usable === null && !asking) {
    asking = true;
    terminalApi.capability().then(
      (capability) => {
        asking = false;
        settle(capability.available);
      },
      () => {
        // Not known (offline, refused): nothing is offered now, and the question is asked again a little later.
        asking = false;
        settle(false);
        window.setTimeout(() => {
          if (usable === false) usable = null;
        }, RETRY_AFTER_MS);
      },
    );
  }
  return usable === true;
}

/** A fresher answer, read by the terminal panel. */
export function noteTerminalCapability(capability: TerminalCapability): void {
  settle(capability.available);
}
