function Resolve-RabiSpeechEndpoint {
    param([string]$ExplicitUrl = "")

    if (-not [string]::IsNullOrWhiteSpace($ExplicitUrl)) {
        return $ExplicitUrl.Trim().TrimEnd('/')
    }
    $resolver = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\scripts\resolve-speech.mjs'))
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Node.js is required for discovery; provide -RabiSpeechBaseUrl explicitly.' }
    $node = $nodeCommand.Source
    $result = & $node $resolver 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "RabiSpeech discovery failed: $($result -join ' ')"
    }
    $url = ($result -join "`n").Trim()
    if (-not $url) { throw 'RabiSpeech discovery did not publish a service URL.' }
    return $url
}
