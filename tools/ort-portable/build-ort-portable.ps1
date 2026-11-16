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

# ONNX Runtime's .gitattributes sets `* text=auto`, so a Windows checkout writes the .patch files
# as CRLF while the dependency sources come from zip archives with LF. Both `patch --binary` and
# `git apply` compare line endings and refuse a CRLF patch (tested here on the ONNX v1.22.0 sources
# that cmake/deps.txt pins). Write the patch files back as the repository stores them; source
# files are fine with CRLF. Unconditional: an existing clone needs it, and Windows PowerShell 5.1
# has no $IsWindows, so the same check there would not run.
Get-ChildItem -Recurse -Path (Join-Path $Src 'cmake\patches') -Filter '*.patch' -ErrorAction SilentlyContinue |
    ForEach-Object {
        $text = [IO.File]::ReadAllText($_.FullName)
        if ($text.Contains("`r`n")) {
            [IO.File]::WriteAllText($_.FullName, $text.Replace("`r`n", "`n"))
        }
    }

# `patch --binary` compares bytes, so a hunk that needs whitespace tolerance fails on some patch
# builds: the runner's patch (Strawberry perl) rejected two hunks of cmake/patches/onnx/onnx.patch
# while GNU patch 2.7.6 applies the same file cleanly, so no line-ending rule controls it.
# `git apply` compares lines and behaves the same everywhere, so use it for the ONNX patch.
# The patch command can only be changed here, in the clone; the pattern is for ONNX Runtime
# $OrtVersion, and we say when it does not match instead of silently keeping the old tool.
$depsCmake = Join-Path $Src 'cmake\external\onnxruntime_external_deps.cmake'
if (Get-Command git -ErrorAction SilentlyContinue) {
    $text = [IO.File]::ReadAllText($depsCmake)
    $old = 'set(ONNXRUNTIME_ONNX_PATCH_COMMAND ${Patch_EXECUTABLE} --binary --ignore-whitespace -p1 < ${PROJECT_SOURCE_DIR}/patches/onnx/onnx.patch)'
    $new = 'set(ONNXRUNTIME_ONNX_PATCH_COMMAND git apply -p1 --ignore-whitespace ${PROJECT_SOURCE_DIR}/patches/onnx/onnx.patch)'
    if ($text.Contains($new)) {
        # already rewritten by a previous run of this script
    } elseif ($text.Contains($old)) {
        [IO.File]::WriteAllText($depsCmake, $text.Replace($old, $new))
    } else {
        Write-Host "  This pattern is for ONNX Runtime $OrtVersion; it did not match, so the ONNX patch still runs with the patch tool CMake finds." -ForegroundColor Yellow
    }
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

# ONNX Runtime leaves PATCH_COMMAND empty when it does not find `patch`, so a build can continue
# with ONNX half-patched or not patched at all, and that changes ONNX itself: the parts of
# cmake/patches/onnx/onnx.patch are ONNX_MINIMAL_BUILD, assertions.h, tensor.h and
# scoped_resource.h. Stop here instead of building those sources: git apply -R --check only
# succeeds when every hunk of the patch is present in the sources CMake downloaded.
$onnxSrc = Join-Path $Build '_deps\onnx-src'
$onnxPatch = Join-Path $Src 'cmake\patches\onnx\onnx.patch'
if (Test-Path $onnxSrc) {
    Push-Location $onnxSrc
    try {
        git apply -R --check -p1 --ignore-whitespace $onnxPatch
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
