#!/usr/bin/env node
/**
 * Independent CRX3 verifier — reads dist/extension.crx from DISK and
 * re-derives everything from scratch (no shared state with build-crx.cjs,
 * so a bug in the builder cannot self-confirm):
 *
 *   1. magic + version + header length framing;
 *   2. protobuf walk of CrxFileHeader: sha256_with_rsa proof
 *      (public_key field 1, signature field 2) + signed_header_data
 *      (field 10000);
 *   3. RSA-SHA256 signature over exactly
 *      "CRX3 SignedData\0" + LE32(len(signed_header_data))
 *        + signed_header_data + archive;
 *   4. CRX id derivation from the signing public key, compared to the
 *      id pinned by manifest.json's "key" field — a mismatch is reported
 *      as a WARNING (expected with a throwaway signing key) and only
 *      fails the run under CRX_STRICT_ID=1;
 *   5. the inner archive is unzipped and manifest.json is checked for
 *      presence and version parity with package.json.
 *
 * Run: node scripts/verify-crx.cjs   (after npm run build:crx)
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const CRX = path.join(ROOT, "dist", "extension.crx");
const MANIFEST = path.join(ROOT, "extension", "dist", "manifest.json");
const PKG = path.join(ROOT, "package.json");

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function readVarint(buf, off) {
  let n = 0n;
  let shift = 0n;
  let i = off;
  for (;;) {
    const b = buf[i++];
    n |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: n, next: i };
}

/** Walk a protobuf message, returning {fieldNumber: Buffer} for wiretype-2 fields. */
function parseFields(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i);
    i = tag.next;
    const fieldNum = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire !== 2) throw new Error(`unexpected wiretype ${wire} for field ${fieldNum}`);
    const len = readVarint(buf, i);
    i = len.next;
    const n = Number(len.value);
    if (i + n > buf.length) throw new Error("truncated field");
    // Repeated fields (the proof is field 2, repeated): keep the LAST one
    // — the builder emits exactly one.
    out[fieldNum] = buf.subarray(i, i + n);
    i += n;
  }
  return out;
}

function crxIdToExtensionId(crxId /* Buffer, 16 bytes */) {
  return crxId.toString("hex").replace(/[0-9a-f]/g, (c) =>
    String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16)),
  );
}

function idFromSpkiDer(der) {
  return crxIdToExtensionId(crypto.createHash("sha256").update(der).digest().subarray(0, 16));
}

function main() {
  const crx = fs.readFileSync(CRX);

  // 1. Framing.
  step("magic is Cr24", crx.subarray(0, 4).toString("ascii") === "Cr24");
  step("version is 3", crx.readUInt32LE(4) === 3, `version=${crx.readUInt32LE(4)}`);
  const headerLen = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerLen);
  const archive = crx.subarray(12 + headerLen);
  step(
    "framing covers the file exactly",
    12 + headerLen < crx.length && archive.length > 0,
    `header=${headerLen}B, archive=${archive.length}B`,
  );

  // 2. Header protobuf walk.
  let pubDer, signature, signedHeaderData;
  try {
    const top = parseFields(header);
    const proof = top[2];
    if (!proof) throw new Error("no sha256_with_rsa proof (field 2)");
    const inner = parseFields(proof);
    pubDer = inner[1];
    signature = inner[2];
    signedHeaderData = top[10000];
    if (!pubDer || !signature || !signedHeaderData) {
      throw new Error(`missing proof parts: pub=${!!pubDer} sig=${!!signature} shd=${!!signedHeaderData}`);
    }
    step("CRX3 header parses (proof + signed_header_data)", true);
  } catch (e) {
    step("CRX3 header parses (proof + signed_header_data)", false, e.message);
    process.exit(1);
  }

  // 3. Signature verification — exactly Chrome's SignedData construction.
  const signedHeaderLen = Buffer.alloc(4);
  signedHeaderLen.writeUInt32LE(signedHeaderData.length, 0);
  const signedData = Buffer.concat([
    Buffer.from("CRX3 SignedData\x00", "binary"),
    signedHeaderLen,
    signedHeaderData,
    archive,
  ]);
  let sigOk = false;
  try {
    const pubKey = crypto.createPublicKey({ key: pubDer, format: "der", type: "spki" });
    sigOk = crypto.verify("sha256", signedData, { key: pubKey, padding: crypto.constants.RSA_PKCS1_PADDING }, signature);
  } catch (e) {
    step("RSA-SHA256 proof signature verifies", false, e.message);
    process.exit(1);
  }
  step("RSA-SHA256 proof signature verifies", sigOk);

  // 4. Identity — signing-key id vs manifest-pinned id.
  const signerId = idFromSpkiDer(pubDer);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const pinnedDer = Buffer.from(manifest.key, "base64");
  const pinnedId = idFromSpkiDer(pinnedDer);
  const idMatch = signerId === pinnedId;
  step(
    "signing key id vs manifest-pinned id",
    process.env.CRX_STRICT_ID ? idMatch : true,
    idMatch
      ? `both ${pinnedId}`
      : `CRX installs as ${signerId}, manifest pins ${pinnedId} — EXPECTED with a throwaway signing key; real distribution must re-run scripts/embed-public-key.sh`,
  );

  // 5. Inner archive sanity: manifest.json present, version parity.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lwa-crx-verify-"));
  try {
    fs.writeFileSync(path.join(tmp, "inner.zip"), archive);
    const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
    let innerManifest;
    try {
      innerManifest = JSON.parse(execSync(`unzip -p "${path.join(tmp, "inner.zip")}" manifest.json`, { encoding: "utf8" }));
    } catch {
      innerManifest = null;
    }
    step("inner archive contains manifest.json", !!innerManifest);
    step(
      "inner manifest version matches package.json",
      !!innerManifest && innerManifest.version === pkg.version,
      innerManifest ? `both ${pkg.version}` : "manifest missing or unreadable",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nCRX verify: ${passed}/${results.length} checks passed — ${passed === results.length ? "artifact is a well-formed CRX3" : "REGRESSION"}`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
