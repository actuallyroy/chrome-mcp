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
      <h1>Drive real Chrome + Android from Claude Code</h1>
      <p className="tagline">
        Two MCP servers that let an agent tap, type, and reason through your actual apps — the
        browser you're logged into and the device in your hand. No headless sandbox, no fragile
        selectors, no install script.
      </p>

      <section>
        <h2>
          chrome-mcp{" "}
          {chromeManifest && <span className="meta">v{chromeManifest.version}</span>}
        </h2>
        <p>
          Attaches over CDP to your running Chrome. Auto-launches it the first time you send a
          command. macOS, Linux, Windows. The agent sees your logged-in tabs — Gmail, internal
          dashboards, whatever.
        </p>
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
          Drives a real Android device or emulator via UIAutomator2. Same locator ergonomics as the
          Chrome version, but against the native view hierarchy (text, resource-id, content-desc, or
          XPath — no pixel matching). Requires <code>adb</code> on PATH. APK installs itself on
          first use.
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

      <h2>Why not Playwright / Maestro / Appium?</h2>
      <p>
        Those are great for CI suites that run on clean sandboxes. They're frustrating for{" "}
        <em>agent-driven</em> work — screenshots on every step, flaky text matching, no live pause,
        no good way to see a React Native LogBox or an auto-dismissed toast. These MCPs are designed
        around that loop: one cheap <code>outline</code> call describes the page; refs are stable
        across calls; dev overlays get auto-dismissed before your next click; failed order? A toast
        popped up for 800 ms and we captured it.
      </p>

      <h2>How updates work</h2>
      <p>
        The bootstrap in the config block is a 600-char Node snippet. First run it downloads a
        ~4 KB loader to <code>~/.chrome-mcp/</code> or <code>~/.android-mcp/</code>. The loader
        fetches the latest bundle on every launch, verifies its SHA-256, and runs it. Offline? It
        falls back to the cached bundle. No npm publish step, no manual upgrade.
      </p>
      <ul>
        <li>
          <code>CHROME_MCP_PIN_VERSION</code> / <code>ANDROID_MCP_PIN_VERSION</code> — pin a version
        </li>
        <li>
          <code>CHROME_MCP_SKIP_UPDATE=1</code> / <code>ANDROID_MCP_SKIP_UPDATE=1</code> — use cached
          bundle, skip network
        </li>
        <li>
          <code>*_ENDPOINT</code> — self-host the bundles on your own domain
        </li>
        <li>
          <code>*_REFRESH_LOADER=1</code> — force re-download of <code>loader.mjs</code>
        </li>
      </ul>

      <h2>What's in chrome-mcp</h2>
      <ul>
        <li>
          <code>click / fill / fill_form / select_option</code> — locate by visible text, form
          label, accessibility ref, or CSS selector (escape hatch)
        </li>
        <li>
          <code>outline</code> — compact page snapshot with stable refs that persist across calls
        </li>
        <li>
          <code>get_toasts</code> / <code>wait_for_toast</code> — captures sonner / role=alert
          messages even when they auto-dismiss
        </li>
        <li>
          <code>get_console</code> / <code>get_network</code> — ring-buffered logs and
          fetch/XHR traffic
        </li>
        <li>
          <code>pause</code> / <code>resume</code> — in-page "Resume" overlay that blocks the agent
          until you click it
        </li>
        <li>
          <code>inject_script</code> — persists across navigations (debug helpers, test hooks)
        </li>
        <li>
          <code>start_recording / stop_recording / run_script / assert</code> — capture a flow
          live, replay it as a test
        </li>
        <li>
          <code>launch_chrome</code> — spawns Chrome with a dedicated debug profile; also runs
          automatically on first tool call
        </li>
      </ul>

      <h2>What's in android-mcp</h2>
      <ul>
        <li>
          <code>click / fill / long_press / swipe / scroll</code> — locators: text, content-desc,
          resource-id, xpath, ref, class, or raw UiSelector
        </li>
        <li>
          <code>outline</code> — real Android view hierarchy with stable refs (no OCR, no pixel
          diffing)
        </li>
        <li>
          <code>describe</code> — full element info (attrs, rect, ancestors)
        </li>
        <li>
          <code>launch_app / stop_app / install_app / clear_app_data / current_app</code>
        </li>
        <li>
          <code>press_key</code> — HOME, BACK, APP_SWITCH, ENTER, VOLUME_UP… or raw keycodes
        </li>
        <li>
          <code>scroll {"{ until_text }"}</code> — scrolls until target is on screen
        </li>
        <li>
          <code>get_logcat</code> — filtered ring buffer (by tag, level, or substring)
        </li>
        <li>
          <code>dismiss_dev_overlay</code> — handles React Native LogBox + Android ANR dialogs.
          Runs automatically before every interactive tool.
        </li>
        <li>
          <code>adb_shell</code> — escape hatch
        </li>
        <li>
          <code>start_recording / stop_recording / run_script / assert</code> — same flow pattern
          as chrome-mcp
        </li>
        <li>
          <code>wait_for_stable</code> — polls the view tree until two consecutive snapshots match
        </li>
      </ul>

      <h2>Honest caveats</h2>
      <ul>
        <li>
          <strong>Both are local-only.</strong> No cloud farm, no parallel execution — one
          agent, one browser, one device.
        </li>
        <li>
          <strong>iOS isn't in android-mcp yet.</strong> WebDriverAgent + Xcode provisioning is a
          separate dance.
        </li>
        <li>
          <strong>React Native controlled inputs can reject raw keystrokes.</strong> Numeric fields
          with custom <code>onChangeText</code> filters are the main casualty. There's a fallback
          via <code>adb input text</code> that works for most fields.
        </li>
        <li>
          <strong>The bundle is auto-downloaded.</strong> SHA-256 verified, cached locally. If
          you're uncomfortable with that, pin a version and review the bundle yourself.
        </li>
      </ul>
    </main>
  );
}
