type ObjectValue = Record<string, unknown>;
const cloverId = /^[A-Za-z0-9]{8,32}$/;
const object = (x: unknown): x is ObjectValue => x !== null && typeof x === "object" && !Array.isArray(x);
const id = (x: unknown): x is string => typeof x === "string" && cloverId.test(x);
export type PullStep = "configuration" | "authorization" | "list" | "order_core" | "order_refunds" | "order_customers" | "ingest";

export class PullError extends Error {
  readonly code: string;
  readonly step: PullStep;
  readonly providerStatus?: number;
  constructor(code: string, step: PullStep, providerStatus?: number) {
    super(code);
    this.code = code;
    this.step = step;
    this.providerStatus = providerStatus;
  }
}

function elements(value: unknown, step: PullStep): ObjectValue[] {
  const rows = Array.isArray(value) ? value : object(value) ? value.elements : null;
  if (!Array.isArray(rows) || rows.some(row => !object(row))) throw new PullError("clover_collection_missing", step);
  return rows as ObjectValue[];
}

function contact(customer: ObjectValue | undefined, single: string, plural: string): string | null {
  if (!customer) return null;
  if (typeof customer[single] === "string") return customer[single];
  const list = customer[plural];
  const first = object(list) && Array.isArray(list.elements) ? list.elements[0] : undefined;
  return object(first) && typeof first[single] === "string" ? first[single] : null;
}

/** One snapshot contract for manual pull and webhook. K7 SQL remains the only writer/status interpreter. */
export function snapshot(detail: unknown, merchant: string, onlineTypes: string[]): ObjectValue {
  if (!object(detail) || !id(detail.id) || !Number.isSafeInteger(detail.createdTime)) throw new PullError("clover_order_invalid", "order_core");
  const orderType = detail.orderType;
  const typeId = object(orderType) && id(orderType.id) ? orderType.id : null;
  if (!typeId) throw new PullError("clover_order_type_missing", "order_core");
  const items = elements(detail.lineItems, "order_core");
  const payments = elements(detail.payments, "order_core");
  const refunds = detail.refunds === undefined ? [] : elements(detail.refunds, "order_refunds");
  const customers = detail.customers === undefined ? [] : elements(detail.customers, "order_customers");
  for (const row of [...items, ...payments, ...refunds]) if (!id(row.id)) throw new PullError("clover_child_invalid", "order_core");
  for (const row of payments) if (!Number.isSafeInteger(row.amount) || Number(row.amount) < 0) throw new PullError("clover_payment_invalid", "order_core");
  for (const row of refunds) if (!Number.isSafeInteger(row.amount) || Number(row.amount) < 0) throw new PullError("clover_refund_invalid", "order_refunds");
  const isOnline = onlineTypes.includes(typeId);
  const customer = isOnline ? customers[0] : undefined;
  return { id: detail.id, merchantId: merchant, orderTypeId: typeId, online: isOnline,
    createdTime: detail.createdTime, modifiedTime: detail.modifiedTime ?? null,
    state: detail.state ?? null, total: detail.total ?? null,
    customerEmail: contact(customer, "emailAddress", "emailAddresses"),
    customerPhone: contact(customer, "phoneNumber", "phoneNumbers"),
    items, payments, refunds, refundsVerified: detail.refundsVerified !== false,
    customerAccess: detail.customerAccess === "denied" ? "denied" : "verified", raw: detail };
}
