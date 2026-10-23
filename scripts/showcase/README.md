# Reproduce the product screenshots

The screenshots in `docs/assets/screenshots` render the real built web client
against the real server modules. All projects, notes, conversations, messages,
provider catalogues and identities are fictional. The two demo assistants use
the existing scripted test adapter. CLI availability comes from the repository's
test executables. Nothing pictured is evidence of a live provider run.

```sh
npm ci
npm run build
build-queue node scripts/showcase/capture.mjs --domain
build-queue node scripts/showcase/render-devices.mjs
```

On a machine without the optional local `build-queue` wrapper, run the `node`
command directly. Install Playwright's Chromium if it is not already available:
`npx playwright install chromium`.

The runner creates a fresh random temporary directory for the server's home,
data and project workspace. It starts a loopback server on a free port with an
explicit minimal environment and generates ephemeral authentication in memory.
It never reads an existing Studio installation or reuses a browser profile.
Browser requests are restricted to that server. Mail goes through a closed
synthetic transport that refuses sending, token refresh and unknown requests.
Provider catalogues use example addresses and are never verified or invoked.

Only PNGs and a descriptive `manifest.json` go into the screenshot directory;
cookies, tokens, databases and files stay in the temporary directory. Normal
completion, failures and termination signals stop the server/browser and remove
that directory. An uncatchable process kill can leave it behind in the system
temporary directory; it is never a Git input. The source fixture lives in this
documentation tooling folder and is not imported by production code.

The shots use desktop (1440 × 900), tablet (820 × 1180) and phone (390 × 844)
viewports. They demonstrate responsive layouts, not hardware-specific testing.
The separate device-composition script wraps these unaltered product captures
in decorative CSS device frames. Captions and the feature tour identify the
sample data so readers can distinguish UI capabilities from demo output.

Review every generated PNG before committing it. Keep examples fictional and
use reserved domains; never replace the fixtures with personal accounts,
messages, service addresses, credentials or billing data.
