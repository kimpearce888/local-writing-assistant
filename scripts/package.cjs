/**
 * Final ZIP packager.
 *
 * Walks the source tree, excludes build artifacts / node_modules / .git,
 * copies the already-built extension/dist and native-host/build outputs
 * into a clean staging directory, and produces:
 *
 *   dist/Local-Writing-Assistant-Windows.zip
 *
 * The ZIP's top-level directory is Local-Writing-Assistant/ with the
 * structure described in spec section 80.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const STAGE = path.join(ROOT, "dist-stage");
const DIST = path.join(ROOT, "dist");
const ZIP_NAME = "Local-Writing-Assistant-Windows.zip";
const TOP_DIR = "Local-Writing-Assistant";

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    mkdirp(dest);
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function ensureBuilt() {
  const extDist = path.join(ROOT, "extension", "dist");
  const hostExe = path.join(ROOT, "native-host", "build", "LocalWritingAssistantHost.exe");
  if (!fs.existsSync(extDist) || !fs.existsSync(path.join(extDist, "manifest.json"))) {
    throw new Error("Extension is not built. Run `npm run build:extension` first.");
  }
  if (!fs.existsSync(hostExe)) {
    throw new Error("Windows native host EXE not found. Run `npm run build:native` first.");
  }
}

function stage() {
  rmrf(STAGE);
  mkdirp(STAGE);
  const top = path.join(STAGE, TOP_DIR);
  mkdirp(top);

  // Top-level launcher scripts.
  copyRecursive(path.join(ROOT, "installer"), path.join(top, "installer"));

  // Top-level README.
  fs.copyFileSync(
    path.join(ROOT, "packaging", "README.txt"),
    path.join(top, "README.txt"),
  );

  // Native host EXE goes into installer/native-host/ so install.ps1 can find it.
  mkdirp(path.join(top, "native-host"));
  fs.copyFileSync(
    path.join(ROOT, "native-host", "build", "LocalWritingAssistantHost.exe"),
    path.join(top, "native-host", "LocalWritingAssistantHost.exe"),
  );
  // Also copy host-manifest.template.json for reference.
  fs.copyFileSync(
    path.join(ROOT, "native-host", "host-manifest.template.json"),
    path.join(top, "native-host", "host-manifest.template.json"),
  );

  // Built extension goes into extension/ — install.ps1 copies it into %LOCALAPPDATA%.
  copyRecursive(
    path.join(ROOT, "extension", "dist"),
    path.join(top, "extension"),
  );

  // Empty folders the installer will populate.
  mkdirp(path.join(top, "policy"));
  mkdirp(path.join(top, "update"));
  mkdirp(path.join(top, "diagnostics"));

  // Documentation.
  for (const f of ["README.md", "PRIVACY.md", "SECURITY.md", "DEVELOPMENT.md"]) {
    fs.copyFileSync(path.join(ROOT, f), path.join(top, f));
  }

  // Top-level launcher .bat files (copies of installer/*.bat).
  fs.copyFileSync(
    path.join(top, "installer", "Install.bat"),
    path.join(top, "Install.bat"),
  );
  fs.copyFileSync(
    path.join(top, "installer", "Uninstall.bat"),
    path.join(top, "Uninstall.bat"),
  );
  fs.copyFileSync(
    path.join(top, "installer", "Diagnose.bat"),
    path.join(top, "Diagnose.bat"),
  );
}

function zip() {
  rmrf(DIST);
  mkdirp(DIST);
  // Use Info-ZIP's `zip` if available (it is on this dev box); fall back
  // to Node's built-in zlib if not.
  try {
    execSync(`zip -r "${path.join(DIST, ZIP_NAME)}" "${TOP_DIR}"`, {
      cwd: STAGE,
      stdio: "inherit",
    });
  } catch (e) {
    console.error("zip command failed:", e.message);
    process.exit(1);
  }
  console.log("");
  console.log(`Wrote ${path.join(DIST, ZIP_NAME)}`);
  // Print size.
  const sz = fs.statSync(path.join(DIST, ZIP_NAME)).size;
  console.log(`Size: ${(sz / 1024).toFixed(1)} KiB`);
}

function main() {
  ensureBuilt();
  stage();
  zip();
}

main();
