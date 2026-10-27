export type CouponAutomationBody = {
    version: 1;
    businessId: string;
    runId: string;
    issuedAt: number;
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function validCouponAutomationBody(b: unknown, now = Date.now()): b is CouponAutomationBody {
    if (!b || typeof b !== 'object' || Array.isArray(b))
        return false;
    const v = b as CouponAutomationBody;
    return Object.keys(v).sort().join() === 'businessId,issuedAt,runId,version' && v.version === 1 && typeof v.businessId === 'string' && typeof v.runId === 'string' && uuid.test(v.businessId) && uuid.test(v.runId) && Number.isSafeInteger(v.issuedAt) && Math.abs(now / 1000 - v.issuedAt) <= 60;
}
function message(b: CouponAutomationBody) { return JSON.stringify(['coupon.automation.v1', b.version, b.businessId, b.runId, b.issuedAt]); }
async function key(secret: string) { if (!/^[A-Za-z0-9_-]{32,200}$/.test(secret))
    throw Error('automation_key_unavailable'); return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
export async function couponAutomationSignature(b: CouponAutomationBody, secret: string) { return [...new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(message(b))))].map(x => x.toString(16).padStart(2, '0')).join(''); }
export async function verifyCouponAutomation(b: unknown, signature: string, secret: string, now = Date.now()) {
    if (!validCouponAutomationBody(b, now) || !/^[a-f0-9]{64}$/.test(signature) || !/^[A-Za-z0-9_-]{32,200}$/.test(secret))
        return false;
    const bytes = new Uint8Array(signature.match(/../g)!.map(v => parseInt(v, 16)));
    return crypto.subtle.verify('HMAC', await key(secret), bytes, new TextEncoder().encode(message(b)));
}
