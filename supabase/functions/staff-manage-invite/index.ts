// Auth admin key is read only in this server module. No credentials/email bodies logged.
type Env=Record<string,string|undefined>;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
class RpcError extends Error {status:number;constructor(status:number){super('rpc_unavailable');this.status=status;}}
export function inviteHandler(fetcher:typeof fetch=fetch){return async(request:Request,env:Env)=>{
 const origin=request.headers.get('Origin')||'';
 const cors={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS','Vary':'Origin','Cache-Control':'no-store'};
 const reply=(status:number,code:string)=>new Response(JSON.stringify({code}),{status,headers:{...cors,'Content-Type':'application/json'}});
 if(!/^https:\/\/[A-Za-z0-9.-]+$/.test(origin))return reply(403,'forbidden');
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 if(request.method!=='POST')return reply(405,'method_not_allowed');
 const bearer=request.headers.get('Authorization')||'';
 if(!/^Bearer [A-Za-z0-9._-]{10,8192}$/.test(bearer))return reply(401,'unauthorized');
 const url=env.SUPABASE_URL,key=env.SUPABASE_ANON_KEY,admin=env.SUPABASE_SERVICE_ROLE_KEY;
 if(!url||!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url)||!key||!admin||key===admin)return reply(503,'configuration_required');
 let body:Record<string,unknown>;
 try{const raw=await request.text();if(raw.length>2048)return reply(400,'invalid_request');const value:unknown=JSON.parse(raw);if(!object(value))return reply(400,'invalid_request');body=value;}catch{return reply(400,'invalid_request');}
 if(Object.keys(body).some(k=>!['businessId','email','role','requestId'].includes(k))||!uuid(body.businessId)||!uuid(body.requestId)
 ||typeof body.email!=='string'||body.email.trim().length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())||!['owner','manager','staff'].includes(String(body.role)))return reply(400,'invalid_request');
 const rpc=async(name:string,args:Record<string,unknown>,service=false):Promise<Record<string,unknown>|null>=>{
  const r=await fetcher(url+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:service?admin:key,Authorization:service?'Bearer '+admin:bearer,'Content-Type':'application/json'},body:JSON.stringify(args),redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new RpcError(r.status);const data:unknown=await r.json();if(data===null)return null;if(!object(data))throw new RpcError(503);return data;
 };
 let inviteId:string|null=null,token:string|null=null,deliveryStarted=false;
 const finish=async(outcome:string,userId:string|null=null)=>rpc('staff_invite_finish_v1',{p_business_id:body.businessId,p_invite_id:inviteId,p_claim_token:token,p_auth_user_id:userId,p_outcome:outcome},true);
 const knownReply=(r:Record<string,unknown>|null)=>{
  const code=typeof r?.code==='string'&&['invited','existing_account_added','member_exists','invite_rejected','invite_unknown','access_revoked','in_progress','configuration_required','expired','sending'].includes(r.code)?r.code:'invite_unknown';
  return reply(['invited','existing_account_added','member_exists'].includes(code)?200:code==='configuration_required'?503:409,code);
 };
 try{
  // Authoritative Auth lookup, never decode/trust a caller-supplied sub or actor UUID.
  const auth=await fetcher(url+'/auth/v1/user',{headers:{apikey:key,Authorization:bearer},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!auth.ok)return reply(401,'unauthorized');const user:unknown=await auth.json();if(!object(user)||!uuid(user.id))return reply(401,'unauthorized');
  const context=await rpc('staff_management_context_v1',{p_business_id:body.businessId});
  if(!context?.inviteEnabled||typeof context.redirectUrl!=='string')return reply(503,'configuration_required');
  if(new URL(context.redirectUrl).origin!==origin)return reply(403,'forbidden');
  const prepared=await rpc('staff_invite_prepare_v1',{p_business_id:body.businessId,p_email:body.email.trim().toLowerCase(),p_role:body.role,p_request_key:body.requestId});
  if(prepared?.code!=='prepared'||!uuid(prepared.inviteId))return knownReply(prepared);
  inviteId=prepared.inviteId;
  const gate=await rpc('staff_invite_gate_v1',{p_business_id:body.businessId,p_invite_id:inviteId});
  if(!uuid(gate?.claimToken))return reply(409,'in_progress');token=gate.claimToken;
  const bound=await rpc('staff_invite_context_v1',{p_business_id:body.businessId,p_invite_id:inviteId,p_claim_token:token},true);
  if(!bound||typeof bound.email!=='string'||typeof bound.redirectUrl!=='string'||new URL(bound.redirectUrl).origin!==origin)return knownReply(await finish('failed'));
  if(uuid(bound.existingUserId))return knownReply(await finish('existing',bound.existingUserId));
  deliveryStarted=true;
  const invited=await fetcher(url+'/auth/v1/invite?redirect_to='+encodeURIComponent(bound.redirectUrl),{method:'POST',headers:{apikey:admin,Authorization:'Bearer '+admin,'Content-Type':'application/json'},body:JSON.stringify({email:bound.email}),redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!invited.ok)return knownReply(await finish(invited.status>=500?'unknown':'failed'));
  const created:unknown=await invited.json();
  if(!object(created)||!uuid(created.id))return knownReply(await finish('unknown'));
  return knownReply(await finish('invited',created.id));
 }catch(error){
  // Never resend after Auth timeout or a lost finalizer response. A matching
  // terminal finalize is idempotent; otherwise retain unknown for operator review.
  if(inviteId&&token){try{return knownReply(await finish(deliveryStarted?'unknown':'failed'));}catch{return reply(503,'invite_unknown');}}
  return reply(error instanceof RpcError&&error.status===403?403:error instanceof RpcError&&error.status===400?400:503,error instanceof RpcError&&error.status===403?'forbidden':'invite_unavailable');
 }
};}
declare const Deno:{serve:(fn:(r:Request)=>Promise<Response>)=>void;env:{toObject:()=>Env}};
if(typeof Deno!=='undefined')Deno.serve(req=>inviteHandler()(req,Deno.env.toObject()));
