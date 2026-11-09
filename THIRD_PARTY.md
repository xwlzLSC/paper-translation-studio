# 第三方项目与许可

此页记录论文译读依赖的上游项目、分发时附带的资源与界面设计参考。组件及资源分别沿用各自的许可。项目自有代码的开源许可由维护者单独确定。

## Windows

| 上游项目 | 在论文译读中的用途 | 许可与来源 |
| --- | --- | --- |
| PDFMathTranslate / PDF2zh v1.9.11 | Windows PDF 文字层提取、公式保留及译文排版。从独立的便携版运行。 | AGPL-3.0。[上游版本](https://github.com/PDFMathTranslate/PDFMathTranslate/tree/v1.9.11) |
| PyMuPDF / MuPDF 1.25.2 | 读取、渲染和生成 PDF。 | AGPL-3.0 或商业许可。[PyMuPDF](https://github.com/pymupdf/PyMuPDF) · [MuPDF](https://mupdf.com/) |
| BabelDOC 0.2.33 | PDF2zh 便携发行包内的依赖，也是双语论文排版的参考。 | AGPL-3.0。[BabelDOC](https://github.com/funstory-ai/BabelDOC) |
| RapidOCR | Windows 扫描页的本机 OCR，通过 `rapidocr_onnxruntime` 调用。 | Apache-2.0。[RapidOCR](https://github.com/RapidAI/RapidOCR) |
| Argos Translate / OPUS-MT | 使用英译中 `translate-en_zh-1_9` 语言包，由 CTranslate2 和 SentencePiece 在本机运行。 | 原始 OPUS-MT 模型为 CC BY 4.0。作者 Jörg Tiedemann、Santhosh Thottingal。[Argos Translate](https://github.com/argosopentech/argos-translate) · [OPUS-MT 论文](https://aclanthology.org/2020.eamt-1.61/) · [CTranslate2](https://github.com/OpenNMT/CTranslate2) · [SentencePiece](https://github.com/google/sentencepiece) |
| Levenshtein / python-Levenshtein 0.27.1 | Windows 便携运行环境随包依赖。 | GPL-2.0 或更新版本。[Levenshtein](https://github.com/rapidfuzz/Levenshtein) |
| Magpie | 选配的本机网关，由用户独立运行，工作台通过兼容 API 连接。 | [Magpie 项目](https://github.com/yetone/magpie) |

Windows 安装器的源码归档由 `packaging/windows/make_source.py` 生成，包含安装器源码、工作台源码和上面列出的 GPL / AGPL 组件源码归档。其余随便携运行时分发的 Python 组件许可见各自的 `.dist-info`。微软 WebView2 SDK 与运行库适用各自的许可，安装器附带 SDK 许可文本。 [Windows 分发说明](packaging/windows/THIRD-PARTY.txt)

## Android

| 上游项目或资源 | 在论文译读中的用途 | 许可与来源 |
| --- | --- | --- |
| PdfBox-Android 2.0.27.0 | Android PDF 导入、坐标提取及导出。 | Apache-2.0。[上游项目](https://github.com/TomRoush/PdfBox-Android) · [LICENSE](android-app/packaged/licenses/PdfBox-Android-LICENSE.txt) · [NOTICE](android-app/packaged/licenses/PdfBox-Android-NOTICE.txt) |
| llama.cpp v0.9.0 | 在 64 位 Android 上加载 GGUF 并推理。 | MIT。[上游版本](https://github.com/ggml-org/llama.cpp/tree/v0.9.0) · [LICENSE](android-app/packaged/licenses/llama.cpp-LICENSE.txt) |
| 腾讯 Hy-MT2-1.8B-GGUF | 本机精译使用官方 Q4_K_M 权重。权重可另行下载，内置版安装包同时包含模型许可。 | Apache-2.0。[模型主页](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF) · [模型许可](android-app/Hy-MT2-LICENSE.txt) |
| 思源宋体 Source Han Serif | APK 自带的中文字形，用于保留可阅读的译文排版。 | SIL OFL 1.1，保留字体名为 Source。[上游项目](https://github.com/adobe-fonts/source-han-serif) · [OFL](android-app/packaged/licenses/Source-Han-Serif-OFL.txt) |
| Bouncy Castle | PdfBox-Android 的随包依赖。 | [许可文本](android-app/packaged/licenses/Bouncy-Castle-LICENSE.txt) |
| Google ML Kit 与 Google Translate 标识 | OCR 和本机英译中使用 ML Kit SDK。译文区展示官方署名图。 | [ML Kit 翻译使用指南](https://developers.google.com/ml-kit/language/translation/translation-terms) · [Google 署名规范与素材](https://docs.cloud.google.com/translate/attribution) |

## 阅读器设计参考

- Doc2X 的文档导入和 PDF 加结构化内容对照。[Doc2X](https://doc2x.noedgeai.com/parse)
- 沉浸式翻译的 BabelDOC 页面所展示的原译文对照阅读。[沉浸式翻译 BabelDOC](https://app.immersivetranslate.com/babel-doc/)
