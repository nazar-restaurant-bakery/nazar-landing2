#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ReviewedDirectory,[switch]$ValidateOnly)
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$workspace=[IO.Path]::GetFullPath((Join-Path $repoRoot '../..'))
$privateRoot=[IO.Path]::GetFullPath((Join-Path $workspace '20_Yonetim/Teslim_Raporlari/K3_kanit/production-schema-private'))
$reviewed=[IO.Path]::GetFullPath($ReviewedDirectory)
if(!$reviewed.StartsWith($privateRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Only an actual reviewed production capture inside the private root is allowed.'}
$dataDirectory=[IO.Path]::GetFullPath((Join-Path $workspace 'tmp/k3-postgres-data'))
$ownerFile="$dataDirectory.k3-owner.json"
$pgBin='C:\Users\Talip\scoop\apps\postgresql\current\bin'
$python='C:\Users\Talip\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$hostName='127.0.0.1';$port=55473
$baseline=Join-Path $reviewed 'reviewed-baseline.sql'
if(!(Test-Path -LiteralPath $ownerFile -PathType Leaf)-or!(Test-Path -LiteralPath (Join-Path $dataDirectory 'PG_VERSION') -PathType Leaf)){throw 'The existing owned local PostgreSQL cluster is required; no cluster is initialized.'}
$owner=Get-Content -LiteralPath $ownerFile -Raw|ConvertFrom-Json
if($owner.owner_tag-ne'nazar-k3-native-probe-v1'-or$owner.actual_host-ne$hostName-or$owner.actual_port-ne$port-or$owner.data_directory-ne$dataDirectory){throw 'Local ownership marker mismatch.'}
foreach($path in @($reviewed,$dataDirectory)){
 $current=Get-Item -LiteralPath $path
 while($null-ne$current){if($current.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'Reparse paths are not allowed.'};$current=$current.Parent}
}
foreach($name in @('postgres.exe','pg_ctl.exe','psql.exe')){if(!(Test-Path -LiteralPath (Join-Path $pgBin $name) -PathType Leaf)){throw 'Required native PostgreSQL binary missing.'}}
# The Python checker is offline, verifies the raw capture/review/output hash
# chain and fails if any selected entry or reviewed SQL changed.
$validation=& $python (Join-Path $PSScriptRoot 'review-schema.py') --validate-rendered $reviewed
if($LASTEXITCODE-ne0){throw 'Actual reviewed baseline provenance validation failed.'}
$validated=($validation-join[Environment]::NewLine)|ConvertFrom-Json
if($validated.status-ne'REVIEWED_LOCAL_INPUT_VALIDATED_NOT_RESTORED'-or$validated.remote_connection-ne$false){throw 'Reviewed input validation did not establish local-only scope.'}
$plan=[ordered]@{scope='actual production schema, owned local PostgreSQL only';host=$hostName;port=$port;data_directory=$dataDirectory;baseline_sha256=$validated.baseline_sha256;starts_services=$false;remote_connection=$false;copies_rows=$false;auth_fixture_simulated=$true;real_jwt_validation=$false;remote_reset_authorized=$false}
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
 $info.Environment['PGCLIENTENCODING']='UTF8';$info.Environment['PGOPTIONS']='-c statement_timeout=30000 -c lock_timeout=3000'
 $process=[Diagnostics.Process]::new();$process.StartInfo=$info;[void]$process.Start()
 if($capture){$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()}
 if($Sql){$process.StandardInput.Write($Sql)};$process.StandardInput.Close()
 $finished=$process.WaitForExit($TimeoutMs)
 if(!$finished){$process.Kill($true);$process.WaitForExit()}
 $out='Local startup output is in postgres-server.log.';$err=''
 if($capture){if(!$stdout.Wait(5000)-or!$stderr.Wait(5000)){throw 'Bounded native output pipe did not close.'};$out=$stdout.GetAwaiter().GetResult();$err=$stderr.GetAwaiter().GetResult()}
 $result=[ordered]@{exit_code=$process.ExitCode;timed_out=(!$finished);stdout=$out;stderr=$err};$process.Dispose();return $result
}
function Invoke-Sql([string]$Sql){return Invoke-Tool 'psql.exe' @('-X','-q','-w','-h',$hostName,'-p',"$port",'-U','postgres','-d',$script:databaseName,'-v','ON_ERROR_STOP=1','-P','pager=off','-At') ('\set VERBOSITY verbose'+[Environment]::NewLine+$Sql)}
function Save-Step([string]$Name,$Result){[IO.File]::WriteAllText((Join-Path $runDirectory "$Name.json"),($Result|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))}
$runId=(Get-Date).ToUniversalTime().ToString('yyyyMMdd_HHmmss')+'_'+[Guid]::NewGuid().ToString('N').Substring(0,8)
$runDirectory=Join-Path $reviewed "local_restore_$runId"
[IO.Directory]::CreateDirectory($runDirectory)|Out-Null
$database='k3_schema_'+$runId
$report=[ordered]@{scope='Actual reviewed production DDL restored only in a new owned local database; no rows or hosted Auth copied.';baseline_sha256=$validated.baseline_sha256;auth_fixture_simulated=$true;real_jwt_validation=$false;remote_connection=$false;remote_reset_authorized=$false;database=$database;server_started=$false;server_stopped=$false;ddl_restore_succeeded=$false;security_runtime_comparison_pending=$true;baseline_bytes_preserved=$false;error=$null}
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
 if((Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash.ToLowerInvariant()-ne$validated.baseline_sha256){throw 'Reviewed baseline changed before execution.'}
 $restored=Invoke-Sql ([IO.File]::ReadAllText($baseline));Save-Step '05_reviewed_actual_schema' $restored
 if($restored.exit_code-ne0){throw 'Actual reviewed DDL restore failed; no automatic repair or replay.'}
 $report.ddl_restore_succeeded=$true
 $inventory=@'
SELECT json_build_object(
 'core_anon_usage',has_schema_privilege('anon','core','USAGE'),
 'core_authenticated_usage',has_schema_privilege('authenticated','core','USAGE'),
 'tables',(SELECT coalesce(json_agg(json_build_object('schema',n.nspname,'name',c.relname,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',c.relacl::text) ORDER BY n.nspname,c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('core','public') AND c.relkind IN('r','p')),
 'routines',(SELECT coalesce(json_agg(json_build_object('identity',p.oid::regprocedure::text,'security_definer',p.prosecdef,'settings',p.proconfig,'acl',p.proacl::text,'definition_md5',md5(pg_get_functiondef(p.oid))) ORDER BY p.oid::regprocedure::text),'[]') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('core','public') AND p.prokind IN('f','p')),
 'policies',(SELECT coalesce(json_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname),'[]') FROM pg_policies p WHERE schemaname IN('core','public')),
 'default_acls',(SELECT coalesce(json_agg(json_build_object('schema',n.nspname,'role',a.defaclrole::regrole::text,'kind',a.defaclobjtype,'acl',a.defaclacl::text) ORDER BY n.nspname,a.defaclobjtype),'[]') FROM pg_default_acl a JOIN pg_namespace n ON n.oid=a.defaclnamespace WHERE n.nspname IN('core','public')));
'@
 $snapshot=Invoke-Sql $inventory;Save-Step '06_private_security_inventory' $snapshot
 if($snapshot.exit_code-ne0){throw 'Local schema/security inventory failed.'}
 $security=$snapshot.stdout.Trim()|ConvertFrom-Json
 if($security.core_anon_usage-ne$false-or$security.core_authenticated_usage-ne$false){throw 'Reviewed private core access contract did not remain closed.'}
 $report.security_inventory_recorded=$true
}catch{$report.error=$_.Exception.Message}
finally{
 if($attemptedStart){try{$stopped=Invoke-Tool 'pg_ctl.exe' @('-D',$dataDirectory,'-m','fast','-w','-t','30','stop') '' 45000;Save-Step '99_stop' $stopped;$status=Invoke-Tool 'pg_ctl.exe' @('-D',$dataDirectory,'status') '' 10000;$report.server_stopped=($status.exit_code-eq3)}catch{$report.stop_error='Owned server stop verification failed.'}}
 $report.baseline_bytes_preserved=((Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash.ToLowerInvariant()-eq$validated.baseline_sha256)
 [IO.File]::WriteAllText((Join-Path $runDirectory 'local-restore-report.json'),($report|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
 # Raw SQL and native errors remain in the private evidence directory.
 [ordered]@{ddl_restore_succeeded=$report.ddl_restore_succeeded;server_stopped=$report.server_stopped;baseline_bytes_preserved=$report.baseline_bytes_preserved;security_runtime_comparison_pending=$true;remote_reset_authorized=$false;private_evidence_directory=$runDirectory}|ConvertTo-Json
}
if($report.error-or!$report.server_stopped-or!$report.baseline_bytes_preserved){exit 2}
exit 0
