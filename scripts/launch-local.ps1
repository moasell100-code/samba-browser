# 빌드된 자자 브라우저를 독립 프로필로 실행한다. 개발 서버는 필요하지 않다.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'profile-path.ps1')
$browserRoot = Split-Path -Parent $PSScriptRoot
$browserElectron = Join-Path $browserRoot 'node_modules/electron/dist/electron.exe'
$browserEntry = Join-Path $browserRoot 'out/main/index.js'
if (!(Test-Path -LiteralPath $browserElectron) -or !(Test-Path -LiteralPath $browserEntry)) {
  throw '브라우저 빌드가 없습니다. 의존성 설치와 pnpm build를 먼저 실행하세요.'
}
$env:SAMBA_USER_DATA = Get-JajaBrowserProfilePath -Override $env:SAMBA_USER_DATA -Validation:($env:JAJA_VALIDATION -eq '1')
if ($env:SAMBA_USER_DATA) {
  New-Item -ItemType Directory -Path $env:SAMBA_USER_DATA -Force | Out-Null
}
$browserLog = Join-Path $env:TEMP ('jaja-browser-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
Start-Process -FilePath $browserElectron -ArgumentList ('"' + $browserRoot + '"') `
  -WindowStyle Normal `
  -WorkingDirectory $browserRoot -RedirectStandardOutput ($browserLog + '.stdout.log') `
  -RedirectStandardError ($browserLog + '.stderr.log')
