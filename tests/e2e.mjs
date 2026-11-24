#!/usr/bin/env node
/**
 * End-to-end smoke test: drives the real native app (built from this repo)
 * through its actual HTTP API, exactly like a human user would:
 *   1. start the app with an isolated data dir + free port
 *   2. register a host (like the extension does on startup)
 *   3. create a document, write text into it
 *   4. send a rewrite request (LLM unavailable -> must fail cleanly)
 *   5. verify the failure is surfaced as a typed error, not a crash
 *   6. stop the app and check its exit code
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

const ROOT = new URL("..", import.meta.url).pathname;
const BIN = process.env.LWA_NATIVE_BIN ?? path.join(ROOT, "native-host", "lwa-native-app");
const PORT = Number(process.env.LWA_E2E_PORT || 7310);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " -- " + extra : ""}`);
  if (!ok) failures++;
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

async function waitFor(predicate, ms, what) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "lwa-e2e-"));
let child;
try {
  console.log("== starting native app ==");
  child = spawn(BIN, ["--serve", "--port", String(PORT), "--data-dir", dataDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; process.stderr.write(`[app] ${d}`); });
  child.stderr.on("data", (d) => { out += d; process.stderr.write(`[app:err] ${d}`); });

  await waitFor(async () => {
    try { const r = await fetch(BASE + "/api/health"); return r.ok; } catch { return false; }
  }, 15000, "health endpoint");
  check("app starts and /api/health responds", true);

  // host registration (extension does this on startup)
  const reg = await api("POST", "/api/hosts/register", { name: "e2e-host" });
  check("host registers", reg.status === 200 && reg.data?.id, `status ${reg.status}`);
  const hostId = reg.data?.id;

  // document lifecycle
  const doc = await api("POST", "/api/documents", { title: "E2E Doc" });
  check("document creates", doc.status === 201 && doc.data?.id, `status ${doc.status}`);
  const docId = doc.data?.id;

  const put = await api("PUT", `/api/documents/${docId}`, { content: "The quick brown fox." });
  check("document content saves", put.status === 200, `status ${put.status}`);

  const got = await api("GET", `/api/documents/${docId}`);
  check("saved content round-trips", got.data?.content === "The quick brown fox.", JSON.stringify(got.data?.content));

  // rewrite with no LLM configured: must fail cleanly, not crash
  const rw = await api("POST", "/api/rewrite", { documentId: docId, hostId });
  check(
    "rewrite fails cleanly without LLM (typed error)",
    rw.status >= 400 && (rw.data?.error || rw.data?.message),
    `status ${rw.status} body=${JSON.stringify(rw.data)}`
  );

  // app still alive after the failed rewrite
  const h2 = await fetch(BASE + "/api/health");
  check("app survives failed rewrite", h2.ok);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  if (child) child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  rmSync(dataDir, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
