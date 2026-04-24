# launch-chrome.ps1 — launches Chrome with remote debugging on a dedicated profile.
# Modern Chrome refuses --remote-debugging-port on the default profile, so we use
# $HOME\ChromeMCP-Profile by default. Signs of logins and extensions persist across runs.

$Port = if ($env:CHROME_DEBUG_PORT) { $env:CHROME_DEBUG_PORT } else { '9222' }
$Profile = if ($env:CHROME_USER_DATA_DIR) { $env:CHROME_USER_DATA_DIR } else { Join-Path $HOME 'ChromeMCP-Profile' }

$ChromeBin = $env:CHROME_BIN
if (-not $ChromeBin) {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { $ChromeBin = $c; break } }
}
if (-not $ChromeBin -or -not (Test-Path $ChromeBin)) {
    Write-Error "Chrome binary not found. Set CHROME_BIN or install Chrome."
}

# Abort only if this specific profile / port is in use — not if your normal Chrome is open.
$portInUse = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($portInUse) {
    Write-Error "Port $Port already in use. Pick a different CHROME_DEBUG_PORT or stop the other instance."
}

$running = Get-Process -Name chrome -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $ChromeBin } |
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*--user-data-dir=$Profile*" }
if ($running) {
    Write-Error "A Chrome instance is already running against profile $Profile."
}

New-Item -ItemType Directory -Force -Path $Profile | Out-Null

Write-Host "Launching Chrome with remote debugging on port $Port..."
Write-Host "Profile: $Profile"

& $ChromeBin "--remote-debugging-port=$Port" "--user-data-dir=$Profile"
