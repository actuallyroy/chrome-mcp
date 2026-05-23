#!/usr/bin/env node
// macos-mcp loader. Downloads the latest bundle from the Vercel deployment,
// verifies its SHA-256, caches it, fetches the bundled Swift helper binary,
// and runs the bundle as the MCP server over stdio.
//
// Zero npm deps — Node ≥18 stdlib only.
//
// Env:
//   MACOS_MCP_ENDPOINT     override Vercel origin (default: chrome-mcp.actuallyroy.com)
//   MACOS_MCP_PIN_VERSION  pin to a specific version; skips update check
//   MACOS_MCP_SKIP_UPDATE  truthy → always use cached bundle, don't hit network
//   MACOS_MCP_CACHE_DIR    override cache dir (default: ~/.macos-mcp)

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ENDPOINT =
  (process.env.MACOS_MCP_ENDPOINT || "https://chrome-mcp.actuallyroy.com").replace(/\/$/, "");
const CACHE_DIR = process.env.MACOS_MCP_CACHE_DIR || join(homedir(), ".macos-mcp");
const STATE_FILE = join(CACHE_DIR, "state.json");
const PIN = process.env.MACOS_MCP_PIN_VERSION || null;
const SKIP_UPDATE = /^(1|true|yes)$/i.test(process.env.MACOS_MCP_SKIP_UPDATE || "");

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

async function ensureHelperBinary(manifest) {
  if (!manifest?.helper?.url) {
    log("WARN: manifest has no helper binary — sqlite_*-equivalent native ops will fail");
    return;
  }
  const dest = join(CACHE_DIR, "bin", "macos-mcp-helper");
  const expected = manifest.helper.sha256;
  let needFetch = !existsSync(dest);
  if (!needFetch) {
    try { needFetch = sha256Hex(readFileSync(dest)) !== expected; } catch { needFetch = true; }
  }
  if (needFetch) {
    const url = manifest.helper.url.startsWith("http") ? manifest.helper.url : `${ENDPOINT}${manifest.helper.url}`;
    log(`fetching Swift helper binary…`);
    const bytes = await fetchBytes(url);
    if (sha256Hex(bytes) !== expected) {
      throw new Error(`macos-mcp: helper SHA-256 mismatch`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    chmodSync(dest, 0o755);
    // Strip quarantine xattr so Gatekeeper doesn't kill the binary on first run.
    try {
      const { spawnSync } = await import("node:child_process");
      spawnSync("xattr", ["-d", "com.apple.quarantine", dest], { stdio: "ignore" });
    } catch { /* ignore */ }
    log(`fetched helper (${(bytes.length / 1024).toFixed(0)} KB) → ${dest}`);
  }
  process.env.MACOS_MCP_HELPER = dest;
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
    await ensureHelperBinary(manifest);
    await import(pathToFileURL(path).href);
  } catch (err) {
    log(`fatal: ${err.message || err}`);
    process.exit(1);
  }
}
main();
