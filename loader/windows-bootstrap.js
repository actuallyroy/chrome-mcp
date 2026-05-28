// Bootstrap snippet embedded in .mcp.json for windows-mcp via `node -e "..."`.
// Downloads the windows loader.mjs to %USERPROFILE%\.windows-mcp\ on first run,
// then imports it.
//
// Env:
//   WINDOWS_MCP_ENDPOINT        override origin
//   WINDOWS_MCP_CACHE_DIR       override install dir
//   WINDOWS_MCP_REFRESH_LOADER  force re-download of loader.mjs

(async () => {
  const fs = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const E = process.env.WINDOWS_MCP_ENDPOINT || 'https://chrome-mcp.actuallyroy.com';
  const d = process.env.WINDOWS_MCP_CACHE_DIR || join(homedir(), '.windows-mcp');
  const l = join(d, 'loader.mjs');
  if (!fs.existsSync(l) || process.env.WINDOWS_MCP_REFRESH_LOADER) {
    fs.mkdirSync(d, { recursive: true });
    const r = await fetch(E + '/windows/loader.mjs');
    if (!r.ok) throw new Error('windows loader download failed: ' + r.status);
    fs.writeFileSync(l, Buffer.from(await r.arrayBuffer()));
  }
  await import(pathToFileURL(l).href);
})().catch((e) => { console.error('[windows-mcp]', e.message || e); process.exit(1); });
