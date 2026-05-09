// On-demand platform-tools download. Pulls the official Google zip for the
// current host OS into the loader cache dir so findAdb() picks it up.
//
// We do NOT auto-trigger this on a missing-adb error — the agent has to call
// `install_adb` explicitly, which forces the user to opt in (an extra ~13 MB
// download from a Google CDN is the kind of thing you should consent to).

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CACHED_ADB } from "./adb.js";

const execFileP = promisify(execFile);

const CACHE_DIR = process.env.ANDROID_MCP_CACHE_DIR || join(homedir(), ".android-mcp");

function osSlug(): "darwin" | "linux" | "windows" {
  const p = platform();
  if (p === "darwin") return "darwin";
  if (p === "win32") return "windows";
  return "linux";
}

const ZIP_URL = `https://dl.google.com/android/repository/platform-tools-latest-${osSlug()}.zip`;

export type InstallAdbResult = {
  ok: true;
  adb_path: string;
  size_bytes: number;
  source: string;
};

export async function installAdb(): Promise<InstallAdbResult> {
  if (existsSync(CACHED_ADB)) {
    return { ok: true, adb_path: CACHED_ADB, size_bytes: 0, source: "already-installed" };
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  const zipPath = join(tmpdir(), `android-mcp-platform-tools-${Date.now()}.zip`);
  const stagingDir = join(CACHE_DIR, ".pt-staging-" + Date.now());

  try {
    const res = await fetch(ZIP_URL, {
      headers: { "user-agent": "android-mcp-installer/1" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`${ZIP_URL} → HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(zipPath, buf);

    mkdirSync(stagingDir, { recursive: true });
    if (platform() === "win32") {
      // PowerShell Expand-Archive ships with Win10+.
      await execFileP(
        "powershell.exe",
        ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${stagingDir}' -Force`],
        { timeout: 120_000 },
      );
    } else {
      // mac/linux: system unzip.
      await execFileP("unzip", ["-q", zipPath, "-d", stagingDir], { timeout: 120_000 });
    }

    // Zip contains a top-level `platform-tools/` directory.
    const extracted = join(stagingDir, "platform-tools");
    if (!existsSync(extracted)) {
      throw new Error(`unzip produced unexpected layout (no platform-tools/ in ${stagingDir})`);
    }
    const finalDir = join(CACHE_DIR, "platform-tools");
    // Replace any half-installed previous attempt.
    try { rmSync(finalDir, { recursive: true, force: true }); } catch { /* ignore */ }
    renameSync(extracted, finalDir);

    if (!existsSync(CACHED_ADB)) {
      throw new Error(`installer finished but adb not at expected path: ${CACHED_ADB}`);
    }
    return { ok: true, adb_path: CACHED_ADB, size_bytes: buf.length, source: ZIP_URL };
  } finally {
    try { rmSync(zipPath, { force: true }); } catch { /* ignore */ }
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
