# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
