// Codes and receipt notes are bearer/private data: never log, persist or put in URLs.
export type CouponStatus = 'valid' | 'used' | 'expired' | 'inactive' | 'wrong_business' | 'not_found';
export type Coupon = {
  status: CouponStatus; valid: boolean; reason: string; customerNameMasked: string | null;
  campaign: {id: string; name: string; benefitType: 'item'; minimumAmountCents: number; channels: string[]; units: 1} | null;
  couponId: string | null; expiresAt: string | null; redeemedAt: string | null;
};
export type Receipt = {orderId: string; text: string; channel: string; amount: string; receiptAt: string; receiptRef: string; checked: boolean};
export type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<{data: unknown; error: {code?: string; status?: number} | null; status?: number}>;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const date = (v: unknown) => v === null || typeof v === 'string' && /T/.test(v) && Number.isFinite(Date.parse(v));
export const channels: Record<string, string> = {dine_in: 'Restoranda', site_pickup: 'Site pickup', site_delivery: 'Site delivery'};
export function normalizeCoupon(value: string): string | null {
  const code = value.replace(/[\s-]/g, '').toUpperCase();
  return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/.test(code) ? code.match(/.{4}/g)!.join('-') : null;
}
export function couponFromQr(value: string): string | null {
  return /^VIPCOUPON1:[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){3}$/.test(value)
    ? normalizeCoupon(value.slice(11)) : null;
}
export function validCoupon(v: unknown): v is Coupon {
  if (!object(v) || !['valid','used','expired','inactive','wrong_business','not_found'].includes(String(v.status))
    || v.valid !== (v.status === 'valid') || typeof v.reason !== 'string' || !date(v.expiresAt) || !date(v.redeemedAt)
    || !(v.customerNameMasked === null || typeof v.customerNameMasked === 'string' && /^[\p{L}\p{N}]?\*\*\*$/u.test(v.customerNameMasked))
    || !(v.couponId === null || uuid(v.couponId))) return false;
  if (['wrong_business','not_found'].includes(String(v.status))) return v.customerNameMasked === null && v.campaign === null && v.couponId === null;
  const c = v.campaign;
  return object(c) && uuid(c.id) && typeof c.name === 'string' && c.name.length <= 200 && c.benefitType === 'item'
    && Number.isSafeInteger(c.minimumAmountCents) && Number(c.minimumAmountCents) >= 3000 && c.units === 1
    && Array.isArray(c.channels) && c.channels.length > 0 && c.channels.every(v => typeof v === 'string' && Object.hasOwn(channels,v))
    && uuid(v.couponId) && (v.status !== 'used' || typeof v.redeemedAt === 'string');
}
export function receiptNote(receipt: Receipt, coupon: Coupon, now = Date.now()) {
  const {orderId, text, channel, amount, receiptAt, receiptRef, checked} = receipt;
  if (!checked || !coupon.valid || !coupon.campaign || !coupon.campaign.channels.includes(channel)) return null;
  if (orderId.trim() && !/^[A-Za-z0-9]{8,32}$/.test(orderId.trim())) return null;
  if (!/^\d{1,9}(?:[.,]\d{1,2})?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.replace(',', '.').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2,'0'));
  const when = new Date(receiptAt);
  const local = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/.exec(receiptAt);
  // Reject nonexistent local times (including the spring DST gap), not a rolled-over receipt.
  if (local && [when.getFullYear(),when.getMonth()+1,when.getDate(),when.getHours(),when.getMinutes()].some((v,i)=>v!==Number(local[i+1]))) return null;
  if (!Number.isSafeInteger(cents) || cents < coupon.campaign.minimumAmountCents || !Number.isFinite(when.getTime())
    || when.getTime() > now || !receiptRef.trim() || receiptRef.trim().length > 120 || text.trim().length > 1000) return null;
  return {version: 1, text: text.trim() || 'Fiş ve sipariş kontrol edildi', channel, qualifyingAmountCents: cents,
    receiptAt: when.toISOString(), receiptRef: receiptRef.trim()};
}
export function forbidden(result: {error: {code?: string; status?: number} | null; status?: number}) {
  return result.status === 403 || result.error?.status === 403 || ['42501','403'].includes(result.error?.code || '');
}
export const couponLabels: Record<CouponStatus,string> = {valid:'Geçerli',used:'Kullanılmış',expired:'Süresi dolmuş',inactive:'Durdurulmuş kampanya',wrong_business:'Yanlış işletme',not_found:'Bulunamadı'};
export const couponReasons: Record<string,string> = {
  already_used:'Bu kupon daha önce kullanılmış.', expired:'Kuponun süresi dolmuş.', campaign_inactive:'Kampanya durdurulmuş.',
  wrong_business:'Kupon başka işletmeye ait.', not_found:'Kupon bulunamadı.', below_minimum:'Sipariş tutarı kampanya eşiğinin altında.',
  channel_not_allowed:'Sipariş kanalı uygun değil.', order_not_synced:'Clover siparişi henüz yerel kayıtta yok.',
  order_unmatched:'Sipariş ve kupon sahibi eşleşmiyor.', order_not_paid:'Ödeme veya iade durumu uygun değil.',
  order_before_coupon:'Sipariş kupon kazanıldıktan sonra verilmiş olmalı; gerçek fiş tarihini kontrol edin.',
  amount_evidence_missing:'Sipariş tutarı kanıtı eksik.', order_already_rewarded:'Bu sipariş veya fişte daha önce ikram kullanılmış.',
  attestation_required:'Gerçek fiş bilgilerini ve kontrol onayını tamamlayın.', attestation_mismatch:'Beyan ve Clover siparişi uyuşmuyor.',
  total_limit:'Kampanyanın toplam kullanım sınırı dolmuş.',
};
export function redemptionResult(v: unknown): v is {redeemed: boolean; status: string; code: string; redeemedAt?: string; evidenceMode?: string} {
  return object(v) && typeof v.redeemed === 'boolean' && typeof v.status === 'string' && typeof v.code === 'string'
    && (v.redeemed ? v.code === 'redeemed' && v.status === 'used' && typeof v.redeemedAt === 'string' && date(v.redeemedAt)
      : Object.hasOwn(couponReasons,v.code));
}
