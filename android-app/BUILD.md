# Android APK 构建

在 Windows PowerShell 中，从仓库根目录运行以下命令。源码与签名是分开的，同一安装的覆盖升级需要原签名。

## 环境

- JDK 17 或更高版本、Gradle 8.14.3。
- Android SDK Platform 36 和 Build-Tools 35.0.0。设置 `ANDROID_HOME`，也可以给构建脚本传入 `-Sdk`。
- Android NDK r28c、CMake 3.31.6 和 Ninja。原生构建脚本从 `cmake.exe` 同目录读取 `ninja.exe`。
- [llama.cpp v0.9.0](https://github.com/ggml-org/llama.cpp/tree/v0.9.0) 的源码目录。

先将以下路径换成本机路径，构建 ARM64 与 x86_64 的精译库。Gradle 会从 `android-app/build/precision-jni/` 收录它们。

```powershell
.\android-app\native\build.ps1 -Ndk 'D:\deps\android-ndk-r28c' -CMake 'D:\deps\cmake-3.31.6\bin\cmake.exe' -LlamaSource 'D:\deps\llama.cpp-0.9.0'
```

## 标准版与内置模型版

首次独立构建可以用 JDK 创建自己的签名库。下例会交互询问口令。为已有安装发布升级时，直接使用其原签名库。

```powershell
keytool -genkeypair -keystore .\android-app\local-build.jks -alias paperstudio -keyalg RSA -keysize 2048 -validity 10000
```

把 Gradle 的 `bin` 目录加入 PATH，也可在构建命令中传入 `-Gradle`。标准版使用下列命令，签名口令仅在这次构建的环境中传入。

```powershell
$signingPassword = Read-Host '签名库口令' -AsSecureString
$env:PAPER_STUDIO_SIGNING_PASSWORD = [Net.NetworkCredential]::new('', $signingPassword).Password
try {
    .\build_apk.ps1 -SigningKey .\android-app\local-build.jks
} finally {
    Remove-Item Env:PAPER_STUDIO_SIGNING_PASSWORD
    Remove-Variable signingPassword
}
```

构建内置 Hy-MT2 版时，在上例的构建命令里添加 `-BundledModel 'D:\models\Hy-MT2-1.8B-Q4_K_M.gguf'`。请使用 [官方 Q4_K_M GGUF](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/tree/a0c709d9fac510f2c807aa3af52872340dc37a4a)。脚本校验权重的 SHA-256，并随包写入模型许可。签名库的密钥口令不同于库口令时，还需设置 `PAPER_STUDIO_KEY_PASSWORD`。

两种安装包都生成在 `output/android/`，同时生成 `.sha256` 校验文件。文件名带 `-Offline` 的版本内置模型，支持 ARM64 和 x86_64。标准版额外支持 32 位 ARM 设备上的 Google ML Kit 与 API 翻译。

`android-app/build.gradle` 定义版本号。构建时，Gradle 合并 `static/` 的阅读器界面与 `android-app/web/` 的 Android 实现。当前 Android 构建入口是仓库根目录的 `build_apk.ps1`。
