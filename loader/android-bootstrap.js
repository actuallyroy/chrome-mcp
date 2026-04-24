// Bootstrap snippet embedded in .mcp.json for android-mcp via `node -e "..."`.
// Downloads the android loader.mjs to ~/.android-mcp/ on first run, then imports it.
//
// Env:
//   ANDROID_MCP_ENDPOINT        override origin
//   ANDROID_MCP_CACHE_DIR       override install dir
//   ANDROID_MCP_REFRESH_LOADER  force re-download of loader.mjs

(async () => {
  const fs = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const E = process.env.ANDROID_MCP_ENDPOINT || 'https://chrome-mcp.actuallyroy.com';
  const d = process.env.ANDROID_MCP_CACHE_DIR || join(homedir(), '.android-mcp');
  const l = join(d, 'loader.mjs');
  if (!fs.existsSync(l) || process.env.ANDROID_MCP_REFRESH_LOADER) {
    fs.mkdirSync(d, { recursive: true });
    const r = await fetch(E + '/android/loader.mjs');
    if (!r.ok) throw new Error('android loader download failed: ' + r.status);
    fs.writeFileSync(l, Buffer.from(await r.arrayBuffer()));
  }
  await import(pathToFileURL(l).href);
})().catch((e) => { console.error('[android-mcp]', e.message || e); process.exit(1); });
