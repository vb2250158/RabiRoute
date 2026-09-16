#requires -Version 5.1
<#
.SYNOPSIS
Reports drift between the RabiRoute-owned project skills and the localized copies installed in a downstream project.

.DESCRIPTION
RabiRoute owns the rules for these skills; each consuming project owns its localized copy under
`.agents/skills/<name>/`. A localized copy is deliberately not a byte copy: internal references are
replaced with project-local pages and project-specific rules are added. This script therefore never
rewrites the copy. It compares the current source and target trees against the baseline recorded by
the last completed port and reports, per file, what an Agent has to port:

  source-ahead      upstream changed; port the change into the localized copy
  target-modified   the project changed it locally; upstream is unchanged
  both-changed      both sides moved; read both before porting
  baseline-missing  no baseline recorded yet; review once, then record it
  target-missing    the project has not installed this skill

Agent workflow:

1. Run this script and read the per-file lists.
2. Port every upstream change into the localized copy. Keep project-local edits; never revert them
   blindly and never drop the project's own rules.
3. Run `-UpdateBaseline` to record the new baseline, then run the report again and confirm `in-sync`.

Reading the report is read-only. Only `-UpdateBaseline` writes, and it writes only the baseline file
inside the target skill directory.

.PARAMETER ProjectPath
Downstream project root that contains the target directory from `project-skills.json`.

.PARAMETER Skill
Restrict the report to catalog skills.

.PARAMETER UpdateBaseline
Record the current source and target trees as the new baseline. Run this after a completed port.

.PARAMETER Check
Exit non-zero unless every selected skill is `in-sync`. Use it as a gate.

.EXAMPLE
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath ../ExampleProject

.EXAMPLE
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath ../ExampleProject -Check

.EXAMPLE
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath ../ExampleProject -Skill plan-task-orchestration -UpdateBaseline
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectPath,
    [string[]]$Skill = @(),
    [switch]$UpdateBaseline,
    [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
$catalogPath = Join-Path $sourceRoot 'project-skills.json'
if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw "Missing catalog: $catalogPath" }
$catalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
if ([int]$catalog.schemaVersion -ne 1) { throw "Unsupported catalog schemaVersion: $($catalog.schemaVersion)" }
$targetDirectory = [string]$catalog.targetDirectory
$baselineName = [string]$catalog.baselineFile
$catalogSkills = @($catalog.skills | ForEach-Object { $_.name })

$projectRoot = (Resolve-Path -LiteralPath $ProjectPath).Path
$selected = if ($Skill.Count -gt 0) { @($Skill) } else { $catalogSkills }
foreach ($name in $selected) {
    if ($name -notin $catalogSkills) { throw "Skill is not in the catalog: $name" }
    if ($name -notmatch '^[a-z0-9-]+$') { throw "Invalid skill name: $name" }
}

$skipDirectoryNames = @('__pycache__', '.git', 'node_modules')
$skipFileExtensions = @('.pyc')

function Get-RelativePath {
    param([Parameter(Mandatory)][string]$Base, [Parameter(Mandatory)][string]$Path)
    $baseFull = [IO.Path]::GetFullPath($Base).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $pathFull = [IO.Path]::GetFullPath($Path)
    if ($pathFull.StartsWith($baseFull, [StringComparison]::OrdinalIgnoreCase)) {
        $trimmed = $pathFull.Substring($baseFull.Length).TrimStart([IO.Path]::DirectorySeparatorChar)
        if ($trimmed) { return $trimmed }
    }
    return $pathFull
}

function Get-TreeHashes {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$SkipName)
    $map = [Collections.Generic.SortedDictionary[string, string]]::new([StringComparer]::Ordinal)
    foreach ($file in Get-ChildItem -LiteralPath $Root -Recurse -File -Force) {
        if ($file.Name -eq $SkipName -or $file.Extension -in $skipFileExtensions) { continue }
        $relative = (Get-RelativePath -Base $Root -Path $file.FullName).Replace('\', '/')
        if (($relative -split '/') | Where-Object { $_ -in $skipDirectoryNames }) { continue }
        $map[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $map
}

function Write-JsonFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Content)
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Compare-TreeHashes {
    param($Current, $Baseline)
    $result = [ordered]@{ added = @(); removed = @(); modified = @() }
    foreach ($path in $Current.Keys) {
        if (-not $Baseline.ContainsKey($path)) { $result.added += $path }
        elseif ($Baseline[$path] -ne $Current[$path]) { $result.modified += $path }
    }
    foreach ($path in $Baseline.Keys) {
        if (-not $Current.ContainsKey($path)) { $result.removed += $path }
    }
    return $result
}

function ConvertTo-HashMap {
    param($Value)
    $map = [Collections.Generic.SortedDictionary[string, string]]::new([StringComparer]::Ordinal)
    if ($null -ne $Value) {
        foreach ($property in $Value.PSObject.Properties) { $map[$property.Name] = [string]$property.Value }
    }
    return $map
}

function Assert-SafeTargetPath {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$ProjectRoot)
    $ancestor = $Path
    while ($ancestor -and $ancestor.Length -ge $ProjectRoot.Length) {
        if (Test-Path -LiteralPath $ancestor) {
            $entry = Get-Item -LiteralPath $ancestor -Force
            if (-not $entry.PSIsContainer -or $entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Target path is obstructed, a symbolic link or a junction: $ancestor"
            }
        }
        if ($ancestor -eq $ProjectRoot) { break }
        $ancestor = Split-Path -Parent $ancestor
    }
}

function Get-LoadReferenceState {
    param([Parameter(Mandatory)][string]$ProjectRoot, [Parameter(Mandatory)][string]$TargetDirectory, [Parameter(Mandatory)][string]$Name)
    $entry = Join-Path $ProjectRoot 'AGENTS.md'
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { return 'AGENTS.md missing' }
    $expected = "$TargetDirectory/$Name/SKILL.md".Replace('\', '/')
    $content = (Get-Content -LiteralPath $entry -Raw).Replace('\', '/')
    if ($content.Contains($expected)) { return 'ok' }
    return "not referenced: $expected"
}

$skillResults = [Collections.Generic.List[object]]::new()
foreach ($name in $selected) {
    $sourceDirectory = Join-Path (Join-Path $sourceRoot 'skills') $name
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory 'SKILL.md') -PathType Leaf)) {
        throw "Source skill is incomplete: $sourceDirectory"
    }
    $targetRoot = Join-Path $projectRoot $targetDirectory
    $targetDirectoryPath = Join-Path $targetRoot $name
    $baselinePath = Join-Path $targetDirectoryPath $baselineName
    Assert-SafeTargetPath -Path $targetRoot -ProjectRoot $projectRoot

    $sourceFiles = Get-TreeHashes -Root $sourceDirectory -SkipName $baselineName
    $sourceHash = (Get-FileHash -LiteralPath (Join-Path $sourceDirectory 'SKILL.md') -Algorithm SHA256).Hash.ToLowerInvariant()

    if (-not (Test-Path -LiteralPath $targetDirectoryPath -PathType Container)) {
        $skillResults.Add([pscustomobject]@{
            name = $name; verdict = 'target-missing'; sourceFiles = $sourceFiles
            sourceChanged = [ordered]@{ added = @(); removed = @(); modified = @() }
            targetChanged = [ordered]@{ added = @(); removed = @(); modified = @() }
            loadReference = 'n/a'; targetFiles = $null; skillContentHash = $sourceHash
        })
        continue
    }

    $targetFiles = Get-TreeHashes -Root $targetDirectoryPath -SkipName $baselineName
    $loadReference = Get-LoadReferenceState -ProjectRoot $projectRoot -TargetDirectory $targetDirectory -Name $name

    if (-not (Test-Path -LiteralPath $baselinePath -PathType Leaf)) {
        $skillResults.Add([pscustomobject]@{
            name = $name; verdict = 'baseline-missing'; sourceFiles = $sourceFiles
            sourceChanged = [ordered]@{ added = @($sourceFiles.Keys); removed = @(); modified = @() }
            targetChanged = [ordered]@{ added = @(); removed = @(); modified = @() }
            loadReference = $loadReference; targetFiles = $targetFiles; skillContentHash = $sourceHash
        })
        continue
    }

    $baseline = Get-Content -LiteralPath $baselinePath -Raw | ConvertFrom-Json
    $sourceChanged = Compare-TreeHashes -Current $sourceFiles -Baseline (ConvertTo-HashMap $baseline.sourceFiles)
    $targetChanged = Compare-TreeHashes -Current $targetFiles -Baseline (ConvertTo-HashMap $baseline.targetFiles)
    $sourceMoved = ($sourceChanged.added.Count + $sourceChanged.removed.Count + $sourceChanged.modified.Count) -gt 0
    $targetMoved = ($targetChanged.added.Count + $targetChanged.removed.Count + $targetChanged.modified.Count) -gt 0
    $verdict = if ($sourceMoved -and $targetMoved) { 'both-changed' }
        elseif ($sourceMoved) { 'source-ahead' }
        elseif ($targetMoved) { 'target-modified' }
        else { 'in-sync' }

    $skillResults.Add([pscustomobject]@{
        name = $name; verdict = $verdict; sourceFiles = $sourceFiles
        sourceChanged = $sourceChanged; targetChanged = $targetChanged
        loadReference = $loadReference; targetFiles = $targetFiles; skillContentHash = $sourceHash
    })
}

if ($UpdateBaseline) {
    $stamped = (Get-Date).ToString('o')
    foreach ($result in $skillResults) {
        if ($result.verdict -eq 'target-missing') { throw "Cannot record a baseline without a target copy: $($result.name)" }
        $baselinePath = Join-Path (Join-Path (Join-Path $projectRoot $targetDirectory) $result.name) $baselineName
        $payload = [ordered]@{
            schemaVersion = 1
            skill = $result.name
            source = "skills/$($result.name)"
            portedAt = $stamped
            sourceFiles = $result.sourceFiles
            targetFiles = $result.targetFiles
        }
        $json = $payload | ConvertTo-Json -Depth 5
        Write-JsonFile -Path $baselinePath -Content $json
        Write-Output "baseline updated: $((Get-RelativePath -Base $projectRoot -Path $baselinePath).Replace('\', '/'))"
    }
    Write-Output ''
}

function Write-ChangeList {
    param([Parameter(Mandatory)][string]$Label, $Changes)
    $lines = @()
    foreach ($path in $Changes.added) { $lines += "    + $path" }
    foreach ($path in $Changes.removed) { $lines += "    - $path" }
    foreach ($path in $Changes.modified) { $lines += "    ~ $path" }
    if ($lines.Count -eq 0) { Write-Output "  $Label`: none" } else { Write-Output "  $Label`:"; $lines | ForEach-Object { Write-Output $_ } }
}

$analysis = @{ 'in-sync' = 'no action'; 'source-ahead' = 'port the upstream changes into the localized copy'; 'target-modified' = 'upstream unchanged; keep the project-local edit'; 'both-changed' = 'both sides moved; read both before porting'; 'baseline-missing' = 'review once, then record the baseline'; 'target-missing' = 'install the skill, or drop it from the catalog' }

Write-Output "project: $projectRoot"
Write-Output "source:  $sourceRoot"
Write-Output ''
foreach ($result in $skillResults) {
    Write-Output "$($result.name): $($result.verdict) - $($analysis[$result.verdict])"
    if ($result.verdict -eq 'target-missing') { Write-Output ''; continue }
    Write-Output "  load reference: $($result.loadReference)"
    if ($result.verdict -eq 'baseline-missing') {
        Write-Output "  upstream files: $((@($result.sourceFiles.Keys) -join ', '))"
        Write-Output "  project files:  $((@($result.targetFiles.Keys) -join ', '))"
    } else {
        Write-ChangeList -Label 'upstream changes to port' -Changes $result.sourceChanged
        Write-ChangeList -Label 'project-local changes' -Changes $result.targetChanged
    }
    Write-Output ''
}

if ($Check) {
    $blocked = @($skillResults | Where-Object { $_.verdict -ne 'in-sync' -or $_.loadReference -ne 'ok' })
    if ($blocked.Count -gt 0) {
        Write-Output "not in sync: $((($blocked | ForEach-Object { $_.name }) -join ', '))"
        exit 1
    }
    Write-Output 'all selected skills are in sync'
}
exit 0
