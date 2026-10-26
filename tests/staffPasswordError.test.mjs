import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
const source = await readFile(new URL('../src/lib/staffPasswordError.ts',import.meta.url),'utf8');
const {staffPasswordError} = await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
for(const [error,expected] of [
 [{status:403,code:'session_not_found'},'session'],[{code:'session_expired'},'session'],
 [{code:'refresh_token_not_found'},'session'],[{status:401},'session'],[{name:'AuthSessionMissingError'},'session'],
 [{status:401,code:'insufficient_aal'},'reauthentication'],[{status:401,code:'reauthentication_needed'},'reauthentication'],
 [{code:'reauthentication_needed'},'reauthentication'],[{code:'current_password_required'},'reauthentication'],
 [{code:'same_password'},'same'],[{code:'weak_password'},'weak'],[{status:429},'limit'],
 [{status:403},'denied'],[new Error('PRIVATE_SYNTHETIC_DETAIL'),'unknown'],[null,'unknown'],
 [{code:'PRIVATE_SYNTHETIC_DETAIL',status:500},'unknown'],
])test('safe fixed error category '+expected+' '+JSON.stringify(error),()=>assert.equal(staffPasswordError(error),expected));
test('actual installed SDK: GET user 200 does not prevent later PUT session_not_found; no automatic PUT retry',async()=>{
 const calls=[];
 const user={id:'11111111-1111-4111-8111-111111111111',aud:'authenticated',role:'authenticated',email:'synthetic@example.invalid',app_metadata:{},user_metadata:{},created_at:'2026-01-01T00:00:00Z'};
 const token=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,sub:user.id})).toString('base64url')+'.c3ludGhldGlj';
 const client=createClient('https://synthetic.invalid','synthetic-publishable-key',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(url,options)=>{
  const path=new URL(url).pathname;const method=options?.method||'GET';calls.push({path,method});
  assert.equal(path,'/auth/v1/user');assert.ok(['GET','PUT'].includes(method));
  return Response.json(method==='GET'?user:{code:'session_not_found',msg:'PRIVATE_SYNTHETIC_DETAIL'},{status:method==='GET'?200:403,headers:{'x-supabase-api-version':'2024-01-01'}});
 }}});
 assert.equal((await client.auth.setSession({access_token:token,refresh_token:'synthetic-refresh'})).error,null);
 assert.equal((await client.auth.getUser()).error,null);
 const result=await client.auth.updateUser({password:'SYNTHETIC_ONLY_PASSWORD'});
 // auth-js normalizes wire 403/session_not_found to AuthSessionMissingError (400).
 assert.equal(result.error.name,'AuthSessionMissingError');assert.equal(result.error.status,400);assert.equal(staffPasswordError(result.error),'session');
 assert.equal(calls.filter(x=>x.method==='PUT').length,1);
 assert.equal(calls.some(x=>x.path.includes('token')),false);
});
