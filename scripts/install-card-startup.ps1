[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$cardBrowserRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$cardLauncher = Join-Path $cardBrowserRoot 'scripts/launch-local.ps1'
$cardEntry = Join-Path $cardBrowserRoot 'out/main/index.js'
if (!(Test-Path -LiteralPath $cardLauncher -PathType Leaf) -or !(Test-Path -LiteralPath $cardEntry -PathType Leaf)) {
    throw 'Built JAJA browser and launcher are required.'
}
$cardUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$cardAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
    '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $cardLauncher + '"'
) -WorkingDirectory $cardBrowserRoot
$cardTrigger = New-ScheduledTaskTrigger -AtLogOn -User $cardUser
$cardTrigger.Delay = 'PT30S'
$cardPrincipal = New-ScheduledTaskPrincipal -UserId $cardUser -LogonType Interactive -RunLevel Limited
$cardTaskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$null = Register-ScheduledTask -TaskName 'JAJA-CardCollector-Startup' -Action $cardAction `
    -Trigger $cardTrigger -Principal $cardPrincipal -Settings $cardTaskSettings `
    -Description 'Start the existing JAJA browser profile at user logon; card scheduling uses local app settings.' -Force
Write-Output 'JAJA card browser startup registered.'
