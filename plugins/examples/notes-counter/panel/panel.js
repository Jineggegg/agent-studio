/* global document */
// The panel of the example plugin.
//
// This page runs in a sandboxed frame: no cookies, no storage, no network.
// The one thing it can do is ask the Studio page around it to call a panel
// method of its own plugin — `studio.request(...)` below.
//
// "./@studio/panel.js" is provided by the Studio next to every panel page.
import { connectPanel } from './@studio/panel.js';

const element = (id) => document.getElementById(id);

function render(summary) {
  element('greeting').textContent = summary.greeting;
  element('total').textContent = String(summary.total);
  element('total-label').textContent = summary.total === 1 ? 'note' : 'notes';
  const list = element('notes');
  list.replaceChildren(
    ...summary.latest.map((note) => {
      const item = document.createElement('li');
      // textContent, never innerHTML: a note is text someone typed.
      item.textContent = `#${note.number} ${note.text}`;
      return item;
    }),
  );
}

async function main() {
  const studio = await connectPanel();
  const applyContext = (context) => {
    document.documentElement.dataset.theme = context.theme;
    document.documentElement.lang = context.locale;
  };
  applyContext(studio.context);
  studio.onContextChange(applyContext);

  const refresh = async () => render(await studio.request('summary'));
  await refresh();
  studio.resize();

  element('add').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = element('text');
    const status = element('status');
    try {
      await studio.request('add', { text: input.value });
      input.value = '';
      status.textContent = '';
      await refresh();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'That did not work.';
    }
  });
}

main().catch((error) => {
  element('status').textContent = error instanceof Error ? error.message : 'The panel could not start.';
});
