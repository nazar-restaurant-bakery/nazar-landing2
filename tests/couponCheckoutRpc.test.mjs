import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fixture} from './fixtures/signupRewardCouponsNative.mjs';
import {validCoupon,receiptNote,redemptionResult,forbidden} from '../src/lib/couponCheckout.ts';
test('cashier adapters accept actual order 14/14a RPCs and reject repeated/unauthorized redemption',async()=>{
 const h=await fixture();try{
 h.sql(await readFile(new URL('../supabase/migrations/20261021000825_coupon_delivery_reconciliation.sql',import.meta.url),'utf8'));
 h.reward();const customer=h.customer({status:'pending_review'}),signup=h.signup(customer);h.confirm(customer,signup);const coupon=h.coupon(customer),business=h.config.businessId,actor=h.config.scopeFixture.users.ownerA;
 const lookup=()=>h.sql('SELECT public.coupon_lookup_v1('+h.literal(business)+','+h.literal(coupon.code)+')',{role:'authenticated',subject:actor});
 const ready=lookup();assert.equal(validCoupon(ready),true);assert.equal(ready.valid,true);
 const note=receiptNote({orderId:'',text:'',channel:'dine_in',amount:'30.00',receiptAt:new Date().toISOString(),receiptRef:'SYNTHETIC-UI-RPC',checked:true},ready);assert.ok(note);
 const result=h.redeem(coupon.code,{attestation:note});assert.equal(redemptionResult(result),true);assert.equal(result.redeemed,true);
 const repeat=h.redeem(coupon.code,{attestation:note});assert.equal(redemptionResult(repeat),true);assert.equal(repeat.code,'already_used');assert.equal(validCoupon(lookup()),true);assert.equal(lookup().status,'used');
 const denied=h.raw('SELECT public.coupon_lookup_v1('+h.literal(business)+','+h.literal(coupon.code)+')',{role:'authenticated',subject:h.config.scopeFixture.users.platformOnly});assert.notEqual(denied.status,0);assert.equal(forbidden({error:{code:'42501'}}),true);
 }finally{await h.stop();}
});
