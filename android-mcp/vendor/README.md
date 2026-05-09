# Vendored binaries

## sqlite3-arm64

Android arm64 (aarch64) build of the upstream `sqlite3` CLI.

- **Source:** https://github.com/amitwinit/SQLite-DevTools-Mobile-ReactNative
  (tracked file: `sqlite3-arm64`).
- **Upstream license:** MIT (the SQLite-DevTools repo). The SQLite library
  itself is in the public domain.
- **Why it's here:** there is no canonical Android distribution of the
  `sqlite3` CLI. Many devices ship without `/system/bin/sqlite3`, so the
  `sqlite_*` MCP tools push this binary to `/data/local/tmp/sqlite3` as a
  last-resort fallback when no on-device binary is found.
- **Architecture limitation:** arm64 only. x86_64 emulators will need a
  matching binary supplied via the `ANDROID_MCP_SQLITE3` env var.

This binary is redistributed under MIT, which is GPLv3-compatible — fine to
include inside this GPLv3-licensed package.
