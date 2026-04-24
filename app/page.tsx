import { readFileSync } from "node:fs";
import { join } from "node:path";
import InstallBlock from "./InstallBlock";

type Manifest = {
  version: string;
  sha256: string;
  size_bytes: number;
  released_at: string;
};

function read(relPath: string): string | null {
  try {
    return readFileSync(join(process.cwd(), "public", relPath), "utf8");
  } catch {
    return null;
  }
}

function readManifest(): Manifest | null {
  const raw = read("bundle/manifest.json");
  return raw ? JSON.parse(raw) : null;
}

export default function Page() {
  const manifest = readManifest();
  const bootstrap = read("bootstrap.min.js")?.trim() ?? "";

  return (
    <main>
      <h1>chrome-mcp</h1>
      <p className="tagline">
        An MCP server that drives your <em>real</em> Chrome from Claude Code. Semantic locators,
        toast capture, flow recording, debug pause — one config block, no install script.
      </p>

      {manifest && (
        <p className="meta">
          <span>
            Latest: <strong>v{manifest.version}</strong>
          </span>
          <span>{(manifest.size_bytes / 1024 / 1024).toFixed(2)} MB</span>
          <span>Released {new Date(manifest.released_at).toLocaleDateString()}</span>
        </p>
      )}

      <h2>Paste into <code>~/.claude.json</code> (or <code>.mcp.json</code>) and restart Claude Code:</h2>
      <InstallBlock bootstrap={bootstrap} />

      <p>
        That's it. On first launch the <code>node -e …</code> bootstrap downloads{" "}
        <code>~/.chrome-mcp/loader.mjs</code>, which fetches the latest bundle (verifying SHA-256),
        caches it, and runs it. Subsequent launches use the cache. Updates happen automatically when
        a new version is released; pin via <code>CHROME_MCP_PIN_VERSION</code> or disable checks
        with <code>CHROME_MCP_SKIP_UPDATE=1</code>.
      </p>

      <h2>Chrome launches itself</h2>
      <p>
        The first tool call triggers the MCP to spawn Chrome with{" "}
        <code>--remote-debugging-port=9222</code> on a dedicated profile at{" "}
        <code>~/ChromeMCP-Profile</code>. A Chrome window pops up — sign into whatever sites you
        want the agent to drive, once. That profile persists, so future runs skip the login step.
        This coexists with your normal Chrome; we don't touch your main profile.
      </p>
      <p>
        You can also invoke the <code>launch_chrome</code> tool directly if you want to pre-launch
        before issuing other commands.
      </p>

      <h2>Environment variables</h2>
      <ul>
        <li>
          <code>CHROME_MCP_PIN_VERSION</code> — stick to a specific version, skip update checks
        </li>
        <li>
          <code>CHROME_MCP_SKIP_UPDATE=1</code> — always use cached bundle, don't hit network
        </li>
        <li>
          <code>CHROME_MCP_ENDPOINT</code> — override the origin (self-hosting)
        </li>
        <li>
          <code>CHROME_MCP_CACHE_DIR</code> — override <code>~/.chrome-mcp/</code>
        </li>
        <li>
          <code>CHROME_MCP_REFRESH_LOADER=1</code> — re-download <code>loader.mjs</code> (after an
          upstream loader update)
        </li>
        <li>
          <code>CHROME_DEBUG_PORT</code> / <code>CHROME_USER_DATA_DIR</code> / <code>CHROME_BIN</code>
          {" "}— override the Chrome launch settings
        </li>
      </ul>

      {manifest && (
        <>
          <h2>Current bundle</h2>
          <p className="hash">
            sha256: {manifest.sha256}
            <br />
            bundle: <a href={`/bundle/v${manifest.version}.mjs`}>
              /bundle/v{manifest.version}.mjs
            </a>
            <br />
            manifest: <a href="/bundle/manifest.json">/bundle/manifest.json</a>
            <br />
            loader: <a href="/loader.mjs">/loader.mjs</a>
          </p>
        </>
      )}

      <h2>What's in it</h2>
      <ul>
        <li>
          Semantic locators: <code>click {"{ text | label | ref | selector }"}</code>,{" "}
          <code>fill</code>, <code>fill_form</code>, <code>select_option</code>
        </li>
        <li>
          <code>outline</code> — compact page snapshot with stable refs (cheaper than screenshots)
        </li>
        <li>
          <code>get_toasts</code> / <code>wait_for_toast</code> — captures sonner / role=alert even
          when it auto-dismisses
        </li>
        <li>
          <code>get_console</code> / <code>get_network</code> — captured console logs + fetch/XHR
        </li>
        <li>
          <code>pause</code> — in-page "Resume" overlay that blocks the agent
        </li>
        <li>
          <code>inject_script</code> — persists across navigations
        </li>
        <li>
          <code>start_recording</code> / <code>stop_recording</code> / <code>run_script</code> /{" "}
          <code>assert</code> — record a flow, replay it as a test
        </li>
        <li>
          <code>launch_chrome</code> — explicit Chrome launcher (auto-fires on first tool call)
        </li>
      </ul>
    </main>
  );
}
