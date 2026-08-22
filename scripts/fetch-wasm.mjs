#!/usr/bin/env node
// Fetch the pinned libghostty-vt WebAssembly artifact from ghostty-org's
// commit-addressed CDN and verify it against ghostty-vt.pin.json.
//
//   node scripts/fetch-wasm.mjs                 verify, downloading if needed
//   node scripts/fetch-wasm.mjs --force         re-download even if present
//   node scripts/fetch-wasm.mjs --update <sha>  repin to a ghostty commit
//
// The artifact itself is gitignored: the pin is the committed input, the .wasm
// is a reproducible output of it.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pinPath = join(root, "ghostty-vt.pin.json");
const cdn = (commit, variant) => `https://tip.files.ghostty.org/${commit}/${variant}`;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function readPin() {
  return JSON.parse(readFileSync(pinPath, "utf8"));
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Verify the artifact really is a freestanding libghostty-vt wasm module and
 * not, say, an HTML error page that happened to hash correctly in a bad pin.
 * Cheap, and it catches a whole class of "the CDN served us garbage" bugs at
 * build time rather than at terminal-open time.
 */
function assertUsableModule(buf) {
  const mod = new WebAssembly.Module(buf);
  const exports = new Set(WebAssembly.Module.exports(mod).map((e) => e.name));
  const required = [
    "memory",
    "__indirect_function_table",
    "ghostty_type_json",
    "ghostty_wasm_alloc",
    "ghostty_wasm_free",
    "ghostty_wasm_alloc_opaque",
    "ghostty_terminal_new",
    "ghostty_terminal_vt_write",
    "ghostty_render_state_new",
    "ghostty_key_encoder_new",
  ];
  const missing = required.filter((n) => !exports.has(n));
  if (missing.length) {
    throw new Error(`artifact is missing expected exports: ${missing.join(", ")}`);
  }
  const imports = WebAssembly.Module.imports(mod);
  if (imports.length > 0) {
    throw new Error(
      `artifact declares ${imports.length} import(s); the official build is ` +
        `wasm32-freestanding and must declare none`,
    );
  }
}

async function update(commit) {
  const pin = readPin();
  const url = cdn(commit, pin.variant);
  process.stdout.write(`  fetching ${url}\n`);
  const buf = await download(url);
  assertUsableModule(buf);

  const next = {
    ...pin,
    commit,
    version: `libghostty-vt@${commit.slice(0, 7)}`,
    url,
    sha256: sha256(buf),
    bytes: buf.byteLength,
  };
  writeFileSync(pinPath, `${JSON.stringify(next, null, 2)}\n`);
  writeFileSync(join(root, pin.variant), buf);
  process.stdout.write(`  repinned to ${commit} (${buf.byteLength} bytes)\n`);
}

async function ensure({ force }) {
  const pin = readPin();
  const dest = join(root, pin.variant);

  if (!force && existsSync(dest) && statSync(dest).size === pin.bytes) {
    const have = sha256(readFileSync(dest));
    if (have === pin.sha256) {
      process.stdout.write(`  ${pin.variant} verified (${pin.commit.slice(0, 12)})\n`);
      return;
    }
  }

  process.stdout.write(`  fetching ${pin.url}\n`);
  const buf = await download(pin.url);

  const have = sha256(buf);
  if (have !== pin.sha256) {
    throw new Error(
      `checksum mismatch for ${pin.variant}\n  expected ${pin.sha256}\n  actual   ${have}`,
    );
  }
  if (buf.byteLength !== pin.bytes) {
    throw new Error(`size mismatch: expected ${pin.bytes}, got ${buf.byteLength}`);
  }
  assertUsableModule(buf);

  writeFileSync(dest, buf);
  process.stdout.write(`  ${pin.variant} downloaded and verified (${pin.commit.slice(0, 12)})\n`);
}

const args = process.argv.slice(2);
const updateAt = args.indexOf("--update");
try {
  if (updateAt !== -1) {
    const commit = args[updateAt + 1];
    if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
      throw new Error("--update requires a full 40-character ghostty commit sha");
    }
    await update(commit);
  } else {
    await ensure({ force: args.includes("--force") });
  }
} catch (err) {
  process.stderr.write(`fetch-wasm: ${err.message}\n`);
  process.exit(1);
}
