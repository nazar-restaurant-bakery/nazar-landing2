// Server-owned deployment settings, never populated from the browser request.
import settings from "./tenant-settings.json" with { type: "json" };
import { uuid } from "./contracts.ts";
import { object } from "./collectors.ts";
export function placeIdForBusiness(businessId: unknown, configuration: unknown = settings): string | null {
  if (!uuid(businessId) || !object(configuration) || !object(configuration.businesses)
    || !Object.hasOwn(configuration.businesses, businessId)) return null;
  const business = configuration.businesses[businessId];
  if (!object(business) || !object(business.google_places)) return null;
  const id = business.google_places.place_id;
  return typeof id === "string" && /^[A-Za-z0-9_-]{20,255}$/.test(id) ? id : null;
}
