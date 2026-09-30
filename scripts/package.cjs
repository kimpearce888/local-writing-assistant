/**
 * Final ZIP packager — supports both Windows and Linux.
 *
 * Walks the source tree, excludes build artifacts / node_modules / .git,
 * copies the already-built extension/dist and native-host/build outputs
 * into a clean staging directory, and produces:
 *
 *   dist/Local-Writing-Assistant-Windows.zip   (Windows EXE + .bat/.ps1 installers)
 *   dist/Local-Writing-Assistant-Linux.zip     (Linux binary + .sh installers)
 *
 * The ZIP's top-level directory is Local-Writing-Assistant/ with the
 * structure described in spec section 80.
 *
 * Usage:
 *   node scripts/package.cjs              # package both platforms
 *   node scripts/package.cjs --windows    # Windows only
 *   node scripts/package.cjs --linux      # Linux only
 *
 * For a Windows-only release from this Linux dev box, the native host
 * EXE must already exist at native-host/build/LocalWritingAssistantHost.exe
 * (built via `npm run build:native` which sets GOOS=windows).
 * For a Linux-only release, the binary at native-host/build/LocalWritingAssistantHost
 * must already exist (built via `npm run build:native:linux`).
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const STAGE = path.join(ROOT, "dist-stage");
const DIST = path.join(ROOT, "dist");
const TOP_DIR = "Local-Writing-Assistant";

const argv = process.argv.slice(2);
const wantWindows = argv.includes("--windows") || argv.length === 0;
const wantLinux = argv.includes("--linux") || argv.length === 0;

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

function ensureBuiltFor(platform) {
  const extDist = path.join(ROOT, "extension", "dist");
  if (!fs.existsSync(extDist) || !fs.existsSync(path.join(extDist, "manifest.json"))) {
    throw new Error("Extension is not built. Run `npm run build:extension` first.");
  }
  const hostName = platform === "windows"
    ? "LocalWritingAssistantHost.exe"
    : "LocalWritingAssistantHost";
  const hostPath = path.join(ROOT, "native-host", "build", hostName);
  if (!fs.existsSync(hostPath)) {
    throw new Error(
      `${platform === "windows" ? "Windows" : "Linux"} native host not found at ${hostPath}. ` +
      `Run ${platform === "windows" ? "`npm run build:native`" : "`npm run build:native:linux`"} first.`,
    );
  }
  return hostPath;
}

/**
 * Stage the platform-specific ZIP. Each platform gets:
 *   - installer/ — all .bat/.ps1 (Windows) or .sh (Linux) scripts
 *   - native-host/ — the platform binary
 *   - extension/ — built extension files (platform-independent)
 *   - README.md, PRIVACY.md, SECURITY.md, DEVELOPMENT.md, LICENSE, CHANGELOG.md
 *   - README.txt (packaging/)
 */
function stageFor(platform, hostPath) {
  rmrf(STAGE);
  mkdirp(STAGE);
  const top = path.join(STAGE, TOP_DIR);
  mkdirp(top);

  // Top-level launcher scripts — copy the WHOLE installer/ folder, then
  // remove the OTHER platform's scripts to avoid confusion.
  copyRecursive(path.join(ROOT, "installer"), path.join(top, "installer"));
  if (platform === "windows") {
    // Remove Linux scripts from the Windows package.
    for (const f of ["install.sh", "setup-lm-studio.sh", "diagnose.sh"]) {
      const p = path.join(top, "installer", f);
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  } else {
    // Remove Windows scripts from the Linux package.
    for (const f of [
      "install.ps1", "setup-lm-studio.ps1", "uninstall.ps1",
      "diagnose.ps1", "LocalWritingAssistant.iss",
      "Install.bat", "Uninstall.bat", "Diagnose.bat",
    ]) {
      const p = path.join(top, "installer", f);
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  }

  // Top-level README.
  fs.copyFileSync(
    path.join(ROOT, "packaging", "README.txt"),
    path.join(top, "README.txt"),
  );

  // Native host binary goes into native-host/ so install scripts find it.
  mkdirp(path.join(top, "native-host"));
  const hostName = path.basename(hostPath);
  fs.copyFileSync(hostPath, path.join(top, "native-host", hostName));
  // Also copy host-manifest.template.json for reference.
  fs.copyFileSync(
    path.join(ROOT, "native-host", "host-manifest.template.json"),
    path.join(top, "native-host", "host-manifest.template.json"),
  );

  // Built extension (platform-independent).
  copyRecursive(
    path.join(ROOT, "extension", "dist"),
    path.join(top, "extension"),
  );

  // Empty folders the installer will populate.
  mkdirp(path.join(top, "policy"));
  mkdirp(path.join(top, "update"));
  mkdirp(path.join(top, "diagnostics"));

  // Documentation. LICENSE MUST be included so the ZIP is MIT-compliant.
  for (const f of ["README.md", "PRIVACY.md", "SECURITY.md", "DEVELOPMENT.md", "LICENSE", "CHANGELOG.md"]) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(top, f));
    }
  }

  // Top-level launcher scripts (copies of installer/*.bat or installer/*.sh).
  if (platform === "windows") {
    for (const f of ["Install.bat", "Uninstall.bat", "Diagnose.bat"]) {
      const src = path.join(top, "installer", f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(top, f));
      }
    }
  } else {
    for (const f of ["install.sh", "diagnose.sh"]) {
      const src = path.join(top, "installer", f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(top, f));
        // Make sure the copied .sh is executable in the ZIP.
        fs.chmodSync(path.join(top, f), 0o755);
      }
    }
  }
}

function zipFor(platform) {
  const zipName = platform === "windows"
    ? "Local-Writing-Assistant-Windows.zip"
    : "Local-Writing-Assistant-Linux.zip";
  rmrf(DIST);
  mkdirp(DIST);
  try {
    execSync(`zip -r "${path.join(DIST, zipName)}" "${TOP_DIR}"`, {
      cwd: STAGE,
      stdio: "inherit",
    });
  } catch (e) {
    console.error("zip command failed:", e.message);
    process.exit(1);
  }
  console.log("");
  console.log(`Wrote ${path.join(DIST, zipName)}`);
  const sz = fs.statSync(path.join(DIST, zipName)).size;
  console.log(`Size: ${(sz / 1024).toFixed(1)} KiB`);
  console.log("");
}

function packagePlatform(platform) {
  console.log(`=== Packaging for ${platform} ===`);
  const hostPath = ensureBuiltFor(platform);
  stageFor(platform, hostPath);
  zipFor(platform);
}

function main() {
  if (wantWindows) packagePlatform("windows");
  if (wantLinux) packagePlatform("linux");
}

main();
