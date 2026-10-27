import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validCouponAutomationBody,couponAutomationSignature,verifyCouponAutomation} from '../functions/_lib/couponAutomationAuth.ts';
import {couponAccountPacer,normalCouponProviders} from '../functions/_lib/couponAutomationTransport.ts';
const secret='synthetic_machine_secret_12345678901234567890',now=Date.parse('2026-10-26T22:00:00Z');
const body={version:1,businessId:'10000000-0000-4000-8000-000000000001',runId:'20000000-0000-4000-8000-000000000001',issuedAt:now/1000};
test('HMAC exact purpose/body and machine-only 60s freshness',async()=>{const sig=await couponAutomationSignature(body,secret);assert.equal(sig.length,64);assert.equal(await verifyCouponAutomation(body,sig,secret,now),true);assert.equal(await verifyCouponAutomation({...body,runId:'30000000-0000-4000-8000-000000000001'},sig,secret,now),false);assert.equal(await verifyCouponAutomation(body,sig,secret+'x',now),false);assert.equal(await verifyCouponAutomation(body,sig,secret,now+61000),false);assert.equal(await verifyCouponAutomation(body,sig,secret,now-61000),false);});
for(const change of [{businessId:[body.businessId]},{runId:[body.runId]},{issuedAt:String(body.issuedAt)},{version:2},{extra:'scope'},{issuedAt:NaN}])test('machine rejects ambiguous/malformed body '+JSON.stringify(change),()=>assert.equal(validCouponAutomationBody({...body,...change},now),false));
test('normal account pacer serializes keys, delays initial read and never retries failed read',async()=>{let clock=0,calls=0;const at=[];const pace=couponAccountPacer({now:()=>clock,sleep:async ms=>{clock+=ms;}});await Promise.all([0,1,2].map(i=>pace(async()=>{at.push(clock);calls++;if(i===1)throw Error('synthetic429');return i;}).catch(()=>undefined)));assert.equal(calls,3);assert.deepEqual(at,[4200,8400,12600]);});
test('normal read/event/receipt Accounts share pacing without changing event or profile methods',async()=>{let clock=0;const at=[],requests=[];const c={mode:'live',approvalId:'synthetic-review',readKey:'pk_synthetic_read_123456',eventKey:'pk_synthetic_event_123456',receiptKey:'pk_synthetic_receipt_123456'};const fetcher=async(u,o)=>{requests.push({u,o});if(new URL(u).pathname==='/api/accounts/')at.push(clock);return Response.json({data:[]});};const {provider,receiptProvider}=normalCouponProviders(c,fetcher,{now:()=>clock,sleep:async ms=>{clock+=ms;}});await provider.get('/accounts');await provider.eventAccount();await receiptProvider.get('/accounts');assert.deepEqual(at,[4200,8400,12600]);assert.ok(requests.every(x=>x.o.method==='GET'&&x.o.redirect==='manual'&&x.o.headers.revision==='2026-07-15'));});

test('Edge source gateway delegates to mandatory HMAC before database access',async()=>{
 const config=await readFile(new URL('../supabase/config.toml',import.meta.url),'utf8');
 assert.match(config,/\[functions\.coupon-welcome-run\]\s+verify_jwt = false/);
});
