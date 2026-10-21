import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeCoupon,couponFromQr,validCoupon,receiptNote,forbidden,redemptionResult} from '../src/lib/couponCheckout.ts';
const ready={status:'valid',valid:true,reason:'valid',customerNameMasked:'A***',couponId:'11111111-1111-4111-8111-111111111111',campaign:{id:'22222222-2222-4222-8222-222222222222',name:'INTERNAL TEST',benefitType:'item',minimumAmountCents:3000,channels:['dine_in','site_pickup','site_delivery'],units:1},expiresAt:null,redeemedAt:null};
const receipt={orderId:'',text:'',channel:'dine_in',amount:'30.00',receiptAt:'2026-10-21T12:30:00-04:00',receiptRef:'SYNTHETIC-RECEIPT-1',checked:true};
test('code normalization accepts only 16 contract symbols; QR accepts only versioned coupon payload, never a URL',()=>{
 assert.equal(normalizeCoupon('2345 6789-abcd efgh'),'2345-6789-ABCD-EFGH');assert.equal(couponFromQr('VIPCOUPON1:2345-6789-ABCD-EFGH'),'2345-6789-ABCD-EFGH');
 for(const v of ['O23456789ABCDEFG','123456789ABCDEFG','2345-6789-ABCD-EFGH.extra','https://example.invalid/?code=23456789ABCDEFGH'])assert.equal(normalizeCoupon(v),null);
 for(const v of ['2345-6789-ABCD-EFGH','VIPCOUPON2:2345-6789-ABCD-EFGH','https://example.invalid/VIPCOUPON1:2345-6789-ABCD-EFGH'])assert.equal(couponFromQr(v),null);
});
for(const status of ['valid','used','inactive','expired'])test('safe lookup shape: '+status,()=>{
 assert.ok(validCoupon({...ready,status,valid:status==='valid',redeemedAt:status==='used'?'2026-10-21T16:30:00Z':null}));
});
for(const status of ['wrong_business','not_found'])test(status+' never exposes another customer or campaign',()=>{
 const value={...ready,status,valid:false,customerNameMasked:null,campaign:null,couponId:null};assert.ok(validCoupon(value));assert.equal(validCoupon({...value,customerNameMasked:'A***'}),false);
});
test('malformed or unmasked responses cannot unlock redemption',()=>{
 for(const value of [{...ready,customerNameMasked:'Alice Test'},{...ready,valid:false},{...ready,campaign:{...ready.campaign,minimumAmountCents:2999}},{...ready,campaign:{...ready.campaign,channels:['marketplace']}},{...ready,status:'used',valid:false}])assert.equal(validCoupon(value),false);
 assert.ok(validCoupon({...ready,customerNameMasked:'***'}));
});
test('receipt uses integer cents, exact note v1 and ISO instant; optional text has explicit checked attestation',()=>{
 assert.deepEqual(receiptNote(receipt,ready,Date.parse('2026-10-22Z')),{version:1,text:'Fiş ve sipariş kontrol edildi',channel:'dine_in',qualifyingAmountCents:3000,receiptAt:'2026-10-21T16:30:00.000Z',receiptRef:'SYNTHETIC-RECEIPT-1'});
 assert.equal(receiptNote({...receipt,amount:'30,01'},ready,Date.parse('2026-10-22Z')).qualifyingAmountCents,3001);
});
for(const change of [{amount:'29.99'},{amount:'30.001'},{amount:'3e3'},{channel:'marketplace'},{checked:false},{receiptAt:'2030-01-01T00:00Z'},{receiptRef:''},{orderId:'bad/id'},{text:'x'.repeat(1001)}])test('invalid receipt is blocked '+JSON.stringify(Object.keys(change)),()=>assert.equal(receiptNote({...receipt,...change},ready,Date.parse('2026-10-22Z')),null));
test('403 / 42501 have one denied boundary, not business rejection or success',()=>{
 assert.ok(forbidden({error:{code:'42501'}}));assert.ok(forbidden({error:null,status:403}));assert.equal(forbidden({error:{code:'22023'}}),false);
 assert.ok(redemptionResult({redeemed:false,status:'used',code:'already_used'}));assert.equal(redemptionResult({redeemed:true,status:'used',code:'redeemed'}),false);
});
