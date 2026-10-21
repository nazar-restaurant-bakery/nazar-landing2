#requires -Version 7.0
param([switch]$OfflineCheck,[string]$WorkspaceRoot)
$ErrorActionPreference='Stop'
$runner=Join-Path $PSScriptRoot 'Operations-Runner.ps1'
if ((Get-FileHash -LiteralPath $runner).Hash -cne '900489AF0DBEE1CE5CD5E0C331527FE26D48F5EB7071EBE363257D268BC7E83F') {Write-Output 'OPERATIONS: FAILED (başlatıcı SHA256)';exit 1}
& $runner -Order '13' -Target 'Sandbox' -OfflineCheck:$OfflineCheck -WorkspaceRoot $WorkspaceRoot
exit $LASTEXITCODE
