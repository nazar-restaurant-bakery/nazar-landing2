// Search plan and result filtering for the market-places Edge function.
// Places API (New): https://developers.google.com/maps/documentation/places/web-service/text-search
// and https://developers.google.com/maps/documentation/places/web-service/nearby-search
export type Topic = "catering" | "restaurant";
export type Claim = { claim_token: string; topic: Topic; mode: "county" | "radius"; state: string;
  counties: string[] | null; radius_miles: number | null; dry_run: boolean; max_calls: number };
export type Search =
  | { kind: "text"; target: "competitor" | "area"; county: string; textQuery: string; pageToken?: string }
  | { kind: "nearby"; target: "competitor"; includedType: string; offsetEast: number; offsetNorth: number; radius: number };
export type Row = { place_id: string; name: string; address: string | null; types: string[]; rating: number | null;
  review_count: number | null; latitude: number | null; longitude: number | null; website: string | null;
  city: string | null; county: string | null };

// Only the fields that are stored, plus nextPageToken for paging.
export const FIELDS = ["id", "displayName", "formattedAddress", "types", "rating", "userRatingCount", "location", "websiteUri", "addressComponents"];
export const SEARCH_MASK = FIELDS.map(f => "places." + f).join(",") + ",nextPageToken";
export const DETAILS_MASK = "id,location";
export const METERS_PER_MILE = 1609.344;
export const MAX_PAGES = 3;

// Town-based scan per county (CT). A county without a list is searched as a whole.
export const COUNTY_TOWNS: Record<string, Record<string, string[]>> = { CT: {
  "New Haven County": ["Ansonia", "Beacon Falls", "Bethany", "Branford", "Cheshire", "Derby", "East Haven", "Guilford",
    "Hamden", "Madison", "Meriden", "Middlebury", "Milford", "Naugatuck", "New Haven", "North Branford", "North Haven",
    "Orange", "Oxford", "Prospect", "Seymour", "Southbury", "Wallingford", "Waterbury", "West Haven", "Wolcott", "Woodbridge"],
  "Fairfield County": ["Bethel", "Bridgeport", "Brookfield", "Danbury", "Darien", "Easton", "Fairfield", "Greenwich", "Monroe",
    "New Canaan", "New Fairfield", "Newtown", "Norwalk", "Redding", "Ridgefield", "Shelton", "Sherman", "Stamford",
    "Stratford", "Trumbull", "Weston", "Westport", "Wilton"],
  "Middlesex County": ["Chester", "Clinton", "Cromwell", "Deep River", "Durham", "East Haddam", "East Hampton", "Essex",
    "Haddam", "Killingworth", "Middlefield", "Middletown", "Old Saybrook", "Portland", "Westbrook"],
} };
// Catering: caterers are competitors; offices that order catering are area businesses.
export const CATERING_COMPETITOR_QUERY = "catering";
export const AREA_QUERIES = ["corporate office", "law firm", "medical office"];
// Restaurant: dine-in, pick-up and delivery competitors around Nazar.
export const RESTAURANT_TYPES = ["restaurant", "bakery", "meal_takeaway"];

export function countySearches(claim: Claim): Search[] {
  const searches: Search[] = [];
  for (const county of claim.counties ?? []) {
    const towns = COUNTY_TOWNS[claim.state]?.[county] ?? [county];
    for (const town of towns) {
      const where = `${town}, ${claim.state}`;
      searches.push({ kind: "text", target: "competitor", county, textQuery: `${CATERING_COMPETITOR_QUERY} in ${where}` });
      for (const q of AREA_QUERIES) searches.push({ kind: "text", target: "area", county, textQuery: `${q} in ${where}` });
    }
  }
  return searches;
}

// Grid of small circles covering the radius; Nearby Search returns at most 20 per call.
export function radiusGrid(radiusMeters: number): { east: number; north: number; radius: number }[] {
  const small = radiusMeters / 4, step = small * Math.SQRT2, n = Math.ceil(radiusMeters / step);
  const points: { east: number; north: number; radius: number }[] = [];
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const east = i * step, north = j * step;
    if (Math.hypot(east, north) <= radiusMeters + small / 2) points.push({ east, north, radius: Math.round(small) });
  }
  return points;
}
export function radiusSearches(claim: Claim): Search[] {
  const radius = Number(claim.radius_miles) * METERS_PER_MILE;
  return radiusGrid(radius).flatMap(p => RESTAURANT_TYPES.map(includedType =>
    ({ kind: "nearby", target: "competitor", includedType, offsetEast: p.east, offsetNorth: p.north, radius: p.radius } as Search)));
}
// First-page calls (plus one location lookup for radius mode); paging uses what the cap leaves.
export function plannedCalls(claim: Claim): number {
  return claim.mode === "county" ? countySearches(claim).length : 1 + radiusSearches(claim).length;
}

export function offset(center: { latitude: number; longitude: number }, east: number, north: number) {
  return { latitude: center.latitude + north / 111_320,
    longitude: center.longitude + east / (111_320 * Math.cos(center.latitude * Math.PI / 180)) };
}
export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const rad = Math.PI / 180, dLat = (b.latitude - a.latitude) * rad, dLng = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

type Component = { longText?: unknown; shortText?: unknown; types?: unknown };
function component(place: Record<string, unknown>, type: string, field: "longText" | "shortText"): string | null {
  const list = Array.isArray(place.addressComponents) ? place.addressComponents as Component[] : [];
  const found = list.find(c => Array.isArray(c?.types) && (c.types as unknown[]).includes(type));
  const value = found?.[field];
  return typeof value === "string" && value.trim() && value.length <= 120 ? value.trim() : null;
}
const text = (value: unknown, max: number) => typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;

// Business listing fields only; nothing else from the response is kept.
export function placeRow(place: unknown): (Row & { state: string | null }) | null {
  if (!place || typeof place !== "object" || Array.isArray(place)) return null;
  const p = place as Record<string, unknown>;
  const id = typeof p.id === "string" && /^[A-Za-z0-9_-]{10,255}$/.test(p.id) ? p.id : null;
  const name = text((p.displayName as { text?: unknown } | undefined)?.text, 300);
  if (!id || !name) return null;
  const location = p.location as { latitude?: unknown; longitude?: unknown } | undefined;
  const lat = typeof location?.latitude === "number" && Math.abs(location.latitude) <= 90 ? location.latitude : null;
  const lng = typeof location?.longitude === "number" && Math.abs(location.longitude) <= 180 ? location.longitude : null;
  const website = text(p.websiteUri, 500);
  return {
    place_id: id, name, address: text(p.formattedAddress, 500),
    types: Array.isArray(p.types) ? (p.types as unknown[]).filter((t): t is string => typeof t === "string" && /^[a-z0-9_]{1,64}$/.test(t)).slice(0, 30) : [],
    rating: typeof p.rating === "number" && p.rating >= 0 && p.rating <= 5 ? Math.round(p.rating * 10) / 10 : null,
    review_count: Number.isSafeInteger(p.userRatingCount) && (p.userRatingCount as number) >= 0 ? p.userRatingCount as number : null,
    latitude: lat, longitude: lng, website: website && /^https?:\/\//.test(website) ? website : null,
    city: component(p, "locality", "longText") ?? component(p, "administrative_area_level_3", "longText") ?? component(p, "postal_town", "longText"),
    county: component(p, "administrative_area_level_2", "longText"),
    state: component(p, "administrative_area_level_1", "shortText"),
  };
}

// County mode: the address must be in the target state and county. CT addresses may carry a
// planning region instead of a county, so the town list of the county is the fallback.
export function inCounty(row: Row & { state: string | null }, state: string, county: string): boolean {
  if (row.state !== state) return false;
  if (row.county === county) return true;
  const towns = COUNTY_TOWNS[state]?.[county];
  return !!towns && !!row.city && towns.some(t => t.toLowerCase() === row.city!.toLowerCase());
}
