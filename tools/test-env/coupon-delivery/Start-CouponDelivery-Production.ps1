#requires -Version 7.0
param([switch]$OfflineCheck,[string]$WorkspaceRoot)
$ErrorActionPreference='Stop'
$runner=Join-Path $PSScriptRoot 'CouponDelivery-Runner.ps1'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf) -or (Get-FileHash -LiteralPath $runner -Algorithm SHA256).Hash -cne 'DAF7D5C9536CACF86FF4EB6228E204EA679BA8719959E38C2D437EA7F55D0930') {
 Write-Output 'COUPON DELIVERY PRODUCTION: FAILED (başlatıcı SHA256)'; exit 1
}
& $runner -Order '14a' -Target 'Production' -OfflineCheck:$OfflineCheck -WorkspaceRoot $WorkspaceRoot
exit $LASTEXITCODE
