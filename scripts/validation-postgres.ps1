param(
  [ValidateSet('setup', 'start', 'status', 'stop')]
  [string]$Action = 'start'
)

$ErrorActionPreference = 'Stop'
$labRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'JAJA-Browser-Validation-Lab'))
$markerPath = Join-Path $labRoot 'lab-marker.json'
$connectionPath = Join-Path $labRoot 'connection.json'
$runtimeRoot = Join-Path $labRoot 'runtime'
$dataRoot = Join-Path $labRoot 'postgres-data'
$downloadRoot = Join-Path $labRoot 'downloads'
$logRoot = Join-Path $labRoot 'logs'
$binaryUrl = 'https://get.enterprisedb.com/postgresql/postgresql-16.15-4-windows-x64-binaries.zip'
$expectedArchiveHash = 'f5f55b03bd54ce0dd1c51d524b54c7e015abd4d620af27d6971288a2dbe4a8f8'
$archivePath = Join-Path $downloadRoot 'postgresql-16.15-4-windows-x64-binaries.zip'
$provenancePath = Join-Path $labRoot 'postgres-provenance.json'
$identity = 'jaja-browser-validation-lab-v1'
$utf8 = New-Object Text.UTF8Encoding($false)

function Write-JsonFile([string]$Path, $Value) {
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 8), $utf8)
}

function Protect-PrivateConfig {
  $permissions = New-Object Security.AccessControl.FileSecurity
  $permissions.SetAccessRuleProtection($true, $false)
  $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $permissions.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($userSid, 'FullControl', 'Allow')))
  $permissions.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($systemSid, 'FullControl', 'Allow')))
  Set-Acl -LiteralPath $connectionPath -AclObject $permissions
}

function Assert-LabPath([string]$Path) {
  $resolved = [IO.Path]::GetFullPath($Path)
  if ($resolved -ne $labRoot -and -not $resolved.StartsWith($labRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing a path outside the isolated validation lab.'
  }
}

function Get-LabConfig {
  if (-not (Test-Path -LiteralPath $connectionPath)) { throw 'Run setup first.' }
  $config = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
  if ($config.marker -ne $identity -or $config.host -ne '127.0.0.1' -or $config.port -ne 15432 -or $config.database -ne 'jaja_browser_validation' -or $config.username -ne 'jaja_validation') {
    throw 'Invalid isolated PostgreSQL configuration.'
  }
  Assert-LabPath $config.binPath
  Assert-LabPath $config.dataPath
  if ($config.binPath -ne (Join-Path $runtimeRoot 'pgsql\bin')) { throw 'Unexpected PostgreSQL binary directory.' }
  if ($config.dataPath -ne $dataRoot) { throw 'Unexpected database directory.' }
  return $config
}

function Invoke-PgTool([string]$Name, [string[]]$PgArguments, [string]$LogName) {
  $toolPath = Join-Path $script:binPath $Name
  $arguments = ($PgArguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
  $result = Start-Process -FilePath $toolPath -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot ($LogName + '.out.log')) -RedirectStandardError (Join-Path $logRoot ($LogName + '.err.log'))
  $null = $result.Handle
  # Wait for pg_ctl itself, not its deliberately long-running server child.
  $result.WaitForExit()
  return $result.ExitCode
}

function Assert-DatabasePortAvailable {
  $listeners = @(Get-NetTCPConnection -LocalPort 15432 -State Listen -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) { throw 'Port 15432 is already occupied; no existing process was stopped.' }
}

function Assert-OwnedPostmaster {
  $pidFile = Join-Path $dataRoot 'postmaster.pid'
  if (-not (Test-Path -LiteralPath $pidFile)) { return $false }
  $lines = [IO.File]::ReadAllLines($pidFile)
  if ($lines.Length -lt 4 -or [IO.Path]::GetFullPath($lines[1]) -ne $dataRoot -or $lines[3] -ne '15432') {
    throw 'Unexpected PostgreSQL process metadata; refusing to control it.'
  }
  $processId = [int]$lines[0]
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
  if (-not $process) { return $false }
  if ($process.ExecutablePath -ne (Join-Path $script:binPath 'postgres.exe')) {
    throw 'PostgreSQL PID does not belong to the validation runtime.'
  }
  return $true
}

if (Test-Path -LiteralPath $labRoot) {
  if (-not (Test-Path -LiteralPath $markerPath)) { throw 'Existing lab directory has no ownership marker; refusing reuse.' }
  $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
  if ($marker.marker -ne $identity) { throw 'Existing lab directory has an unknown ownership marker.' }
} elseif ($Action -eq 'setup') {
  Assert-DatabasePortAvailable
  New-Item -ItemType Directory -Path $labRoot | Out-Null
  Write-JsonFile $markerPath @{ marker = $identity; createdAt = [DateTime]::UtcNow.ToString('o') }
} else {
  throw 'The isolated validation lab has not been set up.'
}

foreach ($path in @($runtimeRoot, $downloadRoot, $logRoot)) {
  Assert-LabPath $path
  New-Item -ItemType Directory -Path $path -Force | Out-Null
}
$script:binPath = Join-Path $runtimeRoot 'pgsql\bin'

if ($Action -eq 'setup') {
  if (-not (Test-Path -LiteralPath $archivePath)) {
    Write-Host 'Downloading the official PostgreSQL portable archive...'
    $partialPath = $archivePath + '.partial'
    & curl.exe --fail --location --proto '=https' --tlsv1.2 --silent --show-error --output $partialPath $binaryUrl
    if ($LASTEXITCODE -ne 0) { throw 'Official PostgreSQL download failed.' }
    Move-Item -LiteralPath $partialPath -Destination $archivePath
  }
  $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($archiveHash -ne $expectedArchiveHash) { throw 'The PostgreSQL archive does not match the verified official download.' }
  if (-not (Test-Path -LiteralPath (Join-Path $script:binPath 'postgres.exe')) -or -not (Test-Path -LiteralPath $provenancePath)) {
    if (Test-Path -LiteralPath (Join-Path $dataRoot 'postmaster.pid')) { throw 'Refusing to replace binaries while PostgreSQL may be running.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
      foreach ($entry in $archive.Entries) {
        if ($entry.FullName -notmatch '^pgsql/(bin|lib|share)/') { continue }
        $target = Join-Path $runtimeRoot $entry.FullName.Replace('/', '\')
        Assert-LabPath $target
        if (-not [IO.Path]::GetFullPath($target).StartsWith($runtimeRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive entry.' }
        if ($entry.FullName.EndsWith('/')) {
          [void][IO.Directory]::CreateDirectory($target)
        } else {
          [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
          [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        }
      }
    } finally { $archive.Dispose() }
  }
  $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $script:binPath 'postgres.exe')
  Write-JsonFile $provenancePath @{
    marker = $identity; url = $binaryUrl; sha256 = $archiveHash
    signatureStatus = $signature.Status.ToString(); acquiredAt = [DateTime]::UtcNow.ToString('o')
  }
  if (-not (Test-Path -LiteralPath $connectionPath)) {
    if (Test-Path -LiteralPath $dataRoot) { throw 'Database directory exists without a connection marker; refusing reinitialization.' }
    Assert-DatabasePortAvailable
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 32
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    $password = ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    $config = @{
      marker = $identity; host = '127.0.0.1'; port = 15432; database = 'jaja_browser_validation'
      username = 'jaja_validation'; password = $password; binPath = $script:binPath; dataPath = $dataRoot
      databaseUrl = "postgresql+asyncpg://jaja_validation:${password}@127.0.0.1:15432/jaja_browser_validation"
    }
    Write-JsonFile $connectionPath $config
    Protect-PrivateConfig
  }
  $config = Get-LabConfig
  Protect-PrivateConfig
  if (-not (Test-Path -LiteralPath (Join-Path $dataRoot 'PG_VERSION'))) {
    $passwordPath = Join-Path $labRoot 'initdb-password.tmp'
    [IO.File]::WriteAllText($passwordPath, $config.password, $utf8)
    try {
      $exitCode = Invoke-PgTool 'initdb.exe' @('-D', $dataRoot, '-U', 'jaja_validation', '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--encoding=UTF8', '--locale=C', ('--pwfile=' + $passwordPath)) 'initdb'
      if ($exitCode -ne 0) { throw 'Isolated initdb failed; inspect lab logs.' }
    } finally {
      Assert-LabPath $passwordPath
      Remove-Item -LiteralPath $passwordPath -Force
    }
    $settings = "`n# Isolated JAJA browser validation only.`nlisten_addresses = '127.0.0.1'`nport = 15432`nmax_connections = 30`nshared_buffers = '64MB'`n"
    [IO.File]::AppendAllText((Join-Path $dataRoot 'postgresql.conf'), $settings, $utf8)
  }
}

$config = Get-LabConfig
$script:binPath = $config.binPath
$ownedRunning = Assert-OwnedPostmaster
if ($Action -eq 'status') {
  Write-Output (@{ running = $ownedRunning; host = '127.0.0.1'; port = 15432; database = $config.database; configPath = $connectionPath } | ConvertTo-Json -Compress)
  exit 0
}
if ($Action -eq 'stop') {
  if ($ownedRunning) {
    $exitCode = Invoke-PgTool 'pg_ctl.exe' @('-D', $dataRoot, '-m', 'fast', '-w', 'stop') 'stop'
    if ($exitCode -ne 0) { throw 'Isolated PostgreSQL stop failed.' }
  }
  Write-Host 'Validation PostgreSQL stopped.'
  exit 0
}
if (-not $ownedRunning) {
  Assert-DatabasePortAvailable
  $exitCode = Invoke-PgTool 'pg_ctl.exe' @('-D', $dataRoot, '-l', (Join-Path $logRoot 'postgres.log'), '-w', 'start') 'start'
  if ($exitCode -ne 0) { throw 'Isolated PostgreSQL start failed; inspect lab logs.' }
}

$previousPassword = [Environment]::GetEnvironmentVariable('PGPASSWORD', 'Process')
try {
  [Environment]::SetEnvironmentVariable('PGPASSWORD', $config.password, 'Process')
  $exitCode = Invoke-PgTool 'psql.exe' @('-h', '127.0.0.1', '-p', '15432', '-U', 'jaja_validation', '-d', 'postgres', '-tAc', "SELECT 1 FROM pg_database WHERE datname='jaja_browser_validation'") 'database-exists'
  if ($exitCode -ne 0) { throw 'Cannot authenticate to isolated PostgreSQL.' }
  $exists = [IO.File]::ReadAllText((Join-Path $logRoot 'database-exists.out.log')).Trim()
  if ($exists -ne '1') {
    $exitCode = Invoke-PgTool 'createdb.exe' @('-h', '127.0.0.1', '-p', '15432', '-U', 'jaja_validation', '--owner=jaja_validation', 'jaja_browser_validation') 'createdb'
    if ($exitCode -ne 0) { throw 'Could not create isolated validation database.' }
  }
} finally {
  [Environment]::SetEnvironmentVariable('PGPASSWORD', $previousPassword, 'Process')
}
Write-Output (@{ running = $true; host = '127.0.0.1'; port = 15432; database = 'jaja_browser_validation'; configPath = $connectionPath } | ConvertTo-Json -Compress)
