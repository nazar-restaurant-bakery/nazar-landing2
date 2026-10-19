#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ReviewedDirectory,
      [Parameter(Mandatory)][string]$ExpectedProjectRef,
      [string]$NodeExecutable='C:\Program Files\nodejs\node.exe',
      [switch]$ValidateOnly)
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$workspace=[IO.Path]::GetFullPath((Join-Path $repoRoot '../..'))
$privateRoot=[IO.Path]::GetFullPath((Join-Path $workspace '20_Yonetim/Teslim_Raporlari/K3_kanit/sandbox-recovery'))
$reviewed=[IO.Path]::GetFullPath($ReviewedDirectory)
if(!$reviewed.StartsWith($privateRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Only an archive-bound reviewed sandbox capture inside the private root is allowed.'}
if($ExpectedProjectRef-notmatch'^[a-z]{20}$'){throw 'An explicit expected sandbox project ref is required.'}
$dataDirectory=[IO.Path]::GetFullPath((Join-Path $workspace 'tmp/k3-postgres-data'))
$ownerFile="$dataDirectory.k3-owner.json"
$pgBin='C:\Users\Talip\scoop\apps\postgresql\current\bin'
$python='C:\Users\Talip\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$hostName='127.0.0.1';$port=55473
if(!(Test-Path -LiteralPath $ownerFile -PathType Leaf)-or!(Test-Path -LiteralPath (Join-Path $dataDirectory 'PG_VERSION') -PathType Leaf)){throw 'The existing owned local PostgreSQL cluster is required; no cluster is initialized.'}
$owner=Get-Content -LiteralPath $ownerFile -Raw|ConvertFrom-Json
if($owner.owner_tag-ne'nazar-k3-native-probe-v1'-or$owner.actual_host-ne$hostName-or$owner.actual_port-ne$port-or$owner.data_directory-ne$dataDirectory){throw 'Local ownership marker mismatch.'}
foreach($path in @($reviewed,$dataDirectory)){
 $current=Get-Item -LiteralPath $path
 while($null-ne$current){if($current.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'Reparse paths are not allowed.'};$current=$current.Parent}
}
foreach($name in @('postgres.exe','pg_ctl.exe','psql.exe')){if(!(Test-Path -LiteralPath (Join-Path $pgBin $name) -PathType Leaf)){throw 'Required native PostgreSQL binary missing.'}}
if(![IO.Path]::IsPathFullyQualified($NodeExecutable)-or!(Test-Path -LiteralPath $NodeExecutable -PathType Leaf)){throw 'An absolute trusted Node 24+ executable is required.'}
# No native server can start before the immutable SANDBOX capture, explicit
# complete review, reviewed archive selection and derived row bytes validate.
$validation=& $python (Join-Path $PSScriptRoot 'review-sandbox-recovery.py') --validate-rendered $reviewed --expected-project-ref $ExpectedProjectRef
if($LASTEXITCODE-ne0){throw 'Archive-bound reviewed sandbox provenance validation failed.'}
$validated=($validation-join[Environment]::NewLine)|ConvertFrom-Json
if($validated.status-ne'SANDBOX_LOCAL_INPUT_VALIDATED_NOT_RESTORED'-or$validated.remote_connection-ne$false){throw 'Sandbox input validation did not establish local-only scope.'}
$package=$validated.package_directory
$packageValidation=& $NodeExecutable (Join-Path $PSScriptRoot 'validate-recovery.mjs') $package
if($LASTEXITCODE-ne0){throw 'Reviewed derived recovery package failed offline validation.'}
$packageReport=($packageValidation-join[Environment]::NewLine)|ConvertFrom-Json
if($packageReport.packageIntegrityVerified-ne$true){throw 'Complete synthetic recovery package validation is required.'}
$nodeVersion=& $NodeExecutable --version
if($LASTEXITCODE-ne0-or$nodeVersion-notmatch'^v(2[4-9]|[3-9][0-9])\.'){throw 'Node 24+ exact-number JSON source context is required.'}
$baseline=Join-Path $reviewed 'reviewed-baseline.sql'
$orders=Join-Path $package 'catering-orders.json'
$plan=[ordered]@{scope='reviewed sandbox DDL and four exact test orders in a new owned local database';host=$hostName;port=$port;baseline_sha256=$validated.baseline_sha256;orders_sha256=$validated.orders_sha256;starts_services=$false;remote_connection=$false;auth_fixture_simulated=$true;real_jwt_validation=$false;staff_identity_restored=$false;remote_reset_authorized=$false}
if($ValidateOnly){$plan|ConvertTo-Json;exit 0}

function Invoke-Tool([string]$Name,[string[]]$Arguments,[string]$Sql='',[int]$TimeoutMs=120000){
 $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=Join-Path $pgBin $Name
 foreach($arg in $Arguments){[void]$info.ArgumentList.Add($arg)}
 $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardInput=$true
 $capture=!($Name-eq'pg_ctl.exe'-and$Arguments-contains'start')
 $info.RedirectStandardOutput=$capture;$info.RedirectStandardError=$capture
 $info.StandardInputEncoding=[Text.UTF8Encoding]::new($false)
 if($capture){$info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false);$info.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)}
 foreach($key in @($info.Environment.Keys)){if($key.StartsWith('PG',[StringComparison]::OrdinalIgnoreCase)){[void]$info.Environment.Remove($key)}}
 $info.Environment['PGCLIENTENCODING']='UTF8';$info.Environment['PGOPTIONS']='-c statement_timeout=30000 -c lock_timeout=3000 -c timezone=UTC'
 $process=[Diagnostics.Process]::new();$process.StartInfo=$info
 $clock=[Diagnostics.Stopwatch]::StartNew();$started=$false;$timedOut=$false
 try{
  [void]$process.Start();$started=$true
  if($capture){$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()}
  # One deadline covers writing the entire stdin document, its EOF and exit.
  # A child that stops reading must not block before WaitForExit is reached.
  if($Sql){
   $write=$process.StandardInput.WriteAsync($Sql)
   $remaining=[Math]::Max(0,$TimeoutMs-[int]$clock.ElapsedMilliseconds)
   if(!$write.Wait($remaining)){$timedOut=$true}else{[void]$write.GetAwaiter().GetResult()}
  }
  if(!$timedOut){
   $closed=$process.StandardInput.DisposeAsync().AsTask()
   $remaining=[Math]::Max(0,$TimeoutMs-[int]$clock.ElapsedMilliseconds)
   if(!$closed.Wait($remaining)){$timedOut=$true}else{[void]$closed.GetAwaiter().GetResult()}
  }
  if(!$timedOut){
   $remaining=[Math]::Max(0,$TimeoutMs-[int]$clock.ElapsedMilliseconds)
   if(!$process.WaitForExit($remaining)){$timedOut=$true}
  }
  if($timedOut){
   if(!$process.HasExited){$process.Kill($true)}
   if(!$process.WaitForExit(5000)){throw 'Timed-out native child did not stop.'}
  }
  $out='Local startup output is in postgres-server.log.';$err=''
  if($capture){
   $drained=[Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($stdout,$stderr))
   if(!$drained.Wait(5000)){throw 'Bounded native output pipes did not close.'}
   $out=$stdout.GetAwaiter().GetResult();$err=$stderr.GetAwaiter().GetResult()
  }
  return [ordered]@{exit_code=$process.ExitCode;timed_out=$timedOut;stdout=$out;stderr=$err}
 }finally{
  if($started-and!$process.HasExited){try{$process.Kill($true);[void]$process.WaitForExit(5000)}catch{}}
  $process.Dispose();$clock.Stop()
 }
}
function Invoke-Sql([string]$Sql){return Invoke-Tool 'psql.exe' @('-X','-q','-w','-h',$hostName,'-p',"$port",'-U','postgres','-d',$script:databaseName,'-v','ON_ERROR_STOP=1','-P','pager=off','-At') ('\set VERBOSITY verbose'+[Environment]::NewLine+$Sql)}
function Save-Step([string]$Name,$Result){[IO.File]::WriteAllText((Join-Path $runDirectory "$Name.json"),($Result|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))}
$runId=(Get-Date).ToUniversalTime().ToString('yyyyMMdd_HHmmss')+'_'+[Guid]::NewGuid().ToString('N').Substring(0,8)
$runDirectory=Join-Path $reviewed "sandbox_restore_$runId"
[IO.Directory]::CreateDirectory($runDirectory)|Out-Null
$database='k3_recovery_'+$runId
$report=[ordered]@{scope='reviewed sandbox DDL and four orders only in a new owned local database';baseline_sha256=$validated.baseline_sha256;orders_sha256=$validated.orders_sha256;auth_fixture_simulated=$true;real_jwt_validation=$false;staff_identity_restored=$false;remote_connection=$false;remote_reset_authorized=$false;database=$database;server_started=$false;server_stopped=$false;ddl_restore_succeeded=$false;orders_restore_succeeded=$false;readback_matches=$false;source_bytes_preserved=$false;security_runtime_comparison_pending=$true;error=$null}
$attemptedStart=$false
try{
 $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port);try{$listener.Start()}finally{$listener.Stop()}
 $version=Invoke-Tool 'postgres.exe' @('--version');Save-Step '00_version' $version
 if($version.exit_code-ne0-or$version.stdout-notmatch'PostgreSQL\) 18\.'){throw 'Native PostgreSQL 18 is required.'}
 $attemptedStart=$true
 $started=Invoke-Tool 'pg_ctl.exe' @('-D',$dataDirectory,'-l',(Join-Path $runDirectory 'postgres-server.log'),'-o',"-h 127.0.0.1 -p $port",'-w','-t','30','start') '' 45000;Save-Step '01_start' $started
 if($started.exit_code-ne0){throw 'Owned local server did not start.'};$report.server_started=$true
 $script:databaseName='postgres'
 $identity=Invoke-Sql "SELECT json_build_object('host',host(inet_server_addr()),'port',inet_server_port(),'data_directory',current_setting('data_directory'),'current_user',current_user);";Save-Step '02_identity' $identity
 if($identity.exit_code-ne0){throw 'Local identity read failed.'};$seen=$identity.stdout.Trim()|ConvertFrom-Json
 if($seen.host-ne$hostName-or$seen.port-ne$port-or$seen.current_user-ne'postgres'-or![string]::Equals([IO.Path]::GetFullPath($seen.data_directory),$dataDirectory,[StringComparison]::OrdinalIgnoreCase)){throw 'Owned local endpoint identity mismatch.'}
 $created=Invoke-Sql ('CREATE DATABASE "'+$database+'";');Save-Step '03_create_unique_database' $created
 if($created.exit_code-ne0){throw 'New local database creation failed.'};$script:databaseName=$database
 $auth=@'
DO $roles$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS; END IF;
END $roles$;
CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
'@
 $fixture=Invoke-Sql $auth;Save-Step '04_empty_simulated_auth_fixture' $fixture
 if($fixture.exit_code-ne0){throw 'Empty Auth compatibility fixture failed.'}
 if((Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash.ToLowerInvariant()-ne$validated.baseline_sha256-or(Get-FileHash -LiteralPath $orders -Algorithm SHA256).Hash.ToLowerInvariant()-ne$validated.orders_sha256){throw 'Reviewed baseline or exact order bytes changed before execution.'}
 $restored=Invoke-Sql ([IO.File]::ReadAllText($baseline));Save-Step '05_reviewed_sandbox_schema' $restored
 if($restored.exit_code-ne0){throw 'Reviewed sandbox DDL restore failed; no automatic repair.'};$report.ddl_restore_succeeded=$true
 # Only base64 enters the SQL source. PostgreSQL decodes the original exact UTF-8
 # document, and EXECUTE USING binds jsonb as a value, never as executable SQL.
 # No PowerShell/JavaScript JSON round-trip can round large integers or decimals.
 $encoded=[Convert]::ToBase64String([IO.File]::ReadAllBytes($orders))
 if($encoded-notmatch'^[A-Za-z0-9+/]+={0,2}$'){throw 'Encoded recovery payload is invalid.'}
 $insertTemplate=@'
BEGIN;
DO $k3_recovery$
DECLARE payload jsonb; expected_columns text[]; columns_sql text; actual_count bigint;
BEGIN
 payload := convert_from(decode('__K3_RECOVERY_BASE64__','base64'),'UTF8')::jsonb;
 IF jsonb_typeof(payload) <> 'array' OR jsonb_array_length(payload) <> 4 THEN
   RAISE EXCEPTION 'Exactly four recovery rows required';
 END IF;
 IF (SELECT count(*) FROM public.catering_orders) <> 0 THEN
   RAISE EXCEPTION 'Recovery destination must be empty';
 END IF;
 SELECT array_agg(attname::text ORDER BY attname) INTO expected_columns
 FROM pg_attribute WHERE attrelid='public.catering_orders'::regclass AND attnum>0 AND NOT attisdropped;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(payload) value
   WHERE jsonb_typeof(value) <> 'object' OR
    (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(value) key) IS DISTINCT FROM expected_columns) THEN
   RAISE EXCEPTION 'Every original order column must be preserved';
 END IF;
 SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO columns_sql
 FROM pg_attribute WHERE attrelid='public.catering_orders'::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='';
 IF columns_sql IS NULL THEN RAISE EXCEPTION 'No writable recovery columns'; END IF;
 EXECUTE format('INSERT INTO public.catering_orders (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM jsonb_populate_recordset(NULL::public.catering_orders,$1)',columns_sql,columns_sql) USING payload;
 SELECT count(*) INTO actual_count FROM public.catering_orders;
 IF actual_count <> 4 THEN RAISE EXCEPTION 'Restored order count differs'; END IF;
END $k3_recovery$;
COMMIT;
'@
 $insertSql=$insertTemplate.Replace('__K3_RECOVERY_BASE64__',$encoded)
 $inserted=Invoke-Sql $insertSql;Save-Step '06_four_orders_restore' $inserted
 $encoded=$null;$insertSql=$null
 if($inserted.exit_code-ne0){throw 'Exact four-order restore failed; no retry or repair.'};$report.orders_restore_succeeded=$true
 $readback=Invoke-Sql "SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY id),'[]'::jsonb)::text FROM public.catering_orders o;"
 if($readback.exit_code-ne0){throw 'Full-column local readback failed.'}
 $readbackFile=Join-Path $runDirectory 'catering-orders-readback.json'
 [IO.File]::WriteAllText($readbackFile,$readback.stdout.Trim(),[Text.UTF8Encoding]::new($false))
 $comparison=& $NodeExecutable (Join-Path $PSScriptRoot 'validate-recovery.mjs') $package --readback $readbackFile --output (Join-Path $runDirectory 'readback-validation.json')
 if($LASTEXITCODE-ne0){throw 'Exact-number local readback comparison failed.'}
 $compared=($comparison-join[Environment]::NewLine)|ConvertFrom-Json
 if($compared.packageIntegrityVerified-ne$true-or$compared.localReadback.matches-ne$true){throw 'Every original order value must match local readback.'};$report.readback_matches=$true
 $inventory=Invoke-Sql "SELECT json_build_object('core_anon_usage',has_schema_privilege('anon','core','USAGE'),'core_authenticated_usage',has_schema_privilege('authenticated','core','USAGE'),'staff_rows',(SELECT count(*) FROM core.crm_staff),'auth_rows',(SELECT count(*) FROM auth.users),'tables',(SELECT coalesce(json_agg(json_build_object('schema',n.nspname,'name',c.relname,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',c.relacl::text) ORDER BY n.nspname,c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('core','public') AND c.relkind IN('r','p')),'policies',(SELECT coalesce(json_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname),'[]') FROM pg_policies p WHERE schemaname IN('core','public')));";Save-Step '07_private_security_inventory' $inventory
 if($inventory.exit_code-ne0){throw 'Local recovery security inventory failed.'}
 $security=$inventory.stdout.Trim()|ConvertFrom-Json
 if($security.core_anon_usage-ne$false-or$security.core_authenticated_usage-ne$false-or$security.staff_rows-ne0-or$security.auth_rows-ne0){throw 'Private core or identity-free local restore contract failed.'}
 $report.security_inventory_recorded=$true
}catch{$report.error=$_.Exception.Message}
finally{
 if($attemptedStart){try{$stopped=Invoke-Tool 'pg_ctl.exe' @('-D',$dataDirectory,'-m','fast','-w','-t','30','stop') '' 45000;Save-Step '99_stop' $stopped;$status=Invoke-Tool 'pg_ctl.exe' @('-D',$dataDirectory,'status') '' 10000;$report.server_stopped=($status.exit_code-eq3)}catch{$report.stop_error='Owned server stop verification failed.'}}
 $report.source_bytes_preserved=((Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash.ToLowerInvariant()-eq$validated.baseline_sha256-and(Get-FileHash -LiteralPath $orders -Algorithm SHA256).Hash.ToLowerInvariant()-eq$validated.orders_sha256)
 # Repeat full offline source/review/derivative validation after the restore.
 $after=& $python (Join-Path $PSScriptRoot 'review-sandbox-recovery.py') --validate-rendered $reviewed --expected-project-ref $ExpectedProjectRef
 $report.capture_and_review_provenance_preserved=($LASTEXITCODE-eq0)
 [IO.File]::WriteAllText((Join-Path $runDirectory 'sandbox-local-restore-report.json'),($report|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
 [ordered]@{ddl_restore_succeeded=$report.ddl_restore_succeeded;orders_restore_succeeded=$report.orders_restore_succeeded;readback_matches=$report.readback_matches;server_stopped=$report.server_stopped;source_bytes_preserved=$report.source_bytes_preserved;capture_and_review_provenance_preserved=$report.capture_and_review_provenance_preserved;staff_identity_restored=$false;real_jwt_validation=$false;remote_reset_authorized=$false;private_evidence_directory=$runDirectory}|ConvertTo-Json
}
if($report.error-or!$report.server_stopped-or!$report.source_bytes_preserved-or!$report.capture_and_review_provenance_preserved){exit 2}
exit 0
