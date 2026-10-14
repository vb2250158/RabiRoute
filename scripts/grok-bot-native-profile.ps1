param(
  [string]$ProfilePath = (Join-Path $env:APPDATA 'Grok Bot'),
  [switch]$CredentialForClient
)

# Read-only credential bridge. The private mode is captured by Node's execFile
# pipe; callers must never forward its output to a console, log, or file.
$ErrorActionPreference = 'Stop'
$taskErrorCode = 'GROK_BOT_PROFILE_UNREADABLE'
try {
  if ($env:OS -ne 'Windows_NT') { throw 'GROK_BOT_PLATFORM_UNSUPPORTED' }
  $taskErrorCode = 'GROK_BOT_PROFILE_MISSING'
  $taskStatus = Get-Content -LiteralPath (Join-Path $ProfilePath 'desktop-status.json') -Raw | ConvertFrom-Json
  if ($taskStatus.signedIn -ne $true) { throw 'GROK_BOT_NOT_SIGNED_IN' }
  $taskErrorCode = 'GROK_BOT_PROFILE_INVALID'
  $taskSecrets = Get-Content -LiteralPath (Join-Path $ProfilePath 'sand-secrets.json') -Raw | ConvertFrom-Json
  if ($taskSecrets.version -ne 1) { throw 'GROK_BOT_PROFILE_VERSION_UNSUPPORTED' }
  $taskAccounts = $taskSecrets.'cursor-accounts' | ConvertFrom-Json
  $taskScope = [string]$taskAccounts.active
  if ($taskScope -notmatch '^[0-9a-f]{64}$') { throw 'GROK_BOT_ACCOUNT_NOT_SELECTED' }
  $taskSlot = $taskAccounts.accounts.PSObject.Properties[$taskScope].Value
  if ($null -eq $taskSlot -or [string]::IsNullOrWhiteSpace($taskSlot.'cursor-access-token')) { throw 'GROK_BOT_TOKEN_MISSING' }
  $taskResult = [ordered]@{ version = 1; signedIn = $true; accountScope = $taskScope; appVersion = [string]$taskStatus.appVersion }
  if ($CredentialForClient) {
    Add-Type -AssemblyName System.Security
    $taskKey = $null
    $taskKeyLoaded = $false
    function Read-GrokProtectedValue([string]$Value) {
      if ([string]::IsNullOrEmpty($Value)) { return $null }
      if ($Value.StartsWith('scoped:v1:')) {
        $taskParts = $Value.Split(':', 4)
        if ($taskParts.Length -ne 4 -or $taskParts[2] -ne $taskScope) { throw 'GROK_BOT_ACCOUNT_MISMATCH' }
        $Value = $taskParts[3]
      }
      if ($Value.StartsWith('plaintext:v1:')) { throw 'GROK_BOT_UNPROTECTED_CREDENTIAL' }
      $taskBytes = [Convert]::FromBase64String($Value)
      if ($taskBytes.Length -ge 3 -and [Text.Encoding]::ASCII.GetString($taskBytes, 0, 3) -eq 'v10') {
        if (-not $script:taskKeyLoaded) {
          $taskLocalState = Get-Content -LiteralPath (Join-Path $ProfilePath 'Local State') -Raw | ConvertFrom-Json
          $taskWrappedKey = [Convert]::FromBase64String($taskLocalState.os_crypt.encrypted_key)
          if ($taskWrappedKey.Length -lt 6 -or [Text.Encoding]::ASCII.GetString($taskWrappedKey, 0, 5) -ne 'DPAPI') { throw 'GROK_BOT_KEY_FORMAT_UNSUPPORTED' }
          $script:taskKey = [Security.Cryptography.ProtectedData]::Unprotect($taskWrappedKey[5..($taskWrappedKey.Length - 1)], $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
          if ($script:taskKey.Length -ne 32) { throw 'GROK_BOT_KEY_FORMAT_UNSUPPORTED' }
          $script:taskKeyLoaded = $true
        }
        return @{ format = 'aes-gcm'; data = $Value }
      }
      $taskPlain = [Security.Cryptography.ProtectedData]::Unprotect($taskBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      return @{ format = 'dpapi'; data = [Convert]::ToBase64String($taskPlain) }
    }
    $taskErrorCode = 'GROK_BOT_CREDENTIAL_UNREADABLE'
    $taskResult.accessToken = Read-GrokProtectedValue $taskSlot.'cursor-access-token'
    $taskResult.selectedTeamId = Read-GrokProtectedValue $taskSlot.'cursor-selected-team-id'
    $taskResult.machineId = Read-GrokProtectedValue $taskSecrets.'cursor-machine-id'
    if ($script:taskKeyLoaded) { $taskResult.encryptionKey = [Convert]::ToBase64String($script:taskKey) }
  }
  [Console]::Out.WriteLine(($taskResult | ConvertTo-Json -Depth 6 -Compress))
} catch {
  $taskKnownCode = [string]$_.Exception.Message
  if ($taskKnownCode -match '^GROK_BOT_[A-Z_]+$') { $taskErrorCode = $taskKnownCode }
  # Exception text can include protected input; emit only a closed diagnostic code.
  [Console]::Out.WriteLine((@{ version = 1; signedIn = $false; errorCode = $taskErrorCode } | ConvertTo-Json -Compress))
  exit 1
} finally {
  if ($null -ne $script:taskKey) { [Array]::Clear($script:taskKey, 0, $script:taskKey.Length) }
}
