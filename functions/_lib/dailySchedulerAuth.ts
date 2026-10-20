export type MachineBody={business_id:string;run_id:string;nonce:string;issued_at:number;claim_token?:string;start_ms?:number;end_ms?:number};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validMachine(body:unknown,purpose:'daily.dispatch.v1'|'daily.clover.v1',now=Date.now()):body is MachineBody {
 if(!body||typeof body!=='object'||Array.isArray(body))return false;
 const b=body as MachineBody;
 if(!uuid.test(b.business_id)||!uuid.test(b.run_id)||!uuid.test(b.nonce)||!Number.isSafeInteger(b.issued_at)||Math.abs(now/1000-b.issued_at)>300)return false;
 const keys=['business_id','run_id','nonce','issued_at'];
 if(purpose==='daily.clover.v1'){
  keys.push('claim_token','start_ms','end_ms');
  if(!uuid.test(b.claim_token||'')||!Number.isSafeInteger(b.start_ms)||!Number.isSafeInteger(b.end_ms)||b.end_ms!<=b.start_ms!||b.end_ms!-b.start_ms!>25*3600000)return false;
 }
 return Object.keys(b).every(k=>keys.includes(k));
}
function message(purpose:string,b:MachineBody){return [purpose,b.business_id,b.run_id,b.nonce,String(b.issued_at),...(purpose==='daily.clover.v1'?[b.claim_token,String(b.start_ms),String(b.end_ms)]:[])].join('\n');}
async function key(secret:string){if(secret.length<32)throw Error('machine_not_configured');return crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function machineSignature(purpose:string,b:MachineBody,secret:string){return [...new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret),new TextEncoder().encode(message(purpose,b))))].map(v=>v.toString(16).padStart(2,'0')).join('');}
export async function verifyMachine(purpose:'daily.dispatch.v1'|'daily.clover.v1',b:unknown,signature:string,secret:string,now=Date.now()){
 if(!validMachine(b,purpose,now)||! /^[a-f0-9]{64}$/.test(signature)||secret.length<32)return false;
 const bytes=new Uint8Array(signature.match(/../g)!.map(v=>parseInt(v,16)));
 return crypto.subtle.verify('HMAC',await key(secret),bytes,new TextEncoder().encode(message(purpose,b)));
}
