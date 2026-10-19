// Exercise only the extracted process helper against Node children. No restore
// script body, PostgreSQL service, owned cluster, capture or network is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,mkdtemp,writeFile,realpath,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const shell=process.env.K3_PWSH || 'C:/Users/Talip/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
const temporaryRoot=await realpath(fileURLToPath(new URL('../../',import.meta.url)));
const helpers=['restore-reviewed-local.ps1','restore-sandbox-recovery-local.ps1'];

async function runChild(helper,mode){
 const source=await readFile(new URL('../tools/test-env/'+helper,import.meta.url),'utf8');
 const start=source.indexOf('function Invoke-Tool(');
 const end=source.indexOf('\nfunction Invoke-Sql(',start);
 assert.ok(start>=0 && end>start,'Only the process helper is extracted');
 const directory=await mkdtemp(join(temporaryRoot,'nazar-child-deadline-unit-'));
 try{
  const script=join(directory,'fake-child.ps1');
  const payload=mode==='blocked' ? "('x' * (16 * 1024 * 1024))" : "\"SELECT 'Yücel';`n\"";
  await writeFile(script,"$ErrorActionPreference='Stop'\n"+source.slice(start,end)+`\n$pgBin=[IO.Path]::GetDirectoryName($env:K3_FAKE_NODE)
$clock=[Diagnostics.Stopwatch]::StartNew()
$result=Invoke-Tool ([IO.Path]::GetFileName($env:K3_FAKE_NODE)) @('-e',$env:K3_FAKE_CHILD_CODE) ${payload} ${mode==='blocked'?500:5000}
$clock.Stop()
[ordered]@{result=$result;elapsed_ms=$clock.ElapsedMilliseconds}|ConvertTo-Json -Depth 6 -Compress
`,'utf8');
  const childCode=mode==='blocked'
   ? 'process.stdout.write(JSON.stringify({pid:process.pid}));process.stdin.pause();setTimeout(()=>{},30000);'
   : "const c=[];process.stdin.on('data',v=>c.push(v));process.stdin.on('end',()=>{const b=Buffer.concat(c);process.stdout.write(JSON.stringify({sha256:require('node:crypto').createHash('sha256').update(b).digest('hex'),bytes:b.length,pgHostPresent:Object.hasOwn(process.env,'PGHOST'),pgPasswordPresent:Object.hasOwn(process.env,'PGPASSWORD'),encoding:process.env.PGCLIENTENCODING,options:process.env.PGOPTIONS}));});";
  const result=spawnSync(shell,['-NoProfile','-NonInteractive','-File',script],{
   encoding:'utf8',windowsHide:true,timeout:12000,maxBuffer:1024*1024,
   env:{...process.env,K3_FAKE_NODE:process.execPath,K3_FAKE_CHILD_CODE:childCode,
    PGHOST:'synthetic.invalid',PGPASSWORD:'SYNTHETIC_NOT_A_CREDENTIAL'},
  });
  assert.equal(result.status,0,result.error?.message || result.stderr);
  return JSON.parse(result.stdout.replace(/^\uFEFF/,''));
 }finally{
  // Resolve and verify the exact disposable test target before recursive cleanup.
  const target=await realpath(directory);
  assert.equal(dirname(target),temporaryRoot);
  assert.ok(basename(target).startsWith('nazar-child-deadline-unit-'));
  assert.ok(resolve(target).startsWith(temporaryRoot+sep));
  await rm(target,{recursive:true});
 }
}

for(const helper of helpers){
 test(helper+' kills a non-consuming child within its stdin/exit deadline',async()=>{
  const {result,elapsed_ms}=await runChild(helper,'blocked');
  assert.equal(result.timed_out,true);
  assert.notEqual(result.exit_code,0);
  assert.ok(elapsed_ms<7000,'The write cannot wait for the child\'s 30-second lifetime');
  const {pid}=JSON.parse(result.stdout);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 });

 test(helper+' completes EOF with BOM-free UTF-8 and strips inherited PG settings',async()=>{
  const {result}=await runChild(helper,'normal');
  assert.equal(result.timed_out,false);
  assert.equal(result.exit_code,0,result.stderr);
  const value=JSON.parse(result.stdout);
  const bytes=Buffer.from("SELECT 'Yücel';\n",'utf8');
  assert.equal(value.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(value.bytes,bytes.length);
  assert.equal(value.pgHostPresent,false);
  assert.equal(value.pgPasswordPresent,false);
  assert.equal(value.encoding,'UTF8');
  assert.equal(value.options,'-c statement_timeout=30000 -c lock_timeout=3000 -c timezone=UTC');
 });
}
