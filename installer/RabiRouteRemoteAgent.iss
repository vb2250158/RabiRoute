#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\output\remote-agent\payload"
#endif
#ifndef OutputDir
  #define OutputDir "Output"
#endif
#ifndef OutputBaseFilename
  #define OutputBaseFilename "RabiRoute-Remote-Agent-setup"
#endif

[Setup]
AppId={{D912B9D4-AD75-4D9C-BB17-C5EEA74E30D2}
AppName=RabiRoute Remote Agent
AppVersion={#AppVersion}
AppPublisher=RabiRoute
AppPublisherURL=https://github.com/vb2250158/RabiRoute
AppSupportURL=https://github.com/vb2250158/RabiRoute/issues
DefaultDirName={localappdata}\Programs\RabiRoute Remote Agent
DefaultGroupName=RabiRoute Remote Agent
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\RabiRoute-Remote-Agent.exe
SetupLogging=yes

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\RabiRoute Remote Agent"; Filename: "{app}\RabiRoute-Remote-Agent.exe"; WorkingDir: "{app}"
Name: "{group}\重新配置 Remote Agent"; Filename: "{app}\RabiRoute-Remote-Agent.exe"; Parameters: "--configure"; WorkingDir: "{app}"
Name: "{autodesktop}\RabiRoute Remote Agent"; Filename: "{app}\RabiRoute-Remote-Agent.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "其他选项："

[Run]
Filename: "{app}\RabiRoute-Remote-Agent.exe"; Description: "启动并配置 RabiRoute Remote Agent"; Flags: nowait postinstall skipifsilent
