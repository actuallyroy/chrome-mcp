// Bootstrap snippet embedded in .mcp.json via `node -e "..."`.
// Its only job: download loader.mjs to ~/.chrome-mcp/ if missing, then import it.
// Keep this file readable; scripts/build-mcp.mjs produces a minified one-liner.
//
// Env:
//   CHROME_MCP_ENDPOINT     override origin
//   CHROME_MCP_CACHE_DIR    override install dir
//   CHROME_MCP_REFRESH_LOADER=1  force re-download of loader.mjs

(async () => {
  const fs = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const E = process.env.CHROME_MCP_ENDPOINT || 'https://chrome-mcp.actuallyroy.com';
  const d = process.env.CHROME_MCP_CACHE_DIR || join(homedir(), '.chrome-mcp');
  const l = join(d, 'loader.mjs');
  if (!fs.existsSync(l) || process.env.CHROME_MCP_REFRESH_LOADER) {
    fs.mkdirSync(d, { recursive: true });
    const r = await fetch(E + '/loader.mjs');
    if (!r.ok) throw new Error('loader download failed: ' + r.status);
    fs.writeFileSync(l, Buffer.from(await r.arrayBuffer()));
  }
  await import(pathToFileURL(l).href);
})().catch((e) => { console.error('[chrome-mcp]', e.message || e); process.exit(1); });
