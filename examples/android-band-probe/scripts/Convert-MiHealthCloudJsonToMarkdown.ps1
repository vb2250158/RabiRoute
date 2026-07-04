param(
    [string]$InputJson = "",
    [string]$InputZip = "",
    [string]$RawDir = "",
    [string]$OutputMarkdown = ""
)

$ErrorActionPreference = "Stop"

if (-not [string]::IsNullOrWhiteSpace($InputZip)) {
    $extractRoot = Join-Path $env:TEMP ("mi-health-cloud-" + [System.IO.Path]::GetFileNameWithoutExtension($InputZip) + "-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
    Expand-Archive -LiteralPath $InputZip -DestinationPath $extractRoot -Force
    if ([string]::IsNullOrWhiteSpace($InputJson)) {
        $candidateJson = Get-ChildItem -LiteralPath $extractRoot -Filter "mi-health-heart-rate.json" -File -Recurse | Select-Object -First 1
        if ($null -eq $candidateJson) {
            $candidateJson = Get-ChildItem -LiteralPath $extractRoot -Filter "*.json" -File -Recurse |
                Where-Object { $_.FullName -notmatch "[\\/]raw[\\/]" } |
                Select-Object -First 1
        }
        if ($null -eq $candidateJson) {
            throw "ZIP 里没有找到主 JSON。"
        }
        $InputJson = $candidateJson.FullName
    }
    if ([string]::IsNullOrWhiteSpace($RawDir)) {
        $candidateRaw = Get-ChildItem -LiteralPath $extractRoot -Directory -Recurse |
            Where-Object { $_.Name -eq "raw" -or $_.Name -like "raw-*" } |
            Select-Object -First 1
        if ($null -ne $candidateRaw) {
            $RawDir = $candidateRaw.FullName
        }
    }
}

if ([string]::IsNullOrWhiteSpace($InputJson)) {
    throw "需要提供 -InputJson 或 -InputZip。"
}

if ([string]::IsNullOrWhiteSpace($OutputMarkdown)) {
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($InputJson)
    $OutputMarkdown = Join-Path (Split-Path -Parent $InputJson) "$baseName.summary.md"
}

$root = Get-Content -LiteralPath $InputJson -Raw -Encoding UTF8 | ConvertFrom-Json
$points = @($root.points)
$rawPoints = New-Object System.Collections.Generic.List[object]
$rawSources = New-Object System.Collections.Generic.List[object]
$counts = @{}
$uniqueKeys = New-Object 'System.Collections.Generic.HashSet[string]'
$values = New-Object System.Collections.Generic.List[double]
$rows = New-Object System.Collections.Generic.List[object]

function Get-PointValueText {
    param([object]$Point)
    $valueText = ""
    $numeric = $null
    if ($Point.value -and @($Point.value).Count -gt 0) {
        $first = @($Point.value)[0]
        if ($null -ne $first.fpVal) {
            $numeric = [double]$first.fpVal
            $valueText = "$numeric"
        } elseif ($null -ne $first.intVal) {
            $numeric = [double]$first.intVal
            $valueText = "$numeric"
        } elseif ($null -ne $first.value) {
            $numeric = [double]$first.value
            $valueText = "$numeric"
        } else {
            $valueText = ($Point.value | ConvertTo-Json -Compress -Depth 20)
        }
    }
    [pscustomobject]@{
        Text = $valueText
        Numeric = $numeric
    }
}

function Find-DataPointArrays {
    param(
        [object]$Node,
        [string]$Path = '$'
    )
    $found = New-Object System.Collections.Generic.List[object]
    if ($null -eq $Node) {
        return $found
    }
    if ($Node -is [System.Array]) {
        for ($i = 0; $i -lt $Node.Count; $i++) {
            $childFound = Find-DataPointArrays -Node $Node[$i] -Path "$Path[$i]"
            foreach ($item in $childFound) { $found.Add($item) }
        }
        return $found
    }
    if ($Node -is [pscustomobject]) {
        foreach ($property in $Node.PSObject.Properties) {
            if ($property.Name -eq "dataPoint" -and $property.Value) {
                $found.Add([pscustomobject]@{
                    Path = "$Path.dataPoint"
                    Points = @($property.Value)
                })
            }
            $childFound = Find-DataPointArrays -Node $property.Value -Path "$Path.$($property.Name)"
            foreach ($item in $childFound) { $found.Add($item) }
        }
    }
    return $found
}

function Get-JsonPropertyValue {
    param(
        [object]$Node,
        [string]$Name
    )
    if ($null -eq $Node -or $Node -isnot [pscustomobject]) {
        return $null
    }
    $property = $Node.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Get-DataTypeText {
    param([object]$Source)
    $direct = Get-JsonPropertyValue -Node $Source -Name "dataTypeName"
    if ($null -ne $direct -and -not [string]::IsNullOrWhiteSpace([string]$direct)) {
        return [string]$direct
    }
    $dataType = Get-JsonPropertyValue -Node $Source -Name "dataType"
    if ($null -eq $dataType) {
        return ""
    }
    if ($dataType -is [string]) {
        return [string]$dataType
    }
    foreach ($name in @("name", "dataTypeName", "type", "dataType")) {
        $value = Get-JsonPropertyValue -Node $dataType -Name $name
        if ($null -ne $value -and -not [string]::IsNullOrWhiteSpace([string]$value)) {
            return [string]$value
        }
    }
    return ($dataType | ConvertTo-Json -Compress -Depth 20)
}

function Find-DataSourceObjects {
    param(
        [object]$Node,
        [string]$Path = '$'
    )
    $found = New-Object System.Collections.Generic.List[object]
    if ($null -eq $Node) {
        return $found
    }
    if ($Node -is [System.Array]) {
        for ($i = 0; $i -lt $Node.Count; $i++) {
            $childFound = Find-DataSourceObjects -Node $Node[$i] -Path "$Path[$i]"
            foreach ($item in $childFound) { $found.Add($item) }
        }
        return $found
    }
    if ($Node -is [pscustomobject]) {
        $streamId = Get-JsonPropertyValue -Node $Node -Name "dataStreamId"
        $streamName = Get-JsonPropertyValue -Node $Node -Name "dataStreamName"
        $typeText = Get-DataTypeText -Source $Node
        if (($null -ne $streamId -and -not [string]::IsNullOrWhiteSpace([string]$streamId)) -or
            ($null -ne $streamName -and -not [string]::IsNullOrWhiteSpace([string]$streamName)) -or
            -not [string]::IsNullOrWhiteSpace($typeText)) {
            $found.Add([pscustomobject]@{
                Path = $Path
                Source = $Node
            })
        }
        foreach ($property in $Node.PSObject.Properties) {
            $childFound = Find-DataSourceObjects -Node $property.Value -Path "$Path.$($property.Name)"
            foreach ($item in $childFound) { $found.Add($item) }
        }
    }
    return $found
}

foreach ($point in $points) {
    $dataType = if ($point.dataType) { [string]$point.dataType } else { "<unknown>" }
    if (-not $counts.ContainsKey($dataType)) {
        $counts[$dataType] = 0
    }
    $counts[$dataType] += 1

    $value = Get-PointValueText -Point $point
    $key = if ($point.uniqueKey) {
        [string]$point.uniqueKey
    } else {
        "$dataType|$($point.sourceId)|$($point.startTimeNanos)|$($point.endTimeNanos)|$(($point.value | ConvertTo-Json -Compress -Depth 20))"
    }
    [void]$uniqueKeys.Add($key)
    if ($null -ne $value.Numeric) {
        $values.Add($value.Numeric)
    }
    $rows.Add([pscustomobject]@{
        DataType = $dataType
        StartTime = $point.startTime
        EndTime = $point.endTime
        Value = $value.Text
        SourceId = $point.sourceId
        Page = $point.page
    })
}

if ([string]::IsNullOrWhiteSpace($RawDir)) {
    $candidate = Join-Path (Split-Path -Parent $InputJson) "raw"
    if (Test-Path -LiteralPath $candidate) {
        $RawDir = $candidate
    } else {
        $candidateRaw = Get-ChildItem -LiteralPath (Split-Path -Parent $InputJson) -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "raw-*" } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($null -ne $candidateRaw) {
            $RawDir = $candidateRaw.FullName
        }
    }
}

if (-not [string]::IsNullOrWhiteSpace($RawDir) -and (Test-Path -LiteralPath $RawDir)) {
    Get-ChildItem -LiteralPath $RawDir -Filter *.json -File -Recurse | ForEach-Object {
        $rawFile = $_.FullName
        try {
            $rawRoot = Get-Content -LiteralPath $rawFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $arrays = Find-DataPointArrays -Node $rawRoot
            foreach ($array in $arrays) {
                foreach ($point in @($array.Points)) {
                    $value = Get-PointValueText -Point $point
                    $rawPoints.Add([pscustomobject]@{
                        RawFile = $rawFile
                        JsonPath = $array.Path
                        StartTimeNanos = $point.startTimeNanos
                        EndTimeNanos = $point.endTimeNanos
                        Value = $value.Text
                        Raw = $point
                    })
                }
            }
            $sources = Find-DataSourceObjects -Node $rawRoot
            foreach ($sourceItem in $sources) {
                $source = $sourceItem.Source
                $rawSources.Add([pscustomobject]@{
                    RawFile = $rawFile
                    JsonPath = $sourceItem.Path
                    DataStreamId = [string](Get-JsonPropertyValue -Node $source -Name "dataStreamId")
                    DataStreamName = [string](Get-JsonPropertyValue -Node $source -Name "dataStreamName")
                    DataType = Get-DataTypeText -Source $source
                    Raw = $source
                })
            }
        } catch {
            $rawPoints.Add([pscustomobject]@{
                RawFile = $rawFile
                JsonPath = "<parse-error>"
                StartTimeNanos = $null
                EndTimeNanos = $null
                Value = $_.Exception.Message
                Raw = $null
            })
        }
    }
}

$builder = New-Object System.Text.StringBuilder
[void]$builder.AppendLine("# 小米健康云心率列表整理")
[void]$builder.AppendLine()
[void]$builder.AppendLine("- 输入文件：$InputJson")
[void]$builder.AppendLine("- 总样本数：$($points.Count)")
[void]$builder.AppendLine("- 去重后样本数：$($uniqueKeys.Count)")
[void]$builder.AppendLine("- 疑似重复样本数：$($points.Count - $uniqueKeys.Count)")
[void]$builder.AppendLine("- raw dataPoint 样本数：$($rawPoints.Count)")
[void]$builder.AppendLine("- raw dataSource 样本数：$($rawSources.Count)")
if (-not [string]::IsNullOrWhiteSpace($RawDir)) {
    [void]$builder.AppendLine("- raw 目录：$RawDir")
}
if ($root.requestedStartTime -or $root.requestedEndTime) {
    [void]$builder.AppendLine("- 请求范围：$($root.requestedStartTime) ~ $($root.requestedEndTime)")
}
foreach ($key in ($counts.Keys | Sort-Object)) {
    [void]$builder.AppendLine("- $key：$($counts[$key]) 条")
}
if ($values.Count -gt 0) {
    $avg = ($values | Measure-Object -Average).Average
    $min = ($values | Measure-Object -Minimum).Minimum
    $max = ($values | Measure-Object -Maximum).Maximum
    [void]$builder.AppendLine(("- 数值统计：count={0} min={1:N1} max={2:N1} avg={3:N1}" -f $values.Count, $min, $max, $avg))
}

if ($rawSources.Count -gt 0) {
    $sourceTypeCounts = @{}
    foreach ($source in $rawSources) {
        $type = if ([string]::IsNullOrWhiteSpace([string]$source.DataType)) { "<unknown>" } else { [string]$source.DataType }
        if (-not $sourceTypeCounts.ContainsKey($type)) {
            $sourceTypeCounts[$type] = 0
        }
        $sourceTypeCounts[$type] += 1
    }
    [void]$builder.AppendLine()
    [void]$builder.AppendLine("## Raw HTTP 中发现的 dataSource")
    [void]$builder.AppendLine()
    foreach ($key in ($sourceTypeCounts.Keys | Sort-Object)) {
        [void]$builder.AppendLine("- $key：$($sourceTypeCounts[$key]) 个数据源")
    }
    [void]$builder.AppendLine()
    [void]$builder.AppendLine("| # | raw 文件 | JSON 路径 | dataType | dataStreamId | dataStreamName |")
    [void]$builder.AppendLine("|---:|---|---|---|---|---|")
    $sourceIndex = 0
    foreach ($source in $rawSources) {
        $sourceIndex += 1
        $rawFileName = [System.IO.Path]::GetFileName([string]$source.RawFile).Replace("|", "\|")
        $jsonPath = ([string]$source.JsonPath).Replace("|", "\|")
        $dataType = ([string]$source.DataType).Replace("|", "\|")
        $streamId = ([string]$source.DataStreamId).Replace("|", "\|")
        $streamName = ([string]$source.DataStreamName).Replace("|", "\|")
        [void]$builder.AppendLine("|$sourceIndex|$rawFileName|$jsonPath|$dataType|$streamId|$streamName|")
    }
}

[void]$builder.AppendLine()
[void]$builder.AppendLine("| # | 数据类型 | 开始时间 | 结束时间 | 心率/值 | 数据源 | 页码 |")
[void]$builder.AppendLine("|---:|---|---|---|---|---|---:|")

$index = 0
foreach ($row in $rows) {
    $index += 1
    $source = ([string]$row.SourceId).Replace("|", "\|")
    [void]$builder.AppendLine("|$index|$($row.DataType)|$($row.StartTime)|$($row.EndTime)|$($row.Value)|$source|$($row.Page)|")
}

if ($rawPoints.Count -gt 0) {
    [void]$builder.AppendLine()
    [void]$builder.AppendLine("## Raw HTTP 中发现的 dataPoint")
    [void]$builder.AppendLine()
    [void]$builder.AppendLine("| # | raw 文件 | JSON 路径 | startTimeNanos | endTimeNanos | 心率/值 |")
    [void]$builder.AppendLine("|---:|---|---|---:|---:|---|")
    $rawIndex = 0
    foreach ($point in $rawPoints) {
        $rawIndex += 1
        $rawFileName = [System.IO.Path]::GetFileName([string]$point.RawFile).Replace("|", "\|")
        $jsonPath = ([string]$point.JsonPath).Replace("|", "\|")
        $rawValue = ([string]$point.Value).Replace("|", "\|")
        [void]$builder.AppendLine("|$rawIndex|$rawFileName|$jsonPath|$($point.StartTimeNanos)|$($point.EndTimeNanos)|$rawValue|")
    }
}

Set-Content -LiteralPath $OutputMarkdown -Value $builder.ToString() -Encoding UTF8

[pscustomobject]@{
    InputJson = (Resolve-Path -LiteralPath $InputJson).Path
    OutputMarkdown = (Resolve-Path -LiteralPath $OutputMarkdown).Path
    TotalPoints = $points.Count
    UniquePoints = $uniqueKeys.Count
    DuplicatePoints = $points.Count - $uniqueKeys.Count
    RawPoints = $rawPoints.Count
    RawSources = $rawSources.Count
    RawDir = $RawDir
    DataTypes = $counts
}
