import { execFile, spawn, ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export function findAdb(): string {
  if (process.env.ANDROID_MCP_ADB && existsSync(process.env.ANDROID_MCP_ADB)) {
    return process.env.ANDROID_MCP_ADB;
  }
  if (process.env.ADB && existsSync(process.env.ADB)) return process.env.ADB;

  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  const ext = platform() === "win32" ? ".exe" : "";
  const candidates: string[] = [];
  if (sdk) candidates.push(join(sdk, "platform-tools", "adb" + ext));
  if (platform() === "darwin") {
    candidates.push(
      join(homedir(), "Library/Android/sdk/platform-tools/adb"),
      "/opt/homebrew/bin/adb",
      "/usr/local/bin/adb",
    );
  } else if (platform() === "linux") {
    candidates.push(
      join(homedir(), "Android/Sdk/platform-tools/adb"),
      "/usr/bin/adb",
      "/usr/local/bin/adb",
    );
  } else if (platform() === "win32") {
    candidates.push(
      join(homedir(), "AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe"),
      "C:\\Android\\Sdk\\platform-tools\\adb.exe",
    );
  }
  const found = candidates.find((p) => existsSync(p));
  if (found) return found;
  throw new Error(
    "adb binary not found. Install Android SDK platform-tools, set $ANDROID_SDK_ROOT, " +
      "or set $ANDROID_MCP_ADB to the absolute path of adb.",
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
  return spawn(bin, [...baseArgs(), ...args], { stdio: ["ignore", "pipe", "pipe"] });
}
