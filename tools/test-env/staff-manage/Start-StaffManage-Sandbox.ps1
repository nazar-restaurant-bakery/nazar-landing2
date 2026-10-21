#requires -Version 7.0
param([switch]$OfflineCheck,[string]$WorkspaceRoot)
$ErrorActionPreference='Stop'
$runner=Join-Path $PSScriptRoot 'StaffManage-Runner.ps1'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf) -or (Get-FileHash -LiteralPath $runner -Algorithm SHA256).Hash -cne '5175C908C06AD4AB4DAF5CEE7B7C59964192968322AE377E3B2224819D6864A4') {
 Write-Output 'STAFF MANAGE SANDBOX: FAILED (başlatıcı SHA256)'; exit 1
}
& $runner -Order '14b' -Target 'Sandbox' -OfflineCheck:$OfflineCheck -WorkspaceRoot $WorkspaceRoot
exit $LASTEXITCODE
