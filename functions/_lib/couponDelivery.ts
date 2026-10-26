import type {CouponStore} from './couponWelcome.ts';
type Json=Record<string,unknown>;
const object=(x:unknown):x is Json=>!!x&&typeof x==='object'&&!Array.isArray(x);
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(x);
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
export type ReceiptProvider={mode:'mock'|'live';get(path:string,query?:Record<string,string>):Promise<unknown>};
export function liveReceiptProvider(key:string,fetcher:typeof fetch=fetch):ReceiptProvider {
 return {mode:'live',async get(path,query={}){
  if(!/^pk_[A-Za-z0-9_-]{10,200}$/.test(key)||!/^\/(accounts|events|metrics\/[A-Za-z0-9_-]{1,100})$/.test(path))throw Error('receipt_read_rejected');
  const url=new URL('https://a.klaviyo.com/api'+path+'/');
  for(const [k,v] of Object.entries(query)){
   if(!['filter','page[size]','fields[event]','include','fields[profile]','fields[metric]'].includes(k))throw Error('receipt_read_rejected');url.searchParams.set(k,v);
  }
  // workerd supports manual, not error. Never follow redirects with the key;
  // accept only 200 below, before reading any provider body.
  const r=await fetcher(url.href,{method:'GET',headers:{Authorization:'Klaviyo-API-Key '+key,revision:'2026-07-15',Accept:'application/vnd.api+json'},redirect:'manual',signal:AbortSignal.timeout(5000)});
  if(r.status!==200)throw Error('receipt_read_unavailable');
  const text=await r.text();if(text.length>1000000)throw Error('receipt_too_large');return JSON.parse(text);
 }};
}
/** A native Received Email is matched to a durable, one-per-profile welcome binding.
 * The trigger event's unique_id is never assumed to echo into Received Email. */
export async function reconcileCouponDelivery({store,provider,businessId,couponId,accountId,now=Date.now}:{store:CouponStore;provider:ReceiptProvider;businessId:string;couponId:string;accountId:string;now?:()=>number}){
 let activationAllowed=false;
 const result=(status:'delivered'|'pending'|'blocked',code:string)=>({status,code,synthetic:provider.mode==='mock',activationReady:status==='delivered'&&provider.mode==='live'&&activationAllowed});
 if(!uuid(businessId)||!uuid(couponId)||!id(accountId))return result('blocked','invalid_input');
 try{
  const c=await store.rpc('coupon_delivery_context_v1',{p_business_id:businessId,p_coupon_id:couponId});
  if(!object(c)||c.businessId!==businessId||c.accountId!==accountId||!uuid(c.bindingId)||![c.profileId,c.flowId,c.messageId,c.metricId].every(id)
   ||typeof c.dispatchedAt!=='string'||!Number.isFinite(Date.parse(c.dispatchedAt))||Date.parse(c.dispatchedAt)>now())return result('blocked','delivery_context_unconfirmed');
  activationAllowed=c.activationAllowed===true;
  const accounts=await provider.get('/accounts');
  if(!object(accounts)||!Array.isArray(accounts.data)||accounts.data.length!==1||!object(accounts.data[0])||accounts.data[0].id!==accountId)return result('blocked','provider_account_mismatch');
  const metric=await provider.get('/metrics/'+c.metricId);
  const data=object(metric)&&object(metric.data)?metric.data:null;
  const a=data&&object(data.attributes)?data.attributes:null;
  const integration=a&&object(a.integration)?a.integration:null;
  if(!data||data.id!==c.metricId||!a||a.name!=='Received Email'||!integration||integration.name!=='Klaviyo'
   ||typeof integration.category!=='string'||integration.category.toLowerCase()!=='internal')return result('blocked','native_received_metric_unconfirmed');
  const events=await provider.get('/events',{filter:`and(equals(metric_id,${JSON.stringify(c.metricId)}),equals(profile_id,${JSON.stringify(c.profileId)}),greater-or-equal(datetime,${new Date(c.dispatchedAt).toISOString()}))`,'page[size]':'100','fields[event]':'datetime,event_properties,uuid'});
  if(!object(events)||!Array.isArray(events.data)||!object(events.links)||events.links.next!==null)return result('pending','receipt_page_incomplete');
  const matches=events.data.filter(e=>{
   if(!object(e)||!id(e.id)||!object(e.attributes)||!object(e.attributes.event_properties)||!object(e.relationships))return false;
   const p=e.attributes.event_properties;const rel=e.relationships;
   return object(rel.profile)&&object(rel.profile.data)&&rel.profile.data.id===c.profileId
    &&object(rel.metric)&&object(rel.metric.data)&&rel.metric.data.id===c.metricId
    &&p.$flow===c.flowId&&p.$message===c.messageId&&typeof e.attributes.datetime==='string'
    &&Date.parse(e.attributes.datetime)>=Date.parse(String(c.dispatchedAt))&&Date.parse(e.attributes.datetime)<=now()+60000;
  });
  if(matches.length!==1)return result('pending',matches.length?'ambiguous_delivery_receipt':'delivery_receipt_waiting');
  const event=matches[0] as Json;const attrs=event.attributes as Json;
  // Persist a digest plus minimal identity/time; no provider body or customer content.
  const normalized={accountId,profileId:c.profileId,metricId:c.metricId,flowId:c.flowId,messageId:c.messageId,eventId:event.id,deliveredAt:attrs.datetime,bindingId:c.bindingId};
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(normalized))))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const receipt=await store.rpc('coupon_delivery_record_v1',{p_business_id:businessId,p_binding_id:c.bindingId,p_provider_event_id:event.id,p_delivered_at:attrs.datetime,p_evidence_sha256:hash});
  if(!object(receipt)||receipt.acknowledged!==true||receipt.code!=='delivery_confirmed'||Date.parse(String(receipt.deliveredAt))!==Date.parse(String(attrs.datetime)))return result('pending','delivery_record_unconfirmed');
  return result('delivered','delivery_confirmed');
 }catch{return result('pending','delivery_reconciliation_unconfirmed');}
}
