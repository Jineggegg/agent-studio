# Browser, images and voice

These optional tools use the current signed-in account. A new installation has
no browser profile, transcription endpoint, paired device or model credential.
UI labels are available in English and Simplified Chinese.

## Annotating and replying with images

Open an image attachment in a conversation, then choose **Annotate image**.
Choose Pen, Arrow, Rectangle or Circle, adjust the colour and stroke width, and
draw. Undo removes the last mark; Clear removes every mark. Keyboard users can
focus the canvas, press Enter to start, use arrow keys to move and press Enter
to finish. Escape cancels the unfinished mark.

**Save annotated copy** creates a separate PNG with an `-annotated` filename.
The original attachment is never overwritten. Very large images are scaled to
at most 4096 pixels on their longest edge in the copy. Copy uses the image
clipboard where supported; Share uses the operating system's chooser. Both
fall back to downloading a copy when their native feature is unavailable.

**Reply with image** attaches the new copy to the current conversation's draft.
For an edit request, enter instructions and choose **Request image edit**. The
selected agent must advertise image input support. The request becomes an
ordinary image attachment plus text; whether an actual edited image can be
produced depends on that provider's tools. Review the draft before sending.

External image URLs are never fetched for annotation or automatically uploaded.
Only this application's authenticated attachment URLs and local blob images
are eligible. Downloading a third-party image and attaching it yourself is an
explicit choice. Changing conversations closes the viewer. Optional **Read
aloud** speaks a reply's plain text after you press its button; it stops when
the reply is left.

## Voice dictation

Press the microphone beside the current draft. A consent notice identifies
whether audio will go to the configured instance service or your browser's
speech-recognition service. Press **Start microphone**, grant the operating
system's microphone permission, speak and choose **Finish dictation**. The
result is appended to the current draft, preserving text typed while listening.
Cancel discards the recording. Changing conversation or closing the composer
aborts recording and any pending result; late results cannot enter another draft.

Recordings are limited to one minute and 5 MiB. Recording is never automatic.
Without server transcription, a browser exposing SpeechRecognition can supply
dictation; unsupported browsers show an explanation. Browser recognition may
send audio to the browser vendor's service. Read-aloud is a separate opt-in
plain-text feature and does not listen to the microphone.

The instance owner can configure **Settings → Voice dictation**. Enter the full
Whisper-compatible `https://…/v1/audio/transcriptions` endpoint, model name and
optional API key. Saving requires a recently authenticated owner session. The
key is encrypted at rest and never returned; changing the endpoint origin clears
the old key. An explicit private-network setting permits a local service, with
plain HTTP restricted to loopback. Metadata/link-local destinations remain
blocked. Requests use guarded, DNS-pinned transport; redirects are not followed.

The server does not store recordings or transcripts. It returns only bounded
transcribed text to the initiating browser. The configured remote service has
its own retention policy. Microphone Permissions-Policy is limited to this app's
own origin; camera and other unrelated device permissions remain disabled.

## Isolated agent browser

The instance owner must install Chromium and enable the Linux bubblewrap sandbox.
Set `CLOUD_HARNESS_CHROMIUM` to its **canonical absolute executable path**, for
example `/usr/lib/chromium/chromium`, then restart the server. Symlink paths are
refused. The executable must be under `/usr`, `/bin` or the dedicated
`/opt/cloud-harness-chromium/` directory. The dedicated directory must contain
only the public Chromium distribution; never put credentials or project files
there. Browser support is disabled by default and refuses to launch if the
sandbox or required runtime is unavailable. It never falls back to a personal
browser or to an unsandboxed process.

Open **Agent browser**, select an optional project and choose **Open isolated
browser**. Only the creating user can see that browser. A project browser also
requires current write access to its project. Enter an HTTPS address and review
the navigation. A screenshot can be refreshed without performing an interaction.
Select a point on the image or enter coordinates, then review **Click selected
point**. Text is inserted only into the currently focused field after review.
An agent can use `browser_control` through the existing tool permission system.

One browser may run on an instance at a time. It closes after five minutes
without an action or when explicitly closed. Profiles are temporary, isolated
by user/project, and discarded at close. No saved logins are imported. Screenshots
remain in server memory and are shown only to the creating user; they are not
automatically sent to model providers. Page text is untrusted content.

The browser has no host network, host sockets, home directory or project mount.
CDP uses process-private pipes. The host substitutes guarded HTTPS responses for
page/frame requests, validating each redirect and subresource independently.
Private addresses, WebSockets, WebRTC, downloads, uploads without a bounded text
body, worker/popup targets, camera and microphone are blocked. Some sites that
require those features will not work. There is no arbitrary JavaScript, local
file, shell command or browser-extension API. Chromium's internal sandbox stays
enabled. The first version uses a fixed 1280 × 800 viewport.

Chromium receives a minimal fixed environment, without operator passthrough
variables or proxy credentials. Namespace isolation does not impose CPU, memory
or temporary-disk quotas: an untrusted page can still exhaust local resources.
Enable the optional browser only on a host with suitable resource supervision.

Tests use synthetic pages, fake upstream services and temporary profiles. The
opt-in real Chromium smoke test can be run with
`CLOUD_HARNESS_TEST_CHROMIUM=/absolute/path/to/test/chrome npx vitest run --project server apps/server/src/modules/browser/engine.smoke.test.ts`.
Its alternate runtime-directory option is accepted only in test mode. Production
path and sandbox checks remain unchanged.

For the optional desktop wrapper, see [desktop setup](../../desktop/README.md).
