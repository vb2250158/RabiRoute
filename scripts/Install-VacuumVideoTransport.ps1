param([Parameter(Mandatory=$true)][string]$RuntimeDir)
$ErrorActionPreference = 'Stop'
# The caller supplies the Xiaomi Home provider runtime directory, never a Manager port or cloud credentials.
$destination = Join-Path ([IO.Path]::GetFullPath($RuntimeDir)) 'vacuum-video'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$zip = Join-Path $destination 'go2rtc_win64.zip'
Invoke-WebRequest 'https://github.com/AlexxIT/go2rtc/releases/download/v1.9.14/go2rtc_win64.zip' -OutFile $zip
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'dd4167d75cb04abe618855b7c71f8658bd009f60c1a71835d134d2c11c939907') { throw 'Video transport archive digest mismatch.' }
Expand-Archive -LiteralPath $zip -DestinationPath $destination -Force
$executable = Join-Path $destination 'go2rtc.exe'
if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne '923d57252e8139a69c52e4acc1e399a640244a8ef457fd9b7267a25847d68f8c') { throw 'Video transport executable digest mismatch.' }
Invoke-WebRequest 'https://raw.githubusercontent.com/AlexxIT/go2rtc/v1.9.14/LICENSE' -OutFile (Join-Path $destination 'LICENSE-go2rtc.txt')
Remove-Item -LiteralPath $zip
@{version='1.9.14';source='https://github.com/AlexxIT/go2rtc/releases/tag/v1.9.14';sha256='923d57252e8139a69c52e4acc1e399a640244a8ef457fd9b7267a25847d68f8c';installedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'transport.json') -Encoding UTF8
Write-Output 'Pinned video transport installed. No process started.'
