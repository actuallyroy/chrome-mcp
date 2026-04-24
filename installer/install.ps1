# chrome-mcp installer for Windows.
# Usage:
#   irm https://chrome-mcp.actuallyroy.com/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$Endpoint = if ($env:CHROME_MCP_ENDPOINT) { $env:CHROME_MCP_ENDPOINT } else { 'https://chrome-mcp.actuallyroy.com' }
$InstallDir = if ($env:CHROME_MCP_CACHE_DIR) { $env:CHROME_MCP_CACHE_DIR } else { Join-Path $HOME '.chrome-mcp' }
$BinDir = Join-Path $InstallDir 'bin'
$ScriptsDir = Join-Path $InstallDir 'scripts'

function Require-Node {
    try { $v = node -e "process.stdout.write(process.versions.node)" } catch {
        Write-Error 'chrome-mcp: node is required (>=18). Install via https://nodejs.org'
    }
    $major = [int]($v.Split('.')[0])
    if ($major -lt 18) {
        Write-Error "chrome-mcp: node $v is too old. Need >=18 (for global fetch)."
    }
}

Require-Node

New-Item -ItemType Directory -Force -Path $BinDir, $ScriptsDir | Out-Null

Write-Host "chrome-mcp: downloading loader -> $InstallDir\loader.mjs"
Invoke-WebRequest -UseBasicParsing "$Endpoint/loader.mjs" -OutFile (Join-Path $InstallDir 'loader.mjs')

Write-Host "chrome-mcp: downloading launch-chrome.ps1 -> $ScriptsDir\launch-chrome.ps1"
Invoke-WebRequest -UseBasicParsing "$Endpoint/scripts/launch-chrome.ps1" -OutFile (Join-Path $ScriptsDir 'launch-chrome.ps1')

# Bin shim — a .cmd that execs node against the loader.
$shim = @"
@echo off
node "%~dp0..\loader.mjs" %*
"@
Set-Content -Path (Join-Path $BinDir 'chrome-mcp.cmd') -Value $shim -Encoding ASCII

# Convenience launcher for Chrome.
$launchShim = @"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "$ScriptsDir\launch-chrome.ps1" %*
"@
Set-Content -Path (Join-Path $BinDir 'chrome-mcp-launch-chrome.cmd') -Value $launchShim -Encoding ASCII

# Health check.
try { Invoke-WebRequest -UseBasicParsing "$Endpoint/bundle/manifest.json" | Out-Null }
catch { Write-Warning "could not fetch $Endpoint/bundle/manifest.json — loader will retry at runtime" }

$binPath = (Join-Path $BinDir 'chrome-mcp.cmd')
$launchPath = (Join-Path $BinDir 'chrome-mcp-launch-chrome.cmd')
# Escape backslashes for the JSON snippet.
$binJson = $binPath.Replace('\', '\\')

@"

================================================================
 chrome-mcp installed at $InstallDir
 Binary:          $binPath
 Chrome launcher: $launchPath
================================================================

Next steps:

1) Launch Chrome with remote debugging (in a separate PowerShell):

   $launchPath

2) Add this to %USERPROFILE%\.claude.json (or your project's .mcp.json):

   {
     "mcpServers": {
       "chrome": {
         "command": "$binJson"
       }
     }
   }

3) Restart Claude Code.

Pin a version:     `$env:CHROME_MCP_PIN_VERSION = '0.2.0'`
Disable updates:   `$env:CHROME_MCP_SKIP_UPDATE = '1'`

"@ | Write-Host
