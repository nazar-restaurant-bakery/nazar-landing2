#requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Config,
  [Parameter(Mandatory)][ValidateSet('test','production')][string]$Target,
  [switch]$ConfirmTarget,
  [switch]$AllowProduction,
  [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$k6Backend = Join-Path $PSScriptRoot 'k6-migrate.py'
if (-not [IO.Path]::IsPathFullyQualified($Config) -or $Config.StartsWith('\\') -or $Config.StartsWith('//')) {
  throw 'K6_LOCAL_ABSOLUTE_FILES_REQUIRED'
}
$k6ConfigPath = [IO.Path]::GetFullPath($Config)
$k6Configuration = Get-Content -LiteralPath $k6ConfigPath -Raw | ConvertFrom-Json
$k6Python = [string]$k6Configuration.python_path
if (-not [IO.Path]::IsPathFullyQualified($k6Python) -or $k6Python.StartsWith('\\') -or
    -not (Test-Path -LiteralPath $k6Python -PathType Leaf) -or
    (Get-FileHash -LiteralPath $k6Python -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$k6Configuration.python_sha256) {
  throw 'K6_PYTHON_PIN_REQUIRED'
}
if (-not $ValidateOnly -and -not $ConfirmTarget) { throw 'K6_HUMAN_CONFIRMATION_REQUIRED' }
if ($Target -eq 'production' -and -not $AllowProduction) { throw 'K6_HUMAN_PRODUCTION_FLAG_REQUIRED' }

function Invoke-K6Backend {
  param([string[]]$Arguments, [AllowNull()][string]$Handoff)
  $k6Start = [Diagnostics.ProcessStartInfo]::new()
  $k6Start.FileName = $k6Python
  $k6Start.UseShellExecute = $false
  $k6Start.CreateNoWindow = $true
  $k6Start.RedirectStandardInput = $true
  $k6Start.RedirectStandardOutput = $true
  $k6Start.RedirectStandardError = $true
  $k6Start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
  $k6Start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
  foreach ($k6Key in @($k6Start.Environment.Keys)) {
    if ($k6Key.StartsWith('PG', [StringComparison]::OrdinalIgnoreCase) -or $k6Key -in @('PSQLRC','PSQL_HISTORY')) {
      [void]$k6Start.Environment.Remove($k6Key)
    }
  }
  foreach ($k6Argument in @($k6Backend) + $Arguments) { $k6Start.ArgumentList.Add($k6Argument) }
  $k6Process = [Diagnostics.Process]::Start($k6Start)
  try {
    $k6OutputTask = $k6Process.StandardOutput.ReadToEndAsync()
    $k6ErrorTask = $k6Process.StandardError.ReadToEndAsync()
    if ($null -ne $Handoff) { $k6Process.StandardInput.Write($Handoff) }
    $k6Process.StandardInput.Close()
    if (-not $k6Process.WaitForExit(330000)) {
      $k6Process.Kill($true)
      throw 'K6_TIMEOUT_OUTCOME_REVIEW_REQUIRED'
    }
    $k6SafeOutput = $k6OutputTask.GetAwaiter().GetResult()
    [void]$k6ErrorTask.GetAwaiter().GetResult() # Never print stderr or a provider/SQL body.
    try { $k6Result = $k6SafeOutput | ConvertFrom-Json } catch { throw 'K6_STOP_RESULT_REVIEW_REQUIRED' }
    if ($k6Process.ExitCode -ne 0) {
      if ($k6Result.code -cmatch '^[A-Z0-9_]{1,80}$') { throw [string]$k6Result.code }
      throw 'K6_STOP_RESULT_REVIEW_REQUIRED'
    }
    return $k6Result
  } finally { $Handoff = $null; $k6Process.Dispose() }
}

$k6Arguments = @('--config', $k6ConfigPath, '--target', $Target)
if ($AllowProduction) { $k6Arguments += '--allow-production' }
$k6Plan = Invoke-K6Backend -Arguments $k6Arguments -Handoff $null
if ($ValidateOnly) { $k6Plan | ConvertTo-Json -Depth 8; return }
if ($k6Plan.scope -cne 'K6_OPERATOR_PLAN' -or $k6Plan.target -cne $Target -or
    $k6Plan.connection_started -ne $false -or $k6Plan.plan_sha256 -cnotmatch '^[a-f0-9]{64}$') {
  throw 'K6_DISPLAYED_PLAN_CHANGED'
}
Write-Host ('K6 {0} | {1} | {2}' -f $Target.ToUpperInvariant(), $k6Plan.name, $k6Plan.ref)
Write-Host ('Direct: {0}:5432 | user postgres | psql 18.6 | TLS verify-full' -f $k6Plan.host)
Write-Host ('SQL SHA256: {0}' -f $k6Plan.migration_sha256)
Write-Host 'Henüz database bağlantısı kurulmadı. Password girip Enter ile yalnız bu işlemi başlatırsın.'
$k6Secure = Read-Host ($k6Plan.name + ' — database password (staff login / web / archive değil)') -AsSecureString
$k6Pointer = [IntPtr]::Zero
$k6Plain = $null
$k6Handoff = $null
try {
  $k6Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($k6Secure)
  $k6Plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($k6Pointer)
  if ([string]::IsNullOrEmpty($k6Plain)) { throw 'K6_HUMAN_STDIN_HANDOFF_REQUIRED' }
  $k6Handoff = @{ password=$k6Plain; human_confirmed=$true; target_ref=$k6Plan.ref; plan_sha256=$k6Plan.plan_sha256 } | ConvertTo-Json -Compress
  $k6Result = Invoke-K6Backend -Arguments ($k6Arguments + @('--execute','--plan-sha256',$k6Plan.plan_sha256)) -Handoff $k6Handoff
  $k6Result | ConvertTo-Json -Compress
  Write-Host 'Tamamlandı. Receipt kaydedildi.'
} catch {
  Write-Host 'İşlem durdu. Aynı komutu tekrar çalıştırma; receipt önce incelenecek.'
  throw
} finally {
  if ($k6Pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($k6Pointer) }
  $k6Plain = $null; $k6Handoff = $null
  if ($null -ne $k6Secure) { $k6Secure.Dispose() }
}
