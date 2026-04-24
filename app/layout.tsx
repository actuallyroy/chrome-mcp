import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Drive real Chrome + Android from Claude Code — MCP servers",
  description:
    "Two MCP servers that let Claude Code drive your actual Chrome browser and Android devices. Semantic locators, flow recording, live debugging. One JSON block — no install script.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
