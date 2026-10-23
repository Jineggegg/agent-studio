/** Screenshot fixture only. Never imported by the product or included in its release. */
import { Readable } from 'node:stream';
import type { AgentCapabilities } from '../../apps/server/src/modules/agents/adapter.js';
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
import { content, files } from './content.mjs';

const t = content(process.env.SHOWCASE_LANG === 'zh-CN' ? 'zh-CN' : 'en');

/**
 * Scripted stand-ins that look like the two coding agents in the picker. Every
 * reply below is written out in this file: no CLI, model or provider runs.
 */
class DemoAgent extends ScriptedAdapter {
  readonly #models: AgentCapabilities['models'];
  constructor(id: string, displayName: string, models: AgentCapabilities['models']) {
    super({ id, displayName });
    this.#models = models;
    this.currentStatus = {
      installed: true,
      signedIn: true,
      account: t.demoAccount,
      version: 'demo',
      problem: null,
    };
  }
  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), models: this.#models, defaultModel: this.#models[0]!.id };
  }
}

const claude = new DemoAgent('claude-code', 'Claude Code', [
  {
    id: 'sonnet',
    label: 'Sonnet',
    recommended: true,
    contextWindow: 200_000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  { id: 'opus', label: 'Opus', contextWindow: 200_000, efforts: ['low', 'medium', 'high'] },
]);
const codex = new DemoAgent('codex', 'Codex', [
  {
    id: 'default',
    label: t.defaultModel,
    recommended: true,
    contextWindow: 200_000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
]);

const fixPatch = `--- a/src/cart/total.ts
+++ b/src/cart/total.ts
@@ -5,6 +5,8 @@ export interface CartLine {

 export function cartTotal(lines: CartLine[], discount = 0): number {
-  const subtotal = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
-  return Number((subtotal * (1 - discount)).toFixed(2));
+  // Work in whole pence: adding decimals drifts (0.1 + 0.2 !== 0.3).
+  const pence = lines.reduce((sum, line) => sum + Math.round(line.price * 100) * line.quantity, 0);
+  return Math.round(pence * (1 - discount)) / 100;
 }
`;

const refundPatch = `--- a/src/refunds/total.ts
+++ b/src/refunds/total.ts
@@ -3,4 +3,5 @@
 export function refundTotal(items: RefundItem[]): number {
-  const sum = items.reduce((total, item) => total + item.amount, 0);
-  return Number(sum.toFixed(2));
+  // Same rule as the cart: whole pence, rounded once.
+  const pence = items.reduce((total, item) => total + Math.round(item.amount * 100), 0);
+  return pence / 100;
 }
`;

const fix: readonly ScriptStep[] = [
  {
    tool: {
      id: 'read-total',
      name: 'Read',
      kind: 'read',
      input: { file_path: 'src/cart/total.ts' },
      output: files['src/cart/total.ts'],
    },
  },
  {
    tool: {
      id: 'search-rounding',
      name: 'Grep',
      kind: 'search',
      input: { pattern: 'toFixed', path: 'src' },
      output: 'src/cart/total.ts:8\nsrc/refunds/total.ts:5',
    },
  },
  {
    tool: {
      id: 'edit-total',
      name: 'Edit',
      kind: 'edit',
      input: { file_path: 'src/cart/total.ts' },
      diffs: [{ path: 'src/cart/total.ts', added: 3, removed: 2, patch: fixPatch }],
    },
  },
  {
    tool: {
      id: 'run-tests',
      name: 'Bash',
      kind: 'execute',
      input: { command: 'npm test', description: t.runTests },
      output:
        ' ✓ src/cart/total.test.ts (8 tests)\n ✓ src/checkout/flow.test.ts (10 tests)\n\n Test Files  2 passed (2)\n      Tests  18 passed (18)',
    },
  },
  { text: t.fixAnswer },
];

claude.otherwise((request) => {
  const text = request.prompt.text;
  if (text.includes(t.prompts.refund))
    return [
      { text: t.refundIntro },
      {
        permission: {
          toolName: 'Edit',
          kind: 'edit',
          title: t.refundTitle,
          input: { file_path: 'src/refunds/total.ts' },
          paths: ['src/refunds/total.ts'],
          diff: refundPatch,
        },
      },
      { text: t.refundDone },
    ];
  if (text.includes(t.prompts.upgrade))
    return [
      {
        emit: {
          type: 'todos',
          items: t.upgradeTodos.map((item, index) => ({
            text: item,
            status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending',
          })),
        },
      },
      { text: t.upgradeProgress },
      { hang: true },
    ];
  if (text.includes(t.prompts.review)) return [{ text: t.reviewClaude }];
  return fix;
});
codex.otherwise((request) => {
  const text = request.prompt.text;
  if (text.includes(t.prompts.notes)) return [{ text: t.notesProgress }, { hang: true }];
  if (text.includes(t.prompts.review)) return [{ text: t.reviewCodex }];
  return [{ text: t.reviewCodex }];
});

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
    return answer({ messages: t.mail.map(({ id }) => ({ id })) });
  const message = t.mail.find(({ id }) => url.pathname.endsWith(`/messages/${id}`));
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
  // The scripted stand-ins take the place of the real Claude Code and Codex adapters.
  ...modules
    .filter((module) => module.name !== 'claude-code' && module.name !== 'codex')
    .map((module) => (module.name === 'mailbox' ? createMailboxModule({ transport }) : module)),
  scriptedModule(claude, codex),
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
