# Compile the C# sidecar.
#
# Two output flavors:
#   default          → vendor/windows-mcp-helper.exe
#                      framework-dependent single-file (~25 MB). End users on
#                      the host need .NET 8 Desktop Runtime; loader prints a
#                      clear install hint if missing.
#   -Sandbox         → vendor-sandbox/   (a whole directory)
#                      self-contained multi-file publish (~190 MB). Ships
#                      inside Windows Sandbox, where there's no .NET runtime
#                      and where a single-file bundle's %TEMP%\.net
#                      extraction tax hits every cold boot.
#
# Switches:
#   -Sandbox                      build the self-contained sandbox payload
#   -BuildArm64                   also publish a win-arm64 slice (host flavor only)
#
# Env vars:
#   WINDOWS_MCP_DOTNET=<path>     pin a specific dotnet.exe (defaults to PATH)

param(
  [switch]$Sandbox,
  [switch]$BuildArm64
)

$ErrorActionPreference = "Stop"

$here  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root  = Resolve-Path (Join-Path $here "..")
$proj  = Join-Path $root "csharp-helper\WindowsMcpHelper.csproj"

if (-not (Test-Path $proj)) {
  throw "csproj not found at $proj"
}

$dotnet = $env:WINDOWS_MCP_DOTNET
if (-not $dotnet -or -not (Test-Path $dotnet)) {
  $cmd = Get-Command dotnet -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "dotnet not on PATH. Install .NET 8 SDK: https://dot.net/" }
  $dotnet = $cmd.Source
}

Write-Host "[build-helper] dotnet: $dotnet"
Write-Host "[build-helper] csproj: $proj"

function Stop-RunningHelpers {
  # Kill any lingering helper holding a lock on the vendor output we're about
  # to overwrite. Safe — Node helper.ts re-spawns on next call.
  Get-Process windows-mcp-helper -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "[build-helper] stopping running helper pid $($_.Id)"
    Stop-Process -Id $_.Id -Force
  }
  Start-Sleep -Milliseconds 200
}

function Publish-Host {
  param([string]$Rid, [string]$DestName)

  $publishDir = Join-Path $root "csharp-helper\bin\publish-host-$Rid"
  if (Test-Path $publishDir) { Remove-Item -Recurse -Force $publishDir }

  Write-Host "[build-helper] publishing host $Rid (framework-dependent, single-file) ..."
  & $dotnet publish $proj `
    -c Release `
    -r $Rid `
    --no-self-contained `
    -p:PublishSingleFile=true `
    -p:PublishReadyToRun=false `
    -p:DebugType=embedded `
    -o $publishDir
  if ($LASTEXITCODE -ne 0) { throw "dotnet publish (host $Rid) failed (exit $LASTEXITCODE)" }

  $srcExe = Join-Path $publishDir "windows-mcp-helper.exe"
  if (-not (Test-Path $srcExe)) { throw "publish ran but $srcExe missing" }

  Stop-RunningHelpers
  $outDir = Join-Path $root "vendor"
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $destExe = Join-Path $outDir $DestName
  Copy-Item $srcExe $destExe -Force
  $sz = (Get-Item $destExe).Length
  Write-Host ("[build-helper] host {0} -> {1} ({2:N0} bytes)" -f $Rid, $destExe, $sz)
}

function Publish-Sandbox {
  param([string]$Rid)

  $publishDir = Join-Path $root "csharp-helper\bin\publish-sandbox-$Rid"
  if (Test-Path $publishDir) { Remove-Item -Recurse -Force $publishDir }

  Write-Host "[build-helper] publishing sandbox $Rid (self-contained, multi-file) ..."
  & $dotnet publish $proj `
    -c Release `
    -r $Rid `
    --self-contained true `
    -p:SandboxBuild=true `
    -p:PublishSingleFile=false `
    -p:PublishReadyToRun=false `
    -p:DebugType=embedded `
    -o $publishDir
  if ($LASTEXITCODE -ne 0) { throw "dotnet publish (sandbox $Rid) failed (exit $LASTEXITCODE)" }

  $srcExe = Join-Path $publishDir "windows-mcp-helper.exe"
  if (-not (Test-Path $srcExe)) { throw "publish ran but $srcExe missing" }

  $outDir = Join-Path $root "vendor-sandbox"
  if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null

  Copy-Item (Join-Path $publishDir "*") $outDir -Recurse -Force

  $total = (Get-ChildItem $outDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
  $count = (Get-ChildItem $outDir -Recurse -File).Count
  Write-Host ("[build-helper] sandbox {0} -> {1} ({2:N0} bytes across {3} files)" -f $Rid, $outDir, $total, $count)
}

if ($Sandbox) {
  Publish-Sandbox -Rid "win-x64"
} else {
  Publish-Host -Rid "win-x64" -DestName "windows-mcp-helper.exe"
  if ($BuildArm64 -or $env:BUILD_ARM64 -eq "1") {
    Publish-Host -Rid "win-arm64" -DestName "windows-mcp-helper-arm64.exe"
  }
}

Write-Host "[build-helper] done."
