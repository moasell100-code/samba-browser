[CmdletBinding()]
param([switch]$ValidateOnly)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'profile-path.ps1')
$script:CardTaskName = 'JAJA-CardCollector-Startup'
$script:CardBootRestoreFailed = $false
$script:CardBootPolicyBlocked = $false

function Assert-CardInstallPolicy {
    # Only the new task process requests RemoteSigned. Domain/user policy remains
    # authoritative; this installer never changes machine or user execution policy.
    foreach ($scope in @('MachinePolicy', 'UserPolicy')) {
        if ([string](Get-ExecutionPolicy -Scope $scope) -in @('Restricted', 'AllSigned')) {
            $script:CardBootPolicyBlocked = $true
            throw 'Managed PowerShell execution policy does not allow this local unsigned collector script.'
        }
    }
}

function Get-CardBootProfilePath {
    return Get-JajaBrowserProfilePath
}

function Test-CardBrowserRunning {
    param([Parameter(Mandatory = $true)][string]$ElectronPath)
    $expected = [IO.Path]::GetFullPath($ElectronPath)
    # Inspect executable paths only; command lines can contain unrelated private data.
    $processes = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'electron.exe'" -Property ExecutablePath -ErrorAction Stop
    foreach ($process in $processes) {
        if ($process.ExecutablePath -and [IO.Path]::GetFullPath($process.ExecutablePath).Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Get-CardInstallIdentity {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return [pscustomobject]@{
        Name = $identity.Name
        Sid = $identity.User.Value
        Administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }
}

function Resolve-CardAccountSid {
    param([Parameter(Mandatory = $true)][string]$Account)
    if ($Account -match '^S-1-') { return (New-Object Security.Principal.SecurityIdentifier($Account)).Value }
    return (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier]).Value
}

function Get-CardBootInstallPlan {
    param([Parameter(Mandatory = $true)][string]$BrowserRoot)
    Assert-CardInstallPolicy
    $resolvedRoot = (Resolve-Path -LiteralPath $BrowserRoot).Path
    $launcher = Join-Path $resolvedRoot 'scripts/launch-card-collector.ps1'
    $entry = Join-Path $resolvedRoot 'out/main/index.js'
    $electron = Join-Path $resolvedRoot 'node_modules/electron/dist/electron.exe'
    foreach ($path in @($launcher, $entry, $electron)) {
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Built collector and launcher are required.' }
    }
    if (!(Select-String -LiteralPath $entry -SimpleMatch -Pattern '--card-collector-only' -Quiet)) {
        throw 'Build the browser with collector-only mode before registering startup.'
    }
    $identity = Get-CardInstallIdentity
    if (!(Test-Path -LiteralPath (Get-CardBootProfilePath) -PathType Container)) {
        throw 'The existing Windows user browser profile is required.'
    }
    $existing = Get-ScheduledTask -TaskName $script:CardTaskName -ErrorAction SilentlyContinue
    if ($existing) {
        if ((Resolve-CardAccountSid -Account $existing.Principal.UserId) -ne $identity.Sid) {
            throw 'Run setup as the Windows user who owns the existing card task.'
        }
        if ([string]$existing.Principal.LogonType -notin @('Interactive', 'Password')) {
            throw 'The existing card task has an unsupported logon type; it was not changed.'
        }
    }
    return [pscustomobject]@{
        Root = $resolvedRoot
        Launcher = $launcher
        Identity = $identity
        Existing = $existing
        BrowserRunning = Test-CardBrowserRunning -ElectronPath $electron
        PowerShell = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::System)) 'WindowsPowerShell/v1.0/powershell.exe'
    }
}

function Test-CardWindowsCredential {
    param([Parameter(Mandatory = $true)][pscredential]$Credential)
    if (-not ('JajaCardBoot.NativeLogon' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace JajaCardBoot {
    public static class NativeLogon {
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool LogonUser(string user, string domain, string password, int type, int provider, out IntPtr token);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CloseHandle(IntPtr handle);
    }
}
'@
    }
    $networkCredential = $Credential.GetNetworkCredential()
    $token = [IntPtr]::Zero
    try {
        # Validate the password without needing a pre-existing batch-logon right.
        # Task Scheduler validates the required execution context during registration.
        return [JajaCardBoot.NativeLogon]::LogonUser($networkCredential.UserName, $networkCredential.Domain, $networkCredential.Password, 2, 0, [ref]$token)
    } finally {
        if ($token -ne [IntPtr]::Zero) { $null = [JajaCardBoot.NativeLogon]::CloseHandle($token) }
        $networkCredential = $null
    }
}

function Invoke-CardBootInstall {
    param([Parameter(Mandatory = $true)][object]$Plan)
    if (!$Plan.Identity.Administrator) { throw 'Open this installer as administrator under the same Windows account.' }
    if ($Plan.BrowserRunning) { throw 'Close the existing JAJA browser before activating boot collection.' }
    $script:CardBootRestoreFailed = $false
    $credential = $null
    $password = $null
    $beforeXml = $null
    $registrationStarted = $false
    try {
        # Windows PowerShell 5.1 uses a local masked credential dialog. No input is
        # transmitted to the browser, chat, environment, command line, or a file.
        $credential = Get-Credential -UserName $Plan.Identity.Name -Message 'JAJA card collection at PC startup: enter this Windows account password (not the Windows Hello PIN). Windows Task Scheduler stores the credential. Cancel leaves startup unchanged.'
        if (!$credential) { return 'cancelled' }
        if ((Resolve-CardAccountSid -Account $credential.UserName) -ne $Plan.Identity.Sid) {
            throw 'Use the same Windows account as the existing JAJA browser.'
        }
        if ($credential.Password.Length -eq 0 -or !(Test-CardWindowsCredential -Credential $credential)) {
            throw 'Windows could not validate the account password. Startup was not changed.'
        }
        $action = New-ScheduledTaskAction -Execute $Plan.PowerShell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "' + $Plan.Launcher + '"') -WorkingDirectory $Plan.Root
        $boot = New-ScheduledTaskTrigger -AtStartup
        $boot.Delay = 'PT60S'
        $daily = New-ScheduledTaskTrigger -Daily -At ([DateTime]::Today.AddHours(9))
        $daily.StartBoundary = [DateTimeOffset]::Now.ToOffset([TimeSpan]::FromHours(9)).ToString('yyyy-MM-dd') + 'T09:00:00+09:00'
        $principal = New-ScheduledTaskPrincipal -UserId $Plan.Identity.Name -LogonType Password -RunLevel Limited
        # Retry only a failed process (for example boot connectivity before any login claim).
        # Completed issuer attempts requiring review exit successfully and remain protected.
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 40) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
        $definition = New-ScheduledTask -Action $action -Trigger @($boot, $daily) -Principal $principal -Settings $settings -Description 'Run the existing JAJA card collector after boot and daily at 09:00 KST, without an interactive Windows logon.'
        if (Test-CardBrowserRunning -ElectronPath (Join-Path $Plan.Root 'node_modules/electron/dist/electron.exe')) {
            throw 'The JAJA browser started during setup. Close it before activating boot collection.'
        }
        # Capture the old task only after all validation and preparation have succeeded.
        if ($Plan.Existing) { $beforeXml = Export-ScheduledTask -TaskName $script:CardTaskName }
        $password = $credential.GetNetworkCredential().Password
        $registrationStarted = $true
        $null = Register-ScheduledTask -TaskName $script:CardTaskName -InputObject $definition -User $Plan.Identity.Name -Password $password -Force
        $registered = Get-ScheduledTask -TaskName $script:CardTaskName -ErrorAction Stop
        if ([string]$registered.Principal.LogonType -ne 'Password' -or (Resolve-CardAccountSid -Account $registered.Principal.UserId) -ne $Plan.Identity.Sid) {
            throw 'The startup task did not retain the required user context.'
        }
        return 'installed'
    } catch {
        if ($registrationStarted) {
            try {
                if ($beforeXml) {
                    $rollback = @{ TaskName = $script:CardTaskName; Xml = $beforeXml; Force = $true; ErrorAction = 'Stop' }
                    if ([string]$Plan.Existing.Principal.LogonType -eq 'Password') {
                        $rollback.User = $Plan.Identity.Name
                        $rollback.Password = $password
                    }
                    $null = Register-ScheduledTask @rollback
                } elseif (!$Plan.Existing) {
                    $null = Unregister-ScheduledTask -TaskName $script:CardTaskName -Confirm:$false -ErrorAction SilentlyContinue
                }
            } catch {
                $script:CardBootRestoreFailed = $true
                throw 'Startup registration failed and its prior state could not be restored. Check this card task in Windows Task Scheduler.'
            }
        }
        # Do not print native errors or credential-bearing invocation details.
        throw 'Card startup was not changed. Verify the same Windows account, its password, and administrator access.'
    } finally {
        $password = $null
        if ($credential) { $credential.Password.Dispose() }
        $credential = $null
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $bootRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
        $bootPlan = Get-CardBootInstallPlan -BrowserRoot $bootRoot
        if ($ValidateOnly) {
            [pscustomobject]@{ Ready = !$bootPlan.BrowserRunning; Administrator = $bootPlan.Identity.Administrator; ExistingTask = [bool]$bootPlan.Existing; BrowserRunning = $bootPlan.BrowserRunning; PasswordInputRequired = $true }
        } else {
            $installResult = Invoke-CardBootInstall -Plan $bootPlan
            Write-Output ('JAJA card startup: ' + $installResult)
        }
    } catch {
        if ($script:CardBootPolicyBlocked) {
            [Console]::Error.WriteLine('JAJA card startup is blocked by managed PowerShell execution policy. No policy or startup settings were changed.')
        } elseif ($script:CardBootRestoreFailed) {
            [Console]::Error.WriteLine('JAJA card startup registration and restoration failed. Check JAJA-CardCollector-Startup in Windows Task Scheduler.')
        } else {
            [Console]::Error.WriteLine('JAJA card startup was not installed. Existing settings were preserved.')
        }
        exit 1
    }
}
