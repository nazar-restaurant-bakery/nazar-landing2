// Clover void/refund -> site order, through the real K7 ingest RPC on an owned
// local PostgreSQL 18.6 cluster. Synthetic records only; no hosted connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,lf,sha256,MIGRATION,ROLLBACK} from './fixtures/siteOrderReversalNative.mjs';

const h=await fixture();
test.after(()=>h.stop());

test('full void: payment and order refunded, kitchen ticket cancelled, sourced event', () => {
  const o=h.paidOrder();
  h.ingest(o.cloverOrderId,{payments:[{id:o.paymentId,amount:o.amount,result:'SUCCESS'}]});
  assert.deepEqual(h.state(o.orderId),{order:'paid',payment:'verified',tickets:['new'],events:null});
  h.ingest(o.cloverOrderId,{payments:[{id:o.paymentId,amount:o.amount,result:'VOIDED'}]});
  const s=h.state(o.orderId);
  assert.equal(s.order,'refunded');assert.equal(s.payment,'refunded');assert.deepEqual(s.tickets,['cancelled']);
  assert.equal(s.events.length,1);assert.equal(s.events[0].type,'payment_voided');
  assert.equal(s.events[0].key,'reversal:void:'+o.paymentId);
  assert.equal(s.events[0].details.source,'clover_payment_void');assert.equal(s.events[0].details.via,'k7_ledger');
  assert.equal(s.events[0].details.clover_payment_id,o.paymentId);assert.equal(s.events[0].details.previous_order_status,'paid');
  assert.equal(h.log('void:'+o.paymentId).outcome,'reversed');
  // The Ops queue no longer shows the ticket.
  assert.equal(h.sql(`SELECT count(*) FROM core.site_order_tickets WHERE site_order_id='${o.orderId}' AND status IN ('new','needs_reschedule','accepted','preparing','ready')`),0);
});

test('full refund: same reversal from a core.refunds row', () => {
  const o=h.paidOrder({subtotal:9000,tax:810});const refund=h.key();
  h.ingest(o.cloverOrderId,{payments:[{id:o.paymentId,amount:o.amount,result:'SUCCESS'}],
    refunds:[{id:refund,amount:o.amount,payment:{id:o.paymentId}}]});
  const s=h.state(o.orderId);
  assert.equal(s.order,'refunded');assert.equal(s.payment,'refunded');assert.deepEqual(s.tickets,['cancelled']);
  assert.equal(s.events.length,1);assert.equal(s.events[0].type,'payment_refunded');
  assert.equal(s.events[0].details.clover_refund_id,refund);assert.equal(s.events[0].details.refunded_total_cents,o.amount);
  assert.equal(h.log('refund:'+refund).outcome,'reversed');
});

test('partial refund records an event and does not cancel; the remainder completes the reversal', () => {
  const o=h.paidOrder({subtotal:10000});const first=h.key(),second=h.key();
  const payment={id:o.paymentId,amount:o.amount,result:'SUCCESS'};
  h.ingest(o.cloverOrderId,{payments:[payment],refunds:[{id:first,amount:2500,payment:{id:o.paymentId}}]});
  let s=h.state(o.orderId);
  assert.equal(s.order,'paid');assert.equal(s.payment,'verified');assert.deepEqual(s.tickets,['new']);
  assert.equal(s.events.length,1);assert.equal(s.events[0].type,'payment_partially_refunded');
  assert.equal(s.events[0].details.amount_cents,2500);assert.equal(s.events[0].details.refunded_total_cents,2500);
  assert.equal(h.log('refund:'+first).outcome,'partial_refund');
  h.ingest(o.cloverOrderId,{payments:[payment],refunds:[{id:first,amount:2500,payment:{id:o.paymentId}},{id:second,amount:7500,payment:{id:o.paymentId}}]});
  s=h.state(o.orderId);
  assert.equal(s.order,'refunded');assert.equal(s.payment,'refunded');assert.deepEqual(s.tickets,['cancelled']);
  assert.deepEqual(s.events.map(e=>e.type),['payment_partially_refunded','payment_refunded']);
});

test('the same notification twice changes nothing the second time', () => {
  const o=h.paidOrder();const refund=h.key();
  const snapshot={payments:[{id:o.paymentId,amount:o.amount,result:'SUCCESS'}],refunds:[{id:refund,amount:o.amount,payment:{id:o.paymentId}}]};
  h.ingest(o.cloverOrderId,snapshot);const once=h.state(o.orderId);
  h.ingest(o.cloverOrderId,snapshot);h.ingest(o.cloverOrderId,snapshot);
  assert.deepEqual(h.state(o.orderId),once);
  const row=h.log('refund:'+refund);assert.equal(row.outcome,'reversed');assert.equal(row.attempts,1);
  assert.equal(h.sql(`SELECT to_jsonb(core.site_order_clover_reversal_apply_v1('${h.businessId}','${h.merchant}','clover_refund','${refund}','${o.paymentId}',${o.amount},${o.amount},'{}'))`),'duplicate');
  // A later void of the same, already refunded payment is logged but changes nothing.
  h.ingest(o.cloverOrderId,{...snapshot,payments:[{id:o.paymentId,amount:o.amount,result:'VOIDED'}]});
  const after=h.state(o.orderId);
  assert.equal(after.order,'refunded');assert.deepEqual(after.tickets,['cancelled']);
  assert.deepEqual(after.events.map(e=>e.type),['payment_refunded','payment_reversal_repeated']);
  assert.equal(h.log('void:'+o.paymentId).outcome,'already_reversed');
});

test('unmatched payment is recorded, not skipped, and touches no site order', () => {
  const before=h.sql(`SELECT json_agg(json_build_object('o',o.status) ORDER BY o.id) FROM core.site_orders o`);
  const pos=h.key(),posPayment=h.key(),posRefund=h.key();
  h.ingest(pos,{payments:[{id:posPayment,amount:1500,result:'VOIDED'}]});
  h.ingest(h.key(),{payments:[{id:h.key(),amount:900,result:'SUCCESS'}],refunds:[{id:posRefund,amount:900,payment:{id:h.key()}}]});
  assert.equal(h.log('void:'+posPayment).outcome,'unmatched');assert.equal(h.log('void:'+posPayment).reason,'no_site_order_payment');
  assert.equal(h.log('refund:'+posRefund).reason,'no_site_order_payment');
  // Matching Clover payment ID but a different amount is never applied.
  const o=h.paidOrder({subtotal:5000});
  h.ingest(o.cloverOrderId,{payments:[{id:o.paymentId,amount:4000,result:'VOIDED'}]});
  assert.equal(h.log('void:'+o.paymentId).reason,'amount_mismatch');
  assert.deepEqual(h.state(o.orderId),{order:'paid',payment:'verified',tickets:['new'],events:null});
  const overRefund=h.key();
  h.ingest(o.cloverOrderId,{payments:[{id:o.paymentId,amount:5000,result:'SUCCESS'}],refunds:[{id:overRefund,amount:6000,payment:{id:o.paymentId}}]});
  assert.equal(h.log('refund:'+overRefund).reason,'amount_mismatch');
  assert.equal(h.state(o.orderId).order,'paid');
  const review=h.sql(`SELECT public.site_order_clover_reversal_review_v1('${h.businessId}')`,{service:true});
  for(const k of ['void:'+posPayment,'refund:'+posRefund,'void:'+o.paymentId,'refund:'+overRefund])
    assert.ok(review.some(r=>r.sourceKey===k&&r.outcome==='unmatched'),k);
  assert.equal(h.sql(`SELECT json_agg(json_build_object('o',o.status) ORDER BY o.id) FROM core.site_orders o WHERE o.id<>'${o.orderId}'`)?.length,before?.length??null);
  // Re-ingesting an unmatched record is re-evaluated and counted.
  h.ingest(pos,{payments:[{id:posPayment,amount:1500,result:'VOIDED'}]});
  assert.equal(h.log('void:'+posPayment).attempts,2);
});

test('completed ticket stays completed; reversal is recorded with its own event', () => {
  const o=h.paidOrder();
  h.sql(`UPDATE core.site_order_tickets SET status='completed' WHERE site_order_id='${o.orderId}'`);
  h.ingest(o.cloverOrderId,{payments:[{id:o.paymentId,amount:o.amount,result:'VOIDED'}]});
  const s=h.state(o.orderId);
  assert.equal(s.order,'refunded');assert.equal(s.payment,'refunded');assert.deepEqual(s.tickets,['completed']);
  assert.deepEqual(s.events.map(e=>e.type),['payment_voided','ticket_completed_before_reversal']);
  assert.equal(s.events[0].details.tickets_completed_unchanged,1);assert.equal(s.events[0].details.tickets_cancelled,0);
});

test('a reversal error is recorded as failed and never fails the ledger ingest', () => {
  const o=h.paidOrder();
  h.sql(`ALTER TABLE core.site_order_events ADD CONSTRAINT reversal_fault_injection CHECK (event_type<>'payment_voided') NOT VALID`);
  try{
    const result=h.ingest(o.cloverOrderId,{payments:[{id:o.paymentId,amount:o.amount,result:'VOIDED'}]});
    assert.equal(typeof result.orderId,'string');
    const row=h.log('void:'+o.paymentId);assert.equal(row.outcome,'failed');assert.equal(row.details.sqlstate,'23514');
    assert.deepEqual(h.state(o.orderId),{order:'paid',payment:'verified',tickets:['new'],events:null});
  }finally{h.sql('ALTER TABLE core.site_order_events DROP CONSTRAINT reversal_fault_injection');}
  h.ingest(o.cloverOrderId,{payments:[{id:o.paymentId,amount:o.amount,result:'VOIDED'}]});
  assert.equal(h.log('void:'+o.paymentId).outcome,'reversed');assert.equal(h.state(o.orderId).order,'refunded');
});

test('core stays private: only the server review function is callable', () => {
  for(const role of ['anon','authenticated','service_role']){
    assert.notEqual(h.raw('SELECT * FROM core.site_order_clover_reversals',{role}).status,0,role);
    assert.notEqual(h.raw(`SELECT core.site_order_clover_reversal_apply_v1('${h.businessId}','M','clover_refund','X','X',1,1,'{}')`,{role}).status,0,role);
  }
  for(const role of ['anon','authenticated'])
    assert.notEqual(h.raw(`SELECT public.site_order_clover_reversal_review_v1('${h.businessId}')`,{role}).status,0,role);
  assert.equal(h.sql(`SELECT relrowsecurity FROM pg_class WHERE oid='core.site_order_clover_reversals'::regclass`),true);
});

test('migration is guarded, leaves existing functions unchanged and rolls back', async () => {
  const migration=(await lf(MIGRATION)).toString('utf8'),rollback=(await lf(ROLLBACK)).toString('utf8');
  assert.equal((await lf(MIGRATION)).includes(13),false);
  const repeat=h.raw(migration);assert.notEqual(repeat.status,0);assert.match(repeat.stderr,/SITE_ORDER_REVERSAL_ALREADY_INSTALLED/);
  const defs=()=>h.sql(`SELECT json_agg(md5(pg_get_functiondef(p.oid))||coalesce(p.proacl::text,'') ORDER BY p.oid) FROM pg_proc p
    WHERE p.oid IN ('public.clover_order_ingest_v1(uuid,text,jsonb)'::regprocedure,
      'public.site_order_payment_confirm_v1(uuid,text,text,text,bigint,timestamptz,jsonb)'::regprocedure,
      'public.site_order_ops_queue_v1(uuid)'::regprocedure)`);
  const installed=defs();
  let r=h.raw(rollback);assert.equal(r.status,0,r.stderr);
  assert.match(r.stderr,/korundu/);
  assert.equal(h.sql(`SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'site_order_clover_%_reversal'`),0);
  assert.deepEqual(defs(),installed);
  // Without triggers a void no longer reaches the site order; ingest still works.
  const o=h.paidOrder();
  h.ingest(o.cloverOrderId,{payments:[{id:o.paymentId,amount:o.amount,result:'VOIDED'}]});
  assert.equal(h.state(o.orderId).order,'paid');
  // A table kept for audit blocks a blind reinstall until it is reviewed.
  assert.match(h.raw(migration).stderr,/SITE_ORDER_REVERSAL_ALREADY_INSTALLED/);
  h.sql('DROP TABLE core.site_order_clover_reversals');
  r=h.raw(migration);assert.equal(r.status,0,r.stderr);assert.deepEqual(defs(),installed);
  console.log(JSON.stringify({migration:MIGRATION,sha256:sha256(await lf(MIGRATION)),rollbackSha256:sha256(await lf(ROLLBACK))}));
});

test('migration refuses to install without the K7 and site order prerequisites', async () => {
  const bare=await (await import('./fixtures/siteOrderReversalNative.mjs')).fixture({install:false});
  try{
    bare.sql('DROP FUNCTION public.site_order_payment_confirm_v1(uuid,text,text,text,bigint,timestamptz,jsonb)');
    const r=bare.raw((await lf(MIGRATION)).toString('utf8'));
    assert.notEqual(r.status,0);assert.match(r.stderr,/SITE_ORDER_REVERSAL_PREREQUISITE_REQUIRED/);
    assert.equal(bare.sql(`SELECT to_regclass('core.site_order_clover_reversals') IS NULL`),true);
  }finally{await bare.stop();}
});
