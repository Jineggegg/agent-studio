# Cloud Harness desktop

An optional Electron client for an existing Cloud Harness server. It does not
bundle a server, private control plane, updater, notification badge, or trading
integration. The web app remains independently usable.

From the repository root, install dependencies using the normal lockfile flow.
This repository disables npm lifecycle scripts. Download the Electron runtime
explicitly with `npm run desktop:prepare`, then launch `npm run desktop`. Choose
a server at first launch, or set `CLOUD_HARNESS_URL=https://your-server.example`.
Only HTTPS URLs are accepted remotely; plain HTTP is accepted for `localhost`,
`127.0.0.1` and `[::1]`. The app remembers the URL without credentials. Sign in
using the server's normal account flow. A server must already be running.

`npm run desktop:package` builds for the current platform with electron-builder
and never publishes. Cross-platform packaging requires the relevant build tools;
macOS signing and Windows signing require the operator's own certificates. No
certificates or distribution accounts are supplied. Unpackaged and unsigned
builds can show OS warnings. Output is `desktop-dist/`.

The renderer is sandboxed, isolated from Node, and cannot invoke arbitrary IPC.
Navigation stays on the selected origin. Popups and embedded webviews are denied;
external HTTPS navigation asks before opening the system browser. Certificate
errors are refused. Authentication flows requiring cross-origin popups must be
completed in the browser instead. The shell never disables certificate checks.

Notifications are off initially. Enable them from the native Cloud Harness menu;
consent is scoped to the current server and is reset when changing servers or
restarting the app. Web notification permission requests cannot grant consent.
The optional narrow `cloudHarnessDesktop.notify(title, body)` bridge accepts
bounded plain text only and is rate limited. The app never sets taskbar badges.
Microphone access asks separately, allows audio only, and can be revoked from
the menu. Screen capture, camera and unrelated permissions are refused.

Connection setup is bilingual (English / 简体中文); the connected web app follows
its normal language and accessibility settings. Native menu labels are bilingual.

Run policy tests with `build-queue node --test desktop/policy.test.mjs`. Smoke test packaged builds on each target OS before
releasing: login, reconnect, dictation permission denial, off-origin navigation,
notification denial/consent, download save dialog, and keyboard focus.
