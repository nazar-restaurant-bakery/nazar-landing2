/** Flow webhook -> verified DOI -> existing atomic coupon issuer. Never sends. */
import { resolveServerEnvironment } from '../../src/lib/deploymentEnvironment.ts';
import { confirmCouponVip, liveCouponProvider, type CouponConfig, type CouponProvider, type CouponStore } from './couponWelcome.ts';
type Json = Record<string, unknown>;
const obj = (x: unknown): x is Json => !!x && typeof x === 'object' && !Array.isArray(x);
const id = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(x);
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const digest = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(n=>n.toString(16).padStart(2,'0')).join('');
export type DoiWebhookConfig = { enabled: boolean; key: string; flowId: string; listId: string; coupon: CouponConfig };
export function doiWebhookConfig(env: Record<string,string|undefined>, hostname: string): DoiWebhookConfig {
 const target=resolveServerEnvironment(env,hostname),prefix=target.isolated?'TEST_':'';
 const read=(key:string)=>env[prefix+key]||'';
 const key=read('VIP_DOI_WEBHOOK_KEY'),flowId=read('VIP_DOI_FLOW_ID'),listId=read('VIP_DOI_LIST_ID');
 const accountId=read('COUPON_KLAVIYO_ACCOUNT_ID'),readKey=read('COUPON_KLAVIYO_READ_KEY');
 const approvalId=read('VIP_DOI_APPROVAL_ID'),mode=read('VIP_DOI_MODE');
 const enabled=target.configured && target.secret.startsWith('sb_secret_') && read('VIP_DOI_ENABLED')==='true'
  && /^[A-Za-z0-9_-]{32,200}$/.test(key) && id(flowId) && id(listId) && id(accountId)
  && (target.isolated ? mode==='mock' : mode==='live' && /^pk_[A-Za-z0-9_-]{10,200}$/.test(readKey)
   && /^[A-Za-z0-9_.:-]{8,120}$/.test(approvalId));
 return {enabled,key,flowId,listId,coupon:{mode:enabled?(target.isolated?'mock':'live'):'disabled',isolated:target.isolated,
  url:target.url,businessId:target.businessId,serviceKey:target.secret,processKey:'',accountId,readKey,
  eventKey:'',qrOrigin:'',approvalId}};
}
const RPCS=new Set(['vip_doi_webhook_match_v1','vip_doi_webhook_confirm_v1','vip_doi_webhook_observe_v1',
 'coupon_confirmation_context_v1','coupon_record_negative_v1']);
export function doiWebhookStore(config:DoiWebhookConfig,fetcher:typeof fetch):CouponStore {
 return {async rpc(name,args){
  if(!config.enabled||!RPCS.has(name))throw Error('doi_rpc_unavailable');
  const r=await fetcher(config.coupon.url+'/rest/v1/rpc/'+name,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(5000),
   headers:{apikey:config.coupon.serviceKey,'Content-Type':'application/json'},body:JSON.stringify(args)});
  if(!r.ok)throw Error('doi_rpc_unavailable');return r.json();
 }};
}
export function doiWebhookProvider(config:DoiWebhookConfig,fetcher:typeof fetch):CouponProvider {
 const base=liveCouponProvider(config.coupon,fetcher);
 return {mode:config.coupon.mode==='live'?'live':'mock',async get(path,query){
  // Runtime mock cannot manufacture proof; only local test harness injects it.
  if(config.coupon.mode!=='live')throw Error('mock_evidence_required');return base.get(path,query);
 },async eventAccount(){throw Error('doi_never_sends');},async event(){throw Error('doi_never_sends');}};
}
async function authorized(value:string|null,key:string){
 if(!value||value.length>220)return false;
 const a=await digest(value),b=await digest('Bearer '+key);let difference=0;
 for(let i=0;i<a.length;i++)difference|=a.charCodeAt(i)^b.charCodeAt(i);return difference===0;
}
export async function handleDoiWebhook(request:Request,config:DoiWebhookConfig,
 {store,provider}:{store:CouponStore;provider:CouponProvider}):Promise<Response>{
 const reply=(status:number,code:string)=>Response.json({code},{status,headers:{'Cache-Control':'no-store'}});
 if(request.method!=='POST')return reply(405,'method_not_allowed');
 if(!config.enabled)return reply(503,'doi_disabled');
 if(request.headers.has('Origin')||!await authorized(request.headers.get('Authorization'),config.key)
  ||request.headers.get('X-Klaviyo-Flow-ID')!==config.flowId)return reply(403,'forbidden');
 if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')
  ||Number(request.headers.get('Content-Length')||0)>1024)return reply(400,'invalid_input');
 let requestKey='';
 const observe=async(status:string,code:string)=>{
  if(await store.rpc('vip_doi_webhook_observe_v1',{p_business_id:config.coupon.businessId,p_request_key:requestKey,p_status:status,p_safe_code:code})!==true)throw Error('audit_unconfirmed');
 };
 try{
  const raw=await request.text();if(raw.length>1024)return reply(400,'invalid_input');
  let b:unknown;try{b=JSON.parse(raw);}catch{return reply(400,'invalid_input');}
  if(!obj(b)||Object.keys(b).sort().join()!=='email,listId,version'||b.version!==1||b.listId!==config.listId
   ||typeof b.email!=='string'||b.email!==b.email.trim().toLowerCase()||b.email.length>254
   ||!/^\S+@[^\s@]+\.[A-Za-z]{2,}$/.test(b.email))return reply(400,'invalid_input');
  if(provider.mode!==config.coupon.mode)return reply(503,'provider_mode_mismatch');
  requestKey=await digest(JSON.stringify([config.coupon.businessId,config.flowId,config.listId,b.email]));
  const local=await store.rpc('vip_doi_webhook_match_v1',{p_business_id:config.coupon.businessId,p_email:b.email,p_list_id:config.listId});
  if(!obj(local))throw Error('local_context_unconfirmed');
  if(local.allowed!==true){
   const code=['local_request_unmatched','local_request_ambiguous','recipient_blocked'].includes(String(local.code))?String(local.code):'local_request_unmatched';
   await observe('blocked',code);return reply(200,code);
  }
  if(local.businessId!==config.coupon.businessId||!uuid(local.customerId)||!uuid(local.signupId))throw Error('local_context_unconfirmed');
  // Reuse every existing account/list/profile/date/suppression check. Only the
  // final DB call is wrapped to commit the dedupe receipt with the same coupon.
  const wrapped:CouponStore={async rpc(name,args){
   if(name==='coupon_record_confirmed_vip_v1')return store.rpc('vip_doi_webhook_confirm_v1',{...args,p_account_id:config.coupon.accountId});
   return store.rpc(name,args);
  }};
  const result=await confirmCouponVip({store:wrapped,provider,businessId:config.coupon.businessId,
   customerId:local.customerId,signupId:local.signupId,accountId:config.coupon.accountId});
  if(result.status==='confirmed'){await observe('confirmed','confirmation_recorded');return reply(200,'confirmation_recorded');}
  if(result.status==='blocked'&&['provider_recipient_blocked','customer_ineligible'].includes(result.code)){
   await observe('blocked','recipient_blocked');return reply(200,'recipient_blocked');
  }
  // Includes eventual consistency: no acknowledgement until proof is stored.
  await observe('retryable','verification_unconfirmed');return reply(503,'verification_unconfirmed');
 }catch{
  if(requestKey)await observe('retryable','database_unavailable').catch(()=>undefined);
  return reply(503,'processing_unconfirmed');
 }
}
