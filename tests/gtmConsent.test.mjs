// G20: GTM loader, dataLayer events, purchase rules, opt-out consent and the GTM import file.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { trackBeginCheckout, trackCateringRequestSubmitted, trackCloverOrderHandoffs, trackPurchase, trackVipConfirmationStarted,
  trackVipSignupSubmitted } from '../src/lib/analytics.ts';
import { AD_OPT_OUT_KEY, adConsent, setAdOptOut } from '../src/lib/consent.ts';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('index.html');
const ORDER = '6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab';
afterEach(() => { for (const key of ['window', 'document', 'Element', 'HTMLAnchorElement']) delete globalThis[key];
  Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true }); });

function browser({ host = 'www.nazarrestaurantandbakery.com', storage = new Map(), blocked = false, gpc } = {}) {
  const store = blocked ? { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); } }
    : { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
  const dataLayer = [], gtagCalls = [];
  globalThis.window = { location: { hostname: host, pathname: '/catering', search: '' }, sessionStorage: store, localStorage: store, dataLayer,
    gtag: (...args) => gtagCalls.push(args) };
  Object.defineProperty(globalThis, 'navigator', { value: gpc === undefined ? {} : { globalPrivacyControl: gpc }, configurable: true, writable: true });
  globalThis.document = { referrer: '' };
  return { dataLayer, gtagCalls, storage, events: () => dataLayer.filter((x) => x && typeof x === 'object' && 'event' in x) };
}

test('index.html loads GTM-TJ67R6VZ after the consent default and no longer loads gtag.js', () => {
  const consentAt = html.indexOf("consent('consent', 'default'"), gtmAt = html.indexOf("'GTM-TJ67R6VZ');</script>");
  assert.ok(consentAt > 0 && gtmAt > consentAt);
  assert.match(html, /https:\/\/www\.googletagmanager\.com\/gtm\.js\?id=/);
  assert.doesNotMatch(html, /gtag\/js\?id=|gtag\('config'|gtag\('js'|function gtag/);
  assert.match(html, new RegExp(AD_OPT_OUT_KEY));
});

// Runs the inline consent default exactly as written in index.html.
function consentDefault({ gpc, stored, blocked = false } = {}) {
  const script = html.match(/<script>\s*(\/\/ Consent Mode v2 default[\s\S]*?)<\/script>/)[1];
  const window = { localStorage: { getItem: (k) => { if (blocked) throw Error('blocked'); return k === AD_OPT_OUT_KEY && stored ? '1' : null; } } };
  const navigator = gpc === undefined ? {} : { globalPrivacyControl: gpc };
  window.window = window;
  vm.runInNewContext(script, { window, navigator });
  assert.equal(window.dataLayer.length, 1);
  const [command, kind, state] = Array.from(window.dataLayer[0]);
  assert.deepEqual([command, kind], ['consent', 'default']);
  assert.equal(Object.prototype.toString.call(window.dataLayer[0]), '[object Arguments]');
  return { ...state };
}
test('consent default: all granted; GPC or a stored opt-out denies only the ad signals', () => {
  const granted = { analytics_storage: 'granted', ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' };
  const denied = { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' };
  assert.deepEqual(consentDefault(), granted);
  assert.deepEqual(consentDefault({ gpc: false }), granted);
  assert.deepEqual(consentDefault({ gpc: true }), denied);
  assert.deepEqual(consentDefault({ stored: true }), denied);
  assert.deepEqual(consentDefault({ gpc: true, blocked: true }), denied);
  assert.deepEqual(consentDefault({ blocked: true }), granted);
});

test('footer choice is stored on this device, updates consent, and can be undone; GPC always stays denied', () => {
  const b = browser();
  assert.equal(adConsent(), 'granted');
  assert.equal(setAdOptOut(true), 'denied');
  assert.equal(b.storage.get(AD_OPT_OUT_KEY), '1');
  const update = b.dataLayer.at(-1);
  assert.equal(Object.prototype.toString.call(update), '[object Arguments]');
  assert.deepEqual(Array.from(update), ['consent', 'update', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' }]);
  assert.equal(adConsent(), 'denied');
  assert.equal(setAdOptOut(false), 'granted');
  assert.equal(b.storage.has(AD_OPT_OUT_KEY), false);
  assert.deepEqual(Array.from(b.dataLayer.at(-1))[2], { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' });
  // GPC: undo keeps ad signals denied.
  const g = browser({ gpc: true });
  assert.equal(adConsent(), 'denied');
  assert.equal(setAdOptOut(false), 'denied');
  assert.deepEqual(Array.from(g.dataLayer.at(-1))[2].ad_storage, 'denied');
  // Blocked storage never throws; the update still applies to this page view.
  const s = browser({ blocked: true });
  assert.doesNotThrow(() => setAdOptOut(true));
  assert.equal(Array.from(s.dataLayer.at(-1))[2].ad_storage, 'denied');
});

test('form events go to the dataLayer once each, with the same names and parameters, never through gtag', () => {
  const b = browser();
  trackCateringRequestSubmitted('request-1'); trackCateringRequestSubmitted('request-1');
  trackVipSignupSubmitted('request-2'); trackVipSignupSubmitted('request-2'); trackVipConfirmationStarted('request-2');
  assert.deepEqual(b.events(), [{ event: 'catering_request_submitted', form_name: 'catering' },
    { event: 'vip_signup_submitted', form_name: 'vip' }, { event: 'vip_confirmation_started', form_name: 'vip' }]);
  assert.equal(b.gtagCalls.length, 0);
  assert.doesNotMatch(JSON.stringify(b.dataLayer), /request-/);
  // sessionStorage keeps the dedupe across a reload of the same tab.
  const again = browser({ storage: b.storage });
  trackCateringRequestSubmitted('request-1');
  assert.equal(again.events().length, 0);
});

test('link clicks go to the dataLayer once per activation, never through gtag', () => {
  class E { constructor(anchor) { this.anchor = anchor; } closest() { return this.anchor || this; } }
  class A extends E { constructor(href) { super(); this.href = href; } getAttribute() { return null; } }
  globalThis.Element = E; globalThis.HTMLAnchorElement = A;
  const b = browser(), listeners = [];
  globalThis.document = { addEventListener: (_, fn) => listeners.push(fn) };
  window.location.pathname = '/menu';
  trackCloverOrderHandoffs();
  for (const fn of listeners) fn({ target: new A('https://nazar-bakery-west-haven.cloveronline.com/') });
  assert.deepEqual(b.events(), [{ event: 'clover_order_click', page_path: '/menu' }]);
  assert.equal(b.gtagCalls.length, 0);
});

test('begin_checkout: once per order, no form data', () => {
  const b = browser();
  trackBeginCheckout(ORDER); trackBeginCheckout(ORDER); trackBeginCheckout('not-an-order');
  assert.deepEqual(b.events(), [{ event: 'begin_checkout' }]);
});

test('purchase only for a server-confirmed paid order, once, with value, currency and transaction_id', () => {
  const b = browser();
  for (const status of ['pending', 'failed', 'cancelled', 'unknown', undefined]) trackPurchase({ status, orderId: ORDER, totalCents: 12345 });
  trackPurchase({ status: 'paid', orderId: 'not-a-uuid', totalCents: 12345 });
  for (const totalCents of [0, -5, 12.5, '12345', undefined]) trackPurchase({ status: 'paid', orderId: ORDER, totalCents });
  assert.equal(b.events().length, 0);
  trackPurchase({ status: 'paid', orderId: ORDER, totalCents: 12345, emailStatus: 'sent', requestedAt: '2026-11-01T15:00:00Z' });
  trackPurchase({ status: 'paid', orderId: ORDER, totalCents: 12345 });
  trackPurchase({ status: 'needs_reschedule', orderId: ORDER, totalCents: 12345 });
  assert.deepEqual(b.events(), [{ event: 'purchase', transaction_id: ORDER, value: 123.45, currency: 'USD' }]);
  // A reload of the return page (same tab) does not count it again.
  const reload = browser({ storage: b.storage });
  trackPurchase({ status: 'paid', orderId: ORDER, totalCents: 12345 });
  assert.equal(reload.events().length, 0);
  // Without sessionStorage, memory still prevents a second event in the same page.
  const noStore = browser({ blocked: true });
  const other = '7f1c2d3e-4a5b-4c6d-8e7f-0123456789ab';
  trackPurchase({ status: 'needs_reschedule', orderId: other, totalCents: 500 }); trackPurchase({ status: 'paid', orderId: other, totalCents: 500 });
  assert.deepEqual(noStore.events(), [{ event: 'purchase', transaction_id: other, value: 5, currency: 'USD' }]);
});

test('preview / test hosts send no purchase or other event', () => {
  for (const host of ['nazar-restaurant-website-abc.pages.dev', 'localhost']) {
    const b = browser({ host });
    trackPurchase({ status: 'paid', orderId: ORDER, totalCents: 12345 }); trackBeginCheckout(ORDER); trackCateringRequestSubmitted('r');
    assert.equal(b.events().length, 0);
  }
});

test('a failing dataLayer, missing GTM or blocked storage never breaks payment or forms', () => {
  browser();
  window.dataLayer = Object.assign([], { push() { throw Error('blocked by extension'); } });
  assert.doesNotThrow(() => { trackPurchase({ status: 'paid', orderId: ORDER, totalCents: 100 }); trackBeginCheckout(ORDER);
    trackCateringRequestSubmitted('x'); trackVipSignupSubmitted('y'); setAdOptOut(true); });
  browser();
  delete window.dataLayer;
  assert.doesNotThrow(() => trackPurchase({ status: 'paid', orderId: ORDER, totalCents: 100 }));
  // Nothing was marked as sent while GTM was unavailable: the event goes once the dataLayer exists.
  window.dataLayer = [];
  trackPurchase({ status: 'paid', orderId: ORDER, totalCents: 100 });
  assert.equal(window.dataLayer.length, 1);
});

test('payment return measures only after the paid answer; PAY measures right before Clover opens; server calls unchanged', () => {
  const ret = read('src/components/CateringPaymentReturn.tsx');
  assert.match(ret, /setState\(result\);\s*\/\/[^\n]*\n\s*trackPurchase\(result\);\s*\} catch/);
  assert.match(ret, /fetch\("\/api\/catering\/order-status"/);
  const form = read('src/components/CateringCheckoutForm.tsx');
  assert.match(form, /sessionStorage\.setItem\("nazar-site-order-reference-v1"[\s\S]*?\}\)\);\s*trackBeginCheckout\(result\.orderId\);\s*window\.location\.assign\(result\.checkoutUrl!\);/);
  assert.match(read('src/components/Footer.tsx'), /<AdChoices \/>/);
  assert.match(read('src/components/AdChoices.tsx'), /Do not sell or share my personal information/);
  assert.match(read('src/pages/PrivacyPage.tsx'), /Global Privacy Control[\s\S]*Do not sell or share my personal information|Do not sell or share my personal information[\s\S]*Global Privacy Control/);
});

test('GTM import file: Google tag, one GA4 event tag per event, Conversion Linker, Ads purchase tag gated by ad_storage', () => {
  const file = JSON.parse(read('gtm/GTM-TJ67R6VZ.container.json'));
  assert.equal(file.exportFormatVersion, 2);
  const v = file.containerVersion;
  assert.equal(v.container.publicId, 'GTM-TJ67R6VZ');
  const p = (tag, key) => tag.parameter.find((x) => x.key === key)?.value;
  const byType = (type) => v.tag.filter((t) => t.type === type);
  const ids = (list, key) => new Set(list.map((x) => x[key]));
  assert.equal(ids(v.tag, 'tagId').size, v.tag.length); assert.equal(ids(v.trigger, 'triggerId').size, v.trigger.length);
  assert.equal(ids(v.variable, 'variableId').size, v.variable.length);
  const google = byType('googtag'); assert.equal(google.length, 1); assert.equal(p(google[0], 'tagId'), 'G-LK46HFY46G');
  assert.deepEqual(google[0].firingTriggerId, ['2147479553']);
  assert.equal(byType('gclidw').length, 1);
  const triggerName = Object.fromEntries(v.trigger.map((t) => [t.triggerId, t]));
  const expected = { catering_request_submitted: ['form_name'], vip_signup_submitted: ['form_name', 'qr_source', 'qr_medium', 'qr_campaign'],
    vip_confirmation_started: ['form_name', 'qr_source', 'qr_medium', 'qr_campaign'], clover_order_click: ['page_path'], phone_click: ['page_path'],
    directions_click: ['page_path'], begin_checkout: [], purchase: ['transaction_id', 'value', 'currency'] };
  const ga4 = byType('gaawe');
  assert.deepEqual(ga4.map((t) => p(t, 'eventName')).sort(), Object.keys(expected).sort());
  const variables = new Set(v.variable.map((x) => x.name));
  for (const tag of ga4) {
    const name = p(tag, 'eventName');
    assert.equal(p(tag, 'measurementIdOverride'), 'G-LK46HFY46G');
    const table = tag.parameter.find((x) => x.key === 'eventSettingsTable')?.list ?? [];
    const params = table.map((row) => Object.fromEntries(row.map.map((m) => [m.key, m.value])));
    assert.deepEqual(params.map((x) => x.parameter), expected[name], name);
    for (const x of params) { assert.equal(x.parameterValue, `{{DLV - ${x.parameter}}}`); assert.ok(variables.has(`DLV - ${x.parameter}`)); }
    assert.equal(tag.firingTriggerId.length, 1);
    const trigger = triggerName[tag.firingTriggerId[0]];
    assert.equal(trigger.type, 'CUSTOM_EVENT');
    assert.deepEqual(trigger.customEventFilter[0].parameter.map((x) => x.value), ['{{_event}}', name]);
  }
  for (const variable of v.variable) assert.equal(variable.type, 'v');
  const ads = byType('awct'); assert.equal(ads.length, 1);
  const a = ads[0];
  assert.deepEqual([p(a, 'conversionId'), p(a, 'conversionLabel')], ['18403364763', 'H7eeCN_l468dEJuftMdE']);
  assert.deepEqual([p(a, 'conversionValue'), p(a, 'currencyCode'), p(a, 'orderId')], ['{{DLV - value}}', '{{DLV - currency}}', '{{DLV - transaction_id}}']);
  assert.deepEqual(a.firingTriggerId.map((id) => triggerName[id].customEventFilter[0].parameter[1].value), ['purchase']);
  assert.deepEqual(a.consentSettings, { consentStatus: 'NEEDED', consentType: { type: 'LIST', list: [{ type: 'TEMPLATE', value: 'ad_storage' }] } });
  assert.equal(p(a, 'enableEnhancedConversion'), 'false');
  // No Ads tag for catering_request_submitted (imported from GA4) and no user data anywhere.
  assert.equal(v.tag.filter((t) => t.type === 'awct' || t.type === 'sp').length, 1);
  assert.doesNotMatch(JSON.stringify(file), /email|phone_number|user_data|userProvidedData|enhanced_conversion|"cvt_/i);
});
