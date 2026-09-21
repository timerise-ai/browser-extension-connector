# Build and package

Dependency-free apart from `esbuild` (and `vitest` + `typescript` for the
checks). Five bundles, two formats, one deterministic zip.

## Layout inside the host repo

```
extension/
  manifest.json  PERMISSIONS.md  package.json  tsconfig.json  chrome.d.ts
  build.mjs      package.mjs
  src/  adapters/ background/ content/ inject/ options/ popup/ shared/ wire.ts
  test/
  dist/          (built)      release/connector-extension.zip (packed)
```

Wire into the host's scripts. The pack step runs **before** the host's own
build, so the zip can never describe a build older than the files it packs, and an
artefact in git would drift silently:

```json
// package.json (the host repo), scripts
"ext:build": "node extension/build.mjs",
"ext:package": "node extension/build.mjs && node extension/package.mjs",
"ext:typecheck": "tsc --noEmit -p extension/tsconfig.json",
"build": "node extension/build.mjs && node extension/package.mjs && <host build>"
```

## build.mjs

```js
// extension/build.mjs
import { build } from "esbuild";
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Extension build. Five independent bundles, because MV3 loads them in
 * different contexts and they may not share a module graph:
 *
 *   background  service worker   the sync loop; no DOM
 *   content     isolated world   relays taps; sees `chrome.*`, not the page
 *   inject      MAIN world       sees the page's `fetch`; NO `chrome.*` at all
 *   options     extension page   pairing and diagnostics
 *   popup       extension page   read-only status
 *
 * `inject` must never import from the others: a stray `chrome.runtime`
 * reference in MAIN-world code throws on the page and takes the tap down
 * silently. Its two inputs, the capture pattern and the header allowlist,
 * are read from the adapter here and injected as defines.
 *
 * Bundled, not transpiled-in-place: MV3 has no bare-specifier resolution, so
 * every import must be inlined. Type-only imports erase at build time, which
 * is why the extension carries no validator and no host runtime.
 */
const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "dist");
mkdirSync(out, { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** The adapter's tap configuration, evaluated once at build time. */
async function tapConfig() {
  const bundled = await build({
    entryPoints: [join(root, "src/adapters/tap-config.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  const code = bundled.outputFiles[0].text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  if (typeof mod.TAP_CAPTURE !== "string" || !Array.isArray(mod.TAP_AUTH_HEADERS)) {
    throw new Error("src/adapters/tap-config.ts must export TAP_CAPTURE (string) and TAP_AUTH_HEADERS (string[])");
  }
  return { capture: mod.TAP_CAPTURE, headers: mod.TAP_AUTH_HEADERS.map((h) => String(h).toLowerCase()) };
}
const tap = await tapConfig();

const common = {
  bundle: true,
  target: "chrome120",
  platform: "browser",
  logLevel: "info",
  minify: process.env.NODE_ENV === "production",
  sourcemap: process.env.NODE_ENV === "production" ? false : "inline",
  define: {
    __AGENT_VERSION__: JSON.stringify(pkg.version),
    __TAP_CAPTURE__: JSON.stringify(tap.capture),
    __TAP_AUTH_HEADERS__: JSON.stringify(tap.headers),
  },
};

/**
 * Format is per target, and getting it wrong is silent. Content scripts are
 * loaded as **classic scripts** (there is no way to ask Chrome for a module),
 * so a single top-level `export` in the bundle is a `SyntaxError` and the
 * whole file never runs. Nothing logs it where anyone looks. `iife` also keeps
 * the tap's own bindings out of the page it is injected into. The others are
 * genuinely modules: `background.js` is declared `"type": "module"` in the
 * manifest, and the two pages load their scripts with `type="module"`.
 */
const CLASSIC = { ...common, format: "iife" };
const MODULE = { ...common, format: "esm" };

await Promise.all([
  build({ ...MODULE, entryPoints: [join(root, "src/background/index.ts")], outfile: join(out, "background.js") }),
  build({ ...CLASSIC, entryPoints: [join(root, "src/content/relay.ts")], outfile: join(out, "content.js") }),
  build({ ...CLASSIC, entryPoints: [join(root, "src/inject/net-tap.ts")], outfile: join(out, "net-tap.js") }),
  build({ ...MODULE, entryPoints: [join(root, "src/options/options.ts")], outfile: join(out, "options.js") }),
  build({ ...MODULE, entryPoints: [join(root, "src/popup/popup.ts")], outfile: join(out, "popup.js") }),
]);

// The manifest's version must track package.json, or telemetry reports a
// build number nobody can map back to a commit.
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
copyFileSync(join(root, "src/options/options.html"), join(out, "options.html"));
copyFileSync(join(root, "src/popup/popup.html"), join(out, "popup.html"));

console.log(`extension built to ${out}`);
```

Format is per target and getting it wrong is silent. Content scripts are
loaded as classic scripts (there is no way to ask Chrome for a module), so
`iife` for `content.js` and `net-tap.js`, `esm` for the worker (declared
`"type": "module"`) and the two pages (`<script type="module">`). The tap's
config is read from the adapter by bundling `tap-config.ts` in memory and
importing it as a data URL, so the tap bundle itself keeps zero imports.

## package.mjs

```js
// extension/package.mjs
import { deflateRawSync } from "node:zlib";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Packs `dist/` into the zip the host app links to for self-hosted installs.
 *
 * Written by hand rather than shelling out to `zip`: the binary is not on
 * every CI image, and a build step that works locally and silently produces
 * no download in production is exactly the failure this module is prone to.
 *
 * The output is **deterministic** (sorted entries, fixed 1980 timestamps), so
 * a rebuild of unchanged sources yields byte-identical bytes, diffable,
 * cacheable, checksummable. Runs after `build.mjs`; wire both ahead of the
 * host's build, so the zip can never describe a build older than the files it packs.
 * `EXTENSION_ZIP_OUT` overrides the destination.
 */
const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const out = process.env.EXTENSION_ZIP_OUT ?? join(root, "release", "connector-extension.zip");

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Every file under `dir`, sorted, with zip-style forward-slash names. */
function walk(dir, base = dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory()
        ? walk(full, base)
        : [{ name: relative(base, full).split(sep).join("/"), body: readFileSync(full) }];
    });
}

const files = walk(dist);
if (!files.some((f) => f.name === "manifest.json")) {
  // Chrome reads the manifest from the archive root; a zip without one
  // installs as nothing and says little about why.
  throw new Error("dist has no manifest.json: run `node build.mjs` first");
}

// 1980-01-01 00:00, the zero point of the DOS timestamp fields.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const locals = [];
const central = [];
let offset = 0;

for (const file of files) {
  const name = Buffer.from(file.name, "utf8");
  const deflated = deflateRawSync(file.body, { level: 9 });
  // Deflate only when it actually helps; a tiny file can grow.
  const stored = deflated.length >= file.body.length;
  const body = stored ? file.body : deflated;
  const method = stored ? 0 : 8;
  const crc = crc32(file.body);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(file.body.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28); // extra
  locals.push(local, name, body);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4); // version made by
  entry.writeUInt16LE(20, 6); // version needed
  entry.writeUInt16LE(0, 8);
  entry.writeUInt16LE(method, 10);
  entry.writeUInt16LE(DOS_TIME, 12);
  entry.writeUInt16LE(DOS_DATE, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(body.length, 20);
  entry.writeUInt32LE(file.body.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt16LE(0, 30); // extra
  entry.writeUInt16LE(0, 32); // comment
  entry.writeUInt16LE(0, 34); // disk
  entry.writeUInt16LE(0, 36); // internal attrs
  entry.writeUInt32LE(0o644 << 16, 38); // external attrs
  entry.writeUInt32LE(offset, 42);
  central.push(entry, name);

  offset += local.length + name.length + body.length;
}

const cd = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4); // disk
eocd.writeUInt16LE(0, 6); // disk with cd
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cd.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20); // comment

mkdirSync(dirname(out), { recursive: true });
const zip = Buffer.concat([...locals, cd, eocd]);
writeFileSync(out, zip);

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
console.log(`extension packaged to ${out} (v${version}, ${files.length} files, ${zip.length} B)`);
```

Hand-rolled because the `zip` binary is not on every build image, and a step
that works locally and silently produces no download in production is exactly
the failure this module is prone to. Sorted entries and fixed timestamps make
it deterministic: unchanged sources yield identical bytes.

## chrome.d.ts

```ts
// extension/chrome.d.ts
/**
 * The slice of the MV3 API this extension actually uses.
 *
 * Hand-written rather than `@types/chrome`, for two reasons. The build stays
 * dependency-free; and a hand-written surface is a **list of what we touch**,
 * which is exactly the review question the Web Store asks. Adding an API here
 * is a visible diff, the same property `PERMISSIONS.md` is trying to preserve.
 * Swap for `@types/chrome` if your host already has it; nothing below conflicts.
 */
declare namespace chrome {
  namespace runtime {
    type Port = {
      name: string;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: { addListener(cb: (message: never) => void): void };
      onDisconnect: { addListener(cb: () => void): void };
    };
    const lastError: { message?: string } | undefined;
    function connect(info: { name: string }): Port;
    function sendMessage(message: unknown): Promise<unknown>;
    function getURL(path: string): string;
    /** Opens the options page. The only navigation the popup performs itself. */
    function openOptionsPage(): Promise<void>;
    const onMessage: {
      addListener(
        cb: (
          message: never,
          sender: { tab?: { id?: number }; origin?: string },
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
    };
    const onConnect: { addListener(cb: (port: Port) => void): void };
    const onInstalled: { addListener(cb: (details: { reason: string }) => void): void };
  }

  namespace storage {
    const local: {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
  }

  namespace alarms {
    function create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): void;
    function get(name: string): Promise<{ name: string } | undefined>;
    function clear(name: string): Promise<boolean>;
    const onAlarm: { addListener(cb: (alarm: { name: string }) => void): void };
  }

  /**
   * `tabs.create` only: opening a URL needs no `tabs` permission, and none is
   * requested. Nothing here reads, lists or inspects the user's tabs.
   */
  namespace tabs {
    function create(props: { url: string }): Promise<{ id?: number }>;
  }

  namespace permissions {
    function request(perms: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    function contains(perms: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  }
}

/** Injected by the build from `package.json`; reported to the host as telemetry. */
declare const __AGENT_VERSION__: string;
/** Injected by the build from the adapter: the URL pattern the tap captures. */
declare const __TAP_CAPTURE__: string;
/** Injected by the build from the adapter: request headers the tap records for replay. */
declare const __TAP_AUTH_HEADERS__: string[];
```

Hand-written rather than `@types/chrome`: the build stays dependency-free, and
the file is a **list of what we touch**, which is the review question the Web Store
asks. Adding an API here is a visible diff. Swap for `@types/chrome` if the host
already has it; nothing conflicts.

## tsconfig.json and package.json

```json
// extension/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "chrome.d.ts"]
}
```

If the host's root `tsconfig` fits, `extends` it and keep only `lib`,
`types` and `include`. `"types": ["node"]` is for the build scripts and the
tests, not the extension code. There is no `baseUrl`: TypeScript 7 removed the
option and fails the whole config with `TS5102`, verified against `tsc 7.0.2`.
Nothing here needs it, because every import is relative.

```json
// extension/package.json
{
  "name": "browser-extension-connector",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Chrome MV3 connector: observes and acts on an external web service from the user's own signed-in session, syncing with a host app."
}
```

The `version` here is what the manifest and `__AGENT_VERSION__` report. Bump
it on every release; a machine on a stale build is otherwise invisible.

## Versioning and release

1. Bump `package.json` version.
2. `node build.mjs` writes `dist/`; `node package.mjs` writes the zip.
3. Run the tests ([tests.md](tests.md)): the format and zip tests read `dist/`.
4. Upload `dist/` (zipped) to the Web Store, or serve the zip from the host.

## Checklist

- [ ] Content scripts `iife`, everything else `esm`
- [ ] `__AGENT_VERSION__`, `__TAP_CAPTURE__`, `__TAP_AUTH_HEADERS__` all defined
- [ ] Manifest version rewritten from `package.json`
- [ ] Pack step wired ahead of the host build
