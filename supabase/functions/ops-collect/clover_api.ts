import { CollectorError, budget, failure, notConnected, object, providerJson, type CollectorContext, type CollectorResult } from "./collectors.ts";
// API scaffold only. Do not derive qualified net sales from payment.amount:
// tax/tip/additional-charge/refund fields require a verified merchant mapping.
// https://docs.clover.com/dev/docs/get-all-payments
const merchantId = "F8Q154GMDKFD1";
export async function collect(ctx: CollectorContext): Promise<CollectorResult> {
  const token = ctx.env.CLOVER_OPS_READ_TOKEN;
  if (!token || ctx.env.CLOVER_OPS_API_ENABLED !== "true") return notConnected("clover", "İlk sürüm Clover CSV kullanır; API read erişimi ve eşleme doğrulaması bekleniyor.");
  if (ctx.env.CLOVER_MERCHANT_ID !== merchantId) return notConnected("clover", "Yalnız doğrulanmış Nazar Clover merchant kullanılabilir.");
  const start = budget(ctx).remaining;
  try {
    const prefix = "/v3/merchants/" + merchantId;
    const data = await providerJson(ctx, "https://api.clover.com" + prefix, "api.clover.com", { headers: { Authorization: "Bearer " + token } }, prefix);
    if (!object(data) || data.id !== merchantId || typeof data.name !== "string" || !/\bnazar\b/i.test(data.name)) throw new CollectorError("clover_merchant_mismatch");
    return { source: "clover", status: "not_connected", metrics: [], note: "Merchant okuması geçti; satış/refund/kanal eşlemesi henüz doğrulanmadı. CSV yolu kullanılabilir.", requestsUsed: start - budget(ctx).remaining, capabilities: [] };
  } catch (error) { return failure(ctx, "clover", start, error); }
}
