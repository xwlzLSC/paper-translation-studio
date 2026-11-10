param(
    [string]$Compiler
)

$ErrorActionPreference = 'Stop'
$setup = Join-Path $PSScriptRoot 'setup.iss'
$version = [regex]::Match([IO.File]::ReadAllText($setup), '(?m)^#define AppVersion "([0-9]+\.[0-9]+\.[0-9]+)"\r?$').Groups[1].Value
if (-not $version) { throw '无法从 setup.iss 读取版本号。' }
$studio = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$cache = Join-Path $studio 'test-data\windows-packaging-cache'
$desktop = Join-Path $cache 'desktop-host'
$python = Join-Path $studio '..\pdf2zh\build\runtime\python.exe'
$sdk = Join-Path $cache 'microsoft.web.webview2.1.0.4314.35.nupkg'
$webview = Join-Path $cache 'WebView2Runtime-x64.exe'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not $Compiler) { $Compiler = Join-Path $cache 'InnoSetup7\ISCC.exe' }
foreach ($file in @($Compiler, $python, $sdk, $webview, $csc)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "缺少构建工具或组件：$file。请参阅 BUILD.md。"
    }
}
if ((Get-FileHash -LiteralPath $sdk -Algorithm SHA256).Hash -ne '90778DEB1B77E36292828B4B5833C9255C27533F40E0DDD55891AE718944EDC4') {
    throw 'WebView2 SDK 校验失败。'
}
$signature = Get-AuthenticodeSignature -LiteralPath $webview
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike 'CN=Microsoft Corporation*') {
    throw 'WebView2 运行库的签名无效。'
}
New-Item -ItemType Directory -Path $desktop -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($sdk)
try {
    $files = @{
        'lib/net462/Microsoft.Web.WebView2.Core.dll' = 'Microsoft.Web.WebView2.Core.dll'
        'lib/net462/Microsoft.Web.WebView2.WinForms.dll' = 'Microsoft.Web.WebView2.WinForms.dll'
        'runtimes/win-x64/native/WebView2Loader.dll' = 'WebView2Loader.dll'
        'LICENSE.txt' = 'WebView2-LICENSE.txt'
    }
    foreach ($name in $files.Keys) {
        $entry = $archive.GetEntry($name)
        if (-not $entry) { throw "WebView2 SDK 缺少 $name。" }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $desktop $files[$name]), $true)
    }
} finally {
    $archive.Dispose()
}
$arguments = @(
    '/nologo', '/utf8output', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001',
    ('/out:' + (Join-Path $desktop '论文译读.exe')),
    ('/win32icon:' + (Join-Path $PSScriptRoot 'paperstudio.ico')),
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    ('/reference:' + (Join-Path $desktop 'Microsoft.Web.WebView2.Core.dll')),
    ('/reference:' + (Join-Path $desktop 'Microsoft.Web.WebView2.WinForms.dll')),
    (Join-Path $PSScriptRoot 'PaperStudio.cs')
)
& $csc $arguments
if ($LASTEXITCODE -ne 0) { throw '桌面窗口编译失败。' }
& $python -X utf8 -B (Join-Path $PSScriptRoot 'make_source.py') $version
if ($LASTEXITCODE -ne 0) { throw '源码包生成失败。' }
& $Compiler /Q $setup
if ($LASTEXITCODE -ne 0) { throw '安装包编译失败。' }

$output = Join-Path $studio 'output\windows'
foreach ($name in @("PaperTranslationStudio-Setup-$version-x64.exe", "PaperTranslationStudio-Source-$version.zip")) {
    $file = Join-Path $output $name
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $name" | Set-Content -LiteralPath ($file + '.sha256') -Encoding ascii
    Get-Item -LiteralPath $file | Select-Object FullName, Length
}
