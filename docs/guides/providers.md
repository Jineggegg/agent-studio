# Model providers

Cloud Harness supports OpenAI-compatible chat completions and Anthropic's native
Messages API through the same conversation and approved-tool execution system.
Owner settings store provider keys encrypted. New installations have no accounts,
keys, model balances or usage records.

Choose an Anthropic preset to use the Messages protocol. Save a key and discover
models, then select a default and mark the image/tool capabilities of the models
you use. The preset does not guess model availability, context limits or prices.
An empty catalogue does not make paid requests. Verification first uses model
listing; an explicit verification may use a minimal completion when listing is
unavailable. Run costs use only the prices configured by the owner.

The native client uses API version `2026-10-21`, streams text and tool arguments,
accepts inline PNG/JPEG/GIF/WebP attachments, and aggregates cache-aware token
usage. It does not request extended thinking or replay unsigned thinking blocks.
Temperature is omitted because that API version removed sampling parameters.
Remote image URLs are refused; they are never fetched automatically.

Provider endpoints use the existing DNS-pinned transport policy. Public
endpoints require HTTPS, redirects are refused, and private networks require an
explicit owner setting. Upstream error bodies are not shown or logged by the
native client. Browser access never receives the saved API key.

Public protocol references used for this implementation:

- [Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Model discovery](https://platform.claude.com/docs/en/api/models/list)
- [API versions](https://platform.claude.com/docs/en/api/versioning)

Automated tests use a local synthetic service. No live account or paid model call
is part of the test suite.
