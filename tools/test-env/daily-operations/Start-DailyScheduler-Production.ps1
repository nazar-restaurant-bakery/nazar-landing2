#requires -Version 7.0
param([switch]$OfflineCheck,[string]$WorkspaceRoot)
$ErrorActionPreference='Stop'
$runner=Join-Path $PSScriptRoot 'Operations-Runner.ps1'
if ((Get-FileHash -LiteralPath $runner).Hash -cne 'D212405135D9E0C2EFD480BD41AB369F468F1A13D626F3FB0A4E6760E6F1BD69') {Write-Output 'OPERATIONS: FAILED (başlatıcı SHA256)';exit 1}
& $runner -Order '13' -Target 'Production' -OfflineCheck:$OfflineCheck -WorkspaceRoot $WorkspaceRoot
exit $LASTEXITCODE
