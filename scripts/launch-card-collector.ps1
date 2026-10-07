[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'profile-path.ps1')

function Get-CardCollectorProfilePath {
    return Get-JajaBrowserProfilePath
}

function New-CardCollectorStartInfo {
    param([Parameter(Mandatory = $true)][string]$BrowserRoot)
    $resolvedRoot = (Resolve-Path -LiteralPath $BrowserRoot).Path
    $electronPath = Join-Path $resolvedRoot 'node_modules/electron/dist/electron.exe'
    $entryPath = Join-Path $resolvedRoot 'out/main/index.js'
    if (!(Test-Path -LiteralPath $electronPath -PathType Leaf) -or !(Test-Path -LiteralPath $entryPath -PathType Leaf)) {
        throw 'Built JAJA browser is required.'
    }
    $profilePath = Get-CardCollectorProfilePath
    # A wrong Windows identity must not silently create a fresh, empty card profile.
    if (!(Test-Path -LiteralPath $profilePath -PathType Container)) {
        throw 'The existing JAJA browser profile is required.'
    }
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $electronPath
    $startInfo.WorkingDirectory = $resolvedRoot
    $startInfo.Arguments = '"' + $resolvedRoot + '" --card-collector-only'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    # Scheduled collection never inherits development, login-harness, or MCP capabilities.
    foreach ($name in @($startInfo.EnvironmentVariables.Keys)) {
        if ($name -match '^(SAMBA_|JAJA_|FINANCE_|ELECTRON_)' -or $name -in @('NODE_OPTIONS', 'NODE_PATH', 'VITEST', 'VAULT_KDF_MEM')) {
            $startInfo.EnvironmentVariables.Remove($name)
        }
    }
    $startInfo.EnvironmentVariables['SAMBA_USER_DATA'] = $profilePath
    return $startInfo
}

function Invoke-CardCollectorLauncher {
    param([Parameter(Mandatory = $true)][string]$BrowserRoot)
    $startInfo = New-CardCollectorStartInfo -BrowserRoot $BrowserRoot
    $collector = New-Object System.Diagnostics.Process
    $collector.StartInfo = $startInfo
    try {
        if (!$collector.Start()) { throw 'The card collector could not start.' }
        # Drain both pipes without storing or logging their contents. Broad browser output
        # may contain private data; the collector writes its own bounded status receipt.
        $stdoutDrain = $collector.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
        $stderrDrain = $collector.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
        $collector.WaitForExit()
        $stdoutDrain.GetAwaiter().GetResult()
        $stderrDrain.GetAwaiter().GetResult()
        return $collector.ExitCode
    } finally {
        $collector.Dispose()
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $collectorRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
        exit (Invoke-CardCollectorLauncher -BrowserRoot $collectorRoot)
    } catch {
        [Console]::Error.WriteLine('JAJA card collector could not run. Check the local collection status.')
        exit 1
    }
}
