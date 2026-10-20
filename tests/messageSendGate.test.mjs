import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runMessageSendGate} from '../functions/_lib/messageSendGate.ts';

// The RPC store and transport are synthetic. Actual clock-window/concurrency
// enforcement is tested separately against the real K6 SQL, not inferred here.
const NOW = Date.parse('2026-10-20T12:00:00Z');
const RESERVATION = '11111111-2222-4333-8444-555555555555';
const LEASE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const EXPIRY = new Date(NOW + 120000).toISOString();
const intent = (patch = {}) => ({ businessId:'12345678-1234-4234-8234-123456789012',
  customerId:'87654321-4321-4321-8321-210987654321', messageKey:'campaign:test:one',
  messageKind:'campaign', payloadSha256:'a'.repeat(64), ...patch });
const context = input => ({ ...input, leaseId:LEASE, dispatchExpiresAt:EXPIRY,
  email:'synthetic-customer@example.invalid', emailStatus:'subscribed', isTest:false,
  suppressedAt:null, providerBlockedStatus:null });

function harness(options = {}) {
  const h = { calls:[], sends:[], finishes:[], record:null };
  const store = {
    async reserve(input) {
      h.calls.push(['reserve', structuredClone(input)]);
      options.onReserve?.(input,h);
      if (options.reserve) return options.reserve(input,h);
      if (h.record) {
        const same = h.record.intent.messageKey === input.messageKey;
        if (!same) return {allowed:false,code:'frequency_limited'};
        if (JSON.stringify(h.record.intent) !== JSON.stringify(input)) return {allowed:false,code:'idempotency_conflict'};
        if (h.record.status !== 'reserved') return {allowed:false,code:'already_processed',status:h.record.status};
        return {allowed:true,code:'already_reserved',status:'reserved',reservationId:RESERVATION,idempotent:true};
      }
      h.record = {intent:structuredClone(input),status:'reserved'};
      return {allowed:true,code:'reserved',status:'reserved',reservationId:RESERVATION,idempotent:false};
    },
    async claim(id) {
      h.calls.push(['claim',id]);
      if (options.claim) return options.claim(id,h);
      if (h.record.status !== 'reserved') return {allowed:false,code:'not_claimable',reservationId:id,status:h.record.status};
      h.record.status = 'claimed';
      return {allowed:true,code:'claimed',reservationId:id,status:'claimed',leaseId:LEASE,dispatchExpiresAt:EXPIRY};
    },
    async context(id,lease) {
      h.calls.push(['context',id,lease]);
      if (options.context) return options.context(id,lease,h);
      if (h.record.status !== 'claimed') return {allowed:false,code:'already_dispatched',reservationId:id,status:h.record.status};
      h.record.status = 'sending';
      return {allowed:true,code:'dispatch_authorized',reservationId:id,status:'sending',context:context(h.record.intent)};
    },
    async finalize(id,lease,outcome) {
      h.calls.push(['finalize',id,lease,outcome]); h.finishes.push(outcome);
      if (options.finalize) return options.finalize(id,lease,outcome,h);
      if (['sent','unknown','blocked'].includes(h.record.status)) return {status:h.record.status,idempotent:true};
      h.record.status = outcome;
      return {status:outcome,idempotent:false};
    },
  };
  const transport = {mode:'synthetic',async send(request) {
    h.sends.push(request);
    return options.send ? options.send(request,h) : {accepted:true};
  }};
  h.run = (input = intent(), extra = {}) => runMessageSendGate({intent:input,store,transport,now:()=>NOW,...extra});
  return h;
}

test('campaign and flow use the same reserve/claim/consuming-context path before the sole synthetic dispatch',async()=>{
  for (const kind of ['campaign','flow']) {
    const h=harness(); const result=await h.run(intent({messageKind:kind,messageKey:kind+':test:one'}));
    assert.equal(result.status,'sent'); assert.equal(result.synthetic,true);
    assert.deepEqual(h.calls.map(c=>c[0]),['reserve','claim','context','finalize']);
    assert.equal(h.sends.length,1); assert.equal(h.sends[0].messageKind,kind);
    assert.ok(h.sends[0].signal instanceof AbortSignal);
    assert.equal(h.sends[0].leaseId,undefined);
    assert.deepEqual(Object.keys(h.calls[0][1]).sort(),['businessId','customerId','messageKey','messageKind','payloadSha256']);
    assert.equal(JSON.stringify(result).includes('example.invalid'),false);
    assert.equal(JSON.stringify(result).includes(LEASE),false);
  }
});

test('caller cannot override person identity, window, eligibility, provider or synthetic-only transport',async()=>{
  for (const patch of [{windowHours:0},{personId:'another-person'},{email:'other@example.invalid'},
    {isTest:false},{emailStatus:'subscribed'},{providerUrl:'synthetic://not-accepted'},
    {businessId:'bad'},{customerId:'bad'},{messageKind:'transactional'},{messageKey:'short'},
    {payloadSha256:'not-a-hash'}]) {
    const h=harness(); assert.equal((await h.run(intent(patch))).code,'invalid_intent');
    assert.equal(h.calls.length,0); assert.equal(h.sends.length,0);
  }
  const h=harness(); const result=await h.run(intent(),{transport:{mode:'live',send(){assert.fail('No live transport');}}});
  assert.equal(result.code,'invalid_transport'); assert.equal(h.calls.length,0);
});

test('server denials and disabled/missing policy fail closed without a claim or send',async()=>{
  for (const code of ['settings_disabled','customer_ineligible','frequency_limited','idempotency_conflict','already_processed']) {
    const h=harness({reserve:()=>({allowed:false,code})});
    assert.deepEqual(await h.run(),{status:'blocked',code,synthetic:true});
    assert.deepEqual(h.calls.map(c=>c[0]),['reserve']); assert.equal(h.sends.length,0);
  }
});

test('a campaign reservation also blocks a different flow; changing message kind never selects another quota',async()=>{
  const h=harness(); assert.equal((await h.run()).status,'sent');
  const next=await h.run(intent({messageKey:'flow:test:other',messageKind:'flow'}));
  assert.equal(next.code,'frequency_limited'); assert.equal(h.sends.length,1);
  assert.equal(h.calls.at(-1)[0],'reserve');
});

test('repeated or concurrent identical requests dispatch at most once with database-owned claim fencing',async()=>{
  const h=harness(); const results=await Promise.all([h.run(),h.run()]);
  assert.equal(results.filter(r=>r.status==='sent').length,1);
  assert.equal(h.sends.length,1); assert.equal(h.calls.filter(c=>c[0]==='context').length,1);
  assert.equal((await h.run()).code,'already_processed'); assert.equal(h.sends.length,1);
});

test('mutation of the original intent after reserve cannot retarget a pending request',async()=>{
  const input=intent(); const h=harness({onReserve(){input.messageKey='flow:changed:after';input.customerId=RESERVATION;}});
  assert.equal((await h.run(input)).status,'sent');
  assert.equal(h.sends[0].messageKey,'campaign:test:one');
  assert.equal(h.sends[0].customerId,intent().customerId);
});

test('consent, suppression, test status, recipient and payload changes are rechecked before dispatch',async()=>{
  for (const patch of [{emailStatus:'unsubscribed'},{emailStatus:'not_subscribed'},{isTest:true},
    {suppressedAt:new Date(NOW).toISOString()},{providerBlockedStatus:'suppressed'},
    {businessId:RESERVATION},{customerId:RESERVATION},{messageKey:'changed:key:one'},
    {messageKind:'flow'},{payloadSha256:'b'.repeat(64)},{leaseId:RESERVATION},
    {dispatchExpiresAt:new Date(NOW-1).toISOString()},{email:'invalid'},
    {emailStatus:undefined},{isTest:undefined},{suppressedAt:undefined},{providerBlockedStatus:undefined}]) {
    const h=harness({context:(id,_lease,h)=>({allowed:true,code:'dispatch_authorized',status:'sending',reservationId:id,
      context:{...context(h.record.intent),...patch}})});
    const result=await h.run(); assert.equal(result.code,'invalid_context'); assert.equal(h.sends.length,0);
    assert.deepEqual(h.finishes,['blocked']);
  }
});

test('current-state denial already terminalized by the DB is not rewritten or sent',async()=>{
  for (const [status,code] of [['blocked','customer_ineligible'],['unknown','lease_expired']]) {
    const h=harness({context:id=>({allowed:false,code,reservationId:id,status})});
    assert.equal((await h.run()).status,status); assert.equal(h.sends.length,0); assert.equal(h.finishes.length,0);
  }
  const h=harness({context:id=>({allowed:false,code:'already_dispatched',reservationId:id,status:'sending'})});
  assert.equal((await h.run()).status,'unknown'); assert.equal(h.sends.length,0); assert.deepEqual(h.finishes,['unknown']);
});

test('lost claim acknowledgement or consumed context acknowledgement never triggers a send/retry',async()=>{
  const claim=harness({claim(){throw new Error('PRIVATE_STORE_ERROR');}});
  assert.equal((await claim.run()).code,'claim_unconfirmed');
  assert.equal(claim.sends.length,0); assert.equal(claim.calls.filter(c=>c[0]==='claim').length,1);
  const context=harness({context(_id,_lease,h){h.record.status='sending';throw new Error('PRIVATE_CONTEXT_ACK');}});
  const result=await context.run(); assert.equal(result.status,'unknown');
  assert.equal(context.sends.length,0); assert.deepEqual(context.finishes,['unknown']);
  assert.equal(context.calls.filter(c=>c[0]==='context').length,1);
  assert.equal((await context.run()).code,'already_processed');
});

test('transport exception, malformed acknowledgement and timeout become unknown with no automatic resend',async()=>{
  for (const send of [async()=>{throw new Error('PRIVATE_KEY person@example.invalid');},
    async()=>({accepted:false}),async()=>({accepted:true,raw:'PRIVATE_RESPONSE'}),async()=>new Promise(()=>{})]) {
    const h=harness({send}); const result=await h.run(intent(),{timeoutMs:3});
    assert.equal(result.status,'unknown'); assert.equal(h.sends.length,1); assert.deepEqual(h.finishes,['unknown']);
    assert.equal((await h.run()).code,'already_processed'); assert.equal(h.sends.length,1);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE|person@/);
  }
});

test('accepted dispatch with lost finalize ACK is never reported as sent or automatically dispatched again',async()=>{
  const h=harness({finalize(_id,_lease,outcome,h){h.record.status=outcome;throw new Error('PRIVATE_RECEIPT_ACK_LOST');}});
  const result=await h.run(); assert.equal(result.status,'unknown'); assert.equal(result.code,'finalize_unconfirmed');
  assert.equal(h.record.status,'sent'); assert.equal(h.sends.length,1); assert.deepEqual(h.finishes,['sent']);
  assert.equal((await h.run()).code,'already_processed'); assert.equal(h.sends.length,1);
});

test('a contradictory or malformed final receipt cannot invent successful dispatch',async()=>{
  for (const receipt of [{status:'unknown',idempotent:true},{status:'sent'},null,{status:'sent',idempotent:'false'}]) {
    const h=harness({finalize:()=>receipt}); const result=await h.run();
    assert.equal(result.status,'unknown'); assert.equal(result.code,'finalize_unconfirmed');
    assert.equal(h.sends.length,1); assert.equal(h.finishes.length,1);
  }
});

test('unknown/malformed RPC responses and raw errors never reach the result or a transport',async()=>{
  for (const reserve of [()=>null,()=>({allowed:true,code:'reserved',status:'reserved',reservationId:'PRIVATE_EMAIL'}),
    ()=>({allowed:false,code:'PRIVATE_API_KEY'}),()=>{throw new Error('PRIVATE_EXCEPTION');}]) {
    const h=harness({reserve}); const result=await h.run();
    assert.equal(h.sends.length,0); assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
  }
  const h=harness({claim:id=>({allowed:true,code:'claimed',status:'claimed',reservationId:id,leaseId:LEASE,dispatchExpiresAt:'bad'})});
  assert.equal((await h.run()).code,'claim_unconfirmed'); assert.equal(h.sends.length,0);
});

test('the pure gate never invokes global fetch and includes no live network fallback',async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=()=>{assert.fail('No global network is permitted in K6');};
  try {assert.equal((await harness().run()).status,'sent');}
  finally {globalThis.fetch=previous;}
});
