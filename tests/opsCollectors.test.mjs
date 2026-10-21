// Every provider response and credential in this file is synthetic. No native
// fetch is used by any test; unknown mocked URLs fail instead of forwarding.
import assert from 'node:assert/strict';
import test from 'node:test';
import { collect as klaviyo } from '../supabase/functions/ops-collect/klaviyo.ts';
import { placeIdForBusiness } from '../supabase/functions/ops-collect/tenant-settings.ts';
import { NAZAR_BUSINESS } from '../supabase/functions/ops-collect/contracts.ts';
import { collect as places } from '../supabase/functions/ops-collect/places.ts';
import { collect as site } from '../supabase/functions/ops-collect/site_ping.ts';
import { collect as ga4 } from '../supabase/functions/ops-collect/ga4.ts';
import { collect as ads } from '../supabase/functions/ops-collect/google_ads.ts';
import { collect as meta } from '../supabase/functions/ops-collect/meta.ts';
import { collect as clover } from '../supabase/functions/ops-collect/clover_api.ts';
import { allowedUrl, metric, sanitizeText } from '../supabase/functions/ops-collect/collectors.ts';

const now = new Date('2026-10-19T14:00:00Z');
const make = (env = {}, router = () => { throw new Error('Unexpected provider request'); }, remaining = 30) => {
  const calls = [];
  return { env, businessId: NAZAR_BUSINESS, now, budget: { remaining }, calls, fetch: async (input, init) => {
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    const url = new URL(input); calls.push({ url: url.href, init });
    return router(url, init);
  } };
};
const val = (result, name) => result.metrics.find(row => row.metric === name)?.value_num;
const text = (result, name) => result.metrics.find(row => row.metric === name)?.value_text;
const json = value => Response.json(value);
const previous = (source, key, value, date = '2026-10-12T14:00:00Z') => ({ ...metric({ env: {}, now: new Date(date) }, source, key, value), is_test: false });

test('missing credentials never fetch, emit fake zeros or claim a connection', async () => {
  for (const collect of [klaviyo, places, ga4, ads, meta, clover]) {
    const ctx = make(); const result = await collect(ctx);
    assert.equal(result.status, 'not_connected'); assert.deepEqual(result.metrics, []); assert.equal(ctx.calls.length, 0); assert.equal(ctx.budget.remaining, 30);
  }
});
test('provider allowlist rejects SSRF targets, credentials, ports and wrong path', () => {
  for (const url of ['http://places.googleapis.com/a', 'https://localhost/a', 'https://places.googleapis.com.evil.example/a', 'https://x@places.googleapis.com/a', 'https://places.googleapis.com:8443/a']) assert.throws(() => allowedUrl(url, 'places.googleapis.com'));
  assert.throws(() => allowedUrl('https://places.googleapis.com/wrong', 'places.googleapis.com', '/v1/places/'));
  assert.equal(sanitizeText('<b>Fixture</b>\nname person@example.com https://example.invalid/secret'), 'Fixture name [redacted] [link]');
});
test('shared request budget is consumed before each network call and stops at zero', async () => {
  const ctx = make({ GOOGLE_PLACES_API_KEY: 'synthetic-key' }, () => new Response('ok'), 1);
  assert.equal((await site(ctx)).status, 'connected');
  const result = await places(ctx); assert.equal(result.status, 'error'); assert.equal(result.error, 'request_budget_exhausted');
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.budget.remaining, 0);
});
test('redirect responses are not followed and raw network errors are not leaked', async () => {
  const redirect = make({}, () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }));
  const result = await site(redirect); assert.equal(result.error, 'provider_redirect_rejected'); assert.equal(redirect.calls.length, 1);
  const failed = await site(make({}, () => { throw new Error('secret-key private@example.com'); }));
  assert.equal(failed.error, 'provider_network_error'); assert.doesNotMatch(JSON.stringify(failed), /secret-key|private@/);
});
test('site ping uses fixed canonical GET, records HTTP status and distinguishes HTTP failure', async () => {
  const ctx = make({}, url => { assert.equal(url.href, 'https://www.nazarrestaurantandbakery.com/'); return new Response('ok'); });
  const ok = await site(ctx); assert.equal(val(ok, 'is_up'), 1); assert.equal(val(ok, 'http_status'), 200); assert.ok(val(ok, 'response_ms') >= 0);
  const down = await site(make({}, () => new Response('not available', { status: 503 })));
  assert.equal(down.status, 'error'); assert.equal(val(down, 'is_up'), 0); assert.equal(val(down, 'http_status'), 503);
});
test('Places requests only rating/count and labels negative delta as NET snapshot difference', async () => {
  const ctx = make({ GOOGLE_PLACES_API_KEY: 'synthetic-key' }, (url, init) => {
    assert.equal(url.hostname, 'places.googleapis.com'); assert.equal(init.headers['X-Goog-FieldMask'], 'rating,userRatingCount');
    assert.equal(url.pathname, '/v1/places/' + placeIdForBusiness(NAZAR_BUSINESS));
    return json({ rating: 4.5, userRatingCount: 20 });
  });
  ctx.previous = [previous('reviews', 'total_reviews', 22)]; const result = await places(ctx);
  assert.equal(val(result, 'rating'), 4.5); assert.equal(val(result, 'new_reviews_7d'), -2); assert.match(text(result, 'new_reviews_7d'), /NET/);
});
test('Places missing/stale baseline stays unknown; no actual new-review claim', async () => {
  const ctx = make({ GOOGLE_PLACES_API_KEY: 'synthetic' }, () => json({ userRatingCount: 0 }));
  ctx.previous = [previous('reviews', 'total_reviews', 4, '2026-10-01T14:00:00Z')]; const result = await places(ctx);
  assert.equal(val(result, 'new_reviews_7d'), null); assert.equal(val(result, 'rating'), null); assert.equal(val(result, 'total_reviews'), 0);
});
test('Places rejects malformed or missing count', async () => {
  for (const data of [{ rating: 4 }, { userRatingCount: -1 }]) {
    const result = await places(make({ GOOGLE_PLACES_API_KEY: 'synthetic' }, () => json(data))); assert.equal(result.status, 'error'); assert.deepEqual(result.metrics, []);
  }
});

test('Places selects only the trusted business setting and fails closed for absent/malformed settings', async () => {
  const other = '11111111-1111-4111-8111-111111111111';
  assert.equal(placeIdForBusiness(NAZAR_BUSINESS), 'ChIJKTmeJADZ54kRvLZoaDaB9J4');
  for (const id of [undefined, other, '__proto__']) {
    const ctx = make({ GOOGLE_PLACES_API_KEY: 'synthetic' }); ctx.businessId = id;
    assert.equal((await places(ctx)).status, 'not_connected'); assert.equal(ctx.calls.length, 0);
  }
  for (const config of [null, {}, { businesses: {} }, { businesses: { [NAZAR_BUSINESS]: {} } },
    { businesses: { [NAZAR_BUSINESS]: { google_places: { place_id: '../escape?key=private' } } } }]) {
    assert.equal(placeIdForBusiness(NAZAR_BUSINESS, config), null);
  }
  const config = { businesses: { [NAZAR_BUSINESS]: { google_places: { place_id: 'SyntheticPlaceForTenantA123' } }, [other]: { google_places: { place_id: 'SyntheticPlaceForTenantB123' } } } };
  assert.equal(placeIdForBusiness(NAZAR_BUSINESS, config), 'SyntheticPlaceForTenantA123');
  assert.equal(placeIdForBusiness(other, config), 'SyntheticPlaceForTenantB123');
});

const ga4Report = visits => ({ metricHeaders: [{ name: 'sessions', type: 'TYPE_INTEGER' }], rows: [{ metricValues: [{ value: String(visits) }] }], rowCount: 1, metadata: { timeZone: 'America/New_York' } });
test('GA4 fixed property sessions report uses seven completed NY days', async () => {
  const ctx = make({ GA4_ACCESS_TOKEN: 'synthetic-access' }, (url, init) => {
    assert.equal(url.href, 'https://analyticsdata.googleapis.com/v1beta/properties/551076037:runReport');
    const body = JSON.parse(init.body); assert.deepEqual(body.dateRanges, [{ startDate: '2026-10-12', endDate: '2026-10-18' }]); assert.deepEqual(body.metrics, [{ name: 'sessions' }]); return json(ga4Report(12));
  });
  const result = await ga4(ctx); assert.equal(val(result, 'visits_7d'), 12); assert.equal(result.requestsUsed, 1);
});
test('GA4 wrong property or wrong timezone cannot produce Nazar values', async () => {
  const wrong = make({ GA4_PROPERTY_ID: '123', GA4_ACCESS_TOKEN: 'synthetic' }); assert.equal((await ga4(wrong)).status, 'not_connected'); assert.equal(wrong.calls.length, 0);
  const result = await ga4(make({ GA4_ACCESS_TOKEN: 'synthetic' }, () => json({ ...ga4Report(1), metadata: { timeZone: 'UTC' } })));
  assert.equal(result.status, 'error'); assert.deepEqual(result.metrics, []);
});
test('GA4 explicit empty report is zero, malformed absence is unknown', async () => {
  const known = await ga4(make({ GA4_ACCESS_TOKEN: 'synthetic' }, () => json({ metricHeaders: [{ name: 'sessions' }], rowCount: 0, metadata: { timeZone: 'America/New_York' } })));
  assert.equal(val(known, 'visits_7d'), 0);
  const unknown = await ga4(make({ GA4_ACCESS_TOKEN: 'synthetic' }, () => json({ metadata: { timeZone: 'America/New_York' } })));
  assert.equal(unknown.status, 'error'); assert.deepEqual(unknown.metrics, []);
});
test('GA4 service account token URL is fixed and both OAuth/report calls consume budget', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey)); const pem = '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(der).toString('base64') + '\n-----END PRIVATE KEY-----';
  const credentials = { client_email: 'fixture@synthetic.iam.gserviceaccount.com', private_key: pem, token_uri: 'https://evil.example/token' };
  const ctx = make({ GA4_SERVICE_ACCOUNT_JSON: JSON.stringify(credentials) }, (url, init) => {
    if (url.hostname === 'oauth2.googleapis.com') {
      assert.equal(url.href, 'https://oauth2.googleapis.com/token'); const assertion = new URLSearchParams(init.body).get('assertion');
      const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString()); assert.equal(claims.aud, 'https://oauth2.googleapis.com/token'); assert.match(claims.scope, /analytics.readonly$/); return json({ access_token: 'synthetic-exchanged' });
    }
    return json(ga4Report(3));
  });
  const result = await ga4(ctx); assert.equal(result.status, 'connected'); assert.equal(result.requestsUsed, 2); assert.equal(ctx.budget.remaining, 28);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE KEY|synthetic-exchanged|gserviceaccount/);
});

const adsEnv = { GOOGLE_ADS_CLIENT_ID: 'synthetic-client', GOOGLE_ADS_CLIENT_SECRET: 'synthetic-secret', GOOGLE_ADS_REFRESH_TOKEN: 'synthetic-refresh', GOOGLE_ADS_CUSTOMER_ID: '647-847-7284' };
const adsRouter = (url, init) => {
  if (url.hostname === 'oauth2.googleapis.com') {
    assert.equal(url.href, 'https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('client_id'), adsEnv.GOOGLE_ADS_CLIENT_ID);
    assert.equal(body.get('client_secret'), adsEnv.GOOGLE_ADS_CLIENT_SECRET);
    assert.equal(body.get('refresh_token'), adsEnv.GOOGLE_ADS_REFRESH_TOKEN);
    return json({ access_token: 'synthetic-access' });
  }
  assert.equal(init.headers.Authorization, 'Bearer synthetic-access');
  assert.equal('developer-token' in init.headers, false);
  assert.equal(url.href, 'https://googleads.googleapis.com/v26/customers/6478477284/googleAds:searchStream'); const query = JSON.parse(init.body).query;
  if (query.includes('customer.time_zone')) return json([{ results: [{ customer: { id: '6478477284', timeZone: 'America/New_York', currencyCode: 'USD' } }] }]);
  if (query.includes('metrics.cost_micros')) return json([{ results: [{ metrics: { costMicros: '1200000', impressions: '90', clicks: '4', conversions: 2 } }] }]);
  if (query.includes('campaign.status')) return json([{ results: [{ campaign: { id: 'A', status: 'ENABLED' } }, { campaign: { id: 'B', status: 'PAUSED' } }, { campaign: { id: 'A', status: 'ENABLED' } }] }]);
  throw new Error('Unexpected synthetic GAQL');
};
test('Google Ads read-only queries fixed account, verifies scope and does not double-count campaigns', async () => {
  const ctx = make(adsEnv, adsRouter); const result = await ads(ctx);
  assert.equal(result.status, 'connected'); assert.equal(val(result, 'spend_yesterday'), 1.2); assert.equal(val(result, 'clicks_yesterday'), 4); assert.equal(val(result, 'conversions_yesterday'), 2);
  assert.equal(val(result, 'active_campaigns'), 1); assert.equal(val(result, 'paused_campaigns'), 1); assert.equal(ctx.calls.length, 4);
  assert.equal(ctx.calls.some(call => /mutate/.test(call.url)), false);
});
test('Ads credentials for another account are rejected before any fetch', async () => {
  const ctx = make({ ...adsEnv, GOOGLE_ADS_CUSTOMER_ID: '999-999-9999' }); assert.equal((await ads(ctx)).status, 'not_connected'); assert.equal(ctx.calls.length, 0);
});
test('Ads OAuth refresh call is budgeted along with all read calls', async () => {
  const ctx = make(adsEnv, (url, init) => url.hostname === 'oauth2.googleapis.com' ? json({ access_token: 'synthetic-access' }) : adsRouter(url, init));
  const result = await ads(ctx); assert.equal(result.status, 'connected'); assert.equal(result.requestsUsed, 4); assert.equal(ctx.budget.remaining, 26);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|synthetic-refresh/);
});
test('Ads missing or blank OAuth settings stay disconnected without provider calls', async () => {
  for (const key of Object.keys(adsEnv)) for (const value of [undefined, '', '   ']) {
    const ctx = make({ ...adsEnv, [key]: value });
    const result = await ads(ctx);
    assert.equal(result.status, 'not_connected'); assert.deepEqual(result.metrics, []);
    assert.equal(ctx.calls.length, 0); assert.equal(ctx.budget.remaining, 30);
  }
  const legacy = make({ GOOGLE_ADS_ACCESS_TOKEN: 'legacy-access', GOOGLE_ADS_DEVELOPER_TOKEN: 'legacy-dev', GOOGLE_ADS_CUSTOMER_ID: '6478477284' });
  assert.equal((await ads(legacy)).status, 'not_connected'); assert.equal(legacy.calls.length, 0);
});
test('Ads ignores legacy tokens and still refreshes OAuth; provider denial is sanitized', async () => {
  const ctx = make({ ...adsEnv, GOOGLE_ADS_ACCESS_TOKEN: 'legacy-access', GOOGLE_ADS_DEVELOPER_TOKEN: 'legacy-dev' }, adsRouter);
  assert.equal((await ads(ctx)).status, 'connected'); assert.equal(ctx.calls.length, 4);
  const denied = make(adsEnv, (url, init) => url.hostname === 'oauth2.googleapis.com' ? adsRouter(url, init) : new Response('private-provider-body synthetic-secret', { status: 403 }));
  const result = await ads(denied);
  assert.equal(result.error, 'provider_http_403'); assert.deepEqual(result.metrics, []);
  assert.doesNotMatch(JSON.stringify(result), /private-provider-body|synthetic-secret/);
});

test('Ads wrong timezone rejects report instead of relabelling its dates NY', async () => {
  const ctx = make(adsEnv, (url, init) => url.hostname === 'oauth2.googleapis.com' ? adsRouter(url, init) : json([{ results: [{ customer: { id: '6478477284', timeZone: 'UTC', currencyCode: 'USD' } }] }]));
  const result = await ads(ctx); assert.equal(result.status, 'error'); assert.equal(ctx.calls.length, 2); assert.deepEqual(result.metrics, []);
});

const profile = (id, attributes = {}, marketing = {}) => ({ id, attributes: { email: id + '@customer.example', first_name: 'Fixture', last_name: 'Guest', properties: {},
  subscriptions: { email: { marketing: { consent: 'SUBSCRIBED', can_receive_email_marketing: true, suppression: [], list_suppressions: [], ...marketing } } }, ...attributes } });
const page = (data, next = null) => ({ data, links: { next } });
const campaign = (id, name, date) => ({ id, attributes: { name, status: 'Sent', send_time: date } });
function klaviyoRouter(overrides = {}) {
  return (url, init) => {
    assert.equal(init.headers.revision, '2026-07-15'); assert.match(init.headers.Authorization, /^Klaviyo-API-Key synthetic/);
    if (url.pathname === '/api/accounts/') assert.equal(url.searchParams.get('fields[account]'), 'timezone,preferred_currency');
    if (url.pathname === '/api/campaigns/') assert.equal(url.searchParams.get('filter'), 'and(equals(messages.channel,"email"),equals(archived,false))');
    if (url.pathname === '/api/accounts/') return json(page([{ id: 'W6Kr7z', attributes: { timezone: 'America/New_York' } }]));
    if (url.pathname === '/api/lists/UeJynm/profiles/') return json(page([profile('fixture-one')]));
    if (url.pathname === '/api/campaigns/') return json(page([campaign('campA', 'Fixture weekly offer', '2026-10-17T14:00:00Z'), campaign('testA', 'Nazar internal test — delivery and unsubscribe', '2026-10-18T14:00:00Z')]));
    if (url.pathname === '/api/campaign-values-reports/') return json({ data: { attributes: { results: [{ groupings: { campaign_id: 'campA', campaign_message_id: 'msgA', send_channel: 'email' }, statistics: { open_rate: 0.42, click_rate: 0.031 } }] } } });
    if (overrides.next) return overrides.next(url, init);
    throw new Error('Unexpected synthetic Klaviyo URL');
  };
}
test('Klaviyo verifies account before reading profiles or campaigns', async () => {
  const ctx = make({ KLAVIYO_OPS_READ_KEY: 'synthetic-key' }, () => json(page([{ id: 'OTHER' }])));
  const result = await klaviyo(ctx); assert.equal(result.error, 'klaviyo_account_mismatch'); assert.equal(ctx.calls.length, 1); assert.deepEqual(result.metrics, []);
});
test('Klaviyo returns counts only, excludes technical campaigns, converts rate ratios exactly once', async () => {
  const ctx = make({ KLAVIYO_OPS_READ_KEY: 'synthetic-key', KLAVIYO_CONVERSION_METRIC_ID: 'metricA' }, klaviyoRouter());
  ctx.previous = [previous('klaviyo', 'subscribers', 0)]; const result = await klaviyo(ctx);
  assert.equal(result.status, 'connected'); assert.equal(val(result, 'subscribers'), 1); assert.equal(val(result, 'net_growth_7d'), 1);
  assert.equal(text(result, 'last_campaign_name'), 'Fixture weekly offer'); assert.equal(val(result, 'last_campaign_open_rate'), 42); assert.equal(val(result, 'last_campaign_click_rate'), 3.1);
  assert.doesNotMatch(JSON.stringify(result), /@customer\.example|Fixture Guest|synthetic-key|profile-one/);
  assert.deepEqual(result.capabilities, []);
});
test('Klaviyo paginated counts exclude test, pending and suppressed profiles; exact duplicate IDs dedupe', async () => {
  const base = klaviyoRouter();
  const ctx = make({ KLAVIYO_OPS_READ_KEY: 'synthetic-key' }, (url, init) => {
    if (url.pathname === '/api/lists/UeJynm/profiles/') {
      if (url.searchParams.has('page[cursor]')) return json(page([profile('good'), profile('good2'), profile('pending', {}, { consent: 'NEVER_SUBSCRIBED', can_receive_email_marketing: false })]));
      return json(page([profile('good'), profile('test', { email: 'test@example.com' }), profile('marked', { properties: { is_test: true } }), profile('suppressed', {}, { suppression: [{ reason: 'UNSUBSCRIBE' }], can_receive_email_marketing: false }), profile('list-block', {}, { list_suppressions: [{ list_id: 'UeJynm' }] })], 'https://a.klaviyo.com/api/lists/UeJynm/profiles/?page[cursor]=next'));
    }
    return base(url, init);
  });
  const result = await klaviyo(ctx); assert.equal(result.status, 'connected'); assert.equal(val(result, 'subscribers'), 2); assert.equal(val(result, 'net_growth_7d'), null); assert.equal(val(result, 'last_campaign_open_rate'), null);
});
test('Klaviyo exhausted pagination budget produces unknown, not partial subscriber totals', async () => {
  const base = klaviyoRouter(); const ctx = make({ KLAVIYO_OPS_READ_KEY: 'synthetic-key' }, (url, init) => url.pathname.includes('/profiles/') ? json(page([profile('one')], 'https://a.klaviyo.com/api/lists/UeJynm/profiles/?page[cursor]=more')) : base(url, init), 2);
  const result = await klaviyo(ctx); assert.equal(result.status, 'error'); assert.equal(result.error, 'request_budget_exhausted'); assert.deepEqual(result.metrics, []); assert.equal(ctx.calls.length, 2);
});
test('Klaviyo pagination cannot change provider host or list scope', async () => {
  for (const next of ['https://evil.example/steal', 'https://a.klaviyo.com/api/profiles/']) {
    const base = klaviyoRouter(); const ctx = make({ KLAVIYO_OPS_READ_KEY: 'synthetic-key' }, (url, init) => url.pathname.includes('/profiles/') ? json(page([profile('one')], next)) : base(url, init));
    const result = await klaviyo(ctx); assert.equal(result.status, 'error'); assert.equal(ctx.calls.length, 2); assert.deepEqual(result.metrics, []);
  }
});
test('Klaviyo missing consent data does not count an active profile as a subscriber', async () => {
  const base = klaviyoRouter(); const ctx = make({ KLAVIYO_OPS_READ_KEY: 'synthetic-key' }, (url, init) => url.pathname.includes('/profiles/') ? json(page([{ id: 'unknown', attributes: { email: 'synthetic@customer.example' } }])) : base(url, init));
  const result = await klaviyo(ctx); assert.equal(result.error, 'klaviyo_missing_consent_fields'); assert.deepEqual(result.metrics, []);
});
test('Klaviyo multiple message rates are not averaged without denominators', async () => {
  const base = klaviyoRouter(); const ctx = make({ KLAVIYO_OPS_READ_KEY: 'synthetic-key', KLAVIYO_CONVERSION_METRIC_ID: 'metricA' }, (url, init) => url.pathname.includes('campaign-values-reports') ? json({ data: { attributes: { results: [0.1, 0.9].map(rate => ({ groupings: { campaign_id: 'campA', send_channel: 'email' }, statistics: { open_rate: rate, click_rate: rate } })) } } }) : base(url, init));
  const result = await klaviyo(ctx); assert.equal(result.status, 'connected'); assert.equal(val(result, 'last_campaign_open_rate'), null);
});

const metaEnv = { META_ACCESS_TOKEN: 'synthetic-token', META_AD_ACCOUNT_ID: '123456789', META_API_VERSION: 'v25.0', META_RESULT_ACTION_TYPE: 'lead' };
function metaRouter(url) {
  assert.equal(url.hostname, 'graph.facebook.com');
  if (url.pathname.endsWith('/act_123456789')) return json({ account_id: '123456789', name: 'Nazar synthetic fixture account', currency: 'USD', timezone_name: 'America/New_York' });
  if (url.pathname.endsWith('/insights')) return json({ data: [{ spend: '1.20', reach: '55', actions: [{ action_type: 'lead', value: '2' }] }] });
  if (url.pathname.endsWith('/campaigns')) return json({ data: [{ id: 'A', effective_status: 'ACTIVE' }, { id: 'B', effective_status: 'PAUSED' }, { id: 'A', effective_status: 'ACTIVE' }] });
  throw new Error('Unexpected synthetic Meta URL');
}
test('Meta configured read adapter verifies Nazar account and reports selected outcome, no write capability', async () => {
  const ctx = make(metaEnv, metaRouter); const result = await meta(ctx);
  assert.equal(result.status, 'connected'); assert.equal(val(result, 'spend_7d'), 1.2); assert.equal(val(result, 'reach_7d'), 55); assert.equal(val(result, 'results_7d'), 2); assert.equal(val(result, 'campaigns'), 2);
  assert.deepEqual(result.capabilities, []); assert.ok(ctx.calls.every(call => !call.init.method || call.init.method === 'GET'));
});
test('Meta without an agreed result action leaves results unknown rather than summing unrelated actions', async () => {
  const { META_RESULT_ACTION_TYPE, ...env } = metaEnv; const result = await meta(make(env, metaRouter)); assert.equal(val(result, 'results_7d'), null);
});
test('Meta rejects another business account or incomplete insights', async () => {
  const wrong = make(metaEnv, () => json({ account_id: '123456789', name: 'Other business', currency: 'USD' }));
  assert.equal((await meta(wrong)).error, 'meta_account_mismatch'); assert.equal(wrong.calls.length, 1);
  const ctx = make(metaEnv, url => url.pathname.endsWith('/insights') ? json({ data: [], paging: { next: 'https://graph.facebook.com/more' } }) : metaRouter(url));
  assert.equal((await meta(ctx)).error, 'meta_incomplete_insights');
});
test('Meta account timezone must match NY before reporting seven-day date totals', async () => {
  for (const timezone_name of ['UTC', undefined]) {
    const ctx = make(metaEnv, () => json({ account_id: '123456789', name: 'Nazar synthetic fixture', currency: 'USD', timezone_name }));
    const result = await meta(ctx); assert.equal(result.error, 'meta_timezone_mismatch'); assert.deepEqual(result.metrics, []); assert.equal(ctx.calls.length, 1);
  }
});
test('snapshot deltas carry actual NY dates across a UTC date boundary, not a fabricated completed-day period', async () => {
  const snapshotNow = new Date('2026-10-19T02:00:00Z'); // Oct 18 in NY.
  const baseline = '2026-10-12T01:00:00Z'; // Oct 11 in NY, one hour before rolling 7d target.
  const reviewCtx = make({ GOOGLE_PLACES_API_KEY: 'synthetic' }, () => json({ id: 'ChIJKTmeJADZ54kRvLZoaDaB9J4', userRatingCount: 20 }));
  reviewCtx.now = snapshotNow; reviewCtx.previous = [previous('reviews', 'total_reviews', 18, baseline)];
  const emailCtx = make({ KLAVIYO_OPS_READ_KEY: 'synthetic-key' }, klaviyoRouter());
  emailCtx.now = snapshotNow; emailCtx.previous = [previous('klaviyo', 'subscribers', 0, baseline)];
  for (const [result, key] of [[await places(reviewCtx), 'new_reviews_7d'], [await klaviyo(emailCtx), 'net_growth_7d']]) {
    const delta = result.metrics.find(row => row.metric === key);
    assert.equal(result.status, 'connected'); assert.equal(delta.period_start, '2026-10-11'); assert.equal(delta.period_end, '2026-10-18');
    assert.ok(delta.value_text.includes(new Date(baseline).toISOString())); assert.match(delta.value_text, /snapshot/);
  }
});
test('Clover API remains a merchant-read scaffold; a token alone never fabricates qualified sales', async () => {
  const ctx = make({ CLOVER_OPS_READ_TOKEN: 'synthetic-token', CLOVER_OPS_API_ENABLED: 'true', CLOVER_MERCHANT_ID: 'F8Q154GMDKFD1' }, url => {
    assert.equal(url.href, 'https://api.clover.com/v3/merchants/F8Q154GMDKFD1'); return json({ id: 'F8Q154GMDKFD1', name: 'Nazar synthetic fixture' });
  });
  const result = await clover(ctx); assert.equal(result.status, 'not_connected'); assert.deepEqual(result.metrics, []); assert.equal(ctx.calls.length, 1); assert.deepEqual(result.capabilities, []);
});

// Synthetic reproduction of the observed Account sparse-field rejection.
test('Klaviyo 400 Account field regression stops before profiles and corrected request reaches counts', async () => {
  const fieldsError = { errors: [{ code: 'invalid', detail: "fields must be in ['contact_information', 'id', 'industry', 'locale', 'preferred_currency', 'public_api_key', 'test_account', 'timezone']: (got ['timezone', 'currency'])" }] };
  const router = klaviyoRouter();
  const provider = (url, init) => {
    if (url.pathname === '/api/accounts/' && url.searchParams.get('fields[account]').split(',').includes('currency'))
      return Response.json(fieldsError, { status: 400 });
    return router(url, init);
  };
  const bad = make({ KLAVIYO_OPS_READ_KEY: 'synthetic-key' }, (url, init) => {
    if (url.pathname === '/api/accounts/') url.searchParams.set('fields[account]', 'timezone,currency');
    return provider(url, init);
  });
  const rejected = await klaviyo(bad);
  assert.equal(rejected.error, 'provider_http_400'); assert.equal(bad.calls.length, 1); assert.deepEqual(rejected.metrics, []);
  const good = make({ KLAVIYO_OPS_READ_KEY: 'synthetic-key' }, provider);
  const accepted = await klaviyo(good);
  assert.equal(accepted.status, 'connected'); assert.equal(val(accepted, 'subscribers'), 1); assert.equal(good.calls.length, 3);
  assert.doesNotMatch(JSON.stringify(accepted), /synthetic-key|@customer\.example/);
});
