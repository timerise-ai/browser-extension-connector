# browser-extension-connector

[![Agent Skills](https://img.shields.io/badge/Agent_Skills-open_format-059669)](https://agentskills.io)
[![skills.sh](https://img.shields.io/badge/skills.sh-npx_skills_add-059669)](https://www.skills.sh)
[![Claude Code](https://img.shields.io/badge/Claude_Code-compatible-059669)](https://docs.claude.com/en/docs/claude-code/skills)
[![Codex CLI](https://img.shields.io/badge/Codex_CLI-compatible-059669)](https://developers.openai.com/codex/skills)
[![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-compatible-059669)](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md)

An [Agent Skill](https://agentskills.io) that teaches an agent to build a **Chrome MV3** connector for a web
service with no usable public API: an extension that observes the service's JSON traffic in the page's own
context, replays the page's own auth headers for pulls and writes, buffers what it learns when the network or
the host is away, and exchanges all of it with a host app through one polled request. The host app it syncs
with is a **Next.js App Router** app in our own use, but its side is a documented contract, so any server
that answers two endpoints will do.

**A site with no API still has a signed-in user and a browser that sees every response the site serves.** The
plumbing that turns that into a connector is a week's work; the runtime it has to live in is the rest. Chrome
evicts an idle service worker after about 30 seconds, `chrome.alarms` will not fire more often than once a
minute, a MAIN-world content script with one top-level `export` ships dead and silent, a content script
detached by an extension reload throws on every `chrome.*` call forever, and the credential that makes the
whole thing possible must never leave the tab it was captured in. This skill is that runtime, with the
service itself behind a seam.

This skill was written by the engineer who has shipped this module. The earlier implementation it was audited
against was a connector extension carrying one service's data into a host app, with an architecture note kept
alongside it recording every incident. The templates hold the properties a connector has to hold: every
response from the host handled the same way, so a command handed out on any post runs; every live relay port
kept, so two open tabs are two ports; acks riding the next post, so a browser closing mid-command loses
nothing; a buffer that is bounded, drops oldest and reports the drop; records validated one by one, so one
bad record cannot wedge the channel; and a credential read only from the page's own requests, replayed only
to the origin it came from, never persisted and never posted to the host. The suites and the build state each
one, and [`references/provenance.md`](references/provenance.md) has the record.

## Install

One command, via the [skills.sh](https://www.skills.sh) CLI, which installs the skill into every
skills-compatible agent it detects, including Claude Code, Codex CLI and Gemini CLI:

```bash
npx skills add timerise-ai/browser-extension-connector
```

Name the agents instead with `-a`, for example
`npx skills add timerise-ai/browser-extension-connector -a claude-code -a codex`.

### Manual install

Nothing here is Claude-specific: the skill is a plain [Agent Skills](https://agentskills.io) folder,
`SKILL.md` plus markdown references and a runnable `assets/extension/` tree, with no file that calls a model,
so cloning it into an agent's skills directory is all an install is. For Claude Code:

```bash
git clone https://github.com/timerise-ai/browser-extension-connector.git ~/.claude/skills/browser-extension-connector
```

To scope it to a single project instead, clone it into that project's `.claude/skills/` directory. For
another agent, clone into that agent's skills directory, or symlink the Claude Code copy so one `git pull`
updates every agent:

```bash
mkdir -p ~/.agents/skills
ln -s ~/.claude/skills/browser-extension-connector ~/.agents/skills/browser-extension-connector
```

Update the skill with `git pull` in its directory. The current release is **0.1.1**. See
[CHANGELOG.md](CHANGELOG.md). The [skills index](https://github.com/timerise-ai/skills) lists the other
Timerise Skills and how to install them all at once.

## Activation

The skill activates automatically when a task matches its description: connecting a third-party site that
offers no API, no OAuth and no export to your own app; reading data out of a service from the user's own
signed-in session; writing something back into it; or hardening a connector extension that already exists,
where the service worker dies, the alarm never fires, the content script shipped dead, records go missing or
commands are marked failed without having run. Invoke it explicitly with `/browser-extension-connector` in
Claude Code, `$browser-extension-connector` in Codex CLI, or from `/skills` in Gemini CLI.

Each host matches a task against the description its own way, so invoke the skill explicitly on a first run
rather than assuming it fired. Only `SKILL.md` is read up front; the `references/` files load on demand, so
the skill stays cheap in context until a topic is actually needed.

## What's inside

| File | Contents |
|---|---|
| `SKILL.md` | Entry point: architecture diagram, six critical facts, six hard rules, quick start, and the reference directory |
| `references/adaptation.md` | The seam contract with the host app: record, pull and command kinds, the host probe, the rename table, the order of work |
| `references/architecture.md` | The three execution contexts and why each exists, the credential rules, why it polls, the honest ceiling on the cadence |
| `references/manifest-and-permissions.md` | The manifest, every permission with its rationale, what is deliberately absent, single purpose, Web Store versus self-hosted |
| `references/main-world-tap.md` | The MAIN-world tap: patching the page's `fetch` and XHR, what it captures, the header fingerprint, config injected at build time |
| `references/relay.md` | The relay: port and keepalive ping, replaying the page's own auth headers, orphaned contexts, the cross-context message contract |
| `references/service-worker-loop.md` | Worker plumbing: the alarm that must not be recreated, the port registry, bootstrap, message routing, constants |
| `references/sync-engine.md` | The loop's logic: the behaviour contract, one exchange path for every post, commands, acks, the pull step, backoff |
| `references/offline-queue.md` | The bounded buffer, the serial lane, and routing records to the pairing bound to their account |
| `references/host-client.md` | The host client, the four failure classes, stored pairings and last-post state |
| `references/diagnostics.md` | The test-connection ladder, run as a real poll, and what each rung tells the user |
| `references/server-contract.md` | What the host must implement: the wire types, the pair and sync endpoints, directives, health, retention |
| `references/adapter-seam.md` | The `ConnectorAdapter` seam a per-service adapter fills, the rules it must keep, the stub and the registry |
| `references/pairing-ui.md` | The options page: the PIN flow, the origin permission request, test connection, unpair |
| `references/popup-and-strings.md` | The read-only popup and the strings map every user-facing literal goes through |
| `references/build-and-package.md` | esbuild with two formats, the deterministic zip, `chrome.d.ts`, the tsconfig, the release order |
| `references/tests.md` | The nine suites, 70 tests, what each one pins, and how to test an adapter |
| `references/operations.md` | The runbook: what the host must show per connection, silence, kill switch, extension reloads |
| `references/provenance.md` | The engineering ledger: what the audit of the earlier implementation changed and how the templates verify it, what was kept deliberately, and what is new in the skill |
| `assets/extension/` | The runnable extension tree the references quote: sources, the hand-written `chrome.d.ts`, the build and pack scripts, and the nine test suites |

The seam is the table at the top of [`references/adaptation.md`](references/adaptation.md), and it bounds
three things. The **service** sits behind `ConnectorAdapter`, so a service changing its shape is an extension
release and never a host deploy. The **host** sits behind two endpoints and one shared file of wire types,
so the routes, the staging schema and the command queue stay in the host's own idiom. The **vocabulary**
(service, account, pairing, pull, command) is renamed once, in one table, before anything is generated. The
extension's own auth, styling and strings are the host's too: `strings.ts` carries every literal, and the two
small pages keep their ids and class names so the host's CSS can land on them.

## The six non-negotiables

These travel with the module and are never optional. Each is stated as a hard rule in `SKILL.md` and covered
by the suites in [`references/tests.md`](references/tests.md):

1. **Never create the alarm unconditionally at startup.** `chrome.alarms.create` replaces and restarts a
   same-named alarm, so a worker that is revived often pushes its own next fire away and never polls. Check
   `alarms.get` first, and poll immediately on bootstrap.
2. **Never fall back to a worker-side fetch when no service tab is open.** The worker holds no session with
   the service, so a login page comes back, parses as zero rows, and looks exactly like a finished pull.
   Refusing is what makes the failure visible on the connection card.
3. **Never keep one "current port".** Two open tabs are two relay ports, and closing the newer one must not
   orphan the older. `PortRegistry` keeps them all and `ports.test.ts` pins the rule.
4. **Never acknowledge a command on the same post that ran it.** Acks ride the next post, so a browser that
   closes in between lets the lease expire and the command comes back instead of being lost. Three cases in
   `engine.test.ts` cover the ack path, including a post that gets no answer.
5. **Never validate a batch as a whole on the host.** One bad record must cost one record, named in
   `rejected`; a batch-level `400` keeps the whole buffer re-posting forever while the card still says
   connected.
6. **Never write into the service until the write path is verified live**, and never delete by anything but
   the id the service returned. `writeVerified` gates every writing command, and a create that returns no id
   throws rather than leaving something only a human can remove.

Everything else is the host app's: the routes, the schema, the console UI, the styling, the language, and the
adapter for the service itself.

## Requirements

- **Chrome 120 or newer.** `world: "MAIN"` in a declared content script is the whole basis of the tap.
- **Node with `esbuild`**, plus `typescript` and `vitest` for the checks. Nothing else: the build is five
  bundles in two formats and a zip written with `node:zlib`.
- **A host app that answers two endpoints**, pair and sync, to
  [`references/server-contract.md`](references/server-contract.md). Anything that can serve JSON will do.
- **One adapter per service**, written against
  [`references/adapter-seam.md`](references/adapter-seam.md) as its own skill. The tree builds and boots with
  the shipped stub, and syncs nothing until an adapter is wired.

## Security

The credential that makes a connector possible is a live session token belonging to the user, so four limits
are enforced in code rather than promised, and
[`references/architecture.md`](references/architecture.md) states them as a contract:

- Headers are read **only from requests the page itself made**, never minted, never prompted for, never read
  out of storage or the cookie jar. The allowlist is explicit and comes from the adapter.
- They are replayed **only to the origin they were captured from**, checked on every call.
- They are **never persisted**: they live in the relay's memory and die with the tab.
- They are **never sent to the host**. The sync payload is a fixed field set with nowhere to put a token.

The manifest asks for `storage`, `alarms` and the service's own hosts, and the host app's origin is requested
at pairing time through `chrome.permissions.request`. `tabs`, `cookies`, `webRequest`, `<all_urls>` and
`unlimitedStorage` are all absent on purpose, and
[`references/manifest-and-permissions.md`](references/manifest-and-permissions.md) says what each absence
costs. The alternative this is measured against, a host app holding the user's service password, works from
anywhere, forever, and usually breaks the service's terms.

## Verification

The `assets/extension/` tree is the checked copy, and every template block in `references/` is the file it
names, quoted. From that directory:

```bash
npm i -D esbuild typescript vitest @types/node
node build.mjs && node package.mjs      # five bundles, then the deterministic zip
npx vitest run --dir test                # 9 files, 70 tests
npx tsc --noEmit -p tsconfig.json --noUncheckedIndexedAccess
```

What that does and does not prove is written down in
[`references/provenance.md`](references/provenance.md): the templates compile, the suites pass and the zip
round-trips, while worker eviction, alarm timing and the tap on a live page are claims from the earlier
implementation's own history rather than from a run of this tree.

## Not this

| Not this | Use instead |
|---|---|
| A service with a partner API, OAuth or an export | That API. A connector is a workaround with real costs, and this skill says so before it starts |
| Server-side scraping with the user's stored password | Nothing here. It is a different threat model, it works from anywhere forever, and it usually breaks the service's terms |
| A one-off data export | A script pasted into DevTools, which is cheaper than an extension and stops existing afterwards |
| One service's parsers, endpoints and quirks | An adapter skill on top of this one, written against `references/adapter-seam.md` |
| The host's routes, staging tables, merge queues and console UI | The host's own idiom, to the contract in `references/server-contract.md` and the operator surface in `references/operations.md` |
| Pairing and running unattended screens in a venue | [`digital-signage`](https://github.com/timerise-ai/digital-signage), which pairs displays by PIN and plays to them |

## Contributing

Issues and pull requests are welcome here. Pure markdown, plus the runnable `assets/extension/` tree, with
nothing to install at the root; the code is checked, though. Every TypeScript, JavaScript, JSON and HTML
block names its destination on the first line and is the shipped asset file quoted verbatim below that line,
so a change to a template is a change to both, and the suites and the build in *Verification* above are what
proves it. Claims in this skill are meant to be verifiable: if you change a factual claim, say how you
verified it, whether against Chrome's extension documentation, a reproduction in a real profile, the
TypeScript or esbuild release notes, or a run of the suites.

Adding, removing or renaming a file in `references/` or `assets/` means updating the quick start and the
reference directory table in `SKILL.md`, the file table above, and any relative cross-links.
[`references/provenance.md`](references/provenance.md) is the ledger that must stay truthful: read it before
simplifying anything, and add an entry for any change to a template, whether it fixes a defect, keeps an
earlier choice on purpose or adds something that has never run in production. Commits follow Conventional
Commits and releases follow [STANDARD.md](https://github.com/timerise-ai/skills/blob/main/STANDARD.md) in the
index; `CLAUDE.md` carries the full editing conventions.

## Part of the Timerise Skills

This is one of the [Timerise Skills](https://github.com/timerise-ai/skills): modules for **Next.js App
Router** apps written by our own senior engineers from the modules they have shipped, not synthetic, each
published as its own repository and indexed there. They share one layout, so an agent that has read one knows
how to read the next: a `SKILL.md` entry point, `references/` loaded on demand, and a seam contract carrying
the module's non-negotiables.

## Author

Built and maintained by [Timerise](https://timerise.ai).

## License

MIT. See [LICENSE](LICENSE).
