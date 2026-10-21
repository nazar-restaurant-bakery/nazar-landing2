#requires -Version 7.0
param([Parameter(Mandatory)][ValidateSet('Sandbox','Production')][string]$Target,[ValidateSet('Preflight','InstallInactive','Enable','Disable')][string]$Action='Preflight',[switch]$OfflineCheck,[string]$WorkspaceRoot)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$workspace=if($WorkspaceRoot){$WorkspaceRoot}else{[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))}
$refs=Get-Content (Join-Path $PSScriptRoot 'targets.json') -Raw|ConvertFrom-Json;$ref=$refs.$Target
if((Get-FileHash (Join-Path $PSScriptRoot 'targets.json')).Hash -cne 'D3B0FD6973EC68CD81092E013D0035A5155B87C46465FCB25181C82571DA284E'){throw 'TARGET_PIN_FAILED'}
$configPath=Join-Path $PSScriptRoot 'scheduler-settings.json'
if(-not(Test-Path $configPath)){Write-Output 'SCHEDULER: WAITING (scheduler-settings.json)';exit 2}
$c=(Get-Content $configPath -Raw|ConvertFrom-Json).$Target
if($c.businessId -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $c.cloverUrl -notmatch '^https://[a-zA-Z0-9.-]+/api/internal/daily-clover-pull$'){throw 'SETTINGS_REVIEW_REQUIRED'}
# Ordered receipt and package validation run without database activity.
& (Join-Path $PSScriptRoot "Start-DailyScheduler-$Target.ps1") -OfflineCheck -WorkspaceRoot $workspace
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
$receiptPath=Join-Path $PSScriptRoot "receipts/13-$($Target.ToLowerInvariant())-success.json"
if(-not(Test-Path $receiptPath)){Write-Output 'SCHEDULER: WAITING (migration 13 success)';exit 2}
if($OfflineCheck){Write-Output 'SCHEDULER SETUP OFFLINE: PASSED (bağlantı/parola/yazma yok)';exit 0}
$helper=Join-Path $PSScriptRoot 'K7-DbRunner.ps1';$psql=Join-Path $env:USERPROFILE 'scoop/apps/postgresql/18.6-4/bin/psql.exe';$ca=Join-Path $workspace '20_Yonetim/Teslim_Raporlari/K3_kanit/tls/prod-ca-2021.crt'
if((Get-FileHash $helper).Hash -cne 'F33D200727A327EE5F2732922010EE79E9B079172FAEFFA41DC4E74A98252F3A'){throw 'HELPER_PIN_FAILED'}
. $helper
$secure=Read-Host "$Target database password" -AsSecureString;$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try{
 $password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
 $base=@('-X','-w','-h',"db.$ref.supabase.co",'-p','5432','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-t','-A')
 $pre="SELECT (to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL AND to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NOT NULL AND to_regprocedure('extensions.hmac(text,text,text)') IS NOT NULL AND to_regclass('vault.decrypted_secrets') IS NOT NULL)::int;"
 $r=Invoke-K7Psql -Psql $psql -Arguments ($base+@('-c',$pre)) -Password $password -Ca $ca
 if($r.ExitCode -ne 0 -or $r.Output.Trim() -cne '1'){throw 'EXTENSION_PREFLIGHT_FAILED'}
 $secretCheck="SELECT (EXISTS(SELECT FROM vault.decrypted_secrets WHERE name='SCHEDULER_SIGNING_SECRET' AND length(decrypted_secret)>=32) AND EXISTS(SELECT FROM vault.decrypted_secrets WHERE name='SCHEDULER_EDGE_URL' AND decrypted_secret='https://$ref.supabase.co/functions/v1/daily-ops-run') AND EXISTS(SELECT FROM core.businesses WHERE id='$($c.businessId)'::uuid))::int;"
 $r=if($Action -eq 'Disable'){[pscustomobject]@{ExitCode=0;Output='1'}}else{Invoke-K7Psql -Psql $psql -Arguments ($base+@('-c',$secretCheck)) -Password $password -Ca $ca}
 if($r.ExitCode -ne 0 -or $r.Output.Trim() -cne '1'){throw 'VAULT_OR_BUSINESS_PREFLIGHT_FAILED'}
 if($Action -eq 'Preflight'){Write-Output 'SCHEDULER PREFLIGHT: READY (cron/pg_net/pgcrypto/Vault/işletme; değerler gösterilmedi)';exit 0}
 if((Read-Host "$Target $Action için ONAY yazın") -cne 'ONAY'){throw 'CANCELLED'}
 $sql=switch($Action){
  InstallInactive {"BEGIN; INSERT INTO core.daily_scheduler_settings(business_id,enabled,clover_url) VALUES('$($c.businessId)'::uuid,false,'$($c.cloverUrl)') ON CONFLICT(business_id) DO UPDATE SET clover_url=excluded.clover_url,enabled=false; SELECT cron.schedule('platform-daily-ops','* * * * *','SELECT core.daily_scheduler_tick();'); UPDATE cron.job SET active=false WHERE jobname='platform-daily-ops'; COMMIT;"}
  Enable {"BEGIN; UPDATE core.daily_scheduler_settings SET enabled=true WHERE business_id='$($c.businessId)'::uuid AND clover_url='$($c.cloverUrl)'; UPDATE cron.job SET active=true WHERE jobname='platform-daily-ops' AND schedule='* * * * *' AND command='SELECT core.daily_scheduler_tick();'; DO `$`$ BEGIN IF NOT EXISTS(SELECT FROM cron.job WHERE jobname='platform-daily-ops' AND active) THEN RAISE EXCEPTION 'JOB_NOT_INSTALLED'; END IF; END; `$`$; COMMIT;"}
  Disable {"BEGIN; UPDATE core.daily_scheduler_settings SET enabled=false WHERE business_id='$($c.businessId)'::uuid; UPDATE cron.job SET active=false WHERE jobname='platform-daily-ops'; COMMIT;"}
 }
 $r=Invoke-K7Psql -Psql $psql -Arguments ($base+@('-c',$sql)) -Password $password -Ca $ca
 if($r.ExitCode -ne 0){throw 'SETUP_UNCONFIRMED'}
 Write-Output "SCHEDULER $Action`: SAVED (çalışma başarısı panelden ayrıca doğrulanır)"
}catch{Write-Output 'SCHEDULER: STOPPED — kurulum/çalışma doğrulanmadı; otomatik tekrar yok.';exit 1}
finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr);$secure.Dispose();$password=$null}
