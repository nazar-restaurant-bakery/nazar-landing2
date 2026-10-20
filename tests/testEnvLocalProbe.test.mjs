// Pure safety validation; never start PostgreSQL, Docker, Supabase or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const script=path.join(repo,'tools/test-env/probe-local.ps1');
const shell=process.env.K3_PWSH || 'C:/Users/Talip/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
const invoke=(args=[])=>spawnSync(shell,['-NoProfile','-NonInteractive','-File',script,'-ValidateOnly',...args],{encoding:'utf8',windowsHide:true});
test('validation reports single-tenant compatibility-only local scope without cluster mutation',()=>{
 const result=invoke();assert.equal(result.status,0,result.stderr);
 const plan=JSON.parse(result.stdout);
 assert.equal(plan.actual_host,'127.0.0.1');assert.equal(plan.actual_port,55473);assert.equal(plan.metadata_simulated,true);
 assert.equal(plan.real_jwt_validation,false);assert.equal(plan.production_or_staging_proof,false);
 assert.equal(plan.starts_services,false);assert.equal(plan.emergency_pause_excluded,true);assert.equal(plan.planned_incrementals,17);
});
test('foreign data directory and another port are rejected before mutation',()=>{
 for(const args of [['-DataDirectory','C:/Windows'],['-Port','5432']]){
  const result=invoke(args);assert.notEqual(result.status,0);assert.match(result.stderr,/Only the fixed|Only loopback/);
 }
});
test('source ownership, cleanup and stop-first-error safety contract is explicit',async()=>{
 const text=await fs.readFile(script,'utf8');
 assert.match(text,/Existing data directory has no K3 ownership marker/);
 assert.match(text,/source_sql_bytes_preserved/);
 assert.match(text,/finally\{\s+if\(\$owned-and\$attemptedStart\)/);
 assert.match(text,/if\(\$migration.exit_code-ne0\)[\s\S]*?;break\}/);
 assert.doesNotMatch(text,/Remove-Item|dropdb|DROP DATABASE|https:\/\/[^'"]+\/rest\/|supabase\s+(?:start|link|db)/i);
});

test('LF normalization is explicitly disclosed in the validation plan without starting a server',()=>{
 const result=invoke(['-NormalizeLineEndings']);assert.equal(result.status,0,result.stderr);
 const plan=JSON.parse(result.stdout);assert.equal(plan.sql_line_endings,'CRLF_to_LF');assert.equal(plan.source_sql_modified,false);assert.equal(plan.starts_services,false);
});