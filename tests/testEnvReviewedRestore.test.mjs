// Preparation safety only: parse PowerShell and inspect the fixed local scope.
// No database, native PostgreSQL service or production capture is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const path=fileURLToPath(new URL('../tools/test-env/restore-reviewed-local.ps1',import.meta.url));
const shell=process.env.K3_PWSH || 'C:/Users/Talip/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
test('reviewed restore script parses without executing its body',()=>{
 const result=spawnSync(shell,['-NoProfile','-NonInteractive','-Command', '$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:K3_PARSE_FILE,[ref]$tokens,[ref]$errors);if($errors.Count){$errors|ForEach-Object{$_.Message};exit 2};Write-Output "PARSE_OK"'],{encoding:'utf8',windowsHide:true,env:{...process.env,K3_PARSE_FILE:path}});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PARSE_OK/);
});
test('restore path is local only, requires real provenance before services and never resets a database',async()=>{
 const source=await readFile(path,'utf8');
 assert.match(source,/127\.0\.0\.1/);assert.match(source,/\$port=55473/);assert.match(source,/--validate-rendered/);
 assert.ok(source.indexOf('--validate-rendered')<source.indexOf('if($ValidateOnly)'));
 assert.ok(source.indexOf('if($ValidateOnly)')<source.indexOf('$attemptedStart=$true'));
 assert.match(source,/existing owned local PostgreSQL cluster is required/);
 assert.match(source,/CREATE DATABASE/);assert.match(source,/k3_schema_/);
 assert.match(source,/finally\{\s+if\(\$attemptedStart\)/);
 assert.match(source,/security_runtime_comparison_pending=\$true/);
 assert.doesNotMatch(source,/DROP DATABASE|dropdb|Remove-Item|supabase\s+(?:db|link|start)|https:\/\/[^'"\s]+\/rest\//i);
 assert.doesNotMatch(source,/REPLACE_WITH_NEW_PROJECT_REF|pg_get_functiondef.*UPDATE/i);
});
