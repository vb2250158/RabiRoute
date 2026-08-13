Option Explicit
Dim fso, scriptDir, ps1, shell, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = scriptDir & "\watch-rabiroute-health.ps1"
Set shell = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & ps1 & """ -ManagerUrl ""http://127.0.0.1:8790"" -DefaultRouteName ""default-main"" -Once -NoTrayRepair"
shell.Run cmd, 0, False
