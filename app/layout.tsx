import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "chrome-mcp — drive your real Chrome from Claude Code",
  description:
    "An MCP server that attaches to your running Chrome over CDP. Semantic tools, flow recording, auto-updating loader.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
