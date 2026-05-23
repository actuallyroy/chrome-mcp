#!/usr/bin/env node
// macos-mcp loader. Downloads the latest bundle from the Vercel deployment,
// verifies its SHA-256, caches it, materializes the Swift helper binary, and
// runs the bundle as the MCP server over stdio.
//
// Helper materialization (Tahoe AMFI bites here):
//   On macOS 26+, downloaded adhoc-signed Mach-Os are SIGKILL'd by the kernel
//   even when invoked via execve. Locally-compiled binaries are fine because
//   the kernel learned them at link time. So the loader's preferred path is:
//   download the Swift source, compile it locally with the user's swiftc.
//   Falls back to downloading the prebuilt binary only when swiftc is absent.
//
// Zero npm deps — Node ≥18 stdlib only.
//
// Env:
//   MACOS_MCP_ENDPOINT       override Vercel origin (default: chrome-mcp.actuallyroy.com)
//   MACOS_MCP_PIN_VERSION    pin to a specific version; skips update check
//   MACOS_MCP_SKIP_UPDATE    truthy → always use cached bundle, don't hit network
//   MACOS_MCP_CACHE_DIR      override cache dir (default: ~/.macos-mcp)
//   MACOS_MCP_HELPER         absolute path to a pre-built helper; skips all detection
//   MACOS_MCP_FORCE_PREBUILT truthy → skip local source compile; always download prebuilt
//   MACOS_MCP_FORCE_REBUILD  truthy → always recompile from source (debug)

import { createHash } from "node:crypto";
import { execFile, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const ENDPOINT =
  (process.env.MACOS_MCP_ENDPOINT || "https://chrome-mcp.actuallyroy.com").replace(/\/$/, "");
const CACHE_DIR = process.env.MACOS_MCP_CACHE_DIR || join(homedir(), ".macos-mcp");
const STATE_FILE = join(CACHE_DIR, "state.json");
const PIN = process.env.MACOS_MCP_PIN_VERSION || null;
const SKIP_UPDATE = /^(1|true|yes)$/i.test(process.env.MACOS_MCP_SKIP_UPDATE || "");
const FORCE_PREBUILT = /^(1|true|yes)$/i.test(process.env.MACOS_MCP_FORCE_PREBUILT || "");
const FORCE_REBUILD = /^(1|true|yes)$/i.test(process.env.MACOS_MCP_FORCE_REBUILD || "");

function log(...args) { console.error("[macos-mcp]", ...args); }

function readState() { try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return null; } }
function writeState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
async function fetchJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "macos-mcp-loader/1" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}
async function fetchBytes(url) {
  const res = await fetch(url, { headers: { "user-agent": "macos-mcp-loader/1" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");
const bundlePathFor = (version) => join(CACHE_DIR, `server-v${version}.mjs`);

async function resolveBundle() {
  const state = readState();
  if (PIN && state?.version === PIN && existsSync(bundlePathFor(PIN))) {
    return { version: PIN, path: bundlePathFor(PIN), source: "pinned-cache" };
  }
  if (SKIP_UPDATE && state && existsSync(bundlePathFor(state.version))) {
    return { version: state.version, path: bundlePathFor(state.version), source: "skip-update-cache" };
  }
  let manifest;
  try {
    manifest = await fetchJson(`${ENDPOINT}/macos/bundle/manifest.json`);
  } catch (err) {
    if (state && existsSync(bundlePathFor(state.version))) {
      log(`manifest fetch failed (${err.message}); using cached v${state.version}`);
      return { version: state.version, path: bundlePathFor(state.version), source: "offline-cache" };
    }
    throw new Error(`macos-mcp: cannot reach ${ENDPOINT} and no cached bundle. ${err.message}`);
  }
  const localPath = bundlePathFor(manifest.version);
  if (state?.version === manifest.version && existsSync(localPath)) {
    const cached = readFileSync(localPath);
    if (sha256Hex(cached) === manifest.sha256) {
      return { version: manifest.version, path: localPath, source: "up-to-date", manifest };
    }
    log("cached bundle hash mismatch — re-downloading");
  }
  const bundleUrl = manifest.url.startsWith("http") ? manifest.url : `${ENDPOINT}${manifest.url}`;
  log(`downloading macos-mcp v${manifest.version} from ${bundleUrl}`);
  const bytes = await fetchBytes(bundleUrl);
  const actual = sha256Hex(bytes);
  if (actual !== manifest.sha256) {
    throw new Error(`macos-mcp: SHA-256 mismatch. Expected ${manifest.sha256}, got ${actual}.`);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(localPath, bytes);
  writeState({ version: manifest.version, sha256: actual, fetched_at: new Date().toISOString() });
  return { version: manifest.version, path: localPath, source: "downloaded", manifest };
}

// Probe: does this binary actually execute and respond to {"method":"ping"}?
// Returns true only if we see "pong" in stdout within 3s. Catches AMFI kills.
async function testHelper(path) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn(path, [], { stdio: ["pipe", "pipe", "pipe"] }); }
    catch { resolve(false); return; }
    let stdout = "";
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; try { proc.kill(); } catch {} resolve(ok); };
    const timer = setTimeout(() => done(false), 3000);
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('"pong"')) { clearTimeout(timer); done(true); }
    });
    proc.on("exit", (code, signal) => { if (signal === "SIGKILL") log(`AMFI killed test helper (signal SIGKILL)`); clearTimeout(timer); done(stdout.includes('"pong"')); });
    proc.on("error", () => { clearTimeout(timer); done(false); });
    try { proc.stdin.write('{"id":1,"method":"ping","params":{}}\n'); proc.stdin.end(); }
    catch { clearTimeout(timer); done(false); }
  });
}

async function hasSwiftc() {
  try { await execFileP("swiftc", ["--version"], { timeout: 4000 }); return true; }
  catch { return false; }
}

// Resolve an SDK that swiftc can build against. xcrun's default SDK is sometimes
// newer than the installed swiftc (CLT lag on rapid macOS releases) — falls
// back to walking /Library/Developer/CommandLineTools/SDKs for an older one.
async function pickSdkPath() {
  let preferred = null;
  try {
    const { stdout } = await execFileP("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { timeout: 4000 });
    preferred = stdout.trim();
  } catch { /* no xcrun */ }
  // Probe the preferred SDK with a tiny no-op compile to detect "SDK not supported".
  if (preferred && existsSync(preferred)) {
    const ok = await probeSdk(preferred);
    if (ok) return preferred;
  }
  // Fallback: walk CLT SDK dir for the highest-version MacOSX*.sdk that swiftc accepts.
  const sdkDir = "/Library/Developer/CommandLineTools/SDKs";
  if (existsSync(sdkDir)) {
    const candidates = readdirSync(sdkDir)
      .filter((n) => /^MacOSX\d+(\.\d+)?\.sdk$/.test(n))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const c of candidates) {
      const p = join(sdkDir, c);
      if (p === preferred) continue;
      if (await probeSdk(p)) return p;
    }
  }
  if (preferred) return preferred; // last resort; let real compile produce the error
  throw new Error("No usable SDK found for swiftc");
}

async function probeSdk(sdkPath) {
  // Compile a 1-line stub against the SDK. If swiftc errors with "SDK is not
  // supported", it returns non-zero. Anything else (including success) is fine.
  const stub = join(CACHE_DIR, ".sdk-probe.swift");
  const out = join(CACHE_DIR, ".sdk-probe.bin");
  try {
    writeFileSync(stub, "@main struct P { static func main() {} }\n");
    await execFileP("swiftc", ["-parse-as-library", "-sdk", sdkPath, "-o", out, stub], { timeout: 10_000 });
    try { rmSync(out); } catch {}
    try { rmSync(stub); } catch {}
    return true;
  } catch {
    try { rmSync(stub); } catch {}
    try { rmSync(out); } catch {}
    return false;
  }
}

// Build helper locally from sources. Returns dest path on success, throws on failure.
async function buildHelperFromSource(manifest) {
  if (!manifest?.helper_sources?.url) {
    throw new Error("manifest has no helper_sources — server bundle is too old");
  }
  const srcDir = join(CACHE_DIR, "src");
  const tarPath = join(CACHE_DIR, "helper-src.tar.gz");
  mkdirSync(srcDir, { recursive: true });

  const url = manifest.helper_sources.url.startsWith("http")
    ? manifest.helper_sources.url
    : `${ENDPOINT}${manifest.helper_sources.url}`;
  log(`fetching helper sources from ${url}`);
  const bytes = await fetchBytes(url);
  if (sha256Hex(bytes) !== manifest.helper_sources.sha256) {
    throw new Error("helper_sources SHA-256 mismatch");
  }
  writeFileSync(tarPath, bytes);
  // Clear stale extract.
  try { rmSync(srcDir, { recursive: true, force: true }); } catch {}
  mkdirSync(srcDir, { recursive: true });
  await execFileP("tar", ["-xzf", tarPath, "-C", srcDir], { timeout: 15_000 });

  const swiftFiles = readdirSync(srcDir).filter((f) => f.endsWith(".swift")).map((f) => join(srcDir, f));
  if (swiftFiles.length === 0) {
    throw new Error(`no .swift files in extracted ${srcDir}`);
  }

  const sdk = await pickSdkPath();
  log(`compiling helper with swiftc (SDK=${sdk}, ${swiftFiles.length} sources)`);
  const dest = join(CACHE_DIR, "bin", "macos-mcp-helper");
  mkdirSync(dirname(dest), { recursive: true });

  await execFileP("swiftc", [
    "-O", "-parse-as-library",
    "-sdk", sdk,
    "-target", "arm64-apple-macos14.0",
    "-framework", "AppKit",
    "-framework", "ApplicationServices",
    "-framework", "ScreenCaptureKit",
    "-framework", "CoreGraphics",
    "-framework", "UniformTypeIdentifiers",
    "-framework", "Foundation",
    "-framework", "Vision",
    "-o", dest,
    ...swiftFiles,
  ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });

  chmodSync(dest, 0o755);
  return dest;
}

// Download the prebuilt helper. Tahoe AMFI may SIGKILL it — caller must testHelper().
async function downloadPrebuiltHelper(manifest) {
  if (!manifest?.helper?.url) throw new Error("manifest has no prebuilt helper");
  const dest = join(CACHE_DIR, "bin", "macos-mcp-helper");
  const url = manifest.helper.url.startsWith("http") ? manifest.helper.url : `${ENDPOINT}${manifest.helper.url}`;
  log(`downloading prebuilt helper from ${url}`);
  const bytes = await fetchBytes(url);
  if (sha256Hex(bytes) !== manifest.helper.sha256) throw new Error("prebuilt helper sha256 mismatch");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  chmodSync(dest, 0o755);
  try { spawnSync("xattr", ["-c", dest], { stdio: "ignore" }); } catch {}
  return dest;
}

async function ensureHelper(manifest) {
  // User-supplied override always wins.
  if (process.env.MACOS_MCP_HELPER && existsSync(process.env.MACOS_MCP_HELPER)) {
    log(`using MACOS_MCP_HELPER=${process.env.MACOS_MCP_HELPER}`);
    return;
  }

  const dest = join(CACHE_DIR, "bin", "macos-mcp-helper");
  const versionMarker = join(CACHE_DIR, "bin", `built-for-v${manifest.version}.txt`);

  // Fast path: cached helper from this version, runs cleanly.
  if (!FORCE_REBUILD && existsSync(dest) && existsSync(versionMarker)) {
    if (await testHelper(dest)) {
      process.env.MACOS_MCP_HELPER = dest;
      return;
    }
    log("cached helper failed ping test — rebuilding");
  }

  // Preferred path: compile from source locally (Tahoe AMFI workaround).
  if (!FORCE_PREBUILT && await hasSwiftc()) {
    try {
      const path = await buildHelperFromSource(manifest);
      if (await testHelper(path)) {
        writeFileSync(versionMarker, manifest.version);
        log(`built helper locally → ${path}`);
        process.env.MACOS_MCP_HELPER = path;
        return;
      }
      log("locally-built helper failed ping test — falling back to prebuilt download");
    } catch (e) {
      log(`local compile failed: ${e.message.split("\n")[0]} — falling back to prebuilt download`);
    }
  } else if (!FORCE_PREBUILT) {
    log("swiftc not found — install Xcode Command Line Tools (xcode-select --install) to enable the local-compile path; falling back to prebuilt download");
  }

  // Fallback: download prebuilt and hope AMFI accepts it.
  const path = await downloadPrebuiltHelper(manifest);
  if (await testHelper(path)) {
    writeFileSync(versionMarker, manifest.version);
    process.env.MACOS_MCP_HELPER = path;
    return;
  }

  // Both paths failed. Surface a clear, actionable error.
  throw new Error(
    "macos-mcp helper won't run on this system.\n" +
      "  - The locally-built path needs Xcode Command Line Tools (`xcode-select --install`).\n" +
      "  - The downloaded prebuilt was killed by macOS code-signing enforcement (AMFI/Gatekeeper).\n" +
      "  - Override with MACOS_MCP_HELPER=/absolute/path/to/macos-mcp-helper if you've built it yourself."
  );
}

async function main() {
  try {
    if (process.platform !== "darwin") {
      throw new Error(`macos-mcp only runs on macOS (current platform: ${process.platform})`);
    }
    const isFirstRun = !readState();
    const { version, path, source, manifest } = await resolveBundle();
    if (isFirstRun) {
      log("");
      log("macos-mcp is licensed under GNU GPL v3 (copyleft). By using it you");
      log("accept the GPLv3 terms. Source + LICENSE: https://github.com/actuallyroy/chrome-mcp");
      log("");
    }
    log(`using v${version} (${source})`);
    await ensureHelper(manifest);
    await import(pathToFileURL(path).href);
  } catch (err) {
    log(`fatal: ${err.message || err}`);
    process.exit(1);
  }
}
main();
