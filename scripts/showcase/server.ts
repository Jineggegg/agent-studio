/** Screenshot fixture only. Never imported by the product or included in its release. */
import { Readable } from 'node:stream';
import { loadConfig } from '../../apps/server/src/kernel/config.js';
import { createStudio } from '../../apps/server/src/kernel/studio.js';
import { modules } from '../../apps/server/src/modules/index.js';
import { createMailboxModule } from '../../apps/server/src/modules/mailbox/mailbox.module.js';
import type { MailTransport } from '../../apps/server/src/modules/mailbox/provider.js';
import {
  ScriptedAdapter,
  scriptedModule,
  type ScriptStep,
} from '../../apps/server/src/testing/scripted-adapter.js';

const planner = new ScriptedAdapter({ id: 'showcase-planner', displayName: 'Demo planner' });
const reviewer = new ScriptedAdapter({ id: 'showcase-reviewer', displayName: 'Demo reviewer' });
for (const adapter of [planner, reviewer]) {
  adapter.currentStatus = {
    installed: true,
    signedIn: true,
    account: 'Fictional showcase',
    version: 'scripted',
    problem: null,
  };
}

const work: readonly ScriptStep[] = [
  {
    tool: {
      id: 'brief',
      name: 'Read',
      kind: 'read',
      input: { file_path: 'README.md' },
      title: 'Read the Atlas project brief',
      output: 'Atlas is a fictional community reading app. Keep navigation clear on every screen.',
    },
  },
  {
    tool: {
      id: 'notes',
      name: 'memory_search',
      kind: 'search',
      input: { query: 'Atlas design' },
      title: 'Read shared project decisions',
      output: 'Use one clear primary action. Keep touch targets at least 44 pixels.',
    },
  },
  {
    text: '## A calmer reading space\n\nThe Atlas plan is ready. The same project can move from a desktop work session to a quick review on your phone.\n\n- **Discover** — find a reading list worth opening.\n- **Collect** — save useful ideas without losing your place.\n- **Continue** — pick up the conversation on another screen.\n\nThe design decisions are in shared memory. Hand this conversation to the reviewer when you are ready for a second perspective.',
  },
];
planner.otherwise((request) => {
  const text = request.prompt.text;
  if (text.includes('mobile handoff'))
    return [
      {
        text: '## Ready for review\n\nThe Atlas plan is in shared memory. Hand this conversation to the reviewer when you are ready.',
      },
    ];
  if (text.includes('Keep working'))
    return [
      {
        emit: {
          type: 'todos',
          items: [
            { text: 'Read the Atlas design brief', status: 'completed' },
            { text: 'Review the responsive navigation', status: 'in_progress' },
            { text: 'Write a short review summary', status: 'pending' },
          ],
        },
      },
      {
        text: 'Reviewing the navigation across desktop, tablet and phone. I will leave the findings with the project.',
      },
      { hang: true },
    ];
  if (text.includes('approval'))
    return [
      { text: 'The preview is ready for review. Please approve the next step before I continue.' },
      {
        permission: {
          toolName: 'Bash',
          kind: 'execute',
          title: 'Run the preview checks',
          input: { command: 'npm run check' },
          command: 'npm run check',
        },
      },
    ];
  if (text.includes('Compare the two'))
    return [
      {
        text: '## Review summary\n\nBoth perspectives agree on a simple navigation and large touch controls. Keep the desktop sidebar, use a compact tablet layout, and show one focused conversation on a phone.\n\nNext: test the primary actions with the keyboard and a screen reader.',
      },
    ];
  return work;
});
reviewer.otherwise((request) =>
  request.prompt.text.includes('Keep working')
    ? [
        {
          text: 'Checking keyboard focus, touch targets and readable contrast for the Atlas navigation.',
        },
        { hang: true },
      ]
    : [
        {
          text: '## A second perspective\n\nI have the project context and the earlier decisions. The layout is clear; these are the checks I would add before release:\n\n1. Keep the primary action visible on a narrow screen.\n2. Give every icon button a useful accessible name.\n3. Preserve keyboard focus when opening a panel.\n\nI have left this review in the conversation so the next agent can continue from it.',
        },
      ],
);

const messages = [
  {
    id: 'atlas-review',
    subject: 'Atlas — the next design review',
    from: 'design@example.invalid',
    preview: 'A short agenda for our next review.',
    text: 'Hi Alex,\n\nThe Atlas preview is ready for a design review.\n\nPlease check the reading-list navigation on phone and tablet, then leave your feedback in the project notes.\n\nAgenda\n• Review the main screen\n• Check keyboard and touch interaction\n• Agree on the next small improvement\n\nThanks,\nThe fictional Atlas team',
  },
  {
    id: 'atlas-notes',
    subject: 'Shared notes for the reading experience',
    from: 'research@example.invalid',
    preview: 'The research summary and open questions are ready.',
    text: 'The fictional research notes are ready for review.',
  },
  {
    id: 'atlas-copy',
    subject: 'A clearer welcome message',
    from: 'writing@example.invalid',
    preview: 'Three short alternatives for the welcome screen.',
    text: 'Here are three fictional alternatives to discuss.',
  },
];
const answer = (value: unknown) => ({
  status: 200,
  headers: {},
  body: Readable.from([JSON.stringify(value)]),
});
const transport: MailTransport = async (raw, options) => {
  const url = new URL(raw);
  // A closed fixture: unsupported requests fail. No DNS, OAuth refresh or sending is possible.
  if (url.origin !== 'https://gmail.googleapis.com' || (options?.method ?? 'GET') !== 'GET')
    throw new Error('Showcase transport refuses external actions');
  if (url.pathname.endsWith('/labels')) return answer({ labels: [{ id: 'INBOX', name: 'Inbox' }] });
  if (url.pathname.endsWith('/messages'))
    return answer({ messages: messages.map(({ id }) => ({ id })) });
  const message = messages.find(({ id }) => url.pathname.endsWith(`/messages/${id}`));
  if (!message) throw new Error('Unknown showcase mail request');
  return answer({
    id: message.id,
    snippet: message.preview,
    labelIds: ['INBOX', 'UNREAD'],
    internalDate: '1792746000000',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: message.subject },
        { name: 'From', value: message.from },
        { name: 'To', value: 'alex@example.invalid' },
      ],
      body: { data: Buffer.from(message.text).toString('base64url') },
    },
  });
};

const config = loadConfig(
  {},
  {
    env: 'test',
    host: '127.0.0.1',
    port: 0,
    dataDir: process.env.SHOWCASE_DATA!,
    workspaceRoots: [process.env.SHOWCASE_WORKSPACE!],
    webDir: process.env.SHOWCASE_WEB!,
    setupToken: process.env.SHOWCASE_SETUP!,
    sandbox: 'off',
    terminalEnabled: false,
    logLevel: 'silent',
  },
);
const studio = await createStudio(config, [
  ...modules.map((module) =>
    module.name === 'mailbox' ? createMailboxModule({ transport }) : module,
  ),
  scriptedModule(planner, reviewer),
]);
const address = await studio.start();
process.send?.({ url: address.url });
let closing = false;
const stop = () => {
  if (closing) return;
  closing = true;
  void studio.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('disconnect', stop);
