#!/usr/bin/env node
// windows-mcp loader. Downloads the latest bundle from the Vercel deployment,
// verifies its SHA-256, caches it, materializes the C# helper exe, and runs
// the bundle as the MCP server over stdio.
//
// Unlike macos-mcp this is straightforward — no AMFI / Gatekeeper dance. The
// helper is a framework-dependent .NET 8 single-file exe; the bundle's own
// helper.ts translates a missing-runtime exit into a clear install hint.
//
// Zero npm deps — Node ≥18 stdlib only.
//
// Env:
//   WINDOWS_MCP_ENDPOINT       override Vercel origin (default chrome-mcp.actuallyroy.com)
//   WINDOWS_MCP_PIN_VERSION    pin to a specific version; skips update check
//   WINDOWS_MCP_SKIP_UPDATE    truthy → always use cached bundle, don't hit network
//   WINDOWS_MCP_CACHE_DIR      override cache dir (default %USERPROFILE%\.windows-mcp)
//   WINDOWS_MCP_HELPER         absolute path to a pre-built helper; skips detection

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ENDPOINT =
  (process.env.WINDOWS_MCP_ENDPOINT || "https://chrome-mcp.actuallyroy.com").replace(/\/$/, "");
const CACHE_DIR = process.env.WINDOWS_MCP_CACHE_DIR || join(homedir(), ".windows-mcp");
const STATE_FILE = join(CACHE_DIR, "state.json");
const PIN = process.env.WINDOWS_MCP_PIN_VERSION || null;
const SKIP_UPDATE = /^(1|true|yes)$/i.test(process.env.WINDOWS_MCP_SKIP_UPDATE || "");

function log(...args) { console.error("[windows-mcp]", ...args); }

function readState() { try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return null; } }
function writeState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
async function fetchJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "windows-mcp-loader/1" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}
async function fetchBytes(url) {
  const res = await fetch(url, { headers: { "user-agent": "windows-mcp-loader/1" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");
const bundlePathFor = (version) => join(CACHE_DIR, `server-v${version}.mjs`);
const helperPathFor = (version) => join(CACHE_DIR, "bin", `windows-mcp-helper-v${version}.exe`);

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
    manifest = await fetchJson(`${ENDPOINT}/windows/bundle/manifest.json`);
  } catch (err) {
    if (state && existsSync(bundlePathFor(state.version))) {
      log(`manifest fetch failed (${err.message}); using cached v${state.version}`);
      return { version: state.version, path: bundlePathFor(state.version), source: "offline-cache" };
    }
    throw new Error(`windows-mcp: cannot reach ${ENDPOINT} and no cached bundle. ${err.message}`);
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
  log(`downloading windows-mcp v${manifest.version} from ${bundleUrl}`);
  const bytes = await fetchBytes(bundleUrl);
  const actual = sha256Hex(bytes);
  if (actual !== manifest.sha256) {
    throw new Error(`windows-mcp: SHA-256 mismatch. Expected ${manifest.sha256}, got ${actual}.`);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(localPath, bytes);
  writeState({ version: manifest.version, sha256: actual, fetched_at: new Date().toISOString() });
  return { version: manifest.version, path: localPath, source: "downloaded", manifest };
}

async function ensureHelper(manifest) {
  // User-supplied override always wins.
  if (process.env.WINDOWS_MCP_HELPER && existsSync(process.env.WINDOWS_MCP_HELPER)) {
    log(`using WINDOWS_MCP_HELPER=${process.env.WINDOWS_MCP_HELPER}`);
    return;
  }
  if (!manifest?.helper?.url) {
    throw new Error(
      "manifest has no helper info — server bundle is too old or build skipped the helper. " +
      "Either re-run scripts/build-windows-mcp.mjs on a Windows host or set WINDOWS_MCP_HELPER.",
    );
  }
  const dest = helperPathFor(manifest.version);
  if (existsSync(dest)) {
    // Trust the cached copy — name is version-pinned so a stale file means
    // someone manually pinned the version.
    process.env.WINDOWS_MCP_HELPER = dest;
    return;
  }
  const url = manifest.helper.url.startsWith("http") ? manifest.helper.url : `${ENDPOINT}${manifest.helper.url}`;
  log(`downloading helper exe from ${url} (${(manifest.helper.size_bytes / 1024 / 1024).toFixed(1)} MB)`);
  const bytes = await fetchBytes(url);
  const actual = sha256Hex(bytes);
  if (actual !== manifest.helper.sha256) {
    throw new Error(`windows-mcp helper SHA-256 mismatch. Expected ${manifest.helper.sha256}, got ${actual}.`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  process.env.WINDOWS_MCP_HELPER = dest;
  log(`helper cached at ${dest}`);
}

async function main() {
  try {
    if (process.platform !== "win32") {
      throw new Error(`windows-mcp only runs on Windows (current platform: ${process.platform})`);
    }
    const isFirstRun = !readState();
    const { version, path, source, manifest } = await resolveBundle();
    if (isFirstRun) {
      log("");
      log("windows-mcp is licensed under GNU GPL v3 (copyleft). By using it you");
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
