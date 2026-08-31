#define AppName "RabiRoute"
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef PortableZip
  #define PortableZip "..\output\windows\RabiRoute-portable.zip"
#endif
#ifndef ReleaseId
  #define ReleaseId "invalid-release"
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
UninstallDisplayIcon={app}\assets\rabiroute-icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
ChangesEnvironment=no
VersionInfoVersion={#AppVersion}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "autostart"; Description: "登录 Windows 后启动 RabiRoute"; GroupDescription: "启动选项"; Flags: unchecked

[Files]
Source: "{#PortableZip}"; DestName: "RabiRoute-portable.zip"; Flags: dontcopy
Source: "..\scripts\Install-RabiRouteReleaseTransaction.ps1"; Flags: dontcopy
Source: "..\scripts\Uninstall-RabiRouteReleaseTransaction.ps1"; Flags: dontcopy
Source: "..\scripts\Stop-RabiRouteHostFenced.ps1"; Flags: dontcopy
Source: "..\scripts\Stop-LegacyRabiRouteRuntime.ps1"; Flags: dontcopy
Source: "..\scripts\Migrate-LegacyWearableHealthTask.ps1"; Flags: dontcopy
Source: "..\scripts\Configure-WindowsAutostart.ps1"; Flags: dontcopy

[Icons]
Name: "{group}\RabiRoute"; Filename: "{app}\RabiRouteHost.exe"; WorkingDir: "{app}"
Name: "{group}\卸载 RabiRoute"; Filename: "{uninstallexe}"
Name: "{autodesktop}\RabiRoute"; Filename: "{app}\RabiRouteHost.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\RabiRouteHost.exe"; Description: "启动 RabiRoute"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
function PsQuote(Value: String): String;
begin
  Result := '"' + Value + '"';
end;

function RunPowerShell(ScriptName, Arguments: String; var ResultCode: Integer): Boolean;
begin
  ResultCode := -1;
  Result := Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' +
      PsQuote(ExpandConstant('{tmp}\' + ScriptName)) + ' ' + Arguments,
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if not Result then Log(Format('%s failed closed (ResultCode=%d).', [ScriptName, ResultCode]));
end;

procedure ExtractTransactionFiles;
begin
  ExtractTemporaryFile('RabiRoute-portable.zip');
  ExtractTemporaryFile('Install-RabiRouteReleaseTransaction.ps1');
  ExtractTemporaryFile('Uninstall-RabiRouteReleaseTransaction.ps1');
  ExtractTemporaryFile('Stop-RabiRouteHostFenced.ps1');
  ExtractTemporaryFile('Stop-LegacyRabiRouteRuntime.ps1');
  ExtractTemporaryFile('Migrate-LegacyWearableHealthTask.ps1');
  ExtractTemporaryFile('Configure-WindowsAutostart.ps1');
end;

function InstallTransaction: Boolean;
var
  AutostartValue, Arguments: String;
  ResultCode: Integer;
begin
  ExtractTransactionFiles;
  if WizardIsTaskSelected('autostart') then AutostartValue := 'true' else AutostartValue := 'false';
  Arguments := '-InstallRoot ' + PsQuote(ExpandConstant('{app}')) +
    ' -PortableZip ' + PsQuote(ExpandConstant('{tmp}\RabiRoute-portable.zip')) +
    ' -ExpectedReleaseId ' + PsQuote('{#ReleaseId}') +
    ' -StopHostScript ' + PsQuote(ExpandConstant('{tmp}\Stop-RabiRouteHostFenced.ps1')) +
    ' -LegacyMigrationScript ' + PsQuote(ExpandConstant('{tmp}\Stop-LegacyRabiRouteRuntime.ps1')) +
    ' -LegacyTaskMigrationScript ' + PsQuote(ExpandConstant('{tmp}\Migrate-LegacyWearableHealthTask.ps1')) +
    ' -AutostartScript ' + PsQuote(ExpandConstant('{tmp}\Configure-WindowsAutostart.ps1')) +
    ' -AutostartEnabled ' + AutostartValue;
  Result := RunPowerShell('Install-RabiRouteReleaseTransaction.ps1', Arguments, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  if not InstallTransaction then
    Result := 'RabiRoute 候选版本未通过完整性、自检、fenced quit 或原子切换门禁。安装已 fail-closed；原版本指针与 bootstrap 已恢复，请查看安装日志。'
  else Result := '';
end;

function RunUninstallTransaction(PreflightOnly: Boolean): Boolean;
var
  Arguments: String;
  ResultCode: Integer;
begin
  ExtractTransactionFiles;
  Arguments := '-InstallRoot ' + PsQuote(ExpandConstant('{app}')) +
    ' -StopHostScript ' + PsQuote(ExpandConstant('{tmp}\Stop-RabiRouteHostFenced.ps1')) +
    ' -LegacyTaskMigrationScript ' + PsQuote(ExpandConstant('{tmp}\Migrate-LegacyWearableHealthTask.ps1'));
  if PreflightOnly then Arguments := Arguments + ' -PreflightOnly';
  Result := RunPowerShell('Uninstall-RabiRouteReleaseTransaction.ps1', Arguments, ResultCode);
end;

function InitializeUninstall(): Boolean;
begin
  Result := RunUninstallTransaction(True);
  if not Result then
    SuppressibleMsgBox('RabiRoute 无法安全验证版本清单或 fenced stop。卸载已中止，现有程序、data、logs 与 foreign 文件均保持原样。', mbError, MB_OK, IDOK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usUninstall) and not RunUninstallTransaction(False) then
    RaiseException('RabiRoute 仅清单所有权卸载失败；未执行广泛目录删除。');
end;
