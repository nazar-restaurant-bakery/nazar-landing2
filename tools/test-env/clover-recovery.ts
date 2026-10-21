// Operator-only recovery. Uses the existing K7 reader/ingest; no new HTTP route.
import {createHash} from 'node:crypto';
import {nyMidnight,collectOrders,PullError,orderPullConfig} from '../../functions/_lib/cloverOrderPull.ts';
export function recoveryWindow(from:string,to:string,now=Date.now()) {
 const valid=(d:string)=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d+'T12:00Z').toISOString().slice(0,10)===d;
 if(!valid(from)||!valid(to)||from>to)throw Error('invalid_range');
 const next=new Date(to+'T12:00Z');next.setUTCDate(next.getUTCDate()+1);
 const start=nyMidnight(from),end=nyMidnight(next.toISOString().slice(0,10));
 const days=Math.round((Date.parse(to)-Date.parse(from))/86400000)+1;
 if(start===null||end===null||days>31||now-start>90*86400000||end>now)throw Error('invalid_range');
 return {start,end,from,to,days};
}
export function dayProofs(orders:Record<string,unknown>[],from:string,to:string){
 const result=[];
 for(let day=from;day<=to;){
  const ids=orders.filter(o=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/New_York'}).format(Number(o.createdTime))===day).map(o=>String(o.id)).sort();
  result.push({day,sourceCount:ids.length,idsMd5:createHash('md5').update(ids.join(',')).digest('hex')});
  const next=new Date(day+'T12:00Z');next.setUTCDate(next.getUTCDate()+1);day=next.toISOString().slice(0,10);
 }
 return result;
}
export async function recover(config:ReturnType<typeof orderPullConfig>,from:string,to:string,reserveRpc:'daily_reserve_external_request'|'ops_reserve_external_request',fetcher:typeof fetch=fetch,now=Date.now()){
 const window=recoveryWindow(from,to,now);
 if(!config.ready)throw Error('configuration_missing');
 const rpc=async(name:string,body:Record<string,unknown>)=>{
  const r=await fetcher(config.url+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:config.secret,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('database_unavailable');return r.json();
 };
 const budgeted:typeof fetch=async(input,init)=>{
  if(await rpc(reserveRpc,reserveRpc==='daily_reserve_external_request'?{p_business_id:config.businessId}:{})!==true)throw new PullError('daily_budget_exhausted','list');
  return fetcher(input,init);
 };
 // Confirm the configured provider identity before reading any orders.
 const merchant=await budgeted(config.cloverBase+'/v3/merchants/'+config.merchant,{headers:{Authorization:'Bearer '+config.token},redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!merchant.ok||(await merchant.json()).id!==config.merchant)throw Error('merchant_mismatch');
 const result=await collectOrders(config,1,budgeted,window);
 if(result.orders.some(o=>Number(o.createdTime)<window.start||Number(o.createdTime)>=window.end))throw Error('source_outside_range');
 // A denied optional scope is explicitly incomplete; never label the month complete.
 if(result.warnings.length)throw Error('optional_scope_incomplete');
 for(const snapshot of result.orders)await rpc('clover_order_ingest_v1',{p_business_id:config.businessId,p_merchant_id:config.merchant,p_snapshot:snapshot});
 return {schemaVersion:1,target:config.url,businessId:config.businessId,from,to,status:'PENDING_DATABASE_CHECK',
  sourceOrders:result.orders.length,providerRequests:result.requestCount+1,days:dayProofs(result.orders,from,to),
  verifiedAtUtc:new Date(now).toISOString(),customerContentRecorded:false,financialReconciliation:false};
}
