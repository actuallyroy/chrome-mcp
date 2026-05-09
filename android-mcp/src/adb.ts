import { execFile, execFileSync, spawn, ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Loader cache dir (kept consistent with sqlite.ts / android-loader.mjs).
const CACHE_DIR = process.env.ANDROID_MCP_CACHE_DIR || join(homedir(), ".android-mcp");
export const CACHED_ADB = join(
  CACHE_DIR,
  "platform-tools",
  "adb" + (platform() === "win32" ? ".exe" : ""),
);

export function findAdb(): string {
  if (process.env.ANDROID_MCP_ADB && existsSync(process.env.ANDROID_MCP_ADB)) {
    return process.env.ANDROID_MCP_ADB;
  }
  if (process.env.ADB && existsSync(process.env.ADB)) return process.env.ADB;
  if (existsSync(CACHED_ADB)) return CACHED_ADB;

  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  const ext = platform() === "win32" ? ".exe" : "";
  const candidates: string[] = [];
  if (sdk) candidates.push(join(sdk, "platform-tools", "adb" + ext));
  if (platform() === "darwin") {
    candidates.push(
      join(homedir(), "Library/Android/sdk/platform-tools/adb"),
      "/opt/homebrew/bin/adb",
      "/usr/local/bin/adb",
      // Homebrew android-commandlinetools cask (issue #10).
      "/opt/homebrew/share/android-commandlinetools/platform-tools/adb",
      "/usr/local/share/android-commandlinetools/platform-tools/adb",
    );
  } else if (platform() === "linux") {
    candidates.push(
      join(homedir(), "Android/Sdk/platform-tools/adb"),
      "/usr/bin/adb",
      "/usr/local/bin/adb",
      "/snap/bin/adb",
    );
  } else if (platform() === "win32") {
    candidates.push(
      join(homedir(), "AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe"),
      "C:\\Android\\Sdk\\platform-tools\\adb.exe",
    );
  }
  const found = candidates.find((p) => existsSync(p));
  if (found) return found;

  // Last resort: shell `which`/`where` so $PATH installs work even when the
  // binary lives somewhere we didn't enumerate.
  try {
    const cmd = platform() === "win32" ? "where" : "which";
    const out = execFileSync(cmd, ["adb"], { encoding: "utf8", timeout: 2000 }).trim().split("\n")[0];
    if (out && existsSync(out)) return out;
  } catch { /* not on PATH */ }

  throw new Error(
    "adb binary not found. Either install Android SDK platform-tools manually, set " +
      "$ANDROID_SDK_ROOT / $ANDROID_MCP_ADB, OR call the `install_adb` MCP tool " +
      "(downloads ~13 MB from dl.google.com/android — ask the user's permission first).",
  );
}

let activeSerial: string | null = null;

export function setActiveSerial(serial: string | null) {
  activeSerial = serial;
}

export function getActiveSerial(): string | null {
  return activeSerial;
}

function baseArgs(): string[] {
  return activeSerial ? ["-s", activeSerial] : [];
}

export async function adb(
  args: string[],
  opts: { timeout_ms?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const bin = findAdb();
  const { stdout, stderr } = await execFileP(bin, [...baseArgs(), ...args], {
    timeout: opts.timeout_ms ?? 20_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { stdout, stderr };
}

export async function adbShell(
  cmd: string,
  opts: { timeout_ms?: number } = {},
): Promise<string> {
  const { stdout } = await adb(["shell", cmd], opts);
  return stdout;
}

export function adbSpawn(args: string[]): ChildProcess {
  const bin = findAdb();
  // If the caller already passed an explicit `-s <serial>` (first two args),
  // skip baseArgs to avoid duplicate `-s` flags. Otherwise fall back to the
  // active serial.
  const hasExplicitSerial = args[0] === "-s";
  const prefix = hasExplicitSerial ? [] : baseArgs();
  return spawn(bin, [...prefix, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

// Cached screen size from `adb shell wm size`. Avoid calling the v9-incompatible
// /window/rect endpoint.
let cachedSize: { w: number; h: number } | null = null;

export async function screenSize(): Promise<{ w: number; h: number }> {
  if (cachedSize) return cachedSize;
  try {
    const out = await adbShell("wm size");
    const m = out.match(/(\d+)x(\d+)/);
    if (m) {
      cachedSize = { w: Number(m[1]), h: Number(m[2]) };
      return cachedSize;
    }
  } catch { /* fall through */ }
  return { w: 1080, h: 2400 };
}
