/**
 * CRX3 packager — produces a signed .crx file from extension/dist + a
 * private key.
 *
 * The CRX3 format is defined in Chromium's components/crx_file/crx3.proto:
 *   https://source.chromium.org/chromium/chromium/src/+/main:components/crx_file/crx3.proto
 *
 *   [4 octets]  "Cr24" magic
 *   [4 octets]  version = 3 (uint32 little-endian)
 *   [4 octets]  N — header length (uint32 little-endian)
 *   [N octets]  CrxFileHeader proto
 *   [M octets]  ZIP archive
 *
 *   message CrxFileHeader {
 *     repeated AsymmetricKeyProof sha256_with_rsa = 2;
 *     optional bytes signed_header_data = 10000;
 *   }
 *   message AsymmetricKeyProof {
 *     optional bytes public_key = 1;   // X.509 SPKI DER
 *     optional bytes signature = 2;
 *   }
 *   message SignedData {
 *     optional bytes crx_id = 1;       // first 128 bits of SHA-256(public_key)
 *   }
 *
 * The signature covers EXACTLY:
 *   "CRX3 SignedData\x00" +
 *   signed_header_size (4 octets, little-endian) +
 *   signed_header_data +
 *   archive
 *
 * (An earlier version of this script computed the RSA signature over the
 * ZIP hash and then DISCARDED it, encoded sha256_with_rsa at field 10000
 * instead of field 2, and never emitted signed_header_data — Chrome parsed
 * the proof blob as signed_header_data and rejected the CRX outright.
 * This file is now a faithful implementation of the proto above.)
 *
 * Run via:  node scripts/build-crx.cjs
 * Outputs:
 *   dist/extension.crx        — signed CRX3 file
 *   dist/extension.crx.sha256 — SHA-256 of the CRX
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const EXT_DIR = path.join(ROOT, "extension", "dist");
const KEY_PATH = path.join(ROOT, ".keys", "extension.pem");
const OUT_DIR = path.join(ROOT, "dist");
const OUT_CRX = path.join(OUT_DIR, "extension.crx");
const OUT_SHA = path.join(OUT_DIR, "extension.crx.sha256");

function ensureBuilt() {
  if (!fs.existsSync(path.join(EXT_DIR, "manifest.json"))) {
    throw new Error(
      "extension/dist/manifest.json not found. Run `npm run build:extension` first.",
    );
  }
  if (!fs.existsSync(KEY_PATH)) {
    throw new Error(
      "Private key not found at .keys/extension.pem. Run scripts/generate-keypair.sh first.",
    );
  }
}

/** Chrome maps the first 128 bits of SHA-256(SPKI DER) to the 32-char
 *  extension id by re-mapping hex digits: 0-9 → a-p. */
function crxIdToExtensionId(crxId /* Buffer, 16 bytes */) {
  const hex = crxId.toString("hex");
  return hex.replace(/[0-9a-f]/g, (c) => {
    const idx = parseInt(c, 16);
    return String.fromCharCode("a".charCodeAt(0) + idx);
  });
}

/** Field encoding: varint tag ((fieldNum << 3) | 2) + varint length + bytes. */
function varint(n) {
  n = BigInt(n);
  const out = [];
  while (n > 0x7fn) {
    out.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

function bytesField(fieldNum, value) {
  return Buffer.concat([varint(BigInt(fieldNum) * 8n + 2n), varint(BigInt(value.length)), value]);
}

function buildCRX3() {
  // 1. Build the ZIP of extension/dist/.
  const zipPath = path.join(OUT_DIR, "extension-for-crx.zip");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  execSync(`zip -r -X "${zipPath}" .`, {
    cwd: EXT_DIR,
    stdio: "inherit",
  });
  const zip = fs.readFileSync(zipPath);

  // 2. Public key (X.509 SPKI DER) + crx_id.
  const pem = fs.readFileSync(KEY_PATH);
  const privKeyObj = crypto.createPrivateKey(pem);
  const pubDer = crypto.createPublicKey(privKeyObj).export({
    type: "spki",
    format: "der",
  });
  const crxId = crypto.createHash("sha256").update(pubDer).digest().subarray(0, 16);

  // 3. signed_header_data = serialized SignedData { crx_id }.
  const signedHeaderData = bytesField(1, crxId);

  // 4. Signature over "CRX3 SignedData\x00" + size + signed_header_data + archive.
  const signedHeaderLen = Buffer.alloc(4);
  signedHeaderLen.writeUInt32LE(signedHeaderData.length, 0);
  const signedData = Buffer.concat([
    Buffer.from("CRX3 SignedData\x00", "binary"),
    signedHeaderLen,
    signedHeaderData,
    zip,
  ]);
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signedData);
  const signature = signer.sign(privKeyObj);

  // 5. CrxFileHeader = sha256_with_rsa (field 2, repeated AsymmetricKeyProof)
  //                  + signed_header_data (field 10000).
  const proof = Buffer.concat([
    bytesField(1, pubDer), // AsymmetricKeyProof.public_key
    bytesField(2, signature), // AsymmetricKeyProof.signature
  ]);
  const header = Buffer.concat([
    bytesField(2, proof),
    bytesField(10000, signedHeaderData),
  ]);

  // 6. Write: magic + version + header_len + header + zip.
  const magic = Buffer.from("Cr24", "ascii");
  const version = Buffer.alloc(4);
  version.writeUInt32LE(3, 0);
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32LE(header.length, 0);

  const crx = Buffer.concat([magic, version, headerLen, header, zip]);
  fs.writeFileSync(OUT_CRX, crx);

  // 7. Self-verification — decode the header back out of the produced file
  //    and verify the signature the way Chrome would. If this ever fails,
  //    the CRX is broken and the script fails loudly instead of shipping it.
  verifyCRX3(crx, pubDer, signedData);

  const crxHash = crypto.createHash("sha256").update(crx).digest("hex");
  fs.writeFileSync(OUT_SHA, `${crxHash}  ${path.basename(OUT_CRX)}\n`);

  // Clean up the intermediate ZIP.
  fs.unlinkSync(zipPath);

  return {
    crxPath: OUT_CRX,
    sha256: crxHash,
    size: crx.length,
    extensionId: crxIdToExtensionId(crxId),
  };
}

/** Re-parse the produced CRX3 and verify the proof signature independently. */
function verifyCRX3(crx, expectedPubDer, expectedSignedData) {
  if (crx.subarray(0, 4).toString("ascii") !== "Cr24") {
    throw new Error("self-check: bad magic");
  }
  const version = crx.readUInt32LE(4);
  if (version !== 3) {
    throw new Error(`self-check: bad version ${version}`);
  }
  const headerLen = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerLen);
  const archive = crx.subarray(12 + headerLen);

  // Minimal proto walker: returns array of { field, value } (length-delimited only).
  const fields = parseProtoFields(header);
  const proofField = fields.find((f) => f.field === 2);
  const shdField = fields.find((f) => f.field === 10000);
  if (!proofField || !shdField) {
    throw new Error("self-check: missing sha256_with_rsa (2) or signed_header_data (10000)");
  }
  const proof = parseProtoFields(proofField.value);
  const pubDer = proof.find((f) => f.field === 1);
  const sig = proof.find((f) => f.field === 2);
  if (!pubDer || !sig) {
    throw new Error("self-check: AsymmetricKeyProof missing public_key/signature");
  }
  if (!pubDer.value.equals(expectedPubDer)) {
    throw new Error("self-check: public key mismatch");
  }
  // Rebuild SignedData exactly as Chrome does and verify the signature.
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(shdField.value.length, 0);
  const signedData = Buffer.concat([
    Buffer.from("CRX3 SignedData\x00", "binary"),
    lenBuf,
    shdField.value,
    archive,
  ]);
  if (!signedData.equals(expectedSignedData)) {
    throw new Error("self-check: SignedData reconstruction mismatch");
  }
  const ok = crypto.createVerify("RSA-SHA256").update(signedData).verify(
    crypto.createPublicKey({ key: pubDer.value, format: "der", type: "spki" }),
    sig.value,
  );
  if (!ok) {
    throw new Error("self-check: signature verification failed");
  }
}

function parseProtoFields(buf) {
  const out = [];
  let i = 0;
  const readVarint = () => {
    let result = 0n;
    let shift = 0n;
    while (true) {
      if (i >= buf.length) throw new Error("self-check: truncated varint");
      const b = buf[i++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const tag = readVarint();
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire !== 2) throw new Error(`self-check: unexpected wire type ${wire}`);
    const len = Number(readVarint());
    if (i + len > buf.length) throw new Error("self-check: truncated field");
    out.push({ field, value: buf.subarray(i, i + len) });
    i += len;
  }
  return out;
}

function checkManifestKeyMatch(extensionId) {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"),
    );
    if (!manifest.key) return;
    const pubDer = crypto.createPublicKey({
      key: Buffer.from(manifest.key, "base64"),
      format: "der",
      type: "spki",
    }).export({ type: "spki", format: "der" });
    const crxId = crypto.createHash("sha256").update(pubDer).digest().subarray(0, 16);
    const manifestId = crxIdToExtensionId(crxId);
    if (manifestId !== extensionId) {
      console.warn(
        `WARNING: signing key produces extension id ${extensionId}, ` +
          `but manifest.json pins ${manifestId}. The .crx would install under ` +
          `a DIFFERENT id than the unpacked extension. Re-run scripts/embed-public-key.sh.`,
      );
    }
  } catch {
    // Manifest read failure is not fatal here — ensureBuilt() covers it.
  }
}

function main() {
  ensureBuilt();
  const result = buildCRX3();
  checkManifestKeyMatch(result.extensionId);
  console.log(`Wrote ${result.crxPath}`);
  console.log(`Size: ${(result.size / 1024).toFixed(1)} KiB`);
  console.log(`SHA-256: ${result.sha256}`);
  console.log(`Extension ID: ${result.extensionId}`);
}

main();
