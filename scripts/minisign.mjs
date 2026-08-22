// Minisign signature verification.
//
// Implemented directly rather than shelling out to minisign or taking a
// dependency: the format is a thin wrapper over Ed25519 and Node has
// everything needed. Kept separate from fetch-wasm.mjs so it can be tested.

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

/**
 * Verify a minisign signature over `data`.
 *
 * This is what chains trust to Ghostty's signing key rather than to whatever
 * the CDN happened to serve. Implemented directly because minisign is a thin
 * format over Ed25519 and Node has everything needed — a build-time signature
 * check is not worth a dependency.
 *
 * Public key:  "Ed" | key id (8) | Ed25519 public key (32)
 * Signature:   alg  | key id (8) | Ed25519 signature (64)
 * where alg is "ED" when the payload is prehashed with BLAKE2b-512, "Ed" when
 * the signature covers the raw bytes.
 */
export function verifyMinisign(data, signatureFile, publicKeyBase64) {
  const pk = Buffer.from(publicKeyBase64, "base64");
  if (pk.length !== 42) throw new Error(`bad minisign public key length ${pk.length}`);
  const pkId = pk.subarray(2, 10);
  const pkBytes = pk.subarray(10);

  const lines = signatureFile.split("\n").filter((l) => l.trim() !== "");
  const sigLine = lines.find((l) => !l.startsWith("untrusted comment:") && !l.startsWith("trusted comment:"));
  const trustedComment = (lines.find((l) => l.startsWith("trusted comment:")) ?? "")
    .replace(/^trusted comment:\s?/, "");
  const globalLine = lines[lines.length - 1];
  if (!sigLine) throw new Error("no signature line in .minisig");

  const sig = Buffer.from(sigLine, "base64");
  if (sig.length !== 74) throw new Error(`bad minisign signature length ${sig.length}`);
  const alg = sig.subarray(0, 2).toString("ascii");
  const sigId = sig.subarray(2, 10);
  const sigBytes = sig.subarray(10);

  if (!sigId.equals(pkId)) {
    throw new Error(
      `signature was made by key ${sigId.toString("hex")}, expected ${pkId.toString("hex")}`,
    );
  }

  // Raw Ed25519 keys need an SPKI wrapper before Node will accept them.
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pkBytes]),
    format: "der",
    type: "spki",
  });

  const payload = alg === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (alg !== "ED" && alg !== "Ed") throw new Error(`unknown minisign algorithm ${alg}`);
  if (!verifySignature(null, payload, key, sigBytes)) {
    throw new Error("minisign signature does not match the artifact");
  }

  // The global signature binds the trusted comment (which names the file) to
  // the signature, so a valid signature cannot be relabelled onto another file.
  const global = Buffer.from(globalLine, "base64");
  if (global.length === 64) {
    const bound = Buffer.concat([sigBytes, Buffer.from(trustedComment, "utf8")]);
    if (!verifySignature(null, bound, key, global)) {
      throw new Error("minisign trusted comment is not signed by the same key");
    }
  }

  return trustedComment;
}
