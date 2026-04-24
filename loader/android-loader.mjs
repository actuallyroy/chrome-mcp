#!/usr/bin/env node
// android-mcp loader. Downloads the latest bundle from the Vercel deployment,
// verifies its SHA-256, caches it, and runs it as the MCP server over stdio.
//
// Zero npm deps — only Node ≥18 stdlib (fs, path, crypto, os, fetch).
//
// Env:
//   ANDROID_MCP_ENDPOINT     override the Vercel origin (default: chrome-mcp.actuallyroy.com)
//   ANDROID_MCP_PIN_VERSION  pin to a specific version; skips update check
//   ANDROID_MCP_SKIP_UPDATE  truthy → always use cached bundle, don't hit network
//   ANDROID_MCP_CACHE_DIR    override cache dir (default: ~/.android-mcp)

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ENDPOINT =
  (process.env.ANDROID_MCP_ENDPOINT || "https://chrome-mcp.actuallyroy.com").replace(/\/$/, "");
const CACHE_DIR = process.env.ANDROID_MCP_CACHE_DIR || join(homedir(), ".android-mcp");
const STATE_FILE = join(CACHE_DIR, "state.json");
const PIN = process.env.ANDROID_MCP_PIN_VERSION || null;
const SKIP_UPDATE = /^(1|true|yes)$/i.test(process.env.ANDROID_MCP_SKIP_UPDATE || "");

function log(...args) { console.error("[android-mcp]", ...args); }

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return null; }
}
function writeState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
async function fetchJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "android-mcp-loader/1" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}
async function fetchBytes(url) {
  const res = await fetch(url, { headers: { "user-agent": "android-mcp-loader/1" } });
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
    manifest = await fetchJson(`${ENDPOINT}/android/bundle/manifest.json`);
  } catch (err) {
    if (state && existsSync(bundlePathFor(state.version))) {
      log(`manifest fetch failed (${err.message}); using cached v${state.version}`);
      return { version: state.version, path: bundlePathFor(state.version), source: "offline-cache" };
    }
    throw new Error(`android-mcp: cannot reach ${ENDPOINT} and no cached bundle. ${err.message}`);
  }
  const localPath = bundlePathFor(manifest.version);
  if (state?.version === manifest.version && existsSync(localPath)) {
    const cached = readFileSync(localPath);
    if (sha256Hex(cached) === manifest.sha256) {
      return { version: manifest.version, path: localPath, source: "up-to-date" };
    }
    log("cached bundle hash mismatch — re-downloading");
  }
  const bundleUrl = manifest.url.startsWith("http") ? manifest.url : `${ENDPOINT}${manifest.url}`;
  log(`downloading android-mcp v${manifest.version} from ${bundleUrl}`);
  const bytes = await fetchBytes(bundleUrl);
  const actual = sha256Hex(bytes);
  if (actual !== manifest.sha256) {
    throw new Error(`android-mcp: SHA-256 mismatch. Expected ${manifest.sha256}, got ${actual}.`);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(localPath, bytes);
  writeState({ version: manifest.version, sha256: actual, fetched_at: new Date().toISOString() });
  return { version: manifest.version, path: localPath, source: "downloaded" };
}

async function main() {
  try {
    const { version, path, source } = await resolveBundle();
    log(`using v${version} (${source})`);
    await import(pathToFileURL(path).href);
  } catch (err) {
    log(`fatal: ${err.message || err}`);
    process.exit(1);
  }
}
main();
