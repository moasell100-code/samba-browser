# Run with Windows PowerShell or pwsh. No task, password prompt, or browser is opened.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptPaths = @('launch-card-collector.ps1', 'install-card-boot.ps1') | ForEach-Object { Join-Path $repoRoot ('scripts/' + $_) }
foreach ($path in $scriptPaths) {
    $tokens = $null
    $parseErrors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -ne 0) { throw 'A card startup script failed PowerShell parsing.' }
    . $path
}

function Assert-CardTest {
    param([bool]$Condition, [string]$Message)
    if (!$Condition) { throw $Message }
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('jaja-card-boot-script-test-' + [Guid]::NewGuid().ToString('N'))
$script:fixtureRoot = $testRoot
$script:fixtureProfile = Join-Path $testRoot 'profile'
$script:originalTask = [pscustomobject]@{ Principal = [pscustomobject]@{ UserId = 'TEST\Owner'; LogonType = 'Interactive' } }
$script:taskState = $script:originalTask
$script:registerCalls = New-Object Collections.Generic.List[object]
$script:credentialMode = 'valid'
$script:passwordValid = $true
$script:failRegistration = $false
$script:credentialChecks = 0
$script:promptCalls = 0
$script:managedPolicy = 'Undefined'

# Every privileged API is replaced before any installer function is invoked.
function Get-CardInstallIdentity { return [pscustomobject]@{ Name = 'TEST\Owner'; Sid = 'S-1-5-21-100'; Administrator = $true } }
function Get-ExecutionPolicy { param([string]$Scope) return $script:managedPolicy }
function Test-CardBrowserRunning { param([string]$ElectronPath) return $false }
function Get-CardBootProfilePath { return $script:fixtureProfile }
function Get-CardCollectorProfilePath { return $script:fixtureProfile }
function Resolve-CardAccountSid {
    param([string]$Account)
    if ($Account -eq 'TEST\Owner') { return 'S-1-5-21-100' }
    return 'S-1-5-21-200'
}
function Get-ScheduledTask {
    [CmdletBinding()]param([string]$TaskName)
    Assert-CardTest ($TaskName -eq 'JAJA-CardCollector-Startup') 'Unexpected task was accessed.'
    return $script:taskState
}
function Export-ScheduledTask { param([string]$TaskName) return 'synthetic-original-task' }
function Get-Credential {
    param([string]$UserName, [string]$Message)
    $script:promptCalls++
    if ($script:credentialMode -eq 'cancel') { return $null }
    $account = if ($script:credentialMode -eq 'other') { 'TEST\Other' } else { 'TEST\Owner' }
    $secure = ConvertTo-SecureString 'synthetic-test-password' -AsPlainText -Force
    return New-Object Management.Automation.PSCredential($account, $secure)
}
function Test-CardWindowsCredential { param([pscredential]$Credential) $script:credentialChecks++; return $script:passwordValid }
function New-ScheduledTaskAction {
    param([string]$Execute, [string]$Argument, [string]$WorkingDirectory)
    return [pscustomobject]@{ Execute = $Execute; Argument = $Argument; WorkingDirectory = $WorkingDirectory }
}
function New-ScheduledTaskTrigger {
    param([switch]$AtStartup, [switch]$Daily, [DateTime]$At)
    return [pscustomobject]@{ Boot = [bool]$AtStartup; Daily = [bool]$Daily; Delay = ''; StartBoundary = '' }
}
function New-ScheduledTaskPrincipal {
    param([string]$UserId, [string]$LogonType, [string]$RunLevel)
    return [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel }
}
function New-ScheduledTaskSettingsSet {
    param([switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, [string]$MultipleInstances, [TimeSpan]$ExecutionTimeLimit, [int]$RestartCount, [TimeSpan]$RestartInterval)
    return [pscustomobject]@{ StartWhenAvailable = [bool]$StartWhenAvailable; MultipleInstances = $MultipleInstances; ExecutionTimeLimit = $ExecutionTimeLimit; RestartCount = $RestartCount; RestartInterval = $RestartInterval }
}
function New-ScheduledTask {
    param($Action, $Trigger, $Principal, $Settings, [string]$Description)
    return [pscustomobject]@{ Action = $Action; Trigger = $Trigger; Principal = $Principal; Settings = $Settings }
}
function Register-ScheduledTask {
    [CmdletBinding()]param([string]$TaskName, $InputObject, [string]$User, [string]$Password, [string]$Xml, [switch]$Force)
    if ($Xml) {
        Assert-CardTest ($Xml -eq 'synthetic-original-task') 'Rollback used the wrong task definition.'
        $script:registerCalls.Add([pscustomobject]@{ Kind = 'rollback' })
        $script:taskState = $script:originalTask
        return
    }
    Assert-CardTest ($Password -eq 'synthetic-test-password') 'Password was not passed directly in memory.'
    $script:registerCalls.Add([pscustomobject]@{ Kind = 'install'; Definition = $InputObject })
    $script:taskState = $InputObject
    if ($script:failRegistration) { throw 'Synthetic registration failure after a partial change.' }
}
function Unregister-ScheduledTask { param($TaskName, $Confirm, $ErrorAction) throw 'Existing task must be restored, never deleted.' }

function Assert-InstallFailsWithoutChange {
    param($Plan)
    $before = $script:registerCalls.Count
    $failed = $false
    try { $null = Invoke-CardBootInstall -Plan $Plan } catch { $failed = $true }
    Assert-CardTest $failed 'Invalid setup unexpectedly succeeded.'
    Assert-CardTest ($script:registerCalls.Count -eq $before) 'Invalid setup mutated a task.'
    Assert-CardTest ($script:taskState -eq $script:originalTask) 'Original task was lost.'
}

try {
    foreach ($directory in @('scripts', 'out/main', 'node_modules/electron/dist', 'profile')) {
        $null = New-Item -Path (Join-Path $testRoot $directory) -ItemType Directory -Force
    }
    Set-Content -LiteralPath (Join-Path $testRoot 'scripts/launch-card-collector.ps1') -Value '# synthetic launcher'
    Set-Content -LiteralPath (Join-Path $testRoot 'out/main/index.js') -Value '// --card-collector-only'
    Set-Content -LiteralPath (Join-Path $testRoot 'node_modules/electron/dist/electron.exe') -Value 'synthetic file; never executed'

    $plan = Get-CardBootInstallPlan -BrowserRoot $testRoot
    Assert-CardTest ($script:promptCalls -eq 0 -and $script:registerCalls.Count -eq 0) 'Read-only preflight prompted or wrote a task.'
    foreach ($policy in @('Restricted', 'AllSigned')) {
        $script:managedPolicy = $policy
        $failed = $false
        try { $null = Get-CardBootInstallPlan -BrowserRoot $testRoot } catch { $failed = $true }
        Assert-CardTest ($failed -and $script:CardBootPolicyBlocked -and $script:promptCalls -eq 0) 'Managed policy was bypassed.'
    }
    $script:managedPolicy = 'Undefined'
    $script:CardBootPolicyBlocked = $false
    $script:credentialMode = 'cancel'
    Assert-CardTest ((Invoke-CardBootInstall -Plan $plan) -eq 'cancelled') 'Cancel was not respected.'
    Assert-CardTest ($script:registerCalls.Count -eq 0) 'Cancel changed the task.'
    $script:credentialMode = 'other'
    Assert-InstallFailsWithoutChange -Plan $plan
    Assert-CardTest ($script:credentialChecks -eq 0) 'Another account password was validated.'
    $script:credentialMode = 'valid'
    $script:passwordValid = $false
    Assert-InstallFailsWithoutChange -Plan $plan
    $script:passwordValid = $true
    $plan.BrowserRunning = $true
    $promptsBefore = $script:promptCalls
    Assert-InstallFailsWithoutChange -Plan $plan
    Assert-CardTest ($script:promptCalls -eq $promptsBefore) 'A running legacy browser did not block credential entry.'
    $plan.BrowserRunning = $false
    $plan.Identity.Administrator = $false
    $promptsBefore = $script:promptCalls
    Assert-InstallFailsWithoutChange -Plan $plan
    Assert-CardTest ($script:promptCalls -eq $promptsBefore) 'Nonadministrator setup prompted for a password.'
    $plan.Identity.Administrator = $true

    $script:failRegistration = $true
    $failed = $false
    try { $null = Invoke-CardBootInstall -Plan $plan } catch { $failed = $true }
    Assert-CardTest ($failed -and $script:taskState -eq $script:originalTask) 'Failed registration did not restore the original task.'
    Assert-CardTest ($script:registerCalls[$script:registerCalls.Count - 1].Kind -eq 'rollback') 'Rollback was not attempted.'
    $script:failRegistration = $false
    Assert-CardTest ((Invoke-CardBootInstall -Plan $plan) -eq 'installed') 'Valid installation did not finish.'
    $installed = $script:taskState
    Assert-CardTest ($installed.Principal.LogonType -eq 'Password' -and $installed.Principal.RunLevel -eq 'Limited') 'Task security context is wrong.'
    Assert-CardTest ($installed.Trigger.Count -eq 2 -and $installed.Trigger[0].Boot -and $installed.Trigger[0].Delay -eq 'PT60S') 'Boot trigger is incorrect.'
    Assert-CardTest ($installed.Trigger[1].Daily -and $installed.Trigger[1].StartBoundary.EndsWith('T09:00:00+09:00')) 'Daily trigger must use 09:00 KST.'
    Assert-CardTest ($installed.Settings.StartWhenAvailable -and $installed.Settings.MultipleInstances -eq 'IgnoreNew' -and $installed.Settings.ExecutionTimeLimit.TotalMinutes -eq 40) 'Task limits are incorrect.'
    Assert-CardTest ($installed.Settings.RestartCount -eq 3 -and $installed.Settings.RestartInterval.TotalMinutes -eq 5) 'Failed processes need bounded startup retries.'
    Assert-CardTest ($installed.Action.Argument -eq ('-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "' + $plan.Launcher + '"')) 'Launcher arguments are not fixed.'
    foreach ($scriptPath in $scriptPaths) {
        $source = Get-Content -LiteralPath $scriptPath -Raw
        Assert-CardTest ($source -notmatch '(?im)^\s*Set-ExecutionPolicy\b|ExecutionPolicy\s+(Bypass|Unrestricted)') 'A script weakens persistent or process execution policy.'
    }

    $poisonNames = @('SAMBA_CARD_MCP_SESSION', 'SAMBA_E2E_LOGIN', 'JAJA_VALIDATION', 'FINANCE_BROWSER_IMPORT_TOKEN_FILE', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'VITEST', 'VAULT_KDF_MEM')
    $savedEnvironment = @{}
    foreach ($name in $poisonNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name); [Environment]::SetEnvironmentVariable($name, 'synthetic-unwanted-value') }
    try {
        $startInfo = New-CardCollectorStartInfo -BrowserRoot $testRoot
        foreach ($name in $poisonNames) { Assert-CardTest (!$startInfo.EnvironmentVariables.ContainsKey($name)) 'A development capability reached the collector.' }
        Assert-CardTest ($startInfo.EnvironmentVariables['SAMBA_USER_DATA'] -eq $script:fixtureProfile) 'Profile was not fixed.'
        Assert-CardTest ($startInfo.Arguments -eq ('"' + $testRoot + '" --card-collector-only')) 'Collector-only argument is missing.'
        Assert-CardTest (!$startInfo.UseShellExecute -and $startInfo.CreateNoWindow -and $startInfo.RedirectStandardError -and $startInfo.RedirectStandardOutput) 'Collector launch exposes a shell or output.'
    } finally {
        foreach ($name in $poisonNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]) }
    }
    Write-Output 'PASS: parser, preflight, cancel, wrong user/password, privilege check, rollback, boot/daily settings, and isolated collector environment.'
} finally {
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolvedTestRoot.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedTestRoot).StartsWith('jaja-card-boot-script-test-')) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
