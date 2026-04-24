"use client";

import { useEffect, useState } from "react";

type OS = "mac" | "linux" | "windows";

function detectOS(): OS {
  if (typeof navigator === "undefined") return "mac";
  const p = navigator.platform || "";
  const ua = navigator.userAgent || "";
  if (/Win/i.test(p) || /Windows/i.test(ua)) return "windows";
  if (/Mac/i.test(p)) return "mac";
  return "linux";
}

const SNIPPETS: Record<OS, string> = {
  mac: `curl -fsSL https://chrome-mcp.actuallyroy.com/install.sh | sh`,
  linux: `curl -fsSL https://chrome-mcp.actuallyroy.com/install.sh | sh`,
  windows: `irm https://chrome-mcp.actuallyroy.com/install.ps1 | iex`,
};

export default function InstallBlock() {
  const [os, setOs] = useState<OS>("mac");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setOs(detectOS());
  }, []);

  const cmd = SNIPPETS[os];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* noop */
    }
  };

  return (
    <>
      <div className="tabs" role="tablist">
        {(["mac", "linux", "windows"] as OS[]).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={os === key}
            onClick={() => setOs(key)}
          >
            {key === "mac" ? "macOS" : key === "linux" ? "Linux" : "Windows"}
          </button>
        ))}
      </div>
      <pre>
        <button className="copy" onClick={copy}>
          {copied ? "copied" : "copy"}
        </button>
        <code>{cmd}</code>
      </pre>
    </>
  );
}
