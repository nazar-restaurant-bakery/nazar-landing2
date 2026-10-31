import test from 'node:test';import assert from 'node:assert/strict';
import {verifyMachine,machineSignature} from '../functions/_lib/dailySchedulerAuth.ts';
import {dailyCloverHandler} from '../functions/api/internal/daily-clover-pull.ts';
import {dailyHandler} from '../supabase/functions/daily-ops-run/index.ts';
import {NAZAR_BUSINESS} from '../supabase/functions/ops-collect/contracts.ts';
const secret='synthetic-machine-key-not-used-anywhere-live-123456';
const id='22222222-2222-4222-8222-222222222222',nonce='33333333-3333-4333-8333-333333333333',token='44444444-4444-4444-8444-444444444444';
const baseBody=(business=NAZAR_BUSINESS)=>({business_id:business,run_id:id,nonce,issued_at:Math.floor(Date.now()/1000)});
test('machine scope binds tenant/run/nonce/time; collect key cannot sign an arbitrary write action',async()=>{
 const b=baseBody(),sig=await machineSignature('daily.dispatch.v1',b,secret);
 assert.equal(await verifyMachine('daily.dispatch.v1',b,sig,secret),true);
 for(const x of [{...b,business_id:nonce},{...b,nonce:token},{...b,operation:'ops.write'},{...b,issued_at:b.issued_at-301}])assert.equal(await verifyMachine('daily.dispatch.v1',x,sig,secret),false);
 assert.equal(await verifyMachine('daily.clover.v1',b,sig,secret),false);
});
test('scheduled K7 path uses exact closed-day window, shared quota, same ingest RPC and rejects replay',async()=>{
 const business='11111111-1111-4111-8111-111111111111';
 const env={APP_ENV:'isolated-test',TEST_SUPABASE_URL:'https://'+'s'.repeat(20)+'.supabase.co',TEST_BUSINESS_ID:business,TEST_SUPABASE_SECRET_KEY:'sb_secret_synthetic_only',TEST_TURNSTILE_SECRET_KEY:'1x0000000000000000000000000000000AA',TEST_TURNSTILE_EXPECTED_HOSTNAME:'preview.pages.dev',VITE_TEST_SUPABASE_ANON_KEY:'sb_publishable_synthetic_only',TEST_CLOVER_MERCHANT_ID:'MERCHANT123',TEST_CLOVER_ORDERS_ACCESS_TOKEN:'synthetic-clover-token',TEST_CLOVER_ONLINE_ORDER_TYPE_IDS:'ONLINE12345',SCHEDULER_SIGNING_SECRET:secret};
 const start=Date.parse('2026-03-08T05:00:00Z'),end=Date.parse('2026-03-09T04:00:00Z');
 const b={...baseBody(business),claim_token:token,start_ms:start,end_ms:end};
 let claimed=false,reserves=0,providers=0,ingests=0;let denyBudget=false;
 const fetch=async(input,init)=>{
  const u=new URL(input);
  if(u.hostname===('s'.repeat(20)+'.supabase.co')){
   const name=u.pathname.split('/').at(-1),args=JSON.parse(init.body);assert.equal(args.p_business_id,business);
   if(name==='daily_clover_claim'){if(claimed)return Response.json(false);claimed=true;return Response.json(true);}
   if(name==='daily_run_check'||name==='daily_clover_finish')return Response.json(true);
   if(name==='daily_reserve_external_request'){reserves++;return Response.json(!denyBudget);}
   if(name==='clover_order_ingest_v1'){ingests++;assert.equal(args.p_snapshot.id,'ORDER123456');return Response.json({ok:true});}
   throw Error('unexpected DB method');
  }
  assert.equal(u.hostname,'apisandbox.dev.clover.com');providers++;
  if(u.pathname.endsWith('/orders')&&u.searchParams.getAll('filter')[0].startsWith('modifiedTime')){
   assert.deepEqual(u.searchParams.getAll('filter'),['modifiedTime>='+start,'modifiedTime<='+(end-1),'createdTime<'+start]);return Response.json({elements:[]});}
  if(u.pathname.endsWith('/orders')){assert.deepEqual(u.searchParams.getAll('filter'),['createdTime>='+start,'createdTime<='+(end-1)]);return Response.json({elements:[{id:'ORDER123456',createdTime:start+1000}]});}
  const expand=u.searchParams.get('expand');
  if(expand==='refunds')return Response.json({id:'ORDER123456',refunds:{elements:[]}});
  if(expand==='customers')return Response.json({id:'ORDER123456',customers:{elements:[]}});
  return Response.json({id:'ORDER123456',createdTime:start+1000,orderType:{id:'ONLINE12345'},lineItems:{elements:[]},payments:{elements:[]}});
 };
 const handler=dailyCloverHandler(fetch);
 const request=async body=>new Request('https://preview.pages.dev/api/internal/daily-clover-pull',{method:'POST',headers:{'X-Scheduler-Signature':await machineSignature('daily.clover.v1',body,secret)},body:JSON.stringify(body)});
 assert.equal((await handler({request:await request(b),env})).status,200);
 // 4 created-window requests + 1 empty modified-window listing.
 assert.equal(ingests,1);assert.equal(providers,5);assert.equal(reserves,5);
 assert.equal((await handler({request:await request(b),env})).status,409);assert.equal(providers,5);
 claimed=false;denyBudget=true;
 const denied=await handler({request:await request(b),env});assert.equal((await denied.json()).code,'budget_exhausted');assert.equal(providers,5);
 assert.equal((await handler({request:await request({...b,business_id:token}),env})).status,403);
});
function runner(mode='ok'){
 const b=baseBody(),calls=[];let starts=0,finished=null;let reserves=0;
 const env={SUPABASE_URL:'https://'+'s'.repeat(20)+'.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',SCHEDULER_SIGNING_SECRET:secret};
 const fetch=async(input,init)=>{
  const u=new URL(input);calls.push(u.hostname+u.pathname);
  if(u.origin===env.SUPABASE_URL){const name=u.pathname.split('/').at(-1),args=JSON.parse(init.body);assert.equal(args.p_business_id,NAZAR_BUSINESS);
   if(name==='daily_scheduler_start'){starts++;return Response.json(starts>1?null:{business_id:NAZAR_BUSINESS,id,claim_token:token,clover_url:'https://tenant.example/api/internal/daily-clover-pull',start_ms:1,end_ms:86400001});}
   if(name==='daily_ops_snapshot')return Response.json({previous:[],metrics:[],capabilities:[],scheduler:{}});
   if(name==='daily_run_check')return Response.json(mode!=='paused');
   if(name==='daily_reserve_external_request'){reserves++;return Response.json(mode!=='budget');}
   if(name==='daily_commit_ops')return Response.json(true);
   if(name==='daily_scheduler_finish'){finished=args;return Response.json({status:'done'});}
   throw Error('unexpected RPC');
  }
  if(u.hostname==='tenant.example'){
   const body=JSON.parse(init.body);assert.equal(await verifyMachine('daily.clover.v1',body,init.headers['X-Scheduler-Signature'],secret),true);
   if(mode==='fetch-error')throw new TypeError('PRIVATE network detail');
   if(mode==='timeout')throw new DOMException('PRIVATE','TimeoutError');
   if(mode==='edge-html')return new Response('<html>PRIVATE challenge page '+token+'</html>',{status:403,headers:{'Content-Type':'text/html; charset=UTF-8',Server:'cloudflare','CF-RAY':'8f00000000000000-EWR','cf-mitigated':'challenge'}});
   return mode==='clover-error'?Response.json({code:'clover_failed',detail:'clover_http_error_500',step:'list',stage:'collect'},{status:503}):mode==='error-name'?Response.json({code:'clover_failed',detail:'unexpected_TypeError',step:null,stage:'ingest'},{status:503}):mode==='unsafe-detail'?Response.json({code:'clover_failed',detail:'PRIVATE Detail text',step:'order core!',stage:'Collect stage!'},{status:503}):Response.json({code:'succeeded',reconciled:false});
  }
  assert.equal(u.href,'https://www.nazarrestaurantandbakery.com/');return new Response('synthetic site');
 };
 const request=async()=>new Request('https://example.invalid',{method:'POST',headers:{'X-Scheduler-Signature':await machineSignature('daily.dispatch.v1',b,secret)},body:JSON.stringify(b)});
 return {env,fetch,request,calls,get finished(){return finished;},get reserves(){return reserves;}};
}
test('Clover precedes Ops, dispatcher replay does not run twice, no arbitrary endpoint is used',async()=>{
 const h=runner(),handle=dailyHandler(h.fetch);assert.equal((await handle(await h.request(),h.env)).status,200);
 assert.ok(h.calls.findIndex(x=>x.startsWith('tenant.example'))<h.calls.findIndex(x=>x.endsWith('/daily_ops_snapshot')));
 assert.equal(h.finished.p_code,'collected');assert.equal(h.reserves,1);
 assert.equal((await handle(await h.request(),h.env)).status,409);
 assert.equal(h.calls.filter(x=>x.startsWith('tenant.example')).length,1);
});
test('budget/pause/error receipts persist, errors never turn into reconciliation or blind retries',async()=>{
 for(const mode of ['budget','paused','clover-error']){
  const h=runner(mode);await dailyHandler(h.fetch)(await h.request(),h.env);
  assert.equal(h.finished.p_code,mode==='budget'?'budget_exhausted':mode==='paused'?'paused':'clover_failed');
  assert.equal(h.calls.filter(x=>x.startsWith('tenant.example')).length,1);
  if(mode==='clover-error')assert.equal(h.calls.some(x=>x.endsWith('/daily_ops_snapshot')),false);
 }
});
test('gateway ack registers background work; missing signature causes no Auth/RPC/provider call',async()=>{
 const h=runner(),pending=[];const r=await dailyHandler(h.fetch,()=>Date.now(),p=>pending.push(p))(await h.request(),h.env);
 assert.equal(r.status,202);assert.equal(pending.length,1);await Promise.all(pending);assert.equal(h.finished.p_code,'collected');
 const denied=runner();assert.equal((await dailyHandler(denied.fetch)(new Request('https://example.invalid',{method:'POST',body:'{}'}),denied.env)).status,401);assert.equal(denied.calls.length,0);
});
function captureInfo(){const lines=[],original=console.info;console.info=(...a)=>lines.push(a.join(' '));return {lines,restore:()=>{console.info=original;}};}
const diagLines=lines=>lines.filter(l=>l.startsWith('daily_clover_pull_diag ')).map(l=>JSON.parse(l.slice('daily_clover_pull_diag '.length)));
test('one diagnostic line per pull: edge-answered HTML is visible without body text or secrets',async()=>{
 const cases={
  ok:[{host:'tenant.example',status:200,redirected:false,content_type:'application/json',server:null,cf_ray_present:false,cf_mitigated:null,body_code:'succeeded',body_detail:null,body_step:null,body_stage:null,json:true},'collected'],
  'clover-error':[{host:'tenant.example',status:503,redirected:false,content_type:'application/json',server:null,cf_ray_present:false,cf_mitigated:null,body_code:'clover_failed',body_detail:'clover_http_error_500',body_step:'list',body_stage:'collect',json:true},'clover_failed'],
  'edge-html':[{host:'tenant.example',status:403,redirected:false,content_type:'text/html; charset=UTF-8',server:'cloudflare',cf_ray_present:true,cf_mitigated:'challenge',body_code:null,body_detail:null,body_step:null,body_stage:null,json:false},'clover_failed'],
  'error-name':[{host:'tenant.example',status:503,redirected:false,content_type:'application/json',server:null,cf_ray_present:false,cf_mitigated:null,body_code:'clover_failed',body_detail:'unexpected_TypeError',body_step:null,body_stage:'ingest',json:true},'clover_failed'],
  'unsafe-detail':[{host:'tenant.example',status:503,redirected:false,content_type:'application/json',server:null,cf_ray_present:false,cf_mitigated:null,body_code:'clover_failed',body_detail:null,body_step:null,body_stage:null,json:true},'clover_failed']};
 for(const [mode,[expected,code]] of Object.entries(cases)){
  const h=runner(mode),log=captureInfo();
  try{await dailyHandler(h.fetch)(await h.request(),h.env);}finally{log.restore();}
  assert.deepEqual(diagLines(log.lines),[expected],mode);assert.equal(h.finished.p_code,code,mode);
  for(const secretText of [token,secret,'PRIVATE','synthetic-service','<html'])assert.ok(!log.lines.join('').includes(secretText),mode+' '+secretText);
 }
});
test('a thrown pull fetch logs only host and error name; the run still finishes as execution_failed',async()=>{
 // daily_scheduler_finish does not accept clover_unreachable, so the run code is unchanged.
 for(const [mode,name] of [['fetch-error','TypeError'],['timeout','TimeoutError']]){
  const h=runner(mode),log=captureInfo();
  try{assert.equal((await dailyHandler(h.fetch)(await h.request(),h.env)).status,503);}finally{log.restore();}
  assert.deepEqual(diagLines(log.lines),[{host:'tenant.example',fetch_error:name}]);
  assert.equal(h.finished.p_code,'execution_failed');assert.equal(h.finished.p_ops_status,'failed');
  assert.equal(h.calls.some(x=>x.endsWith('/daily_ops_snapshot')),false);
  assert.ok(!log.lines.join('').includes('PRIVATE'));
 }
});
function pagesPull({cloverStatus=200,ingestOk=true,claim='ok',ingestThrows=false,ingestError=null,finishThrows=false}={}){
 const business='11111111-1111-4111-8111-111111111111';
 const env={APP_ENV:'isolated-test',TEST_SUPABASE_URL:'https://'+'s'.repeat(20)+'.supabase.co',TEST_BUSINESS_ID:business,TEST_SUPABASE_SECRET_KEY:'sb_secret_synthetic_only',TEST_TURNSTILE_SECRET_KEY:'1x0000000000000000000000000000000AA',TEST_TURNSTILE_EXPECTED_HOSTNAME:'preview.pages.dev',VITE_TEST_SUPABASE_ANON_KEY:'sb_publishable_synthetic_only',TEST_CLOVER_MERCHANT_ID:'MERCHANT123',TEST_CLOVER_ORDERS_ACCESS_TOKEN:'synthetic-clover-token',TEST_CLOVER_ONLINE_ORDER_TYPE_IDS:'ONLINE12345',SCHEDULER_SIGNING_SECRET:secret};
 const start=Date.parse('2026-03-08T05:00:00Z'),end=Date.parse('2026-03-09T04:00:00Z');
 const b={...baseBody(business),claim_token:token,start_ms:start,end_ms:end};const finishes=[];
 const fetch=async(input,init)=>{
  const u=new URL(input);
  if(u.hostname===('s'.repeat(20)+'.supabase.co')){
   const name=u.pathname.split('/').at(-1),args=JSON.parse(init.body);
   if(name==='daily_clover_claim')return claim==='db-down'?new Response('PRIVATE db text',{status:500}):claim==='empty'?new Response('',{status:200}):claim==='not-json'?new Response('PRIVATE <html>',{status:200}):Response.json(true);
   if(name==='daily_run_check'||name==='daily_reserve_external_request')return Response.json(true);
   if(name==='daily_clover_finish'){finishes.push(args.p_status);if(finishThrows&&args.p_status!=='failed')throw new TypeError('PRIVATE '+token);return Response.json(true);}
   if(name==='clover_order_ingest_v1'){if(ingestThrows)throw new TypeError('PRIVATE network '+token);if(ingestError)throw ingestError();return ingestOk?Response.json({ok:true}):new Response('PRIVATE',{status:500});}
   throw Error('unexpected DB method');
  }
  if(cloverStatus!==200)return new Response('PRIVATE clover body synthetic-clover-token',{status:cloverStatus});
  if(u.pathname.endsWith('/orders')&&u.searchParams.getAll('filter')[0].startsWith('modifiedTime'))return Response.json({elements:[]});
  if(u.pathname.endsWith('/orders'))return Response.json({elements:[{id:'ORDER123456',createdTime:start+1000}]});
  const expand=u.searchParams.get('expand');
  if(expand==='refunds')return Response.json({id:'ORDER123456',refunds:{elements:[]}});
  if(expand==='customers')return Response.json({id:'ORDER123456',customers:{elements:[]}});
  return Response.json({id:'ORDER123456',createdTime:start+1000,orderType:{id:'ONLINE12345'},lineItems:{elements:[]},payments:{elements:[]}});
 };
 const run=async()=>{
  const warns=[],original=console.warn;console.warn=(...a)=>warns.push(a);
  try{const r=await dailyCloverHandler(fetch)({request:new Request('https://preview.pages.dev/api/internal/daily-clover-pull',{method:'POST',headers:{'X-Scheduler-Signature':await machineSignature('daily.clover.v1',b,secret)},body:JSON.stringify(b)}),env});
   return {status:r.status,body:await r.json(),warns,finishes};}finally{console.warn=original;}
 };
 return run;
}
test('failed Clover pull reports a safe detail and step in the 503 and one warning',async()=>{
 const cases=[
  [{cloverStatus:500},{code:'clover_failed',detail:'clover_http_error_500',step:'list',stage:'collect'}],
  [{cloverStatus:401},{code:'clover_failed',detail:'clover_access_denied_401',step:'list',stage:'collect'}],
  [{ingestOk:false},{code:'clover_failed',detail:'ingest_failed',step:'ingest',stage:'ingest'}],
  [{claim:'db-down'},{code:'clover_failed',detail:'database_unavailable',step:null,stage:'claim'}],
  [{claim:'empty'},{code:'clover_failed',detail:'database_response_invalid',step:null,stage:'claim'}],
  [{claim:'not-json'},{code:'clover_failed',detail:'database_response_invalid',step:null,stage:'claim'}],
  [{ingestThrows:true},{code:'clover_failed',detail:'unexpected_TypeError',step:null,stage:'ingest'}],
  [{ingestError:()=>new DOMException('PRIVATE','TimeoutError')},{code:'clover_failed',detail:'unexpected_TimeoutError',step:null,stage:'ingest'}],
  [{ingestError:()=>Object.assign(new Error('PRIVATE'),{name:'PRIVATE name 2'})},{code:'clover_failed',detail:'unexpected',step:null,stage:'ingest'}],
  [{ingestError:()=>'PRIVATE thrown string'},{code:'clover_failed',detail:'unexpected',step:null,stage:'ingest'}],
  [{finishThrows:true},{code:'clover_failed',detail:'unexpected_TypeError',step:null,stage:'finish'}]];
 for(const [setup,expected] of cases){
  const r=await pagesPull(setup)();
  assert.equal(r.status,503);assert.deepEqual(r.body,expected,JSON.stringify(setup));
  assert.deepEqual(r.warns,[['daily_clover_pull_error',{detail:expected.detail,step:expected.step,stage:expected.stage}]]);
  const text=JSON.stringify([r.body,r.warns]);
  for(const hidden of ['PRIVATE','synthetic-clover-token',token,secret,'sb_secret'])assert.ok(!text.includes(hidden),hidden);
 }
});
test('successful pull response and warnings are unchanged',async()=>{
 const r=await pagesPull()();
 assert.equal(r.status,200);assert.deepEqual(r.body,{code:'succeeded',upserted:1,reconciled:false});assert.equal(r.warns.length,0);
});
