# Reproduce the product images

The images in `docs/assets/showcase/<lang>/` are the real built web client and
server modules, photographed with fictional data and then laid out as product
images. Nothing pictured is evidence of a live agent or provider run.

```sh
npm ci
npm run build
build-queue node scripts/showcase/build.mjs
```

On a machine without the optional local `build-queue` wrapper, run the `node`
command directly. Install Playwright's Chromium if it is not already available:
`npx playwright install chromium`.

## What runs

- `content.mjs`: everything that is pictured, in English and Chinese. This
  includes the fictional `lumen-shop` project and its files, the agent replies,
  the notes, the tools and the mail.
- `server.ts`: starts the real server with two scripted stand-ins, shown as
  Claude Code and Codex, in place of the real adapters. Every reply is written
  out in `content.mjs`; no CLI, model or provider is ever started. Mail goes
  through a closed fixture that refuses sending, token refresh and unknown
  requests. Provider catalogues use reserved example addresses and are never
  contacted.
- `capture.mjs --lang <en|zh-CN> --out <dir>`: creates a fresh temporary home,
  data folder and workspace, and a disposable account. It turns the project into
  a throwaway Git repository and changes one file after the first commit, so the
  Git panel shows a real diff. It then photographs the screens at twice the pixel
  density. The browser can reach only that local server.
- `compose.mjs --lang <en|zh-CN> --raw <dir> --out <dir>`: lays the captures
  out with `poster.css`. This produces the hero (1600 × 900) and one card per
  idea (1200 × 750). Everything is local: no web fonts, scripts or images are
  fetched.
- `build.mjs`: runs both steps for both languages and writes the finished images.
  It also keeps the dark-theme and domain screens for the tour. The raw captures
  stay in a temporary directory that is removed afterwards.

## Fonts and review

The text uses locally installed fonts: Inter or Ubuntu Sans for Latin text, and
Noto Sans SC or Microsoft YaHei for Chinese, with system fallbacks. Other
machines may render slightly different glyphs.

Review every generated PNG before committing it. Keep examples fictional and use
reserved domains. Never replace the fixtures with personal accounts, messages,
service addresses, credentials or billing data.
