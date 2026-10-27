import { liveCouponProvider, type CouponConfig, type CouponProvider } from './couponWelcome.ts';
import { liveReceiptProvider, type ReceiptProvider } from './couponDelivery.ts';
export type AccountTiming = {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
};
/** Normal route instance only; no retry/cache and no change to bootstrap pacing. */
export function couponAccountPacer(timing: AccountTiming = { now: Date.now, sleep: ms => new Promise(r => setTimeout(r, ms)) }) {
    let tail: Promise<unknown> = Promise.resolve(), next = timing.now() + 4200;
    return <T>(read: () => Promise<T>): Promise<T> => { const pending = tail.then(async () => { const wait = Math.max(0, next - timing.now()); if (wait)
        await timing.sleep(wait); try {
        return await read();
    }
    finally {
        next = timing.now() + 4200;
    } }); tail = pending.catch(() => { }); return pending; };
}
export function normalCouponProviders(config: CouponConfig, fetcher: typeof fetch = fetch, timing?: AccountTiming) {
    const pace = couponAccountPacer(timing), raw = liveCouponProvider(config, fetcher), receipt = liveReceiptProvider(config.receiptKey || '', fetcher);
    const provider: CouponProvider = { ...raw, get: (path, query) => path === '/accounts' ? pace(() => raw.get(path, query)) : raw.get(path, query), eventAccount: () => pace(() => raw.eventAccount()) };
    const receiptProvider: ReceiptProvider = { ...receipt, get: (path, query) => path === '/accounts' ? pace(() => receipt.get(path, query)) : receipt.get(path, query) };
    return { provider, receiptProvider };
}
