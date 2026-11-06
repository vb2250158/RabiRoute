# Exact, operation-scoped adjudication of scanner candidates. Never changes the raw scanner report.
function Get-RabiReviewHash {
    param([byte[]]$Bytes, [string]$Algorithm = "SHA256")
    $hasher = [System.Security.Cryptography.HashAlgorithm]::Create($Algorithm)
    try { return ([BitConverter]::ToString($hasher.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $hasher.Dispose() }
}

function Get-RabiReviewTextHash {
    param([string]$Text)
    return Get-RabiReviewHash ([Text.Encoding]::UTF8.GetBytes($Text))
}

function Invoke-RabiReviewGitBytes {
    param([string]$Repository, [string[]]$Arguments)
    # ProcessStartInfo never invokes a shell. Quote argv for Windows PowerShell 5.1 as well.
    $quoted = @(@("-C", $Repository) + $Arguments | ForEach-Object {
        '"' + [regex]::Replace([regex]::Replace($_, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
    })
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $start.Arguments = $quoted -join " "
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $memory = [IO.MemoryStream]::new()
    try {
        [void]$process.Start()
        $errors = $process.StandardError.ReadToEndAsync()
        $process.StandardOutput.BaseStream.CopyTo($memory)
        $process.WaitForExit()
        [void]$errors.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "Review Git snapshot could not be read." }
        return ,$memory.ToArray()
    } finally { $memory.Dispose(); $process.Dispose() }
}

function Get-RabiReviewGitText {
    param([string]$Repository, [string[]]$Arguments)
    return [Text.Encoding]::UTF8.GetString((Invoke-RabiReviewGitBytes $Repository $Arguments)).TrimEnd("`r", "`n")
}

function Resolve-RabiReviewPath {
    param([string]$Root, [string]$Relative, [switch]$LexicalOnly)
    if ([string]::IsNullOrWhiteSpace($Relative) -or $Relative -ne $Relative.Trim() -or
        $Relative -match '[\\\x00-\x1f\x7f:*?"<>|]' -or $Relative.StartsWith("/") -or
        @($Relative.Split('/') | Where-Object { $_ -in @("", ".", "..", ".git") }).Count) {
        throw "Review path must be a canonical relative file path."
    }
    $base = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $target = [IO.Path]::GetFullPath((Join-Path $base $Relative))
    $comparison = if ([IO.Path]::DirectorySeparatorChar -eq '\') { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    if (-not $target.StartsWith($base + [IO.Path]::DirectorySeparatorChar, $comparison)) { throw "Review path escaped its root." }
    $current = $base
    foreach ($segment in $Relative.Split('/')) {
        $current = Join-Path $current $segment
        if (-not $LexicalOnly -and ([IO.File]::Exists($current) -or [IO.Directory]::Exists($current))) {
            if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Review paths cannot traverse links." }
        }
    }
    return $target
}

function Get-RabiReviewBlobId {
    param([byte[]]$Bytes, [string]$ObjectFormat)
    $header = [Text.Encoding]::ASCII.GetBytes("blob $($Bytes.Length)" + [char]0)
    $content = [byte[]]::new($header.Length + $Bytes.Length)
    [Buffer]::BlockCopy($header, 0, $content, 0, $header.Length)
    [Buffer]::BlockCopy($Bytes, 0, $content, $header.Length, $Bytes.Length)
    return Get-RabiReviewHash $content $(if ($ObjectFormat -eq "sha256") { "SHA256" } else { "SHA1" })
}

function Get-RabiSecurityReviewContext {
    param([string]$Repository, [string]$Scope, [string]$FailOn, $SecurityReport, [string[]]$ChangedFiles)
    $repositoryRoot = [IO.Path]::GetFullPath((Get-RabiReviewGitText $Repository @("rev-parse", "--show-toplevel"))).Replace('\', '/').TrimEnd('/')
    $gitDirectory = [IO.Path]::GetFullPath((Get-RabiReviewGitText $Repository @("rev-parse", "--absolute-git-dir"))).Replace('\', '/').TrimEnd('/')
    $baseHead = Get-RabiReviewGitText $Repository @("rev-parse", "HEAD")
    $objectFormat = Get-RabiReviewGitText $Repository @("rev-parse", "--show-object-format")
    if ($objectFormat -notin @("sha1", "sha256") -or $Scope -notin @("WorkingTree", "Staged")) { throw "Invalid review snapshot kind." }
    $identity = $repositoryRoot + "`n" + $gitDirectory
    if ([IO.Path]::DirectorySeparatorChar -eq '\') { $identity = $identity.ToLowerInvariant() }
    $repositoryId = Get-RabiReviewTextHash $identity
    $index = @{}
    foreach ($entry in (Get-RabiReviewGitText $Repository @("-c", "core.quotepath=false", "ls-files", "--stage", "-z")).Split([char]0)) {
        if (-not $entry) { continue }
        if ($entry -notmatch '^(\d{6}) ([0-9a-f]+) ([0-3])\t(.+)$') { throw "Invalid review index entry." }
        $index[$Matches[4]] = @{ mode = $Matches[1]; id = $Matches[2]; stage = $Matches[3] }
    }
    $stagedPaths = @((Get-RabiReviewGitText $Repository @("-c", "core.quotepath=false", "diff", "--cached", "--name-only", "-z")).Split([char]0))
    $files = @{}
    $manifest = [Collections.Generic.List[string]]::new()
    $paths = @($ChangedFiles | Sort-Object -Unique -CaseSensitive)
    $actualPaths = [Collections.Generic.List[string]]::new()
    $pathQueries = ,@('diff', '--cached', '--no-ext-diff', '--name-only', '-z')
    if ($Scope -eq 'WorkingTree') { $pathQueries += ,@('diff', '--no-ext-diff', '--name-only', '-z'); $pathQueries += ,@('ls-files', '--others', '--exclude-standard', '-z') }
    foreach ($query in $pathQueries) {
        foreach ($name in (Get-RabiReviewGitText $Repository $query).Split([char]0)) { if ($name) { $actualPaths.Add($name) } }
    }
    $actual = @($actualPaths | Sort-Object -Unique -CaseSensitive)
    if (($paths -join "`0") -cne ($actual -join "`0")) { throw "Changed paths differ from the current scoped Git snapshot." }
    if ($Scope -eq 'WorkingTree') { $manifest.Add("git-unstaged`0" + (Get-RabiReviewGitText $Repository @('diff', '--no-ext-diff', '--raw', '--no-abbrev', '-z'))) }
    $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
    foreach ($relative in $paths) {
        $absolute = Resolve-RabiReviewPath $repositoryRoot $relative -LexicalOnly:($Scope -eq 'Staged')
        $indexed = $index[$relative]
        if ($indexed -and ($indexed.stage -ne '0' -or $indexed.mode -notin @('100644', '100755'))) { throw "Review snapshot contains a non-regular index entry." }
        $bytes = $null; $kind = "missing"; $text = $null
        if ($Scope -eq "Staged") {
            if ($indexed) { $kind = "git-index-bytes-v1" }
        } elseif ([IO.File]::Exists($absolute)) {
            $bytes = [IO.File]::ReadAllBytes($absolute)
            $kind = "worktree-bytes-v1"
        }
        $file = @{ relative = $relative; absolute = $absolute; bytes = $bytes; text = $text; contentKind = $kind; indexed = $indexed }
        if ($Scope -eq "Staged") {
            $file.blobId = if ($indexed) { $indexed.id } else { "missing" }
            $manifest.Add("$relative`0$kind`0$($file.blobId)`0$($indexed.mode)")
        } else {
            $file.fileSha256 = if ($null -ne $bytes) { Get-RabiReviewHash $bytes } else { "missing" }
            $file.blobId = if ($null -ne $bytes) { Get-RabiReviewBlobId $bytes $objectFormat } else { "missing" }
            $manifest.Add("$relative`0$kind`0$($file.fileSha256)`0$($indexed.id)`0$($indexed.mode)")
        }
        $files[$relative] = $file
    }
    $reported = [Collections.Generic.List[object]]::new()
    foreach ($finding in @($SecurityReport.findings)) {
        $file = $files[[string]$finding.file]
        if (-not $file) { throw "Scanner candidate is outside the reviewed change set." }
        if ($Scope -eq "Staged" -and $null -eq $file.bytes) {
            $file.bytes = Invoke-RabiReviewGitBytes $Repository @("show", ":$($finding.file)")
            $file.fileSha256 = Get-RabiReviewHash $file.bytes
            if ((Get-RabiReviewBlobId $file.bytes $objectFormat) -cne $file.blobId) { throw "Index changed while reading the review snapshot." }
        }
        if ($null -eq $file.bytes) { throw "A scanner candidate has no current byte snapshot." }
        # Decode only the finding's display hunk. Whole-file and scope identities always retain raw bytes.
        if ($null -eq $file.text) { $file.text = $strictUtf8.GetString($file.bytes).Replace("`r`n", "`n") }
        if ($Scope -eq "WorkingTree" -and $stagedPaths -ccontains [string]$finding.file -and $file.indexed) {
            $indexedBytes = Invoke-RabiReviewGitBytes $Repository @("show", ":$($finding.file)")
            if ((Get-RabiReviewHash $indexedBytes) -cne $file.fileSha256) { throw "Mixed index/worktree candidate requires a separate staged review." }
        }
        $lines = $file.text.Split("`n")
        $line = [int]$finding.line
        if ($line -lt 1 -or $line -gt $lines.Length) { throw "Scanner candidate line is outside its current snapshot." }
        # A finding hunk is the numbered LF-normalized source window, two lines on each side.
        # The entire scoped blob and full change-set digest are independently bound below.
        $first = [Math]::Max(1, $line - 2); $last = [Math]::Min($lines.Length, $line + 2)
        $window = "$first`:$last`n" + ($lines[($first - 1)..($last - 1)] -join "`n")
        $reported.Add([pscustomobject]@{ severity = $finding.severity; rule = $finding.rule; file = $finding.file; line = $line
            hunkHash = Get-RabiReviewTextHash $window; fileSha256 = $file.fileSha256; blobId = $file.blobId; contentKind = $file.contentKind })
    }
    return [pscustomobject]@{ schemaVersion = 1; repository = $repositoryRoot; repositoryId = $repositoryId; baseHead = $baseHead
        scope = $Scope; failOn = $FailOn; scopeHash = Get-RabiReviewTextHash ($manifest -join "`n"); reported = $reported.ToArray() }
}

function Resolve-RabiSecurityReviewReceipt {
    param([string]$Repository, [string]$Scope, [string]$FailOn, $SecurityReport, [string[]]$ChangedFiles, [string]$ReceiptPath)
    $reported = @($SecurityReport.findings); $resolved = @(); $diagnostics = [Collections.Generic.List[string]]::new(); $context = $null; $phase = 'snapshot'; $receiptSha256 = $null
    try {
        $context = Get-RabiSecurityReviewContext $Repository $Scope $FailOn $SecurityReport $ChangedFiles
        $reported = @($context.reported)
        $phase = 'external-file'
        $receiptFile = [IO.Path]::GetFullPath($ReceiptPath)
        $root = [IO.Path]::GetFullPath($Repository).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $comparison = if ([IO.Path]::DirectorySeparatorChar -eq '\') { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
        if ($receiptFile.StartsWith($root + [IO.Path]::DirectorySeparatorChar, $comparison) -or
            -not [IO.File]::Exists($receiptFile) -or ([IO.FileInfo]::new($receiptFile)).Length -gt 1MB -or
            (([IO.File]::GetAttributes($receiptFile) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "Receipt must be an external regular JSON evidence file." }
        $ancestor = [IO.FileInfo]::new($receiptFile)
        while ($ancestor) {
            if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Receipt ancestry cannot traverse links." }
            $ancestor = if ($ancestor -is [IO.FileInfo]) { $ancestor.Directory } else { $ancestor.Parent }
        }
        $receiptBytes = [IO.File]::ReadAllBytes($receiptFile)
        if ($receiptBytes.Length -gt 1MB) { throw "Receipt exceeds its bounded JSON size." }
        $receiptSha256 = Get-RabiReviewHash $receiptBytes
        $receipt = ([Text.UTF8Encoding]::new($false, $true).GetString($receiptBytes).TrimStart([char]0xFEFF)) | ConvertFrom-Json
        foreach ($field in @('schemaVersion', 'repository', 'repositoryId', 'baseHead', 'scope', 'failOn', 'scopeHash')) {
            $phase = "identity.$field"
            if ([string]$receipt.$field -cne [string]$context.$field) { throw "Receipt snapshot identity differs." }
        }
        $phase = 'reviewer'
        if (-not ($receipt.reviewer -is [string]) -or -not $receipt.reviewer.Trim() -or
            -not ($receipt.reviewedAt -is [string] -or $receipt.reviewedAt -is [DateTime] -or $receipt.reviewedAt -is [DateTimeOffset])) { throw "Receipt requires a reviewer and review time." }
        $reviewedAt = [DateTimeOffset]::MinValue
        if (-not [DateTimeOffset]::TryParse([string]$receipt.reviewedAt, [ref]$reviewedAt)) { throw "Receipt review time is invalid." }
        $phase = 'finding-set'
        $entries = @($receipt.findings)
        if (-not $entries.Count -or $entries.Count -gt $reported.Count) { throw "Receipt finding set is invalid." }
        $matched = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($entry in $entries) {
            $phase = 'finding-disposition'
            [void](Resolve-RabiReviewPath $root ([string]$entry.file) -LexicalOnly:($Scope -eq 'Staged'))
            if ($entry.status -cne 'closed' -or $entry.disposition -cnotin @('false_positive', 'verified_trusted_contract') -or
                -not ($entry.realVulnerability -is [bool]) -or $entry.realVulnerability -ne $false -or $entry.severity -cne 'High') { throw "Receipt cannot accept real vulnerabilities or unknown dispositions." }
            foreach ($field in @('input', 'sink', 'boundary', 'verification')) {
                $phase = "facts.$field"
                if (-not ($entry.facts.$field -is [string]) -or -not $entry.facts.$field.Trim()) { throw "Receipt lacks source-to-sink review facts." }
            }
            $evidence = @($entry.evidence)
            $phase = 'evidence'
            if (-not $evidence.Count -or $evidence.Count -gt 32) { throw "Receipt lacks bounded review evidence." }
            foreach ($proof in $evidence) {
                if ([string]$proof.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw "Receipt evidence hash is invalid." }
                $proofFile = Resolve-RabiReviewPath (Split-Path -Parent $receiptFile) ([string]$proof.path)
                if (-not [IO.File]::Exists($proofFile)) { throw "Receipt evidence is missing." }
                $stream = [IO.File]::OpenRead($proofFile); $hasher = [Security.Cryptography.SHA256]::Create()
                try { $hash = ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
                finally { $stream.Dispose(); $hasher.Dispose() }
                if ($hash -cne [string]$proof.sha256) { throw "Receipt evidence changed." }
            }
            $candidates = @($reported | Where-Object {
                $_.rule -ceq $entry.rule -and $_.file -ceq $entry.file -and $_.line -eq $entry.line -and $_.severity -ceq $entry.severity -and
                $_.hunkHash -ceq $entry.hunkHash -and $_.fileSha256 -ceq $entry.fileSha256 -and $_.blobId -ceq $entry.blobId -and $_.contentKind -ceq $entry.contentKind
            })
            $phase = 'candidate-binding'
            $key = "$($entry.rule)`0$($entry.file)`0$($entry.line)"
            if (-not $candidates.Count -or -not $matched.Add($key)) { throw "Receipt candidate does not exactly match the current scan." }
            $resolved += $candidates
        }
        $phase = 'snapshot-recheck'
        $recheck = Get-RabiSecurityReviewContext $Repository $Scope $FailOn $SecurityReport $ChangedFiles
        if ($recheck.scopeHash -cne $context.scopeHash -or $recheck.baseHead -cne $context.baseHead -or $recheck.repositoryId -cne $context.repositoryId -or
            ($recheck.reported | ConvertTo-Json -Depth 4 -Compress) -cne ($context.reported | ConvertTo-Json -Depth 4 -Compress)) { throw "Review snapshot changed while checking evidence." }
        if ((Get-RabiReviewHash ([IO.File]::ReadAllBytes($receiptFile))) -cne $receiptSha256) { throw "Review receipt changed while checking evidence." }
    } catch { $diagnostics.Add("review-receipt-invalid:$phase"); $resolved = @() }
    $unresolved = @($reported | Where-Object { $resolved -notcontains $_ })
    $rank = @{ Info = 0; Low = 1; Medium = 2; High = 3; Critical = 4 }
    $effectivePassed = $diagnostics.Count -eq 0 -and @($unresolved | Where-Object { $rank[[string]$_.severity] -ge $rank[$FailOn] }).Count -eq 0
    return [pscustomobject]@{ receiptValid = $diagnostics.Count -eq 0; reported = @($reported); resolved = @($resolved); unresolved = @($unresolved)
        rawPassed = [bool]$SecurityReport.passed; effectivePassed = [bool]$effectivePassed; receiptSha256 = $receiptSha256; diagnostics = $diagnostics.ToArray(); context = $context }
}
