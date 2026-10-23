# Code similarity audit

As part of the release checklist, this code base was compared mechanically with
the private predecessor system it was modelled on (which is itself derived from
CloudCLI UI). The tool is `scripts/similarity-audit.mjs`; it reads both trees
and prints aggregate figures and locations in **this** tree. Detailed JSON
reports also contain counterpart file names, so those reports stay local;
only the aggregate findings below are published. The comparison does not copy
the other tree's source into the application.

What it measures, from coarse to strict:

1. **Identical significant lines** — after whitespace normalisation, ignoring
   imports, lines shorter than 30 characters and punctuation-only lines.
   Isolated identical lines are normal between any two TypeScript projects
   that use the same libraries (`const timer = setTimeout(() => {`).
2. **Shared windows of six consecutive significant lines** — the usual
   signature of copy-and-paste.
3. **Per-file overlap** — for each file here, the share of its three-line
   windows that appear in any single file there.
4. **Distinctive identifiers** — names of at least fourteen characters
   declared here that also occur there.

## Current review

The 2026-10-23 Cloud Harness candidate is compared against both the private
predecessor and public upstream `siteboon/claudecodeui` at
`7238368fca24e90938e9a6736d38af8b86575eb9`. Build products and dependencies are
excluded. This tree contains 986 compared files, 114,362 significant lines and
101,974 unique significant lines.

| Measure                                                    | Private predecessor | Public upstream |
| ---------------------------------------------------------- | ------------------: | --------------: |
| Compared files                                             |               1,861 |             859 |
| Significant lines                                          |             185,273 |          66,509 |
| Identical significant lines                                |         524 (0.51%) |     179 (0.18%) |
| Regions with six consecutive matching significant lines    |                   0 |               0 |
| Files with at least 10% three-line-window overlap          |                   0 |               0 |
| Shared distinctive identifiers, out of 2,756 declared here |                 103 |              38 |

There are no three-line file matches against the private predecessor. Against
the public upstream, one three-line window appears in the existing public
`apps/server/src/modules/claude-code/tools.ts` (one of 143 windows, 0.70%). That
file is unchanged in this expansion; the match is conventional tool argument
handling. Isolated lines and shared identifiers are not treated as evidence of
copying by themselves.

The checks look for matching sequences and shared identifiers. They do not
prove absence of copying, derivation or legal risk. Behavioural requirements
were deliberately informed by an earlier system; process limitations are
recorded in [PROCESS.md](PROCESS.md).

## Earlier release

The 2026-10-14 comparison at `v2.0.0-beta.1` found 411 identical significant
lines (0.43%), no six-line regions and no three-line file matches against the
private predecessor. Those figures describe that earlier tree only.
