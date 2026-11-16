# Builds the Windows release: kokon-service.exe, kokon-mcp.exe, the desktop app and the
# NSIS installer ("Kokon_<version>_x64-setup.exe").
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
#
# Takes ~5-15 minutes on first run (optimized Rust build). CPU only.

$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot\.."
Set-Location $root
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

# ort's prebuilt ONNX Runtime needs AVX2 and stops with SIGILL on older CPUs (#53). Link the
# portable one built by tools\ort-portable\build-ort-portable.ps1 instead (docs/releasing.md).
if (-not $env:ORT_LIB_LOCATION) {
    $env:ORT_LIB_LOCATION = Join-Path $env:USERPROFILE 'kokon-deps\ort-portable\lib'
}
if (-not (Test-Path (Join-Path $env:ORT_LIB_LOCATION 'onnxruntime.lib'))) {
    throw "Portable ONNX Runtime not found: $env:ORT_LIB_LOCATION\onnxruntime.lib. Build it first: powershell -ExecutionPolicy Bypass -File tools\ort-portable\build-ort-portable.ps1"
}

Write-Host "1/5 Tests (Rust core + frontend)" -ForegroundColor Cyan
cargo test -p qls-core -p qls-service --release --quiet
if ($LASTEXITCODE) { throw "Rust tests failed" }
# kokon-service embeds the built UI (dist\) for browsers on other devices: build it first.
npm run build
if ($LASTEXITCODE) { throw "UI build failed" }
npx vitest run
if ($LASTEXITCODE) { throw "Frontend tests failed" }

Write-Host "2/5 kokon-service (release)" -ForegroundColor Cyan
cargo build -p qls-service --release
if ($LASTEXITCODE) { throw "service build failed" }
# src-tauri\binaries is not in the repository (it is gitignored), so a clean checkout has no
# folder to copy into — which is what the CI failed on. The Mac and Linux scripts do the same.
New-Item -ItemType Directory -Force src-tauri\binaries | Out-Null
Copy-Item target\release\kokon-service.exe src-tauri\binaries\kokon-service-x86_64-pc-windows-msvc.exe -Force

Write-Host "3/5 kokon-mcp + MCP tests (they drive the bundle and the service built above)" -ForegroundColor Cyan
Push-Location mcp; npm run build:exe; $rc = $LASTEXITCODE; Pop-Location
if ($rc) { throw "MCP build failed" }
# The protocol test runs the bundle above against the service built in step 2, not the sidecar Tauri
# copies here from the previous release, so it has to run after both.
Push-Location mcp; npx vitest run; $rc = $LASTEXITCODE; Pop-Location
if ($rc) { throw "MCP tests failed" }

Write-Host "4/5 Desktop app + NSIS installer (signed for the in-app updater)" -ForegroundColor Cyan
# Updates are verified against the public key in tauri.conf.json; the private key never
# leaves this machine (back it up: without it, installed copies cannot be updated).
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    $key = Join-Path $env:USERPROFILE ".tauri\kokon-updater.key"
    if (-not (Test-Path $key)) { throw "Updater signing key not found: $key (see docs/releasing.md)" }
    $env:TAURI_SIGNING_PRIVATE_KEY = $key
}
npx tauri build
if ($LASTEXITCODE) { throw "tauri build failed" }

Write-Host "5/5 Artifacts" -ForegroundColor Cyan
$exe = Get-Item "target\release\Kokon.exe"
$setup = Get-ChildItem "target\release\bundle\nsis\*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
New-Item -ItemType Directory -Force dist-release | Out-Null
Copy-Item $exe.FullName "dist-release\Kokon.exe" -Force
Copy-Item $setup.FullName "dist-release\Kokon Setup.exe" -Force
Copy-Item target\release\kokon-service.exe dist-release\ -Force
Copy-Item mcp\build\kokon-mcp.exe dist-release\ -Force
node scripts\release\updater.mjs fragment windows-x86_64 $setup.FullName
if ($LASTEXITCODE) { throw "updater entry failed" }
Get-ChildItem dist-release | Format-Table Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } -AutoSize
Write-Host "Installer: $root\dist-release\Kokon Setup.exe" -ForegroundColor Green
