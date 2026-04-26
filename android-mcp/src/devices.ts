import { adb, setActiveSerial, getActiveSerial, adbShell } from "./adb.js";

export type DeviceInfo = {
  serial: string;
  state: string;
  product?: string;
  model?: string;
  device?: string;
  transport_id?: string;
};

export async function listDevices(): Promise<DeviceInfo[]> {
  const { stdout } = await adb(["devices", "-l"]);
  const lines = stdout.split("\n").slice(1);
  const out: DeviceInfo[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const [serial, state, ...rest] = t.split(/\s+/);
    const info: DeviceInfo = { serial, state };
    for (const kv of rest) {
      const [k, v] = kv.split(":");
      if (!k || v == null) continue;
      if (k === "product") info.product = v;
      else if (k === "model") info.model = v;
      else if (k === "device") info.device = v;
      else if (k === "transport_id") info.transport_id = v;
    }
    out.push(info);
  }
  return out;
}

export async function ensureDevice(): Promise<DeviceInfo> {
  const active = getActiveSerial();
  const devices = await listDevices();
  const ready = devices.filter((d) => d.state === "device");
  if (active) {
    const found = ready.find((d) => d.serial === active);
    if (found) return found;
    // Previously-selected device is gone. Do NOT silently fall back to another
    // connected device — that's how multi-device sessions end up driving the
    // wrong phone. Force the caller to re-select explicitly.
    const others = ready.map((d) => d.serial).join(", ") || "none ready";
    throw new Error(
      `Previously selected device ${active} is no longer ready (other devices: ${others}). ` +
        `Call select_device { serial } to choose one.`,
    );
  }
  if (ready.length === 0) {
    const offline = devices.filter((d) => d.state !== "device");
    const hint = offline.length
      ? ` (${offline.length} in state: ${offline.map((d) => d.state).join(", ")})`
      : " — connect one or launch an emulator";
    throw new Error(`No Android devices ready${hint}`);
  }
  if (ready.length > 1) {
    throw new Error(
      `Multiple devices connected (${ready.map((d) => d.serial).join(", ")}). ` +
        `Call select_device { serial } first.`,
    );
  }
  setActiveSerial(ready[0].serial);
  return ready[0];
}

export async function selectDevice(serial: string): Promise<DeviceInfo> {
  const devices = await listDevices();
  const found = devices.find((d) => d.serial === serial);
  if (!found) throw new Error(`Device ${serial} not connected`);
  if (found.state !== "device") {
    throw new Error(`Device ${serial} is ${found.state}, not ready`);
  }
  const previous = getActiveSerial();
  setActiveSerial(serial);
  if (previous && previous !== serial) {
    // Existing UIAutomator2 session is bound to the old device — kill it so the
    // next u2() call rebuilds against the newly selected serial.
    const { teardownSession } = await import("./uiautomator2.js");
    await teardownSession();
  }
  return found;
}

export async function deviceInfo(): Promise<Record<string, string>> {
  await ensureDevice();
  const props = [
    "ro.product.manufacturer",
    "ro.product.model",
    "ro.product.device",
    "ro.build.version.release",
    "ro.build.version.sdk",
    "ro.build.id",
  ];
  const out: Record<string, string> = {};
  for (const p of props) {
    const v = (await adbShell(`getprop ${p}`)).trim();
    if (v) out[p] = v;
  }
  return out;
}

export async function currentApp(): Promise<{ package: string; activity: string } | null> {
  await ensureDevice();
  const out = await adbShell(
    "dumpsys activity activities | grep -E 'ResumedActivity|mCurrentFocus' | head -n 3",
  );
  // Match e.g. "ResumedActivity: ActivityRecord{...  com.android.settings/.Settings ..."
  const m = out.match(/([a-zA-Z0-9_.]+)\/([a-zA-Z0-9_.]+)/);
  if (!m) return null;
  return { package: m[1], activity: m[2].startsWith(".") ? m[1] + m[2] : m[2] };
}
