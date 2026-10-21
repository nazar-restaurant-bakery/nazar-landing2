// Strict in-memory fake. Every address, Auth session and record below is synthetic.
// The Vite alias ensures the real Supabase SDK cannot be imported by this fixture.
import { createOpsMock } from "./opsMock.js";
export const fixtureIds = {
  customer: '11111111-1111-4111-8111-111111111111',
  secondCustomer: '22222222-2222-4222-8222-222222222222',
  testCustomer: '33333333-3333-4333-8333-333333333333',
  request: '44444444-4444-4444-8444-444444444444',
  secondRequest: '55555555-5555-4555-8555-555555555555',
  testRequest: '66666666-6666-4666-8666-666666666666',
  task: '77777777-7777-4777-8777-777777777777',
  testTask: '88888888-8888-4888-8888-888888888888',
  error: '99999999-9999-4999-8999-999999999999',
  staff: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const checkedAt = '2026-10-18T18:05:00Z';
const clone = value => structuredClone(value);
const customer = (id, name, source, emailStatus = 'pending_review') => ({
  id, name, email: id.slice(0, 8) + '@example.invalid', phone: null,
  email_status: emailStatus, created_at: '2026-10-18T18:05:00Z', signup_count: 1,
  last_signup_at: '2026-10-18T18:05:00Z', last_source: source,
  vip_signup_count: source === 'website_vip_page' ? 1 : 0, kevin_signup_count: 0,
  recent_signups: [{ id: id.replace('11111111', '10101010'), source, campaign: null, created_at: '2026-10-18T18:05:00Z' }], notes: [],
});
const request = (id, c, options = {}) => ({
  id, customer_id: c.id, name: c.name, email: c.email, phone: null,
  event_date: '2026-10-20', guests: 20,
  message: 'SYNTHETIC FIXTURE ONLY — No order, customer contact or marketing action.',
  status: 'new', assigned_to: 'Talip', follow_up_at: '2026-10-20T14:00:00Z',
  created_at: '2026-10-18T18:05:00Z', ...options,
});
const task = (id, title) => ({ id, title, assigned_to: 'Talip', due_at: '2026-10-20T14:00:00Z', completed_at: null });
const listeners = new Set();
const writes = new Set(['crm_add_note', 'crm_create_task_v1', 'crm_complete_task_v1', 'crm_update_catering', 'crm_request_catering_decision_v1', 'crm_resolve_form_error_v1']);
let state;
let sequence = 100;
const session = { access_token: 'mock-only-not-a-real-access-token', refresh_token: 'mock-only', expires_in: 3600,
  token_type: 'bearer', user: { id: fixtureIds.staff, email: 'staff@example.invalid', app_metadata: {}, user_metadata: {} } };
function fresh(mode = 'normal') {
  const a = customer(fixtureIds.customer, 'Örnek Müşteri', 'catering');
  const b = customer(fixtureIds.secondCustomer, 'Örnek İkinci', 'website_vip_page', 'subscribed');
  const t = customer(fixtureIds.testCustomer, 'INTERNAL TEST — Örnek', 'catering', 'unsubscribed');
  return { mode, signedIn: !['signed-out', 'signin-network'].includes(mode), calls: [], unexpected: [], held: [],
    holdNames: [], customers: [a, b], testCustomers: [t],
    requests: [request(fixtureIds.request, a), request(fixtureIds.secondRequest, b, { status: 'closed', assigned_to: 'Yücel', follow_up_at: null })],
    testRequests: [request(fixtureIds.testRequest, t, { guests: 55 })],
    tasks: { [a.id]: [task(fixtureIds.task, 'Örnek takip görevi')], [b.id]: [], [t.id]: [task(fixtureIds.testTask, 'INTERNAL TEST — Takip görevi')] },
    decisions: [], errors: [{ id: fixtureIds.error, occurred_at: checkedAt, form_kind: 'catering', stage: 'database', error_code: 'upstream_timeout', http_status: 503, alert_status: 'not_requested' }],
  };
}
state = fresh(new URLSearchParams(window.location.search).get('mode') || 'normal');
const emit = (event, value) => { for (const fn of listeners) fn(event, value); };
const result = (data, error = null) => ({ data: clone(data), error });
const remember = (name, params) => { state.calls.push({ name, params: clone(params ?? {}), at: new Date().toISOString() }); };
const opsMock = createOpsMock(() => state, remember);
const nextId = () => 'bbbbbbbb-bbbb-4bbb-8bbb-' + String(sequence++).padStart(12, '0');
function unknown(name, params) {
  state.unexpected.push({ name, params: clone(params ?? {}) });
  throw new Error('Unexpected mocked call: ' + name);
}
async function pause(name) {
  if (state.holdNames.includes(name) || (state.mode === 'slow' && writes.has(name)) || (state.mode === 'slow-read' && name === 'crm_overview_v2')) {
    state.holdNames = state.holdNames.filter(n => n !== name);
    await new Promise(resolve => state.held.push({ name, resolve }));
  }
}
const allRequests = () => [...state.requests, ...state.testRequests];
function overview(segment) {
  if (state.mode === 'empty') return { customers: [], requests: [] };
  if (state.mode === 'malformed') return { customers: null, requests: [] };
  const customers = clone(segment === 'test' ? state.testCustomers : state.customers);
  const requests = clone(segment === 'test' ? state.testRequests : state.requests);
  if (state.mode === 'bad-date') { customers[0].created_at = 'not-a-date'; customers[0].last_signup_at = 'not-a-date'; requests[0].follow_up_at = 'not-a-date'; }
  if (state.mode === 'null-owner') requests[0].assigned_to = null;
  if (state.mode === 'closed') { requests[0].status = 'closed'; requests[0].follow_up_at = null; }
  return { customers, requests };
}
function queue(name, offset) {
  const names = ['open_catering', 'overdue_catering', 'missing_owner', 'missing_followup', 'open_tasks', 'overdue_tasks', 'pending_decisions'];
  if (!names.includes(name) || !Number.isInteger(offset) || offset < 0) return unknown('queue parameters', { name, offset });
  const rows = [];
  for (const [customerId, tasks] of Object.entries(state.tasks)) {
    if (customerId === fixtureIds.testCustomer) continue;
    for (const t of tasks.filter(t => !t.completed_at)) rows.push({ kind: 'task', id: t.id, request_id: null, customer_id: customerId,
      customer_name: state.customers.find(c => c.id === customerId).name, title: t.title, request_status: null,
      assigned_to: t.assigned_to, due_at: t.due_at, created_at: checkedAt, flags: [] });
  }
  const openRequests = state.requests.filter(r => ['new', 'contacted', 'quoted'].includes(r.status)).map(r => ({
    kind: 'request', id: r.id, request_id: r.id, customer_id: r.customer_id, customer_name: r.name,
    title: 'Catering follow-up', request_status: r.status, assigned_to: r.assigned_to, due_at: r.follow_up_at,
    created_at: r.created_at, flags: [...(!r.assigned_to?.trim() ? ['missing_owner'] : []), ...(!r.follow_up_at ? ['missing_followup'] : []),
      ...(r.follow_up_at && Date.parse(r.follow_up_at) < Date.parse(checkedAt) ? ['overdue'] : [])],
  }));
  const decisions = state.decisions.filter(d => !d.recorded_at).flatMap(d => {
    const r = state.requests.find(r => r.id === d.request_id && ['new', 'contacted', 'quoted'].includes(r.status));
    return r ? [{ kind: 'decision', id: d.id, request_id: r.id, customer_id: r.customer_id, customer_name: r.name,
      title: d.question, request_status: r.status, assigned_to: r.assigned_to, due_at: r.follow_up_at, created_at: d.requested_at, flags: ['decision'] }] : [];
  });
  const categories = { open_tasks: rows, overdue_tasks: rows.filter(t => Date.parse(t.due_at) < Date.parse(checkedAt)),
    open_catering: openRequests, overdue_catering: openRequests.filter(r => r.flags.includes('overdue')),
    missing_owner: openRequests.filter(r => r.flags.includes('missing_owner')), missing_followup: openRequests.filter(r => r.flags.includes('missing_followup')),
    pending_decisions: decisions };
  const counts = Object.fromEntries(names.map(n => [n, categories[n].length]));
  const items = categories[name];
  return { generated_at: checkedAt, queue: name, offset, page_size: 25, total: items.length, counts, items: items.slice(offset, offset + 25) };
}
async function rpc(name, params) {
  remember(name, params);
  const signedInAtStart = state.signedIn;
  await pause(name);
  if (name === 'crm_staff_authorized_v1') {
    if (state.mode === 'auth-network') throw new Error('Synthetic authorization network failure');
    return result(!['denied', 'auth-denied'].includes(state.mode));
  }
  // A request already accepted before sign-out can still resolve successfully.
  if (!signedInAtStart) return result(null, { code: '42501' });
  if (state.mode === 'denied') return result(null, { code: '42501' });
  if (name === 'staff_business_authorized_v1') {
    if (params?.p_operation !== 'campaign.staff_mark' || params?.p_business_id !== 'a358eba4-b197-4309-805b-46f43a718454') return unknown(name + ' parameters', params);
    return result(state.mode !== 'coupon-platform-only');
  }
  const opsResult = opsMock.rpc(name);
  if (opsResult !== undefined) return opsResult;
  if (name === 'loyalty_metrics_v1') return state.loyaltyResponse
    ? clone(state.loyaltyResponse) : result(null, { code: 'PGRST202' });
  if (state.mode === 'throws' && !writes.has(name)) throw new Error('Synthetic read connection failure');
  if (name === 'campaign_eligibility_check_v1') {
    if (params?.p_business_id !== 'a358eba4-b197-4309-805b-46f43a718454'
      || params?.p_clover_order_id !== 'SYNTHETIC-ORDER') return unknown(name + ' parameters', params);
    return result({ known: false, eligible: null, reason: 'order_not_synced', campaign: null,
      remaining: null, candidates: [], checkedAt, snapshotAt: null });
  }
  if (name === 'crm_overview_v2') {
    if (params?.p_search !== '' || !['all', 'test'].includes(params?.p_segment)) return unknown(name + ' parameters', params);
    return result(overview(params.p_segment));
  }
  if (name === 'crm_customer_tasks_v1') {
    if (!Object.hasOwn(state.tasks, params?.p_customer_id)) return unknown(name + ' customer', params);
    if (state.mode === 'task-error') throw new Error('Synthetic task read failure');
    if (state.mode === 'tasks-malformed') return result([null]);
    return result(state.tasks[params.p_customer_id]);
  }
  if (name === 'crm_follow_up_queue_v1') {
    if (state.mode === 'queue-unavailable') return result(null, { code: 'NETWORK_ERROR' });
    if (state.mode === 'queue-malformed') return result({ total: 0 });
    return result(queue(params?.p_queue, params?.p_offset));
  }
  if (name === 'crm_catering_decisions_v1') return result(state.mode === 'decisions-malformed' ? { items: [null] } : { items: state.decisions });
  if (name === 'crm_catering_notification_status_v1') return result({ items: allRequests().map(r => ({ request_id: r.id, tracked: false, attempted_at: null, sent_at: null, error: null })) });
  if (name === 'crm_form_errors_v1') {
    if (state.mode === 'errors-unavailable') return result(null, { code: 'NETWORK_ERROR' });
    return result(state.mode === 'errors-malformed' ? { total_open: 0, items: null } : { total_open: state.errors.length, items: state.errors });
  }
  if (name === 'list_offers') return result([{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'ÖRNEK — Yayında olmayan test teklifi', description: 'Synthetic read-only fixture', code: 'FIXTURE-ONLY', channel_target: 'pickup', starts_at: '2026-10-01', ends_at: '2026-11-01', active: false, offer_status: 'inactive' }]);
  if (name === 'get_active_offers') {
    if (params?.p_business_id !== 'a358eba4-b197-4309-805b-46f43a718454') return unknown(name + ' business', params);
    return result([{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'ÖRNEK — Yayında olmayan test teklifi', description: 'Synthetic read-only fixture', code: 'FIXTURE-ONLY', channel_target: 'pickup', starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z' }]);
  }
  if (!writes.has(name)) return unknown(name, params);
  if (state.mode === 'save-error') return result(null, { code: 'NETWORK_ERROR' });
  let response = true;
  if (name === 'crm_add_note') {
    const c = [...state.customers, ...state.testCustomers].find(c => c.id === params?.p_customer_id);
    if (!c || typeof params?.p_body !== 'string') return unknown(name + ' parameters', params);
    c.notes.push({ id: nextId(), body: params.p_body, created_at: checkedAt, author_id: fixtureIds.staff });
  } else if (name === 'crm_create_task_v1') {
    if (!Object.hasOwn(state.tasks, params?.p_customer_id)) return unknown(name + ' parameters', params);
    response = nextId();
    state.tasks[params.p_customer_id].push({ id: response, title: params.p_title, assigned_to: params.p_assigned_to, due_at: params.p_due_at, completed_at: null });
  } else if (name === 'crm_complete_task_v1') {
    const t = Object.values(state.tasks).flat().find(t => t.id === params?.p_task_id);
    if (!t) return unknown(name + ' parameters', params);
    t.completed_at = checkedAt;
  } else if (name === 'crm_update_catering') {
    const r = allRequests().find(r => r.id === params?.p_request_id);
    if (!r) return unknown(name + ' parameters', params);
    r.status = params.p_status; r.assigned_to = params.p_assigned_to; r.follow_up_at = params.p_follow_up_at;
  } else if (name === 'crm_request_catering_decision_v1') {
    const r = allRequests().find(r => r.id === params?.p_request_id);
    if (!r) return unknown(name + ' parameters', params);
    response = nextId();
    state.decisions.push({ id: response, request_id: r.id, question: params.p_question, requested_at: checkedAt, decision: null, recorded_at: null, request_status: r.status, customer_name: r.name });
  } else if (name === 'crm_resolve_form_error_v1') state.errors = state.errors.filter(e => e.id !== params?.p_id);
  if (state.mode === 'lost-save-response') throw new Error('Synthetic committed write; response lost');
  return result(response);
}
export function createClient(url, key) {
  if (url !== 'https://khgczybubufouraqyrcj.supabase.co' || key !== 'sb_publishable_OFFLINE_SYNTHETIC_ONLY') return unknown('createClient real credentials rejected', { url });
  return { rpc, functions: { invoke: (_name, options) => opsMock.invoke(options.body) },
    storage: { from: () => ({ createSignedUrl: async () => ({ data:null,error:{message:"Synthetic download is not connected"} }) }) },
    auth: {
    async getSession() { remember('auth.getSession'); return { data: { session: state.signedIn ? clone(session) : null }, error: null }; },
    onAuthStateChange(fn) { listeners.add(fn); return { data: { subscription: { unsubscribe() { listeners.delete(fn); } } } }; },
    async signOut() { remember('auth.signOut'); state.signedIn = false; emit('SIGNED_OUT', null); return { error: null }; },
    async signInWithPassword(params) {
      remember('auth.signInWithPassword', { email: params.email });
      if (state.mode === 'signin-network') throw new Error('Synthetic login connection failure');
      state.signedIn = true; emit('SIGNED_IN', clone(session)); return { data: { session: clone(session) }, error: null };
    },
    async signInWithOtp(params) { remember('auth.signInWithOtp', { email: params.email, options: params.options }); return { error: { status: 429 } }; },
    async updateUser() { remember('auth.updateUser'); return { error: null }; },
  } };
}
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
  if (url.origin === window.location.origin && ['/api/staff/clover-orders', '/api/staff/decision-email-draft'].includes(url.pathname)) {
    if (new Headers(init?.headers).get('Authorization') !== 'Bearer ' + session.access_token) return unknown('Missing staff bearer');
    if (url.pathname.endsWith('clover-orders')) {
      if (init?.method !== 'GET') return unknown('Clover method');
      remember('fetch.clover-orders', {});
      return Response.json({ code: 'ok', checkedAt, orders: [{ id: 'SYNTHETIC-ORDER', cloverUrl: 'https://www.clover.com/orders/SYNTHETIC-ORDER', createdAt: checkedAt, orderType: 'pickup', totalCents: 4250 }] });
    }
    const body = JSON.parse(init.body);
    if (init?.method !== 'POST' || !state.decisions.some(d => d.id === body.decisionId)) return unknown('Decision draft parameters', body);
    remember('fetch.decision-email-draft', body);
    return Response.json({ to: 'review@example.invalid', cc: 'owner@example.invalid', subject: 'Synthetic decision', body: 'Synthetic review only' });
  }
  if (url.origin !== window.location.origin || url.pathname !== '/api/staff/klaviyo-status' || init?.method !== 'POST') return unknown('fetch ' + url.href, { method: init?.method });
  if (new Headers(init.headers).get('Authorization') !== 'Bearer ' + session.access_token) return unknown('Klaviyo missing staff bearer');
  let body;
  try { body = JSON.parse(init.body); } catch { return unknown('fetch invalid JSON'); }
  if (!body || ![...state.customers, ...state.testCustomers].some(c => c.id === body.customerId)) return unknown('Klaviyo customer', body);
  remember('fetch.klaviyo-status', body);
  const blocked = body.customerId === fixtureIds.testCustomer;
  const status = blocked ? 'suppressed' : 'pending';
  return Response.json({ status, checkedAt, saved: { status, checkedAt, blocked, blockedAt: blocked ? checkedAt : null, blockedStatus: blocked ? 'suppressed' : null }, localBlocked: blocked, synced: true });
};
// Exposed only by this test entry. No fixture or control is imported by production.
window.__staffMock = {
  ids: fixtureIds,
  snapshot() { return clone({ ...state, held: state.held.map(h => h.name), holdNames: [...state.holdNames] }); },
  setMode(mode) { state.mode = mode; },
  setLoyaltyResponse(data, error = null) { state.loyaltyResponse = result(data, error); },
  hold(name) { state.holdNames.push(name); },
  release() { const held = state.held.splice(0); for (const h of held) h.resolve(); },
  signOut() { state.signedIn = false; emit('SIGNED_OUT', null); },
  resume() { state.mode = 'normal'; state.signedIn = true; emit('SIGNED_IN', clone(session)); },
  seedNotes(notes) { state.customers[0].notes = clone(notes); },
};
