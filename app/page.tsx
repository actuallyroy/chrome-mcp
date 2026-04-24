import { readFileSync } from "node:fs";
import { join } from "node:path";
import InstallBlock from "./InstallBlock";

type Manifest = {
  version: string;
  sha256: string;
  size_bytes: number;
  released_at: string;
};

function readManifest(): Manifest | null {
  try {
    const raw = readFileSync(join(process.cwd(), "public", "bundle", "manifest.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default function Page() {
  const manifest = readManifest();

  return (
    <main>
      <h1>chrome-mcp</h1>
      <p className="tagline">
        An MCP server that drives your <em>real</em> Chrome browser from Claude Code. Semantic
        locators, toast capture, flow recording, debug pause. One-liner install.
      </p>

      {manifest ? (
        <p className="meta">
          <span>
            Latest: <strong>v{manifest.version}</strong>
          </span>
          <span>{(manifest.size_bytes / 1024 / 1024).toFixed(2)} MB</span>
          <span>Released {new Date(manifest.released_at).toLocaleDateString()}</span>
        </p>
      ) : (
        <p className="meta">manifest not built yet</p>
      )}

      <h2>1. Install</h2>
      <p>Pick your OS. The installer writes a small loader + bin shim to your home directory.</p>
      <InstallBlock />

      <h2>2. Launch Chrome with debugging enabled</h2>
      <p>
        Modern Chrome refuses remote debugging on its default profile, so the launcher uses a
        dedicated profile at <code>~/ChromeMCP-Profile</code>. It coexists with your normal Chrome.
      </p>
      <pre>
        <code>
{`# macOS / Linux
~/.chrome-mcp/bin/chrome-mcp-launch-chrome

# Windows
%USERPROFILE%\\.chrome-mcp\\bin\\chrome-mcp-launch-chrome`}
        </code>
      </pre>

      <h2>3. Wire up Claude Code</h2>
      <p>
        Add this to <code>~/.claude.json</code> (user scope) or <code>.mcp.json</code> in your
        project, then restart Claude Code.
      </p>
      <pre>
        <code>
{`{
  "mcpServers": {
    "chrome": {
      "command": "~/.chrome-mcp/bin/chrome-mcp"
    }
  }
}`}
        </code>
      </pre>
      <p>
        On Windows replace the command with{" "}
        <code>%USERPROFILE%\\.chrome-mcp\\bin\\chrome-mcp.cmd</code>.
      </p>

      <h2>Updates</h2>
      <p>
        The loader checks this site for a newer version on each launch and verifies the SHA-256
        before using it. If the endpoint is unreachable it falls back to the cached bundle. Pin a
        version or disable updates via environment variables:
      </p>
      <pre>
        <code>
{`export CHROME_MCP_PIN_VERSION=${manifest?.version ?? "0.2.0"}
export CHROME_MCP_SKIP_UPDATE=1`}
        </code>
      </pre>

      {manifest && (
        <>
          <h2>Current bundle</h2>
          <p className="hash">
            sha256: {manifest.sha256}
            <br />
            url: <a href={`/bundle/v${manifest.version}.mjs`}>/bundle/v{manifest.version}.mjs</a>
            <br />
            manifest: <a href="/bundle/manifest.json">/bundle/manifest.json</a>
          </p>
        </>
      )}

      <h2>What's in it</h2>
      <ul>
        <li>
          Semantic tools: <code>click {"{ text | label | ref | selector }"}</code>,{" "}
          <code>fill</code>, <code>fill_form</code>, <code>select_option</code>
        </li>
        <li>
          <code>outline</code> — compact page snapshot with stable refs (cheaper than screenshots)
        </li>
        <li>
          <code>get_toasts</code> / <code>wait_for_toast</code> — capture sonner / role=alert
          notifications even after they auto-dismiss
        </li>
        <li>
          <code>get_console</code> / <code>get_network</code> — captured console logs + fetch/XHR
          traffic
        </li>
        <li>
          <code>pause</code> — injects a Resume overlay in the browser and blocks the agent
        </li>
        <li>
          <code>inject_script</code> — persists across navigations
        </li>
        <li>
          <code>start_recording</code> / <code>stop_recording</code> / <code>run_script</code> —
          capture a flow, replay it as a test
        </li>
      </ul>
    </main>
  );
}
