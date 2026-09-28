# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

An [Agent Skill](https://agentskills.io) package: markdown, plus one runnable tree under
`assets/extension/`. There is no `package.json` at the root and nothing here executes as part of the skill.
It teaches an agent to build a **Chrome MV3** connector for a web service with no usable public API: a
MAIN-world tap on the page's own `fetch` and XHR, a relay that replays the page's own auth headers, a service
worker that polls one host endpoint, a bounded offline buffer, a PIN pairing screen, and a diagnostics
ladder. The host app's side is a contract, not a template.

Keep the two straight: the commands and code in `references/` and in `assets/extension/` describe the
extension the agent will generate, not this repository. The `npm i`, `node build.mjs`, `node package.mjs`,
`npx vitest` and `npx tsc` invocations in `build-and-package.md` and `tests.md` run in the generated project,
or in a throwaway copy of `assets/extension/` when the templates themselves are being checked. The host probe
in `adaptation.md` runs in the host app. `assets/extension/package.json` is the generated extension's
manifest of record for its own version; it is not this repository's.

The skill was written by the engineer who has shipped this module; the earlier implementation it was audited
against was a connector extension carrying one service's data into a host app.
`references/provenance.md` is the ledger of that audit: five defects fixed and how the templates verify them,
seven choices kept deliberately with the reason each is safe, and five things designed here that have never
run in production. That file is the rationale layer: read it before "simplifying" anything.

## Structure

- `SKILL.md`: entry point, loaded whole on every activation, so it stays between 130 and 160 lines, the
  closing index line aside. The frontmatter `description` is the trigger surface; the body carries the
  architecture diagram, six **critical facts**, six **hard rules**, the quick-start order, the **reference
  directory table** mapping trigger keywords to files, and a closing line linking the skills index.
- `README.md`: the human-facing front door, in the section order of the skill standard: install, activation,
  the file table, the six non-negotiables, requirements, security, verification, the *Not this* table,
  contributing.
- `references/*.md`: one topic per file, loaded on demand. `adaptation.md` (the seam contract) and
  `architecture.md` (contexts, credential rules, cadence) are the design entry points; `main-world-tap.md`,
  `relay.md`, `service-worker-loop.md`, `sync-engine.md`, `offline-queue.md`, `host-client.md` and
  `diagnostics.md` carry the runtime; `server-contract.md` and `adapter-seam.md` carry the two seams;
  `pairing-ui.md`, `popup-and-strings.md` and `build-and-package.md` carry the surfaces and the build;
  `tests.md` the suites; `operations.md` the runbook; `provenance.md` the audit.
- `assets/extension/`: the runnable copy of everything the references quote, so a target project starts from
  a tree that already builds, typechecks and passes its tests.
- `evals/`: `prompts.md` holds what an operator types after installing, in their words; the first prompt
  is the agent eval run before every release. Every other file there is one eval run: measured frontmatter
  that is never edited, then the notes of the person who ran it. Add a prompt rather than rewording one that
  has results. The procedure is section 10 of the index's STANDARD.md.
- `.github/workflows/agent-eval.yml`: the caller of the index's reusable eval workflow, copied verbatim from
  section 10 of the standard and run on every published release and on a maintainer's dispatch. It is the
  same in every skill; never edit it, and never add a trigger on `push` or `pull_request`.

## Editing conventions

- **Code blocks name their destination on the first line** as a comment, for example
  `// extension/src/background/engine.ts`, `<!-- extension/src/popup/popup.html -->`. The path is where the
  file lands in the host repo, under `extension/`, which is one level above the path inside
  `assets/extension/`. That line is what makes a block extractable; it is not part of the file, which matters
  for `manifest.json` and `package.json`, where a comment would not parse.
- **A template block is the asset file, quoted.** Below its destination line, every `ts`, `js`, `json`,
  `html` and `markdown` block in `references/` is byte-identical to the file it names in
  `assets/extension/`. Change one and change the other in the same commit. To check the whole tree:

  ```bash
  python3 - <<'EOF'
  import glob, os
  FENCE = chr(96) * 3
  assets = {}
  for p in glob.glob('assets/extension/**/*', recursive=True):
      if os.path.isfile(p) and p.split('.')[-1] in ('ts','js','mjs','json','html','md'):
          assets[p] = open(p).read().strip()
  for f in sorted(glob.glob('references/*.md')):
      lines, inb = open(f).read().split(chr(10)), False
      for i, l in enumerate(lines):
          if l.startswith(FENCE):
              if not inb:
                  inb, lang, start = True, l[3:], i + 2   # skip the destination line
              else:
                  inb = False
                  if lang in ('ts','js','json','html','markdown'):
                      body = chr(10).join(lines[start:i]).strip()
                      if body and not any(body in v for v in assets.values()):
                          print('drifted:', f, start)
  EOF
  ```

  The two blocks with no asset behind them are the host's `package.json` scripts in `build-and-package.md`
  and the host's validator sketch in `server-contract.md`; both name a destination in the host app.
- **The assets are checked by running them.** Copy `assets/extension/` to a scratch directory, then

  ```bash
  npm i -D esbuild typescript vitest @types/node
  node build.mjs && node package.mjs
  npx vitest run --dir test        # 9 files, 70 tests
  npx tsc --noEmit -p tsconfig.json --noUncheckedIndexedAccess
  ```

  Do not add `baseUrl` to `tsconfig.json`: TypeScript 7 removed it and fails the whole config with `TS5102`.
  Two suites, `content-script-format.test.ts` and `package.test.ts`, read `dist/` and the zip, so run the
  build before vitest or they fail for the wrong reason.
- **Identifiers are shared across files.** `ConnectorAdapter`, `ConnectorRecord`, `Command`, `Ack`,
  `SyncRequest`, `SyncResponse`, `PairRequest`, `PairResponse`, `Engine`, `EngineDeps`, `RecordQueue`,
  `PortRegistry`, `Serial`, `SyncClient`, `SyncPayload`, `Pairing`, `LastPost`, `Store`, `chromeStore`,
  `diagnose`, `isContextInvalidated`, `accountFor`, `STRINGS`, `t`, `ADAPTERS`, `stubAdapter`,
  `TAP_CAPTURE`, `TAP_AUTH_HEADERS`, the constants `MAX_RECORDS_PER_POST`, `MAX_QUEUE_ITEMS`, `ALARM`,
  `KEEPALIVE_PORT`, `DEFAULT_POLL_MS`, `SLOW_POLL_MS`, `RELAY_TIMEOUT_MS`, and the build defines
  `__AGENT_VERSION__`, `__TAP_CAPTURE__`, `__TAP_AUTH_HEADERS__` appear in several references and in the
  assets. Rename in all of them or none.
- **Keep the three tables in sync** with `references/` and `assets/`: the reference directory in `SKILL.md`,
  the quick-start list in `SKILL.md`, and the file table in `README.md`. Links are relative:
  `[x.md](references/x.md)` from `SKILL.md`, `[x.md](x.md)` between references.
- **Do not remove the odd-looking parts.** `credentials: "omit"` on both the host and the service calls, the
  channel-name constants duplicated between the tap and the relay instead of imported, the hand-written
  `chrome.d.ts`, the popup that never messages the worker, `info` excluded from the diagnostics summary,
  unknown command kinds left unacknowledged, the alarm read with `alarms.get` before it is created, and the
  batch id keyed on content rather than time: each is a ledger entry in `provenance.md` or a documented
  judgement call. Check it before touching one.
- **The numbers that remain are load-bearing.** 70 tests across 9 suites, the 2,000-record buffer, the 200
  records per post, the 20 s keepalive ping, the 30 s default poll and the 60 s slow poll, the 30 s relay
  timeout, `minimum_chrome_version: 120`, the roughly 10 MB `chrome.storage.local` ceiling and the roughly
  30 s worker eviction. They were verified against this repository, against Chrome's documented limits, or
  are design parameters the next implementation needs. Do not restate them loosely and do not add new ones.
  Figures describing the earlier implementation's deployment do not appear anywhere.
- **Mark additions as additions.** Anything designed in the skill and never run in the earlier
  implementation belongs in *Added* in `provenance.md`, stated as such, or in `operations.md` under *Not
  built here* as a design. The skill's credibility is that it distinguishes the two.
- **Never present the non-negotiables as optional.** The conditional alarm, the refusal to fetch without a
  service tab, the port registry, acks on the next post, per-record validation on the host and the write gate
  are hard rules in `SKILL.md` and non-negotiables in `README.md`; keep them that way everywhere, including
  in code comments.
- **What the host renames, and what it must not.** The canonical vocabulary (service, account, host app,
  connection, pairing, pull, command) is renamed once through the table in `adaptation.md`. The wire and the
  authoring contract are not renamed: the field names in `wire.ts`, `externalId`, `externalRef`, `batchId`,
  `pollMs`, `agentVersion`, the storage keys, the build defines and the two endpoint shapes are what both
  sides agree on.
- **Plain punctuation, and prose wrapped at 110 columns.** No em-dash, en-dash, arrow, middle dot or smart
  quote anywhere, including inside code comments and UI strings, because the templates are read as prose too.
  Diagrams are ASCII. Table rows and commands stay on one line.
- **No attribution to tools.** No generated-by lines, no assistant trailers and no session links, in files or
  in commit messages.
