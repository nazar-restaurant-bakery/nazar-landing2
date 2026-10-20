import {verifyMachine,machineSignature,type MachineBody} from '../../../functions/_lib/dailySchedulerAuth.ts';
import {collectSources} from '../ops-collect/run-collectors.ts';
import {NAZAR_BUSINESS} from '../ops-collect/contracts.ts';
import type {CollectorContext} from '../ops-collect/collectors.ts';
type Env=Record<string,string|undefined>;
type Run={business_id:string;id:string;claim_token:string;clover_url:string;start_ms:number;end_ms:number};
export function dailyHandler(fetcher:typeof fetch=fetch,now=()=>Date.now(),background?:(task:Promise<unknown>)=>void){return async(request:Request,env:Env)=>{
 const reply=(status:number,code:string)=>new Response(JSON.stringify({code}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 if(request.method!=='POST')return reply(405,'method_not_allowed');
 let body:MachineBody;
 try{const raw=await request.text();if(raw.length>1024)return reply(400,'invalid_request');body=JSON.parse(raw);}catch{return reply(400,'invalid_request');}
 if(!await verifyMachine('daily.dispatch.v1',body,request.headers.get('X-Scheduler-Signature')||'',env.SCHEDULER_SIGNING_SECRET||'',now()))return reply(401,'unauthorized');
 if(!env.SUPABASE_URL||!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(env.SUPABASE_URL)||!env.SUPABASE_SERVICE_ROLE_KEY)return reply(503,'configuration_missing');
 async function rpc(name:string,args:Record<string,unknown>){
  const key=env.SUPABASE_SERVICE_ROLE_KEY!;
  const r=await fetcher(env.SUPABASE_URL+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(args),redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error(name==='daily_ops_snapshot'?'scope_unavailable':'database_unavailable');return r.json();
 }
 let run:Run|null;
 try{run=await rpc('daily_scheduler_start',{p_business_id:body.business_id,p_run_id:body.run_id,p_nonce:body.nonce});}
 catch{return reply(503,'database_unavailable');}
 if(!run)return reply(409,'already_claimed_or_paused');
 const claimed=run;
 const work=async()=>{
 let code='execution_failed';let opsStatus='failed';let budgetDenied=false;let paused=false;
 const run=claimed;
 try{
  if(run.business_id!==body.business_id||run.id!==body.run_id||!/^https:\/\/[A-Za-z0-9.-]+\/api\/internal\/daily-clover-pull$/.test(run.clover_url))throw Error('scope_unavailable');
  const args={p_business_id:run.business_id,p_run_id:run.id,p_token:run.claim_token};
  const clover:MachineBody={...body,issued_at:Math.floor(now()/1000),claim_token:run.claim_token,start_ms:run.start_ms,end_ms:run.end_ms};
  const pull=await fetcher(run.clover_url,{method:'POST',headers:{'Content-Type':'application/json','X-Scheduler-Signature':await machineSignature('daily.clover.v1',clover,env.SCHEDULER_SIGNING_SECRET!)},body:JSON.stringify(clover),redirect:'error',signal:AbortSignal.timeout(120000)});
  const pulled=await pull.json().catch(()=>({}));
  if(!pull.ok){code=pulled.code==='budget_exhausted'?'budget_exhausted':pulled.code==='paused'?'paused':'clover_failed';throw Error(code);}
  // The existing provider adapters/snapshot are explicitly bound to their legacy
  // business. Never apply those fixed account totals to another tenant.
  if(run.business_id!==NAZAR_BUSINESS)throw Error('scope_unavailable');
  const snapshot=await rpc('daily_ops_snapshot',args);
  const ctx:CollectorContext & {businessId:string}={env,businessId:run.business_id,now:new Date(now()),budget:{remaining:30},fetch:async(input,init)=>{
   if(await rpc('daily_run_check',args)!==true){paused=true;throw Error('paused');}
   if(await rpc('daily_reserve_external_request',args)!==true){budgetDenied=true;throw Error('budget_exhausted');}
   return fetcher(input,init);
  }};
  const results=await collectSources({snapshot:async()=>snapshot},ctx);
  const connections=results.sources.filter(s=>s.source!=='scheduler');
  await rpc('daily_commit_ops',{...args,p_metrics:results.metrics.filter(m=>m.source!=='scheduler'),p_connections:connections});
  const failed=connections.some(c=>c.status==='error');opsStatus=failed?'partial':'succeeded';
  code=paused?'paused':budgetDenied?'budget_exhausted':failed||pulled.code==='partial'?'partial_collection':'collected';
 }catch(error){if(error instanceof Error&&['scope_unavailable','budget_exhausted','paused'].includes(error.message))code=error.message;}
 if(run){
  try{const done=await rpc('daily_scheduler_finish',{p_business_id:run.business_id,p_run_id:run.id,p_token:run.claim_token,p_ops_status:opsStatus,p_code:code});if(!done)return reply(503,'unknown_result');}
  catch{return reply(503,'unknown_result');}
 }
 return reply(opsStatus==='failed'?503:200,code);
 };
 if(background){background(work());return reply(202,'accepted');}
 return work();
};}
declare const Deno:{serve:(fn:(req:Request)=>Promise<Response>)=>void;env:{toObject:()=>Env}};
declare const EdgeRuntime:{waitUntil:(task:Promise<unknown>)=>void};
if(typeof Deno!=='undefined')Deno.serve(req=>dailyHandler(fetch,()=>Date.now(),typeof EdgeRuntime!=='undefined'?task=>EdgeRuntime.waitUntil(task):undefined)(req,Deno.env.toObject()));
