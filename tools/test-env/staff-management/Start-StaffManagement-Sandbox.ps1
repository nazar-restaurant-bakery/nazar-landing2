#requires -Version 7.0
param([switch]$OfflineCheck,[string]$WorkspaceRoot)
$ErrorActionPreference='Stop'
$runner=Join-Path $PSScriptRoot 'StaffManagement-Runner.ps1'
if ((Get-FileHash -LiteralPath $runner).Hash -cne '4C1F71A3879FE182E5FBB226C0A22B51644CF2831979CB52E831BE7D75BB1485') {Write-Output 'STAFF MANAGEMENT: FAILED (başlatıcı SHA256)';exit 1}
& $runner -Order '15' -Target 'Sandbox' -OfflineCheck:$OfflineCheck -WorkspaceRoot $WorkspaceRoot
exit $LASTEXITCODE
