#requires -Version 7.0
param([Parameter(Mandatory)][string]$WorkspaceRoot)
$ErrorActionPreference='Stop'
# Local setup only: copy the existing approved operator targets, never execute it.
$source=Join-Path $WorkspaceRoot '20_Yonetim/Teslim_Raporlari/Sirali_Kurulum_kanit/Migration-Runner.ps1'
if ((Get-FileHash -LiteralPath $source).Hash -cne '462E808D8E4E2412986A756966D3738D28FCEF41E520A2C1CB0DA8A0912CD622') {throw 'EXISTING_OPERATOR_REVIEW_REQUIRED'}
$text=[IO.File]::ReadAllText($source)
$sandbox=[regex]::Match($text,"Sandbox='([a-z]{20})'").Groups[1].Value
$production=[regex]::Match($text,"Production='([a-z]{20})'").Groups[1].Value
if (-not $sandbox -or -not $production -or $sandbox -ceq $production) {throw 'TARGET_CONFIGURATION_REQUIRED'}
$json="{`n  `"Sandbox`": `"$sandbox`",`n  `"Production`": `"$production`"`n}`n"
$bytes=[Text.Encoding]::UTF8.GetBytes($json)
$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
if ($hash -cne 'D3B0FD6973EC68CD81092E013D0035A5155B87C46465FCB25181C82571DA284E') {throw 'TARGET_CONFIGURATION_REVIEW_REQUIRED'}
$path=Join-Path $PSScriptRoot 'targets.json'
if (Test-Path -LiteralPath $path) {
 if ((Get-FileHash -LiteralPath $path).Hash -cne $hash) {throw 'EXISTING_TARGET_CONFIGURATION_CONFLICT'}
} else {[IO.File]::WriteAllBytes($path,$bytes)}
Write-Output 'STAFF MANAGE TARGETS: READY (local files only; no connection)'
