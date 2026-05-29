#!/usr/bin/env node
// Build the windows-mcp bundle + helper binary. Writes to public/windows/{bundle,vendor}/.
//
// Unlike macos-mcp, the Windows helper is a framework-dependent .NET 8 single-file
// exe (~25 MB). End users need the .NET 8 Desktop Runtime installed; the loader
// translates "missing runtime" exits into a clear install hint.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const MCP_DIR = join(ROOT, "windows-mcp");
const OUT_DIR = join(ROOT, "public", "windows");
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

// 3. Build (or reuse) the C# helper on Windows. On non-Windows build hosts
//    (Vercel deploys typically run Linux), expect a pre-built exe at
//    windows-mcp/vendor/windows-mcp-helper.exe. Build it locally on Windows
//    then commit / artifact-cache it for the deploy.
mkdirSync(VENDOR_DIR, { recursive: true });
const helperSrc = join(MCP_DIR, "vendor", "windows-mcp-helper.exe");
if (process.platform === "win32" && !existsSync(helperSrc)) {
  console.log("> building C# helper…");
  run("powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-helper.ps1", MCP_DIR);
}
let helperBytes = null;
if (existsSync(helperSrc)) {
  const helperDest = join(VENDOR_DIR, "windows-mcp-helper.exe");
  copyFileSync(helperSrc, helperDest);
  helperBytes = readFileSync(helperDest);
  console.log(`vendor/windows-mcp-helper.exe copied (${(helperBytes.length / 1024 / 1024).toFixed(1)} MB)`);
} else {
  console.warn(
    `WARN: ${helperSrc} not found locally (expected on a Linux/Vercel build).\n` +
    `      Falling back to windows-mcp/helper-release.json if present.`,
  );
}

// 3a. Resolve the manifest's helper block. Priority:
//   (a) local exe present -> hash it, serve from /windows/vendor (local/Windows builds).
//   (b) no local exe but windows-mcp/helper-release.json committed -> use its external
//       (GitHub Releases) URL + pre-computed sha. THIS is the Vercel path, since the
//       exe is gitignored and absent on the Linux build host.
//   (c) neither -> null (loader errors with a clear "no helper info" message).
let helperManifest = null;
if (helperBytes) {
  helperManifest = {
    arch: "x64",
    url: "/windows/vendor/windows-mcp-helper.exe",
    sha256: createHash("sha256").update(helperBytes).digest("hex"),
    size_bytes: helperBytes.length,
    requires_runtime: "Microsoft.WindowsDesktop.App 8.0+",
  };
} else {
  const sidecarPath = join(MCP_DIR, "helper-release.json");
  if (existsSync(sidecarPath)) {
    try {
      const sc = JSON.parse(readFileSync(sidecarPath, "utf8"));
      if (!sc.url || !sc.sha256) throw new Error("missing url or sha256");
      helperManifest = {
        arch: sc.arch || "x64",
        url: sc.url,
        sha256: sc.sha256,
        size_bytes: sc.size_bytes ?? null,
        requires_runtime: sc.requires_runtime || "Microsoft.WindowsDesktop.App 8.0+",
      };
      console.log(`helper: using committed helper-release.json -> ${sc.url}`);
    } catch (e) {
      console.warn(`WARN: helper-release.json present but unusable (${e.message}). Manifest helper = null.`);
    }
  }
}

// 3b. Sandbox payload (vendor-sandbox/, self-contained ~190 MB across many
//     files). We compress to a single .zip via PowerShell's Compress-Archive
//     so the loader can fetch + extract atomically on the user's box.
//     The zip is too big for the Vercel static asset limit (100 MB), so the
//     manifest's sandbox_bundle.url is set from WINDOWS_MCP_SANDBOX_BUNDLE_URL
//     (a GitHub Releases asset URL the operator uploads out of band). If
//     unset, the manifest still includes the SHA so locally-served copies
//     can be verified.
const sandboxSrcDir = join(MCP_DIR, "vendor-sandbox");
let sandboxBundle = null;
if (existsSync(sandboxSrcDir) && process.platform === "win32") {
  const sandboxZipName = `windows-mcp-sandbox-v${version}.zip`;
  const sandboxZipPath = join(VENDOR_DIR, sandboxZipName);
  if (existsSync(sandboxZipPath)) {
    // Re-zip every build to keep SHA in sync with current contents.
    spawnSync("cmd.exe", ["/c", "del", "/q", sandboxZipPath], { stdio: "ignore" });
  }
  console.log(`> zipping sandbox payload (${countFiles(sandboxSrcDir)} files)…`);
  // Compress-Archive arguments: -Path "<dir>\*" preserves the directory contents
  // at the zip's root, which matches how Expand-Archive on the user's box
  // restores it.
  const psCmd = `Compress-Archive -Force -Path '${sandboxSrcDir}\\*' -DestinationPath '${sandboxZipPath}' -CompressionLevel Optimal`;
  const psRes = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCmd], { stdio: "inherit" });
  if (psRes.status !== 0 || !existsSync(sandboxZipPath)) {
    console.warn(`WARN: Compress-Archive failed (exit ${psRes.status}). Skipping sandbox_bundle in manifest.`);
  } else {
    const zipBytes = readFileSync(sandboxZipPath);
    const zipSha = createHash("sha256").update(zipBytes).digest("hex");
    const externalUrl = process.env.WINDOWS_MCP_SANDBOX_BUNDLE_URL || `/windows/vendor/${sandboxZipName}`;
    sandboxBundle = {
      version,
      url: externalUrl,
      sha256: zipSha,
      size_bytes: zipBytes.length,
      file_count_unpacked: countFiles(sandboxSrcDir),
      requires_os: "Windows 10/11 Pro/Enterprise/Education with Windows Sandbox feature enabled",
    };
    const human = (zipBytes.length / 1024 / 1024).toFixed(1);
    console.log(`vendor/${sandboxZipName} (${human} MB compressed)`);
    if (zipBytes.length > 95 * 1024 * 1024 && externalUrl.startsWith("/")) {
      console.warn(
        `WARN: sandbox zip is ${human} MB — exceeds Vercel's 100 MB static asset limit.\n` +
        `      Upload it to GitHub Releases manually and set\n` +
        `        $env:WINDOWS_MCP_SANDBOX_BUNDLE_URL = 'https://github.com/...'\n` +
        `      before rebuilding so the manifest references the external URL.`,
      );
    }
  }
} else if (process.platform === "win32") {
  console.log(`(no vendor-sandbox/ — run 'powershell scripts/build-helper.ps1 -Sandbox' inside windows-mcp/ to produce it)`);
}

// 3c. Sidecar fallback for the sandbox payload. Off-Windows build hosts
//     (Vercel/Linux) can't zip vendor-sandbox/ or compute its SHA, so 3b leaves
//     sandbox_bundle null and the deployed manifest ships without it — which
//     makes start_sandbox fail with "manifest has no sandbox_bundle" once a
//     client reconnects to the deployed loader (issue #32). Mirror the helper
//     handling (3a): if an operator has committed windows-mcp/sandbox-release.json
//     pointing at the externally-hosted zip (url + sha256), use it.
if (!sandboxBundle) {
  const sandboxSidecar = join(MCP_DIR, "sandbox-release.json");
  if (existsSync(sandboxSidecar)) {
    try {
      const sc = JSON.parse(readFileSync(sandboxSidecar, "utf8"));
      // Accept either the bundle object directly or one wrapped under a
      // `sandbox_bundle` key.
      const sb = sc && sc.sandbox_bundle ? sc.sandbox_bundle : sc;
      if (!sb || !sb.url || !sb.sha256) throw new Error("missing url or sha256");
      sandboxBundle = {
        version: sb.version || version,
        url: sb.url,
        sha256: sb.sha256,
        size_bytes: sb.size_bytes ?? null,
        file_count_unpacked: sb.file_count_unpacked ?? null,
        requires_os: sb.requires_os || "Windows 10/11 Pro/Enterprise/Education with Windows Sandbox feature enabled",
      };
      console.log(`sandbox: using committed sandbox-release.json -> ${sb.url}`);
    } catch (e) {
      console.warn(`WARN: sandbox-release.json present but unusable (${e.message}). Manifest sandbox_bundle = null.`);
    }
  }
}

// 4. Manifest.
const manifest = {
  product: "windows-mcp",
  version,
  url: `/windows/bundle/v${version}.mjs`,
  sha256: bundleSha,
  size_bytes: bundleBytes.length,
  released_at: new Date().toISOString(),
  helper: helperManifest,
  sandbox_bundle: sandboxBundle,
};
writeFileSync(join(BUNDLE_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

// 5. Copy windows loader + minify bootstrap.
copyFileSync(join(ROOT, "loader", "windows-loader.mjs"), join(OUT_DIR, "loader.mjs"));

const bootstrapSrc = readFileSync(join(ROOT, "loader", "windows-bootstrap.js"), "utf8");
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

console.log(`windows-mcp v${version}: bundle ${(bundleBytes.length / 1024).toFixed(0)} KB, helper ${helperManifest ? (helperManifest.size_bytes ? (helperManifest.size_bytes / 1024 / 1024).toFixed(1) + " MB " : "") + (helperBytes ? "local" : "external") : "MISSING"}, sandbox ${sandboxBundle ? (sandboxBundle.size_bytes / 1024 / 1024).toFixed(1) + " MB zip" : "missing"}, bootstrap ${bootstrapMin.length} chars`);
console.log("build-windows-mcp: done.");

function countFiles(dir) {
  let count = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) count += countFiles(p);
    else if (statSync(p).isFile()) count++;
  }
  return count;
}
