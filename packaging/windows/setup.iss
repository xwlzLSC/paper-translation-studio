#define ProjectDir AddBackslash(SourcePath) + "..\.."
#define CacheDir ProjectDir + "\test-data\windows-packaging-cache"
#define AppVersion "1.0.1"
#define DesktopDir CacheDir + "\desktop-host"

[Setup]
AppId={{A867AE6A-A329-4565-AE64-5151FC552E76}
AppName=论文译读
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersion}
AppPublisher=论文译读
AppMutex=Local\PaperTranslationStudio
DefaultDirName={localappdata}\Programs\PaperTranslationStudio
DefaultGroupName=论文译读
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=..\..\output\windows
OutputBaseFilename=PaperTranslationStudio-Setup-{#AppVersion}-x64
SetupIconFile=paperstudio.ico
UninstallDisplayIcon={app}\论文译读.exe
WizardStyle=modern
Compression=lzma2/fast
SolidCompression=yes
LZMANumBlockThreads=2

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加选项"

[Files]
Source: "{#DesktopDir}\论文译读.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#DesktopDir}\Microsoft.Web.WebView2.Core.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#DesktopDir}\Microsoft.Web.WebView2.WinForms.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#DesktopDir}\WebView2Loader.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#DesktopDir}\WebView2-LICENSE.txt"; DestDir: "{app}\licenses"; Flags: ignoreversion
Source: "{#ProjectDir}\packaging\windows\THIRD-PARTY.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectDir}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectDir}\*.py"; DestDir: "{app}\paper-translation-studio"; Flags: ignoreversion
Source: "{#ProjectDir}\static\*"; DestDir: "{app}\paper-translation-studio\static"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#ProjectDir}\.offline-translation-v1\*"; DestDir: "{app}\paper-translation-studio\.offline-translation-v1"; Excludes: "__pycache__,*.pyc,*.pyo"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#ProjectDir}\..\pdf2zh\build\runtime\*"; DestDir: "{app}\pdf2zh\build\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#ProjectDir}\..\pdf2zh\build\site-packages\*"; DestDir: "{app}\pdf2zh\build\site-packages"; Excludes: "__pycache__,*.pyc,*.pyo,*.log"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#ProjectDir}\..\pdf2zh\build\offline_assets_*.zip"; DestDir: "{app}\pdf2zh\build"; Flags: ignoreversion
Source: "{#ProjectDir}\output\windows\PaperTranslationStudio-Source-{#AppVersion}.zip"; DestDir: "{app}\source"; Flags: ignoreversion
Source: "{#CacheDir}\WebView2Runtime-x64.exe"; DestDir: "{tmp}"; Check: NeedsWebView; Flags: deleteafterinstall
Source: "{#ProjectDir}\..\pdf2zh\build\无法运行请安装vc_redist.x64.exe"; DestDir: "{tmp}"; DestName: "vc_redist.x64.exe"; Check: NeedsVCRuntime; Flags: deleteafterinstall

[Icons]
Name: "{group}\论文译读"; Filename: "{app}\论文译读.exe"; WorkingDir: "{app}"
Name: "{group}\使用说明"; Filename: "{app}\README.md"
Name: "{group}\第三方组件说明"; Filename: "{app}\THIRD-PARTY.txt"
Name: "{group}\卸载论文译读"; Filename: "{uninstallexe}"
Name: "{autodesktop}\论文译读"; Filename: "{app}\论文译读.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\论文译读.exe"; Description: "启动论文译读"; Flags: nowait postinstall skipifsilent

[Code]
function NeedsWebView: Boolean;
var
  Version: String;
  Key: String;
begin
  Key := 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  Result := not ((RegQueryStringValue(HKLM32, Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0')));
end;

function NeedsVCRuntime: Boolean;
var
  Installed, Build: Cardinal;
  Key: String;
begin
  Key := 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64';
  Result := not (RegQueryDWordValue(HKLM64, Key, 'Installed', Installed) and (Installed = 1) and
    RegQueryDWordValue(HKLM64, Key, 'Bld', Build) and (Build >= 35211));
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ExitCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    if NeedsVCRuntime then
    begin
      if not ShellExec('runas', ExpandConstant('{tmp}\vc_redist.x64.exe'),
        '/install /quiet /norestart', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
        RaiseException('无法安装 Microsoft Visual C++ 运行库。请重新运行安装程序并允许系统请求。');
      if (ExitCode <> 0) and (ExitCode <> 3010) and NeedsVCRuntime then
        RaiseException('Microsoft Visual C++ 运行库安装失败，错误代码：' + IntToStr(ExitCode));
    end;
    if NeedsWebView then
    begin
      if not Exec(ExpandConstant('{tmp}\WebView2Runtime-x64.exe'),
        '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
        RaiseException('无法启动 Microsoft Edge WebView2 运行库安装程序。');
      if (ExitCode <> 0) and (ExitCode <> 3010) and NeedsWebView then
        RaiseException('Microsoft Edge WebView2 运行库安装失败，错误代码：' + IntToStr(ExitCode));
    end;
  end;
end;
