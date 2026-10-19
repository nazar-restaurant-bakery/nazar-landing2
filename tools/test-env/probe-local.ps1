#requires -Version 7.0
[CmdletBinding()]
param([switch]$ValidateOnly,[string]$DataDirectory='',[int]$Port=55473,[switch]$NormalizeLineEndings)
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$workspace=[IO.Path]::GetFullPath((Join-Path $repoRoot '../..'))
$expectedData=[IO.Path]::GetFullPath((Join-Path $workspace 'tmp/k3-postgres-data'))
if(!$DataDirectory){$DataDirectory=$expectedData}
$DataDirectory=[IO.Path]::GetFullPath($DataDirectory)
if(![string]::Equals($DataDirectory,$expectedData,[StringComparison]::OrdinalIgnoreCase)){throw 'Only the fixed owned workspace cluster directory is allowed.'}
if($Port-ne55473){throw 'Only loopback port 55473 is allowed.'}
$pgBin='C:\Users\Talip\scoop\apps\postgresql\current\bin'
$foundation=Join-Path $workspace '03_Nazar_Supabase_Kurulum/01_KURULUM.sql'
$evidenceRoot=Join-Path $workspace '20_Yonetim/Teslim_Raporlari/K3_kanit'
$ownerFile="$DataDirectory.k3-owner.json"
$ownerTag='nazar-k3-native-probe-v1'
$hostName='127.0.0.1'
$order=@(
'20260923_form_intake_cutover.sql',
'20261011_crm_staff_draft.sql',
'20261012_crm_unified_view.sql',
'20261012_signup_retry_idempotency.sql',
'20261013_crm_staff_authorized.sql',
'20261013_crm_follow_up_tasks.sql',
'20261013_catering_decision_queue.sql',
'20261013_catering_decision_owner_guard.sql',
'20261013_catering_decision_notifications.sql',
'20261013_catering_staff_notification.sql',
'20261013_test_record_exclusion.sql',
'20261015_form_error_monitoring.sql',
'20261015_form_error_setup_test.sql',
'20261015_klaviyo_optout_return.sql',
'20261016_catering_assignee_whitespace.sql',
'20261016_crm_follow_up_queue.sql',
'20261016_crm_note_authors.sql'
)
foreach($name in @('postgres.exe','pg_ctl.exe','psql.exe','initdb.exe')){if(!(Test-Path -LiteralPath (Join-Path $pgBin $name) -PathType Leaf)){throw "Required native tool missing: $name"}}
if(!(Test-Path -LiteralPath $foundation -PathType Leaf)){throw 'Historical foundation source missing.'}
foreach($name in $order){if(!(Test-Path -LiteralPath (Join-Path $repoRoot "database/$name") -PathType Leaf)){throw "Incremental source missing: $name"}}
$plan=[ordered]@{mode='single_tenant_local_legacy_compatibility_fixture';actual_host=$hostName;actual_port=$Port;data_directory=$DataDirectory;metadata_simulated=$true;real_jwt_validation=$false;production_or_staging_proof=$false;planned_incrementals=$order.Count;emergency_pause_excluded=$true;sql_line_endings=$(if($NormalizeLineEndings){'CRLF_to_LF'}else{'source_transport'});source_sql_modified=$false;starts_services=$false}
if($ValidateOnly){$plan|ConvertTo-Json -Depth 5;exit 0}
function Invoke-LocalTool([string]$Exe,[string[]]$Arguments,[string]$InputSql='',[int]$TimeoutMs=90000){
 $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$Exe
 foreach($arg in $Arguments){[void]$info.ArgumentList.Add($arg)}
 $info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $info.StandardInputEncoding=[Text.UTF8Encoding]::new($false)
 $capture=!($Exe.EndsWith('pg_ctl.exe',[StringComparison]::OrdinalIgnoreCase)-and($Arguments-contains'start'))
 $info.RedirectStandardOutput=$capture;$info.RedirectStandardError=$capture;$info.RedirectStandardInput=$true
 if($capture){$info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false);$info.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)}
 foreach($key in @('PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSERVICE','PGSERVICEFILE','PGPASSFILE','PGOPTIONS')){[void]$info.Environment.Remove($key)}
 $info.Environment['PGCLIENTENCODING']='UTF8';$info.Environment['PGOPTIONS']='-c statement_timeout=15000 -c lock_timeout=3000'
 $process=[Diagnostics.Process]::new();$process.StartInfo=$info;[void]$process.Start()
 if($capture){$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()}
 if($InputSql){$process.StandardInput.Write($InputSql)};$process.StandardInput.Close()
 $finished=$process.WaitForExit($TimeoutMs)
 if(!$finished){$process.Kill($true);$process.WaitForExit()}
 $outText='Detached startup output is recorded in postgres-server.log.';$errText=''
 if($capture){
  if(!$stdout.Wait(5000)-or!$stderr.Wait(5000)){throw 'Native output pipe did not close after the bounded process wait.'}
  $outText=$stdout.GetAwaiter().GetResult();$errText=$stderr.GetAwaiter().GetResult()
 }
 $result=[ordered]@{exit_code=$process.ExitCode;stdout=$outText;stderr=$errText;timed_out=(!$finished)}
 $process.Dispose();return $result
}
function Invoke-LocalSql([string]$Sql){
 if($NormalizeLineEndings){$Sql=$Sql.Replace(([string][char]13+[char]10),([string][char]10))}
 $arguments=@('-X','-q','-w','-h',$hostName,'-p',"$Port",'-U','postgres','-d',$script:databaseName,'-v','ON_ERROR_STOP=1','-P','pager=off','-At')
 return Invoke-LocalTool (Join-Path $pgBin 'psql.exe') $arguments ('\set VERBOSITY verbose'+[Environment]::NewLine+$Sql)
}
function Write-Evidence([string]$Name,$Value){[IO.File]::WriteAllText((Join-Path $script:runDirectory $Name),($Value|ConvertTo-Json -Depth 15),[Text.UTF8Encoding]::new($false))}
function Save-Step([string]$Name,$Result){Write-Evidence "$Name.json" $Result;[void]$script:steps.Add([ordered]@{step=$Name;exit_code=$Result.exit_code;timed_out=$Result.timed_out})}
$runId=(Get-Date).ToUniversalTime().ToString('yyyyMMdd_HHmmss')+'_'+[Guid]::NewGuid().ToString('N').Substring(0,8)
$script:databaseName='k3_probe_'+$runId
$script:runDirectory=Join-Path $evidenceRoot "native_$runId"
$script:steps=[Collections.Generic.List[object]]::new()
$sourceHashes=[ordered]@{};$sourceHashes[$foundation]=(Get-FileHash -LiteralPath $foundation -Algorithm SHA256).Hash.ToLowerInvariant()
foreach($name in $order){$path=Join-Path $repoRoot "database/$name";$sourceHashes[$path]=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
$report=[ordered]@{
 scope='Bounded native PostgreSQL SINGLE-TENANT LOCAL COMPATIBILITY FIXTURE; not real Supabase/Auth/JWT or staging acceptance.'
 checked_at_utc=(Get-Date).ToUniversalTime().ToString('o');metadata_simulated=$true
 sql_line_endings=$(if($NormalizeLineEndings){'CRLF_to_LF'}else{'source_transport'})
 human_confirmation_supplied_in_memory_only=$true;actual_host=$hostName;actual_port=$Port;database=$script:databaseName
 planned_incrementals=$order.Count;applied_incrementals=@();first_failure=$null
 privilege_checks=[ordered]@{};source_hashes_before=$sourceHashes;source_sql_bytes_preserved=$false
 server_started=$false;server_stopped=$false;setup_error=$null;full_migration_replay_verified=$false
}
$owned=$false;$attemptedStart=$false
try{
 $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$Port)
 try{$listener.Start()}finally{$listener.Stop()}
 if(Test-Path -LiteralPath $DataDirectory){
  if(!(Test-Path -LiteralPath $ownerFile -PathType Leaf)){throw 'Existing data directory has no K3 ownership marker; refusing reuse.'}
  $owner=Get-Content -LiteralPath $ownerFile -Raw|ConvertFrom-Json
  if($owner.owner_tag-ne$ownerTag-or$owner.actual_host-ne$hostName-or$owner.actual_port-ne$Port-or$owner.data_directory-ne$DataDirectory){throw 'K3 ownership marker mismatch; refusing reuse.'}
  $owned=$true
  if(!(Test-Path -LiteralPath (Join-Path $DataDirectory 'PG_VERSION') -PathType Leaf)){throw 'Owned directory is incomplete; manual review required. No files deleted.'}
 }elseif(Test-Path -LiteralPath $ownerFile){throw 'Orphan ownership marker requires manual review. No files deleted.'}
 [IO.Directory]::CreateDirectory($script:runDirectory)|Out-Null
 $version=Invoke-LocalTool (Join-Path $pgBin 'postgres.exe') @('--version');Save-Step '00_native_version' $version
 if($version.exit_code-ne0-or$version.stdout-notmatch'PostgreSQL\) 18\.'){throw 'Expected Scoop PostgreSQL 18 native binaries.'}
 if(!$owned){
  [IO.Directory]::CreateDirectory((Split-Path -Parent $DataDirectory))|Out-Null
  $marker=[ordered]@{owner_tag=$ownerTag;actual_host=$hostName;actual_port=$Port;data_directory=$DataDirectory;created_at_utc=(Get-Date).ToUniversalTime().ToString('o');synthetic_only=$true}
  [IO.File]::WriteAllText($ownerFile,($marker|ConvertTo-Json),[Text.UTF8Encoding]::new($false));$owned=$true
  $initialized=Invoke-LocalTool (Join-Path $pgBin 'initdb.exe') @('-D',$DataDirectory,'-U','postgres','--auth=trust','--no-locale','-E','UTF8') '' 120000
  Save-Step '01_initdb' $initialized
  if($initialized.exit_code-ne0){throw 'Native initdb failed; partial owned directory retained for review.'}
 }
 $attemptedStart=$true
 $started=Invoke-LocalTool (Join-Path $pgBin 'pg_ctl.exe') @('-D',$DataDirectory,'-l',(Join-Path $script:runDirectory 'postgres-server.log'),'-o',"-h 127.0.0.1 -p $Port",'-w','-t','30','start') '' 45000
 Save-Step '02_pg_start' $started
 if($started.exit_code-ne0){throw 'Native local PostgreSQL start failed.'}
 $report.server_started=$true;$script:databaseName='postgres'
 $created=Invoke-LocalSql ('CREATE DATABASE "'+$report.database+'";');Save-Step '03_create_database' $created
 if($created.exit_code-ne0){throw 'Cannot create the uniquely named local probe database.'}
 $script:databaseName=$report.database
 $identity=Invoke-LocalSql "SELECT json_build_object('host',host(inet_server_addr()),'port',inet_server_port(),'data_directory',current_setting('data_directory'),'database',current_database(),'current_user',current_user);"
 Save-Step '04_local_identity' $identity
 if($identity.exit_code-ne0){throw 'Cannot verify native server identity.'}
 $observed=$identity.stdout.Trim()|ConvertFrom-Json
 if($observed.host-ne$hostName-or$observed.port-ne$Port-or$observed.database-ne$report.database-or$observed.current_user-ne'postgres'-or![string]::Equals([IO.Path]::GetFullPath($observed.data_directory),$DataDirectory,[StringComparison]::OrdinalIgnoreCase)){throw 'Local host/data-directory identity mismatch; foundation not executed.'}
 $report.observed_local_identity=$observed
 # Synthetic compatibility roles/UID function, NOT real Supabase Auth or JWT validation.
 $authFixture=@'
DO $roles$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS; END IF;
END $roles$;
CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
INSERT INTO auth.users(id) VALUES('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
'@
 $fixtureResult=Invoke-LocalSql $authFixture;Save-Step '05_synthetic_auth_fixture' $fixtureResult
 if($fixtureResult.exit_code-ne0){throw 'Synthetic local auth compatibility fixture failed.'}
 $original=[IO.File]::ReadAllText($foundation)
 if([regex]::Matches($original,'REPLACE_WITH_NEW_PROJECT_REF').Count-ne1){throw 'Unexpected foundation human-confirmation placeholder count.'}
 # Only the in-memory string goes to owned loopback psql stdin; no patched source file is written.
 $localFoundation=$original.Replace('REPLACE_WITH_NEW_PROJECT_REF','khgczybubufouraqyrcj')
 $foundationResult=Invoke-LocalSql $localFoundation;Save-Step '06_historical_foundation_compatibility' $foundationResult
 if($foundationResult.exit_code-ne0){$report.first_failure=[ordered]@{source='03_Nazar_Supabase_Kurulum/01_KURULUM.sql';exit_code=$foundationResult.exit_code;stderr=$foundationResult.stderr}}
 else{
  $index=0
  foreach($name in $order){
   $index++
   $beforeHashes=Invoke-LocalSql "SELECT json_build_object('catering_raw_md5',md5(pg_get_functiondef(to_regprocedure('public.crm_update_catering(uuid,text,text,timestamptz)'))),'overview_lf_md5',md5(replace(pg_get_functiondef(to_regprocedure('public.crm_overview_v2(text,text)')),E'\r\n',E'\n')));"
   $migration=Invoke-LocalSql ([IO.File]::ReadAllText((Join-Path $repoRoot "database/$name")))
   Save-Step ('migration_'+$index.ToString('00')+'_'+[IO.Path]::GetFileNameWithoutExtension($name)) $migration
   if($migration.exit_code-ne0){$report.first_failure=[ordered]@{source="database/$name";exit_code=$migration.exit_code;stderr=$migration.stderr;function_hashes_before=$beforeHashes.stdout.Trim()};break}
   $report.applied_incrementals+=$name
  }
  # Independent narrow privilege observations do not resume or bypass failed migrations.
  $anonDirect=Invoke-LocalSql "SET ROLE anon; SELECT count(*) FROM core.customers;";Save-Step '91_anon_direct_table' $anonDirect
  $report.privilege_checks.anon_direct_table_denied=($anonDirect.exit_code-ne0-and$anonDirect.stderr-match'42501')
  $privileges=Invoke-LocalSql "SELECT json_build_object('anon_submit',has_function_privilege('anon','public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)','EXECUTE'),'authenticated_submit',has_function_privilege('authenticated','public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)','EXECUTE'),'service_submit',has_function_privilege('service_role','public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)','EXECUTE'));"
  Save-Step '92_submit_privileges' $privileges
  if($privileges.exit_code-eq0){$report.privilege_checks.submit_privileges=($privileges.stdout.Trim()|ConvertFrom-Json)}
  $nonstaff=Invoke-LocalSql "SET ROLE authenticated; SET request.jwt.claim.sub='22222222-2222-4222-8222-222222222222'; SELECT public.crm_overview_v2('','all');"
  Save-Step '93_nonstaff_rpc' $nonstaff
  $report.privilege_checks.nonstaff_rpc_denied=($nonstaff.exit_code-ne0-and$nonstaff.stderr-match'42501')
  $report.full_migration_replay_verified=(!$report.first_failure-and$report.applied_incrementals.Count-eq$order.Count)
 }
}catch{$report.setup_error=$_.Exception.Message}
finally{
 if($owned-and$attemptedStart){
  try{
   $stopped=Invoke-LocalTool (Join-Path $pgBin 'pg_ctl.exe') @('-D',$DataDirectory,'-m','fast','-w','-t','30','stop') '' 45000
   if(Test-Path -LiteralPath $script:runDirectory){Save-Step '99_pg_stop' $stopped}
   $status=Invoke-LocalTool (Join-Path $pgBin 'pg_ctl.exe') @('-D',$DataDirectory,'status') '' 10000
   $report.server_stopped=($status.exit_code-eq3)
  }catch{$report.stop_error=$_.Exception.Message}
 }
 $preserved=$true
 foreach($path in $sourceHashes.Keys){if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()-ne$sourceHashes[$path]){$preserved=$false}}
 $report.source_sql_bytes_preserved=$preserved;$report.steps=$script:steps.ToArray();$report.finished_at_utc=(Get-Date).ToUniversalTime().ToString('o')
 if(Test-Path -LiteralPath $script:runDirectory){Write-Evidence 'probe-summary.json' $report}
 $report|ConvertTo-Json -Depth 15
}
if($report.setup_error-or!$report.server_stopped-or!$report.source_sql_bytes_preserved){exit 2}
if($report.first_failure){exit 1}
exit 0
