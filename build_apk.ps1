param(
    [string] $Gradle,
    [string] $GradleCache,
    [string] $Sdk,
    [string] $SigningKey = (Join-Path $PSScriptRoot 'android-app\release-key.jks'),
    [string] $SigningAlias = 'paperstudio',
    [string] $BundledModel
)

$ErrorActionPreference = 'Stop'
if (-not $Sdk) {
    $Sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
}
$Sdk = (Resolve-Path -LiteralPath $Sdk).Path
$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk
if (-not $Gradle) {
    $command = Get-Command gradle.bat -ErrorAction SilentlyContinue
    if ($command) { $Gradle = $command.Source }
    else {
        $wrapper = Join-Path $env:USERPROFILE '.gradle\wrapper\dists\gradle-8.14.3-all'
        if (Test-Path -LiteralPath $wrapper) {
            $Gradle = (Get-ChildItem -LiteralPath $wrapper -Filter gradle.bat -Recurse | Select-Object -First 1).FullName
        }
    }
}
if (-not $Gradle) { throw 'Gradle 8.14.3 is required. Pass -Gradle with the full path to gradle.bat.' }
if (-not (Test-Path -LiteralPath $SigningKey -PathType Leaf)) { throw 'Pass the existing Android signing key with -SigningKey.' }
if (-not $env:PAPER_STUDIO_SIGNING_PASSWORD) { throw 'Set PAPER_STUDIO_SIGNING_PASSWORD for the signing key.' }
$tools = Join-Path $Sdk 'build-tools\35.0.0'
$signer = Join-Path $tools 'lib\apksigner.jar'
if (-not (Test-Path -LiteralPath $signer -PathType Leaf)) { throw 'Android SDK Build-Tools 35.0.0 is required.' }

$android = Join-Path $PSScriptRoot 'android-app'
foreach ($abi in @('arm64-v8a', 'x86_64')) {
    $library = Join-Path $android "build\precision-jni\$abi\libpaper_precision.so"
    if (-not (Test-Path -LiteralPath $library -PathType Leaf)) {
        throw 'Run android-app/native/build.ps1 before assembling the APK.'
    }
}
$gradleArgs = @('--no-daemon', '-p', $android, ':assembleRelease', '--console=plain')
if ($GradleCache) { $gradleArgs = @('-g', $GradleCache) + $gradleArgs }
if ($BundledModel) {
    $BundledModel = (Resolve-Path -LiteralPath $BundledModel).Path
    $expected = 'dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699'
    if ((Get-FileHash -LiteralPath $BundledModel -Algorithm SHA256).Hash -ne $expected) {
        throw 'The bundled model must be the verified official Hy-MT2-1.8B-Q4_K_M GGUF.'
    }
    $license = (Resolve-Path -LiteralPath (Join-Path $android 'Hy-MT2-LICENSE.txt')).Path
    $gradleArgs += @("-PpaperBundledModel=$BundledModel", "-PpaperBundledModelLicense=$license")
}
& $Gradle @gradleArgs
if ($LASTEXITCODE -ne 0) { throw "Gradle failed with exit code $LASTEXITCODE." }

$apkFolder = Join-Path $android 'build\outputs\apk\release'
$metadata = Get-Content -LiteralPath (Join-Path $apkFolder 'output-metadata.json') -Raw | ConvertFrom-Json
$build = $metadata.elements | Select-Object -First 1
$unsigned = Join-Path $apkFolder $build.outputFile
$staged = Join-Path $apkFolder 'release-signed.apk'
$zipalign = Join-Path $tools 'zipalign.exe'
$alignment = 4
if ($BundledModel) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($unsigned)
    try {
        $entry = $archive.GetEntry('assets/models/Hy-MT2-1.8B-Q4_K_M.gguf')
        if (-not $entry -or $entry.Length -ne 1133080448 -or $entry.CompressedLength -ne $entry.Length) {
            throw 'The GGUF must be packaged as an uncompressed APK entry.'
        }
        if (-not $archive.GetEntry('assets/models/Hy-MT2-LICENSE.txt')) { throw 'Bundled model license is missing.' }
    } finally { $archive.Dispose() }
    $alignment = 64
    $aligned = Join-Path $apkFolder 'release-model-aligned.apk'
    & $zipalign -f -P 16 $alignment $unsigned $aligned
    if ($LASTEXITCODE -ne 0) { throw 'APK model alignment failed.' }
    $unsigned = $aligned
}
$keyPass = if ($env:PAPER_STUDIO_KEY_PASSWORD) { 'env:PAPER_STUDIO_KEY_PASSWORD' } else { 'env:PAPER_STUDIO_SIGNING_PASSWORD' }
$preserveAlignment = if ($BundledModel) { 'true' } else { 'false' }
& java.exe -jar $signer sign --ks $SigningKey --ks-key-alias $SigningAlias --ks-pass env:PAPER_STUDIO_SIGNING_PASSWORD --key-pass $keyPass --alignment-preserved $preserveAlignment --v4-signing-enabled false --out $staged $unsigned
if ($LASTEXITCODE -ne 0) { throw 'APK signing failed.' }
& java.exe -jar $signer verify --verbose --print-certs $staged
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
& $zipalign -c -P 16 $alignment $staged
if ($LASTEXITCODE -ne 0) { throw 'APK ZIP alignment verification failed.' }

$output = Join-Path $PSScriptRoot 'output\android'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$suffix = if ($BundledModel) { '-Offline' } else { '' }
$name = "PaperTranslationStudio-$($build.versionName)$suffix.apk"
$apk = Join-Path $output $name
Move-Item -LiteralPath $staged -Destination $apk -Force
$hash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $name" | Set-Content -LiteralPath ($apk + '.sha256') -Encoding ascii
Get-Item -LiteralPath $apk | Select-Object FullName, Length, LastWriteTime
