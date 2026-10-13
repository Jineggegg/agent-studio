# ADR 0003 — Server-side sessions, a setup token, and explicit access on every route

**Status:** accepted

## Decision
1. **Browser sessions are opaque random tokens in an `HttpOnly`,
   `SameSite=Strict` cookie** (`__Host-` prefixed and `Secure` over HTTPS). The
   server stores only a SHA-256 of the token. Sessions slide on use, have an
   absolute lifetime, are listed per device and can be revoked individually or
   all at once. Nothing a script can read grants access, so an XSS bug cannot
   exfiltrate a session, and credentials never travel in URLs.
2. **Cookie authentication needs an anti-forgery token and a same-origin
   check.** Every state-changing request must carry an `Origin` equal to the
   origin it was sent to and an `x-studio-csrf` header derived from the session.
   WebSocket handshakes get the same origin check.
3. **The first account requires a one-time setup token** that the server prints
   on its console and writes to an owner-only file. Whoever creates the owner
   account has therefore proved control of the machine, wherever their browser
   is. (A "loopback only" rule would do the same for a desktop but not for a
   headless server reached over SSH.)
4. **API tokens** (`ast_…`, stored hashed) carry scopes (`read`, `write`,
   `admin`) and an optional expiry. They cannot perform account management:
   creating tokens, changing passwords and managing people require a browser
   session that authenticated recently.
5. **Passwords** are hashed with scrypt (N=2¹⁵) with per-password salts. Failed
   attempts are throttled per account with exponential back-off; unknown
   accounts cost the same time and receive the same answer.
6. **Access is declared, not assumed.** A route under `/api/` that does not
   state `public`, `user`, `owner` or `self` stops the server from starting.
7. **Two roles.** The *owner* administers the instance. A *member* can use only
   the projects shared with them. Members are collaborators the owner trusts
   with agent access: an agent a member runs has the operating-system
   permissions of the service account. Roles bound the API, not the kernel.
8. **The Host header is allow-listed** (loopback names plus configured public
   origins), which defeats DNS rebinding against a service bound to loopback.

## Alternatives considered
- *Bearer tokens in `localStorage`:* simple, but any script injection becomes
  account takeover, and tokens end up in URLs for WebSockets and downloads.
- *Stateless JWT cookies:* no server-side revocation without adding the state
  back.
