import { verifyCouponAutomation, type CouponAutomationBody } from './couponAutomationAuth.ts';
type Env = Record<string, string | undefined>;
type Json = Record<string, unknown>;
const obj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
async function jsonBounded(source: Request | Response, limit: number): Promise<unknown> {
    const reader = source.body?.getReader();
    if (!reader)
        throw Error('body_unavailable');
    let count = 0;
    const chunks: Uint8Array[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_r, reject) => { timer = setTimeout(() => { reader.cancel().catch(() => undefined); reject(Error('body_deadline')); }, 5000); });
    try {
        while (true) {
            const part = await Promise.race([reader.read(), deadline]);
            if (part.done)
                break;
            count += part.value.byteLength;
            if (count > limit)
                throw Error('body_limit');
            chunks.push(part.value);
        }
        const bytes = new Uint8Array(count);
        let at = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, at);
            at += chunk.byteLength;
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
function origin(raw: string | undefined, supabase = false) { try {
    const u = new URL(raw || '');
    if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || u.href !== u.origin + '/')
        return '';
    if (supabase && !/^[a-z0-9]{20}\.supabase\.co$/.test(u.hostname))
        return '';
    return u.origin;
}
catch {
    return '';
} }
/** Disabled before any DB/network. No logger, scheduler, provider key, profile or email sender mutation. */
export function couponAutomationHandler(fetcher: typeof fetch = fetch, now = Date.now) {
    return async (request: Request, env: Env): Promise<Response> => {
        const counts = { accepted: 0, blocked: 0, unconfirmed: 0, delivered: 0, pending: 0 };
        const reply = (status: number, code: string) => Response.json({ code, ...counts }, { status, headers: { 'Cache-Control': 'no-store' } });
        if (env.COUPON_AUTOMATION_ENABLED !== 'true')
            return reply(503, 'automation_disabled');
        if (request.method !== 'POST')
            return reply(405, 'method_not_allowed');
        if (request.headers.has('Origin') || request.headers.get('Content-Type') !== 'application/json')
            return reply(403, 'forbidden');
        let body: CouponAutomationBody;
        try {
            const b = await jsonBounded(request, 1024);
            if (!await verifyCouponAutomation(b, request.headers.get('X-Coupon-Automation-Signature') || '', env.COUPON_AUTOMATION_SIGNING_SECRET || '', now()))
                return reply(403, 'forbidden');
            body = b as CouponAutomationBody;
        }
        catch {
            return reply(403, 'forbidden');
        }
        if (!uuid(env.COUPON_AUTOMATION_BUSINESS_ID) || body.businessId !== env.COUPON_AUTOMATION_BUSINESS_ID)
            return reply(403, 'forbidden');
        const db = origin(env.SUPABASE_URL, true), site = origin(env.COUPON_AUTOMATION_ORIGIN), serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || '', processKey = env.COUPON_PROCESS_KEY || '';
        if (!db || !site || !serviceKey || !/^[A-Za-z0-9_-]{32,200}$/.test(processKey))
            return reply(503, 'configuration_missing');
        const args = { p_business_id: body.businessId, p_run_id: body.runId };
        let runToken: string | undefined, finishAttempted = false;
        async function rpc(name: 'start' | 'next' | 'record' | 'finish', extra: Json = {}) {
            const r = await fetcher(db + '/rest/v1/rpc/coupon_automation_' + name + '_v1', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...args, ...(runToken ? { p_run_token: runToken } : {}), ...extra }) });
            if (r.status !== 200)
                throw Error('database_unavailable');
            return jsonBounded(r, 16000);
        }
        async function machine(action: 'welcome' | 'reconcile', couponId: string) {
            try {
                const r = await fetcher(site + '/api/internal/coupon-welcome', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { Authorization: 'Bearer ' + processKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, businessId: body.businessId, couponId }) });
                if (r.status !== 200 && !(action === 'reconcile' && r.status === 202))
                    return 'unknown';
                const v = await jsonBounded(r, 16000);
                if (!obj(v) || Object.keys(v).sort().join() !== 'activationReady,code,status,synthetic' || v.synthetic !== false || typeof v.activationReady !== 'boolean' || typeof v.code !== 'string')
                    return 'unknown';
                if (action === 'welcome')
                    return v.status === 'provider_accepted' && v.code === 'pending_delivery_receipt_reconciliation' && v.activationReady === false ? 'provider_accepted' : v.status === 'blocked' && v.activationReady === false ? 'blocked' : 'unknown';
                return v.status === 'delivered' && v.code === 'delivery_confirmed' && r.status === 200 ? 'delivered' : (v.status === 'pending' || v.status === 'blocked') && v.activationReady === false ? 'pending' : 'unknown';
            }
            catch {
                return 'unknown';
            }
        }
        try {
            const started = await rpc('start');
            if (!obj(started) || typeof started.allowed !== 'boolean')
                throw Error('start_unconfirmed');
            if (!started.allowed) {
                if (!['disabled', 'replay', 'busy'].includes(String(started.code)))
                    throw Error('start_unconfirmed');
                return reply(200, String(started.code));
            }
            if (started.code !== 'claimed' || !uuid(started.runToken) || started.dispatchLimit !== 1 || !Number.isInteger(started.receiptLimit) || Number(started.receiptLimit) < 0 || Number(started.receiptLimit) > 3 || typeof started.expiresAt !== 'string' || !Number.isFinite(Date.parse(started.expiresAt)) || Date.parse(started.expiresAt) <= now())
                throw Error('start_unconfirmed');
            runToken = started.runToken;
            for (const kind of ['receipt', 'dispatch'] as const) {
                const limit = kind === 'dispatch' ? 1 : Number(started.receiptLimit);
                for (let index = 0; index < limit; index++) {
                    const n = await rpc('next', { p_kind: kind });
                    if (!obj(n) || typeof n.allowed !== 'boolean')
                        throw Error('candidate_unconfirmed');
                    if (!n.allowed) {
                        if (!['paused', 'deadline', 'limit', 'normal_setup_pending', 'queue_empty'].includes(String(n.code)))
                            throw Error('candidate_unconfirmed');
                        break;
                    }
                    if (!uuid(n.attemptId) || !uuid(n.couponId) || n.code !== (kind === 'dispatch' ? 'attempt_recorded' : 'poll_recorded'))
                        throw Error('candidate_unconfirmed');
                    // Durable SQL attempt/poll marker exists before this ONE machine request.
                    const outcome = await machine(kind === 'dispatch' ? 'welcome' : 'reconcile', n.couponId);
                    const ack = await rpc('record', { p_kind: kind, p_attempt_id: n.attemptId, p_outcome: outcome });
                    if (!obj(ack) || ack.acknowledged !== true)
                        throw Error('record_unconfirmed');
                    if (kind === 'dispatch') {
                        if (outcome === 'provider_accepted')
                            counts.accepted++;
                        else if (outcome === 'blocked')
                            counts.blocked++;
                        else
                            counts.unconfirmed++;
                    }
                    else if (outcome === 'delivered')
                        counts.delivered++;
                    else
                        counts.pending++;
                }
            }
            finishAttempted = true;
            const done = await rpc('finish');
            if (!obj(done) || done.acknowledged !== true)
                throw Error('finish_unconfirmed');
            return reply(200, 'cycle_completed');
        }
        catch {
            // SQL durable marks remain. Never retry machine HTTP or requeue an unknown dispatch.
            if (runToken && !finishAttempted) {
                finishAttempted = true;
                await rpc('finish').catch(() => undefined);
            }
            return reply(503, 'cycle_unconfirmed');
        }
    };
}
