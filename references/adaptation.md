# Adaptation

Where this skill touches the host, and how to fill each seam before writing a
line. The extension is a separate package with its own build; the host is
touched only through the server contract and the strings.

## The contract for this skill

| Seam | The skill ships | The host supplies |
|---|---|---|
| Record kinds | a generic envelope; `kind` is a string | its kinds and per-kind payload schemas, on both sides of the wire |
| Pull kinds, command kinds | `pull(kind, ...)`, `execute(command)` | the vocabulary and what each does |
| Adapter | `ConnectorAdapter` + a stub | one adapter per service, as its own skill |
| Host endpoints | the contract in [server-contract.md](server-contract.md) | routes, staging, links, command queue, cron, in its idiom |
| Auth to host | per-pairing bearer token in the body | minting, hashing, revocation, PIN |
| Auth to service | header allowlist + same-origin replay | the allowlist (adapter); one relay line for cookie auth |
| Tenant scope | none in the extension | derived from request host / session / token |
| Strings | `strings.ts` keys with English defaults | its language |
| Styling | ids, class names, structure of two small pages | its CSS |
| Build | esbuild scripts, `chrome.d.ts` | scripts in `package.json`; optionally `@types/chrome` |
| Tests | vitest suites | its runner config |
| Distribution | a deterministic zip | a download page or a Web Store listing |

## Host probe

```bash
cat package.json | grep -E '"(esbuild|vitest|typescript|zod|next)"'   # what is already there
ls extension 2>/dev/null                                                 # an existing extension?
grep -rn "api/.*pair\|signage\|device token" src | head                  # a pairing idiom to mirror
```

If the host already has a device-pairing idiom (screens, kiosks, printers),
mirror it: same PIN rules, same token hashing, same "paused answered with
200". One pairing idiom in a codebase, not two.

## The rename

The skill's vocabulary is deliberately plain. Rename once, everywhere, before
generating:

| Skill says | Your host might say |
|---|---|
| service | portal, provider, marketplace, platform |
| account | business, workspace, location, profile |
| host app | console, dashboard, admin, backoffice |
| connection | integration, link, channel |
| pairing | enrolment, activation, device registration |
| pull | backfill, import, archive walk, refresh |
| command | job, action, task |

Technical terms stay: `externalId`, `externalRef`, `batchId`, `pollMs`,
`agentVersion`.

## Order of work in a host

1. Agree record, pull and command kinds with whoever owns the host schema.
2. Implement the pair and sync endpoints to the contract; test the sync
   handler with a malformed record in a batch of good ones.
3. Copy `assets/extension/` in, rename, translate `strings.ts`, set the
   manifest hosts, write the adapter (its own skill).
4. Build, run the tests, load unpacked, pair against a local host over
   loopback.
5. Wire the pack step ahead of the host build and serve the zip.

## Checklist

- [ ] Kinds agreed and identical on both sides of the wire
- [ ] Pairing idiom mirrors the host's existing one, if any
- [ ] Rename applied everywhere at once; technical terms left alone
- [ ] `strings.ts` translated; nothing else carries a literal
- [ ] Host CSS applied to the two pages; ids and classes kept
