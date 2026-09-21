import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The zip is written by hand (`package.mjs`), so nothing but a test stands
 * between a malformed central directory and a user downloading an archive
 * Chrome refuses. Reading it back with `node:zlib` alone keeps the check
 * honest: it never consults the writer's own idea of the format.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const zipPath = process.env.EXTENSION_ZIP_OUT ?? join(root, "release", "connector-extension.zip");

/** Read the archive through its central directory, the way an unzipper does. */
function readEntries(zip: Buffer): Map<string, Buffer> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd, "no end-of-central-directory record").toBeGreaterThan(-1);
  const count = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = zip.readUInt16LE(cursor + 10);
    const compressed = zip.readUInt32LE(cursor + 20);
    const uncompressed = zip.readUInt32LE(cursor + 24);
    const nameLen = zip.readUInt16LE(cursor + 28);
    const extraLen = zip.readUInt16LE(cursor + 30);
    const commentLen = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localName = zip.readUInt16LE(localOffset + 26);
    const localExtra = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const body = zip.subarray(start, start + compressed);
    const content = method === 0 ? Buffer.from(body) : inflateRawSync(body);
    expect(content.length, `${name} declares a length it does not have`).toBe(uncompressed);
    entries.set(name, content);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Built here rather than skipped: a self-skipping test reports green on the day it matters. */
function packed(): Buffer {
  if (!existsSync(zipPath) || statSync(zipPath).mtimeMs < statSync(join(root, "package.mjs")).mtimeMs) {
    execFileSync(process.execPath, [join(root, "build.mjs")], { stdio: "ignore" });
    execFileSync(process.execPath, [join(root, "package.mjs")], { stdio: "ignore" });
  }
  return readFileSync(zipPath);
}

describe("extension zip", () => {
  it("reads back as a valid archive with the manifest at its root", () => {
    const entries = readEntries(packed());
    const manifest = entries.get("manifest.json");
    expect(manifest, "manifest.json is not at the zip root").toBeDefined();
    const parsed = JSON.parse(manifest!.toString("utf8"));
    expect(parsed.manifest_version).toBe(3);
    expect(parsed.version).toBe(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
    // Every file the manifest names must be in the archive — a missing
    // service worker is an extension that installs and then does nothing.
    const named = [
      parsed.background.service_worker,
      parsed.options_page,
      parsed.action.default_popup,
      ...parsed.content_scripts.flatMap((s: { js: string[] }) => s.js),
    ];
    for (const file of named) expect(entries.has(file), `${file} missing from zip`).toBe(true);
  });

  it("matches the built directory byte for byte", () => {
    const entries = readEntries(packed());
    for (const [name, content] of entries) {
      expect(content.equals(readFileSync(join(root, "dist", name))), `${name} differs`).toBe(true);
    }
  });
});
