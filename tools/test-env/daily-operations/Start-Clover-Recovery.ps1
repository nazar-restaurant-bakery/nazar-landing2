#requires -Version 7.0
param([Parameter(Mandatory)][string]$RepoRoot,[Parameter(Mandatory)][string]$From,[Parameter(Mandatory)][string]$To,[ValidateSet('Sandbox','Production')][string]$Target='Production',[switch]$OfflineCheck,[string]$WorkspaceRoot)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$workspace=if($WorkspaceRoot){$WorkspaceRoot}else{[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))}
$configPath=Join-Path $PSScriptRoot 'recovery-config.json'
if((Get-FileHash (Join-Path $PSScriptRoot 'recovery-coverage.sql')).Hash -cne 'D68A0C0248A6167C00F829D906B78C0AEAD37698177F2BBC33B1D148DFF5FF3C'){throw 'COVERAGE_SQL_REVIEW_REQUIRED'}
if((Get-FileHash (Join-Path $PSScriptRoot 'recovery-source-sha256.json')).Hash -cne '9A9E0A0ED3784366CAF93D7015890A8CE472530C15E5F3C6C1E949585E5D00DC'){throw 'RECOVERY_PINS_REVIEW_REQUIRED'}
$pins=Get-Content (Join-Path $PSScriptRoot 'recovery-source-sha256.json') -Raw|ConvertFrom-Json
foreach($pin in $pins){if((Get-FileHash (Join-Path $RepoRoot $pin.file)).Hash.ToLowerInvariant() -cne $pin.sha256){throw 'RECOVERY_SOURCE_REVIEW_REQUIRED'}}
if($From -notmatch '^\d{4}-\d{2}-\d{2}$' -or $To -notmatch '^\d{4}-\d{2}-\d{2}$'){throw 'INVALID_RANGE'}
if(-not(Test-Path $configPath)){Write-Output 'RECOVERY: WAITING (recovery-config.json)';exit 2}
$c=Get-Content $configPath -Raw|ConvertFrom-Json
$refs=Get-Content (Join-Path $PSScriptRoot 'targets.json') -Raw|ConvertFrom-Json
$ref=$refs.$Target
if($c.expectedUrl -cne "https://$ref.supabase.co" -or $c.expectedBusinessId -notmatch '^[a-f0-9-]{36}$'){throw 'RECOVERY_TARGET_REJECTED'}
$psql=Join-Path $env:USERPROFILE 'scoop/apps/postgresql/18.6-4/bin/psql.exe'
$ca=Join-Path $workspace '20_Yonetim/Teslim_Raporlari/K3_kanit/tls/prod-ca-2021.crt'
$helper=Join-Path $PSScriptRoot 'K7-DbRunner.ps1'
foreach($p in @(@($psql,'B22D9AC21C30EA131E91C0DCB1E3850383ADF1422848ED4233EE07ADDCA50132'),@($ca,'700723581420DD1AC98FD7E9AC529F0EF210EADCAF87FC868A3AD7D114C2F3B7'),@($helper,'F33D200727A327EE5F2732922010EE79E9B079172FAEFFA41DC4E74A98252F3A'))){if((Get-FileHash $p[0]).Hash -cne $p[1]){throw 'RECOVERY_PIN_FAILED'}}
if($OfflineCheck){Write-Output 'RECOVERY OFFLINE: PASSED (bağlantı/parola/yazma yok)';exit 0}
. $helper
$secrets=[Collections.Generic.List[object]]::new()
function Read-Private([string]$Label){$secure=Read-Host $Label -AsSecureString;$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);$secrets.Add(@($secure,$ptr));[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}
try{
 if((Read-Host "$Target $ref / $From — $To çekimi için CEK yazın") -cne 'CEK'){throw 'CANCELLED'}
 $password=Read-Private "$Target database password"
 $base=@('-X','-w','-h',"db.$ref.supabase.co",'-p','5432','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-t','-A')
 $check=Invoke-K7Psql -Psql $psql -Arguments ($base+@('-c',"SELECT json_build_object('business',EXISTS(SELECT FROM core.businesses WHERE id='$($c.expectedBusinessId)'::uuid),'daily',to_regprocedure('public.daily_reserve_external_request(uuid,uuid,uuid)') IS NOT NULL,'legacy',to_regprocedure('public.ops_reserve_external_request()') IS NOT NULL);")) -Password $password -Ca $ca
 if($check.ExitCode -ne 0){throw 'RECOVERY_PREFLIGHT_FAILED'}
 $db=$check.Output.Trim()|ConvertFrom-Json
 if(-not $db.business -or (-not $db.daily -and -not $db.legacy)){throw 'RECOVERY_PREFLIGHT_FAILED'}
 $reserve=if($db.daily){'daily_reserve_external_request'}else{'ops_reserve_external_request'}
 $secret=Read-Private "$Target Supabase server secret key (sb_secret_)"
 $token=Read-Private "$Target Clover orders access token"
 if(-not $secret.StartsWith('sb_secret_') -or $token.Length -lt 12){throw 'RECOVERY_CREDENTIAL_TYPE_REJECTED'}
 $run=Join-Path $PSScriptRoot ('runs/recovery-'+[guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($run)
 $proofPath=Join-Path $run 'source-proof.json'
 $node=(Get-Command node -CommandType Application).Source
 $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$node;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 foreach($v in @('--experimental-strip-types',(Join-Path $RepoRoot 'tools/test-env/run-clover-recovery.mjs'),$configPath,$From,$To,$proofPath,$reserve)){[void]$info.ArgumentList.Add($v)}
 foreach($key in @($info.Environment.Keys)){if($key.StartsWith('TEST_') -or $key.StartsWith('VITE_TEST_') -or $key -in @('APP_ENV','SUPABASE_SECRET_KEY','CLOVER_ORDERS_ACCESS_TOKEN')){[void]$info.Environment.Remove($key)}}
 $isolated=$Target -eq 'Sandbox'
 $info.Environment[ $(if($isolated){'TEST_SUPABASE_SECRET_KEY'}else{'SUPABASE_SECRET_KEY'}) ]=$secret
 $info.Environment[ $(if($isolated){'TEST_CLOVER_ORDERS_ACCESS_TOKEN'}else{'CLOVER_ORDERS_ACCESS_TOKEN'}) ]=$token
 $p=[Diagnostics.Process]::new();$p.StartInfo=$info;[void]$p.Start();$out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync()
 if(-not $p.WaitForExit(180000)){$p.Kill($true);throw 'RECOVERY_RESULT_UNCONFIRMED'}
 $safe=$out.GetAwaiter().GetResult();$safeError=$err.GetAwaiter().GetResult();$exit=$p.ExitCode;$p.Dispose();$info.Environment.Clear()
 if($exit -ne 0){Write-Output $safeError.Trim();throw 'RECOVERY_STOPPED_NO_AUTOMATIC_RETRY'}
 $proof=Get-Content $proofPath -Raw|ConvertFrom-Json
 if($proof.target -cne $c.expectedUrl -or $proof.businessId -cne $c.expectedBusinessId -or $proof.from -cne $From -or $proof.to -cne $To){throw 'RECOVERY_PROOF_TARGET_FAILED'}
 $coverage=Join-Path $PSScriptRoot 'recovery-coverage.sql'
 $verified=Invoke-K7Psql -Psql $psql -Arguments ($base+@('-v',"from_day=$From",'-v',"to_day=$To",'-v',"business_id=$($c.expectedBusinessId)",'-f',$coverage)) -Password $password -Ca $ca
 if($verified.ExitCode -ne 0){throw 'RECOVERY_DAILY_DATABASE_CHECK_FAILED'}
 $days=@($verified.Output.Trim()|ConvertFrom-Json)
 if($days.Count -ne $proof.days.Count){throw 'RECOVERY_DAY_COUNT_MISMATCH'}
 foreach($day in $proof.days){$stored=@($days|Where-Object{$_.day -ceq $day.day});if($stored.Count -ne 1 -or $stored[0].count -ne $day.sourceCount -or $stored[0].digest -cne $day.idsMd5){throw 'RECOVERY_DAILY_ID_MISMATCH'}}
 $receipt=[ordered]@{schemaVersion=1;target=$ref;from=$From;to=$To;status='PASSED';daysChecked=$days.Count;sourceOrders=$proof.sourceOrders;providerRequests=$proof.providerRequests;sourceProofSha256=(Get-FileHash $proofPath).Hash;verifiedAtUtc=[DateTimeOffset]::UtcNow.ToString('o');password_recorded=$false;financialReconciliation=$false}
 [IO.File]::WriteAllText((Join-Path $run 'daily-coverage.json'),($receipt|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
 Write-Output "RECOVERY: PASSED ($($days.Count) gün / sipariş kimlik kümeleri eşleşti; mali mutabakat ayrı)"
}catch{Write-Output 'RECOVERY: STOPPED — eksiksizlik kanıtlanmadı; otomatik tekrar yapılmadı.';exit 1}
finally{foreach($s in $secrets){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($s[1]);$s[0].Dispose()};$password=$null;$secret=$null;$token=$null}
