// Tiny zero-dep static file server for local end-to-end testing of the
// windows-mcp loader → bundle → helper-exe flow without touching Vercel.
// Usage: node scripts/static-serve.mjs [port=18888] [dir=public]

import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

const PORT = Number(process.argv[2] || process.env.STATIC_PORT || 18888);
const ROOT = resolve(process.argv[3] || "public");

const MIME = {
  ".mjs": "application/javascript",
  ".js": "application/javascript",
  ".json": "application/json",
  ".html": "text/html",
  ".png": "image/png",
  ".exe": "application/vnd.microsoft.portable-executable",
};

createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  // Guard against path traversal.
  const rel = normalize(url).replace(/^([/\\])+/, "");
  const abs = join(ROOT, rel);
  if (!abs.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
  try {
    const st = statSync(abs);
    if (!st.isFile()) { res.writeHead(404).end("not found"); return; }
    const ext = (abs.match(/\.[^.\\/]+$/) || [""])[0].toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": st.size,
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    createReadStream(abs).pipe(res);
    console.error(`[serve] 200 ${rel} (${st.size} bytes)`);
  } catch {
    res.writeHead(404).end("not found");
    console.error(`[serve] 404 ${rel}`);
  }
}).listen(PORT, "127.0.0.1", () => {
  console.error(`[serve] listening on http://127.0.0.1:${PORT}/ — root=${ROOT}`);
});
