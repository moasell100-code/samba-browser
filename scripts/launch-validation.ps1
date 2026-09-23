param([string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$validationBrowserRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $validationBrowserRoot
& node (Join-Path $PSScriptRoot 'validation-environment.cjs') $Action
if ($LASTEXITCODE -ne 0) { throw '검증 환경을 실행하지 못했습니다. 검증용 로그를 확인하세요.' }
