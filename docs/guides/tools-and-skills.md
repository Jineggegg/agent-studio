# Tools, skills and reusable commands

The **Tools and skills** tile manages entries belonging to your account. Choose
all your projects or one accessible project. Project entries are not shared
with another account; a global entry is visible only to its author. Project
access is checked again whenever an agent reads an entry or contacts a server.

A **skill** is Markdown instruction text. Select it in the conversation command
picker or type `/skill:name your request`. A **slash command** is a reusable
prompt, invoked as `/name your request`. `$ARGUMENTS` inserts the text after the
name; without that marker, the arguments follow the template. A project entry
with the same name takes precedence over your global entry. Expansion happens
once before a message is saved or queued. It never runs a shell, changes
permissions or loads arbitrary files from the host.

**MCP connections** use HTTPS Streamable HTTP with a bearer token stored in the
encrypted credential store. Saving does not make a request. **Connect and list
tools** makes an explicit connection test. Agents first list connections, then
request approval to discover or invoke remote tools. A configuration version
is part of each request: changing the endpoint, credential or settings
invalidates earlier approvals. Changing any part of the endpoint clears its
saved token unless you explicitly supply a replacement.

The client implements the handshake versions `2025-11-25`, `2025-06-18` and
`2025-03-26`, including bounded JSON/SSE replies and paginated tool discovery.
It creates a short-lived MCP session for each operation. It does not implement
the newer stateless protocol, legacy separate SSE endpoints, stdio launchers,
server-initiated sampling/elicitation, automatic OAuth or resource downloads.
Local executable extensions can instead use the existing sandboxed plugin
system. No external connection is installed by default.

Transport uses pinned DNS resolution, refuses redirects and public HTTP, bounds
request/response size and duration, and limits concurrent calls. Only the owner
may opt into private HTTPS destinations; link-local addresses remain blocked.
Remote tool output is untrusted text; access-token echoes are redacted and
remote image/resource blocks are not fetched. A timeout never retries a tool
call, because the remote side may already have performed it.

Implementation references:
[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
and [lifecycle negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).
