#!/usr/bin/env node
// Build the macos-mcp bundle + helper binary. Writes to public/macos/{bundle,vendor}/.

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const MCP_DIR = join(ROOT, "macos-mcp");
const OUT_DIR = join(ROOT, "public", "macos");
const VENDOR_DIR = join(OUT_DIR, "vendor");
const BUNDLE_DIR = join(OUT_DIR, "bundle");

const pkg = JSON.parse(readFileSync(join(MCP_DIR, "package.json"), "utf8"));
const version = pkg.version;

function run(cmd, cwd) { console.log(`> ${cmd}`); execSync(cmd, { cwd, stdio: "inherit" }); }

// 1. Compile TypeScript.
if (!existsSync(join(MCP_DIR, "node_modules"))) {
  run("npm install --include=dev --no-audit --no-fund", MCP_DIR);
}
run("npx tsc", MCP_DIR);

// 2. Bundle.
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

// 3. Build (or reuse) the Swift helper binary on macOS. On non-macOS build
//    hosts, expect a pre-built binary at macos-mcp/vendor/macos-mcp-helper.
mkdirSync(VENDOR_DIR, { recursive: true });
const helperSrc = join(MCP_DIR, "vendor", "macos-mcp-helper");
if (process.platform === "darwin" && !existsSync(helperSrc)) {
  console.log("> building Swift helper…");
  run("bash scripts/build-helper.sh", MCP_DIR);
}
let helperBytes = null;
if (existsSync(helperSrc)) {
  const helperDest = join(VENDOR_DIR, "macos-mcp-helper");
  copyFileSync(helperSrc, helperDest);
  chmodSync(helperDest, 0o755);
  helperBytes = readFileSync(helperDest);
  console.log(`vendor/macos-mcp-helper copied (${(helperBytes.length / 1024).toFixed(0)} KB)`);
} else {
  console.warn(`WARN: ${helperSrc} not found. Helper won't be in the published bundle. Run scripts/build-helper.sh on a macOS host first.`);
}

// 4. Manifest.
const manifest = {
  product: "macos-mcp",
  version,
  url: `/macos/bundle/v${version}.mjs`,
  sha256: bundleSha,
  size_bytes: bundleBytes.length,
  released_at: new Date().toISOString(),
  helper: helperBytes
    ? {
        arch: "arm64",
        url: "/macos/vendor/macos-mcp-helper",
        sha256: createHash("sha256").update(helperBytes).digest("hex"),
        size_bytes: helperBytes.length,
      }
    : null,
};
writeFileSync(join(BUNDLE_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

// 5. Copy macos loader + minify bootstrap.
copyFileSync(join(ROOT, "loader", "macos-loader.mjs"), join(OUT_DIR, "loader.mjs"));
try { chmodSync(join(OUT_DIR, "loader.mjs"), 0o755); } catch {}

const bootstrapSrc = readFileSync(join(ROOT, "loader", "macos-bootstrap.js"), "utf8");
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

console.log(`macos-mcp v${version}: bundle ${(bundleBytes.length / 1024).toFixed(0)} KB, helper ${helperBytes ? (helperBytes.length / 1024).toFixed(0) + " KB" : "missing"}, bootstrap ${bootstrapMin.length} chars`);
console.log("build-macos-mcp: done.");
