# Cloud Harness publication review — 2026-10-23

This expansion implements the accepted behavioural requirements in
[05-cloud-harness.md](../requirements/05-cloud-harness.md). Owner-specific
integrations are excluded. Mail and the general workspace features are
included. Personal accounts, messages, keys, observed financial values, deployment
settings and private Git history are not migration inputs.

## Independent AI-assisted review

Separate reviewers inspected browser/media/desktop boundaries; conversations,
account profiles/checkpoints and computer control; mail, tools, apps and usage;
and publication privacy. They did not implement the features they reviewed.
This is an AI-assisted code review, not an external professional security audit.

The following findings were fixed and independently re-reviewed before commit:

| Finding                                                                   | Resolution                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending MCP initialization could outlive cancellation and dispatch a tool | Propagate the originating cancellation signal through runtime, provider, tool registry and transport; check before every request            |
| A build confirmation could execute edited app configuration               | Separate monotonic configuration revision, immutable proposal snapshot, explicit command display and stale-confirmation refusal             |
| Checkpoints could retain credential files in plaintext                    | Exclude credential paths and entire recognizable secret-bearing snapshots; apply the checks to capture, preview, restore and legacy records |
| Deleted users could leave CLI credentials on disk                         | Revoke and drain profile operations, agent launches/runs and terminals before safe directory removal; startup orphan cleanup                |
| Cascaded tool-library deletion left encrypted tokens                      | Database trigger removes the corresponding secret                                                                                           |
| Chromium inherited operator environment passthrough                       | Start from an empty environment with only fixed runtime paths and private home/temp directories                                             |

Regression tests cover these boundaries with synthetic inputs. See
[STATUS.md](../STATUS.md) for the final verification results and their scope.

## Publication material

The candidate tree, public Git history and generated release material are scanned
for secrets. The scanner's canary test verifies that realistic planted keys in
test files still fail; existing narrow synthetic-fixture exceptions are not widened.
Binary source assets are generic PNG icons without metadata. The desktop archive
contains only the wrapper and its package metadata, with no saved connection or
browser profile. Dependencies use public-registry integrity hashes and allowed
licences. The mechanical source comparison is recorded in
[SIMILARITY.md](SIMILARITY.md); its limitations and the coordinating agent's prior
exposure are disclosed in [PROCESS.md](PROCESS.md).

Two observed API costs and obsolete predecessor names already present in the
public repository were removed from the current guide/test text. Existing public
history was not rewritten; this review does not claim those older public copies
were erased. No private history is merged into this branch.

## Remaining limits

- Credential detection is heuristic; arbitrary secrets in ordinary source text
  cannot be identified perfectly. A stopped process that does not settle delays
  directory cleanup until a later safe startup and is logged.
- Cancellation cannot undo a request already accepted by an external service.
  App revision checks bind configuration, not a frozen copy of project files.
- The isolated browser has no CPU, memory or temporary-disk hard quota. It is
  disabled until the operator configures a suitable Chromium installation.
- Usage gates use reported usage. In-flight/concurrent work, unknown prices and
  requests inside CLI turns can exceed the chosen amount; this is not an exact
  spending cap. No personal limits or account balances are preloaded.
- Windows companion and Electron GUI behaviour require real target-platform
  testing. Static compilation, Linux packaging and synthetic browser tests do
  not substitute for that. Real mail sends and paid provider calls were not used
  in this expansion's verification.
