import test from 'node:test';
import assert from 'node:assert/strict';
import {takeSignupAttempt, signupAttemptsExhausted, clearSignupAttempts} from '../src/lib/signupAttempts.ts';
import {readSignupDraft, saveSignupDraft, requestIdForSignup, savePendingVipEmail, readPendingVipEmail, clearSignupDraft} from '../src/lib/signupRecovery.ts';
import {t} from '../src/components/i18n.ts';
function store(){const data=new Map();return {data,getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}}
const id='f6d45fb6-0b8c-4e67-8a22-62ae287a8b13';
test('initial attempt plus one retry survive reload; third call is not reserved',()=>{
 const s=store(),m={}; assert.equal(takeSignupAttempt(s,'budget',id,m,100),true);
 assert.equal(takeSignupAttempt(s,'budget',id,{},200),true);
 assert.equal(signupAttemptsExhausted(s,'budget',id,{},300),true);
 assert.equal(takeSignupAttempt(s,'budget',id,{},400),false);
 assert.equal(JSON.parse(s.getItem('budget')).count,2);
});
test('unavailable storage retains the limit in the current component',()=>{
 const broken={getItem(){throw Error('private')},setItem(){throw Error('private')},removeItem(){throw Error('private')}};const m={};
 assert.equal(takeSignupAttempt(broken,'budget',id,m,100),true);assert.equal(takeSignupAttempt(broken,'budget',id,m,200),true);assert.equal(takeSignupAttempt(broken,'budget',id,m,300),false);
});
test('each step has its own finite budget and ledger contains no form fields',()=>{
 const s=store();takeSignupAttempt(s,'crm',id,{},100);takeSignupAttempt(s,'crm',id,{},200);
 assert.equal(takeSignupAttempt(s,'email',id,{},300),true);
 assert.deepEqual(Object.keys(JSON.parse(s.getItem('crm'))).sort(),['count','requestId','startedAt']);
 assert.equal(takeSignupAttempt(s,'crm','a-new-content-id',{},400),true);
});
test('the budget expires after one day, ignores corrupt storage and clears on success',()=>{
 const s=store(),m={};takeSignupAttempt(s,'budget',id,m,100);takeSignupAttempt(s,'budget',id,m,200);
 assert.equal(takeSignupAttempt(s,'budget',id,m,100+24*60*60*1000+1),true);
 clearSignupAttempts(s,'budget',m);assert.equal(s.getItem('budget'),null);assert.deepEqual(m,{});
 s.setItem('budget','null');assert.equal(takeSignupAttempt(s,'budget',id,m,300),true);
});
function pendingFixture(){const s=store(),fields={name:'Synthetic Guest',email:'guest@example.invalid',phone:'',consentEmail:true};saveSignupDraft(s,'draft',fields);requestIdForSignup(s,'draft',{kind:'vip'}, {},()=>id);const pending={email:fields.email,name:fields.name,campaign:'synthetic',requestId:id};savePendingVipEmail(s,'draft',pending);return {s,fields,pending}}
test('accepted CRM stage survives autosave/reload without needing another CRM request',()=>{
 const {s,fields,pending}=pendingFixture();saveSignupDraft(s,'draft',fields);assert.deepEqual(readPendingVipEmail(s,'draft'),pending);
 clearSignupDraft(s,'draft');assert.equal(readPendingVipEmail(s,'draft'),null);
});
test('mismatched identity, missing consent and expired drafts cannot restore email continuation',()=>{
 for(const mutate of [d=>{d.fields.email='other@example.invalid'},d=>{d.fields.consentEmail=false},d=>{d.pendingEmail.requestId='bad'},d=>{d.savedAt=0}]){
  const {s}=pendingFixture();const d=JSON.parse(s.getItem('draft'));mutate(d);s.setItem('draft',JSON.stringify(d));assert.equal(readPendingVipEmail(s,'draft'),null);
 }
});
test('new content receives no old pending-email step',()=>{
 const {s}=pendingFixture();requestIdForSignup(s,'draft',{kind:'vip',different:true},{},()=> 'f6d45fb6-0b8c-4e67-8a22-62ae287a8b14');assert.equal(readSignupDraft(s,'draft').pendingEmail,undefined);
});
test('manual recovery and catering date validation show nonempty text in all site languages',()=>{
 for(const lang of ['en','tr','ar'])for(const key of ['vip.retryLimit','vip.confirmationLimit','catering.errorDateGuests'])assert.ok(t(key,lang).trim().length>10);
});
