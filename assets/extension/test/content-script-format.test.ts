import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Content scripts must be **classic scripts**, and the build must keep them so.
 * A bundle carrying a top-level `import` or `export` is a `SyntaxError`, and
 * Chrome's response is to run none of the file and say nothing anywhere a
 * developer looks. Two `export const` on constants that nothing imported once
 * shipped the MAIN-world tap dead: paired, polling, "healthy", capturing nothing.
 *
 * Asserted on the **built output**, not the source: `format` in `build.mjs` is
 * the thing that can be wrong. Run the build first.
 */
const distDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist");

const CONTENT_SCRIPTS = ["content.js", "net-tap.js"];
const MODULES = ["background.js", "options.js", "popup.js"];

function read(name: string): string {
  return readFileSync(join(distDir, name), "utf8");
}

describe("built bundle formats", () => {
  it.each(CONTENT_SCRIPTS)("%s is a classic script Chrome can evaluate", (name) => {
    const code = read(name);
    // Multiline: esbuild emits these at the start of a line.
    expect(code, `${name} has a top-level export, Chrome will refuse the whole file`).not.toMatch(/^export[\s{]/m);
    expect(code, `${name} has a top-level import, same failure`).not.toMatch(/^import[\s{("']/m);
  });

  it.each(MODULES)("%s is left as a module", (name) => {
    expect(read(name).length).toBeGreaterThan(0);
  });

  it("checks every content script the manifest declares", () => {
    const manifest = JSON.parse(read("manifest.json")) as { content_scripts: { js: string[] }[] };
    const declared = new Set(manifest.content_scripts.flatMap((entry) => entry.js));
    expect([...declared].sort()).toEqual([...CONTENT_SCRIPTS].sort());
  });

  it("injects the adapter's tap configuration into the MAIN-world bundle", () => {
    // esbuild names the hoisted define after the identifier in a comment, so
    // comments are stripped before looking for a bare, un-replaced reference.
    const code = read("net-tap.js").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b__TAP_(CAPTURE|AUTH_HEADERS)__\b/);
  });
});
