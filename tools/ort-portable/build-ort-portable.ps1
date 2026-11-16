# Builds a portable ONNX Runtime for Kokon on Windows: MSVC's x64 baseline (SSE2; it runs on
# every machine Kokon supports), with MLAS's AVX/AVX2/AVX-512 kernels still compiled and chosen
# at runtime. Do NOT add /arch:AVX or /arch:AVX2 here: that is what makes ort's prebuilt
# libraries crash on a Xeon X5670.
#
#   powershell -ExecutionPolicy Bypass -File tools\ort-portable\build-ort-portable.ps1
#
# Result: %USERPROFILE%\kokon-deps\ort-portable\lib\onnxruntime.lib
# Then, before scripts\build-release.ps1:
#
#   $env:ORT_LIB_LOCATION = "$env:USERPROFILE\kokon-deps\ort-portable\lib"
#
# Needs: Visual Studio 2022 or newer (Desktop C++), CMake >= 3.26, Python 3, Git.
# See README.md.
$ErrorActionPreference = 'Stop'

$OrtVersion = if ($env:ORT_VERSION) { $env:ORT_VERSION } else { 'v1.31.0' }
$Deps = if ($env:KOKON_DEPS) { $env:KOKON_DEPS } else { Join-Path $env:USERPROFILE 'kokon-deps' }
$Src = Join-Path $Deps 'onnxruntime'
$Build = Join-Path $Deps 'ort-build'
$Prefix = Join-Path $Deps 'ort-portable'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($args -contains '--clean') {
    Remove-Item -Recurse -Force $Build, $Prefix -ErrorAction SilentlyContinue
}

if (-not (Test-Path (Join-Path $Src '.git'))) {
    Write-Host "==> Cloning ONNX Runtime $OrtVersion into $Src" -ForegroundColor Cyan
    New-Item -ItemType Directory -Force $Deps | Out-Null
    # core.autocrlf=false keeps the checkout as the repository stores it, which is what the patch
    # step below needs. -c applies to the whole clone, so the submodules get it too.
    git clone --recursive --depth 1 -c core.autocrlf=false --branch $OrtVersion https://github.com/microsoft/onnxruntime $Src
    if ($LASTEXITCODE) { throw "git clone failed" }
}

# Same rule as the .sh: `patch --binary` compares bytes, so the .patch files must be the bytes the
# repository stores — the clone is made with core.autocrlf=false and the files are taken from git.
# The ONNX patch is not byte-exact against the sources it patches (its context has 4-space
# indentation where ONNX v1.22.0 has 2), so it needs whitespace tolerance and fuzz, and patch
# implementations disagree: the CI runner's patch 2.5.9 refused two hunks that GNU patch 2.7.6
# applies. patches/onnx-v1.22.0.patch is the same hunks written against the pinned sources, so any
# implementation applies them; if the pin is a different version, keep upstream's file and say so.
$onnxPin = 'onnx;https://github.com/onnx/onnx/archive/refs/tags/v1.22.0.zip;2b2cd58ac7a26df5371266149e0c76776330cdf1'
$depsCmake = Join-Path $Src 'cmake\external\onnxruntime_external_deps.cmake'
$exactPatch = Join-Path $Here 'patches\onnx-v1.22.0.patch'
if (Test-Path (Join-Path $Src '.git')) {
    git -C $Src -c core.autocrlf=false checkout --force -- cmake/patches
    if ($LASTEXITCODE) { throw "git could not restore cmake/patches as the repository stores them" }
}
if (-not (Get-Command patch -ErrorAction SilentlyContinue)) {
    throw "patch is not installed; ONNX Runtime would skip its dependency patches and build ONNX without them"
}
$text = [IO.File]::ReadAllText($depsCmake)
$oldLine = '  set(ONNXRUNTIME_ONNX_PATCH_COMMAND ${Patch_EXECUTABLE} --binary --ignore-whitespace -p1 < ${PROJECT_SOURCE_DIR}/patches/onnx/onnx.patch)'
$oursLine = "  set(ONNXRUNTIME_ONNX_PATCH_COMMAND `${Patch_EXECUTABLE}` --binary --ignore-whitespace -p1 < $exactPatch)"
$onnxPatch = Join-Path $Src 'cmake\patches\onnx\onnx.patch'
if ((Get-Content -Raw (Join-Path $Src 'cmake\deps.txt')).Contains($onnxPin) -and (Test-Path $exactPatch)) {
    $onnxPatch = $exactPatch
    if (-not $text.Contains($oursLine)) {
        [IO.File]::WriteAllText($depsCmake, $text.Replace($oldLine, $oursLine))
    }
} else {
    Write-Host "  Using the ONNX patch from the clone: patches/onnx-v1.22.0.patch was generated for ONNX v1.22.0, and the pin is not that." -ForegroundColor Yellow
}

# A CMake generator name is tied to one Visual Studio major version: "Visual Studio 17 2022"
# fails with "could not find any instance of Visual Studio" on a machine or CI image that ships
# Visual Studio 2026. Ask vswhere which C++ toolchain is installed instead of guessing, and use
# Ninja when this is already a Developer PowerShell (cl.exe on PATH).
function Get-CMakeGenerator {
    if ($env:KOKON_CMAKE_GENERATOR) {
        return @{ Name = $env:KOKON_CMAKE_GENERATOR }
    }

    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $version = & $vswhere -latest -products * `
            -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
            -property installationVersion
        $version = "$version".Trim()
        if ($version) {
            $major = [int]($version.Split('.')[0])
            switch ($major) {
                18 { return @{ Name = 'Visual Studio 18 2026'; Arch = 'x64' } }
                17 { return @{ Name = 'Visual Studio 17 2022'; Arch = 'x64' } }
                default {
                    Write-Host "WARNING: Visual Studio $version has no known CMake generator name; trying Ninja" -ForegroundColor Yellow
                }
            }
        }
    }

    if (Get-Command cl.exe -ErrorAction SilentlyContinue) {
        return @{ Name = 'Ninja' }
    }

    throw "No C++ compiler found. Install Visual Studio 2022 or newer with 'Desktop development with C++', or run this from a Developer PowerShell."
}

$generator = Get-CMakeGenerator

# Same defines for every generator; only -G (and -A for Visual Studio) changes.
$defines = @(
    '-DCMAKE_BUILD_TYPE=Release',
    "-DCMAKE_INSTALL_PREFIX=$Prefix",
    "-DONNXRUNTIME_SOURCE_DIR=$Src",
    '-Donnxruntime_USE_AVX=OFF',
    '-Donnxruntime_USE_AVX2=OFF',
    '-Donnxruntime_USE_AVX512=OFF',
    '-Donnxruntime_BUILD_UNIT_TESTS=OFF',
    '-Donnxruntime_CLIENT_PACKAGE_BUILD=ON',
    '-Donnxruntime_USE_KLEIDIAI=OFF',
    '-DONNX_USE_MSVC_STATIC_RUNTIME=OFF',
    '-Dprotobuf_MSVC_STATIC_RUNTIME=OFF',
    '-Dgtest_force_shared_crt=ON',
    '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL',
    '--compile-no-warning-as-error'
)

function Invoke-OrtConfigure([hashtable]$Generator) {
    $arguments = @('-S', $Here, '-B', $Build, '-G', $Generator.Name) + $defines
    if ($Generator.Arch) { $arguments += @('-A', $Generator.Arch) }
    Write-Host "==> Configuring ONNX Runtime (portable, CPU only, $($Generator.Name))" -ForegroundColor Cyan
    & cmake @arguments | Out-Host
    return ($LASTEXITCODE -eq 0)
}

$configured = Invoke-OrtConfigure $generator

# Second chance when CMake cannot use the Visual Studio generator at all (the case that broke
# CI): import the MSVC environment from vcvarsall.bat (version-agnostic) and build with Ninja.
# A configure that ran even partially leaves a CMakeCache bound to its generator, so start over.
if (-not $configured -and -not $env:KOKON_CMAKE_GENERATOR -and $generator.Name -like 'Visual Studio*') {
    Write-Host "Visual Studio generator failed; retrying with Ninja + vcvarsall" -ForegroundColor Yellow
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vsRoot = if (Test-Path $vswhere) {
        (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
    }
    $vcvars = if ($vsRoot) { Join-Path $vsRoot 'VC\Auxiliary\Build\vcvarsall.bat' }
    if (-not $vcvars -or -not (Test-Path $vcvars)) { throw "CMake configure failed and vcvarsall.bat was not found" }
    if (-not (Get-Command ninja -ErrorAction SilentlyContinue)) { throw "CMake configure failed and Ninja is not installed" }
    cmd /c "`"$vcvars`" x64 >nul 2>&1 && set" | ForEach-Object {
        if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($matches[1])" -Value $matches[2] }
    }
    if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) { throw "vcvarsall.bat did not provide cl.exe" }
    Remove-Item -Recurse -Force $Build -ErrorAction SilentlyContinue
    $configured = Invoke-OrtConfigure @{ Name = 'Ninja' }
}
if (-not $configured) { throw "CMake configure failed" }

# CMake stops when a hunk does not apply, which is what the CI showed. The quiet case is a
# dependency that is never patched, so check the ONNX sources before building: the same tool and
# flags CMake uses (offset and fuzz are part of how these patches apply, so git apply is not
# equivalent here — it is stricter and rejects them), and the reverse dry-run only succeeds when
# every hunk is present.
$onnxSrc = Join-Path $Build '_deps\onnx-src'
if (Test-Path $onnxSrc) {
    Push-Location $onnxSrc
    try {
        Get-Content $onnxPatch | patch --ignore-whitespace -R --dry-run -p1 | Out-Null
        $patched = ($LASTEXITCODE -eq 0)
    } finally { Pop-Location }
    if (-not $patched) { throw "$onnxPatch did not apply in $onnxSrc; the build would use ONNX without those changes" }
}

Write-Host "==> Building (this takes a while)" -ForegroundColor Cyan
cmake --build $Build --config Release --parallel
if ($LASTEXITCODE) { throw "CMake build failed" }

Write-Host "==> Installing to $Prefix" -ForegroundColor Cyan
cmake --install $Build --config Release
if ($LASTEXITCODE) { throw "CMake install failed" }

$lib = Join-Path $Prefix 'lib\onnxruntime.lib'
if (-not (Test-Path $lib)) { throw "$lib was not produced" }
$mb = [math]::Round((Get-Item $lib).Length / 1MB, 1)
Write-Host "OK Portable ONNX Runtime: $lib ($mb MB)" -ForegroundColor Green
Write-Host "Set: `$env:ORT_LIB_LOCATION = '$Prefix\lib'" -ForegroundColor Green
