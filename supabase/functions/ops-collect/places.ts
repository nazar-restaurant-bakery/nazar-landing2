import { CollectorError, budget, count, failure, metric, notConnected, nyDate, object, previousAt, providerJson, type CollectorContext, type CollectorResult } from "./collectors.ts";
// https://developers.google.com/maps/documentation/places/web-service/place-details
const placeId = "ChIJKTmeJADZ54kRvLZoaDaB9J4";
export async function collect(ctx: CollectorContext): Promise<CollectorResult> {
  const key = ctx.env.GOOGLE_PLACES_API_KEY;
  if (!key) return notConnected("reviews", "Google Places API key bekleniyor.");
  const start = budget(ctx).remaining;
  try {
    const data = await providerJson(ctx, "https://places.googleapis.com/v1/places/" + placeId, "places.googleapis.com", {
      headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "id,rating,userRatingCount" },
    }, "/v1/places/");
    if (!object(data) || data.id !== placeId || count(data.userRatingCount) === null
      || (data.rating !== undefined && (typeof data.rating !== "number" || !Number.isFinite(data.rating) || data.rating < 1 || data.rating > 5))) throw new CollectorError("places_invalid_payload");
    const total = count(data.userRatingCount)!; const now = ctx.now ?? new Date();
    const previous = previousAt(ctx, "reviews", "total_reviews", new Date(now.getTime() - 7 * 86_400_000));
    return { source: "reviews", status: "connected", metrics: [metric(ctx, "reviews", "rating", typeof data.rating === "number" ? data.rating : null), metric(ctx, "reviews", "total_reviews", total),
      metric(ctx, "reviews", "new_reviews_7d", previous ? total - previous.value_num! : null,
        previous ? "NET snapshot farkı; yeni yorum değildir. Başlangıç " + previous.collected_at + "; hedef 7 gün, en çok 24 saat tolerans." : "7 günlük karşılaştırma snapshot'ı yok.",
        previous ? nyDate(previous.collected_at) : null, nyDate(now))],
      note: "Google Places yalnız puan/toplam sağlar; 7 gün değeri net snapshot farkıdır, silinen yorumları da içerir.", requestsUsed: start - budget(ctx).remaining };
  } catch (error) { return failure(ctx, "reviews", start, error); }
}
