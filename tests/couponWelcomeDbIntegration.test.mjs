import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixtures/signupRewardCouponsNative.mjs';
import { confirmCouponVip, processCouponWelcome } from '../functions/_lib/couponWelcome.ts';

// Actual accepted K4/K5/K6 + K9/K10 SQL on owned loopback PostgreSQL only.
// Only the external provider is synthetic. No keys/hosted URL/email is read.
const h = await fixture(); const checks = [];
after(async () => {
  await writeFile(join(h.config.run, 'coupon-welcome-integration-summary.json'), JSON.stringify({
    scope: 'K10_COUPON_ADAPTER_ACTUAL_K4_K5_K6_POSTGRES18_6', checks,
    passed: checks.filter(c => c.passed).length, total: checks.length,
    provider_network_calls: 0, hosted: false, real_customer_data: false,
    synthetic_provider: true, local_unmarked_fixtures_only: true,
  }, null, 2) + '\n');
  await h.stop();
});
function check(name, body) {
  test(name, async () => { try { await body(); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, error: String(error.message) }); throw error; } });
}
const safeRpc = new Set(['coupon_confirmation_context_v1','coupon_record_confirmed_vip_v1','coupon_record_negative_v1',
  'coupon_welcome_claim_v1','coupon_welcome_context_v1','coupon_welcome_finish_v1',
  'message_send_reserve_v1','message_send_claim_v1','message_send_context_v1','message_send_finalize_v1']);
const store = { async rpc(name, args) {
  assert.ok(safeRpc.has(name));
  const values = Object.entries(args).map(([key, value]) => {
    assert.match(key, /^p_[a-z][a-z0-9_]*$/);
    return key + '=>' + (value === null ? 'NULL' : typeof value === 'object'
      ? h.literal(JSON.stringify(value)) + '::jsonb' : h.literal(value));
  });
  return h.sql(`SELECT public.${name}(${values.join(',')})`, { service: true });
} };
function input({ status = 'pending_review', providerNegative = false } = {}) {
  const campaign = h.reward({ is_test: false });
  const customer = h.customer({ status });
  // A local-only synthetic person must exercise actual K6's real-only gate;
  // these markers are never changed in any hosted database.
  const recipient = `${customer}@synthetic.test`;
  h.sql(`UPDATE core.customers SET is_test=false,email=${h.literal(recipient)},identity_key=${h.literal('email:' + recipient)} WHERE id='${customer}'`);
  const signup = h.signup(customer, { createdAt: new Date(Date.now() - 60000).toISOString() });
  const confirmedAt = new Date(Date.now() - 30000).toISOString();
  const events = []; let negative = providerNegative;
  const provider = { mode: 'mock', async get(path, query) {
    if (path === '/accounts') return { data: [{ id: 'SYNTHETIC_ACCOUNT' }] };
    if (path === '/lists/SYNTHETIC_VIP') return { data: { id: 'SYNTHETIC_VIP', attributes: { opt_in_process: 'double_opt_in' } } };
    assert.ok(['/profiles', '/lists/SYNTHETIC_VIP/profiles'].includes(path));
    assert.equal(query.filter, `equals(email,${JSON.stringify(recipient)})`);
    return { data: [{ id: 'PROFILE_' + customer.replaceAll('-', ''), attributes: { email: recipient,
      subscriptions: { email: { marketing: { consent: negative ? 'UNSUBSCRIBED' : 'SUBSCRIBED',
        can_receive_email_marketing: !negative, double_optin: true, consent_timestamp: confirmedAt,
        suppression: [], list_suppressions: [] } } } } }] };
  }, async eventAccount() { return { data: [{ id: 'SYNTHETIC_ACCOUNT' }] }; },
  async event(body) { events.push(structuredClone(body)); return { status: 202 }; } };
  return { campaign, customer, signup, recipient, provider, events,
    makeNegative: () => { negative = true; },
    confirm: () => confirmCouponVip({ store, provider, businessId: h.config.businessId,
      customerId: customer, signupId: signup, accountId: 'SYNTHETIC_ACCOUNT' }),
    welcome: couponId => processCouponWelcome({ store, provider, businessId: h.config.businessId,
      accountId: 'SYNTHETIC_ACCOUNT', qrOrigin: 'https://owned.synthetic.invalid', couponId }),
  };
}
check('actual DOI bridge atomically earns a coupon; orchestrator binds one accepted event to consumed K6 unknown', async () => {
  const x = input(); assert.equal((await x.confirm()).status, 'confirmed');
  const coupon = h.coupon(x.customer); assert.ok(coupon); assert.equal(coupon.state, 'issued');
  h.sql(`INSERT INTO core.message_send_settings(business_id,enabled) VALUES('${h.config.businessId}',true) ON CONFLICT(business_id) DO UPDATE SET enabled=true`);
  const reply = await x.welcome(coupon.id); assert.equal(reply.status, 'provider_accepted',JSON.stringify(reply)); assert.equal(reply.activationReady, false);
  assert.equal(x.events.length, 1); assert.equal(x.events[0].data.attributes.properties.coupon_code, coupon.code);
  assert.equal(x.events[0].data.attributes.properties.coupon_id, coupon.id);
  const receipt = h.sql(`SELECT json_build_object('outbox',j.status,'reservation',m.status,'businessMatches',m.business_id=j.business_id,
    'customerMatches',m.customer_id=cp.customer_id,'messageMatches',m.message_key=j.message_key,'kind',m.message_kind,
    'dispatchConsumed',m.dispatch_authorized_at IS NOT NULL,'payloadHash',m.payload_sha256,'sentAt',m.sent_at)
    FROM core.coupon_welcome_outbox j JOIN core.campaign_coupons cp ON cp.id=j.coupon_id
    JOIN core.message_log m ON m.id=j.message_reservation_id WHERE cp.id='${coupon.id}'`);
  assert.deepEqual({ ...receipt, payloadHash: undefined }, { outbox:'provider_accepted',reservation:'unknown',businessMatches:true,
    customerMatches:true,messageMatches:true,kind:'flow',dispatchConsumed:true,payloadHash:undefined,sentAt:null });
  assert.match(receipt.payloadHash, /^[0-9a-f]{64}$/);
  await x.welcome(coupon.id); assert.equal(x.events.length,1);
  assert.equal(h.sql(`SELECT count(*) FROM core.message_log WHERE customer_id='${x.customer}'`),1);
  // The existing immutable K6 terminal state conservatively holds the person.
  const next = h.sql(`SELECT public.message_send_reserve_v1('${h.config.businessId}','${x.customer}','another-campaign:synthetic','campaign',repeat('b',64))`,{service:true});
  assert.equal(next.allowed,false); assert.equal(next.code,'frequency_limited');
});
check('actual provider unsubscribe read during confirmation persists K4-protected local negative and issues no coupon', async () => {
  const x=input({providerNegative:true}); assert.equal((await x.confirm()).status,'blocked');
  assert.equal(h.coupon(x.customer),null);
  assert.equal(h.sql(`SELECT email_status='unsubscribed' AND email_suppressed_at IS NOT NULL FROM core.customers WHERE id='${x.customer}'`),true);
  assert.equal(x.events.length,0);
});
check('actual late provider negative blocks event and local delivery while preserving already earned coupon',async()=>{
  const x=input();assert.equal((await x.confirm()).status,'confirmed');const coupon=h.coupon(x.customer);x.makeNegative();
  const reply=await x.welcome(coupon.id);assert.equal(reply.status,'blocked',JSON.stringify(reply));assert.equal(x.events.length,0);
  assert.equal(h.sql(`SELECT email_status='unsubscribed' FROM core.customers WHERE id='${x.customer}'`),true);
  assert.equal(h.coupon(x.customer).state,'issued');
  assert.equal(h.sql(`SELECT status='blocked' FROM core.coupon_welcome_outbox WHERE coupon_id='${coupon.id}'`),true);
});
check('actual outbox rejects another coupon customer/message K6 receipt even when that gate was consumed',async()=>{
  const first=input();assert.equal((await first.confirm()).status,'confirmed');const firstCoupon=h.coupon(first.customer);
  assert.equal((await first.welcome(firstCoupon.id)).status,'provider_accepted');
  const reservation=h.sql(`SELECT to_jsonb(message_reservation_id) FROM core.coupon_welcome_outbox WHERE coupon_id='${firstCoupon.id}'`);
  const second=input();assert.equal((await second.confirm()).status,'confirmed');const secondCoupon=h.coupon(second.customer);
  const job=h.sql(`SELECT public.coupon_welcome_claim_v1('${h.config.businessId}','${secondCoupon.id}')`,{service:true});assert.equal(job.allowed,true);
  assert.throws(()=>h.sql(`SELECT public.coupon_welcome_finish_v1('${job.jobId}','${job.jobLeaseId}','provider_accepted','${reservation}',NULL,'accepted')`,{service:true}),/WELCOME_RESERVATION_MISMATCH/);
  assert.equal(h.sql(`SELECT status='claimed' AND message_reservation_id IS NULL FROM core.coupon_welcome_outbox WHERE id='${job.jobId}'`),true);
  assert.equal(second.events.length,0);
});
