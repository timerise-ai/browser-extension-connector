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
