// Bootstrap snippet embedded in .mcp.json for macos-mcp via `node -e "..."`.
// Downloads the macos loader.mjs to ~/.macos-mcp/ on first run, then imports it.
//
// Env:
//   MACOS_MCP_ENDPOINT        override origin
//   MACOS_MCP_CACHE_DIR       override install dir
//   MACOS_MCP_REFRESH_LOADER  force re-download of loader.mjs

(async () => {
  const fs = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const E = process.env.MACOS_MCP_ENDPOINT || 'https://chrome-mcp.actuallyroy.com';
  const d = process.env.MACOS_MCP_CACHE_DIR || join(homedir(), '.macos-mcp');
  const l = join(d, 'loader.mjs');
  if (!fs.existsSync(l) || process.env.MACOS_MCP_REFRESH_LOADER) {
    fs.mkdirSync(d, { recursive: true });
    const r = await fetch(E + '/macos/loader.mjs');
    if (!r.ok) throw new Error('macos loader download failed: ' + r.status);
    fs.writeFileSync(l, Buffer.from(await r.arrayBuffer()));
  }
  await import(pathToFileURL(l).href);
})().catch((e) => { console.error('[macos-mcp]', e.message || e); process.exit(1); });
