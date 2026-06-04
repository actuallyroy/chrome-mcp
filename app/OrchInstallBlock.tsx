"use client";

import { useState } from "react";

// orch-mcp is installed differently from chrome/android/macos:
// - It shells out to the user's local `claude` CLI, so a cloud loader
//   doesn't add value (it can't run without Claude Code installed anyway).
// - The runtime is a plain Node script, no native helper to bundle.
//
// So this block shows the direct config snippet (path to a local build)
// rather than a bootstrap-loader payload.

export default function OrchInstallBlock() {
  const [copied, setCopied] = useState(false);

  const config = JSON.stringify(
    {
      mcpServers: {
        orch: {
          command: "node",
          args: ["/absolute/path/to/chrome-mcp/orch-mcp/dist/index.js"],
        },
      },
    },
    null,
    2,
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(config);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  };

  return (
    <pre>
      <button className="copy" onClick={copy}>
        {copied ? "copied" : "copy"}
      </button>
      <code>{config}</code>
    </pre>
  );
}
