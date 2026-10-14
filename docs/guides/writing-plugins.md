# Writing plugins

A plugin adds things to the Studio that are not part of its code: tools an
agent can call, small panels in the interface, reactions to events, tiles that
open another site. This guide is the reference for writing one, and an honest
account of how far a plugin is — and is not — kept from the rest of the
machine.

The example in [`plugins/examples/notes-counter`](../../plugins/examples/notes-counter)
is small enough to read in a few minutes and is walked through at the end.

## The model in one page

- **A plugin is a folder with a `plugin.json`.** Nothing else is required.
- **Installing never runs anything.** The Studio copies the folder (or one
  revision of a Git repository), checks it, and stores it. No install scripts,
  no build step, no package manager, no Git hooks. **`npm install` is never run
  for a plugin: a plugin ships everything it needs**, as plain files. The one
  thing it does not ship is the SDK, which the Studio provides.
- **A plugin starts disabled.** The owner sees what it asks for, grants all or
  some of it, and approves exactly the files that are installed (by their
  content hash). If the files change afterwards — through an update or
  otherwise — the plugin is disabled until it is approved again.
- **Server-side code runs in its own process**, started when first needed and
  stopped when idle. It has no network, sees no file but its own, and gets a
  scrubbed environment. All it can do beyond computing is ask the Studio,
  through a short list of capabilities that are checked against the granted
  permissions on every call.
- **A panel is a web page in a sandboxed frame** without an origin: no cookies,
  no storage, no network. Its only channel is a message to the page around it,
  which relays a call to the plugin's own server code as the signed-in user.

## Folder layout

```
my-plugin/
  plugin.json          the manifest
  server/index.js      server code (optional) — an ES module
  panel/index.html     a panel page (optional) and what it loads
  panel/panel.js
  panel/panel.css
```

A plugin may contain ordinary files and folders only: **symbolic links are
refused**, as are devices, sockets and pipes. At most 2000 files and 20 MiB.
A `.git` folder at the top is ignored — it is neither copied nor part of the
content hash.

## `plugin.json`

Every key is checked; **an unknown key is an error**, not something that is
ignored. The schema is `pluginManifestSchema` in
[`packages/protocol/src/plugins.ts`](../../packages/protocol/src/plugins.ts).

```json
{
  "manifestVersion": 1,
  "id": "notes-counter",
  "name": "Notes counter",
  "version": "1.0.0",
  "description": "Keeps short notes and counts them.",
  "author": "You",
  "license": "MIT",
  "homepage": "https://example.com/notes-counter",
  "minStudioVersion": "2.0.0",
  "server": { "entry": "server/index.js" },
  "permissions": ["notifications", "network:api.example.com"],
  "contributes": {
    "tools": [
      {
        "name": "count_notes",
        "description": "Says how many notes have been saved.",
        "effect": "read",
        "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
      }
    ],
    "panels": [
      { "id": "notes", "title": "Notes", "icon": "notebook", "entry": "panel/index.html", "slots": ["home-tile", "project-tab"] }
    ],
    "hooks": ["run.finished"],
    "linkTiles": [{ "id": "docs", "title": "Docs", "icon": "book", "url": "https://docs.example.com/" }]
  }
}
```

| Key | Required | Meaning |
|---|---|---|
| `manifestVersion` | yes | Always `1`. |
| `id` | yes | A slug (`notes-counter`) or reverse-DNS name (`com.example.notes`): lowercase letters and digits in groups joined by single `.` or `-`, 2–48 characters. `install`, `contributions`, `sources`, `panel` and `isolation` are reserved. Two ids that differ only in `.` versus `-` cannot both be installed. |
| `name` | yes | Shown to people, and to the model in front of each tool description. Up to 60 characters. |
| `version` | yes | `1.2.3`, optionally with `-pre` or `+build`. |
| `description`, `author`, `license` | no | Plain text; `license` is an SPDX identifier. |
| `homepage` | no | An `https://` address. |
| `minStudioVersion` | no | Installing on an older Studio is refused. |
| `server.entry` | no | A `.js` or `.mjs` file inside the plugin: the server code. Needed for tools, hooks and permissions. |
| `permissions` | no | What the plugin asks for. See below. |
| `contributes.tools` | no | Up to 32. `name`: lowercase letters, digits, `_`. `effect`: `read` or `write`. `inputSchema`: see below. |
| `contributes.panels` | no | Up to 8. `entry` is an `.html` file; `slots` says where it may appear: `home-tile`, `project-tab`, `settings-page`. `icon` is the **name** of one of the Studio's own icons — a plugin never supplies an image for the Studio's page. |
| `contributes.hooks` | no | Events the plugin wants to hear of. See below. |
| `contributes.linkTiles` | no | Up to 16 home tiles that open an `https://` address in a new tab. |

Paths are relative, use forward slashes, and no segment may start with a dot —
so no `..`, no absolute paths, no hidden files.

### Tool input schemas

`inputSchema` is a deliberately small subset of JSON Schema: `type` (`object`,
`string`, `number`, `integer`, `boolean`, `array`), `description`,
`properties`, `required`, `additionalProperties`, `items`, `enum` (strings),
`minLength` / `maxLength`, `minimum` / `maximum`, `minItems` / `maxItems`. The
top level is an object; at most six levels and 200 nodes. There is no `$ref`,
no combinator, and **no `pattern`** — a regular expression supplied by a plugin
would run inside the server. Input that does not fit the schema never reaches
the plugin; an object refuses properties it does not describe unless it says
`"additionalProperties": true`.

A tool is offered to agents as `plugin_<id>_<tool>` (dots and hyphens of the id
become underscores; 63 characters at most), with the description
`[Plugin: <name>] <description>`.

## Permissions

A plugin that requests nothing can compute, keep its own storage, and write to
its log. Everything else is asked for in the manifest and granted — all of it
or any part — by the owner.

| Permission | What it really grants |
|---|---|
| `notifications` | Creating a notification **for the user a call is acting for**. Not for anyone else, and not from a hook (a hook acts for nobody). At most 10 a minute. |
| `projects:read` | Listing the projects **that user can see** and reading files in them, up to 512 KiB per read. A tool call sees only the project of the run that called it; a panel opened as a project tab only that project; a home tile or settings page every project of the user. Files that usually hold credentials (`.env*`, `*.pem`, `*.key`, `.npmrc`, `.git/`, `.ssh/`, `id_rsa`, …) are withheld — a courtesy, not a guarantee that no secret sits in another file. Together with any network permission this lets a plugin send project files elsewhere; grant the pair with that in mind. |
| `network:<host>` | https requests to **exactly that host name**, default port, made by the Studio on the plugin's behalf (`host.http.fetch`). The plugin never holds a socket. The name must resolve to a public address — checked at connection time, so a name that later points inward is refused too — redirects are returned rather than followed, only a short list of request headers may be set, and the response is capped at 512 KiB. IP addresses, `localhost`, wildcards and ports cannot be granted. |
| `network` | **Unrestricted network access for the plugin's process**: any address the server machine can reach, including services on the machine itself and on the local network. Meant for the owner's own private tools. It does not widen `host.http.fetch`. |

There is no permission for the Studio's database, its key file, other plugins'
data, the user's credentials, stored provider keys, sessions, or shared memory:
none of them is reachable at all. **`memory.search` is out of scope for now**;
a plugin cannot read or write shared memory.

### Tool effects

A tool declared `read` is not subject to the run's permission mode, so the
declaration cannot simply be believed. The Studio honours it only where it can
stand behind it:

- During a `read` tool call, `storage.set`, `storage.delete`, `http.fetch` and
  `notify` are refused (`read_only_call`).
- A plugin that has been granted **any** `network…` permission or
  `notifications` has **all** its tools registered as `write`, whatever it
  declares — because a process could remember a tool's input and send it out
  later, in another call.
- On a machine where plugin processes are not kept off the network (see
  below), every plugin tool is `write`.

The owner's plugin list shows both the declared and the effective effect.

## How plugin code is isolated

### The process

One process per enabled plugin with server code, started on the first call and
stopped after ten idle minutes. It is given:

- **A scrubbed environment**: `PATH=/usr/bin:/bin`, `HOME` and `TMPDIR` set to
  its data folder, `LANG`, `NO_COLOR`, and `TZ` if the server has one. Nothing
  named `AGENT_STUDIO_*`, no API key, no proxy setting, and none of the
  variables an operator passes through to agents.
- **Two folders**: its own code (`<data>/plugins/<id>`, read-only) and its own
  data folder (`<data>/plugin-data/<id>`, the only place it can write, 256 MiB).
- **No authority of its own.** Every request to the Studio has to name a call
  that is still in progress. When a handler has returned, its `host` stops
  working; a plugin cannot act in the background, and cannot act for a user who
  is not calling it at that moment.

How well the process is held to that depends on the machine, and the plugin
list says which of three levels is in force.

**`sandboxed` — bubblewrap available (Linux).** The process starts in an empty
file system that contains the system's program folders, the Node binary, the
plugin's code and the SDK (all read-only), and its data folder. There is no
home directory, no `/etc`, no `/run` (so no local service sockets), no `/tmp`;
the root and `/dev` are read-only. It has its own network namespace with no
interface but an isolated loopback (unless `network` was granted), and its own
process namespace, so it cannot see or signal anything else. Inside that, Node's
permission model is switched on as a second layer: file access outside the two
folders, child processes, worker threads, native add-ons and WASI are refused
by the runtime itself.

**`restricted` — no bubblewrap, Node's permission model only.** The runtime
still refuses files outside the two folders, child processes, workers and
add-ons. **But:** on the Node versions the Studio supports (22 and 24) the
permission model does not cover the network, so the process *can* open
connections — including to services on the same machine and to local sockets
such as D-Bus — and it can signal other processes of the server's account.
Node's documentation is explicit that the permission model is a seat belt for
well-meaning code and not a boundary against code written to break out. In
this mode, treat a plugin as you would any program you run under your own
account. No plugin tool is considered `read` here.

**`none` — neither.** Plugins with server code cannot be enabled. An operator
who accepts that such a plugin can do anything the server can may set
`AGENT_STUDIO_PLUGINS_UNSANDBOXED=on`; the plugin list then says so.

A plugin is never run with less isolation than it was approved under: if a
machine loses bubblewrap, plugins approved as `sandboxed` are blocked until the
owner approves them again at the lower level.

### Limits on a process

| Limit | Default | What happens beyond it |
|---|---|---|
| Start-up handshake | 10 s | The process is ended. |
| A tool call / panel call / hook | 30 s / 15 s / 10 s | The call fails and **the process is ended** — nothing else can interrupt running JavaScript. It starts again on the next call. |
| One message, either way | 1 MiB | A larger message from the plugin ends the process. |
| Unread input | 4 MiB | A plugin that stops reading is ended. |
| Messages from the plugin | 500 a second | Flooding ends the process. |
| Lines that are not protocol messages | 20 | Then the process is ended. |
| JavaScript heap | 128 MiB (`--max-old-space-size`) | Node aborts. |
| Memory of the whole process group | 512 MiB | Ended (Linux only; measured every 5 s). |
| Processor while nobody is calling | half a core for about 10 s | Ended (Linux only). |
| Data folder | 256 MiB | Ended (measured every 30 s). |
| Log | the last 16 KiB | Older lines are dropped. Secrets are redacted when shown. |
| Failures | 5 within 10 minutes | The plugin is **disabled**, with the reason shown. Before that, each failure doubles the wait before the next start (1 s … 60 s). |
| Storage | 2000 keys, 64 KiB a value, 4 MiB in all | The call is refused. |
| Calls in progress per plugin | 16 | Further calls are refused as busy. |

### The panel

A panel's files are served from an address that contains a *grant*: a random
value minted when a signed-in user opens the panel, bound to that plugin,
panel, user, session and (for a project tab) project, valid for an hour, and
ended by sign-out, by disabling the plugin, or by losing access to the project.
A grant opens the panel's static files — only files in the folder of the
panel's page, only these types: `.html .js .mjs .css .json .txt .svg .png .jpg
.jpeg .gif .webp .ico .woff2`. It is not enough to *call* anything: that also
takes the user's session.

The web client embeds the page in
`<iframe sandbox="allow-scripts allow-forms">`, and every file is served with

```
Content-Security-Policy: sandbox allow-scripts allow-forms; default-src 'none';
  script-src <grant address>/; style-src <grant address>/; img-src <grant address>/ data:;
  font-src <grant address>/; connect-src 'none'; form-action 'none'; base-uri 'none';
  frame-ancestors 'self'; webrtc 'block'
X-Content-Type-Options: nosniff
Cross-Origin-Resource-Policy: cross-origin
X-Frame-Options: SAMEORIGIN
Access-Control-Allow-Origin: *
Cache-Control: no-store
Referrer-Policy: no-referrer
```

so the page has an opaque origin whether or not the frame's own attribute is
right, and even when opened in a tab by itself. In practice, for a panel author:

- **No inline scripts or styles, no `eval`.** Put code in `.js` files and
  styles in `.css` files next to the page. Setting `element.style.…` from
  script works.
- **No network at all**: no `fetch`, XHR, WebSocket, EventSource or beacon, no
  images, fonts or scripts from anywhere but the panel's own folder (and
  `data:` images), no form posts.
- **No cookies, `localStorage`, IndexedDB or service workers.** Keep state in
  your plugin's storage, through a panel method.
- **No pop-ups, no navigating the Studio**, no access to the page around it.

What a browser does not let any policy close — a DNS prefetch hint, for one —
is not closed here either. A panel only ever knows what its own server code
tells it and the context below, so there is little for it to leak.

## The SDK

```js
import { definePlugin, HostError } from '@agent-studio/plugin-sdk';
```

A plugin needs no `node_modules` for this. Node looks for packages in the
folders above the importing file; plugins live in `<data>/plugins/<id>/`, and
the Studio keeps a copy of the SDK in `<data>/plugins/node_modules/`, handed to
every plugin process read-only. The same folder holds a `package.json` that
says `"type": "module"`, so a plugin without one of its own has its `.js`
files treated as ES modules. For types while writing a plugin in an editor,
add `@agent-studio/plugin-sdk` as a development dependency; nothing of it
needs to be shipped.

```js
definePlugin({
  tools: {          // one function per tool in the manifest
    async my_tool(input, context) { return 'text for the agent'; },   // or { text, isError: true }
  },
  panelMethods: {   // what the plugin's panels may call
    async summary(params, context) { return { any: 'JSON' }; },
  },
  hooks: {          // one function per hook in the manifest
    async 'run.finished'(payload, context) {},
  },
  onStart(context) {},   // once, after the process has started
  onStop(context) {},    // when the Studio stops the plugin politely; keep it short
});
```

Call `definePlugin` once, at the top level of the server entry. After that,
**standard output belongs to the protocol**: the SDK points `console.*` at
standard error, which the Studio keeps as the plugin's log. Do not write to
`process.stdout` yourself.

Every handler receives a `context`:

| Field | |
|---|---|
| `host` | The capability client for this call. See below. |
| `plugin` | `{ id, version, studioVersion, permissions }` — the permissions actually granted. |
| `user` | `{ id, displayName }` for tools and panel methods; `null` for hooks, `onStart` and `onStop`. Never a credential. |
| `projectId` | The run's project (tools), the project of a project tab (panels), or `null`. |
| `run` | Tools only: `{ runId, sessionId, agentId }`. |
| `panel`, `method` | Panel methods only: `{ panelId, slot }` and the method's name. |
| `event` | Hooks only. |

`context.host`:

| Call | Needs | Notes |
|---|---|---|
| `host.log(message, level?)` | — | Adds a line to the plugin's log. Never fails. |
| `host.storage.get(key)` | — | The value, or `undefined`. The space is the plugin's own; no other plugin can see it. It is shared by all users of the plugin. |
| `host.storage.set(key, value)` | not in a `read` tool | Any JSON value. |
| `host.storage.delete(key)` | not in a `read` tool | Resolves to whether there was something to delete. |
| `host.storage.list({ prefix?, limit? })` | — | Keys, in order. |
| `host.notify({ title, body? })` | `notifications`, a user | |
| `host.http.fetch(url, { method?, headers?, body?, responseType? })` | `network:<host>` | Methods: `GET HEAD POST PUT PATCH DELETE`. Headers you may set: `accept`, `accept-language`, `authorization`, `content-type`, `if-match`, `if-none-match`, `if-modified-since`, `x-api-key`, `x-request-id`. Resolves to `{ status, headers, body, encoding }`; `responseType: 'base64'` for binary. A 3xx is returned as it is. |
| `host.projects.list()` | `projects:read`, a user | `[{ id, name, access }]`. |
| `host.files.read(projectId, path, { maxBytes? })` | `projects:read`, a user | `{ path, size, truncated, encoding, content }`; text as UTF-8, anything else as base64. |

A refusal rejects with a `HostError` whose `code` is stable:
`permission_denied`, `no_user`, `read_only_call`, `invalid_scope` (the call the
request belonged to is over), `invalid_params`, `too_large`, `quota_exceeded`,
`rate_limited`, `not_found`, `project_not_found`, `path_outside_root`,
`path_not_allowed`, `address_not_allowed`, `header_not_allowed`,
`port_not_allowed`, `insecure_url`, `network_error`.

An error thrown by a panel method reaches the panel with its `message` and, if
it has a string `code`, that code. An error thrown by a tool is shown to the
agent as the tool's failure.

A plugin does not have to use the SDK. The protocol underneath is JSON-RPC 2.0,
one message per line, over the process's standard input and output: the Studio
sends `initialize`, `tool.call`, `panel.request`, `hook.event` and `shutdown`,
each with a `scope`; the plugin may send `host.*` requests that carry the
`scope` of the call they are made in. Speaking it by hand gives a plugin
nothing the SDK does not — the hostile test plugin in
`apps/server/test/integration/plugins-fixtures/hostile` does exactly that.

## Hooks

Payloads carry identifiers only: never a name, a path, message text or
anything about a person. A hook runs for no user, so `notify`,
`projects.list` and `files.read` are refused in it whatever was granted; it
can use storage, the log and `http.fetch`.

| Event | Payload | Delivered |
|---|---|---|
| `project.created` | `{ projectId }` | today |
| `project.deleted` | `{ projectId }` | today |
| `run.started` | `{ runId, sessionId, projectId, agentId }` | once the agent runtime announces runs on users' topics, as the protocol defines |
| `run.finished` | `{ runId, sessionId, projectId, agentId, status }` | likewise |

Each plugin receives its events one at a time, in order. At most 100 wait for
one plugin; further events are dropped, with a line in the log. An event starts
the plugin's process if it is not running.

## Panels

```html
<!-- panel/index.html -->
<link rel="stylesheet" href="./panel.css" />
<script type="module" src="./panel.js"></script>
```

```js
// panel/panel.js
import { connectPanel } from './@studio/panel.js';

const studio = await connectPanel();
studio.context;                       // { pluginId, panelId, slot, theme, locale, project, user: { displayName } }
studio.onContextChange((context) => {});
const data = await studio.request('summary', { page: 1 });   // calls panelMethods.summary
studio.resize();                      // keep the frame as tall as the content
```

`./@studio/panel.js` is served by the Studio next to every panel's page. It is
the same single file as `@agent-studio/plugin-sdk/panel`; a plugin may ship its
own copy instead. `request` rejects with a `PanelError` (`code`, `message`):
codes from your own panel method, or `timeout`, `too_large` (256 KiB each way),
`too_many_requests` (32 in flight), `panel_expired`, `plugin_timeout`,
`plugin_unavailable`.

A `settings-page` panel can be opened by the owner only.

### The message protocol

For whoever implements the other side — the full specification, with schemas,
is the comment and the `panelToHostMessageSchema` / `hostToPanelMessageSchema`
pair in `packages/protocol/src/plugins.ts`. In short, every message is
`{ channel: 'agent-studio-panel', v: 1, type, … }`:

- Panel → page: `ready`; `request` with `id`, `method`, `params`; `resize` with `height`.
- Page → panel: `init` and `context` with `context`; `response` with `id`, `ok`, and `result` or `error: { code, message }`.

The panel posts to `location.origin` and accepts only messages whose source is
`window.parent` and whose origin is `location.origin`. The page posts with the
target `'*'` (an opaque origin cannot be named) and accepts only messages whose
source is the frame's window and whose origin is `'null'`.

## Installing, updating, removing

Only the owner manages plugins, from a browser, and installing, approving,
updating and removing each need a sign-in that is a few minutes old. An API
token cannot do any of it. Every one of these actions is written to the audit
log, with the content hash and — for a Git source — the commit.

- **From a folder.** An operator sets `AGENT_STUDIO_PLUGIN_SOURCE_DIR` to a
  folder of plugins; the owner installs one of its sub-folders by name.
- **From Git.** A public `https://host/path` address, optionally a branch or
  tag. No other scheme, no credentials, no query string. The host must resolve
  to a public address, and Git is made to connect to the address that was
  checked. The clone is shallow, without submodules, hooks, credential
  prompts or the machine's own Git configuration, has a time limit, and runs
  sandboxed where bubblewrap is available. A symbolic link in the repository
  arrives as a text file.
- **Update** fetches the plugin again from where it came. When nothing changed
  upstream, nothing happens. New files are installed but disabled until the
  owner approves them — asking for the update is not reviewing the code it
  brings — and the plugin list says what changed: new permissions, different
  contributions (tools and their descriptions, panels, hooks, link tiles), or
  only the content.
- **Uninstall** removes the code and, if asked, the plugin's data. Data that is
  kept will be seen by a later plugin with the same id; the plugin list marks
  such a plugin.

## Walkthrough: `notes-counter`

**`plugin.json`** asks for no permission. It declares two tools, a panel that
may be a home tile or a project tab, and the `run.finished` hook. Because it
can reach nothing outside, its `count_notes` tool is really registered as
`read`.

**`server/index.js`** is the whole server side:

- `load` and `save` keep the notes in the plugin's storage under two keys.
- `count_notes` (`read`) reads them and returns text for the agent. Had it
  called `host.storage.set`, the Studio would have refused.
- `add_note` (`write`) saves a note signed with `user.displayName` — the user
  of the run that called the tool. Each call first passes the run's permission
  mode, like any tool that changes something.
- `panelMethods.summary` and `panelMethods.add` are what the panel calls;
  `user` there is whoever is looking at the panel.
- The `run.finished` hook counts finished runs. It has no user and gets only
  ids.

**`panel/`** is three files. `index.html` links `panel.css` and loads
`panel.js` as a module — nothing inline. `panel.js` connects, applies the
theme, asks `summary`, renders with `textContent` (never `innerHTML`: a note is
text someone typed), and on submit calls `add`. A thrown `empty_note` error
from the server code arrives as a `PanelError` and is shown.

To try it: point `AGENT_STUDIO_PLUGIN_SOURCE_DIR` at `plugins/examples`,
install "notes-counter" from the plugins screen, review and enable it.
