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
 * a rebuild of unchanged sources yields byte-identical bytes — diffable,
 * cacheable, checksummable. Runs after `build.mjs`; wire both ahead of the
 * host's build so the zip can never describe a build older than the source.
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
  throw new Error("dist has no manifest.json — run `node build.mjs` first");
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
console.log(`extension packaged → ${out} (v${version}, ${files.length} files, ${zip.length} B)`);
