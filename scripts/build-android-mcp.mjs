#!/usr/bin/env node
// Build the android-mcp bundle + grab the UIAutomator2 APKs.
// Writes to public/android/{bundle,vendor}/.

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
const MCP_DIR = join(ROOT, "android-mcp");
const OUT_DIR = join(ROOT, "public", "android");
const VENDOR_DIR = join(OUT_DIR, "vendor");
const BUNDLE_DIR = join(OUT_DIR, "bundle");

const pkg = JSON.parse(readFileSync(join(MCP_DIR, "package.json"), "utf8"));
const version = pkg.version;

function run(cmd, cwd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

// 1. Compile.
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

// 3. Fetch UIAutomator2 APKs from latest GitHub release (cache locally).
mkdirSync(VENDOR_DIR, { recursive: true });
async function ensureApk(filename, url) {
  const dest = join(VENDOR_DIR, filename);
  if (existsSync(dest) && !process.env.REFRESH_APKS) {
    console.log(`vendor/${filename} already present`);
    return readFileSync(dest);
  }
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf;
}

let u2Version = process.env.UIAUTOMATOR2_VERSION;
if (!u2Version) {
  const rel = await (await fetch("https://api.github.com/repos/appium/appium-uiautomator2-server/releases/latest")).json();
  u2Version = rel.tag_name.replace(/^v/, "");
}
const mainApkUrl = `https://github.com/appium/appium-uiautomator2-server/releases/download/v${u2Version}/appium-uiautomator2-server-v${u2Version}.apk`;
const testApkUrl = `https://github.com/appium/appium-uiautomator2-server/releases/download/v${u2Version}/appium-uiautomator2-server-debug-androidTest.apk`;
const mainBytes = await ensureApk("uiautomator2-server.apk", mainApkUrl);
const testBytes = await ensureApk("uiautomator2-server-test.apk", testApkUrl);

// 4. Manifest.
const manifest = {
  product: "android-mcp",
  version,
  url: `/android/bundle/v${version}.mjs`,
  sha256: bundleSha,
  size_bytes: bundleBytes.length,
  released_at: new Date().toISOString(),
  uiautomator2: {
    version: u2Version,
    main: {
      url: "/android/vendor/uiautomator2-server.apk",
      sha256: createHash("sha256").update(mainBytes).digest("hex"),
      size_bytes: mainBytes.length,
    },
    test: {
      url: "/android/vendor/uiautomator2-server-test.apk",
      sha256: createHash("sha256").update(testBytes).digest("hex"),
      size_bytes: testBytes.length,
    },
  },
};
writeFileSync(join(BUNDLE_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

// 5. Copy android loader + minify bootstrap.
copyFileSync(join(ROOT, "loader", "android-loader.mjs"), join(OUT_DIR, "loader.mjs"));
try { chmodSync(join(OUT_DIR, "loader.mjs"), 0o755); } catch {}

const bootstrapSrc = readFileSync(join(ROOT, "loader", "android-bootstrap.js"), "utf8");
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

console.log(`android-mcp v${version}: bundle ${(bundleBytes.length / 1024 / 1024).toFixed(2)} MB, u2 v${u2Version}, bootstrap ${bootstrapMin.length} chars`);
console.log("build-android-mcp: done.");
