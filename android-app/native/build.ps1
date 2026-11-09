param(
    [Parameter(Mandatory)] [string] $Ndk,
    [Parameter(Mandatory)] [string] $CMake,
    [Parameter(Mandatory)] [string] $LlamaSource,
    [ValidateSet('arm64-v8a', 'x86_64')] [string[]] $Abi = @('arm64-v8a', 'x86_64')
)

$ErrorActionPreference = 'Stop'
$android = Split-Path -Parent $PSScriptRoot
$ninja = Join-Path (Split-Path -Parent $CMake) 'ninja.exe'
$toolchain = Join-Path $Ndk 'build\cmake\android.toolchain.cmake'
$strip = Join-Path $Ndk 'toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-strip.exe'
foreach ($file in @($CMake, $ninja, $toolchain, $strip, (Join-Path $LlamaSource 'include\llama.h'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing native build input $file" }
}
foreach ($arch in $Abi) {
    $build = Join-Path $android "build\precision-cmake\$arch"
    $configuration = @('-S', $PSScriptRoot, '-B', $build, '-G', 'Ninja', "-DCMAKE_MAKE_PROGRAM=$ninja",
        "-DCMAKE_TOOLCHAIN_FILE=$toolchain", "-DANDROID_ABI=$arch", "-DLLAMA_SOURCE=$LlamaSource",
        '-DANDROID_PLATFORM=android-24', '-DANDROID_STL=c++_static', '-DCMAKE_BUILD_TYPE=Release')
    & $CMake @configuration
    if ($LASTEXITCODE -ne 0) { throw "Native configuration failed for $arch" }
    & $CMake --build $build --target paper_precision --parallel 4
    if ($LASTEXITCODE -ne 0) { throw "Native compilation failed for $arch" }
    $output = Join-Path $android "build\precision-jni\$arch"
    New-Item -ItemType Directory -Force -Path $output | Out-Null
    & $strip --strip-unneeded -o (Join-Path $output 'libpaper_precision.so') (Join-Path $build 'libpaper_precision.so')
    if ($LASTEXITCODE -ne 0) { throw "Native symbol stripping failed for $arch" }
}
