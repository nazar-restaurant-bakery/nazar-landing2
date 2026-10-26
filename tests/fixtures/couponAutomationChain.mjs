// Actual consumer + Cloudflare route in workerd, actual native application SQL.
// Only external Auth/REST/provider transport is intercepted. No network fallback.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,realpath,rm} from 'node:fs/promises';
import {join,relative,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
export async function normalConsumerNativeChain({h,call,customer,business:B,repo}){
 const require=createRequire(import.meta.url);
 const {Miniflare,Response:WorkerResponse,convertV4MiniflareOptions}=require('miniflare');
 const {build}=require('esbuild');const x=customer();
 const calls=[],accountAt=[],key='synthetic_process_key_12345678901234567890',secret='synthetic_machine_secret_12345678901234567890';let events=0;
 const env={COUPON_AUTOMATION_ENABLED:'true',COUPON_AUTOMATION_BUSINESS_ID:B,COUPON_AUTOMATION_ORIGIN:'https://normal.synthetic.invalid',COUPON_AUTOMATION_SIGNING_SECRET:secret,COUPON_PROCESS_KEY:key,SUPABASE_URL:'https://khgczybubufouraqyrcj.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic_only_123456'};
 const routeEnv={COUPON_PROCESS_ENABLED:'true',COUPON_PROCESS_MODE:'live',SUPABASE_SECRET_KEY:env.SUPABASE_SERVICE_ROLE_KEY,COUPON_PROCESS_KEY:key,COUPON_KLAVIYO_ACCOUNT_ID:'ACCOUNT',COUPON_KLAVIYO_READ_KEY:'pk_synthetic_read_123456',COUPON_KLAVIYO_EVENT_KEY:'pk_synthetic_event_123456',COUPON_KLAVIYO_RECEIPT_KEY:'pk_synthetic_receipt_123456',COUPON_LIVE_APPROVAL_ID:'synthetic-review',COUPON_QR_ORIGIN:'https://normal.synthetic.invalid'};
 const wrapper=`
 import {couponAutomationHandler} from './functions/_lib/couponAutomation.ts';
 import {couponAutomationSignature} from './functions/_lib/couponAutomationAuth.ts';
 import {onRequest} from './functions/api/internal/coupon-welcome.ts';
 const env=${JSON.stringify(env)},routeEnv=${JSON.stringify(routeEnv)};
 const bridge=async(input,options)=>{const req=new Request(input,options);if(new URL(req.url).origin==='https://normal.synthetic.invalid'){if(new URL(req.url).pathname!=='/api/internal/coupon-welcome')throw Error('path');return onRequest({request:req,env:routeEnv});}return fetch(req);};
 export default {async fetch(request){const b={version:1,businessId:'${B}',runId:new URL(request.url).searchParams.get('run'),issuedAt:Math.floor(Date.now()/1000)};const signature=await couponAutomationSignature(b,'${secret}');return couponAutomationHandler(bridge)(new Request('https://edge.synthetic.invalid/',{method:'POST',headers:{'Content-Type':'application/json','X-Coupon-Automation-Signature':signature},body:JSON.stringify(b)}),env);}};`;
 const temp=await mkdtemp(join(repo,'.automation-chain-'));let mf;
 try{
  const built=await build({stdin:{contents:wrapper,sourcefile:'native-chain.ts',resolveDir:repo},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
  const scriptPath=join(temp,'worker.mjs');await writeFile(scriptPath,built.outputFiles[0].contents);
  mf=new Miniflare(convertV4MiniflareOptions({cf:false,telemetry:{enabled:false},modules:true,scriptPath,compatibilityDate:'2026-10-06',outboundService:async request=>{
   const u=new URL(request.url);calls.push([u.origin,u.pathname,request.method]);
   if(u.origin===env.SUPABASE_URL){
    assert.equal(request.method,'POST');assert.equal(request.headers.get('apikey'),env.SUPABASE_SERVICE_ROLE_KEY);
    const name=u.pathname.split('/').at(-1);assert.match(name,/^(coupon_automation_(start|next|record|finish)_v1|coupon_(welcome_(claim|context|finish)|delivery_(preflight|bind|context|record)|record_negative)_v1|message_send_(reserve|claim|context|finalize)_v1)$/);
    return WorkerResponse.json(call(name,await request.json()));
   }
   assert.equal(u.origin,'https://a.klaviyo.com');assert.equal(request.headers.get('revision'),'2026-07-15');
   if(u.pathname==='/api/accounts/'){assert.equal(request.method,'GET');accountAt.push(Date.now());return WorkerResponse.json({data:[{id:'ACCOUNT'}]});}
   if(u.pathname==='/api/profiles/'){assert.equal(request.method,'GET');return WorkerResponse.json({data:[{id:x.profile,attributes:{email:x.email,subscriptions:{email:{marketing:{consent:'SUBSCRIBED',can_receive_email_marketing:true,suppression:[],list_suppressions:[]}}}}}]});}
   if(u.pathname==='/api/metrics/METRIC/'){assert.equal(request.method,'GET');return WorkerResponse.json({data:{id:'METRIC',attributes:{name:'Received Email',integration:{name:'Klaviyo',category:'Internal'}}}});}
   assert.equal(u.pathname,'/api/events/');
   if(request.method==='POST'){
    events++;assert.equal(events,1);assert.equal(h.sql(`SELECT count(*) FROM core.coupon_automation_dispatch_attempts WHERE coupon_id='${x.coupon}'`),1);
    const body=await request.json();assert.equal(body.data.attributes.profile.data.attributes.email,x.email);assert.equal(body.data.attributes.metric.data.attributes.name,'Nazar Coupon Welcome Authorized');assert.equal(body.data.attributes.properties.coupon_id,x.coupon);assert.ok(!('bootstrap_event_unique_id' in body.data.attributes.properties));
    return new WorkerResponse(null,{status:202});
   }
   assert.equal(request.method,'GET');assert.equal(u.searchParams.get('include'),null);
   const d=h.sql(`SELECT to_jsonb(d) FROM core.coupon_delivery_bindings d JOIN core.coupon_welcome_outbox j ON j.id=d.job_id WHERE j.coupon_id='${x.coupon}'`);
   return WorkerResponse.json({data:[{id:'LOCAL_CHAIN_RECEIPT',attributes:{datetime:new Date().toISOString(),event_properties:{$flow:d.flow_id,$message:d.message_id}},relationships:{profile:{data:{id:d.profile_id}},metric:{data:{id:d.received_metric_id||'METRIC'}}}}],links:{next:null}});
  }}));await mf.ready;
  let r=await mf.dispatchFetch('https://chain.synthetic.invalid/?run='+randomUUID());let body=await r.json();assert.equal(r.status,200,JSON.stringify(body));assert.equal(body.accepted,1);assert.equal(events,1);
  const before=h.sql(`SELECT to_jsonb(m) FROM core.message_log m JOIN core.coupon_welcome_outbox j ON j.message_reservation_id=m.id WHERE j.coupon_id='${x.coupon}'`);assert.equal(before.status,'unknown');
  r=await mf.dispatchFetch('https://chain.synthetic.invalid/?run='+randomUUID());body=await r.json();assert.equal(r.status,200,JSON.stringify(body));assert.equal(body.delivered,1);assert.equal(body.accepted,0);assert.equal(events,1);
  assert.deepEqual(h.sql(`SELECT to_jsonb(m) FROM core.message_log m WHERE id='${before.id}'`),before);
  assert.equal(h.sql(`SELECT count(*) FROM core.coupon_delivery_receipts dr JOIN core.coupon_delivery_bindings d ON d.id=dr.binding_id JOIN core.coupon_welcome_outbox j ON j.id=d.job_id WHERE j.coupon_id='${x.coupon}'`),1);
  assert.equal(accountAt.length,3);assert.ok(accountAt[1]-accountAt[0]>=4000);assert.ok(accountAt[2]-accountAt[1]>=4000);
  assert.ok(calls.every(c=>!c[1].includes('bootstrap')&&!c[1].includes('subscriptions')&&!c[1].includes('lists')));
  assert.equal(h.sql('SELECT count(*) FROM core.coupon_bootstrap_permits'),0);
 }finally{
  await mf?.dispose();const target=await realpath(temp),child=relative(await realpath(repo),target);assert.ok(child.startsWith('.automation-chain-')&&!child.includes(sep));await rm(target,{recursive:true,force:true});
 }
}
