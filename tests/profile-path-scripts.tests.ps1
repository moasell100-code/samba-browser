# Run with Windows PowerShell or pwsh. All process and filesystem writes are mocked.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptsRoot = Join-Path $repoRoot 'scripts'
foreach ($name in @('profile-path.ps1', 'launch-local.ps1', 'launch-dev.ps1', 'launch-card-collector.ps1', 'install-card-boot.ps1')) {
    $tokens = $null
    $parseErrors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $scriptsRoot $name), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw "PowerShell parsing failed: $name" }
}
. (Join-Path $scriptsRoot 'profile-path.ps1')
. (Join-Path $scriptsRoot 'launch-card-collector.ps1')
. (Join-Path $scriptsRoot 'install-card-boot.ps1')

function Assert-ProfileTest {
    param([bool]$Condition, [string]$Message)
    if (!$Condition) { throw $Message }
}

# Execute the real normal/dev launchers, but never open an app or create/remove a file.
$profileTestLaunches = New-Object Collections.Generic.List[object]
$profileTestDirectories = New-Object Collections.Generic.List[string]
function Start-Process {
    param($FilePath, $ArgumentList, $WindowStyle, $WorkingDirectory, $RedirectStandardOutput, $RedirectStandardError)
    $profileTestLaunches.Add([pscustomobject]@{ Profile = $env:SAMBA_USER_DATA; Validation = $env:JAJA_VALIDATION })
}
function Test-Path { param($LiteralPath, $PathType) return $true }
function New-Item { param($ItemType, $Path, [switch]$Force) $profileTestDirectories.Add($Path) }
function Get-ChildItem { [CmdletBinding()]param($Path, $Filter) }
function Remove-Item {
    [CmdletBinding()]param([Parameter(ValueFromPipeline = $true)]$InputObject, [switch]$Force)
    process { if ($null -ne $InputObject) { throw 'The profile tests must not delete files.' } }
}

$originalEnvironment = @{}
foreach ($name in @('USERPROFILE', 'LOCALAPPDATA', 'SAMBA_USER_DATA', 'JAJA_VALIDATION', 'TEMP')) {
    $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    $env:USERPROFILE = 'C:\Users\Synthetic User'
    $env:TEMP = 'C:\SyntheticTemp'
    $expected = 'C:\Users\Synthetic User\.jaja-browser'
    Assert-ProfileTest ((Get-JajaBrowserProfilePath -UserProfile 'D:/Users/Test/') -eq 'D:\Users\Test\.jaja-browser') 'Drive path was not normalized.'
    Assert-ProfileTest ((Get-JajaBrowserProfilePath -UserProfile '\\server\homes\Test') -eq '\\server\homes\Test\.jaja-browser') 'UNC home was not preserved.'
    foreach ($invalidHome in @($null, '', '  ', 'relative', 'C:relative', '\Users\Test', '/Users/Test', '\\server')) {
        $failed = $false
        try { $null = Get-JajaBrowserProfilePath -UserProfile $invalidHome } catch { $failed = $true }
        Assert-ProfileTest $failed 'An invalid home silently selected a profile.'
    }
    foreach ($localAppData in @($null, 'C:\Users\Synthetic User\AppData\Local', 'C:\Users\Synthetic User\AppData\Local\Packages\Sandbox\LocalCache\Local')) {
        $env:LOCALAPPDATA = $localAppData
        $env:SAMBA_USER_DATA = 'D:\ignored-collector-override'
        $env:JAJA_VALIDATION = '1'
        Assert-ProfileTest ((Get-CardCollectorProfilePath) -eq $expected) 'Collector used a different profile.'
        Assert-ProfileTest ((Get-CardBootProfilePath) -eq $expected) 'Installer used a different profile.'
        foreach ($launcher in @('launch-local.ps1', 'launch-dev.ps1')) {
            foreach ($mode in @('normal', 'override', 'validation', 'validation-override')) {
                $isOverride = $mode -match 'override'
                $isValidation = $mode -match 'validation'
                $env:USERPROFILE = if ($mode -eq 'normal') { 'C:\Users\Synthetic User' } else { $null }
                $env:SAMBA_USER_DATA = if ($isOverride) { 'D:\explicit-profile' } else { $null }
                $env:JAJA_VALIDATION = if ($isValidation) { '1' } else { $null }
                $before = $profileTestLaunches.Count
                $directoriesBefore = $profileTestDirectories.Count
                & (Join-Path $scriptsRoot $launcher)
                $modeExpected = if ($isOverride) { 'D:\explicit-profile' } elseif ($isValidation) { $null } else { $expected }
                Assert-ProfileTest ($profileTestLaunches.Count -eq ($before + 1)) 'Launcher did not reach the mocked process start.'
                Assert-ProfileTest ($profileTestLaunches[$before].Profile -eq $modeExpected) "Profile selection failed: $launcher / $mode"
                if ($mode -eq 'validation') {
                    Assert-ProfileTest ($profileTestDirectories.Count -eq $directoriesBefore) 'Validation created a normal profile directory.'
                }
            }
            $env:USERPROFILE = $null
            $env:SAMBA_USER_DATA = $null
            $env:JAJA_VALIDATION = $null
            $before = $profileTestLaunches.Count
            $failed = $false
            try { & (Join-Path $scriptsRoot $launcher) } catch { $failed = $true }
            Assert-ProfileTest ($failed -and $profileTestLaunches.Count -eq $before) 'Missing home launched an empty profile.'
        }
        $env:USERPROFILE = 'C:\Users\Synthetic User'
    }
    Write-Output 'PASS: canonical profile and all four launch paths; overrides, validation, AppData isolation, and fail-closed home checks.'
} finally {
    foreach ($name in $originalEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process')
    }
}
