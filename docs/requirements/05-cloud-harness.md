# Cloud Harness: conversations, tools and personal productivity

This document describes product behaviour for an independent MIT implementation.
It contains no source, assets, fixtures, credentials, deployment details or user
data from another system. Implementations use this project's protocols, UI
components and security kernel. Personal deployments start with empty accounts
and optional integrations disabled.

## Conversations

- Group conversations with names chosen by the signed-in user; move, rename and
  remove groups without deleting their conversations.
- Branch a conversation at a chosen message or at its end. Existing history is
  immutable; the branch can continue independently. Editing a past prompt starts
  a branch. An attachment must remain accessible only to its authorised users.
- Show model, reasoning effort, context use and supported speed options. A
  provider option is offered only when the runtime can actually honour it.
- Support separate CLI account profiles. A conversation stays bound to the
  account it started with, and login credentials never enter API responses.
- Discover conversations from explicitly configured local CLI roots. Discovery
  is read-only, bounded, scoped to the user and protected against symlink escapes.
- Preview files affected by a real message checkpoint and require confirmation
  before restoring. Unsupported providers cannot offer a fake restore action.
- Display background commands and subagent work from actual runtime events.
  Running, waiting, completed and failed work remain distinguishable on a phone.

## Images and voice

- Annotate an image with pen strokes, arrows, rectangles and circles; undo,
  clear, save a separate copy, share and attach it to a reply. The original is
  preserved. Image-edit requests use the selected model's actual capabilities.
- Dictation inserts text into the draft that requested it. Changing conversation
  or closing the recorder cancels pending input. Recording requires explicit
  permission; remote transcription needs an explicitly configured service.
- Offer an available browser dictation fallback and optional read-aloud. Do not
  create an always-listening assistant or collect voice biometrics.

## Tools and environments

- Manage external tool-server connections, user-written skills and reusable
  slash commands. Validate scope and arguments; process and network access use
  the existing permission and sandbox boundaries.
- An optional agent browser provides navigation, screenshots and approved
  interaction. Profiles are isolated by user/project, and network policy applies
  to redirects, subresources, downloads and browser-initiated requests.
- An optional Windows connector pairs an explicitly selected device and offers
  reviewed actions. Pairing tokens, screenshots, device addresses and approval
  state are installation-local; no system starts paired or silently trusted.
- Build small applications within projects, show build logs/status, and preview
  their output through an isolated gateway. Application content cannot access
  the workbench's cookies or bypass its filesystem/process restrictions.
- Retain the existing SSH environments, terminal, files, Git and project-scoped
  memory while giving local and remote work consistent entry points.

## Mail, reminders and notifications

- Connect the user's own mail accounts, switch accounts, browse folders, search,
  read messages and download permitted attachments. Treat message bodies and
  attachments as untrusted input; remote tracking pixels remain disabled.
- Store account credentials encrypted, and isolate accounts, drafts and caches
  by user. No real mail content or access tokens appear in logs or fixtures.
- Summarisation requires explicit consent and identifies where the selected
  model runs. Drafts are editable; sending requires an explicit human action.
- Let agents propose structured, timezone-aware reminders through the existing
  tool permission system. Users can pause, resume and inspect reminder history.
- Add optional notification channels with blank configuration, encrypted
  credentials, validated destinations and explicit connection tests.

## Delivery and verification

- Product text uses Cloud Harness. The application remains MIT; earlier package,
  command and configuration identifiers can remain as compatibility aliases.
- A desktop wrapper uses the same application, with isolated renderer privileges,
  restricted navigation and opt-in notifications. It never copies browser logins.
- UI works on phone, tablet and desktop, in light/dark modes, with keyboard and
  reduced-motion support. New strings have English and Simplified Chinese forms.
- Verification uses synthetic accounts/messages/images and fake services. No
  tests charge a model account, send mail, operate a personal device or publish
  private data. Release review covers the exact change, new assets, generated
  packages, secret scans, dependencies and source-similarity checks.
