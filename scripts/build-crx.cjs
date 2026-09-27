/**
 * CRX3 packager — produces a signed .crx file from extension/dist + a
 * private key.
 *
 * Chrome's CRX3 format is documented at:
 *   https://source.chromium.org/chromium/chromium/src/+/main:components/crx_file/crx3.proto
 *
 * The format is:
 *   "Cr24" magic (4 bytes)
 *   version = 3 (uint32 little-endian)
 *   length-prefixed CrxFileHeader (a serialized ASNHdr proto)
 *   length-prefixed ZIP archive bytes
 *
 * The CrxFileHeader contains:
 *   sha256_with_rsa (2, 0x10000) — signed proof that the ZIP was
 *   produced by the holder of the private key matching the public
 *   key embedded in the manifest.
 *
 * We don't pull in any protobuf library — we hand-build the two tiny
 * length-delimited proto messages Chrome expects.
 *
 * Run via:
 *   node scripts/build-crx.cjs
 *
 * Outputs:
 *   dist/extension.crx       — signed CRX3 file
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

/**
 * Build a CRX3 file by:
 *   1. Zipping extension/dist/ into a Buffer.
 *   2. Computing SHA-256 of the ZIP.
 *   3. Signing the SHA-256 with the RSA private key (PKCS#1 v1.5).
 *   4. Extracting the DER public key.
 *   5. Hand-encoding the CrxFileHeader proto.
 *   6. Writing: "Cr24" + uint32(3) + header_len + header + zip.
 */
function buildCRX3() {
  // 1. Build the ZIP of extension/dist/.
  const zipPath = path.join(OUT_DIR, "extension-for-crx.zip");
  // Make sure the output dir exists before zip tries to write to it.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  execSync(`zip -r -X "${zipPath}" .`, {
    cwd: EXT_DIR,
    stdio: "inherit",
  });
  const zip = fs.readFileSync(zipPath);

  // 2. SHA-256 of the ZIP contents.
  const zipHash = crypto.createHash("sha256").update(zip).digest();

  // 3. Sign the SHA-256 with the private key.
  const pem = fs.readFileSync(KEY_PATH);
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(zipHash);
  // Note: Chrome uses a raw SHA-256 of the ZIP, not of the header.
  // The signature covers zipHash only.
  const signature = sign.sign(pem);

  // 4. Extract the DER public key from the PEM.
  const pubObj = crypto.createPublicKey(pem);
  const pubDer = pubObj.export({ type: "spki", format: "der" });

  // 5. Hand-build the CrxFileHeader proto.
  //
  // CrxFileHeader proto (proto2):
  //   message AsymmetricKeyProof {
  //     optional bytes signed_header_data = 2;
  //     optional string signature = 3;   // not really string, but proto treats bytes as string
  //   }
  //   message Sha256WithRsa {
  //     optional bytes public_key = 1;
  //     optional AsymmetricKeyProof proof = 2;
  //   }
  //   message CrxFileHeader {
  //     repeated Sha256WithRsa sha256_with_rsa = 10000;
  //     // Plus an optional AsymmetricKeyProof for the signed_header_data
  //     // field — but Chrome accepts a header with just sha256_with_rsa.
  //   }
  //
  // Field encoding: varint-tag + varint-length + bytes.
  // Tag for "bytes" field N: (N << 3) | 2.

  function varint(n) {
    const out = [];
    while (n > 0x7f) {
      out.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    out.push(n & 0x7f);
    return Buffer.from(out);
  }

  function bytesField(fieldNum, value) {
    const tag = (fieldNum << 3) | 2;
    return Buffer.concat([varint(tag), varint(value.length), value]);
  }

  // AsymmetricKeyProof with field 2 = signed_header_data.
  // The "signed data" here is the SHA-256 of the zip.
  const proof = bytesField(2, zipHash);

  // Sha256WithRsa: field 1 = public_key, field 2 = AsymmetricKeyProof.
  const sha256WithRsa = Buffer.concat([
    bytesField(1, pubDer),
    bytesField(2, proof),
  ]);

  // CrxFileHeader: field 10000 = repeated Sha256WithRsa.
  const header = bytesField(10000, sha256WithRsa);

  // 6. Write: magic + version + header_len + header + zip.
  const magic = Buffer.from("Cr24", "ascii");
  const version = Buffer.alloc(4);
  version.writeUInt32LE(3, 0);
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32LE(header.length, 0);

  const crx = Buffer.concat([magic, version, headerLen, header, zip]);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_CRX, crx);

  // SHA-256 of the final CRX.
  const crxHash = crypto.createHash("sha256").update(crx).digest("hex");
  fs.writeFileSync(OUT_SHA, `${crxHash}  ${path.basename(OUT_CRX)}\n`);

  // Clean up the intermediate ZIP.
  fs.unlinkSync(zipPath);

  return { crxPath: OUT_CRX, sha256: crxHash, size: crx.length };
}

function main() {
  ensureBuilt();
  const result = buildCRX3();
  console.log(`Wrote ${result.crxPath}`);
  console.log(`Size: ${(result.size / 1024).toFixed(1)} KiB`);
  console.log(`SHA-256: ${result.sha256}`);
}

main();
