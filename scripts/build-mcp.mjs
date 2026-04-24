#!/usr/bin/env node
// Build the MCP server bundle and wire up the Next.js public/ directory.
// Runs at `npm run build` (prebuild phase), before `next build`.
//
// Outputs (all under public/):
//   bundle/v<version>.mjs   — esbuild bundle of the MCP server
//   bundle/manifest.json    — { version, url, sha256, released_at }
//   loader.mjs              — copied from loader/loader.mjs
//   install.sh              — copied from installer/install.sh
//   install.ps1             — copied from installer/install.ps1
//   scripts/launch-chrome.{sh,ps1}

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const MCP_DIR = join(ROOT, "mcp-server");
const PUBLIC_DIR = join(ROOT, "public");

const pkg = JSON.parse(readFileSync(join(MCP_DIR, "package.json"), "utf8"));
const version = pkg.version;

function run(cmd, cwd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

// 1. Compile MCP TypeScript (catches type errors; esbuild alone doesn't typecheck).
if (!existsSync(join(MCP_DIR, "node_modules"))) {
  run("npm install --no-audit --no-fund", MCP_DIR);
}
run("npx tsc", MCP_DIR);

// 2. Bundle into a single ESM file targeting Node 18.
mkdirSync(join(PUBLIC_DIR, "bundle"), { recursive: true });
const bundlePath = join(PUBLIC_DIR, "bundle", `v${version}.mjs`);

console.log(`> esbuild → ${bundlePath}`);
await esbuild({
  entryPoints: [join(MCP_DIR, "dist", "index.js")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  minify: false,
  sourcemap: false,
  // Node built-ins — esbuild handles them, but listing explicitly is safer.
  external: [],
  banner: {
    // Some bundled deps expect CommonJS globals when running under ESM.
    js: "import { createRequire as __cm_createRequire } from 'node:module'; const require = __cm_createRequire(import.meta.url);",
  },
  logLevel: "info",
});

// 3. SHA-256.
const bytes = readFileSync(bundlePath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const sizeMB = (bytes.length / 1024 / 1024).toFixed(2);

// 4. Manifest.
const manifest = {
  version,
  url: `/bundle/v${version}.mjs`,
  sha256,
  size_bytes: bytes.length,
  released_at: new Date().toISOString(),
};
writeFileSync(join(PUBLIC_DIR, "bundle", "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`bundle v${version}: ${sizeMB} MB, sha256=${sha256.slice(0, 16)}…`);

// 5. Copy loader + installers + launch scripts.
const copies = [
  { from: join(ROOT, "loader", "loader.mjs"), to: join(PUBLIC_DIR, "loader.mjs") },
  { from: join(ROOT, "installer", "install.sh"), to: join(PUBLIC_DIR, "install.sh") },
  { from: join(ROOT, "installer", "install.ps1"), to: join(PUBLIC_DIR, "install.ps1") },
  {
    from: join(ROOT, "scripts", "launch-chrome.sh"),
    to: join(PUBLIC_DIR, "scripts", "launch-chrome.sh"),
  },
  {
    from: join(ROOT, "scripts", "launch-chrome.ps1"),
    to: join(PUBLIC_DIR, "scripts", "launch-chrome.ps1"),
  },
];
for (const { from, to } of copies) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  if (to.endsWith(".sh") || to.endsWith(".mjs")) {
    try { chmodSync(to, 0o755); } catch {}
  }
}
console.log("copied loader, installers, and launch scripts to public/");
console.log("build-mcp: done.");
