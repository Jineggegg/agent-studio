import { fireEvent, render, screen } from '@testing-library/react';
import { SquareTerminal } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetDeviceMemoryForTests } from '../device';
import { type InspectorContext, __resetInspectorForTests, registerInspectorPanel, useInspectorState } from '../inspector/registry';
import { InspectorScope } from '../inspector/scope';
import { Prose } from './Prose';

vi.mock('../api', () => ({ workbenchApi: {}, SEND_TIMEOUT_MS: 20_000 }));

const owner: InspectorContext = { project: { id: 'p' } as never, sessionId: null, role: 'owner' };
const member: InspectorContext = { ...owner, role: 'member' };
const ANSWER = ['Run this:', '', '```bash', 'echo hi', '```', '', 'and this is not a command:', '', '```ts', 'const x = 1;', '```', '', 'Use `git status` inline.'].join('\n');

function Pending() {
  const { pending, open, panel } = useInspectorState();
  return <output>{pending ? `${open ? 'open' : 'closed'}:${panel}:${JSON.stringify(pending.request)}` : 'nothing'}</output>;
}

/** The terminal as the real feature registers it: only the owner has one to type into. */
const registerTerminal = () =>
  registerInspectorPanel({ id: 'terminal', title: 'workbench.inspector.sample', icon: SquareTerminal, load: async () => ({ default: () => null }), handles: (context) => (context.role === 'owner' ? ['run-command'] : []) });

afterEach(() => {
  __resetInspectorForTests();
  __resetDeviceMemoryForTests();
});

describe('"Run" on a shell block in what an agent wrote', () => {
  it('is offered on the shell block only, and hands the command to the terminal panel', () => {
    registerTerminal();
    render(
      <InspectorScope value={owner}>
        <Prose>{ANSWER}</Prose>
        <Pending />
      </InspectorScope>,
    );
    const buttons = screen.getAllByRole('button', { name: 'Run in the terminal' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(screen.getByRole('status')).toHaveTextContent('open:terminal:{"type":"run-command","text":"echo hi"}');
    // The button says the command was handed over; tapping again hands it over again.
    expect(buttons[0]).toHaveTextContent('Typed');
  });

  it('is not drawn at all when no panel can take the command', () => {
    render(
      <InspectorScope value={owner}>
        <Prose>{ANSWER}</Prose>
      </InspectorScope>,
    );
    expect(screen.queryByRole('button', { name: 'Run in the terminal' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Copy code' })).toHaveLength(2);
  });

  it('is not drawn for someone who has no terminal', () => {
    registerTerminal();
    render(
      <InspectorScope value={member}>
        <Prose>{ANSWER}</Prose>
      </InspectorScope>,
    );
    expect(screen.queryByRole('button', { name: 'Run in the terminal' })).toBeNull();
  });

  it('asks which line when a block holds several commands', () => {
    registerTerminal();
    render(
      <InspectorScope value={owner}>
        <Prose>{'```sh\nnpm install\nnpm test\n```'}</Prose>
        <Pending />
      </InspectorScope>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run in the terminal' }));
    expect(screen.getByRole('status')).toHaveTextContent('nothing');
    fireEvent.click(screen.getByRole('menuitem', { name: 'npm test' }));
    expect(screen.getByRole('status')).toHaveTextContent('{"type":"run-command","text":"npm test"}');
  });
});
