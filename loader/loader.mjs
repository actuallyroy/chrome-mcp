#!/usr/bin/env node
// chrome-mcp loader. Downloads the latest bundle from the Vercel deployment,
// verifies its SHA-256, caches it, and runs it as the MCP server over stdio.
//
// Zero npm deps — only Node ≥18 stdlib (fs, path, crypto, os, fetch).
//
// Env:
//   CHROME_MCP_ENDPOINT     override the Vercel origin (default: chrome-mcp.actuallyroy.com)
//   CHROME_MCP_PIN_VERSION  pin to a specific version; skips update check
//   CHROME_MCP_SKIP_UPDATE  truthy → always use cached bundle, don't hit network
//   CHROME_MCP_CACHE_DIR    override cache dir (default: ~/.chrome-mcp)

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ENDPOINT =
  (process.env.CHROME_MCP_ENDPOINT || "https://chrome-mcp.actuallyroy.com").replace(/\/$/, "");
const CACHE_DIR = process.env.CHROME_MCP_CACHE_DIR || join(homedir(), ".chrome-mcp");
const STATE_FILE = join(CACHE_DIR, "state.json");
const PIN = process.env.CHROME_MCP_PIN_VERSION || null;
const SKIP_UPDATE = /^(1|true|yes)$/i.test(process.env.CHROME_MCP_SKIP_UPDATE || "");

function log(...args) {
  // MCP uses stdout for JSON-RPC — all loader messages must go to stderr.
  console.error("[chrome-mcp]", ...args);
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "chrome-mcp-loader/1" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function fetchBytes(url) {
  const res = await fetch(url, { headers: { "user-agent": "chrome-mcp-loader/1" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function bundlePathFor(version) {
  return join(CACHE_DIR, `server-v${version}.mjs`);
}

async function resolveBundle() {
  const state = readState();

  // Pinned + cached → use directly, no network.
  if (PIN && state?.version === PIN && existsSync(bundlePathFor(PIN))) {
    return { version: PIN, path: bundlePathFor(PIN), source: "pinned-cache" };
  }
  // Skip update + cached → use cached.
  if (SKIP_UPDATE && state && existsSync(bundlePathFor(state.version))) {
    return { version: state.version, path: bundlePathFor(state.version), source: "skip-update-cache" };
  }

  let manifest;
  try {
    manifest = await fetchJson(`${ENDPOINT}/bundle/manifest.json`);
  } catch (err) {
    // Network failed — fall back to cached if available.
    if (state && existsSync(bundlePathFor(state.version))) {
      log(`manifest fetch failed (${err.message}); using cached v${state.version}`);
      return { version: state.version, path: bundlePathFor(state.version), source: "offline-cache" };
    }
    throw new Error(
      `chrome-mcp: cannot reach ${ENDPOINT} and no cached bundle. Original error: ${err.message}`,
    );
  }

  const wanted = PIN || manifest.version;
  if (PIN && PIN !== manifest.version) {
    // Pinned to something other than latest — try to fetch pinned version.
    manifest = {
      version: PIN,
      url: `/bundle/v${PIN}.mjs`,
      sha256: manifest.pins?.[PIN]?.sha256,
    };
    if (!manifest.sha256) {
      throw new Error(
        `chrome-mcp: pinned version ${PIN} not in manifest. Latest is ${wanted}. ` +
          `Either update the pin or remove CHROME_MCP_PIN_VERSION.`,
      );
    }
  }

  const localPath = bundlePathFor(manifest.version);
  if (state?.version === manifest.version && existsSync(localPath)) {
    // Already up to date. Verify hash of cached file once (cheap).
    const cached = readFileSync(localPath);
    if (sha256Hex(cached) === manifest.sha256) {
      return { version: manifest.version, path: localPath, source: "up-to-date" };
    }
    log("cached bundle hash mismatch — re-downloading");
  }

  const bundleUrl = manifest.url.startsWith("http") ? manifest.url : `${ENDPOINT}${manifest.url}`;
  log(`downloading chrome-mcp v${manifest.version} from ${bundleUrl}`);
  const bytes = await fetchBytes(bundleUrl);
  const actual = sha256Hex(bytes);
  if (actual !== manifest.sha256) {
    throw new Error(
      `chrome-mcp: SHA-256 mismatch for v${manifest.version}. Expected ${manifest.sha256}, got ${actual}. Refusing to run.`,
    );
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
    // Dynamic import runs the bundle's top-level code (which starts the MCP).
    await import(pathToFileURL(path).href);
  } catch (err) {
    log(`fatal: ${err.message || err}`);
    process.exit(1);
  }
}

main();
