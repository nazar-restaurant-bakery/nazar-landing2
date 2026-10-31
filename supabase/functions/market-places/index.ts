// Edge market-places: Google Places (New) -> market schema through service_role RPCs.
// Triggered only by market.places_run_v1 (signed, single use). Dry run: no Places call.
// Nazar's own place is never written. No key, signature or token is logged or returned.
import { verifyTrigger, type PlacesTrigger } from "./auth.ts";
import { DETAILS_MASK, MAX_PAGES, SEARCH_MASK, countySearches, distanceMeters, inCounty, METERS_PER_MILE, offset,
  placeRow, plannedCalls, radiusSearches, type Claim, type Row, type Search } from "./plan.ts";
import { placeIdForBusiness } from "../ops-collect/tenant-settings.ts";
type Env = Record<string, string | undefined>;
const PLACES = "https://places.googleapis.com/v1/";

class CapReached extends Error {}
class PlacesFailed extends Error { code: string; constructor(code: string) { super(code); this.code = code; } }

export function marketPlacesHandler(fetcher: typeof fetch = fetch, now = () => Date.now(),
  background?: (task: Promise<unknown>) => void, excludePlaceId: (businessId: string) => string | null = placeIdForBusiness) {
  return async (request: Request, env: Env): Promise<Response> => {
    const reply = (status: number, code: string, extra: Record<string, unknown> = {}) =>
      new Response(JSON.stringify({ code, ...extra }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    if (request.method !== "POST") return reply(405, "method_not_allowed");
    let body: PlacesTrigger;
    try { const raw = await request.text(); if (raw.length > 1024) return reply(400, "invalid_request"); body = JSON.parse(raw); }
    catch { return reply(400, "invalid_request"); }
    if (!await verifyTrigger(body, request.headers.get("X-Scheduler-Signature") || "", env.SCHEDULER_SIGNING_SECRET || "", now()))
      return reply(401, "unauthorized");
    if (!env.SUPABASE_URL || !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(env.SUPABASE_URL) || !env.SUPABASE_SERVICE_ROLE_KEY)
      return reply(503, "configuration_missing");
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const key = env.SUPABASE_SERVICE_ROLE_KEY!;
      const r = await fetcher(env.SUPABASE_URL + "/rest/v1/rpc/" + name, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify(args) });
      if (!r.ok) throw Error("database_unavailable");
      return r.json();
    };
    let claim: Claim | null;
    try { claim = await rpc("market_places_claim_v1", { p_business_id: body.business_id, p_run_id: body.run_id, p_nonce: body.nonce }); }
    catch { return reply(503, "database_unavailable"); }
    if (!claim) return reply(409, "already_claimed_or_disabled");
    const run = claim;
    const planned = plannedCalls(run);
    const finish = (status: string, code: string, calls: number, competitors: Row[], area: Row[]) =>
      rpc("market_places_finish_v1", { p_business_id: body.business_id, p_run_id: body.run_id, p_claim_token: run.claim_token,
        p_status: status, p_safe_code: code, p_planned_calls: planned, p_calls_used: calls,
        p_competitors: competitors, p_area_businesses: area });
    const log = (fields: Record<string, unknown>) => console.info("market_places_result " + JSON.stringify({ run_id: body.run_id, topic: run.topic, ...fields }));

    // Dry run: only the planned call count, no Places request.
    if (run.dry_run) {
      try { await finish("succeeded", "dry_run", 0, [], []); } catch { return reply(503, "unknown_result"); }
      log({ status: "succeeded", dry_run: true, planned_calls: planned });
      return reply(200, "dry_run", { planned_calls: planned, max_calls: run.max_calls });
    }
    const exclude = excludePlaceId(body.business_id);
    if (!env.GOOGLE_PLACES_API_KEY || !exclude) {
      try { await finish("failed", "places_not_configured", 0, [], []); } catch { /* recorded as running */ }
      return reply(503, "places_not_configured");
    }

    const work = async () => {
      let calls = 0;
      const places = async (path: string, init: { method: "GET" | "POST"; mask: string; body?: unknown }) => {
        if (calls >= run.max_calls) throw new CapReached();
        calls++;
        let r: Response;
        try {
          r = await fetcher(PLACES + path, { method: init.method, redirect: "error", signal: AbortSignal.timeout(15000),
            headers: { "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY!, "X-Goog-FieldMask": init.mask,
              ...(init.body ? { "Content-Type": "application/json" } : {}) },
            ...(init.body ? { body: JSON.stringify(init.body) } : {}) });
        } catch { throw new PlacesFailed("places_request_failed"); }
        if (!r.ok) throw new PlacesFailed(r.status === 429 ? "places_rate_limited" : "places_http_" + r.status);
        try { return await r.json() as Record<string, unknown>; } catch { throw new PlacesFailed("places_invalid_json"); }
      };
      const competitors = new Map<string, Row>(), area = new Map<string, Row>();
      let status = "succeeded", code = "completed";
      try {
        let center: { latitude: number; longitude: number } | null = null;
        let radius = 0;
        const queue: Search[] = run.mode === "county" ? countySearches(run) : radiusSearches(run);
        if (run.mode === "radius") {
          const own = await places("places/" + encodeURIComponent(exclude), { method: "GET", mask: DETAILS_MASK });
          const loc = own.location as { latitude?: unknown; longitude?: unknown } | undefined;
          if (typeof loc?.latitude !== "number" || typeof loc?.longitude !== "number") throw new PlacesFailed("own_location_missing");
          center = { latitude: loc.latitude, longitude: loc.longitude };
          radius = Number(run.radius_miles) * METERS_PER_MILE;
        }
        const pages = new Map<string, number>();
        while (queue.length) {
          const search = queue.shift()!;
          let data: Record<string, unknown>;
          if (search.kind === "text") {
            data = await places("places:searchText", { method: "POST", mask: SEARCH_MASK,
              body: { textQuery: search.textQuery, pageSize: 20, regionCode: "US", ...(search.pageToken ? { pageToken: search.pageToken } : {}) } });
            const page = (pages.get(search.textQuery) ?? 1);
            if (typeof data.nextPageToken === "string" && data.nextPageToken && page < MAX_PAGES) {
              pages.set(search.textQuery, page + 1);
              queue.push({ ...search, pageToken: data.nextPageToken }); // later pages use what the cap leaves
            }
          } else {
            data = await places("places:searchNearby", { method: "POST", mask: SEARCH_MASK.replace(",nextPageToken", ""),
              body: { includedTypes: [search.includedType], maxResultCount: 20, rankPreference: "DISTANCE",
                locationRestriction: { circle: { center: offset(center!, search.offsetEast, search.offsetNorth), radius: search.radius } } } });
          }
          for (const place of Array.isArray(data.places) ? data.places : []) {
            const row = placeRow(place);
            if (!row || row.place_id === exclude) continue; // Nazar itself is never listed
            if (search.kind === "text") {
              if (!inCounty(row, run.state, search.county)) continue; // outside the county: not written
              row.county = search.county;
            } else if (row.latitude === null || row.longitude === null
              || distanceMeters(center!, { latitude: row.latitude, longitude: row.longitude }) > radius) continue;
            const { state: _state, ...stored } = row;
            (search.target === "area" ? area : competitors).set(stored.place_id, stored);
          }
        }
      } catch (error) {
        if (error instanceof CapReached) { status = "partial"; code = "call_cap_reached"; }
        else { status = "partial"; code = error instanceof PlacesFailed ? error.code : "unexpected"; }
      }
      for (const id of competitors.keys()) area.delete(id); // a caterer is a competitor, not a prospect
      if (status === "partial" && !competitors.size && !area.size) status = "failed";
      const written = await finish(status, code, calls, [...competitors.values()], [...area.values()]);
      log({ status, safe_code: code, planned_calls: planned, calls_used: calls, ...written });
      return reply(status === "failed" ? 503 : 200, status, { calls_used: calls, ...written });
    };
    const guarded = () => work().catch(() => { log({ status: "unknown_result" }); return reply(503, "unknown_result"); });
    if (background) { background(guarded()); return reply(202, "accepted", { planned_calls: planned }); }
    return guarded();
  };
}

declare const Deno: { serve: (fn: (req: Request) => Promise<Response>) => void; env: { toObject: () => Env } };
declare const EdgeRuntime: { waitUntil: (task: Promise<unknown>) => void };
if (typeof Deno !== "undefined") Deno.serve(req => marketPlacesHandler(fetch, () => Date.now(),
  typeof EdgeRuntime !== "undefined" ? task => EdgeRuntime.waitUntil(task) : undefined)(req, Deno.env.toObject()));
