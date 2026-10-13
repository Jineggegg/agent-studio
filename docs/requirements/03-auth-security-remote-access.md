# 03 — Sign-in, Security, Remote Access, Deployment and Settings

> **Provenance.** Written by the product-analysis group from the behaviour of a private predecessor system, as input for an independent implementation (see `docs/clean-room/PROCESS.md`). It describes what the product should do, never how the predecessor was built. Owner-specific private integrations were removed from this published copy. Where the implementation deliberately differs, `docs/requirements/README.md` says so. Statements about the predecessor's security behaviour were removed or restated as requirements before publication.

Clean-room requirements document, Group A (product analysis), domain 3.
Audience: the development group building "Agent Cloud Studio 2.0" (MIT). This document describes **what** the new product must do as seen by a user, an operator and an attacker. It deliberately contains no code, no identifiers and no architecture of the predecessor.

**Reading conventions**

- **(observed)** — ordinary product behaviour taken from the predecessor's screens or documentation.
- **(inferred)** — deduced from surrounding behaviour; not directly confirmed.
- Security requirements carry no such marker; they are requirements for the new product only.
- Numeric values are recommended defaults for the new product, which may make them configurable; tests in section 6 assume these defaults unless stated.
- Vocabulary used here (chosen for this document):
  - **Service** — the backend process; **App** — the browser client (phone, tablet, desktop).
  - **Owner** — the single account holder; **Operator** — whoever administers the machine the Service runs on (often the same person).
  - **Entry point** — a distinct address through which the same Service is reached. Three classes: **public entry** (internet-facing, through an outbound tunnel or reverse proxy that terminates TLS), **private-network entry** (through a mesh-VPN HTTPS proxy on the host), **local/direct** (loopback or LAN, no proxy).
  - **Step-up** — re-entering the account password inside an already signed-in session before a sensitive change.
  - **Access key** — a long-lived credential for programmatic (non-browser) use.
  - **Provider key** — an API key of a model provider (pay-as-you-go), entered by the Owner.
  - **Secret store** — the Service's encrypted storage for provider keys and channel credentials.
  - **Agent CLI** — an external coding-agent command-line tool the Service launches on the Owner's behalf.
- Vendors: requirements below are written vendor-neutrally. The public entry may be any outbound tunnel or TLS-terminating reverse proxy, optionally fronted by an identity-aware access proxy; the private-network entry is a mesh VPN's HTTPS proxy on the host.
- Owner-specific deployment facts (addresses, host names, ports, service names, paths) are intentionally absent.

---

## 1. Scope summary

This domain covers everything that decides **who may use the Service, from where, and how safely**: creating the one Owner account on first run; signing in with a password or a passkey; how sessions live, renew, expire and are revoked; throttling, progressive lockout and the recovery paths around them; the security overview and event log; access keys for programmatic use; how real-time connections are authenticated and bounded; perimeter protections (rate limits, size limits, slow-request limits, cross-origin and framing rules, uniform errors); how provider keys and other secrets are entered, stored, shown (never) and removed; how launched agent processes and terminals are kept away from the Service's own configuration; running the Service locally and exposing it remotely through a tunnel and/or a mesh VPN, including switching between entry points without signing in again; connecting projects to operator-approved remote machines over SSH; the operator's tools (health check, version and runtime status, update detection, command-line status, local unlock, startup and shutdown behaviour, logs, backup and migration); and the Settings application itself — its navigation model and every page not specific to chat or projects. The product is a **single-owner** system (roles are an open question, section 9); password change and reset, per-session revocation and optional backup and export are specified in section 2.11.

---

## 2. Feature inventory

Priority: **Core** (the product is unsafe or unusable without it), **Important**, **Nice-to-have**.
Scope: **Generic** (specify and build) or **Private-excluded** (owner-specific; do not build).

### 2.1 Setup, sign-in and sessions

| ID | Feature | Description | Priority | Scope |
|---|---|---|---|---|
| SEC-001 | First-run account creation | When no account exists, the App shows a setup form and the Service accepts exactly one account creation. | Core | Generic |
| SEC-002 | First-run locality restriction | The first account can only be created from a browser on the host machine itself (direct loopback connection), never through any remote entry point. | Core | Generic |
| SEC-003 | Credential rules | Username 3–128 characters; password minimum length (see SEC-104) and maximum 1024 characters; both required; confirmation must match (client side). | Core | Generic |
| SEC-004 | Password sign-in | Username + password yields a session; one generic refusal for every failure. | Core | Generic |
| SEC-005 | No account enumeration | Unknown usernames cost the same time, count the same, lock the same and are refused in identical words as wrong passwords. | Core | Generic |
| SEC-006 | Sign-in throttling | Wrong passwords are limited per client and per entry-point class in a short window, checked before the password is compared. | Core | Generic |
| SEC-007 | Progressive persistent lockout | Five consecutive wrong passwords lock password sign-in for that entry-point class, with doubling durations; survives restarts. | Core | Generic |
| SEC-008 | Lockout recovery paths | Passkey sign-in, the other entry point, a local operator command, or waiting. A lock never blocks already signed-in sessions. | Important | Generic |
| SEC-009 | Session lifetime and sliding renewal | Sessions last 7 days and are silently renewed while in use (after half the lifetime has passed). | Core | Generic |
| SEC-010 | Sign out (this device) | Confirmed action in Settings that ends the session on this device. | Core | Generic |
| SEC-011 | Sign out everywhere | One action revokes every session, live connection, access key and related grants of the account. | Core | Generic |
| SEC-012 | Session-expiry handling in the App | Any authenticated call refused for an expired/invalid session returns the App to the sign-in screen with a clear message; transient server errors do not sign the user out. | Core | Generic |
| SEC-013 | Post-sign-in onboarding | A two-step wizard on first use: commit identity (required), connect agent CLIs (optional). | Important | Generic |
| SEC-014 | Minimal unauthenticated surface | A visitor without a session can obtain only: the App shell and public static files, a health answer, whether setup is needed, and the sign-in capabilities. | Core | Generic |
| SEC-015 | "Remember this device" choice | Whether to offer it (a shorter default session with an opt-in longer one) is an open question; without it, every sign-in gets the same session lifetime. | Nice-to-have | Generic |

### 2.2 Passkeys (WebAuthn)

| ID | Feature | Description | Priority | Scope |
|---|---|---|---|---|
| SEC-016 | Passkey sign-in | A button on the sign-in screen signs in with a device passkey; no username is typed; user verification (biometric/PIN) is mandatory. | Important | Generic |
| SEC-017 | Passkey registration | From Settings, on the current device, after password step-up. | Important | Generic |
| SEC-018 | Passkey list and removal | List per hostname with device label, enabled date, last-used date; removal needs password step-up. | Important | Generic |
| SEC-019 | Passkeys bound to configured entry hostnames | A passkey works only on the entry point (hostname) it was created on; only configured, DNS-named entry points may use passkeys. | Important | Generic |
| SEC-020 | Flood-proof, replay-proof sign-in challenges | Requesting challenges stores nothing server-side; each challenge is single-use, 60 s, bound to entry point and origin. | Important | Generic |
| SEC-021 | Passkey sign-in while password sign-in is locked | A successful passkey sign-in works while password sign-in is locked and lifts that entry point's lock. | Important | Generic |

### 2.3 Account security, step-up and audit

| ID | Feature | Description | Priority | Scope |
|---|---|---|---|---|
| SEC-022 | Password step-up | Sensitive changes require the current password again; refusals are distinct from sign-in refusals. | Core | Generic |
| SEC-023 | Per-session step-up budget | Each signed-in session has its own wrong-password budget and lock for step-up, independent of sign-in locks, so a stolen session can only lock itself. | Important | Generic |
| SEC-024 | Per-account daily step-up cap | At most 20 failed step-up passwords per account per rolling 24 h across all sessions; cleared only by "sign out everywhere" or the local operator command. | Important | Generic |
| SEC-025 | Lock status display | Settings shows, per scope, whether password use is locked and until when. | Important | Generic |
| SEC-026 | Security event log | Three independently retained lists: important changes, successful sign-ins, failed attempts; addresses masked; repeats collapsed. | Important | Generic |
| SEC-027 | Single-owner account model | One account per installation; registration closes permanently once it exists. | Core | Generic |
| SEC-028 | Per-user scoping of personal data | Passkeys, access keys, stored tokens, provider keys, preferences, drafts, push subscriptions and channel settings are keyed to the account and never returned to another account. | Core | Generic |

### 2.4 Programmatic access and stored tokens

| ID | Feature | Description | Priority | Scope |
|---|---|---|---|---|
| SEC-029 | Access keys | Create (named, password step-up, value shown once), list (masked), disable, re-enable (step-up), delete. | Important | Generic |
| SEC-030 | Access-key authentication | The external automation interface accepts an access key in a request header instead of a session. | Important | Generic |
| SEC-031 | Stored source-host tokens | Named personal tokens for a Git hosting service: add, list (never showing the value), enable/disable, delete. | Important | Generic |
| SEC-032 | Deployment-wide shared gate key | Optional: when configured, every API call must carry one shared key. Whether to offer it is an open question (see W-28). | Nice-to-have | Generic |

### 2.5 Real-time connections

| ID | Feature | Description | Priority | Scope |
|---|---|---|---|---|
| SEC-033 | Authenticated real-time connect | Every real-time channel (chat stream, terminal, notification stream, plugin channels) requires a valid session at connection time. | Core | Generic |
| SEC-034 | Real-time resource bounds | Connect rate limits, open-connection caps per client and per entry class, 16 MiB message cap, heartbeat, slow-consumer eviction. | Core | Generic |
| SEC-035 | Immediate cut-off on revocation | "Sign out everywhere" terminates the account's live connections at once. | Core | Generic |
| SEC-036 | Re-validation of long-lived connections | A connection must not outlive the session that opened it. | Core | Generic |

### 2.6 Perimeter protections

| ID | Feature | Description | Priority | Scope |
|---|---|---|---|---|
| SEC-037 | Tiered rate limiting | Separate budgets for anonymous endpoints, signed-in API, static/page loads and real-time connects; each per client and per entry class. | Core | Generic |
| SEC-038 | In-flight request caps | A client or entry class cannot hold more than its share of requests in progress. | Important | Generic |
| SEC-039 | Request size limits by trust | Small bodies before authentication; large bodies read only after the session is verified. | Core | Generic |
| SEC-040 | Slow-request protection | Deadlines for headers, whole request and pre-authentication bodies; connection and keep-alive caps. | Important | Generic |
| SEC-041 | Upload limits | Per-kind maximum sizes for images, attachments, audio and file uploads. | Core | Generic |
| SEC-042 | Cross-origin policy | No cross-origin reads of the API; only the health answer (and the sandboxed app gateway) are readable from other origins. | Core | Generic |
| SEC-043 | Anti-framing | Only the App's own origin may frame the App. | Core | Generic |
| SEC-044 | Client identification per entry class | Which entry class a request used, and which client it counts as, is decided from trustworthy facts only; IPv6 clients are grouped by /64. | Core | Generic |
| SEC-045 | Uniform errors | JSON errors with a machine code and human message; unknown API paths answer JSON "not found"; no stack traces to clients or (for client errors) to logs. | Important | Generic |
| SEC-046 | No caching of credential-bearing answers | Answers that carry a session or one-time code are marked non-cacheable. | Important | Generic |
| SEC-047 | Credentials kept out of URLs | Session credentials are never accepted in a URL (W-03). | Core | Generic |
| SEC-048 | Static serving hardening | Only built client files and bundled public files are served; traversal refused; long caching for fingerprinted files, revalidation for the shell page. | Important | Generic |
| SEC-049 | Security response headers | Content security policy, transport security, MIME-sniffing and referrer policies on every App response, in addition to anti-framing (W-10). | Core | Generic |

### 2.7 Secrets and isolation

| ID | Feature | Description | Priority | Scope |
|---|---|---|---|---|
| SEC-050 | Provider key management | Enter, replace, verify connection, remove; the App only ever learns "configured / not configured". | Core | Generic |
| SEC-051 | Encrypted secret store | Secrets are stored with authenticated encryption under an installation key in an owner-only location; each record bound to its account and purpose. | Core | Generic |
| SEC-052 | Operator opt-in for high-value keys | Storing a high-value provider key is refused until the Operator enables it server-side; removal always works. | Important | Generic |
| SEC-053 | Key-type validation | Wrong kinds of credential (a subscription sign-in token, an organisation admin key) are refused with a specific explanation that never echoes the value. | Important | Generic |
| SEC-054 | Server-provided key files | A provider key may come from an operator-managed file; the App shows it as "provided by the server" and cannot replace or remove it. | Nice-to-have | Generic |
| SEC-055 | Write-only credential fields | Channel passwords and tokens are never filled back into forms; a blank field keeps the saved value; only a "saved" flag or a short hint is shown. | Important | Generic |
| SEC-056 | Secret redaction | Secrets never appear in responses, error messages, logs, events, URLs or browser storage; error text containing a secret is masked. | Core | Generic |
| SEC-057 | Agent CLI account status and sign-in launcher | Per agent: installed?, signed in? (account label, method), error; a button opens a terminal running that CLI's own sign-in. | Core | Generic |
| SEC-058 | Subscription-override warning | Warn when an API key present in the environment silently overrides a subscription login for an agent CLI. | Nice-to-have | Generic |
| SEC-059 | Agent process environment isolation | Agent sessions and terminals receive the host environment minus everything that configures the Service itself. | Core | Generic |
| SEC-060 | Minimal environments for auxiliary processes | Build runs, plugins and user-built apps get allow-listed environments. | Important | Generic |
| SEC-061 | Private data-store permissions | The data store and its directory are created owner-only and tightened if found too open. | Important | Generic |

### 2.8 Remote access and deployment

| ID | Feature | Description | Priority | Scope |
|---|---|---|---|---|
| SEC-062 | Loopback-by-default listening | Listens on loopback unless the Operator says otherwise; host, port and data location are configurable. | Core | Generic |
| SEC-063 | Two entry points, one backend | A public entry (domain behind an outbound tunnel) and a private-network entry (mesh-VPN HTTPS proxy) both reach the same process and data. | Important | Generic |
| SEC-064 | Dedicated tunnel listener | An extra loopback listener used only by the tunnel, so "public" is decided by where a connection arrived, not by forgeable headers. | Important | Generic |
| SEC-065 | Edge access-proxy verification | Optional: the Service itself verifies the signed assertion of an identity-aware proxy in front of the public entry and refuses everything else. | Important | Generic |
| SEC-066 | Passwordless private-network sign-in | Optional: allow-listed mesh-VPN identities (optionally only listed devices) are signed in without a password on the private-network entry. | Nice-to-have | Generic |
| SEC-067 | Confined, revocable private-network sessions | Sessions issued that way work only through the private-network entry and die when the allow-list no longer covers them. | Nice-to-have | Generic |
| SEC-068 | Entry switch with one-time transfer code | Move the signed-in browser to the other entry point without typing the password, never widening the session. | Important | Generic |
| SEC-069 | Entry reachability and latency probe | Settings shows per entry: reachable with latency, blocked by the access proxy, or unreachable; remembers the device's preferred entry. | Nice-to-have | Generic |
| SEC-070 | In-app network guide | The setup guide is served by the Service itself and rendered in a sheet. | Nice-to-have | Generic |
| SEC-071 | Configuration warnings | Plain-language warnings in Settings; technical detail (which setting, expected form) folded away for the Operator. | Important | Generic |
| SEC-072 | Public health check | Unauthenticated liveness answer usable by proxies and by the other entry's probe. | Core | Generic |
| SEC-073 | Version and runtime status | Shows the build loaded in this browser, the deployed client build, the running backend build, the source checkout, the newest upstream commit and host uptime. | Important | Generic |
| SEC-074 | Client update detection | A long-lived page notices a newer deployed client and reloads when harmless, otherwise offers a refresh. | Important | Generic |
| SEC-075 | Operator command line | Start, status, version, help; options for port and data location. | Important | Generic |
| SEC-076 | Local lock-clearing tool | An operator command on the host clears password locks without the Service running and without a password. | Important | Generic |
| SEC-077 | Startup safety checks | Refuses to start with a development-only authentication relaxation (SEC-084) when any non-loopback address or remote entry is configured; malformed security settings fail closed, cosmetic ones degrade. | Core | Generic |
| SEC-078 | Graceful shutdown and restart behaviour | On termination, background helpers are stopped; runs cut off by a restart are reported, never silently re-run. | Important | Generic |
| SEC-079 | Missing-dependency behaviour | A missing agent CLI, usage tool, SSH client or sandbox component disables only its feature and says so. | Important | Generic |
| SEC-080 | Backup, restore and migration | At least a documented procedure: copy the data store together with the secret store and configuration (Flow 17); in-app backup is optional (SEC-106). | Important | Generic |
| SEC-081 | Operator log hygiene | Logs record reasons and entry class, never secrets, full addresses, full identity names or query strings. | Important | Generic |
| SEC-082 | Updates only by the Operator | No signed-in action pulls, builds or installs a new version on the host; the App only explains how to update (W-16). | Important | Generic |
| SEC-083 | Sub-path hosting behind a reverse proxy | Optional: serve the App under a path prefix; the API and real-time addresses then honour the same prefix (open question 8). | Nice-to-have | Generic |
| SEC-084 | No authentication-bypass mode | No mode treats requests as signed in without credentials, except a development convenience that cannot be enabled on a non-loopback address (W-12). | Core | Generic |

### 2.9 Remote machines

| ID | Feature | Description | Priority | Scope |
|---|---|---|---|---|
| SEC-085 | Operator-approved remote host registry | Remote SSH hosts come only from server-side configuration; the browser can never name an arbitrary host or command. | Important | Generic |
| SEC-086 | Remote host status probe | Online/offline, latency, which tools are installed, short safe failure reason; cached. | Important | Generic |
| SEC-087 | Remote project sessions | A project bound to a remote host opens an agent CLI or a shell in a persistent terminal session on that host, in a full-screen terminal. | Important | Generic |
| SEC-088 | Separate agent identity on the remote host | Agent CLIs on the remote host use their own configuration location so the host owner's logins are untouched. | Important | Generic |

### 2.10 Settings

| ID | Feature | Description | Priority | Scope |
|---|---|---|---|---|
| SEC-089 | Settings shell | Root list plus pages; split view on wide screens, drill-down on phones; deep-linkable pages. | Core | Generic |
| SEC-090 | Account and security page (「账户与安全」) | Who is signed in, locks, passkeys, events, sign out, sign out everywhere. | Core | Generic |
| SEC-091 | Quick controls | One-tap appearance (light / dark / automatic), usage figure mode, home icon labels on the root list. | Important | Generic |
| SEC-092 | Network and remote hosts page (「网络与远程主机」) | Entry points with status and switching; remote hosts with status. | Important | Generic |
| SEC-093 | Notification settings (「通知」) | Channel switches with setup, test and removal; per-event switches. Channel behaviour belongs to domain 4. | Important | Generic |
| SEC-094 | Home screen settings (「主屏幕」) | Look switches, counts, and two confirmed resets. Detail belongs to domain 4. | Nice-to-have | Generic |
| SEC-095 | About page (「关于本机」) | Name, version, build time, link to runtime status, debug switch, source and licence links. | Important | Generic |
| SEC-096 | Language selection | Interface language choice (13 locales in the legacy dialog); the newer screens are single-language. | Important | Generic |
| SEC-097 | Preference sync | Account preferences are stored server-side, merged key-by-key and pushed to the account's other open pages. | Important | Generic |
| SEC-098 | Legacy settings dialog | Older tabbed dialog (agents, appearance, commit identity, keys and tokens, voice, tasks, browser, plugins, notifications, about). Reference for options only. | Nice-to-have | Generic |
| SEC-099 | Voice backend settings | Optional speech backend address, key, models, voice and format; the key is kept in the secret store (W-17). | Nice-to-have | Generic |
| SEC-100 | Touch debug overlay switch | Device-local diagnostic overlay toggled from About. | Nice-to-have | Generic |

### 2.11 Account management and hardening

| ID | Feature | Description | Priority | Scope |
|---|---|---|---|---|
| SEC-101 | Password change | Change password with the current password; revokes other sessions. | Core | Generic |
| SEC-102 | Password reset for a locked-out owner | Operator-side reset on the host machine; no remote reset. | Core | Generic |
| SEC-103 | Per-session list and revocation | See active sessions (entry class, device label, last used) and end one. | Important | Generic |
| SEC-104 | Stronger password policy | Minimum 12 characters or an equivalent strength check; over-long input is rejected, never truncated. | Core | Generic |
| SEC-105 | Server-side single sign-out | "Sign out" invalidates that session on the Service as well as in the browser. | Core | Generic |
| SEC-106 | Data export, in-app backup, account deletion | Optional; decide scope. | Nice-to-have | Generic |
| SEC-107 | Access-key scopes and expiry | Optional expiry and restricted scope per key. | Important | Generic |

### 2.12 Generic capabilities abstracted from private features

| ID | Feature | Description | Priority | Scope |
|---|---|---|---|---|
| SEC-108 | Passkey confirmation for high-risk actions | A fresh, single-use, 60-second passkey assertion bound to one specific action (as opposed to sign-in). | Nice-to-have | Generic |
| SEC-109 | Scoped short-lived access to an embedded companion service | A same-origin gateway to one fixed local service with a path allow-list and an HttpOnly, same-site-strict cookie that slides (30 min) up to a hard cap (8 h) and dies on sign-out. | Nice-to-have | Generic |
| SEC-110 | Signed one-click sign-in to a companion site | A single-use, two-minute signed ticket naming a role and landing route; the shared secret lives in an owner-only file, never in the environment. | Nice-to-have | Generic |

### 2.13 Private features (do not build)

| ID | Feature | Description | Priority | Scope |
|---|---|---|---|---|

---

## 3. User flows

### Flow 1 — First-run setup (SEC-001, 002, 003, 013)

1. The Operator starts the Service on the host machine. No account exists.
2. Any browser that opens the App sees the launch screen, then the setup form (title "Create Account", three fields, a hint about minimum lengths, a footer stating that only one account can be created).
3. **On the host machine (desktop browser at a loopback address):** the Operator types a username, a password and the password again, and submits.
   - Client-side checks, in order: all fields filled; username at least 3 characters (trimmed); password at least the minimum length; both passwords equal. The first failing check shows one inline message and nothing is sent.
   - On success the account exists, the browser is signed in, and onboarding (Flow 9) starts.
4. **From a phone or any remote entry point:** the same form is shown, but submitting is refused with a message saying the first account can only be created on the computer that runs the Service. No account is created. The App detects this case and explains it before the user types (W-25).
5. After the account exists, the setup form never appears again and account creation is refused for everyone, including from the host machine.

### Flow 2 — Sign in with a password (SEC-004–009)

Same on phone and desktop; layout differs only in size.

1. The user opens the App without a valid session. Launch screen → sign-in screen (title, username field, password field with show/hide toggle, primary button, and — if the browser supports passkeys — a divider and a passkey button).
2. The user fills both fields. Password managers may autofill (fields are marked as username / current password).
3. Submit: both buttons disable; the primary button shows a spinner and "signing in…".
4. Success: the session is stored; onboarding status is checked **before** the workspace is shown (so a first-time user never glimpses the workspace); then either onboarding or the home screen appears.
5. Wrong credentials: one generic message ("invalid username or password"); fields keep their content.
6. Too many attempts from this client: a message saying when to retry.
7. Password sign-in locked on this entry point: a message stating how long (minutes, or hours when ≥ 2 h) and suggesting a passkey or the private-network address.
8. Network failure: "network error, try again"; nothing else changes.

### Flow 3 — Register a passkey (SEC-017, 019, 022)

1. Signed in, the user opens Settings → 「账户与安全」.
2. Preconditions shown on the page:
   - Browser lacks passkey support → a warning; the form is disabled.
   - The page was opened from an address that is not a configured, DNS-named entry point → a warning naming the address(es) to open instead; the form is disabled.
3. The user types the account password into the field and taps the enable button (wording changes to "also enable on this device" when this hostname already has a passkey).
4. The Service checks the entry point first, then the password. Wrong password → inline error; counts against the session's step-up budget.
5. The device shows its own biometric/PIN prompt for creating a passkey **on this device** (not a cross-device/phone-over-Bluetooth flow).
6. Success: toast naming the hostname; password field clears; the passkey list and the event log refresh; an "added a sign-in passkey" entry appears under important events.
7. Cancelled or failed prompt → a friendly message (cancelled or device verification not completed / already enabled on this device / this address needs HTTPS with a domain name). The step must be restarted from 3 (the challenge is valid 60 s and single-use).

### Flow 4 — Sign in with a passkey (SEC-016, 020, 021)

1. On the sign-in screen the user taps the passkey button (label in the existing product: "Sign in with Face ID").
2. Both buttons disable; the passkey button shows "verifying…".
3. The device offers the passkeys it holds for this hostname; the user confirms with biometrics/PIN. No username is typed.
4. Success: signed in exactly as with a password. If password sign-in was locked for this entry point, the lock is lifted and an event records it.
5. User cancels the prompt: message "cancelled, or the device did not finish verification"; no request is counted as a failure.
6. Any server-side refusal (unknown passkey, wrong hostname, expired or reused challenge, verification failed): one generic message "passkey sign-in failed; try again or use your password".
7. The page is on an address where passkeys are not available: a message saying to open the App from a configured address.

### Flow 5 — Remove a passkey (SEC-018, 022)

1. In 「账户与安全」 the user taps the delete icon on a passkey row.
2. An alert asks for the account password, explains that this address can no longer use passkey sign-in and that the credential stored on the device itself must be deleted in the device's password settings.
3. Confirm with the correct password → toast, alert closes with its exit animation, list refreshes, event recorded.
4. Wrong password or step-up locked → error inside the alert; alert stays open.
5. Escape, tapping the scrim or Cancel closes the alert (not while the request is in flight); focus returns to the delete button.

### Flow 6 — Sign out, and sign out everywhere (SEC-010, 011, 035)

1. **Sign out:** 「账户与安全」 → 「退出登录」 → confirmation ("this device will sign out") → the Service invalidates that session (SEC-105); the App forgets it together with local copies of preferences and unsent drafts, and shows the sign-in screen.
2. **Sign out everywhere:** 「退出所有设备」 → confirmation that lists the consequences (every browser including this one, running chat and terminal connections drop, access keys are disabled) → on success a toast summarising what was revoked (for example: N access keys disabled, N connections closed, N push subscriptions removed) → sign-in screen.
3. On every other device: the next request or reconnect is refused; live real-time connections are cut immediately; the App shows the sign-in screen with a "session expired" message.
4. After signing in again, access keys remain disabled until re-enabled with the password; a device that had notifications enabled silently re-registers its own push subscription.

### Flow 7 — Session expires or is revoked mid-use (SEC-012, 036)

1. The user is working; a request is refused as unauthenticated (expired, revoked, or no longer valid on this entry point).
2. The App clears the stored session (and its local copies of preferences and drafts), shows the sign-in screen and a message that the session expired. Unsent drafts already synced to the Service come back after signing in again (inferred from the draft-sync behaviour; draft sync itself belongs to domain 1).
3. Real-time channels stop reconnecting until a new session exists; after sign-in they reconnect automatically and each feature catches up on what it missed.
4. If instead the Service is merely unreachable or answers with a server error or "too many requests" while the App starts, the session is **kept**, an error about not being able to check sign-in status is shown, and the next load signs straight back in.

### Flow 8 — Recover from a lockout (SEC-008, 076)

In order of convenience:

1. Use the other entry point: locks are per entry class, so a guessing attack on the public address does not lock the private-network address.
2. Use a passkey on the locked address; success lifts that lock.
3. If the public address has no passkey yet: sign in on the private-network address, switch to the public address (asks for the password once, counted against the session's own budget, unaffected by the public lock), then register a passkey there.
4. On the host machine, run the local lock-clearing command (all users or one username). Takes effect immediately; an event "lock lifted by local command" is recorded.
5. Wait; the sign-in screen states the remaining time.

### Flow 9 — Onboarding after the first sign-in (SEC-013, 057)

1. Step 1 "commit identity": name and e-mail, pre-filled from the host's existing global commit identity when present. Both required; e-mail must look like an e-mail. "Next" saves (also applied as the host's global commit identity; a failure to apply does not block).
2. Step 2 "connect agents": one card per offered agent CLI showing checking / connected / not connected, with a sign-in button. All optional; a hint says it can be done later in Settings.
3. A sign-in button opens a modal terminal running that CLI's own sign-in command; the user follows the CLI's instructions (open a link, paste a code). The modal stays open after the command exits so output can be read; closing it re-checks all statuses.
4. "Complete setup" marks onboarding done and opens the home screen. "Previous" returns to step 1.
5. If onboarding status cannot be read (transient error) the App proceeds to the workspace rather than blocking.

### Flow 10 — Add, replace, verify and remove a provider key (SEC-050–056)

1. Settings → the provider's page. A status row shows 「已配置」 / 「未配置」 (and 「未开启」 when the Operator has not enabled storing this kind of key; then the form is disabled with a one-line explanation).
2. The user types or pastes the key (placeholder: required, or "type a new key to replace"). For high-value keys a second field asks for the account password.
3. Save → the key leaves the browser once, the field clears, a success line "key saved" appears, status becomes 「已配置」. The key is never shown again anywhere.
4. Format problems (too short, too long, contains whitespace, wrong kind of credential) → a specific message that never repeats the typed value.
5. 「验证连接」 performs one free read against the provider and reports "verified", "key invalid or disabled", or "provider unreachable".
6. 「移除密钥」 → confirmation → deleted on the Service; status 「未配置」. Removal needs no password and works even when storing is disabled.
7. A key supplied by an operator-managed file is shown as "provided by the server"; remove is disabled.

### Flow 11 — Create and use an access key (SEC-029, 030)

1. Keys-and-tokens panel → "New key" → name + account password → Create.
2. A highlighted notice shows the full key once with a copy button and a "this is the only time you will see it" warning; "I've saved it" dismisses it for good.
3. The list shows name, a masked beginning of the key, created date, last-used date, an active/inactive button and delete.
4. An external script sends the key in a request header to the automation interface. Missing or inactive key → unauthenticated.
5. Disabling: one tap, no password. Re-enabling: an inline password field appears; correct password required. Deleting: confirmation.
6. Wrong password → the Service's message shown above the list; too many → throttled message.

### Flow 12 — Expose the Service remotely (operator) (SEC-062–072, 077)

1. **Local only (default):** the Service listens on loopback; reachable only from the host machine.
2. **Private-network entry:** the Operator enables the mesh VPN's HTTPS proxy on the host, forwarding to the Service's loopback address, and records that entry's exact origin (scheme + host + optional port, no path) in the Service configuration. Only devices in the private network can reach it; the proxy provides the certificate.
3. **Public entry:** the Operator runs an outbound tunnel client on the host for a domain they control (no inbound ports, no public address needed), points it at a **dedicated** loopback listener of the Service, pins the forwarded host name, and records the public origin in the configuration.
4. **Strongly recommended:** put an identity-aware access proxy in front of the public domain (for example e-mail one-time code, owner only), exempting only the health check and home-screen icon/manifest files; then give the Service the proxy's issuer and audience settings so it verifies every public request itself.
5. Restart the Service. In Settings → 「网络与远程主机」 both entries appear with their status; warnings explain anything misconfigured.
6. On a phone or tablet: open the chosen address in the browser, sign in, and optionally add it to the home screen. A home-screen app is tied to one address; add one icon per entry if both are used. Behind an access proxy the home-screen app has its own cookie jar and must pass the proxy once more.
7. If the host machine sleeps or is off, both entries fail (tunnel error page / unreachable). The App's probe then shows "unreachable".

### Flow 13 — Switch entry points while staying signed in (SEC-068, 069)

1. Settings → 「网络与远程主机」 → section 「连接方式」 lists both entries as radio rows; the current one is marked 「当前」.
2. Tapping the other entry:
   - If the current session came from passwordless private-network sign-in and the target is the public entry → an inline form asks for the account password once.
   - Else, if its probe says unreachable → a toast explains (check the mesh VPN on this device / check the tunnel on the host) and offers "go anyway".
   - Otherwise the row shows a spinner.
3. The App asks the Service for a one-time transfer code and navigates the browser to the same screen on the other address, carrying the code.
4. The page there removes the code from the address bar immediately, exchanges it for a session, remembers this entry as the device's preference and continues on the same screen.
5. If the exchange fails (older than 60 s, already used, wrong address) the sign-in screen appears with an explanation — unless a stored session or passwordless sign-in succeeds, in which case nothing is shown.
6. Later, when the device opens the entry it did **not** last choose, a row offers "this device last chose X — switch there".

### Flow 14 — Passwordless sign-in on the private network (SEC-066, 067)

1. The Operator lists the allowed mesh-VPN identities (and, recommended, the exact device addresses) in the configuration and restarts.
2. An allowed device opens the private-network address. With no stored session, the App silently asks for a passwordless session (3-second limit) and enters the workspace; otherwise the normal sign-in form appears with no error.
3. Other members of the private network still see the sign-in form.
4. "Sign out" followed by a reload signs in again automatically (by design; to stop it, the Operator removes the identity).
5. Removing the identity or device from the allow-list and restarting ends those sessions at once, including renewed ones.

### Flow 15 — Connect a project to a remote machine (SEC-085–088)

1. **Operator (host machine):** sets up key-based SSH to the remote machine under a host alias, then adds an entry to the Service configuration: short name, display label, SSH target, optional default directory. Restart.
2. Settings → 「网络与远程主机」 → 「远程主机」 lists each host with a spinner, then 「在线 N ms」 or 「离线」, plus which tools were found (each agent CLI and the terminal multiplexer, ✓ or ✗) or a short failure reason. A refresh button re-checks.
3. A host with a default directory appears automatically as a project. For other projects, the project editor offers "this machine" or one of the listed hosts, plus a remote directory field.
4. Opening the project shows the host's status and buttons for each agent CLI and a shell. Tapping one opens a full-screen terminal connected to a named persistent session on the remote machine.
5. First use of an agent CLI there: the CLI asks the user to sign in with their own account; those credentials are stored on the remote machine in a location separate from the host owner's.
6. Closing the terminal only detaches; the agent keeps running; reopening reattaches to the same session.
7. Failures: host offline (banner with reason), agent not installed on the remote machine (message in the terminal), host removed from configuration (refused with an explanation).

### Flow 16 — Check versions and pick up an update (SEC-073, 074)

1. Settings → 「关于本机」 shows version and build time; → 「版本与运行状态」 shows the rows described in section 4.
2. When the client build served by the Service differs from the one loaded in this browser, a notice with a "reload page" button appears there.
3. Independently, any long-lived page checks periodically. If a newer client is being served: it reloads by itself when that cannot lose anything (just returned from background, untouched, nothing open, nothing typed), otherwise a persistent toast 「Studio 已更新」 with a 「刷新」 action appears.

### Flow 17 — Back up or move the installation (operator) (SEC-080)

1. Stop the Service or wait for running tasks to finish.
2. Take a consistent copy of the data store, the secret store directory beside it, and the configuration file. They must travel and be protected together: the secret store's installation key decrypts the saved secrets.
3. On the new machine: restore the three items, start the Service, sign the agent CLIs in again (their logins are machine-local), repoint the tunnel/proxy.
4. If the secret-store key is lost or replaced, saved secrets show "cannot be read any more — enter again".

### Flow 18 — Appearance, language and notification switches (SEC-091, 093, 096)

1. Appearance: Settings root → segmented control 浅色 / 深色 / 自动; applies instantly and follows the account to other devices. In automatic mode a small caption says which is active now.
2. Language: a select listing the available languages; applies without reload.
3. Notifications: per-channel switch (disabled until the channel is configured) and per-event switches; each change saves immediately; a save failure shows an error line at the top and the switch reverts on next load.

---

## 4. Screens and interaction requirements

General rules for every screen in this domain (observed unless marked):

- Minimum touch target 44×44 pt; primary buttons on the sign-in screens are at least 50 pt tall; text inputs use a font size of at least 16 px so iOS does not zoom.
- Hover effects only on devices that report hover capability; reduced-motion preference removes non-essential animation.
- Loading is shown in place (spinner row with "reading…"); a failed read shows the reason with a 「重试」 button, never an empty list that looks like "nothing here yet".
- Destructive actions are red, always confirmed in a sheet/alert that states exactly what will be affected.
- Alerts and sheets: focus moves into them, Tab is trapped, Escape and scrim tap cancel (unless a request is in flight), focus returns to the trigger.
- Password and secret fields disable auto-capitalisation, auto-correction and spell check.

### 4.1 Launch / loading screen

- Shown while session state is being determined (stored session check, transfer-code exchange, passwordless attempt).
- No controls. Must not flash the sign-in form before those checks settle, and must not flash the workspace before onboarding status is known.
- Upper bound: passwordless attempt 3 s, transfer-code exchange 8 s; then fall through to the next step.

### 4.2 First-run setup screen

- **Information:** product mark, title, one-line description, footer line that this is a single-owner system.
- **Controls:** username; password; confirm password (both with show/hide toggle); hint line about minimum lengths; submit button.
- **States:** idle; submitting (button spinner + "setting up…", fields disabled); validation error (single alert region); refused because not on the host machine; refused because an account already exists; network error.
- **Autofill:** fields marked as username / new password so password managers offer to save.

### 4.3 Sign-in screen

- **Information:** product mark, title, description, footer line (private workspace; the public address needs the password).
- **Controls:** username; password with show/hide; primary sign-in button; divider "or"; passkey button (only when the browser supports passkeys in this context).
- **States:**
  - idle;
  - password submitting (both buttons disabled, primary shows spinner);
  - passkey pending (both disabled, passkey button shows spinner and "verifying…");
  - error line — one region for: empty fields, invalid credentials, throttled, locked (with wait time and alternatives), passkey cancelled, passkey failed, passkey unavailable on this address, network error;
  - session-expired banner (when arriving from an expired session);
  - transfer-code-expired banner (when an entry switch failed and nothing else signed the user in);
  - sign-in status unknown (Service unreachable at start).
- **Layout:** card centred in the dynamic viewport height; padding adds the top and bottom safe-area insets; narrower type below ~420 px width. Background matches the launch screen so the transition is seamless.
- **Touch vs pointer:** identical controls; hover brightening only with a pointer; Enter submits the form.

### 4.4 Onboarding wizard

- **Information:** two-step progress indicator; step title and description.
- **Step 1 controls:** name field, e-mail field, helper text that these become the host's global commit identity. "Next" disabled until both are valid.
- **Step 2 controls:** one card per agent CLI: logo, name, status text (checking / connected, with account label when known / not connected), sign-in button.
- **Footer:** "Previous" (disabled on step 1 and while saving), "Next" / "Complete setup" with spinner while saving.
- **States:** saving; save error (alert under the step); completion error.
- **Agent sign-in modal:** full-screen on phones, large centred dialog on desktop; title naming the agent; close button; an embedded terminal; stays open after the command exits.

### 4.5 Settings shell (「设置」)

- **Wide screens (tablet and desktop):** list on the left, chosen page on the right. With no page chosen, a default page is shown beside the list. Changing page cross-fades the right pane and scrolls it to the top; the list never moves. A page one level deeper shows its own back button naming the parent.
- **Phones:** one screen at a time. The root list is the first screen; a page pushes in from the right; back pops to the right. Each screen keeps its own scroll position, restored when coming back. The title is a large heading that scrolls away, after which the navigation bar becomes translucent.
- **Deep links:** every page has an address so notifications and other screens can open it directly.
- **Root list content, top to bottom:**
  1. Account card: avatar with the first letter of the username, username, chevron → 「账户与安全」.
  2. Quick controls: 「外观」 (浅色 / 深色 / 自动); usage figures mode (remaining / used); 「图标名称」 switch.
  3. AI group: default model (shows the current choice), usage items, one row per provider key page (shows 已配置 / 未配置).
  4. Connections group: 「网络与远程主机」 (shows which entry class this page came through: public / private network / local).
  5. General group: 「通知」, 「主屏幕」 (shows folder count), 「关于本机」 (shows version, or "development").
- Each row shows its current value in grey where meaningful, so most questions are answered without opening the page.

### 4.6 Account and security page (「账户与安全」)

- **Account row:** avatar initial and username (read-only).
- **Section 「安全」:**
  - Lock rows — "public password sign-in", "private-network password sign-in", and (only while it holds) "password confirmation in settings". Each has a badge 「正常」 or 「已锁定」 and, when locked, "cannot use the password before <time>".
  - Passkey enable form — password field and a button; disabled with a warning when the browser or address cannot use passkeys.
  - Passkey list — hostname (current hostname first and tagged 「当前」, others alphabetical), device label, enabled date, last-used date, delete icon button with an accessible name including the hostname.
  - 「重要事件」 — up to 10 rows.
  - 「最近登录」 — up to 10 rows.
  - 「最近的安全事件」 — up to 30 rows, first 6 visible with "show all N" / "collapse".
  - 「退出所有设备」 (destructive).
- **Final section:** 「退出登录」 (destructive, centred).
- **Event row format:** title (kind of event), then one line: time · entry class · masked client address (omitted when unknown) · detail · "N 次" when the row stands for repeats.
  - Event kinds: password sign-in failed; password sign-in; password sign-in locked; lock lifted (by password sign-in / passkey sign-in / private-network sign-in / password confirmation / local command); passkey sign-in; private-network sign-in; entry-switch sign-in; passkey sign-in failed (unregistered passkey / verification expired / device verification failed / passkey belongs to another account / account missing / invalid data); passkey added; passkey removed; signed out everywhere; access keys disabled; new push subscription; wrong password in settings.
- **States:** loading row; load error with retry; empty event list ("no security events yet"); enrol in progress; enrol error line; revoke in progress.
- **Sheets:** remove-passkey alert (password field, error line, Cancel / Remove); confirm sign-out; confirm sign-out-everywhere.

### 4.7 Network and remote hosts page (「网络与远程主机」)

- **Section 「连接方式」**, header caption "current · <entry label or local address>".
  - One radio row per entry point: icon, label, 「默认」 tag on the default (public) entry, the origin in monospace or 「未配置」, and on the right either a small spinner (probing), "N ms", "needs access-proxy verification", or 「不可达」; the current one also has a 「当前」 badge. Unconfigured rows are disabled.
  - While switching: the target row shows a spinner; other rows are disabled.
  - Inline password form (animated open) when a passwordless session moves to the public entry: password field (autofocus), 「切换」 button, a one-line reason and a cancel link.
  - Preference hint row when this device last chose the other entry.
  - Warnings: one plain sentence each (address format wrong; access-proxy verification misconfigured so all public requests are refused; public entry has no access-proxy verification).
  - Footer links: 「设置说明」 (opens the guide sheet) and 「重新检测」.
- **Guide sheet:** modal with a grabber, title, 「完成」 button; renders the guide text; absolute links open in a new tab, relative links render as plain text; loading and failure states.
- **Section 「远程主机」:** per host: icon, label, SSH target in monospace followed by tool marks or the failure reason, status badge (在线 N ms / 离线) or spinner, refresh icon button. Empty state 「还没有远程主机」. Load error with retry.
- **Touch vs pointer:** rows are full-width tap targets; no hover-only information.

### 4.8 Provider key pages

- **Status row:** provider mark and name; badge 已配置 / 未配置 / 未开启; subtitle "provided by the server" when applicable.
- **Form:** key field (masked; must not trigger the browser's "save password" prompt — use a masked text field where supported, otherwise a password field with autofill off); for high-value keys a password field; Save button with spinner.
- **Actions:** 「验证连接」 (disabled until configured); 「移除密钥」 (destructive, disabled until a removable key exists).
- **Feedback:** success line (saved / verified / removed) or error line under the list; only one at a time.
- **States:** loading (nothing offered until status is known); load error with retry; storing disabled by the Operator (form locked, explanation line; remove still enabled if a key exists).
- Additional per-provider controls (model menu visibility, model lists, balance note) belong to domain 1.

### 4.9 Keys and tokens panel (access keys, source-host tokens)

- **Access keys:** heading with "New" button; description and a link to the public interface documentation; create form (name, password, hint that a key works outside the session, Create / Cancel); error line; one-time reveal notice (full key, copy button with 2-second "copied" state, dismiss button); list rows (name, masked key, created, last used, active/inactive button, delete); inline re-enable password row; empty state.
- **Source-host tokens:** heading with "Add" button; form (name, token with show/hide, optional description, link to the host's token page, Add / Cancel); list rows (name, description, added date, active/inactive button, delete); empty state. The token value is never displayed after saving.
- Confirmations use the product's own confirmation sheet, never a browser-native dialog; failures are shown to the user, not only logged.

### 4.10 Notification settings (「通知」) — security-relevant parts only

- Per channel: switch (disabled until configured), "start setup / change settings" row that expands a form, 「发送测试」 (shows where the test went or why it did not), 「移除设置」 with confirmation.
- Secret fields are never pre-filled; placeholder says "saved — leave blank to keep" or "required"; an account identifier may show only its last four characters.
- State "the saved secret can no longer be read — enter it again" when the secret store's key changed.
- Event switches 「提醒我」: needs your action; reply finished; background task finished; error or interrupted; automation reminders.
- Footnotes state that outbound messages carry only event, project and title — never conversation content.

### 4.11 About and runtime status

- **「关于本机」:** logo and product name; rows: version (or "development mode"), build time; link row → 「版本与运行状态」; debug section with the touch-overlay switch; external links: source code, licence/attribution.
- **「版本与运行状态」:** header with 「刷新状态」 button (spinner while busy). Rows:
  1. This browser — build actually loaded in this tab.
  2. Deployed client — build on the Service's disk.
  3. Running backend — build captured when the process started (does not change if files change later).
  4. Source checkout — branch, short commit, clean/dirty; note that source state is not the running version.
  5. Newest upstream commit — default branch and short commit, checked time; or why it cannot be checked (private repository, rate limited, unreachable, not configured).
  6. Host — machine name, platform, host boot time, process start time.
  - Each build row: version · short commit · "includes uncommitted changes" / "change state unknown", then "built at <time>".
  - Notices: "a different client build is available — save drafts and reload" with a reload button; "client and backend come from different commits — check the deployment".
  - Collapsible 「开发者详情」: when the readings were taken, cache note, and server configuration notes (loaded on first open; loading / error / "nothing needs attention"), link to the network page.
  - States: first load ("checking server and upstream…"), load error with retry, stale-but-shown (error plus "showing the last reading"), signed-out ("sign in again").
  - The page never pulls code, updates or restarts anything.

### 4.12 Agent accounts panel

- Per agent CLI: logo, name, description; connection status text (checking / signed in as <label> / not connected); badge; warning box when a key in the environment overrides a subscription login (names the setting and where it is set, and how to fix); sign-in or re-sign-in button (hidden when the CLI authenticates by key); error line.

### 4.13 Remote project panel and remote terminal

- Host row: label, status (spinner, 在线 N ms, 离线); offline banner with reason; a grid of launch buttons (each agent CLI, shell); collapsible 「详情」 with remote directory, latency, check time, failure reason, notes about the mesh VPN and the terminal multiplexer.
- Remote terminal: full-screen cover with title "<agent> · <host label>" and a close control; closing detaches only.
- Phone: the cover respects safe areas and the on-screen keyboard; desktop: standard keyboard input.

### 4.14 Global notices

- 「Studio 已更新」 toast with 「刷新」 action — persistent until acted on; re-offered when the page returns from background.
- Session expired — sign-in screen with message (not a toast).
- Sign-out-everywhere summary toast before returning to sign-in.

---

## 5. Externally observable behaviour of the Service

Capabilities are described by purpose, inputs, outputs, limits and errors. Addresses, parameter names and message formats are for the new team to design.

### 5.0 Conventions

- **Errors** are JSON with: a success flag set false, a stable machine-readable code, a human-readable message, optional details (for throttles: seconds until retry). Refusals for rate or lock also carry the standard `Retry-After` header.
- **Status families:** 400 malformed or failing validation; 401 no/invalid/expired/revoked session or access key; 403 right identity but not allowed (wrong step-up password, setup not local, origin not allowed, access-proxy assertion missing); 404 unknown resource (also for another account's resource); 408 body arrived too slowly; 409 conflict; 413 too large; 429 throttled or locked; 5xx Service-side.
- **401 answers distinguish** "expired" from "invalid/revoked" in a machine-readable way so the App can word its message.
- Answers that contain a session credential or one-time code are marked `Cache-Control: no-store`.
- Unknown addresses under the API namespace answer JSON 404, never the App shell. Any other address without a file extension answers the App shell; with an extension, a plain 404.

### 5.1 Limits (recommended defaults)

Every limit below must exist. Values are recommended defaults and may be configurable; where none is given, the implementation chooses one and documents it.

| Limit | Recommended default |
|---|---|
| Wrong sign-in passwords per client | 5 per 10 minutes, then refused for the rest of the window |
| Wrong sign-in passwords per entry class (all clients) | a class-wide budget per window, larger than the per-client one |
| Consecutive failures that lock a scope | 5 |
| Lock durations | 15 min, 30 min, 1 h, 2 h … doubling, capped at 24 h |
| Lock level reset | on success in that scope, or after one quiet day following the last lock |
| Step-up wrong passwords per session | 5 per 10 minutes, plus the same progressive lock per session |
| Step-up failed passwords per account | 20 per rolling 24 h |
| Tracked unknown usernames for lockout | bounded; least-recently-relevant evicted first; real accounts never evicted |
| Session lifetime | 7 days; renewed when more than half elapsed; an absolute maximum age as well (W-19) |
| Client clock-skew tolerance before discarding a session locally | 60 s |
| Passkey challenge lifetime | 60 s, single use |
| Pending passkey registrations | 16 (oldest dropped) |
| Transfer code lifetime | 60 s, single use, ≥ 256 bits of randomness |
| Pending transfer codes | 16 (oldest dropped) |
| Transfer-code exchange attempts | throttled per client; malformed codes also per entry class |
| Anonymous-endpoint requests | a small burst, then a slow steady rate; per client and per entry class |
| Signed-in API requests | per client and per entry class, generous enough for normal use |
| Static and page requests | per client and per entry class |
| Real-time connects | per client and per entry class |
| Open real-time connections | capped per client and per entry class |
| Requests in progress | capped per client and per entry class; the refusal carries a retry hint |
| Tracked rate-limit clients | bounded, least recently used evicted |
| Request body before authentication | small (tens of kilobytes) |
| Request body on self-authenticating gateways (access key, scoped cookie) | larger, read only after that gateway's own credential check |
| Request body after session verification | 50 MB |
| Uploads | image 5 MB; chat attachment 10 MB; audio 25 MB; project file upload 200 MB |
| Real-time message | 16 MiB (connection closed with the "message too big" close code) |
| Header receive deadline | short, counted from the request's first byte |
| Whole-request receive deadline | long enough for large uploads (does not limit streamed responses) |
| Pre-authentication body deadline | short → 408 and disconnect |
| Idle keep-alive, requests per connection, open connections | all bounded |
| Real-time heartbeat | ping every 30 s; no answer by the next beat → terminated |
| Slow consumer | more than 8 MiB unsent across two consecutive heartbeats → terminated |
| Security events kept | newest 500 per class |
| Sign-in event collapse window | 1 hour |
| Anonymous passkey-failure logging | at most one per client per minute |
| Remote host status cache | 60 s; probe timeout 12 s; at most 16 hosts |
| Access-proxy signing keys | cached; refetch for an unknown key at most once per minute; short fetch timeout; small clock tolerance |
| Removed push endpoints remembered after global sign-out | 30 days |

### 5.2 Setup status

- **Ask:** anyone, no credentials.
- **Get:** whether first-run setup is needed. Nothing else — no usernames, no counts.

### 5.3 Create the first account

- **Inputs:** username, password.
- **Preconditions:** no account exists (checked before the body is even examined); the request arrived directly from the host machine (loopback peer, not through any proxy entry).
- **Result:** account created atomically (two simultaneous attempts create one account); the caller is signed in; returns the user summary (id, username) and a session.
- **Errors:** account already exists (403); not local (403, with guidance); missing fields (400); too short (400); too long (400); username conflict (409).
- The password is stored only as a slow, salted one-way hash.

### 5.4 Password sign-in

- **Inputs:** username, password.
- **Order of checks:** per-client/entry throttle → lock for this entry class → count the attempt → compare. Parallel guesses cannot all slip through while a comparison runs: a sixth concurrent attempt is refused.
- **Result:** user summary and a session; last-sign-in time updated; "password sign-in" event recorded (collapsed per session).
- **Errors:** missing fields (400); invalid credentials (401, one wording); throttled (429); locked (429 with seconds to wait in body and `Retry-After`).
- **Scope rule:** an attempt counts for the private-network scope only when it provably arrived through the private-network proxy; everything else counts as public. A lock in one scope does not affect the other, nor step-up, nor existing sessions.
- A successful sign-in clears that scope's failures and lock level and forgives the client's own throttle count; it does not consume the entry-class total.

### 5.5 Passkey sign-in

- **Start:** anyone. Input: none (the request's `Origin` is used). Output: a challenge with "user verification required", no list of credentials (so it reveals nothing about accounts), a 60 s timeout, and an opaque challenge ticket to send back. The Service stores nothing at this point.
- **Finish:** inputs: the challenge ticket and the authenticator's assertion. Requirements: ticket genuine and unexpired; same entry class and same origin as the start; assertion signs exactly that challenge; challenge not presented before; credential known and registered for this hostname; user handle matches; signature valid; user verification performed; signature counter not moving backwards.
- **Result:** as password sign-in; credential's counter and last-used time updated; lock of this entry's scope lifted; event recorded.
- **Errors:** origin not a configured passkey address (403 with guidance); everything else one identical 401.

### 5.6 Passwordless private-network sign-in (optional feature)

- **Ask:** anyone; no body.
- **Granted only when all hold:** feature enabled (allow-list non-empty); the request came over loopback from the mesh-VPN proxy; not from that vendor's public-exposure mode; not through the public tunnel or its dedicated listener; the proxy-written forwarded address is exactly one private-network address; that device is in the device allow-list when one is set; the host name is a private-network name matching the pinned origin; the request is same-origin over HTTPS; the proxy-supplied identity is present and allow-listed (case-insensitive); and the identity maps to exactly one local account (explicit mapping required when several accounts exist).
- **Result:** user summary and a session marked as private-network-issued, recording identity and device.
- **Errors:** one identical 403 for every refusal; the reason goes only to the log, with a masked identity.
- **Fail-closed configuration:** an invalid device entry refuses every device (never "all devices"); a malformed or non-private pinned origin refuses everything.

### 5.7 Current user, renewal and sign-out

- **Current user:** with a valid session returns the user summary; otherwise 401.
- **Implicit renewal:** any authenticated request made after half the lifetime carries a replacement session in the response; the App adopts it only if it has the expected shape.
- **Explicit renewal:** returns a replacement session; a private-network-issued session stays private-network-issued.
- The App renews proactively at half-life and when the tab regains focus or visibility; a failed renewal due to network trouble does not sign out.
- **Sign-out:** invalidates the session on the Service, then acknowledges (SEC-105).
- **Session validity checks on every request and real-time connect:** authenticity and expiry; account still exists and is active; not issued before the last "sign out everywhere"; for private-network-issued sessions, identity and device still allow-listed **and** the request arrived through the private-network entry.

### 5.8 Security overview

- **Ask:** signed-in user.
- **Get:** the addresses where passkeys can be used; the user's passkeys (id, hostname, device label, created, last used — never key material); up to 30 recent events, 10 important events, 10 sign-ins; lock state for public, private-network and this session's step-up scope (locked?, until when).
- Event fields: id, time, kind, entry class, masked client, short detail, repeat count.

### 5.9 Passkey registration and removal

- **Start registration:** inputs: password. Checks the origin first (so a wrong address never costs a password attempt), then step-up. Output: creation options preferring an on-device authenticator, requiring a discoverable credential and user verification, excluding credentials already registered for this hostname, 60 s timeout.
- **Finish registration:** input: the authenticator's response (and the browser's user-agent for a device label). Errors: expired or missing challenge (400); invalid or unverified response (400); credential already registered (409); origin not allowed (403).
- **Remove:** inputs: passkey id, password. Errors: unknown id or another account's (404); wrong password (403); throttled (429).
- Each success records an event with hostname and device label.

### 5.10 Step-up password check (shared by several capabilities)

- **Errors:** missing or over-long password (400); wrong password (403); session budget exhausted or session step-up locked (429 with wait time and the advice that signing out everywhere clears it); daily account cap reached (429 with hours to wait and the same advice).
- Only attempts that actually compared a password count toward the daily cap; requests refused by a throttle or lock do not.
- A new sign-in gives a new session budget but never resets other sessions' locks or the daily cap; moving entry points keeps the same session identity (so it cannot be used to mint fresh budgets).

### 5.11 Sign out everywhere

- **Ask:** signed-in user; no password.
- **Effects:** every session issued so far is refused from now on (HTTP and real-time, the caller's included); the user's live real-time connections are terminated without waiting for the client; all active access keys become inactive; scoped gateway accesses are dropped; all push subscriptions are deleted (endpoints remembered 30 days so the same device can silently re-register after signing in); pending transfer codes are discarded; all step-up locks and the daily cap are cleared.
- **Get:** counts of what was revoked (connections, access keys, gateway accesses, push subscriptions, transfer codes).
- Events: "signed out everywhere" with a summary; "access keys disabled" when any were.

### 5.12 Entry switch

- **Issue (signed-in):** inputs: target entry (public or private-network), optional password. Output: one-time code, target, target origin, expiry time.
  - Errors: unknown target (400); target not configured (409); password required — passwordless session moving to public (403); wrong password (401); throttled (429).
  - Rule: the moved session is never broader than its source. Password session → same kind on either entry. Private-network-issued session → keeps that marking when moving within the private network; needs the password to become an ordinary session on the public entry.
- **Redeem (no credentials):** input: the code; the request's `Origin` must equal the code's target origin.
  - Output: user summary, session, target.
  - The code is consumed by the first attempt whatever the outcome. Refused when: unknown/expired/used; origin mismatch; target entry reconfigured since issue; account gone; carried private-network marking no longer allow-listed. All refusals are one identical 400; throttle is 429.
  - Well-formed but wrong codes count only against the caller, so a crowd cannot block the owner's switch on a whole entry class.

### 5.13 Access keys

- **List:** id, name, masked value (a short prefix followed by an ellipsis), created, last used, active flag.
- **Create:** inputs: name (required), password (step-up). Output: the full key **once**. Keys are long random strings with a recognisable prefix.
- **Disable:** no password. **Re-enable:** password. **Delete:** permanent.
- **Errors:** name missing (400); password missing (400); wrong password (403); throttled (429); unknown or another account's key (404); non-boolean state (400).
- **Use:** presented in a request header on the automation interface; valid only while active and the account is active; each use updates "last used". Missing → 401; invalid or inactive → 401.

### 5.14 Stored source-host tokens

- **List (optionally by kind):** id, name, kind, description, created, active flag — never the value.
- **Create:** name, kind, value (all required), optional description. **Toggle**, **Delete**.
- **Errors:** missing fields (400); unknown id (404).
- The automation interface may also accept a token supplied per request instead of a stored one.
- Creating or re-enabling a stored token requires step-up, like access keys; token values are encrypted at rest (W-07).

### 5.15 Provider keys

- **Status:** configured?; source (saved in the app / provided by server file / none); for high-value keys also whether storing is enabled on this server.
- **Save / replace:** input: key (and password for high-value keys). Validation: trimmed; length bounds (12–256 characters for the simple kind, 20–512 for the high-value kind); no whitespace; for the high-value kind, must look like a standard API key and must not be a subscription sign-in token or an organisation admin key.
- **Verify:** one free, read-only call to the provider with a 12 s limit; the provider's answer body is not passed on. Errors: nothing saved (400); rejected by provider (502 with a specific code); unreachable (502).
- **Remove:** always allowed.
- **Never returned:** the key, any part of it, or any derivative. Server log lines say only "saved / replaced / removed" and the account id.
- A record that cannot be decrypted (store key changed, record damaged) yields "cannot be read any more — save it again" rather than a crash.

### 5.16 Network information and guide

- **Info (signed-in):** per entry: id, label, origin or none, configured?, default?; which entry served this request (by host name) or "local"; session kind (password or private-network-issued); warnings (plain); details (technical). Never contains secrets.
- **Guide (signed-in):** the setup guide as text; 404 with a clear message when the guide is not installed.

### 5.17 Remote hosts

- **List (signed-in):** name, label, target — as configured by the Operator.
- **Status (signed-in):** name, online?, latency, checked time, tools found (each agent CLI, terminal multiplexer), optional short error. Unknown name → 404 before any connection attempt. Concurrent checks of one host share one connection; results cached 60 s.
  - Failure wording categories: no SSH client on the host machine; timed out; authentication failed (key not accepted); host key verification failed; host name not resolvable; connection refused; network unreachable; otherwise one cleaned, length-limited line.
  - The probe never prompts and never accepts unknown host keys interactively.
- **Launch (signed-in, per project):** input: which program (agent CLI A, agent CLI B, shell). The Service builds the terminal command from the project's stored, validated host and directory; the client cannot supply host, directory or command at launch time. Output: what to run in the local terminal and a title.
  - Errors: project has no remote host (400); host no longer configured (409); invalid directory or program (400); remote sessions unavailable (503).
- **Configuration validation:** host name — lowercase letters, digits, hyphens, ≤ 32 characters; label ≤ 40 characters without control characters; target — an SSH alias or user@host from a strict character set that can never start an option; directory — home-relative or absolute, restricted character set, no parent-directory segments, ≤ 300 characters. Invalid entries are skipped with a log line; the Service still starts.

### 5.18 Runtime status and health

- **Runtime (signed-in):** the fields shown in 4.11. Upstream check: only a recognised public source host is contacted, without credentials, 4 s limit, cached 60 s; failure is reported as text, not as an error.
- **Health (public):** status "ok" and the current time — nothing else; in particular no version and no install kind (W-13). Readable cross-origin.

### 5.19 Preferences, onboarding and commit identity

- **Preferences get:** all stored preferences for the account.
- **Preferences merge:** only the keys sent are changed (two settings screens can save concurrently); keys 1–200 characters; body must be an object; the account's other open pages are told which keys changed.
- **Onboarding status / complete.**
- **Commit identity get / set:** name and e-mail required, e-mail validated; stored per account and applied to the host's global configuration (failure to apply is logged, not fatal).

### 5.20 Real-time connections

- **Connect:** requires a valid session presented at connection time. Order of checks: connection caps and connect rate (429 with `Retry-After`) → access-proxy assertion when enabled (403) → session (401).
- **During:** messages over 16 MiB close the connection; unresponsive or badly backlogged connections are terminated and may reconnect.
- **After revocation:** terminated abruptly (the client sees an abnormal close).
- **Client behaviour:** reconnect about 3 s after any close while a session exists; reconnect with the new credential after renewal; announce "reconnected" so features can catch up; do not attempt to connect with a locally expired credential — treat as session expiry instead.
- The Service also closes a connection when the session that opened it expires or is individually signed out (SEC-036).

### 5.21 Access-proxy verification (optional)

- **When enabled:** every request that arrived through the public entry (page, static file, API, real-time connect) must carry the access proxy's signed assertion — correct algorithm family, signature by one of the proxy's published keys, expected issuer, an expected audience, an expiry in the future. Otherwise 403 with a message to pass the access proxy first.
- **Exempt:** only read requests for the health answer, the web-app manifest and icon image files.
- **Not affected:** private-network and local requests.
- **Half-configured or malformed settings:** every public request is refused (fail closed) and Settings explains which part is wrong.
- **Key fetching:** cached; an unknown key identifier triggers at most one refetch per minute (forged identifiers cannot make the Service hammer the proxy); when a refetch fails, keys already known keep working; with no keys at all, requests are refused.
- Refusals are logged with reason and path only — never the query string or the assertion.

### 5.22 Static files and the App shell

- Served without credentials: the built client files, bundled public files (manifest, icons, service worker, logos, public interface documentation page, screenshots) and the shell page.
- Fingerprinted client files: compressed (brotli preferred, gzip otherwise), cacheable for a year as immutable, with validators and `Vary` on encoding. The shell page: compressed, must be revalidated on every load.
- Path traversal (dot segments, encoded separators) is refused; nothing outside the built client and public directories is reachable.

### 5.23 Operator tools

- **Command line:** start (default); status (version, install location, data-store location with existence, size and modified time, effective port and overrides, agent data folder presence, configuration file presence, hints); version; help; an update command that only explains how to update. Options: port, data-store location. Unknown command → non-zero exit and a pointer to help. (Two further commands — a container-sandbox launcher and a browser-automation bridge — belong to other domains.)
- **Lock-clearing tool:** no arguments clears every lock and failure count in every scope and the daily step-up counts; a username argument clears only that name. Works with the Service stopped; takes effect immediately when running; records "lock lifted by local command". The short-window per-client throttle need not be cleared; it expires by itself at the end of its window.
- **Startup:** loads configuration from a file beside the application without overriding variables already set in the environment; prints the address to open; refuses to start when a development-only authentication relaxation (SEC-084) is combined with any non-loopback listening address or any remote-entry setting; does not serve the public entry when its dedicated listener cannot be used (for example its port is unusable or equals the main port), rather than classifying requests by headers (W-14).
- **Shutdown (terminate/interrupt signals):** stops watching for agent-session changes, stops dispatching scheduled messages, closes automated browser sessions, stops plugin processes, clears the indicator that tells companion tools a local instance is running, then exits. Open requests and real-time connections are drained first, within a bounded time. On the next start, runs left unfinished are marked interrupted and announced once per conversation; nothing is re-run automatically; scheduled messages that came due while stopped are sent.

---

## 6. Black-box acceptance tests

Notation: "public client" = a client reaching the Service through the public entry; "private client" = through the private-network entry; "local client" = directly on the host. Each test names the features it verifies. Tests use the defaults of 5.1 unless the implementation documents others. A virtual authenticator may stand in for a real passkey device.

Harness assumptions: the test environment can (a) present requests as each entry class the way a real deployment would (separate listeners or the documented proxy set-up), (b) advance the Service's clock, and (c) raise an individual limit when a test needs many attempts to reach the behaviour under test (for example, raising the short-window throttle to exercise lock records). Where a test says "simulated", it relies on (b) or (c); the property in **Then** is what must hold.

### 6.1 First run and unauthenticated surface

**AT-SEC-001** (SEC-001, 014)
Given a fresh installation with no account,
When an unauthenticated client asks for setup status,
Then the answer says setup is needed and contains no other data.

**AT-SEC-002** (SEC-001, 003)
Given a fresh installation,
When a local client creates the account with a valid username and password,
Then the account exists, the client is signed in, and setup status now says setup is not needed.

**AT-SEC-003** (SEC-002)
Given a fresh installation reachable through a public and a private-network entry,
When a public client, and then a private client, try to create the account with valid input,
Then both are refused with a "must be done on the host machine" explanation and no account exists.

**AT-SEC-004** (SEC-002)
Given a fresh installation listening on a LAN address,
When a client on another LAN machine tries to create the account,
Then it is refused and no account exists.

**AT-SEC-005** (SEC-001, 027)
Given an account exists,
When any client (including a local one) tries to create an account with any body, including a malformed one,
Then the answer is a refusal that reveals nothing about the existing account, and no second account exists.

**AT-SEC-006** (SEC-001)
Given a fresh installation,
When two local clients submit account creation at the same instant,
Then exactly one account exists afterwards and at most one request succeeds.

**AT-SEC-007** (SEC-003, 104)
Given a fresh installation,
When account creation is attempted with (a) an empty field, (b) a 2-character username, (c) a password shorter than the minimum, (d) a 129-character username, (e) a 1025-character password, (f) non-string values,
Then each is refused with a validation error and no account is created.

**AT-SEC-008** (SEC-014)
Given an account exists,
When an unauthenticated client calls every documented capability of the Service without credentials, once as a public client and once as a local client,
Then every answer except setup status, health, the sign-in capabilities and static files is an authentication refusal whose body contains only an error — no user data, no file names, no project names.

**AT-SEC-009** (SEC-014, 037)
Given the anonymous capabilities,
When each is called with different letter case, a trailing slash and doubled slashes,
Then none returns data that the canonical form would not, and each still counts against the anonymous rate budget.

**AT-SEC-010** (SEC-014, 048)
When an unauthenticated client requests paths that try to escape the public file roots (dot segments, percent-encoded separators, absolute paths, the configuration file, the data store, source files),
Then each is refused or answered with the App shell, and no file content outside the built client and public files is returned.

**AT-SEC-011** (SEC-045)
When a client requests an unknown address under the API namespace,
Then the answer is a JSON "not found" error, not the App shell.

### 6.2 Password sign-in, throttling and lockout

**AT-SEC-012** (SEC-004)
Given an account,
When a client signs in with the correct username and password,
Then it receives a session with which "current user" returns that username, and the response is marked non-cacheable.

**AT-SEC-013** (SEC-005)
Given an account,
When a client signs in with (a) the right username and a wrong password and (b) a non-existent username,
Then both refusals have the same status, the same code and the same message.

**AT-SEC-014** (SEC-005)
Given an account,
When 50 sign-ins with a wrong password for the real username and 50 for a made-up username are timed (staying under throttles by using distinct clients where needed),
Then the two response-time distributions are statistically indistinguishable.

**AT-SEC-015** (SEC-006)
Given a public client,
When it submits 5 wrong passwords within 10 minutes and then the correct password,
Then the sixth request is refused as throttled, and the correct password is accepted from a different client in a different lockout scope (for example the private-network entry).

**AT-SEC-016** (SEC-006)
Given 6 parallel wrong-password requests from one client,
Then at most 5 are evaluated as "invalid credentials" and at least one is refused as throttled or locked.

**AT-SEC-017** (SEC-007)
Given 5 different public clients,
When each submits one wrong password for the same username in a row,
Then the next public sign-in attempt for that username — even with the correct password — is refused as locked, with a wait of about 15 minutes in both the body and `Retry-After`.

**AT-SEC-018** (SEC-007, 008)
Given password sign-in is locked on the public scope,
When a private client signs in with the correct password,
Then it succeeds; and an existing public session of the same account keeps working.

**AT-SEC-019** (SEC-007)
Given a public lock that has just expired,
When five more wrong passwords follow,
Then the new lock lasts about 30 minutes; repeating yields about 1 h, 2 h … never more than 24 h.

**AT-SEC-020** (SEC-007)
Given a lock level above the first,
When a correct password sign-in succeeds in that scope after the lock expires,
Then five later failures lock for 15 minutes again.

**AT-SEC-021** (SEC-007)
Given an active lock,
When the Service is restarted,
Then the lock is still in force with the same expiry.

**AT-SEC-022** (SEC-005, 007)
Given a made-up username,
When five wrong passwords are submitted for it on the public scope,
Then attempts for that name are answered "locked" exactly as for a real account (same status, code, wording and wait format).

**AT-SEC-023** (SEC-005, 007)
Given a locked real username on the public scope,
When more sign-in attempts with distinct made-up usernames than the lock records can track reach the lock stage (simulated: short-window throttle raised),
Then the real username is still locked with its level unchanged, and a made-up username that was locked before the flood is still locked.

**AT-SEC-024** (SEC-006)
Given the public entry class has used up its class-wide wrong-password budget, from many clients within one window,
When a new public client submits a password,
Then it is throttled; and a private client is not.

**AT-SEC-025** (SEC-006)
Given a client with 4 wrong passwords,
When it signs in correctly and then submits 4 more wrong passwords,
Then none of those 4 is refused as throttled (its own count was cleared by the success).

**AT-SEC-026** (SEC-004)
When sign-in is called with missing fields, non-string values or a body over the anonymous size limit,
Then it is refused with a validation or "too large" error and no failure is counted against any account.

**AT-SEC-027** (SEC-104)
When sign-in is called with a password longer than the maximum,
Then it is refused as invalid input, and no part of it is compared.

### 6.3 Sessions

**AT-SEC-028** (SEC-009)
Given a session older than half its lifetime (simulated clock),
When any authenticated request is made,
Then the response carries a replacement session that is valid and has a fresh full lifetime.

**AT-SEC-029** (SEC-009, 012)
Given a session past its lifetime,
When it is used,
Then the request is refused as unauthenticated with a marker that it expired (distinct from "invalid").

**AT-SEC-030** (SEC-009)
Given a tampered session credential (altered payload, altered signature, a different signing algorithm, or signed with another key),
When it is used on HTTP and on a real-time connect,
Then both refuse it.

**AT-SEC-031** (SEC-047)
Given a valid session,
When it is supplied in the URL of an API request, a real-time connect or a download instead of the proper place,
Then the request is refused as unauthenticated.

**AT-SEC-032** (SEC-105)
Given a signed-in client,
When it signs out and the same credential is replayed afterwards,
Then the replay is refused.

**AT-SEC-033** (SEC-011)
Given two devices signed in as the same account,
When device A performs "sign out everywhere",
Then the credentials of both A and B are refused on the next request, and the answer to A lists what was revoked.

**AT-SEC-034** (SEC-011, 009)
Given "sign out everywhere" has run,
When an old credential that was renewed just before it is used,
Then it is refused; and a session obtained by signing in afterwards works.

**AT-SEC-035** (SEC-012)
Given the App holds a stored session and the Service answers the start-up check with a 502, 503, 429 or 500,
Then the App keeps the stored session and shows a "could not check sign-in status" state instead of the sign-in form with a cleared session.

**AT-SEC-036** (SEC-012)
Given the App is open on a screen with unsent text,
When an authenticated request is refused as expired,
Then the sign-in screen appears with a "session expired" message, and after signing in again the unsent text (already synced) is restored (inferred behaviour; confirm with domain 1).

**AT-SEC-037** (SEC-028)
Given the account's session,
When "current user" is read,
Then the answer contains no password hash, no session internals and no secrets.

### 6.4 Passkeys

**AT-SEC-038** (SEC-020)
When passkey sign-in is started from a configured address,
Then the challenge requires user verification, lists no credentials, and is identical in shape whether or not any passkey exists.

**AT-SEC-039** (SEC-016)
Given a registered passkey for the current hostname,
When a valid assertion with user verification is submitted with its challenge ticket,
Then a session is issued and the passkey's "last used" changes.

**AT-SEC-040** (SEC-020)
Given a completed passkey sign-in,
When the same ticket and assertion are submitted again,
Then it is refused with the generic passkey failure.

**AT-SEC-041** (SEC-020)
Given a challenge older than 60 s,
When a correct assertion for it is submitted,
Then it is refused with the generic failure.

**AT-SEC-042** (SEC-020)
Given a challenge ticket with any byte altered, or a ticket from another Service instance,
When submitted with a matching assertion,
Then it is refused with the generic failure.

**AT-SEC-043** (SEC-019, 020)
Given a challenge started on the private-network entry,
When its assertion is submitted through the public entry (or with a different `Origin`),
Then it is refused.

**AT-SEC-044** (SEC-019)
Given a passkey registered for hostname A,
When it is used to answer a challenge for hostname B,
Then it is refused with the generic failure.

**AT-SEC-045** (SEC-016)
When an assertion is submitted (a) without user verification, (b) with a signature counter lower than the stored one, (c) from an unregistered credential, (d) with another account's user handle,
Then all four receive the identical refusal.

**AT-SEC-046** (SEC-020)
Given 100 000 passkey-start requests from many clients,
When the owner then starts and finishes a passkey sign-in,
Then it succeeds (no challenge was evicted or blocked) and the Service's memory use has not grown in proportion.

**AT-SEC-047** (SEC-019)
When passkey sign-in is started from an address that is not a configured entry (or whose host is an IP address),
Then it is refused with guidance to use a configured address.

**AT-SEC-048** (SEC-021)
Given password sign-in is locked on the public scope,
When a passkey sign-in succeeds there,
Then password sign-in with the correct password now succeeds, and a "lock lifted by passkey sign-in" event exists.

**AT-SEC-049** (SEC-017, 022)
Given a signed-in session,
When passkey registration is started without a password or with a wrong password,
Then no challenge is issued, and the wrong attempt is counted against the session's step-up budget.

**AT-SEC-050** (SEC-017)
Given a signed-in session on a non-configured address,
When passkey registration is started with a wrong password,
Then the refusal is "address not allowed" and no step-up attempt was counted.

**AT-SEC-051** (SEC-017)
Given registration options were issued,
When the registration is finished after 60 s, or finished twice, or with a response made for a different challenge,
Then each is refused and no passkey is stored.

**AT-SEC-052** (SEC-017)
Given a passkey is already registered,
When the same credential is registered again,
Then it is refused as a duplicate.

**AT-SEC-053** (SEC-018, 022)
Given a registered passkey,
When removal is requested without password, with a wrong password, with an unknown id, or with an id of malformed shape,
Then it is refused (validation / forbidden / not found) and the passkey still works.

**AT-SEC-054** (SEC-018)
Given a removed passkey,
When it is used to sign in,
Then it is refused with the generic failure.

**AT-SEC-055** (SEC-016, 026)
Given 30 malformed passkey assertions from one client within a minute,
Then at most one "passkey sign-in failed" event and one log line are recorded for that client in that minute.

### 6.5 Step-up, locks and audit

**AT-SEC-056** (SEC-023)
Given two sessions A and B of the same account,
When A submits 5 wrong step-up passwords,
Then A's next step-up is refused as throttled/locked even with the correct password, while B's step-up with the correct password succeeds.

**AT-SEC-057** (SEC-023)
Given session A's step-up is locked,
When the account signs in again elsewhere (creating session C),
Then A is still locked and C is not.

**AT-SEC-058** (SEC-024)
Given a client that repeatedly creates fresh sessions (by signing in or switching entries) and submits wrong step-up passwords,
When 20 wrong step-up passwords have been compared within 24 h across all sessions,
Then every further step-up for that account is refused with a "daily limit" explanation, even from a new session and even with the correct password.

**AT-SEC-059** (SEC-024)
Given the daily cap is reached,
When "sign out everywhere" succeeds and the account signs in again,
Then step-up with the correct password works.

**AT-SEC-060** (SEC-023, 007)
Given the public sign-in scope is locked,
When a signed-in session performs step-up with the correct password,
Then it succeeds.

**AT-SEC-061** (SEC-024)
Given a session whose step-up is locked,
When 100 further step-up requests are sent while locked,
Then the daily count does not increase (only compared passwords count).

**AT-SEC-062** (SEC-025)
Given a locked public scope,
When the security overview is read,
Then it shows that scope as locked with an end time, the private-network scope as normal, and the session scope as normal.

**AT-SEC-063** (SEC-026)
Given 5 000 failed sign-ins followed by one passkey addition and one successful sign-in, then 5 000 more failed sign-ins,
When the overview is read,
Then the passkey addition is still in the important list and the successful sign-in is still in the sign-ins list.

**AT-SEC-064** (SEC-026)
When events are read,
Then no event contains a full client address (only a masked form), a password, a session credential, a full private-network identity or control characters.

**AT-SEC-065** (SEC-026)
Given one session that renews and switches entries 50 times within an hour,
When the sign-ins list is read,
Then that session occupies one row with a repeat count, and other sessions' sign-ins are still listed.

**AT-SEC-066** (SEC-076)
Given a locked scope,
When the Operator runs the local lock-clearing tool on the host,
Then sign-in with the correct password works immediately without restarting, and a "lifted by local command" event is listed.

### 6.6 Access keys and tokens

**AT-SEC-067** (SEC-029)
When an access key is created with a name and the correct password,
Then the full key is returned exactly once, and every later listing shows only a masked form from which the key cannot be reconstructed.

**AT-SEC-068** (SEC-029, 022)
When access-key creation is attempted without a password or with a wrong password,
Then no key is created.

**AT-SEC-069** (SEC-030)
Given an active access key,
When the automation interface is called with it, without it, with a truncated copy, and with the masked form from the listing,
Then only the first is accepted.

**AT-SEC-070** (SEC-029)
Given an access key that has been disabled,
When it is used,
Then it is refused; re-enabling without a password is refused; re-enabling with the password makes it work again.

**AT-SEC-071** (SEC-011, 029)
Given an active access key,
When "sign out everywhere" runs,
Then the key is refused afterwards and is listed as inactive.

**AT-SEC-072** (SEC-028)
Given two accounts exist (multi-user build) or a forged identifier of a non-existent key,
When one session tries to toggle or delete a key id that is not its own,
Then the answer is "not found" and nothing changes.

**AT-SEC-073** (SEC-031)
Given a stored source-host token,
When tokens are listed, and when every other capability's answers are searched,
Then the token value never appears.

**AT-SEC-074** (SEC-030)
Given an access key,
When it is used against the interactive (session-only) capabilities — security overview, passkey management, access-key management, provider keys, entry switch —
Then every one refuses it.

### 6.7 Real-time connections

**AT-SEC-075** (SEC-033)
When a client opens each real-time channel without a credential, with an expired one, with a revoked one and with a tampered one,
Then every connect is refused as unauthenticated and no data frame is received.

**AT-SEC-076** (SEC-035)
Given an open terminal channel and an open chat channel,
When "sign out everywhere" runs from another device,
Then both connections are closed by the Service within one second and reconnect attempts with the old credential are refused.

**AT-SEC-077** (SEC-036)
Given an open real-time connection,
When the session that opened it reaches its expiry (simulated clock) without renewal, or is individually signed out,
Then the Service closes the connection.

**AT-SEC-078** (SEC-034)
When one client opens real-time connections beyond the per-client cap,
Then the connect over the cap is refused with "too many" and a retry hint, and closing one connection makes room for a new one.

**AT-SEC-079** (SEC-034)
When one client attempts connects faster than the connect budget,
Then the excess are refused with "too many" before any credential check, including when the credential is valid.

**AT-SEC-080** (SEC-034)
When a client sends a single message larger than 16 MiB,
Then the connection is closed with the "message too big" close code and the Service stays healthy.

**AT-SEC-081** (SEC-034)
Given a connected client that stops answering heartbeats,
Then the Service terminates the connection within two heartbeat intervals.

**AT-SEC-082** (SEC-034)
Given a client that reads so slowly that more than 8 MiB stays unsent across two heartbeats during a long stream,
Then the Service terminates it, and a single momentary burst does not.

**AT-SEC-083** (SEC-047, 081)
When a real-time connect carrying a credential is made,
Then no operator log line contains the credential.

### 6.8 Perimeter

**AT-SEC-084** (SEC-037)
Given a public client,
When it calls an anonymous capability more than the burst allows,
Then further calls are refused with "too many" and a `Retry-After`, while a signed-in page load from another public client still succeeds.

**AT-SEC-085** (SEC-037)
Given a flood from thousands of public clients that exhausts the public anonymous budget,
When a private client signs in,
Then it succeeds.

**AT-SEC-086** (SEC-038)
Given a client holding the maximum requests in progress (slow uploads),
When it starts one more,
Then that one is refused with a retry hint, and finishing one frees a slot.

**AT-SEC-087** (SEC-039)
When an unauthenticated client sends a 1 MB body to sign-in,
Then it is refused as too large without being processed.

**AT-SEC-088** (SEC-039)
When an unauthenticated client sends a 40 MB body to a session-protected capability,
Then it is refused as unauthenticated and the Service did not read the body (measured by time and bytes accepted).

**AT-SEC-089** (SEC-039, 045)
When a client sends malformed JSON,
Then the answer is a short 400 error with no stack trace, and the operator log gains no stack trace.

**AT-SEC-090** (SEC-040)
When a client sends request headers one byte per second,
Then the connection is closed at the header deadline; an idle keep-alive connection is not closed by that rule.

**AT-SEC-091** (SEC-040)
When a client declares a body to sign-in and trickles it,
Then it receives a 408 at the pre-authentication body deadline and the connection is closed.

**AT-SEC-092** (SEC-041)
When uploads exceed their per-kind limits (image > 5 MB, attachment > 10 MB, audio > 25 MB, project file > 200 MB),
Then each is refused as too large and nothing is stored.

**AT-SEC-093** (SEC-042)
Given a page on another origin in a browser where the owner is signed in to the Service,
When that page tries to read any API answer (including setup status) or to send a JSON write (pre-flighted),
Then the browser blocks it: the Service's answers carry no cross-origin permission. Only the health answer is readable.

**AT-SEC-094** (SEC-042) (applies when cookie sessions are used)
Given a signed-in browser,
When a page on another origin submits a form or simple request to a state-changing capability,
Then it is refused (origin check and/or anti-forgery token) and no state changes.

**AT-SEC-095** (SEC-043)
When any page, API answer or the health answer is fetched,
Then it carries a directive forbidding framing by other origins.

**AT-SEC-096** (SEC-049)
When the App shell is fetched over HTTPS,
Then the response carries a content security policy that forbids inline script and foreign script origins, a transport-security header, a no-sniff header and a restrictive referrer policy.

**AT-SEC-097** (SEC-044)
Given a public entry with its dedicated tunnel listener,
When a private client sends requests with forged edge headers claiming to be a public visitor,
Then it is still counted and treated as that private device; and a request arriving on the tunnel listener is treated as public even with no edge headers.

**AT-SEC-098** (SEC-044)
Given a public client rotating its source address within one IPv6 /64,
When it submits wrong passwords,
Then it is throttled as one client.

**AT-SEC-099** (SEC-044)
Given a direct (non-proxied) client that sets a forwarded-for header to an arbitrary value,
Then the Service ignores it and counts the client by its connection address.

**AT-SEC-100** (SEC-044)
Given requests whose edge-supplied client address is garbage or missing,
Then they share one "unknown" client budget rather than each creating a new budget.

**AT-SEC-101** (SEC-081)
Given rate-limit refusals for one client over 10 minutes,
Then the operator log holds at most one warning per client and kind per minute, naming the entry class but no address.

### 6.9 Secrets and isolation

**AT-SEC-102** (SEC-050, 056)
Given a provider key has been saved,
When every capability's answers, the security events, the operator log, the browser's storage and the page address are searched for the key or any 8-character substring of it,
Then nothing is found.

**AT-SEC-103** (SEC-050)
When a provider key is saved that is too short, too long or contains whitespace,
Then it is refused, and the refusal text does not contain the submitted value.

**AT-SEC-104** (SEC-053)
When a subscription sign-in token or an organisation admin key is submitted as a high-value provider key,
Then it is refused with a message identifying the kind of mistake, without echoing the value.

**AT-SEC-105** (SEC-052)
Given the Operator has not enabled high-value key storage,
When a save or verify is attempted,
Then it is refused as disabled; status reports "not enabled"; and removing a previously saved key still works.

**AT-SEC-106** (SEC-050, 022)
When a high-value key is saved without the account password or with a wrong one,
Then nothing is stored.

**AT-SEC-107** (SEC-051)
Given a saved key,
When the data store alone (without the secret store's installation key) is inspected,
Then the key cannot be recovered; and when the stored record is copied to another account's slot (multi-user build), it does not decrypt.

**AT-SEC-108** (SEC-051)
Given a saved key,
When the installation key is replaced,
Then status/verify report "cannot be read — save again" and the Service does not crash.

**AT-SEC-109** (SEC-061)
Given a fresh installation on a POSIX system,
Then the data store, its directory, the secret store directory and its key file are accessible by the owning user only; if the data store is found group/world readable at start, it is tightened.

**AT-SEC-110** (SEC-059)
Given the Service is configured with entry origins, a signing secret, a data-store location, a port, feature switches and key-file paths,
When the user runs an environment listing in (a) the built-in terminal and (b) an agent session's shell tool,
Then none of the Service's own settings appear, while the search path, home directory, proxy settings and the agent CLIs' own variables are present.

**AT-SEC-111** (SEC-059)
Given the built-in terminal,
When the user starts a second copy of the Service there with defaults,
Then it does not bind the production port and does not open the production data store.

**AT-SEC-112** (SEC-055)
Given a saved channel password,
When the channel settings are read,
Then the answer contains a "saved" flag (and at most a 4-character hint for an account identifier) but not the password; saving the form again with the secret field blank keeps the secret.

**AT-SEC-113** (SEC-056)
Given a channel test fails with an upstream error that echoes the credential,
Then the message shown and logged has the credential replaced by a mask.

**AT-SEC-114** (SEC-057, 079)
Given an agent CLI is not installed on the host,
When its status is read,
Then it reports "not installed" with a clear message, the other agents' statuses are unaffected, and the rest of the App works.

### 6.10 Entry points and remote access

**AT-SEC-115** (SEC-062)
Given default configuration,
When another machine on the LAN connects to the Service's port,
Then the connection is refused (not listening).

**AT-SEC-116** (SEC-072)
When the health answer is requested without credentials through each entry,
Then it answers "ok" and contains no user data.

**AT-SEC-117** (SEC-065)
Given access-proxy verification is enabled,
When a public client requests the shell page, an API capability and a real-time connect without an assertion, with an expired assertion, with a wrong audience, with a wrong issuer, with a symmetric-algorithm token "signed" with a public key, and with an unknown key id,
Then each is refused (403) before any route runs; with a valid assertion each proceeds to the normal session checks.

**AT-SEC-118** (SEC-065)
Given verification is enabled,
When a public client reads the health answer, the manifest and an icon without an assertion,
Then they are served; a write to those addresses, or a similarly named non-image path, is refused.

**AT-SEC-119** (SEC-065)
Given only one of the two verification settings is present, or one is malformed,
Then every public request is refused, private and local requests work, and the network page explains the problem.

**AT-SEC-120** (SEC-065)
Given verification is enabled and the proxy's key endpoint is unreachable,
Then assertions signed by already-known keys are accepted; 1 000 requests with random key ids cause at most one key fetch per minute.

**AT-SEC-121** (SEC-066)
Given passwordless sign-in is enabled for identity X,
When a request for a passwordless session arrives (a) from a non-loopback peer with forged proxy headers, (b) through the public tunnel with forged identity headers, (c) through the mesh vendor's public-exposure mode, (d) with a forwarded-for list of two addresses, (e) with a non-private host name, (f) with an `Origin` of another site or plain HTTP, (g) with no identity, (h) with identity Y,
Then all eight receive the identical refusal and no session.

**AT-SEC-122** (SEC-066)
Given a device allow-list containing one invalid entry,
Then every passwordless sign-in is refused, including from otherwise valid devices.

**AT-SEC-123** (SEC-067)
Given a private-network-issued session,
When its credential is presented through the public entry or directly on the host (HTTP, real-time connect, and renewal),
Then every use is refused as unauthenticated.

**AT-SEC-124** (SEC-067)
Given a private-network-issued session,
When the Operator removes the identity (or the device) from the allow-list and restarts,
Then the session and any credential renewed from it are refused; password sessions are unaffected.

**AT-SEC-125** (SEC-068)
Given a password session on the private-network entry,
When a transfer code for the public entry is issued and redeemed by a page on the public origin within 60 s,
Then a working session is returned there.

**AT-SEC-126** (SEC-068)
Given a transfer code,
When it is redeemed (a) twice, (b) after 60 s, (c) with a different `Origin` than its target, (d) after the target entry's origin was reconfigured, (e) after "sign out everywhere",
Then every case is refused with the same error; in (c) a following correct redemption is also refused (the code was consumed).

**AT-SEC-127** (SEC-068)
Given a private-network-issued session,
When it requests a transfer code for the public entry without a password, then with a wrong password, then with the correct one,
Then: refused (password required); refused (wrong password, counted in the session's step-up budget); issued — and the redeemed session is an ordinary one that works on both entries.

**AT-SEC-128** (SEC-068)
Given a private-network-issued session,
When it moves within the private-network entry and the identity is then removed from the allow-list,
Then the moved session is refused too.

**AT-SEC-129** (SEC-068)
When an unauthenticated public client submits 1 000 random well-formed codes and 1 000 malformed ones,
Then it is throttled; a private client's legitimate redemption still succeeds; and other public clients' legitimate redemptions succeed despite the well-formed flood.

**AT-SEC-130** (SEC-068)
Given the App receives a transfer code in its address,
Then the code is no longer visible in the address bar or history entry after load, and reloading the page does not replay it.

**AT-SEC-131** (SEC-068)
When a transfer code is requested for an unknown or unconfigured target,
Then it is refused and no code is created.

**AT-SEC-132** (SEC-071)
Given an entry origin configured with a path, a trailing comment, quotes or a non-HTTP scheme,
Then the Service still starts, that entry is reported as invalid on the network page, switching to it is impossible, and passwordless sign-in is refused.

**AT-SEC-133** (SEC-077, 084)
Given a development-only authentication relaxation is requested together with a non-loopback listening address, a remote entry origin, a tunnel listener, a passwordless allow-list or access-proxy settings,
Then the Service refuses to start and prints why.

**AT-SEC-134** (SEC-073)
Given the client files on disk are replaced by a newer build while the Service keeps running,
When runtime status is read,
Then "deployed client" shows the new build and "running backend" still shows the build that was loaded at start.

**AT-SEC-135** (SEC-074)
Given a page left open while a newer client is deployed,
When the page returns from the background untouched with nothing open and nothing typed,
Then it reloads to the new build by itself within about 10 s; when a field holds text or a sheet is open, it shows the update toast instead and does not reload.

**AT-SEC-136** (SEC-074)
Given an intermediary keeps serving the old shell page,
Then the page does not reload in a loop: after one automatic attempt it offers the refresh instead.

### 6.11 Remote machines

**AT-SEC-137** (SEC-085)
When a signed-in client asks for the status of a host name that is not in the Operator's configuration,
Then the answer is "not found" and no outbound connection is attempted.

**AT-SEC-138** (SEC-085, 087)
When a project is saved with a remote host not in the configuration, or with a remote directory containing spaces, quotes, shell metacharacters, a parent-directory segment or more than 300 characters,
Then the save is refused.

**AT-SEC-139** (SEC-087)
When a launch is requested for a program other than the fixed set, or with extra fields attempting to supply a host, directory or command,
Then it is refused or the extra fields are ignored, and the produced command contains only the configured target and the stored directory.

**AT-SEC-140** (SEC-085)
Given configuration entries with an option-like target (starting with a dash), a target containing spaces, a duplicate name, an over-long label, and a 17th host,
Then each is skipped with a log line that does not echo the raw value, valid entries still load, and the Service starts.

**AT-SEC-141** (SEC-086)
Given 20 simultaneous status requests for one host,
Then at most one connection to that host is made, and all receive the same result; a further request within 60 s makes none.

**AT-SEC-142** (SEC-086)
Given a host that is unreachable, rejects the key, or presents a changed host key,
Then status reports offline with the matching short reason, never prompts, never hangs beyond the probe timeout, and exposes no raw multi-line output.

**AT-SEC-143** (SEC-087)
Given a remote agent session was started and its terminal closed,
When it is opened again for the same project and program,
Then the user is attached to the same running session with its prior output.

**AT-SEC-144** (SEC-088)
Given the host owner is signed in to the same agent CLI on the remote machine,
When the Studio user signs in there through a remote session,
Then the host owner's own login is unchanged and the two accounts remain separate.

**AT-SEC-145** (SEC-087)
Given a project whose remote host was removed from configuration,
When a launch is requested,
Then it is refused with a "host removed" explanation.

### 6.12 Operations

**AT-SEC-146** (SEC-078)
Given a running agent task,
When the Service receives a termination signal and is started again,
Then the task is listed as interrupted (marked as caused by the restart), one notification per affected conversation is produced, and nothing is re-executed automatically.

**AT-SEC-147** (SEC-075)
When the Operator runs the status command,
Then it prints version, install location, data-store location and state, effective port and no secret values.

**AT-SEC-148** (SEC-081)
Given a day of mixed traffic including failed sign-ins, passwordless attempts, access-proxy refusals and provider-key operations,
When the operator log is searched,
Then it contains no password, session credential, access key, provider key, transfer code, access-proxy assertion, full client address in rate-limit lines, full private-network identity or request query string.

**AT-SEC-149** (SEC-080)
Given a copy of the data store, secret store and configuration restored on another machine,
When the Service starts there,
Then the account can sign in, passkeys for unchanged hostnames work, saved provider keys verify, and agent CLIs report "not signed in" until signed in on that machine.

**AT-SEC-150** (SEC-089)
Given a phone-width viewport,
When the user opens a settings page, scrolls, opens a sub-page and goes back twice,
Then each earlier screen reappears at the scroll position it was left at; on a tablet-width viewport the list and page are side by side and the list does not scroll when the page changes.

**AT-SEC-151** (SEC-097)
Given two devices signed in,
When appearance is changed on one,
Then the other reflects it without reload, and a concurrent change of an unrelated preference on the other device is not lost.

**AT-SEC-152** (SEC-101, 102)
Given a signed-in session,
When the password is changed with the correct current password,
Then the old password no longer signs in, all other sessions are revoked, and an event is recorded; with a wrong current password nothing changes and step-up limits apply.

---

## 7. Security requirements and threat list

### 7.1 What must never be possible

1. **Reaching any data or action without authentication**, other than the explicitly public set (setup status, health, sign-in capabilities, static client files). Every new capability is session-protected by default; a regression test must walk the full capability list unauthenticated.
2. **Taking over a fresh installation remotely.** The first account can be created only from the host machine (or with a one-time setup secret printed locally).
3. **Creating a second account** or re-running setup once an account exists.
4. **Learning whether a username exists** from status, timing, wording, lock behaviour or log-visible side effects available to the caller.
5. **Unbounded password guessing** through any path that compares the password: sign-in, step-up, entry switch, key creation, key re-enabling, passkey management. Every such path shares the limits of section 5.1.
6. **Locking the owner out by attacking from the internet.** A public guessing attack may at most block public *password* sign-in; it must not block the private-network entry, passkey sign-in, existing sessions or step-up.
7. **Denying service to others by exhausting bounded resources:** rate budgets, challenge storage, transfer-code storage, lock records, event log, connection slots, memory for unsent data.
8. **Using a credential outside its scope:** a private-network-issued session on the public entry; a passkey on another hostname; a transfer code on another origin or twice; an access key on interactive account-management capabilities.
9. **Surviving revocation.** After "sign out everywhere" no earlier session, live connection, access key, pending transfer code, scoped gateway access or push subscription remains usable.
10. **Reading a secret back.** No capability, log, event, error, URL or browser storage ever contains a saved provider key, channel credential, source-host token, access key (after its one-time display), password or installation key.
11. **Spoofing the entry class or client identity** with request headers to gain trust or to spend someone else's budget.
12. **Cross-site abuse of a signed-in browser:** reading API answers from another origin, submitting state changes from another origin, or framing the App.
13. **Injecting commands through configuration-like inputs:** remote host targets and directories, project paths, provider base addresses, key names. The browser never supplies a host or a command for remote execution.
14. **Leaking the Service's own configuration into launched processes** (agent sessions, terminals, plugins, builds, user-built apps).
15. **Starting in an authentication-bypass mode on a reachable address.**
16. **Stack traces, internal paths or raw upstream output** in client-visible errors.

### 7.2 Hardening requirements

Each item is a requirement for the new product; the W-numbers are stable identifiers referenced elsewhere in this document and in tests.

| # | Requirement |
|---|---|
| W-01 | The session credential is not readable by page script. Use an HttpOnly, Secure, same-site cookie (with origin checks / anti-forgery protection for writes), or an equivalent design that survives a script-injection bug without credential theft. |
| W-02 | Signing out invalidates that session on the Service, not only in the browser. |
| W-03 | Credentials are never accepted in a URL — not for API requests, real-time connects, downloads or streaming reads. Use a header, a cookie, or a first-message handshake. |
| W-04 | A one-time transfer code never travels in a URL query string; use a POST navigation or a URL fragment that never reaches servers or logs. |
| W-05 | Long-lived connections are re-validated: they are closed when the session that opened them expires, is signed out, or loses its entry-class validity. |
| W-06 | Access keys are stored only as a one-way hash, and the value is shown once. Keys support optional expiry and scopes. |
| W-07 | All third-party tokens, source-host tokens included, are encrypted at rest; adding or re-enabling one requires step-up. |
| W-08 | A meaningful password policy: at least 12 characters or a strength estimate, rejecting known-breached passwords where feasible. Over-long input is rejected, never truncated, at setup, sign-in and step-up. |
| W-09 | Password change (revoking other sessions) and a host-local password reset exist. |
| W-10 | Every App response carries a strict content security policy, transport security, no-sniff and referrer-policy headers, in addition to anti-framing. |
| W-11 | The secret store's installation key is not readable by processes the Service launches (agents, terminals, plugins, other projects of the same OS user). Options: a separate OS user or service for secrets, an OS keychain, or an unlock passphrase held only in memory. |
| W-12 | No authentication-bypass mode in production builds. A development convenience, if any, cannot be enabled on a non-loopback address. |
| W-13 | The unauthenticated health answer discloses no version and no install kind. |
| W-14 | Entry-class detection rests on where a connection arrived (distinct listeners or a mutually authenticated proxy), never on headers a peer can forge. The Service refuses to run a public entry with header-based classification. |
| W-15 | Passwordless network-identity sign-in, if offered, is off by default, requires a device allow-list, prefers a cryptographically verifiable identity to identity headers written by a proxy, and states its trust boundary in the UI (every program on an allowed device can obtain a full session). |
| W-16 | No capability updates, rebuilds or reinstalls the Service at a signed-in user's request; updates are an operator action. |
| W-17 | Third-party API keys for optional features (such as a speech backend) are kept in the secret store, never in browser storage, and are not sent from the browser in request headers. |
| W-18 | Destinations a signed-in user can configure for outbound calls (mail server, push relay server, speech backend, link checks) are validated against loopback, link-local and metadata address ranges unless the Operator explicitly allows them. |
| W-19 | A list of active sessions with per-session revocation, and an absolute maximum session age in addition to sliding renewal. |
| W-20 | Configuration parsing is strict and explicit: values with stray quotes or inline comments are rejected with a clear startup message, never silently taken as part of the value. |
| W-21 | In any multi-user build, security events are scoped per account. |
| W-22 | Throttle and rate state that protects authentication survives a restart. |
| W-23 | State-changing account actions require step-up consistently, including notification-channel credentials and outbound destinations ("sign out everywhere" optionally). The list is decided and documented. |
| W-24 | Operator logs contain no usernames or account ids on routine events unless the Operator opts in. |
| W-25 | The App shows the user the consequence when setup is attempted remotely, before any input. |
| W-26 | The UI and docs state clearly that a project directory is a working directory, not a sandbox: an agent in permissive mode can read anything its OS user can. A real sandbox option is provided. |
| W-27 | Before the first remote sign-in, the UI says that credentials created on a remote host are readable by that host's owner, and it offers a "sign out on the remote host" action. |
| W-28 | A deployment-wide shared gate key (SEC-032), if offered, is presented differently from access keys and is supported by the App; otherwise it is not offered. |

### 7.3 Further protections

- Refusal order "cheapest first": rate limits → edge verification → authentication → body parsing → routing.
- Fail-closed handling of every security-relevant configuration error; fail-open only for cosmetic features.
- Stateless issuance of anonymous challenges; hashing of one-time codes at rest; consumption on first attempt.
- Separate budgets per entry class so an attack on one never spends another's.
- Three-class event retention so noise cannot evict evidence.
- New push endpoints after a global sign-out are treated as security events; only previously known endpoints re-register silently.
- Removal of a secret never requires what adding it requires.
- Constant-time comparison for any shared secret.
- Signed credentials, where used, are pinned to one signing algorithm.

---

## 8. Mobile requirements (this domain)

1. **Sign-in and setup screens** fill the dynamic viewport height, add top and bottom safe-area insets to their padding, keep the card fully visible in landscape and with the keyboard open (the focused field scrolls into view), and use ≥ 16 px input text so iOS Safari does not zoom.
2. **Passkeys on iOS/iPadOS:** the passkey button appears only in a secure context with platform support; the system sheet is triggered directly by the tap (no intervening async step that breaks the user-gesture requirement); cancelling returns to an unchanged form with a neutral message. Registration must target the device's own authenticator. Passkeys are per hostname, so a device used on two entry points needs one per entry — the security page must make that visible (current hostname tagged, others listed).
3. **Home-screen (standalone) app:** it has storage and cookies separate from the browser, so the user signs in (and passes any access proxy) once more inside it. It is bound to the address it was added from; the entry-switch flow must work from inside a standalone app (navigation stays in the app). The manifest and icons must be reachable without credentials and exempt from access-proxy verification so the icon and name install correctly.
4. **Password managers:** correct autofill hints (username / current password / new password) on sign-in, setup and every step-up field; secret fields for provider keys and channel credentials must not trigger "save password" or auto-generated-password prompts.
5. **Session continuity:** returning from background must not show the sign-in form while a renewal or status check is in flight; iOS often has no network for the first request after waking — one automatic retry before reporting failure.
6. **Settings on a phone:** single-column drill-down with a system-like back gesture/control, per-screen scroll restoration, large title that collapses into a translucent bar; on iPad (including portrait) a split view with a narrower list.
7. **Sheets and alerts** respect the bottom safe area and the on-screen keyboard; the password field in a step-up alert is focused on open; primary actions stay above the keyboard.
8. **Touch targets** ≥ 44 pt for every row, switch, icon button and segmented option; no hover-only information (latency, lock time, tool marks are always visible).
9. **Remote terminal on a phone:** full-screen cover that respects safe areas, keeps the prompt above the keyboard, and whose close control is reachable with one thumb; closing detaches rather than kills.
10. **Update handling:** automatic reload only when the page just returned from background and is untouched; never while a field has text or a sheet is open; the update toast must not cover the composer or the home indicator.
11. **Offline / host asleep:** clear "cannot reach the Service" state distinct from "signed out"; no loss of the stored session.
12. **Reduced motion and dark mode** honoured on the sign-in, setup and settings screens; the launch screen and sign-in background match so the hand-over has no flash.

---

## 9. Open questions and ambiguities

1. **Account model.** Should 2.0 be strictly single-owner, or multi-user with roles (owner / member / read-only)? Personal data is already keyed per account (SEC-028), and a network identity must map to exactly one local account (5.6). Multi-user changes projects, files and agent sessions far more than this domain.
2. **Session mechanism.** Cookie-based sessions (W-01) bring cross-site request considerations and affect the real-time handshake, the entry switch and the standalone app. The team must choose and then define the anti-forgery rule; test AT-SEC-094 is conditional on that choice.
3. **First-run on a headless remote server.** "Host machine only" blocks takeover but also blocks legitimate setup over SSH-only access. Acceptable alternative: a one-time setup secret printed to the local console/log?
4. **Password reset design.** Is a host-local command (SEC-102) sufficient, and should it revoke passkeys and access keys?
5. **"Remember this device".** Is a shorter default session with an opt-in long session wanted (SEC-015)?
6. **Generalising the two-entry design.** This document describes exactly two named entries, one shaped after an outbound tunnel and one after a mesh-VPN HTTPS proxy. Should 2.0 support N operator-defined entries, generic reverse proxies with a trusted-proxy list, and vendor-neutral assertion verification (any OIDC-style signed assertion)?
7. **Passwordless network-identity sign-in.** Keep it at all in a public product, given W-15? If kept, which identity sources?
8. **Sub-path hosting.** Should 2.0 support a configurable base path, with the App, the API and the real-time channels all under one prefix (SEC-083)?
9. **Deployment-wide shared gate key (SEC-032).** Offer it at all (see W-28), or do access keys cover the need?
10. **Legacy settings dialog (SEC-098).** Which of its options survive: project sort order, code-editor preferences (word wrap, minimap, line numbers, font size 10–20), speech backend, task-manager integration switch, agent-browser monitor, sound on completion with a test button, desktop-app notifications?
11. **Languages.** The legacy dialog offers 13 locales; the newer screens (home, settings, security) are written in one language only, and several Service-generated messages are in that language regardless of locale. Which locales ship at launch, and are Service messages localised or code-only with client-side wording?
12. **Displayed time zone.** Some timestamps use a fixed zone chosen by the owner. 2.0 should use the device zone or an account preference — confirm.
13. **Exact numeric limits.** The values in 5.1 are recommended defaults; confirm or tune them for the new product.
14. **Wording and status details to decide:** the passkey button's behaviour when the device holds no passkey for the hostname; whether the sign-in screen shows the lock countdown live or only in the refusal message; how the App words a 403 from access-proxy verification.
15. **Backup and export.** Beyond the documented manual procedure (Flow 17), does 2.0 need in-app backup/restore, export of account data, or account deletion ("danger zone")?
16. **Remote hosts management.** Hosts come from operator configuration, applied by a restart (SEC-085). Should 2.0 allow adding hosts in the App (with step-up), show host-key fingerprints for first-use confirmation, and manage the remote agent sign-out?
17. **Rate-limit persistence and clustering.** If 2.0 can run more than one process, where do budgets, challenges and transfer codes live, and how do they survive a restart (W-22)?
18. **Health disclosure.** With no version in the public health answer (W-13), how does the App detect a restarted-but-not-rebuilt backend — is an authenticated status read acceptable?
19. **Step-up coverage.** Which actions must require the password again (see W-23), and should a recent successful step-up be reusable for a few minutes?
20. **Secret-store isolation (W-11).** Which approach is acceptable for a single-user laptop install without making setup painful?
21. **Desktop wrapper application.** Is a desktop wrapper in scope for 2.0?
22. **Passkeys on a purely local install.** Passkeys need a configured DNS-named entry (SEC-019), so a localhost-only install cannot use them. Should 2.0 allow them on localhost?
23. **Sign out everywhere without step-up.** Should "sign out everywhere" require the password (with its own budget), or stay password-free as the escape hatch from a step-up lock (see W-23)?

---

## 10. Noticed outside my domain

- Web Push subscription lifecycle, device naming and silent re-registration after a global sign-out (domain 4); only the security rules are specified here.
- Notification channels (push, e-mail via the owner's mail server, phone push relay, SMS) with per-channel rate caps, "send test" throttling and content limited to event/project/title (domain 4).
- Gateway for user-built apps: each app runs in a sandboxed opaque origin, reached by an unguessable path token with idle and absolute lifetimes, revoked on global sign-out (domains 2/4).
- AI build runs: OS-level sandboxing, an allow-listed environment and a sandbox self-check (domains 1/2).
- External automation interface (clone a repository, run an agent, optionally branch and open a pull request) authenticated by access keys; public documentation page served without sign-in (domain 1).
- Terminal sessions: cap on live terminals, reattach by command identity, reclaiming detached ones, one-tap "run this command" from a chat code block (domain 2).
- Workspace path validation: containment under a workspace root, forbidden system directories, symlink resolution, read-only extra roots for agent output files (domain 2).
- Repository cloning restricted to web and SSH transports to block command-executing transports (domain 2).
- Project link checker refuses link-local and cloud-metadata addresses (domain 2).
- Task recovery after a restart: interrupted runs are flagged for the owner and never re-run automatically; idempotent message delivery with client-generated request identifiers (domain 1).
- Home "to-do" inbox built from run receipts, with acknowledge rules (domain 4).
- Per-account draft sync with size limits (100 000 characters per draft, 200-character keys) (domain 1).
- Plugin backend processes get a minimal environment; per-plugin secrets are forwarded to the plugin as request headers (domain 2).
- Agent-browser bridge authenticated by a random local token, with constant-time comparison (domain 2).
- Usage/quota reading uses the machine's agent sign-in token read-only per request, never logs, stores or refreshes it; backs off on rate limits (domain 1).
- Shared memory refuses to store notes containing provider-key-shaped strings (domain 4).
- Legacy floating quick-settings panel with chat display toggles (domain 1).
- Legacy "tasks" (external task-manager CLI detection and enable switch) and "browser" (agent browser sessions monitor) settings tabs (domain 2).
- Service-worker caching interacts with client update detection: new entry files are pre-fetched before an automatic reload (domain 4).
- Speech features: the audio upload cap and the speech backend configuration (domain 1; key storage per W-17).
- Home-screen widget showing continuous-integration and auto-deploy state for the product's own repository (likely owner-specific; domain 4 to classify).
