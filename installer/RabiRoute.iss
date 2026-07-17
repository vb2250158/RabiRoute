#define AppName "RabiRoute"
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\output\windows\payload"
#endif
#ifndef OutputDir
  #define OutputDir "..\output\windows"
#endif
#ifndef OutputBaseFilename
  #define OutputBaseFilename "RabiRoute-Setup"
#endif

[Setup]
AppId={{8AA50E6D-E598-4A16-AEE5-9117EC9D3756}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=vb2250158
AppPublisherURL=https://github.com/vb2250158/RabiRoute
AppSupportURL=https://github.com/vb2250158/RabiRoute/issues
AppUpdatesURL=https://github.com/vb2250158/RabiRoute/releases
DefaultDirName={localappdata}\Programs\RabiRoute
DefaultGroupName=RabiRoute
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
SetupIconFile=..\assets\rabiroute-icon.ico
UninstallDisplayIcon={app}\RabiRoute-Tray.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
ChangesEnvironment=no
VersionInfoVersion={#AppVersion}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "autostart"; Description: "登录 Windows 后启动 RabiRoute"; GroupDescription: "启动选项"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\RabiRoute"; Filename: "{app}\RabiRoute-Tray.exe"; WorkingDir: "{app}"
Name: "{group}\卸载 RabiRoute"; Filename: "{uninstallexe}"
Name: "{autodesktop}\RabiRoute"; Filename: "{app}\RabiRoute-Tray.exe"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{userstartup}\RabiRoute"; Filename: "{app}\RabiRoute-Tray.exe"; WorkingDir: "{app}"; Tasks: autostart

[Run]
Filename: "{app}\RabiRoute-Tray.exe"; Description: "启动 RabiRoute"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
procedure StopLocalManager;
var
  ResultCode: Integer;
  Params: String;
begin
  Params := '-NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Method Post -Uri ''http://127.0.0.1:8790/manager/shutdown'' -TimeoutSec 3 | Out-Null; Start-Sleep -Milliseconds 800 } catch {}"';
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  { Ask an existing local Manager to stop gracefully before files are replaced. }
  { /NORUNTIMESTOP is reserved for isolated packaging tests. }
  if Pos('/NORUNTIMESTOP', Uppercase(GetCmdTail)) = 0 then
    StopLocalManager;
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  { Uninstall removes program files but deliberately leaves user-owned data. }
  if (CurUninstallStep = usUninstall) and
     (Pos('/NORUNTIMESTOP', Uppercase(GetCmdTail)) = 0) then
    StopLocalManager;
end;
