# Windows 安装包构建

在 Windows x64 上，从仓库根目录执行。先按 [README](../../README.md#从源码启动-windows-工作台) 准备相邻的 PDF2zh v1.9.11 带资产便携版，并运行 `.\start.bat --install-offline` 安装本机英译中语言包。安装器读取 `..\pdf2zh\build` 里的运行时和资源。

## 准备构建依赖

使用 Inno Setup 7 和 Windows 的 .NET Framework 64 位 C# 编译器。将以下下载文件放进仓库下的 `test-data/windows-packaging-cache/`。

| 本地文件名 | 下载来源 |
| --- | --- |
| `microsoft.web.webview2.1.0.4314.35.nupkg` | [WebView2 SDK 1.0.4314.35](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4314.35) |
| `WebView2Runtime-x64.exe` | [微软 WebView2 下载页](https://developer.microsoft.com/microsoft-edge/webview2/#download-section)的 x64 Evergreen Standalone Installer，下载后改为左侧文件名 |
| `pdf2zh-1.9.11.tar.gz` | [PDF2zh 1.9.11 源码分发包](https://pypi.org/project/pdf2zh/1.9.11/#files) |
| `pymupdf-1.25.2.tar.gz` | [PyMuPDF 1.25.2 源码分发包](https://pypi.org/project/PyMuPDF/1.25.2/#files) |
| `babeldoc-0.2.33.tar.gz` | [BabelDOC 0.2.33 源码分发包](https://pypi.org/project/babeldoc/0.2.33/#files) |
| `levenshtein-0.27.1.tar.gz`、`python_levenshtein-0.27.1.tar.gz` | [Levenshtein](https://pypi.org/project/Levenshtein/0.27.1/#files) · [python-Levenshtein](https://pypi.org/project/python-Levenshtein/0.27.1/#files) |
| `mupdf-1.25.2-source.tar.gz` | [MuPDF 官方下载归档](https://mupdf.com/releases/) |

构建脚本验证 WebView2 SDK 和上游源码包的 SHA-256，以及微软 WebView2 运行库安装程序的数字签名。源码包的文件名与校验值见 [make_source.py](make_source.py)。

## 生成安装包

```powershell
.\packaging\windows\build.ps1 -Compiler 'C:\Program Files\Inno Setup 7\ISCC.exe'
```

`output/windows/` 将生成 `PaperTranslationStudio-Setup-1.0.1-x64.exe` 和 `PaperTranslationStudio-Source-1.0.1.zip`。安装器包含工作台、PDF2zh 便携引擎、离线语言包、运行库及组件许可。安装后，文献与设置位于 `%LOCALAPPDATA%\PaperTranslationStudio\data`。

安装器版本由 `setup.iss` 的 `AppVersion` 定义。构建时为 EXE 和源码归档同时生成 SHA-256 校验文件。
