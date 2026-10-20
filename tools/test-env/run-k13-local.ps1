#requires -Version 7.0
param()
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$bin = 'C:\Users\Talip\scoop\apps\postgresql\18.6-4\bin'
$data = Join-Path ([IO.Path]::GetTempPath()) ('nazar-k13-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 55000 -Maximum 59000
$started = $false
try {
  Write-Output 'K13 local: initdb'
  & (Join-Path $bin 'initdb.exe') -D $data -A trust -U postgres --no-instructions *> $null
  if ($LASTEXITCODE -ne 0) { throw 'local_init_failed' }
  Write-Output 'K13 local: start'
  & (Join-Path $bin 'pg_ctl.exe') -D $data -l (Join-Path $data 'server.log') -o "-h 127.0.0.1 -p $port" -w -t 30 start
  if ($LASTEXITCODE -ne 0) { throw 'local_start_failed' }
  $started = $true
  $files = @(
    'tools/test-env/k7-local-bootstrap.sql',
    'supabase/migrations/20261020000700_clover_order_core.sql',
    'tools/test-env/k13-local-bootstrap.sql',
    'tools/test-env/k13-shared-staff.fixture.sql',
    'tests/opsDbCommission.fixture.sql',
    'supabase/migrations/20261021000400_commission_from_orders.sql',
    'tools/test-env/k13-commission-test.sql'
  )
  foreach ($file in $files) {
    Write-Output ('K13 local: ' + $file)
    & (Join-Path $bin 'psql.exe') -X -w -h 127.0.0.1 -p $port -U postgres -d postgres -v ON_ERROR_STOP=1 -f (Join-Path $repo $file)
    if ($LASTEXITCODE -ne 0) { throw ('local_sql_failed: ' + $file) }
  }
  Write-Output 'K13 LOCAL SQL: PASSED'
} catch {
  Write-Output ('K13 LOCAL SQL: FAILED (' + $_.Exception.Message + ')')
  exit 1
} finally {
  if ($started) { & (Join-Path $bin 'pg_ctl.exe') -D $data -m immediate -w stop *> $null }
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  $resolved = [IO.Path]::GetFullPath($data)
  $insideTemp = $resolved.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)
  $correctName = [IO.Path]::GetFileName($resolved) -match '^nazar-k13-[a-f0-9]{32}$'
  if ($insideTemp -and $correctName -and (Test-Path -LiteralPath $resolved)) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
