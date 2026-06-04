// Bootstrap snippet embedded in .mcp.json for orch-mcp via `node -e "..."`.
// Downloads the orch loader.mjs to ~/.orch-mcp/ on first run, then imports it.
//
// Env:
//   ORCH_MCP_ENDPOINT        override origin
//   ORCH_MCP_CACHE_DIR       override install dir
//   ORCH_MCP_REFRESH_LOADER  force re-download of loader.mjs

(async () => {
  const fs = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const E = process.env.ORCH_MCP_ENDPOINT || 'https://chrome-mcp.actuallyroy.com';
  const d = process.env.ORCH_MCP_CACHE_DIR || join(homedir(), '.orch-mcp');
  const l = join(d, 'loader.mjs');
  if (!fs.existsSync(l) || process.env.ORCH_MCP_REFRESH_LOADER) {
    fs.mkdirSync(d, { recursive: true });
    const r = await fetch(E + '/orch/loader.mjs');
    if (!r.ok) throw new Error('orch loader download failed: ' + r.status);
    fs.writeFileSync(l, Buffer.from(await r.arrayBuffer()));
  }
  await import(pathToFileURL(l).href);
})().catch((e) => { console.error('[orch-mcp]', e.message || e); process.exit(1); });
