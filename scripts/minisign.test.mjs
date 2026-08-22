import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyMinisign } from "./minisign.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(root, "ghostty-vt.pin.json"), "utf8"));
const wasm = readFileSync(join(root, pin.variant));
const { signature, publicKey } = pin.minisign;

describe("verifyMinisign", () => {
  it("accepts the pinned artifact", () => {
    const comment = verifyMinisign(wasm, signature, publicKey);
    assert.match(comment, /file:ghostty-vt\.wasm/);
  });

  // A verifier that only ever succeeds is worse than none, so each way an
  // artifact can be wrong gets its own case.

  it("rejects a single flipped byte", () => {
    const tampered = Buffer.from(wasm);
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(() => verifyMinisign(tampered, signature, publicKey), /does not match/);
  });

  it("rejects a truncated artifact", () => {
    assert.throws(
      () => verifyMinisign(wasm.subarray(0, wasm.length - 1), signature, publicKey),
      /does not match/,
    );
  });

  it("rejects a signature from a key we do not trust", () => {
    // A real, well-formed minisign key — just not Ghostty's.
    const other = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    assert.throws(() => verifyMinisign(wasm, signature, other), /made by key/);
  });

  it("rejects a relabelled trusted comment", () => {
    // The global signature binds the comment, so a valid signature cannot be
    // moved onto a different filename. Anchor the match: "untrusted comment:"
    // contains "trusted comment:" as a substring.
    const relabelled = signature.replace(/^trusted comment:.*/m, "trusted comment: file:evil.wasm");
    assert.throws(() => verifyMinisign(wasm, relabelled, publicKey), /trusted comment/);
  });

  it("rejects corrupted signature bytes", () => {
    const lines = signature.split("\n");
    const raw = Buffer.from(lines[1], "base64");
    raw[40] ^= 0x01;
    lines[1] = raw.toString("base64");
    assert.throws(() => verifyMinisign(wasm, lines.join("\n"), publicKey), /does not match/);
  });

  it("rejects a malformed public key or signature", () => {
    assert.throws(() => verifyMinisign(wasm, signature, "bm90YWtleQ=="), /public key length/);
    assert.throws(() => verifyMinisign(wasm, "untrusted comment: x\nbm90\n", publicKey), /signature length/);
  });
});
