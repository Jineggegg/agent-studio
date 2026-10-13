# Contributing

Thank you for wanting to help. This page is short; the details live in
`docs/development/CONVENTIONS.md`, which you should read before changing code.

## The one unusual rule

This project is an independent implementation, written from requirement
documents rather than from any earlier code base. To keep it that way:

- **Do not copy or port code from CloudCLI UI (`siteboon/claudecodeui`) or
  from any AGPL/GPL project.** If you have read such code, describe behaviour
  in an issue instead of submitting an implementation modelled on it.
- By opening a pull request you confirm that the contribution is your own work
  (or that you have the right to submit it) and that it may be distributed
  under the MIT licence.

## Getting started

Requirements: Node.js 22.13 or newer, npm, git. No C/C++ toolchain is needed.
On Linux, install `bubblewrap` to run the sandbox tests for real (they skip
themselves without it).

```
git clone https://github.com/Jineggegg/agent-studio.git
cd agent-studio
npm ci
npm run dev          # API on 127.0.0.1:7420, client on 127.0.0.1:5420
```

The first start prints a one-time setup token; open the client and create the
owner account with it. Development data goes to `~/.agent-studio`; set
`AGENT_STUDIO_DATA_DIR` to use another directory.

## Before you open a pull request

```
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run build && npm run test:acceptance
```

- Add tests with the change. For anything a client can call, test the refusals
  as carefully as the successes (anonymous, a member without the project,
  read-only access, another user's data, hostile input).
- Keep one logical change per commit, with a message that says why.
- New dependencies need a reason. They must be MIT, ISC, BSD, Apache-2.0 or
  similarly permissive, must not need an install script, and come from the
  public npm registry — CI checks all three.
- Never commit credentials, local data or generated output. CI scans for
  secrets in every commit.
- User-visible strings go in both `en` and `zh-CN`.

## What happens to your pull request

CI runs on GitHub-hosted machines with a read-only token: typecheck, lint,
unit and integration tests on two Node versions, the build with a smoke test,
black-box acceptance tests, browser tests at phone/tablet/desktop sizes,
dependency audit, licence check and a secret scan. A maintainer reviews once
it is green. Changes to `apps/server/src/kernel`, to authentication, to the
permission engine or to the plugin sandbox get a slower, more careful review —
please explain the threat you considered.

## Reporting bugs and security problems

Ordinary bugs: open an issue with steps to reproduce, what you expected and
what happened, plus your OS, Node version and browser. Security problems: see
`SECURITY.md` — please do not file those publicly.

## Code of conduct

Be kind, assume good faith, and keep discussion about the work. Harassment or
personal attacks are not accepted; maintainers may remove comments and block
accounts that do it. See `CODE_OF_CONDUCT.md`.
