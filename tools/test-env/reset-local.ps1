#requires -Version 7.0
[CmdletBinding()]
param([switch]$ValidateOnly,[string]$SupabaseExecutable='supabase')
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$config=Join-Path $repoRoot 'supabase/config.toml'
if(!(Test-Path -LiteralPath $config -PathType Leaf)){throw 'Local Supabase configuration is missing.'}
$node=(Get-Command node -ErrorAction Stop).Source
$auditText=& $node (Join-Path $PSScriptRoot 'audit-migrations.mjs') --json
$auditExit=$LASTEXITCODE
$audit=($auditText -join [Environment]::NewLine)|ConvertFrom-Json
$ready=$audit.integrity.ok -and $audit.readiness.ready -and $auditExit-eq0
if($ValidateOnly){
 [ordered]@{mode='local_only';ready=$ready;remote_reset_supported=$false;executes_sql=$false;blockers=$audit.readiness.blockers}|ConvertTo-Json -Depth 12
 if(!$ready){exit 2};exit 0
}
if(!$ready){throw 'Reset blocked: reviewed canonical baseline and full replay evidence are required. No reset command ran.'}
# Explicit --local only: this entry point never resets a linked/remote project.
Push-Location -LiteralPath $repoRoot
try{
 & $SupabaseExecutable db reset --local --no-seed
 if($LASTEXITCODE-ne0){throw 'Local reset failed. Seed was not run.'}
}finally{Pop-Location}
