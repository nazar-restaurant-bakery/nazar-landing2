import {collectOrders,orderPullConfig,PullError,type PullEnv} from '../../_lib/cloverOrderPull.ts';
import {verifyMachine,type MachineBody} from '../../_lib/dailySchedulerAuth.ts';
const reply=(status:number,code:string,extra:Record<string,unknown>={})=>new Response(JSON.stringify({code,...extra}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export function dailyCloverHandler(fetcher:typeof fetch=fetch){return async({request,env}:{request:Request;env:PullEnv})=>{
 if(request.method!=='POST')return reply(405,'method_not_allowed');
 let body:MachineBody;
 try{const raw=await request.text();if(raw.length>1024)return reply(400,'invalid_request');body=JSON.parse(raw);}catch{return reply(400,'invalid_request');}
 if(!await verifyMachine('daily.clover.v1',body,request.headers.get('X-Scheduler-Signature')||'',env.SCHEDULER_SIGNING_SECRET||''))return reply(401,'unauthorized');
 const config=orderPullConfig(env,new URL(request.url).hostname);
 if(!config.ready||config.businessId!==body.business_id)return reply(403,'wrong_business');
 const args={p_business_id:body.business_id,p_run_id:body.run_id,p_token:body.claim_token};
 async function rpc(name:string,more:Record<string,unknown>={}){
  const r=await fetcher(config.url+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:config.secret,'Content-Type':'application/json'},body:JSON.stringify({...args,...more}),redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error('database_unavailable');return r.json();
 }
 try{
  if(await rpc('daily_clover_claim')!==true)return reply(409,'already_claimed_or_paused');
  const budgeted:typeof fetch=async(input,init)=>{
   if(await rpc('daily_run_check')!==true)throw new PullError('scheduler_paused','list');
   if(await rpc('daily_reserve_external_request')!==true)throw new PullError('daily_budget_exhausted','list');
   return fetcher(input,init);
  };
  // includeModified: a void/refund made days later re-ingests its older order.
  const result=await collectOrders(config,1,budgeted,{start:body.start_ms!,end:body.end_ms!},{includeModified:true});
  for(const snapshot of result.orders){
   if(await rpc('daily_run_check')!==true)throw new PullError('scheduler_paused','ingest');
   const r=await fetcher(config.url+'/rest/v1/rpc/clover_order_ingest_v1',{method:'POST',headers:{apikey:config.secret,'Content-Type':'application/json'},body:JSON.stringify({p_business_id:config.businessId,p_merchant_id:config.merchant,p_snapshot:snapshot}),redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!r.ok)throw new PullError('ingest_failed','ingest');
  }
  const state=result.warnings.length?'partial':'succeeded';
  if(await rpc('daily_clover_finish',{p_status:state})!==true)return reply(409,'paused');
  return reply(200,state,{upserted:result.orders.length,reconciled:false});
 }catch(error){
  await rpc('daily_clover_finish',{p_status:'failed'}).catch(()=>null);
  return reply(503,error instanceof PullError&&error.code==='daily_budget_exhausted'?'budget_exhausted':error instanceof PullError&&error.code==='scheduler_paused'?'paused':'clover_failed');
 }
};}
export const onRequestPost=dailyCloverHandler();
export const onRequest=()=>reply(405,'method_not_allowed');
