#!/usr/bin/env node
// Build the orch-mcp bundle. No native helper, no vendored binaries — just JS.
// Writes to public/orch/{bundle,loader.mjs,bootstrap.min.js}.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const MCP_DIR = join(ROOT, "orch-mcp");
const OUT_DIR = join(ROOT, "public", "orch");
const BUNDLE_DIR = join(OUT_DIR, "bundle");

const pkg = JSON.parse(readFileSync(join(MCP_DIR, "package.json"), "utf8"));
const version = pkg.version;

function run(cmd, cwd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

// 1. Install deps + compile orch-mcp's TypeScript.
if (!existsSync(join(MCP_DIR, "node_modules"))) {
  run("npm install --include=dev --no-audit --no-fund", MCP_DIR);
}
run("npx tsc", MCP_DIR);

// 2. Bundle into a single ESM file for the loader to fetch.
mkdirSync(BUNDLE_DIR, { recursive: true });
const bundlePath = join(BUNDLE_DIR, `v${version}.mjs`);
await esbuild({
  entryPoints: [join(MCP_DIR, "dist", "index.js")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  minify: false,
  banner: {
    js: "import { createRequire as __cm_createRequire } from 'node:module'; const require = __cm_createRequire(import.meta.url);",
  },
  logLevel: "info",
});
const bundleBytes = readFileSync(bundlePath);
const bundleSha = createHash("sha256").update(bundleBytes).digest("hex");

// 3. Manifest.
const manifest = {
  product: "orch-mcp",
  version,
  url: `/orch/bundle/v${version}.mjs`,
  sha256: bundleSha,
  size_bytes: bundleBytes.length,
  released_at: new Date().toISOString(),
};
writeFileSync(join(BUNDLE_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

// 4. Copy loader + minify bootstrap.
copyFileSync(join(ROOT, "loader", "orch-loader.mjs"), join(OUT_DIR, "loader.mjs"));
try { chmodSync(join(OUT_DIR, "loader.mjs"), 0o755); } catch {}

const bootstrapSrc = readFileSync(join(ROOT, "loader", "orch-bootstrap.js"), "utf8");
const minResult = await esbuild({
  stdin: { contents: bootstrapSrc, loader: "js" },
  bundle: false,
  minify: true,
  format: "esm",
  target: "node18",
  write: false,
  logLevel: "silent",
});
const bootstrapMin = minResult.outputFiles[0].text.trim().replace(/\n+$/, "");
writeFileSync(join(OUT_DIR, "bootstrap.min.js"), bootstrapMin, "utf8");

console.log(`orch-mcp v${version}: bundle ${(bundleBytes.length / 1024).toFixed(0)} KB, bootstrap ${bootstrapMin.length} chars`);
console.log("build-orch-mcp: done.");
