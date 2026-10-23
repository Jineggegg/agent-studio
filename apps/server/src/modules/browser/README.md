# Optional isolated agent browser

Disabled by default. A deployer may set `CLOUD_HARNESS_CHROMIUM` to the canonical
absolute Chromium executable under `/usr` or `/opt/cloud-harness-chromium` and
enable the existing Linux bubblewrap sandbox. The `/opt` installation directory
must contain only the public Chromium distribution, never credentials or user
files. There is no fallback to an unsandboxed process, ordinary personal browser,
or a remotely supplied debugging address. No new runtime dependency is required.

The browser talks CDP through inherited fd 3/4, with no debugging TCP listener.
Its filesystem starts from an empty root; only system program/library paths,
the explicit Chromium distribution, and a fresh temporary profile are exposed.
The browser gets a separate network namespace (`network: false`), no host network,
no host sockets and no home/project mounts. Chromium's own sandbox stays enabled.
If the executable cannot run under those boundaries, the request fails closed.

Every document and subresource request on resumed page/frame targets is paused
with CDP Fetch. The host validates HTTPS destinations and uses the kernel's
DNS-pinned `guardedRequest`; redirect responses return to Chromium and each
subsequent request is checked independently. Private/link-local destinations,
non-HTTPS protocols, upgrades, opaque uploads and attachment downloads are denied.
Responses, uploads, concurrency and total network use are bounded. Direct network
traffic from Chromium, WebSockets, WebRTC and worker processes cannot leave the
network namespace. Worker and popup targets remain paused and are closed. Browser
downloads are also disabled through CDP. Permission to the project/user is checked
again before every forwarded request and every action.

Profiles are isolated per user/project and discarded at close. This initial
implementation permits one browser for the instance, expires it after five idle
minutes, and exposes navigate, screenshot, coordinate click and focused-field
text insertion. There is no arbitrary JavaScript, file upload or shell command
API. Human actions show a review dialog; `browser_control` is a write tool through
the existing agent approval system. Page text is marked untrusted. Screenshots
remain in bounded server memory and are served only to the creating user; they
are not automatically attached to model messages. A restart removes all sessions.

Tests use fake network/CDP/engine transports and synthetic content. The kernel
pipe test verifies communication through an actual bubblewrap network namespace.
A deployment should smoke-test its own Chromium build: start, navigate a synthetic
HTTPS fixture, capture, click/type, close; verify private redirects, iframe fetches,
worker requests, WebSockets and downloads remain blocked. No Chromium binary is
bundled, no private profiles are imported, and no tests log into personal accounts.

Public reference APIs used for this independent implementation:
[CDP Fetch](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/),
[CDP Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/), and
[Chromium debugging pipe descriptors](https://chromium.googlesource.com/chromium/src/+/e972c575b9a075ab5dcadddf269d60bb23d4af35).
