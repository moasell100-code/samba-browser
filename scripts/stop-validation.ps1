$ErrorActionPreference = 'Stop'
$validationLab = Join-Path $env:LOCALAPPDATA 'JAJA-Browser-Validation-Lab'
$validationManifest = Join-Path $validationLab 'services.json'
$validationSkipped = @()
function ConvertTo-ValidationArgument([string]$Argument) {
  if ($Argument -ne '' -and $Argument -notmatch '[\s"]') { return $Argument }
  $quoted = [regex]::Replace($Argument, '(\\*)"', { param($match) $match.Groups[1].Value + $match.Groups[1].Value + '\"' })
  $quoted = [regex]::Replace($quoted, '(\\+)$', { param($match) $match.Value + $match.Value })
  return '"' + $quoted + '"'
}
function Test-ValidationProcess($Entry, $Process) {
  if (-not $Process -or $Process.ProcessId -ne $Entry.pid -or $Process.ExecutablePath -ne $Entry.command) { return $false }
  $expectedLine = (@($Entry.command) + @($Entry.arguments) | ForEach-Object { ConvertTo-ValidationArgument ([string]$_) }) -join ' '
  if ($Process.CommandLine -cne $expectedLine) { return $false }
  $createdAt = $Process.CreationDate.ToUniversalTime().ToString('o')
  if ($Entry.createdAt -or $Entry.commandLine) {
    $recordedCreation = $Entry.createdAt
    if ($recordedCreation -is [DateTime]) { $recordedCreation = $recordedCreation.ToUniversalTime().ToString('o') }
    if ($recordedCreation -is [DateTimeOffset]) { $recordedCreation = $recordedCreation.UtcDateTime.ToString('o') }
    return $recordedCreation -ceq $createdAt -and $Entry.commandLine -ceq $Process.CommandLine
  }
  $startedAt = [DateTimeOffset]::MinValue
  if ($Entry.startedAt -is [DateTime] -or $Entry.startedAt -is [DateTimeOffset]) {
    $startedAt = [DateTimeOffset]$Entry.startedAt
  } elseif (-not [DateTimeOffset]::TryParse($Entry.startedAt, [ref]$startedAt)) { return $false }
  if ([Math]::Abs((([DateTimeOffset]$Process.CreationDate).ToUniversalTime() - $startedAt.ToUniversalTime()).TotalMilliseconds) -gt 2000) { return $false }
  $Entry | Add-Member -NotePropertyName createdAt -NotePropertyValue $createdAt -Force
  $Entry | Add-Member -NotePropertyName commandLine -NotePropertyValue $Process.CommandLine -Force
  return $true
}
if (Test-Path -LiteralPath $validationManifest) {
  $services = Get-Content -LiteralPath $validationManifest -Raw | ConvertFrom-Json
  if ($services.environment -ne 'jaja-browser-validation') { throw 'Unexpected validation service manifest.' }
  foreach ($name in @('browser', 'frontend', 'backend')) {
    $entry = $services.$name
    if (-not $entry) { continue }
    $ownedProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$entry.pid)
    if (-not $ownedProcess) { continue }
    if (-not (Test-ValidationProcess $entry $ownedProcess)) {
      Write-Warning ('Skipping stale or unowned validation process: ' + $name)
      $validationSkipped += $name
      continue
    }
    # Keep a handle to this process instance so PID reuse cannot retarget the stop.
    try {
      $targetProcess = Get-Process -Id $ownedProcess.ProcessId -ErrorAction Stop
      $null = $targetProcess.Handle
      if ([Math]::Abs(($targetProcess.StartTime.ToUniversalTime() - $ownedProcess.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1) {
        Write-Warning ('Process changed before stopping: ' + $name)
        $validationSkipped += $name
        continue
      }
      $targetProcess.Kill()
    } catch {
      Write-Warning ('Could not stop confirmed validation process: ' + $name)
      $validationSkipped += $name
    }
  }
}
& (Join-Path $PSScriptRoot 'validation-postgres.ps1') -Action stop
if ($LASTEXITCODE -ne 0) { throw 'Validation PostgreSQL stop failed.' }
if ($validationSkipped.Count) {
  Write-Warning ('Validation shutdown incomplete. Skipped or failed: ' + ($validationSkipped -join ', '))
} else {
  Write-Output 'Validation services stopped. Existing automatic ordering was not targeted.'
}
