// Common write gate: the sole adapter is a local dry-run. No provider HTTP path.
import { allowedOrigin, uuid } from "../ops-collect/contracts.ts";
type Env = Record<string,string|undefined>;
type Receipt = {business_id:string;id:string;target_id:string;preview_hash:string;status:string;safe_result_code:string;expires_at:string;claim_token?:string};
const summary = {before:"Örnek işlem uygulanmadı",after:"Yalnız dry-run tamamlanacak; dış sistem değişmez"};
export async function previewHash(business:string,target:string) {
 const bytes=new TextEncoder().encode(JSON.stringify({business_id:business,action_type:"dry_run",target_id:target,...summary}));
 return [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(x=>x.toString(16).padStart(2,"0")).join("");
}
class GateError extends Error {status:number;code:string;constructor(status:number,code:string){super(code);this.status=status;this.code=code;}}
export async function handleWrite(req:Request,env:Env,request:typeof fetch=fetch) {
 const origin=req.headers.get("origin");
 const headers={"Content-Type":"application/json","Access-Control-Allow-Origin":origin||"null","Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info","Access-Control-Allow-Methods":"POST,OPTIONS","Vary":"Origin"};
 const reply=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers});
 if(!allowedOrigin(origin,env))return reply(403,{code:"forbidden"});
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
 if(req.method!=="POST")return reply(405,{code:"method_not_allowed"});
 const bearer=req.headers.get("authorization");
 if(!bearer?.startsWith("Bearer "))return reply(401,{code:"unauthorized"});
 try {
  const url=env.SUPABASE_URL;
  if(!url||!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url)||!env.SUPABASE_ANON_KEY)throw new GateError(503,"configuration_missing");
  if(Number(req.headers.get("content-length"))>2048)throw new GateError(400,"invalid_request");
  const raw=await req.text();if(raw.length>2048)throw new GateError(400,"invalid_request");
  let body:Record<string,unknown>;try{body=JSON.parse(raw);}catch{throw new GateError(400,"invalid_request");}
  if(!body||Array.isArray(body)||!uuid(body.business_id)||!["preview","approve","execute","status"].includes(String(body.operation))
   ||Object.keys(body).some(k=>!["operation","business_id","target_id","idempotency_key","action_id","preview_hash"].includes(k)))throw new GateError(400,"invalid_request");
  const auth=await request(url+"/auth/v1/user",{headers:{apikey:env.SUPABASE_ANON_KEY,Authorization:bearer},redirect:"error",signal:AbortSignal.timeout(8000)});
  if(!auth.ok)throw new GateError(401,"unauthorized");
  const user=await auth.json();if(!uuid(user?.id))throw new GateError(401,"unauthorized");
  async function rpc(name:string,args:Record<string,unknown>):Promise<Receipt|null> {
   const key=env.SUPABASE_ANON_KEY!;
   const response=await request(url+"/rest/v1/rpc/"+name,{method:"POST",headers:{apikey:key,Authorization:bearer!,"Content-Type":"application/json"},body:JSON.stringify(args),redirect:"error",signal:AbortSignal.timeout(10000)});
   if(!response.ok){const error=await response.json().catch(()=>({}));throw new GateError(error.code==="42501"||response.status===403?403:error.code==="55000"||error.code==="22023"?409:503,error.code==="42501"||response.status===403?"forbidden":error.code==="55000"?"disabled":error.code==="22023"?"repreview_required":"gate_unavailable");}
   return await response.json();
  }
  const business=body.business_id;
  if(body.operation==="status"){
   if(!uuid(body.action_id))throw new GateError(400,"invalid_request");
   return reply(200,{action:await rpc("ops_write_status",{p_business_id:business,p_action_id:body.action_id})});
  }
  if(!uuid(body.target_id))throw new GateError(400,"invalid_request");
  const hash=await previewHash(business,body.target_id);
  if(body.operation==="preview"){
   if(!uuid(body.idempotency_key))throw new GateError(400,"invalid_request");
   const action=await rpc("ops_write_preview",{p_business_id:business,p_target_id:body.target_id,p_preview_hash:hash,p_idempotency_key:body.idempotency_key});
   return reply(200,{action,preview:summary});
  }
  if(!uuid(body.action_id)||body.preview_hash!==hash)throw new GateError(409,"repreview_required");
  const args={p_business_id:business,p_action_id:body.action_id,p_target_id:body.target_id,p_preview_hash:hash};
  if(body.operation==="approve")return reply(200,{action:await rpc("ops_write_approve",args)});
  // Keep the verified user's JWT on the PostgREST request. The narrow DB
  // dry-run wrapper calls service-only claim/finalize with the same auth.uid().
  // A service key + supplied p_staff_id would lose this identity chain.
  const action=await rpc("ops_write_execute_dry_run",args);
  if(!action)return reply(409,{code:"approval_not_claimable"});
  return reply(200,{action});
 }catch(error){return reply(error instanceof GateError?error.status:503,{code:error instanceof GateError?error.code:"unknown_result"});}
}
declare const Deno:{serve:(handler:(req:Request)=>Promise<Response>)=>void;env:{toObject:()=>Env}};
if(typeof Deno!=="undefined")Deno.serve(req=>handleWrite(req,Deno.env.toObject()));
