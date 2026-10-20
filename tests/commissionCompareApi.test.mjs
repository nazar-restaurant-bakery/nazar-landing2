import test from 'node:test';
import assert from 'node:assert/strict';
import {commissionCompareHandler} from '../functions/api/staff/commission-compare.ts';

const site='https://www.nazarrestaurantandbakery.com';
const publicKey='sb_publishable_SYNTHETIC_K13_ONLY';
const secret='sb_secret_SYNTHETIC_MUST_NOT_BE_SENT';
const bearer='Bearer synthetic_k13_staff_jwt_123456789';
const business='a358eba4-b197-4309-805b-46f43a718454';
const env={VITE_SUPABASE_ANON_KEY:publicKey,SUPABASE_SECRET_KEY:secret};
const request=(body={month:'2026-09'})=>new Request(site+'/api/staff/commission-compare',
 {method:'POST',headers:{Origin:site,Authorization:bearer,'Content-Type':'application/json'},body:JSON.stringify(body)});
function harness({allowed=true,comparisonStatus=200}={}){
 const calls=[];
 const fetcher=async(url,init)=>{
  const name=String(url).split('/').at(-1),body=JSON.parse(init.body);
  calls.push({name,body,apiKey:init.headers.apikey,authorization:init.headers.Authorization});
  if(name==='staff_business_authorized_v1')return Response.json(allowed);
  return comparisonStatus===200?Response.json({business_id:business,canPersist:false}):
   Response.json({code:'42501'},{status:comparisonStatus});
 };
 return {calls,run:()=>commissionCompareHandler(fetcher)({request:request(),env})};
}
test('comparison checks ops.read for configured business and uses staff JWT, never service key',async()=>{
 const h=harness(),response=await h.run();assert.equal(response.status,200);
 assert.deepEqual(h.calls.map(c=>c.name),['staff_business_authorized_v1','commission_compare_from_orders_v1']);
 assert.deepEqual(h.calls[0].body,{p_business_id:business,p_operation:'ops.read'});
 assert.deepEqual(h.calls[1].body,{p_business_id:business,p_month:'2026-09-01'});
 for(const call of h.calls){assert.equal(call.apiKey,publicKey);assert.equal(call.authorization,bearer);
  assert.notEqual(call.apiKey,secret);assert.notEqual(call.authorization,`Bearer ${secret}`);}
});
test('denied scope returns HTTP 403 and never reads commission',async()=>{
 const h=harness({allowed:false}),response=await h.run();assert.equal(response.status,403);
 assert.deepEqual(h.calls.map(c=>c.name),['staff_business_authorized_v1']);
});
test('database SQLSTATE 42501 mapped by PostgREST to HTTP 403 stays 403',async()=>{
 const h=harness({comparisonStatus:403}),response=await h.run();assert.equal(response.status,403);
 assert.deepEqual((await response.json()).code,'forbidden');
});
test('client cannot choose another business or request a write operation',async()=>{
 const h=harness(),response=await commissionCompareHandler(async()=>{throw Error('must not fetch');})
  ({request:request({month:'2026-09',p_business_id:'22222222-2222-4222-8222-222222222222'}),env});
 assert.ok([400,413].includes(response.status));assert.equal(h.calls.length,0);
});
