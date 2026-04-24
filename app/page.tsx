import { readFileSync } from "node:fs";
import { join } from "node:path";
import InstallBlock from "./InstallBlock";

type Manifest = {
  version: string;
  sha256: string;
  size_bytes: number;
  released_at: string;
  uiautomator2?: { version: string };
};

function read(relPath: string): string | null {
  try {
    return readFileSync(join(process.cwd(), "public", relPath), "utf8");
  } catch {
    return null;
  }
}

function readManifest(path: string): Manifest | null {
  const raw = read(path);
  return raw ? JSON.parse(raw) : null;
}

export default function Page() {
  const chromeManifest = readManifest("bundle/manifest.json");
  const androidManifest = readManifest("android/bundle/manifest.json");
  const chromeBootstrap = read("bootstrap.min.js")?.trim() ?? "";
  const androidBootstrap = read("android/bootstrap.min.js")?.trim() ?? "";

  return (
    <main>
      <h1>chrome-mcp · android-mcp</h1>
      <p className="tagline">
        MCP servers that drive your <em>real</em> Chrome browser and Android devices from Claude Code.
        Semantic locators, live debugging, flow recording — one config block, no install script.
      </p>

      <section>
        <h2>
          chrome-mcp{" "}
          {chromeManifest && <span className="meta">v{chromeManifest.version}</span>}
        </h2>
        <p>Drives Chrome on macOS/Linux/Windows via CDP. Auto-launches Chrome on first tool call.</p>
        <h3>Paste into <code>~/.claude.json</code> and restart Claude Code:</h3>
        <InstallBlock bootstrap={chromeBootstrap} product="chrome" />
        {chromeManifest && (
          <p className="hash">
            sha256: {chromeManifest.sha256}
            <br />
            <a href={`/bundle/v${chromeManifest.version}.mjs`}>bundle</a> ·{" "}
            <a href="/bundle/manifest.json">manifest</a> ·{" "}
            <a href="/loader.mjs">loader.mjs</a>
          </p>
        )}
      </section>

      <section>
        <h2>
          android-mcp{" "}
          {androidManifest && <span className="meta">v{androidManifest.version}</span>}
          {androidManifest?.uiautomator2 && (
            <span className="meta"> · UIAutomator2 {androidManifest.uiautomator2.version}</span>
          )}
        </h2>
        <p>
          Drives Android devices and emulators via UIAutomator2 (same chrome-mcp pattern, native view
          hierarchy instead of DOM). Requires <code>adb</code> and a device/emulator ready.
        </p>
        <h3>Paste into <code>~/.claude.json</code> and restart Claude Code:</h3>
        <InstallBlock bootstrap={androidBootstrap} product="android" />
        {androidManifest && (
          <p className="hash">
            sha256: {androidManifest.sha256}
            <br />
            <a href={`/android/bundle/v${androidManifest.version}.mjs`}>bundle</a> ·{" "}
            <a href="/android/bundle/manifest.json">manifest</a> ·{" "}
            <a href="/android/loader.mjs">loader.mjs</a> ·{" "}
            <a href="/android/vendor/uiautomator2-server.apk">u2 APK</a>
          </p>
        )}
      </section>

      <h2>How updates work</h2>
      <p>
        Each bootstrap downloads its loader.mjs once into <code>~/.chrome-mcp/</code> or{" "}
        <code>~/.android-mcp/</code>. The loader fetches the latest bundle on every launch, verifies
        its SHA-256, and runs it. If the endpoint is unreachable, it falls back to the cached bundle.
      </p>
      <ul>
        <li>
          <code>CHROME_MCP_PIN_VERSION</code> / <code>ANDROID_MCP_PIN_VERSION</code> — pin a version
        </li>
        <li>
          <code>CHROME_MCP_SKIP_UPDATE=1</code> / <code>ANDROID_MCP_SKIP_UPDATE=1</code> — skip
          network checks
        </li>
        <li>
          <code>*_ENDPOINT</code> — self-host the bundle elsewhere
        </li>
        <li>
          <code>*_REFRESH_LOADER=1</code> — force re-download of loader.mjs
        </li>
      </ul>

      <h2>What's in chrome-mcp</h2>
      <ul>
        <li><code>click / fill / fill_form / select_option</code> — semantic locators (text, label, ref, selector)</li>
        <li><code>outline</code> — compact DOM snapshot with stable refs</li>
        <li><code>get_toasts</code> / <code>wait_for_toast</code> — survives auto-dismiss</li>
        <li><code>get_console</code> / <code>get_network</code> — captured logs + fetch/XHR</li>
        <li><code>pause / resume</code> — in-page "Resume" overlay, blocks the agent</li>
        <li><code>inject_script</code> — persists across navigations</li>
        <li><code>start_recording / stop_recording / run_script / assert</code> — flows</li>
        <li><code>launch_chrome</code> — auto-fires on first tool call</li>
      </ul>

      <h2>What's in android-mcp</h2>
      <ul>
        <li><code>click / fill / long_press</code> — locators: text / desc / id / xpath / ref / class / UiSelector</li>
        <li><code>outline</code> — real view hierarchy, grouped by interaction type</li>
        <li><code>describe</code> — full node info for one element</li>
        <li><code>launch_app / stop_app / install_app / clear_app_data</code></li>
        <li><code>press_key</code> — HOME, BACK, APP_SWITCH, ENTER, VOLUME_UP…</li>
        <li><code>swipe / scroll (with until_text)</code></li>
        <li><code>get_logcat</code> — long-running ring buffer, filtered by tag/level</li>
        <li><code>adb_shell</code> — escape hatch</li>
        <li><code>start_recording / stop_recording / run_script / assert</code></li>
        <li><code>pause</code> — stderr + flag-file (touch /tmp/android-mcp.resume to continue)</li>
      </ul>
    </main>
  );
}
