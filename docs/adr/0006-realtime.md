# ADR 0006 — One WebSocket, topic subscriptions, replay by sequence number

**Status:** accepted

## Decision
A browser tab opens one WebSocket (`/api/realtime`), authenticated by the
session cookie and an origin check. It subscribes to topics (`session:<id>`,
`project:<id>`, `user:<id>`); each subscription is authorised separately.
Durable topics number their events. A client that reconnects sends the last
number it saw and receives exactly what it missed; a subscriber also gets a
snapshot of in-flight state (for example a half-streamed message).

Runs belong to the server. A run continues with no browser attached, and any
number of devices watching the same session see the same stream.

## Why
Phones drop connections constantly — a locked screen, a lift, a tunnel. The
protocol treats disconnection as normal: nothing is lost, nothing is
duplicated, and the user never has to refresh.

Token-by-token deltas are sent live but not stored; the completed message is.
That keeps the log small while a late joiner still sees the partial text
through the snapshot.
