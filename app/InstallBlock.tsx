"use client";

import { useState } from "react";

type Props = {
  bootstrap: string;
  product: "chrome" | "android";
};

export default function InstallBlock({ bootstrap, product }: Props) {
  const [copied, setCopied] = useState(false);

  const serverKey = product === "android" ? "android" : "chrome";
  const config = JSON.stringify(
    {
      mcpServers: {
        [serverKey]: {
          command: "node",
          args: ["-e", bootstrap],
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
