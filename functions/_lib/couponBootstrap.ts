import {bootstrapBoundedFetcher,boundedJsonText} from './bootstrapReadBudget.ts';
/** One genuine first event + supported manual past-profile delivery. Default off.
 * No resend, backfill, profile/subscription write or automatic queue/send action. */
import {couponConfig,liveCouponProvider,processCouponWelcome,couponWelcomeProperties,couponProviderProfile,
 couponProviderAccount,couponProfileMarketing,couponMarketingClear,couponMarketingNegative,COUPON_WELCOME_METRIC,
 type CouponConfig,type CouponStore,type CouponProvider,type CouponDispatchProtocol} from './couponWelcome.ts';
import {resolveServerEnvironment} from '../../src/lib/deploymentEnvironment.ts';
import {liveReceiptProvider,reconcileCouponDelivery} from './couponDelivery.ts';
type Json=Record<string,unknown>;
const obj=(x:unknown):x is Json=>!!x&&typeof x==='object'&&!Array.isArray(x);
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const ident=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(x);
const time=(x:unknown):x is string=>typeof x==='string'&&Number.isFinite(Date.parse(x));
const digest=async(x:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const reply=(code:string,status='blocked')=>({status,code,activationReady:false});
export type Inventory={accountId:string;complete:true;metrics:Json[]};
export type BootstrapProvider={coupon:CouponProvider;inventory():Promise<Inventory>;events(profileId:string,metricId?:string,after?:string):Promise<unknown>};
export function couponBootstrapConfig(env:Record<string,string|undefined>,host:string):CouponConfig {
 const target=resolveServerEnvironment(env,host),base=couponConfig(env,host),prefix=target.isolated?'TEST_':'';
 let mode:CouponConfig['mode']='disabled';
 if(target.configured&&target.secret.startsWith('sb_secret_')&&env[prefix+'COUPON_BOOTSTRAP_ENABLED']==='true'
  &&/^[A-Za-z0-9_-]{32,200}$/.test(base.processKey)&&uuid(base.businessId)&&ident(base.accountId)&&base.qrOrigin){
  if(target.isolated&&env[prefix+'COUPON_BOOTSTRAP_MODE']==='mock')mode='mock';
  if(!target.isolated&&env.COUPON_BOOTSTRAP_MODE==='live'&&/^[A-Za-z0-9_.:-]{8,120}$/.test(base.approvalId)
   &&[base.readKey,base.eventKey,base.receiptKey].every(k=>typeof k==='string'&&/^pk_[A-Za-z0-9_-]{10,200}$/.test(k))
   &&base.eventKey!==base.readKey&&base.eventKey!==base.receiptKey)mode='live';
 }
 return {...base,mode};
}
const RPCS=new Set(['coupon_bootstrap_preview_v1','coupon_bootstrap_claim_v1','coupon_bootstrap_preflight_v1',
 'coupon_bootstrap_dispatch_bind_v1','coupon_bootstrap_finish_v1','coupon_bootstrap_recover_v1','coupon_bootstrap_record_event_v1','coupon_bootstrap_record_delivery_v1',
 'coupon_welcome_context_v1','coupon_welcome_finish_v1','coupon_record_negative_v1',
 'message_send_reserve_v1','message_send_claim_v1','message_send_context_v1','message_send_finalize_v1',
 'coupon_delivery_context_v1','coupon_delivery_record_v1']);
export function bootstrapStore(config:CouponConfig,fetcher:typeof fetch=fetch):CouponStore {
 const budget={remaining:1000000};
 return {async rpc(name,args){
  if(config.mode==='disabled'||!RPCS.has(name))throw Error('bootstrap_rpc_rejected');
  const r=await fetcher(config.url+'/rest/v1/rpc/'+name,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(5000),
   headers:{apikey:config.serviceKey,'Content-Type':'application/json'},body:JSON.stringify(args)});
  if(r.status!==200)throw Error('bootstrap_rpc_unavailable');return JSON.parse(await boundedJsonText(r,budget,128000));
 }};
}
export type BootstrapAccountTiming={now:()=>number;sleep:(milliseconds:number)=>Promise<void>};
const accountTiming:BootstrapAccountTiming={now:Date.now,sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))};
/** One queue across all three credentials, bootstrap instance only. No retries or cache.
 * Cooldown starts after each response (including failures), before transport creates
 * its five-second network signal. This cannot coordinate other requests/processes. */
export function bootstrapAccountPacer(timing:BootstrapAccountTiming=accountTiming){
 let tail:Promise<unknown>=Promise.resolve(),next=timing.now()+4200;
 return <T>(read:()=>Promise<T>):Promise<T>=>{
  const pending=tail.then(async()=>{
   const wait=Math.max(0,next-timing.now());if(wait)await timing.sleep(wait);
   try{return await read();}finally{next=timing.now()+4200;}
  });
  tail=pending.catch(()=>{});return pending;
 };
}
export function bootstrapProvider(config:CouponConfig,fetcher:typeof fetch=fetch,timing?:BootstrapAccountTiming):BootstrapProvider {
 const bounded=bootstrapBoundedFetcher(fetcher),pace=bootstrapAccountPacer(timing);
 const rawCoupon=liveCouponProvider(config,bounded),receipt=liveReceiptProvider(config.receiptKey||'',bounded);
 const coupon:CouponProvider={...rawCoupon,
  get:(path,query)=>path==='/accounts'?pace(()=>rawCoupon.get(path,query)):rawCoupon.get(path,query),
  eventAccount:()=>pace(()=>rawCoupon.eventAccount())};
 async function get(url:URL){
  if(config.mode!=='live'||url.origin!=='https://a.klaviyo.com'||url.username||url.password||url.hash||url.pathname!=='/api/metrics/')throw Error('inventory_read_rejected');
  const r=await bounded(url.href,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(5000),headers:{Authorization:'Klaviyo-API-Key '+config.receiptKey,revision:'2026-07-15',Accept:'application/vnd.api+json'}});
  if(r.status!==200)throw Error('inventory_unavailable');const text=await r.text();if(text.length>1000000)throw Error('inventory_too_large');return JSON.parse(text);
 }
 return {coupon,async inventory(){
  const accounts=await pace(()=>receipt.get('/accounts'));if(!obj(accounts)||!Array.isArray(accounts.data)||accounts.data.length!==1||!obj(accounts.data[0])||accounts.data[0].id!==config.accountId)throw Error('inventory_account_mismatch');
  const metrics:Json[]=[],seen=new Set<string>(),ids=new Set<string>();let url:URL|null=new URL('https://a.klaviyo.com/api/metrics/');
  while(url){
   if(seen.size>=100||seen.has(url.href))throw Error('inventory_page_loop');seen.add(url.href);
   // No include/filter: this must be the complete unfiltered collection.
   for(const [k]of url.searchParams)if(k!=='page[cursor]')throw Error('inventory_query_rejected');
   const page:unknown=await get(url);
   if(!obj(page)||!Array.isArray(page.data)||!obj(page.links)||!('next'in page.links))throw Error('inventory_incomplete');
   for(const row of page.data){if(!obj(row)||row.type!=='metric'||!ident(row.id)||ids.has(row.id)||!obj(row.attributes)||typeof row.attributes.name!=='string')throw Error('inventory_shape');if(ids.size>=5000)throw Error('inventory_row_limit');ids.add(row.id);metrics.push(row);}
   const next=page.links.next;if(next===null)url=null;else if(typeof next==='string'&&next.length)url=new URL(next);else throw Error('inventory_incomplete');
  }
  return {accountId:config.accountId,complete:true,metrics};
 },async events(profileId,metricId,after){
  if(!ident(profileId)||(metricId!==undefined&&!ident(metricId))||(after!==undefined&&!time(after)))throw Error('event_read_rejected');
  const terms=[`equals(profile_id,${JSON.stringify(profileId)})`];if(metricId)terms.push(`equals(metric_id,${JSON.stringify(metricId)})`);if(after)terms.push(`greater-or-equal(datetime,${after})`);
  return receipt.get('/events',metricId ? {filter:`and(${terms.join(',')})`,'page[size]':'100',include:'metric,profile','fields[profile]':'id','fields[metric]':'id,name,integration'} : {filter:terms[0],'page[size]':'1','fields[event]':'datetime'});
 }};
}
function context(x:unknown,config:CouponConfig,permitId:string):x is Json {
 return obj(x)&&x.allowed===true&&x.permitId===permitId&&x.businessId===config.businessId&&x.accountId===config.accountId
  &&x.qrOrigin===config.qrOrigin&&[x.jobId,x.jobLeaseId,x.couponId,x.customerId,x.eventUniqueId].every(uuid)
  &&ident(x.profileId)&&ident(x.vipListId)&&time(x.expiresAt)&&time(x.recoverUntil)&&time(x.confirmedAt)
  &&typeof x.recipient==='string'&&obj(x.properties);
}
function metricRows(inventory:Inventory,accountId:string){
 if(inventory.complete!==true||inventory.accountId!==accountId)throw Error('inventory_unconfirmed');
 return inventory.metrics.filter(row=>obj(row.attributes)&&typeof row.attributes.name==='string'
  &&row.attributes.name.trim().toLowerCase()===COUPON_WELCOME_METRIC.toLowerCase());
}
async function currentProvider(provider:BootstrapProvider,c:Json,store:CouponStore,now:()=>number){
 await couponProviderAccount(provider.coupon,String(c.accountId));await couponProviderAccount(provider.coupon,String(c.accountId),true);
 const profile=await couponProviderProfile(provider.coupon,String(c.recipient));
 const member=await couponProviderProfile(provider.coupon,String(c.recipient),String(c.vipListId));
 const marketing=couponProfileMarketing(profile),denied=couponMarketingNegative(marketing,String(c.vipListId));
 if(denied)await store.rpc('coupon_record_negative_v1',{p_business_id:c.businessId,p_customer_id:c.customerId,p_email:c.recipient,p_status:denied,p_checked_at:new Date(now()).toISOString()});
 if(profile.id!==c.profileId||member.id!==c.profileId||!couponMarketingClear(marketing,String(c.vipListId))||marketing.double_optin!==true
  ||!time(marketing.consent_timestamp)||Date.parse(marketing.consent_timestamp)<Date.parse(String(c.confirmedAt))||Date.parse(marketing.consent_timestamp)>now()+60000)throw Error('bootstrap_recipient_unconfirmed');
}
function markedProperties(job:Parameters<typeof couponWelcomeProperties>[0],base:Json):Json {
 return {...base,bootstrap_event_unique_id:job.eventUniqueId};
}
export async function processCouponBootstrap({config,store,provider,permitId,now=Date.now}:{config:CouponConfig;store:CouponStore;provider:BootstrapProvider;permitId:string;now?:()=>number}){
 if(config.mode==='disabled')return reply('bootstrap_disabled','disabled');
 if(!uuid(permitId)||provider.coupon.mode!==config.mode)return reply('invalid_input');
 try{
  const c=await store.rpc('coupon_bootstrap_preview_v1',{p_permit_id:permitId});
  if(!context(c,config,permitId)||c.state!=='reviewed'||c.attempts!==0||Date.parse(c.expiresAt as string)<=now())return reply('bootstrap_not_claimable');
  if(metricRows(await provider.inventory(),config.accountId).length)return reply('metric_already_exists');
  await currentProvider(provider,c,store,now);
  const readProbe=await provider.events(String(c.profileId));if(!obj(readProbe)||!Array.isArray(readProbe.data))return reply('event_read_scope_unconfirmed');
  const protocol:CouponDispatchProtocol={
   claim:()=>store.rpc('coupon_bootstrap_claim_v1',{p_permit_id:permitId}),
   preflight:j=>store.rpc('coupon_bootstrap_preflight_v1',{p_permit_id:permitId,p_job_id:j.jobId}),
   properties:markedProperties,
   async bind(j,reservationId,profileId){
    if(j.jobId!==c.jobId||j.couponId!==c.couponId||j.eventUniqueId!==c.eventUniqueId||profileId!==c.profileId)throw Error('bootstrap_context_changed');
    if(metricRows(await provider.inventory(),config.accountId).length)throw Error('bootstrap_metric_race');
    const b=await store.rpc('coupon_bootstrap_dispatch_bind_v1',{p_permit_id:permitId,p_job_id:j.jobId,p_job_lease_id:j.jobLeaseId,p_reservation_id:reservationId,p_profile_id:profileId});
    return obj(b)&&b.allowed===true&&b.code==='bootstrap_dispatch_bound'?{allowed:true,code:'delivery_bound'}:{allowed:false};
   }
  };
  const result=await processCouponWelcome({store,provider:provider.coupon,businessId:config.businessId,accountId:config.accountId,qrOrigin:config.qrOrigin,couponId:String(c.couponId),protocol,now});
  await store.rpc('coupon_bootstrap_finish_v1',{p_permit_id:permitId});
  return {...result,activationReady:false};
 }catch{return reply('bootstrap_unconfirmed','unknown');}
}
/** Read only at provider; records only a unique, exact original-event proof locally.
 * The explicit property echoes the submitted unique_id: no assumption that a
 * provider-generated event UUID or Received Email repeats that identifier. */
export function couponEventPropertiesMatch(actual:Json,expected:Json,eventUniqueId:string):boolean {
 // Klaviyo may omit null event values and adds $event_id. Never hash arbitrary
 // provider metadata, or assume attributes.uuid equals the submitted unique_id.
 const own=new Set(Object.keys(expected));
 if(Object.keys(actual).some(key=>!own.has(key)&&key!=='$event_id'))return false;
 if('$event_id' in actual && actual.$event_id!==eventUniqueId)return false;
 return Object.entries(expected).every(([key,value])=>value===null
  ? !(key in actual)||actual[key]===null : JSON.stringify(actual[key])===JSON.stringify(value));
}
export async function verifyCouponBootstrapEvent({config,store,provider,permitId,now=Date.now}:{config:CouponConfig;store:CouponStore;provider:BootstrapProvider;permitId:string;now?:()=>number}){
 if(config.mode!=='live'||provider.coupon.mode!=='live'||!uuid(permitId))return reply('bootstrap_verification_disabled');
 try{
  const c=await store.rpc('coupon_bootstrap_preview_v1',{p_permit_id:permitId});
  if(!context(c,config,permitId)||!['awaiting_event','event_verified'].includes(String(c.state))||!uuid(c.reservationId)||!time(c.recoverUntil)||Date.parse(c.recoverUntil)<=now())return reply('bootstrap_event_context_missing');
  const rows=metricRows(await provider.inventory(),config.accountId);if(rows.length!==1)return reply('bootstrap_metric_unconfirmed');
  const metric=rows[0],integration=obj(metric.attributes)?metric.attributes.integration:null;
  if(!ident(metric.id)||!obj(integration)||integration.name!=='API'||typeof integration.category!=='string'||integration.category.toLowerCase()!=='api')return reply('bootstrap_metric_unconfirmed');
  await currentProvider(provider,c,store,now);
  const gate=await store.rpc('coupon_delivery_context_v1',{p_business_id:config.businessId,p_coupon_id:c.couponId});
  // A bootstrap has no delivery binding yet. Its private preview carries the
  // original K6 dispatch time; never substitute a new timestamp for readback.
  if(obj(gate)&&gate.bindingId)return reply('bootstrap_already_bound');
  if(!time(c.dispatchedAt))return reply('bootstrap_dispatch_time_missing');
  const response=await provider.events(String(c.profileId),metric.id,new Date(Date.parse(c.dispatchedAt)-1000).toISOString());
  if(!obj(response)||!Array.isArray(response.data)||!obj(response.links)||response.links.next!==null)return reply('bootstrap_event_page_incomplete');
  const base=couponWelcomeProperties(c as unknown as Parameters<typeof couponWelcomeProperties>[0],config.qrOrigin);if(!base)return reply('bootstrap_payload_unconfirmed');
  const expected=markedProperties(c as unknown as Parameters<typeof couponWelcomeProperties>[0],base);
  const expectedHash=await digest(JSON.stringify(expected));if(expectedHash!==c.payloadSha256)return reply('bootstrap_payload_unconfirmed');
  const matches=response.data.filter(e=>{
   if(!obj(e)||!ident(e.id)||!obj(e.attributes)||!time(e.attributes.datetime)||!obj(e.attributes.event_properties)||!obj(e.relationships))return false;
   const rel=e.relationships,p=e.attributes.event_properties;
   return obj(rel.profile)&&obj(rel.profile.data)&&rel.profile.data.id===c.profileId&&obj(rel.metric)&&obj(rel.metric.data)&&rel.metric.data.id===metric.id
    &&Date.parse(e.attributes.datetime)>=Date.parse(String(c.dispatchedAt))-1000&&Date.parse(e.attributes.datetime)<=now()+60000
    &&couponEventPropertiesMatch(p,expected,String(c.eventUniqueId));
  });
  if(matches.length!==1)return reply('bootstrap_event_not_unique');
  const event=matches[0] as Json,attrs=event.attributes as Json;
  const proof=await digest(JSON.stringify({accountId:config.accountId,profileId:c.profileId,metricId:metric.id,eventId:event.id,eventAt:attrs.datetime,eventUniqueId:c.eventUniqueId,payloadSha256:expectedHash}));
  const ack=await store.rpc('coupon_bootstrap_record_event_v1',{p_permit_id:permitId,p_metric_id:metric.id,p_provider_event_id:event.id,p_event_at:attrs.datetime,p_evidence_sha256:proof});
  if(!obj(ack)||ack.acknowledged!==true)return reply('bootstrap_event_record_unconfirmed','unknown');
  return reply('bootstrap_event_verified','event_verified');
 }catch{return reply('bootstrap_event_read_unconfirmed','unknown');}
}
export async function handleCouponBootstrapRequest(request:Request,config:CouponConfig,deps:{store:CouponStore;provider:BootstrapProvider}){
 const respond=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 if(request.method!=='POST')return respond(405,reply('method_not_allowed'));
 if(config.mode==='disabled')return respond(503,reply('bootstrap_disabled','disabled'));
 if(request.headers.has('Origin')||config.processKey.length<32||request.headers.get('Authorization')!==`Bearer ${config.processKey}`)return respond(403,reply('forbidden'));
 if(request.headers.get('Content-Type')!=='application/json')return respond(400,reply('invalid_input'));
 try{
  const text=await request.text();if(text.length>512)return respond(400,reply('invalid_input'));
  const b:unknown=JSON.parse(text);if(!obj(b)||Object.keys(b).sort().join()!=='action,permitId'||!uuid(b.permitId))return respond(400,reply('invalid_input'));
  if(b.action==='dispatch')return respond(200,await processCouponBootstrap({config,...deps,permitId:b.permitId}));
  if(b.action==='recover'){const ack=await deps.store.rpc('coupon_bootstrap_recover_v1',{p_permit_id:b.permitId});return respond(200,ack);}
  if(b.action==='verify-event')return respond(200,await verifyCouponBootstrapEvent({config,...deps,permitId:b.permitId}));
  if(b.action==='reconcile'){
   if(config.mode!=='live'||deps.provider.coupon.mode!=='live')return respond(503,reply('bootstrap_reconciliation_disabled'));
   const c=await deps.store.rpc('coupon_bootstrap_preview_v1',{p_permit_id:b.permitId,p_receipt_only:true});
   if(!obj(c)||c.allowed!==true||c.permitId!==b.permitId||c.businessId!==config.businessId||c.accountId!==config.accountId||!uuid(c.couponId)||!['bound','delivered'].includes(String(c.state))||!config.receiptKey)return respond(409,reply('bootstrap_not_bound'));
   const result=await reconcileCouponDelivery({store:deps.store,provider:liveReceiptProvider(config.receiptKey),businessId:config.businessId,couponId:String(c.couponId),accountId:config.accountId});
   if(result.status==='delivered'){const ack=await deps.store.rpc('coupon_bootstrap_record_delivery_v1',{p_permit_id:b.permitId});if(!obj(ack)||ack.acknowledged!==true)return respond(503,reply('bootstrap_delivery_record_unconfirmed','unknown'));}
   return respond(200,{...result,activationReady:false});
  }
  return respond(400,reply('invalid_input'));
 }catch{return respond(503,reply('bootstrap_unconfirmed','unknown'));}
}
