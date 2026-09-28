# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-09-28

Fix release, from scoring the prompt-1 agent eval runs against 0.1.3. Connectors built from an earlier
version should copy in `src/inject/net-tap.ts`, `src/background/ports.ts`, `src/background/queue.ts`,
`src/background/engine.ts` and `src/background/index.ts`, and the three test files that pin them.

### Fixed

- The cookie-authenticated variant could never pull: with the empty header allowlist that `relay.md`
  documents, the tap posted no session and the relay refused every request. With an empty allowlist the tap
  now posts the origin with no headers once a captured request comes back 2xx with JSON, which a login page
  does not. Pinned by the new `tap.test.ts`.
- A relay refusal (no session seen, another origin, the tab closed) reached the adapter as a bare status 0.
  `relayAnswer` in `ports.ts` now throws it with the relay's reason, as a missing service tab already did.
- Drops counted while a post was in flight were zeroed unreported. `clearDropped(reported)` subtracts what
  the post carried, inside the queue's lane.
- 76 tests across 10 suites, up from 70 across 9.

### Changed

- The quick start in `SKILL.md` says to copy `assets/extension/` verbatim and names the edits allowed, to
  install `esbuild`, `typescript`, `vitest` and `@types/node` from the registry (which is not an external
  service) and run the suites unmodified with vitest, to read the PIN and pepper from the environment with no
  default, and to hand over that nothing syncs while the browser is closed.
- `build-and-package.md` and `tests.md` forbid swapping the bundler or converting the suites to another
  runner; `server-contract.md` forbids a default PIN or pepper in tracked source; `relay.md` and
  `main-world-tap.md` state the two auth variants and that they are never mixed.

## [0.1.3] - 2026-09-28

Documentation release. The skill content is unchanged from 0.1.2.

### Changed

- The file table in `README.md` lists every file in the repository,
  `README.md`, `CHANGELOG.md`, `CLAUDE.md` and `LICENSE` included, and adds
  rows for `evals/` and the agent eval workflow.
- `CLAUDE.md` describes `evals/` and the agent eval workflow, which is the
  index's caller copied verbatim and never edited.

## [0.1.2] - 2026-09-21

Wording release. The skill content is unchanged from 0.1.1.

### Changed

- The `Not this` table in `README.md` and the `When NOT to use` list in
  `SKILL.md` name the sibling
  [`ecommerce-process-mining`](https://github.com/timerise-ai/ecommerce-process-mining)
  skill, so a request to watch how employees work lands there rather than
  here. Both skills build a Manifest V3 extension, and the boundary between
  them is what the extension is for: a service's data, or a record of the
  work.

## [0.1.1] - 2026-09-21

Wording release. The skill content is unchanged from 0.1.0.

### Added

- `SKILL.md` closes with a line linking the
  [Timerise Skills](https://github.com/timerise-ai/skills) index, so an agent that
  has the skill loaded can find the sibling skills for neighbouring modules without
  leaving the entry point.

### Changed

- `CLAUDE.md` records the closing line in the `SKILL.md` layout, and the line budget
  it states holds that line aside.

## [0.1.0] - 2026-09-21

Initial release of the `browser-extension-connector` skill: a Chrome MV3 connector
that observes and acts on a web service with no usable public API from inside the
user's own signed-in session, and exchanges records and commands with a host app
through one polled request.

### Added
- `SKILL.md` entry point: the architecture diagram, six critical facts, six hard
  rules, the quick-start order, and the reference directory table mapping trigger
  keywords to `references/`.
- `references/adaptation.md`: the seam contract with the host app, the host probe,
  the rename table from the skill's vocabulary to the host's, and the order of work.
- `references/architecture.md`: the three execution contexts and why each exists,
  the four credential rules, why the runtime polls instead of streaming, and the
  honest ceiling on the cadence.
- `references/manifest-and-permissions.md`: the manifest, a rationale per
  permission, what is deliberately absent and what each absence costs, single
  purpose, and self-hosted install versus the Web Store.
- `references/main-world-tap.md`: the MAIN-world tap over the page's own `fetch`
  and XHR, what it captures, the header fingerprint that notices a rotation
  without keeping a value, and its config injected at build time.
- `references/relay.md`: the port and its 20 s keepalive ping, replaying the
  page's own auth headers to the same origin, telling an orphaned content script
  apart from a transient failure, and the cross-context message contract.
- `references/service-worker-loop.md`: the alarm read before it is created, the
  port registry, bootstrap, message routing, and the shared constants.
- `references/sync-engine.md`: the behaviour contract, one exchange path for every
  post, commands and acks, the pull step, and backoff.
- `references/offline-queue.md`: the bounded buffer that drops oldest and reports
  the drop, the serial lane, and routing records to the pairing bound to their
  account.
- `references/host-client.md`: the host client, the four failure classes, and the
  stored pairings and last-post state.
- `references/diagnostics.md`: the test-connection ladder, run as a real poll, and
  what each rung tells the user.
- `references/server-contract.md`: the wire types, the pair and sync endpoints,
  directives and pacing, health, retention, and a reference validator shape.
- `references/adapter-seam.md`: the `ConnectorAdapter` a per-service adapter
  fills, the rules it must keep, the stub and the registry, and what observation
  cannot supply.
- `references/pairing-ui.md`: the options page, the PIN flow, the origin
  permission request, test connection, and unpair.
- `references/popup-and-strings.md`: the read-only popup and the strings map every
  user-facing literal goes through.
- `references/build-and-package.md`: esbuild with two formats, the deterministic
  zip, the hand-written `chrome.d.ts`, the tsconfig, and the release order.
- `references/tests.md`: the nine suites, 70 tests, what each one pins, and how to
  test an adapter.
- `references/operations.md`: the runbook, what the host must show per connection,
  silence with the browser open, the kill switch, and extension reloads.
- `references/provenance.md`: the engineering ledger, five defects fixed with how
  the templates verify each, seven choices kept deliberately with the reason each
  is safe, and five things designed here that have never run in production.
- `assets/extension/`: the runnable extension tree the references quote, with the
  build and pack scripts, the hand-written `chrome.d.ts`, and nine vitest suites,
  70 tests. Verified on TypeScript 7.0.2, vitest 5.0.1 and Node 22.21.1: the build
  and the zip round-trip, the suites pass, and every template compiles under
  `strict` and `--noUncheckedIndexedAccess`.
- The properties the templates hold: every response from the host handled the same
  way, every live relay port kept, acks riding the next post, a bounded buffer
  whose drops reach the host, records validated one by one, and a credential read
  only from the page's own requests, replayed only to its own origin, never
  persisted and never sent to the host.
- `README.md`: install, activation, the file table, the six non-negotiables,
  requirements, security, verification, the *Not this* table and the contributing
  conventions.
- `CLAUDE.md`: editing conventions for this repository.
- `LICENSE`: MIT.
