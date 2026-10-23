export type SiteOrderTicket = {
  ticket_id: string;
  site_order_id: string;
  department: "restaurant" | "bakery" | "catering";
  ticket_status: "new" | "needs_reschedule" | "accepted" | "preparing" | "ready";
  requested_at: string;
  lines: unknown[];
  customer_name: string;
  kind: "menu" | "catering";
  fulfillment_method: "pickup" | "delivery";
  preparation_note: string;
  total_cents: number;
  order_status: "paid" | "needs_reschedule";
  created_at: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown) => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function validSiteOrderQueue(value: unknown, businessId: string): value is { business_id: string; items: SiteOrderTicket[] } {
  return record(value) && value.business_id === businessId &&
    Array.isArray(value.items) && value.items.length <= 50 && value.items.every(item =>
      record(item) && uuid(item.ticket_id) && uuid(item.site_order_id) &&
      ["restaurant", "bakery", "catering"].includes(String(item.department)) &&
      ["new", "needs_reschedule", "accepted", "preparing", "ready"].includes(String(item.ticket_status)) &&
      ["paid", "needs_reschedule"].includes(String(item.order_status)) &&
      ["menu", "catering"].includes(String(item.kind)) &&
      ["pickup", "delivery"].includes(String(item.fulfillment_method)) &&
      typeof item.customer_name === "string" && typeof item.preparation_note === "string" &&
      typeof item.requested_at === "string" && Number.isFinite(Date.parse(item.requested_at)) &&
      typeof item.created_at === "string" && Number.isFinite(Date.parse(item.created_at)) &&
      Number.isSafeInteger(item.total_cents) && Number(item.total_cents) > 0 && Array.isArray(item.lines));
}

export function nextTicketStatus(status: SiteOrderTicket["ticket_status"]): "preparing" | "ready" | "completed" | null {
  if (status === "new" || status === "accepted") return "preparing";
  if (status === "preparing") return "ready";
  if (status === "ready") return "completed";
  return null;
}

export function ticketLineLabel(value: unknown): string {
  if (!record(value)) return "Ürün ayrıntısı doğrulanamadı";
  const title = typeof value.name === "string" ? value.name :
    typeof value.id === "string" ? value.id : "Ürün";
  const quantity = Number.isSafeInteger(value.quantity) && Number(value.quantity) > 0 ? Number(value.quantity) : 1;
  return `${quantity} × ${title.slice(0, 100)}`;
}
