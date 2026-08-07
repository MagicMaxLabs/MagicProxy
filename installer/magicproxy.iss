; Inno Setup script for MagicProxy — bundles the native host + sing-box and
; registers the native-messaging host per user (no admin required).
;
; Build:  iscc installer\magicproxy.iss   (expects vendor-bin\*.exe present)
; Produces: installer\Output\MagicProxy-Setup.exe
;
; Silent install:  MagicProxy-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES

#define AppName "MagicProxy"
#define AppVersion "0.1.0"
#define HostName "com.magicproxy.host"

[Setup]
; A real GUID. The previous value contained "MAGICPROXY01", which is not valid hex
; and therefore not a GUID at all — that would have broken upgrade/uninstall matching.
; Never change this again once released: Inno matches upgrades on AppId.
AppId={{8B3F3573-6742-45CA-B2C1-0B908AC616D8}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=MagicProxy
DefaultDirName={localappdata}\{#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=Output
OutputBaseFilename=MagicProxy-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableDirPage=yes
UninstallDisplayName={#AppName}
; Upgrading over a running host: let Inno close it, but do NOT restart it. A native
; messaging host relaunched standalone has no stdin to reach EOF on, so it never
; exits and re-locks the exe for the next upgrade.
CloseApplications=yes
CloseApplicationsFilter=*.exe
RestartApplications=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"

[Files]
Source: "..\vendor-bin\magicproxy-host.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\vendor-bin\sing-box.exe";        DestDir: "{app}"; Flags: ignoreversion
Source: "com.magicproxy.host.json";          DestDir: "{app}"; Flags: ignoreversion
; GPLv3 obligations for the bundled sing-box binary: the licence text and the
; pointer to the corresponding source must travel with the binary we convey.
Source: "..\third-party\sing-box\LICENSE";     DestDir: "{app}\third-party\sing-box"; Flags: ignoreversion
Source: "..\third-party\sing-box\GPL-3.0.txt"; DestDir: "{app}\third-party\sing-box"; Flags: ignoreversion
Source: "..\third-party\sing-box\README.md";   DestDir: "{app}\third-party\sing-box"; Flags: ignoreversion
Source: "..\third-party\sing-box\VERSION";     DestDir: "{app}\third-party\sing-box"; Flags: ignoreversion
Source: "..\LICENSE";                          DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion

[Registry]
; Register the native-messaging host for every Chromium browser (HKCU, per-user).
; The default value must point at the manifest; its "path" is relative to it.
Root: HKCU; Subkey: "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\{#HostName}.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\{#HostName}";                ValueType: string; ValueName: ""; ValueData: "{app}\{#HostName}.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\{#HostName}";               ValueType: string; ValueName: ""; ValueData: "{app}\{#HostName}.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Chromium\NativeMessagingHosts\{#HostName}";                     ValueType: string; ValueName: ""; ValueData: "{app}\{#HostName}.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Vivaldi\NativeMessagingHosts\{#HostName}";                      ValueType: string; ValueName: ""; ValueData: "{app}\{#HostName}.json"; Flags: uninsdeletekey

[Tasks]
; Visible, user-checkable, and skipped in silent mode. Writing anything that
; nudges the browser MUST be something the user can see and decline — a silent
; version of this is the pattern adware uses, and reviewers read it that way.
Name: "openextension"; Description: "{cm:OpenExtensionPage}"; Flags: checkedonce

[Run]
; Hands the user from "installed" to the extension. Without this the wizard just
; ends and nothing tells them the browser half still has to be added.
; TODO: switch to https://chromewebstore.google.com/detail/gpkpglcfdlodjbabgjackonmfpemaomg
; once the Web Store listing is public; until then that URL 404s, so point at the
; install instructions, which work today.
Filename: "https://github.com/magicmaxlabs/MagicProxy#установка"; \
  Description: "{cm:OpenExtensionPage}"; \
  Flags: nowait postinstall shellexec skipifsilent; Tasks: openextension

[CustomMessages]
en.OpenExtensionPage=Open the page to add the MagicProxy extension
ru.OpenExtensionPage=Открыть страницу, чтобы добавить расширение MagicProxy
en.FinishedLabelText=Setup is done. One step remains: add the MagicProxy extension to your browser.
ru.FinishedLabelText=Установка завершена. Остался один шаг: добавить расширение MagicProxy в браузер.

[Messages]
en.FinishedLabel=Setup is done. One step remains: add the MagicProxy extension to your browser.
ru.FinishedLabel=Установка завершена. Остался один шаг: добавить расширение MagicProxy в браузер.

[UninstallDelete]
; The generated sing-box config holds the server address and credentials in clear
; text, and it lives in %TEMP%\magicproxy — NOT next to the exe, which is what the
; previous rule wrongly targeted. Remove the whole working directory.
Type: filesandordirs; Name: "{localappdata}\Temp\magicproxy"
Type: files;          Name: "{app}\sing-box.exe.bak"
Type: dirifempty;     Name: "{app}\third-party\sing-box"
Type: dirifempty;     Name: "{app}\third-party"
Type: dirifempty;     Name: "{app}"
